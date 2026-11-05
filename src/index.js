import { buildBoard } from './board.js';
import { renderPage } from './render.js';
import { frequencyTable } from './frequency.js';
import { bookabilityHeatmap } from './heatmap.mjs';
import { releaseTiming } from './timing.mjs';
import { weeklyPattern } from './schedule.mjs';
import { ROUTES, PROFILES, PROFILE } from './routes.js';

// Minimal offline shell. Cached per token path so the secret link is never
// registered at the origin root.
const SW_JS = `const CACHE = 'gowild-v2';
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
});`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0d0f13"/><path d="M36 118l58-20 22-52 14 6-10 44 34 12-4 14-38-6-16 32-16-6 6-34-40 14z" fill="#3fb950"/></svg>`;

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
async function handleIngest(request, env, url) {
  if (!env.BOARD_TOKEN) {
    return json({ ok: false, state: 'unconfigured', message: 'BOARD_TOKEN is not set on this Worker.' }, 503);
  }
  if (!sameSecret(bearerToken(request), env.BOARD_TOKEN)) {
    return json({ ok: false, state: 'unauthorized', message: 'Bad or missing bearer token.' }, 401);
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

  try {
    await env.BOARD.put(key, raw);
  } catch (err) {
    return json({ ok: false, state: 'kv-error', message: String(err && err.message) }, 500);
  }
  return json({
    ok: true,
    profile: wanted,
    stored: raw.length,
    updatedAt: payload.updatedAt || null,
    sweeps: payload.sweeps.length,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const now = Date.now();

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
          '<p>The RDU board is token-gated: open it from its <code>/s/&lt;token&gt;</code> link.</p>' +
          '</body>',
      );
    }

    if (url.pathname === '/api/ingest') return handleIngest(request, env, url);

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
        lastSweep: state.lastSweep || null,
        aborted: state.aborted || null,
        sweepError: view.error || null,
        routeCount: view.routeCount,
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
      return html(
        renderPage(view, state, frequencyTable(state, ROUTES), now, {
          basePath: `/s/${match[1]}`,
          origin: PROFILES[PROFILE].origin,
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
            `<body style="margin:0;padding:2rem;background:#0d0f13;color:#e6edf3;font:16px/1.5 system-ui,sans-serif">` +
            `<h1 style="margin:0 0 1rem">${origin} <span style="color:#3fb950">GoWild</span></h1>` +
            `<p>No snapshot for ${origin} yet. The collector has not written one for this origin, so there is ` +
            `nothing to show rather than nothing available. This page fills in on its next run.</p>` +
            `</body></html>`,
        );
      }
      const view = buildBoard(mine, now);
      return html(
        renderPage(view, mine, frequencyTable(mine, PROFILES[pubOk].routes), now, {
          basePath: `/${pubOk}`,
          origin,
        }),
      );
    }

    // PWA assets: the token path, or the public profile prefix when one is enabled.
    let asset = null;
    const tokAsset = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,})\/(manifest\.webmanifest|sw\.js|icon\.svg)$/);
    if (tokAsset) {
      if (!sameSecret(tokAsset[1], env.BOARD_TOKEN)) return new Response('Not found', { status: 404 });
      asset = { base: `/s/${tokAsset[1]}`, name: tokAsset[2], origin: PROFILES[PROFILE].origin };
    } else {
      const pubAsset = url.pathname.match(/^\/([a-z]{3})\/(manifest\.webmanifest|sw\.js|icon\.svg)$/);
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
          background_color: '#0d0f13',
          theme_color: '#0d0f13',
          icons: [{ src: `${asset.base}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        });
        return new Response(body, {
          headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' },
        });
      }
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
};
