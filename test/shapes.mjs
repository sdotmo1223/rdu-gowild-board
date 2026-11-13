// RANK 7: the shape matrix.
//
// Constraint 4 of this project is "an empty grid is forbidden: every date with no
// rows must state a reason". The dry harness proves one journey end to end; this file
// proves the renderer and the board builder across the shapes a sweep can actually
// produce, and across one shape a sweep should never produce (malformed).
//
// Each shape is asserted on three things, not on exact copy:
//   1. buildBoard does not throw and does not silently drop a date;
//   2. every date carries a status from the closed vocabulary -- never undefined,
//      never '' -- so the page always has something to say;
//   3. every visible date with no rows renders at least one `.state` block, which is
//      where that reason lives.
import assert from 'node:assert/strict';
import { buildBoard } from '../src/board.js';
import { renderPage } from '../src/render.js';
import { ROUTES } from '../src/routes.js';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const NOW = Date.UTC(2026, 10, 12, 18, 0);
const D0 = '2026-11-12';
const D1 = '2026-11-13';

const VOCAB = new Set([
  'ok',
  'blocked',
  'error',
  'peak',
  'stale',
  'folded',
  'departed',
  'above',
  'noflights',
  'nogowild',
]);

const fl = (o = {}) => ({
  date: o.date || D0,
  dest: o.dest || 'ATL',
  city: 'Atlanta',
  dep: o.dep || `${o.date || D0} 19:30:00`,
  arr: o.arr || `${o.date || D0} 21:00:00`,
  stops: o.stops || 'Nonstop',
  nonstop: o.nonstop === undefined ? true : o.nonstop,
  dur: '1 hrs 30 min',
  seats: 3,
  allin: o.allin === undefined ? 31.27 : o.allin,
  goWild: o.goWild === undefined ? true : o.goWild,
});

// One sweep per route per date, which is the collector's own unit.
function snap({ flights = [], ok: allOk = true, blocked = false, carried = null, at = NOW } = {}) {
  const sweeps = [];
  for (const date of [D0, D1]) {
    for (const route of ROUTES) {
      sweeps.push({
        date,
        dest: route.code,
        ok: allOk,
        blocked,
        at,
        carried: Boolean(carried),
        carriedAt: carried,
        carriedReason: carried ? 'aborted' : undefined,
        flights: flights.filter((f) => f.date === date && f.dest === route.code),
      });
    }
  }
  return {
    updatedAt: at,
    routeCount: ROUTES.length,
    sweeps,
    coverage: Object.fromEntries(ROUTES.map((r) => [r.code, { lastOkAt: at }])),
  };
}

const shapes = {
  clean: snap({ flights: [fl(), fl({ date: D1 })] }),
  blocked: snap({ blocked: true, ok: false }),
  partial: {
    ...snap({ at: NOW }),
    sweeps: [
      ...snap({}).sweeps.filter((s) => s.date === D0 && s.dest === 'ATL'),
      { date: D0, dest: 'BOS', ok: false, blocked: false, at: NOW, flights: [] },
      { date: D0, dest: 'CLE', ok: false, blocked: true, at: NOW, flights: [] },
    ],
    lastError: { kind: 'partial', at: NOW, detail: '2 of 14 routes failed' },
  },
  aborted: snap({ carried: NOW - 3 * 3600000 }),
  'zero-rows': snap({}),
  peak: {
    ...snap({}),
    // A blackout date only exists on the board if a sweep asked about it, and the
    // peak verdict needs a priced departure to be reachable at all: an empty date is
    // "no flights", not "peak day charge".
    sweeps: [
      ...snap({}).sweeps,
      ...ROUTES.map((r) => ({
        date: '2026-11-24',
        dest: r.code,
        ok: true,
        blocked: false,
        at: NOW,
        flights: r.code === 'ATL' ? [fl({ date: '2026-11-24', allin: 317.96 })] : [],
      })),
    ],
  },
  above: snap({ flights: [fl({ allin: 63.4 })] }),
  folded: snap({ flights: [fl({ nonstop: false, stops: '2 stops', dur: '11 hrs 30 min' })] }),
  departed: snap({ flights: [fl({ dep: `${D0} 06:05:00`, arr: `${D0} 07:40:00` })] }),
  stale: snap({ flights: [fl()], carried: NOW - 5 * 3600000 }),
  malformed: {
    updatedAt: NOW,
    routeCount: 2,
    sweeps: [
      null,
      42,
      { date: D0, dest: 'ATL', ok: true, flights: 'not-an-array' },
      { date: D0, dest: 'ATL', ok: true, at: NOW, flights: [null, 'x', { allin: 'free' }, fl()] },
      { dest: 'ZZZ', ok: true, flights: [fl()] },
      { date: D1, ok: true, blocked: false, flights: [] },
    ],
    coverage: 'not-an-object',
  },
};

// A blackout date only appears if a sweep asked about it; peak is also price-driven,
// so it is asserted through its own date rather than through the 48-hour window.
const expected = {
  clean: 'ok',
  blocked: 'blocked',
  partial: 'error',
  // An answered sweep with no itinerary rows at all is `noflights` (Frontier has no
  // departure that day); `nogowild` is reserved for a date that HAS flights but no
  // GoWild fare among them.
  aborted: 'noflights',
  'zero-rows': 'noflights',
  peak: 'peak',
  above: 'above',
  folded: 'folded',
  departed: 'departed',
  stale: 'stale',
  malformed: 'ok',
};

