import { buildBoard } from './board.js';
import { renderPage } from './render.js';
import { frequencyTable } from './frequency.js';
import { bookabilityHeatmap } from './heatmap.mjs';
import { releaseTiming } from './timing.mjs';
import { weeklyPattern } from './schedule.mjs';
import { ROUTES, PROFILES, PROFILE } from './routes.js';
import { shouldSendStaleAlert, validTopic } from './alerts.mjs';
import { outboxStatus } from './outbox.mjs';
import { maybeDispatch } from './dispatch.mjs';
import { buildLedger } from './ledger.mjs';
import { ICON_192_PNG, ICON_512_PNG } from './pwa-icons.mjs';
import { publicKey, toB64u, saveSubscription, listSubscriptions, dropSubscription, sendToAll, sendEmpty } from './push.mjs';
import { runPolicy } from './policy.mjs';
import { readSettings, writeSettings } from './settings.mjs';
import {
  channelStatus,
  evaluateWatches,
  listWatches,
  normalizeWatch,
  removeWatch,
  resolveTopic,
  saveWatch,
  watchKey,
} from './watch.mjs';

// Minimal offline shell. Cached per token path so the secret link is never
// registered at the origin root.
const SW_JS = `const CACHE = 'gowild-v4';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // A cached page is a board frozen at render time: its "updated N min ago", its
  // banners and its row times would all read as current. Navigation must always
  // hit the network, so an offline phone sees a plain failure instead of
  // yesterday's board presented as today's.
  if (req.mode === 'navigate') return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        const c = await caches.open(CACHE);
        c.put(req, copy);
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
// The app notifies for itself: no second app, no topic, and the tap lands on the row
// the update was about. The payload arrives encrypted to this device, which is why it
// can carry a link to the token page at all.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  const opts = {
    body: d.body || '',
    tag: d.tag || 'gowild',
    renotify: Boolean(d.renotify),
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: d.url || './' },
  };
  event.waitUntil(self.registration.showNotification(d.title || 'GoWild', opts));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  const absolute = new URL(target, self.registration.scope).href;
  const bare = absolute.split('?')[0];
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (let i = 0; i < open.length; i += 1) {
      if (open[i].url.split('?')[0] === bare) return open[i].focus();
    }
    return self.clients.openWindow(absolute);
  })());
});`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="#0a0a09"/><path d="M36 118l58-20 22-52 14 6-10 44 34 12-4 14-38-6-16 32-16-6 6-34-40 14z" fill="#d9f24d"/><rect x="0" y="176" width="192" height="16" fill="#d9f24d"/></svg>`;

// Chrome needs real PNGs at 192 and 512 to mint a WebAPK. With only the SVG, the
// install dialog still appears and then produces nothing: measured on the owner's S23
// on 2026-11-12 (dialog shown, Install tapped, no package, no launcher icon).
const png = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' },
  });
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const html = (body) =>
  new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const INGEST_MAX_BYTES = 6 * 1024 * 1024;

// Constant-time compare: the ingest token must not be probeable by timing.
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Exported so the gate can be unit-tested without a Worker, a KV binding or a
// network: the rule being tested is "who may read the board", not the plumbing.
export function boardAuthorized(request, env) {
  const url = new URL(request.url);
  const presented = bearerToken(request) || url.searchParams.get('token');
  return Boolean(env && sameSecret(presented, env.BOARD_TOKEN));
}

// Reads and writes are different capabilities. The board token lives in a URL that is
// meant to be opened and shared, so it must not be able to replace the snapshot: a
// leaked link would otherwise be a write credential behind a single equality check.
// The fallback keeps the collector alive during the deploy that introduces the write
// token; once BOARD_WRITE_TOKEN exists on the Worker, the read token cannot write.
export function ingestAuthorized(request, env) {
  const presented = bearerToken(request);
  const write = env && env.BOARD_WRITE_TOKEN;
  if (write) return sameSecret(presented, write);
  return Boolean(env && sameSecret(presented, env.BOARD_TOKEN));
}

const STALE_ALERT_KEY = 'alert:stale';

// The one signal no collector can send: that no collector is running. This fires from
// the Worker, which still answers when the cron is dead, and is deduped in KV so
// opening the board ten times does not send ten pushes.
//
// Scoped per profile. Measured 2026-11-11: RDU was 6h36m old while PHL was 8h58m, and
// that check read `state` (RDU) on every path -- so opening /phl judged RDU's age, a
// healthy RDU masked a dead PHL, and one shared dedupe key let the first profile to
// alert silence the other two. The key and the label are now the caller's, and the
// check only runs on the pages that actually render that profile.
async function maybeStaleAlert(env, now, key = 'state', label = 'RDU') {
  if (!env || !env.BOARD) return null;
  try {
    // The topic may arrive as a Worker secret, or from the collector's own write.
    // The second path exists so the alert works without the owner copying a value
    // they cannot read back out of GitHub secrets: CI already holds it. The same
    // resolution feeds the bells, so a page can never say push is off while a
    // working topic is sitting in KV.
    // The app carries this now. With no enrolled device there is nowhere to send it,
    // and an answer that says so is better than a no-op that looks like a delivery.
    const subs = await listSubscriptions(env).catch(() => []);
    if (!subs.length) return { sent: false, reason: 'no device enrolled for app notifications' };
    const alertKey = `${STALE_ALERT_KEY}:${key}`;
    const last = Number(await env.BOARD.get(alertKey)) || 0;
    if (last && now - last < 6 * 3600 * 1000) return null;
    const stored = await env.BOARD.get(key, 'json');
    if (!stored) return null;
    const view = buildBoard(stored, now);
    if (!shouldSendStaleAlert(view.ageMin, last, now)) return null;
    await env.BOARD.put(alertKey, String(now));
    const hours = Math.max(1, Math.round((view.ageMin || 0) / 60));
    const out = await sendToAll(env, subs, {
      title: `GoWild ${label}: collector silent ${hours}h`,
      body:
        `No ${label} snapshot for ${hours}h, past the 3h limit. ` +
        'The page is still rendering the last good sweep, which is why it looks alive. ' +
        'Check Actions: the cron or the write path has stopped.',
      tag: 'gowild-stale',
      url: env.BOARD_TOKEN ? `/s/${env.BOARD_TOKEN}` : '/rdu',
      urgency: 'high',
    });
    return { sent: out.sent.length > 0, failed: out.failed };
  } catch (err) {
    console.error('stale alert failed', err && err.message);
    return null;
  }
}

function bearerToken(request) {
  const header = (request.headers.get('authorization') || '').trim();
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

// The collector runs on a GitHub runner and cannot mint a Cloudflare API token
// for itself, so it posts the snapshot here and the Worker owns the KV write.
// BOARD_TOKEN already exists and already gates the page, so this adds no new
// secret and removes a whole class of 401-after-a-full-sweep failures.
//
//   GET  /api/ingest            -> the raw stored state (token required)
//   POST /api/ingest            -> replace it (token required, ?dryRun=1 writes nothing)
//   POST /api/ingest?profile=lga -> replace the LGA snapshot instead of the RDU one
//
// One Worker serves several origins by keeping one KV key per profile. That is
// why a second origin costs no second Worker, no second namespace and no second
// secret: only the key changes.
const WATCH_MAX_BYTES = 2048;

// What a watch looks like outside KV: the observation itself stays private, because
// a client only needs to know that the bell is on and what it is watching.
function publicWatch(w) {
  if (!w || typeof w !== 'object') return null;
  const ev = w.lastEvent && typeof w.lastEvent === 'object' ? w.lastEvent : null;
  return {
    dest: w.dest,
    mode: w.mode,
    date: w.date || null,
    channels: Array.isArray(w.channels) ? w.channels : [],
    createdAt: w.createdAt || null,
    updatedAt: w.updatedAt || null,
    observedAt: w.last && w.last.at ? w.last.at : null,
    stale: w.last ? Boolean(w.last.stale) : null,
    lastEvent: ev ? { kind: ev.kind, at: ev.at, sent: ev.sent || [], failed: ev.failed || [] } : null,
  };
}

// Watching is a write, but it is gated by the same secret that already opens the
// page: a link that can read the board is a link that can ask to be told about it.
// The public profile has no token, so it never gets a bell at all.
async function handleWatch(request, env, url, now) {
  if (!env.BOARD_TOKEN) {
    return json({ ok: false, state: 'unconfigured', message: 'BOARD_TOKEN is not set on this Worker.' }, 503);
  }
  const presented = bearerToken(request) || url.searchParams.get('token');
  if (!sameSecret(presented, env.BOARD_TOKEN)) {
    return json(
      { ok: false, state: 'unauthorized', message: 'Watching needs the board token: open the /s/<token> link and use the bell there.' },
      401,
    );
  }
  // Resolve the topic before answering, so the sheet never draws a channel as off
  // when the collector has already stored a working one in KV.
  const channels = channelStatus(env, await resolveTopic(env));
  if (request.method === 'GET') {
    const watches = await listWatches(env, PROFILE);
    // The outbox is part of the bell's state, not an internal detail: a pending entry
    // that keeps failing is invisible in `lastEvent` (which waits for a 2xx) and used
    // to be invisible here too, so "the watch never fired" and "the push is being
    // retried" looked identical from every caller.
    const outbox = await outboxStatus(env, PROFILE).catch(() => null);
    return json({ ok: true, canWatch: true, channels, outbox, watches: watches.map(publicWatch).filter(Boolean) });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }
  let raw;
  try {
    raw = await request.text();
  } catch (err) {
    return json({ ok: false, state: 'unreadable', message: String(err && err.message) }, 400);
  }
  if (raw.length > WATCH_MAX_BYTES) {
    return json({ ok: false, state: 'too-large', message: `${raw.length} bytes; limit is ${WATCH_MAX_BYTES}` }, 413);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return json({ ok: false, state: 'bad-json', message: String(err && err.message) }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, state: 'bad-shape', message: 'Expected a JSON object.' }, 400);
  }
  const dest = String(body.dest == null ? '' : body.dest).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(dest)) {
    return json({ ok: false, state: 'bad-dest', message: 'dest must be a three-letter airport code.' }, 400);
  }
  if (body.remove) {
    await removeWatch(env, PROFILE, dest);
    return json({ ok: true, removed: dest });
  }
  const known = ((PROFILES[PROFILE] && PROFILES[PROFILE].routes) || []).map((r) => r.code);
  const normalized = normalizeWatch({ ...body, dest }, now, known);
  if (!normalized.ok) {
    return json({ ok: false, state: 'invalid', message: normalized.reason, field: normalized.field }, 400);
  }
  // The last observation survives an edit: changing the channel must not make the
  // next sweep look like a brand-new seat and fire a false "available".
  let existing = null;
  try {
    existing = await env.BOARD.get(watchKey(PROFILE, dest), 'json');
  } catch {
    existing = null;
  }
  const record = {
    ...normalized.watch,
    createdAt: (existing && existing.createdAt) || normalized.watch.createdAt,
    last: (existing && existing.last) || null,
    announced: (existing && existing.announced) || [],
    lastEvent: (existing && existing.lastEvent) || null,
  };
  await saveWatch(env, PROFILE, record);
  const unsent = record.channels.filter((c) => !channels[c] || !channels[c].ready);
  return json({
    ok: true,
    watch: publicWatch(record),
    channels,
    unsent,
    note: unsent.length
      ? `Saved, but ${unsent.join(' + ')} cannot deliver yet: ${unsent.map((c) => channels[c] && channels[c].reason).filter(Boolean).join('; ')}`
      : null,
  });
}

async function handleIngest(request, env, url, ctx) {
  if (!env.BOARD_TOKEN) {
    return json({ ok: false, state: 'unconfigured', message: 'BOARD_TOKEN is not set on this Worker.' }, 503);
  }
  // A write needs the write token once it exists; a read only ever needs the board
  // token, which the owner is expected to put in a URL.
  const allowed =
    request.method === 'POST' ? ingestAuthorized(request, env) : sameSecret(bearerToken(request), env.BOARD_TOKEN);
  if (!allowed) {
    return json(
      {
        ok: false,
        state: 'unauthorized',
        message:
          request.method === 'POST'
            ? 'Writes need BOARD_WRITE_TOKEN; the board token is read-only.'
            : 'Reads need BOARD_TOKEN.',
        writeTokenSplit: Boolean(env.BOARD_WRITE_TOKEN),
      },
      401,
    );
  }

  const wanted = (url.searchParams.get('profile') || PROFILE).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PROFILES, wanted)) {
    return json(
      { ok: false, state: 'bad-profile', message: `Unknown profile "${wanted}".`, known: Object.keys(PROFILES) },
      400,
    );
  }
  const key = wanted === 'rdu' ? 'state' : `state:${wanted}`;

  if (request.method === 'GET') {
    try {
      const stored = await env.BOARD.get(key, 'json');
      return json({ ok: true, profile: wanted, state: stored || null });
    } catch (err) {
      return json({ ok: false, state: 'kv-error', message: String(err && err.message) }, 500);
    }
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }
  // Proves the credentials, the profile and the binding without writing
  // anything, so a caller can fail in one second instead of after a two-minute
  // sweep.
  if (url.searchParams.get('dryRun')) {
    return json({ ok: true, dryRun: true, profile: wanted, creds: 'valid', message: 'Write path reachable; nothing written.' });
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > INGEST_MAX_BYTES) {
    return json({ ok: false, state: 'too-large', message: `${declared} bytes; limit is ${INGEST_MAX_BYTES}` }, 413);
  }
  let raw;
  try {
    raw = await request.text();
  } catch (err) {
    return json({ ok: false, state: 'unreadable', message: String(err && err.message) }, 400);
  }
  if (raw.length > INGEST_MAX_BYTES) {
    return json({ ok: false, state: 'too-large', message: `${raw.length} bytes; limit is ${INGEST_MAX_BYTES}` }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return json({ ok: false, state: 'bad-json', message: String(err && err.message) }, 400);
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.sweeps)) {
    return json({ ok: false, state: 'bad-shape', message: 'Expected an object with a sweeps array.' }, 400);
  }
  // Invariant: a failed sweep must never replace a good snapshot. The collector
  // enforces this; the write boundary enforces it again so a collector bug cannot
  // quietly erase the board.
  if (!payload.sweeps.some((s) => s && s.ok === true)) {
    return json(
      { ok: false, state: 'no-usable-sweep', message: 'Refusing to overwrite the board with a failed sweep.' },
      409,
    );
  }

  // The collector sends the notification topic alongside the snapshot, because it is
  // the only component that knows it and a Worker secret cannot be read back. It is
  // stripped before storage: the snapshot is served by GET /api/ingest, and a push
  // channel does not belong in it.
  const { notifyTopic, ...snapshot } = payload;
  const body = notifyTopic === undefined ? raw : JSON.stringify(snapshot);
  // The snapshot being replaced is the baseline for every watch, so it is read
  // before the write. A failed read is survivable: each watch also carries its own
  // last observation, which is why a Worker that missed one snapshot still works.
  let previous = null;
  try {
    previous = await env.BOARD.get(key, 'json');
  } catch {
    previous = null;
  }
  try {
    await env.BOARD.put(key, body);
    if (validTopic(notifyTopic) && notifyTopic !== env.NTFY_TOPIC) await env.BOARD.put('notify:topic', notifyTopic);
  } catch (err) {
    return json({ ok: false, state: 'kv-error', message: String(err && err.message) }, 500);
  }
  // After the write, never before it: a notification provider having a bad day must
  // not be able to cost the snapshot it was reporting on.
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(evaluateWatches(env, wanted, previous, snapshot, Date.now()));
  }
  return json({
    ok: true,
    profile: wanted,
    stored: body.length,
    updatedAt: payload.updatedAt || null,
    sweeps: payload.sweeps.length,
  });
}

// The app's notification endpoints. One face means one place to look: `state` is what
// the app shows, `subscribe` is how a device enrols, `test` is how the owner proves the
// channel without waiting for a fare to move.
//
//   GET  /api/push/state      -> devices, and whether the keys exist at all
//   POST /api/push/subscribe  -> {endpoint, keys:{p256dh,auth}}
//   POST /api/push/remove     -> {id}
//   POST /api/push/test       -> one push to every device, no sweep needed
async function handlePush(request, env, url, now) {
  const presented = bearerToken(request) || url.searchParams.get('token');
  if (!sameSecret(presented, env.BOARD_TOKEN)) {
    return json({ ok: false, state: 'unauthorized', message: 'Send ?token=<BOARD_TOKEN> or an Authorization: Bearer header.' }, 401);
  }
  const key = publicKey(env);
  const action = url.pathname.slice('/api/push/'.length);
  const profile = (url.searchParams.get('profile') || 'rdu').toLowerCase();

  if (action === 'state' && request.method === 'GET') {
    const subs = await listSubscriptions(env).catch(() => []);
    return json({
      ok: true,
      vapid: Boolean(key && env.VAPID_PRIVATE),
      devices: subs.length,
      subscriptions: subs.map((s) => ({ id: s.id, profile: s.profile, label: s.label, at: s.at, lastOk: s.lastOk, lastError: s.lastError })),
    });
  }

  if (action === 'subscribe' && request.method === 'POST') {
    if (!key || !env.VAPID_PRIVATE) {
      return json({ ok: false, state: 'no-vapid', message: 'VAPID keys are not set on the Worker, so a device cannot be enrolled.' }, 503);
    }
    let body = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const res = await saveSubscription(env, body, { profile, label: String((body && body.label) || '').slice(0, 40), at: now });
    return json({ ok: res.ok, ...(res.ok ? { id: res.id, count: res.count } : { state: 'bad-shape', message: res.reason }) }, res.ok ? 200 : 400);
  }

  if (action === 'remove' && request.method === 'POST') {
    let body = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const id = body && typeof body.id === 'string' ? body.id : '';
    if (!id) return json({ ok: false, state: 'bad-shape', message: 'Expected {"id":"..."}.' }, 400);
    await dropSubscription(env, id);
    return json({ ok: true, devices: (await listSubscriptions(env)).length });
  }

  if (action === 'test' && request.method === 'POST') {
    const subs = await listSubscriptions(env);
    if (!subs.length) {
      return json({ ok: false, state: 'no-devices', message: 'No device has subscribed yet: open the token page and press the enable button.' }, 409);
    }
    const focus = url.searchParams.get('focus');
    // Safe only because the payload is encrypted to the device. It is the one reason a
    // token may appear in a notification at all.
    const link = `/s/${env.BOARD_TOKEN}${focus ? `?focus=${encodeURIComponent(focus)}` : ''}`;
    // A body-less push first: it separates "the push service never delivered" from
    // "Chrome delivered something it could not decrypt", which look identical here.
    if (url.searchParams.get('empty')) {
      const results = [];
      for (const sub of subs) results.push({ id: sub.id, ...(await sendEmpty(sub, env, now)) });
      return json({ ok: results.every((r) => r.ok), empty: true, results });
    }
    const out = await sendToAll(env, subs, {
      title: 'GoWild test',
      body: 'If this appeared, the app notifies for itself.',
      tag: 'gowild-test',
      url: link,
    });
    return json({ ok: out.failed.length === 0, devices: subs.length, ...out });
  }

  return json({ ok: false, state: 'unknown', message: 'GET state, POST subscribe, remove or test.' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const now = Date.now();
    // The staleness check is scheduled by each route that renders a profile, not here:
    // it needs that profile's key, and running it on every asset request cost a KV
    // read plus a full buildBoard to answer a question nobody asked.

    // The one origin that may be served without a token, so a link can be handed
    // to somebody else. Everything else stays behind BOARD_TOKEN.
    // One var, several origins: PUBLIC_PROFILE="lga,phl" serves both at /lga and
    // /phl with no token. Everything else stays behind BOARD_TOKEN.
    const pubs = (env.PUBLIC_PROFILE || '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && Object.prototype.hasOwnProperty.call(PROFILES, s));
    const wantedPub =
      url.pathname.length > 1 && !url.pathname.slice(1).includes('/') ? url.pathname.slice(1) : null;

    // The bare origin used to answer 404, which reads as a broken deploy and gives
    // no hint that the boards live one path segment down.
    if (url.pathname === '/') {
      const items = pubs
        .map((p) => `<li><a href="/${p}">${PROFILES[p].origin} &mdash; ${PROFILES[p].city}</a></li>`)
        .join('');
      return html(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>GoWild boards</title>' +
          '<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:0 auto;padding:2rem">' +
          '<h1 style="font-size:1.4rem">Frontier GoWild boards</h1>' +
          '<p>GoWild departures with an estimated all-in fare of $50.00 or less, for the next 48 hours, nonstop first. Every listed departure is still ahead.</p>' +
          `<ul>${items || '<li>No public board is configured.</li>'}</ul>` +
          (pubs.includes('rdu')
            ? '<p>The RDU board is public at <a href="/rdu">/rdu</a>; the token path <code>/s/&lt;token&gt;</code> still works.</p>'
            : '<p>The RDU board is token-gated: open it from its <code>/s/&lt;token&gt;</code> link.</p>') +
          '</body>',
      );
    }

    if (url.pathname === '/api/ingest') return handleIngest(request, env, url, ctx);

    // The same stale-board gate the Cron Trigger runs, callable by hand. Gated by the
    // board token because it can spend a whole collector run; it is not public.
    if (url.pathname === '/api/dispatch') {
      const presented = bearerToken(request) || url.searchParams.get('token');
      if (!sameSecret(presented, env.BOARD_TOKEN)) {
        return json({ ok: false, state: 'unauthorized', message: 'Send ?token=<BOARD_TOKEN> or an Authorization: Bearer header.' }, 401);
      }
      return json({ ok: true, ...(await maybeDispatch(env, now)) });
    }

    // TASK A: the policy numbers the notification tiers read. Token-gated like every
    // other write, because a briefing time is a setting of the owner's phone.
    if (url.pathname === '/api/settings') {
      const presented = bearerToken(request) || url.searchParams.get('token');
      if (!sameSecret(presented, env.BOARD_TOKEN)) {
        return json({ ok: false, state: 'unauthorized', message: 'Send ?token=<BOARD_TOKEN> or an Authorization: Bearer header.' }, 401);
      }
      if (request.method === 'GET') {
        // The last policy run rides along: without it, "no briefing arrived" is
        // unfalsifiable from outside the Worker.
        const policy = await env.BOARD.get('policy:last', 'json').catch(() => null);
        return json({ ok: true, settings: await readSettings(env), policy });
      }
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
      let patch = null;
      try {
        patch = await request.json();
      } catch {
        patch = null;
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return json({ ok: false, state: 'bad-shape', message: 'Expected a JSON object.' }, 400);
      }
      return json({ ok: true, settings: await writeSettings(env, patch) });
    }

    // The bell's endpoint. Gated inside the handler so the refusal is a sentence,
    // not an empty 401 body from a guard three screens away.
    if (url.pathname === '/api/watch') return handleWatch(request, env, url, now);

    // The app's own notification channel. The public key is public (the browser needs
    // it to subscribe); subscribing, listing and testing are token-gated like every
    // other write.
    if (url.pathname === '/api/push/key') {
      const key = publicKey(env);
      return json({ ok: Boolean(key), key: key ? toB64u(key) : null }, key ? 200 : 503);
    }
    if (url.pathname.startsWith('/api/push/')) return handlePush(request, env, url, now);

    // Authorised before any storage read: an unauthenticated caller must not be
    // able to make the Worker touch KV, and must not learn anything from a
    // storage error either.
    if (url.pathname === '/api/board' && !boardAuthorized(request, env)) {
      return json(
        { ok: false, state: 'unauthorized', message: 'Send ?token=<BOARD_TOKEN> or an Authorization: Bearer header.' },
        401,
      );
    }

    let state = null;
    try {
      state = await env.BOARD.get('state', 'json');
    } catch (err) {
      return json({ ok: false, state: 'kv-error', message: String(err && err.message) }, 500);
    }

    if (url.pathname === '/api/board') {
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(maybeStaleAlert(env, now, 'state', PROFILES[PROFILE].origin));
      }
      if (!state) return json({ ok: false, state: 'no-data', message: 'Collector has never written a snapshot.' });
      const view = buildBoard(state, now);
      return json({
        ok: true,
        updatedAt: view.updatedAt,
        ageMinutes: view.ageMin,
        stale: view.stale,
        error: view.error,
        // Sweep health, not only board health. A partial sweep (a refused route,
        // rows carried from a previous tick) was visible on the page but invisible
        // to every API caller, which is how a collector that crashed on every tick
        // could still look like a healthy board.
        requests: state.requests ?? null,
        // RANK 1: what the LAST attempt did, separate from the last good snapshot.
        // A dead tick advances lastAttempt while updatedAt stays put, and this is
        // where a caller can see both at once.
        lastAttempt: state.lastAttempt || null,
        lastSweep: state.lastSweep || null,
        // Per-day requests / refusals / blocks for the current burst budget.
        refusalDays: state.refusalDays || null,
        aborted: state.aborted || null,
        sweepError: view.error || null,
        routeCount: view.routeCount,
        // Worst per-route age. The board-level ageMin says when the snapshot was
        // written, which is a different fact from whether every route behind it was
        // actually re-checked.
        coverage: view.coverage || null,
        dates: view.dates.map((d) => ({
          date: d.date,
          status: d.status,
          blackout: d.blackout,
          peakLabel: d.peakLabel,
          total: d.total,
          goWild: d.goWild,
          above50: d.above,
          folded: d.folded ? d.folded.length : 0,
          // Age of the data behind the rows the page would offer, and how many were
          // withheld for being older than the ceiling. A caller that sees rows: 0
          // must be able to tell "nothing sold" from "nothing fresh enough".
          withheld: d.withheld || 0,
          oldestAgeMin: d.oldestAgeMin ?? null,
          // The count alone was a dead end: a caller could see four folded options
          // and had no way to ask what they were.
          foldedRows: (d.folded || []).map((f) => ({
            dest: f.dest,
            city: f.city,
            dep: f.dep,
            arr: f.arr,
            allin: f.allin,
            stops: f.stops,
            dur: f.dur,
          })),
          past: Array.isArray(d.past) ? d.past.length : 0,
          rows: d.rows,
        })),
        departed: (view.departed || []).map((d) => ({ date: d.date, past: d.pastCount })),
        // TASK 3a: what actually departed, by route and weekday, with the count of
        // distinct dates behind each time. Post-processing of data already stored --
        // no request is spent, and `n` is the confidence the UI must render.
        ledger: buildLedger(state, now),
        // TASK A: what the notification tiers last did. A tier that fails silently is
        // the failure this board exists to remove, so the outcome rides with the
        // board instead of sitting in a log someone would have to go looking for.
        policy: await env.BOARD.get('policy:last', 'json').catch(() => null),
        frequency: frequencyTable(state, ROUTES),
        schedule: weeklyPattern(state),
        heatmap: bookabilityHeatmap(state),
        timing: releaseTiming(state),
      });
    }

    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,})$/);
    if (match) {
      // One comparison rule for one secret: sameSecret is constant-time, and the
      // page must not use a different rule from the API that guards the same data.
      if (!sameSecret(match[1], env.BOARD_TOKEN)) return new Response('Not found', { status: 404 });
      const view = buildBoard(state, now);
      // The token path is the only place a watch can be created, so it is the only
      // place the bell exists. A KV hiccup here costs the bells, never the board.
      const watches = await listWatches(env, PROFILE).catch(() => []);
      // The bell can only be armed for a channel that resolves, and the topic usually
      // lives in KV rather than in the Worker's own environment.
      const channels = channelStatus(env, await resolveTopic(env));
      // Dead deliveries are the only notification failure the page can report, and
      // the only place the reader would ever find out.
      const outbox = await outboxStatus(env, PROFILE).catch(() => null);
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(maybeStaleAlert(env, now, 'state', PROFILES[PROFILE].origin));
      }
      return html(
        renderPage(view, state, frequencyTable(state, ROUTES), now, {
          basePath: `/s/${match[1]}`,
          origin: PROFILES[PROFILE].origin,
          canWatch: true,
          watches,
          channels,
          outbox,
          // Every profile the Worker knows about, with the one this page is. The page
          // must be able to show an origin it cannot serve rather than omit it.
          origins: Object.keys(PROFILES).map((k) => ({
            code: PROFILES[k].origin,
            city: PROFILES[k].city,
            routes: (PROFILES[k].routes || []).length,
            live: k === PROFILE,
          })),
          // Post-processing of stored observations only: the projection the page
          // draws costs no request.
          ledger: buildLedger(state, now),
        }),
      );
    }

    // Public profile page: no token in the URL, because the whole point of this
    // one is that it can be sent to someone. It reads only its own profile's key,
    // so the primary board is unaffected by it.
    if (wantedPub && pubs.includes(wantedPub)) {
      const pubOk = wantedPub;
      let mine = null;
      try {
        mine = await env.BOARD.get(pubOk === 'rdu' ? 'state' : `state:${pubOk}`, 'json');
      } catch (err) {
        return json({ ok: false, state: 'kv-error', message: String(err && err.message) }, 500);
      }
      const origin = PROFILES[pubOk].origin;
      if (!mine) {
        // Never an empty grid with no explanation: say exactly what is missing.
        return html(
          `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
            `<meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<title>${origin} GoWild</title></head>` +
            `<body style="margin:0;padding:2rem;background:#0a0a09;color:#f4f0e5;font:15px/1.6 'Helvetica Neue',Arial,sans-serif">` +
            `<p style="margin:0 0 14px;font:9px/1 ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;color:#8d877a">Frontier GoWild</p>` +
            `<h1 style="margin:0 0 14px;font:700 46px/.84 'Arial Narrow','Helvetica Neue',Arial,sans-serif;letter-spacing:-.025em;text-transform:uppercase">${origin} <span style="color:#d9f24d">GoWild</span></h1>` +
            `<div style="width:46px;height:3px;background:#d9f24d;margin:0 0 18px"></div>` +
            `<p>No snapshot for ${origin} yet. The collector has not written one for this origin, so there is ` +
            `nothing to show rather than nothing available. This page fills in on its next run.</p>` +
            `</body></html>`,
        );
      }
      const view = buildBoard(mine, now);
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(
          maybeStaleAlert(env, now, pubOk === 'rdu' ? 'state' : `state:${pubOk}`, origin),
        );
      }
      return html(
        renderPage(view, mine, frequencyTable(mine, PROFILES[pubOk].routes), now, {
          basePath: `/${pubOk}`,
          origin,
          // No token, no bell: a public link must not be able to subscribe the
          // owner's phone to a stranger's question.
          canWatch: false,
          origins: Object.keys(PROFILES).map((k) => ({
            code: PROFILES[k].origin,
            city: PROFILES[k].city,
            routes: (PROFILES[k].routes || []).length,
            live: k === pubOk,
          })),
        }),
      );
    }

    // PWA assets: the token path, or the public profile prefix when one is enabled.
    let asset = null;
    const tokAsset = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,})\/(manifest\.webmanifest|sw\.js|icon\.svg|icon-192\.png|icon-512\.png)$/);
    if (tokAsset) {
      if (!sameSecret(tokAsset[1], env.BOARD_TOKEN)) return new Response('Not found', { status: 404 });
      asset = { base: `/s/${tokAsset[1]}`, name: tokAsset[2], origin: PROFILES[PROFILE].origin };
    } else {
      const pubAsset = url.pathname.match(/^\/([a-z]{3})\/(manifest\.webmanifest|sw\.js|icon\.svg|icon-192\.png|icon-512\.png)$/);
      if (pubAsset && pubs.includes(pubAsset[1])) {
        asset = { base: `/${pubAsset[1]}`, name: pubAsset[2], origin: PROFILES[pubAsset[1]].origin };
      }
    }
    if (asset) {
      if (asset.name === 'manifest.webmanifest') {
        const body = JSON.stringify({
          name: `${asset.origin} GoWild Board`,
          short_name: 'GoWild',
          start_url: asset.base,
          scope: asset.base,
          display: 'standalone',
          background_color: '#0a0a09',
          theme_color: '#0a0a09',
          icons: [
            { src: `${asset.base}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: `${asset.base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: `${asset.base}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
        });
        return new Response(body, {
          headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' },
        });
      }
      if (asset.name === 'icon-192.png') return png(ICON_192_PNG);
      if (asset.name === 'icon-512.png') return png(ICON_512_PNG);
      if (asset.name === 'icon.svg') {
        return new Response(ICON_SVG, {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' },
        });
      }
      return new Response(SW_JS, {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Service-Worker-Allowed': asset.base,
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  // Cloudflare Cron Trigger, every 15 minutes (see [triggers] in wrangler.toml). It
  // does not depend on GitHub's scheduler, which is the one thing sweep.yml cannot
  // fix from inside: a dropped schedule event leaves no run to recover in.
  async scheduled(controller, env, ctx) {
    const now = Date.now();
    const work = (async () => {
      const dispatched = await maybeDispatch(env, now);
      // The tiers never get to block the dispatch gate: recovering a stalled board is
      // the one job that must survive a notification provider having a bad day.
      let policy = null;
      try {
        policy = await runPolicy(env, now);
      } catch (err) {
        console.error('policy failed', err && err.message);
      }
      return { dispatched, policy };
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
    else await work;
  },
};
