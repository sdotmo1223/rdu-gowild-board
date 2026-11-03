// Assemble captured sweep files into board state and render the real page.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildBoard } from '../src/board.js';
import { renderPage } from '../src/render.js';
import { normalizeSeats } from '../collector/parse.mjs';
import { ROUTES } from '../src/routes.js';

const cityOf = (code) => (ROUTES.find((r) => r.code === code) || {}).city || code;

const files = readdirSync('.sweep').filter((f) => f.endsWith('.json'));
if (!files.length) {
  console.error('no sweep files found');
  process.exit(1);
}

const recs = files.map((f) => JSON.parse(readFileSync(`.sweep/${f}`, 'utf8')));

const sweeps = recs.map((r) => ({
  date: r.iso,
  dest: r.dest,
  ok: !r.blocked && !r.error,
  blocked: Boolean(r.blocked),
  reason: r.error || (r.blocked ? 'datadome-redirect' : 'ok'),
  flights: (r.flights || []).map((f) => {
    const goWild = Boolean(f.enabled) && typeof f.gw === 'number' && f.gw > 0;
    return {
      date: r.iso,
      dest: r.dest,
      city: cityOf(r.dest),
      dep: f.dep,
      arr: f.arr,
      stops: f.stops || '',
      nonstop: Boolean(f.nonstop),
      dur: f.dur,
      seats: normalizeSeats(f.seats),
      allin: goWild ? Math.round(f.gw * 100) / 100 : null,
      std: typeof f.std === 'number' && f.std > 0 ? f.std : null,
      goWild,
    };
  }),
}));

const state = {
  version: 1,
  routeCount: ROUTES.length,
  sweeps,
  updatedAt: Date.now(),
  history: [],
  observed: {},
  days: {},
  lastError: sweeps.every((s) => s.blocked) ? { kind: 'blocked', detail: 'every route blocked' } : null,
};

const now = Date.now();
const view = buildBoard(state, now);
writeFileSync('board.html', renderPage(view, state, [], now));

let totalGw = 0;
let totalRows = 0;
for (const d of view.dates) {
  console.log(`\n=== ${d.date} status=${d.status} flights=${d.total} goWild=${d.goWild} qualified=${d.rows.length} above50=${d.above} failed=${d.failedRoutes} blocked=${d.blockedRoutes} lowest=${d.lowest}`);
  for (const r of d.rows) {
    console.log(`  ${r.dest} ${String(r.city).padEnd(16)} ${String(r.dep).slice(11, 16)} -> ${String(r.arr).slice(11, 16)} ${r.stops.padEnd(12)} ${String(r.dur).padEnd(22)} seats=${r.seats === null ? '-' : r.seats} $${r.allin.toFixed(2)}`);
  }
  totalGw += d.goWild;
  totalRows += d.rows.length;
}

console.log(`\nTOTAL goWildFaresSeen=${totalGw} qualifiedRows=${totalRows} dates=${view.dates.length} stale=${view.stale}`);
console.log(`wrote board.html (${readFileSync('board.html', 'utf8').length} bytes)`);