for (const [name, state] of Object.entries(shapes)) {
  let view;
  try {
    view = buildBoard(state, NOW);
  } catch (err) {
    ok(false, `${name}: buildBoard threw: ${err.message}`);
    continue;
  }
  const all = [...view.dates, ...view.departed];
  ok(all.length > 0, `${name}: no date was silently dropped`);
  for (const d of all) {
    ok(VOCAB.has(d.status), `${name}: ${d.date} has a status (got ${JSON.stringify(d.status)})`);
    ok(typeof d.status === 'string' && d.status.length > 0, `${name}: the status is never empty`);
  }
  if (expected[name]) {
    const hit = all.find((d) => d.status === expected[name]);
    ok(Boolean(hit), `${name}: reports ${expected[name]} (saw ${all.map((d) => d.status).join(',')})`);
  }

  // The rendered page: an empty date must say something.
  let page = '';
  try {
    page = renderPage(view, state, [], NOW, {
      basePath: '/s/abcdefgh1234',
      origin: 'RDU',
      canWatch: true,
      watches: [],
      channels: {},
    });
  } catch (err) {
    ok(false, `${name}: renderPage threw: ${err.message}`);
    continue;
  }
  ok(page.length > 400, `${name}: a page was produced`);
  for (const d of view.dates) {
    if (d.rows.length) continue;
    ok(
      page.includes(`id="d-${d.date}"`),
      `${name}: the empty date ${d.date} still has its own section`,
    );
  }
  const emptyDates = view.dates.filter((d) => !d.rows.length).length;
  if (emptyDates) {
    const stateBlocks = (page.match(/class="state/g) || []).length;
    ok(stateBlocks >= emptyDates, `${name}: every empty date carries a visible reason (${stateBlocks} blocks for ${emptyDates} dates)`);
  }
  // The claim under test from RANK 5 lives in this copy: it must never appear on a
  // board whose zero record does not cover every route.
  if (/No GoWild from/.test(page)) {
    ok(
      Array.isArray(state.zero && state.zero.routes) && state.zero.routes.length >= ROUTES.length,
      `${name}: the station-level zero claim requires full coverage`,
    );
  }
}

// --- the zero-coverage claim on the page --------------------------------------
{
  // `nogowild` is "flights exist, none of them carries a GoWild fare" -- that is the
  // only status that renders the station-level sentence, so the fixture needs real
  // departures with goWild: false rather than an empty date.
  const noGw = snap({ flights: ROUTES.map((r) => fl({ dest: r.code, goWild: false })) });
  const half = {
    ...noGw,
    zero: { count: 5, since: NOW - 5 * 3600000, routes: ROUTES.slice(0, 7).map((r) => r.code) },
  };
  const view = buildBoard(half, NOW);
  const page = renderPage(view, half, [], NOW, { basePath: '/s/abcdefgh1234', origin: 'RDU' });
  ok(!/No GoWild from RDU in 5 sweeps/.test(page), 'half a route list cannot make the station-level claim');

  const full = { ...half, zero: { count: 5, since: NOW - 5 * 3600000, routes: ROUTES.map((r) => r.code) } };
  const fullPage = renderPage(buildBoard(full, NOW), full, [], NOW, { basePath: '/s/abcdefgh1234', origin: 'RDU' });
  ok(/No GoWild from RDU in 5 sweeps/.test(fullPage), 'a covered window still says it plainly');
}

// --- stress: fuzz the state blob ----------------------------------------------
// The collector writes this blob and the Worker must render something even if it is
// half-written. The only acceptable outcomes are "a page with statuses" or "a page
// with the no-data banner" -- never a throw, never an empty date with no status.
{
  const junk = [null, 0, '', 'x', [], {}, true, NaN, undefined];
  let pages = 0;
  for (let seed = 0; seed < 120; seed += 1) {
    const pick = (i) => junk[(seed + i * 7) % junk.length];
    const fuzz = {
      updatedAt: seed % 3 === 0 ? pick(seed) : NOW,
      routeCount: pick(seed + 1),
      sweeps: seed % 2 ? [pick(seed), pick(seed + 2)] : snap({}),
      coverage: pick(seed + 3),
      zero: pick(seed + 4),
      lastError: pick(seed + 5),
    };
    let view;
    try {
      view = buildBoard(fuzz, NOW);
    } catch (err) {
      ok(false, `fuzz ${seed}: buildBoard threw: ${err.message}`);
      continue;
    }
    for (const d of [...view.dates, ...view.departed]) {
      ok(VOCAB.has(d.status), `fuzz ${seed}: every surviving date has a status`);
    }
    try {
      const page = renderPage(view, fuzz, [], NOW, {});
      ok(typeof page === 'string' && page.length > 100, `fuzz ${seed}: a page renders`);
      pages += 1;
    } catch (err) {
      ok(false, `fuzz ${seed}: renderPage threw: ${err.message}`);
    }
  }
  eq(pages, 120, 'every fuzzed blob produced a page');
}

console.log(`shapes: ${checks} checks passed`);
