import { buildBoard } from './board.js';
import { renderPage } from './render.js';
import { frequencyTable } from './frequency.js';
import { bookabilityHeatmap } from './heatmap.mjs';
import { releaseTiming } from './timing.mjs';
import { weeklyPattern } from './schedule.mjs';
import { ROUTES } from './routes.js';

// Minimal offline shell. Cached per token path so the secret link is never
// registered at the origin root.
const SW_JS = `const CACHE = 'rdu-gowild-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
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

const INGEST_MAX_BYTES = 6 * 1024 * 1024;

// Constant-time compare: the ingest token must not be probeable by timing.
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
//   GET  /api/ingest   -> the raw stored state (token required)
//   POST /api/ingest   -> replace it (token required, ?dryRun=1 writes nothing)
async function handleIngest(request, env, url) {
  if (!env.BOARD_TOKEN) {
    return json({ ok: false, state: 'unconfigured', message: 'BOARD_TOKEN is not set on this Worker.' }, 503);
  }
  if (!sameSecret(bearerToken(request), env.BOARD_TOKEN)) {
    return json({ ok: false, state: 'unauthorized', message: 'Bad or missing bearer token.' }, 401);
  }

  if (request.method === 'GET') {
    try {
      const stored = await env.BOARD.get('state', 'json');
      return json({ ok: true, state: stored || null });
    } catch (err) {
      return json({ ok: false, state: 'kv-error', message: String(err && err.message) }, 500);
    }
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }
  // Proves the credentials and the binding without writing anything, so a caller
  // can fail in one second instead of after a two-minute sweep.
  if (url.searchParams.get('dryRun')) {
    return json({ ok: true, dryRun: true, creds: 'valid', message: 'Write path reachable; nothing written.' });
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
    await env.BOARD.put('state', raw);
  } catch (err) {
    return json({ ok: false, state: 'kv-error', message: String(err && err.message) }, 500);
  }
  return json({ ok: true, stored: raw.length, updatedAt: payload.updatedAt || null, sweeps: payload.sweeps.length });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname === '/api/ingest') return handleIngest(request, env, url);

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
          rows: d.rows,
        })),
        frequency: frequencyTable(state, ROUTES),
        schedule: weeklyPattern(state),
        heatmap: bookabilityHeatmap(state),
        timing: releaseTiming(state),
      });
    }

    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,})$/);
    if (match) {
      if (!env.BOARD_TOKEN || match[1] !== env.BOARD_TOKEN) return new Response('Not found', { status: 404 });
      const view = buildBoard(state, now);
      const html = renderPage(view, state, frequencyTable(state, ROUTES), now, {
        basePath: `/s/${match[1]}`,
      });
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // PWA assets, token-gated so the secret link is not discoverable at the root.
    const asset = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,})\/(manifest\.webmanifest|sw\.js|icon\.svg)$/);
    if (asset) {
      if (!env.BOARD_TOKEN || asset[1] !== env.BOARD_TOKEN) return new Response('Not found', { status: 404 });
      const base = `/s/${asset[1]}`;
      if (asset[2] === 'manifest.webmanifest') {
        const body = JSON.stringify({
          name: 'RDU GoWild Board',
          short_name: 'GoWild',
          start_url: base,
          scope: base,
          display: 'standalone',
          background_color: '#0d0f13',
          theme_color: '#0d0f13',
          icons: [{ src: `${base}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        });
        return new Response(body, {
          headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' },
        });
      }
      if (asset[2] === 'icon.svg') {
        return new Response(ICON_SVG, {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' },
        });
      }
      return new Response(SW_JS, {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Service-Worker-Allowed': base,
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
