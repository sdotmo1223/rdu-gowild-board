// Rebuild state.json from the interactive captures in .sweep/, including the
// schedule matrix, observations and first-seen timestamps. Used to render a real
// board (and to seed the weekly-schedule view) without spending a request.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ROUTES } from '../src/routes.js';
import { normalizeSeats } from '../collector/parse.mjs';
import { recordSchedule } from '../src/schedule.mjs';
import { recordObservation, recordFirstSeen } from '../src/history.js';

const cityOf = (code) => (ROUTES.find((r) => r.code === code) || {}).city || code;
const round2 = (n) => Math.round(n * 100) / 100;

const files = readdirSync('.sweep').filter((f) => f.endsWith('.json'));
if (!files.length) {
  console.error('no .sweep captures found; run a sweep first');
  process.exit(1);
}

const sweeps = files.map((f) => {
  const r = JSON.parse(readFileSync(`.sweep/${f}`, 'utf8'));
  return {
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
        allin: goWild ? round2(f.gw) : null,
        std: typeof f.std === 'number' && f.std > 0 ? round2(f.std) : null,
        goWild,
      };
    }),
  };
});

const now = Date.now();
const state = {
  version: 1,
  routeCount: ROUTES.length,
  sweeps,
  updatedAt: now,
  history: [],
  observed: {},
  days: {},
  schedule: {},
  firstSeen: {},
  lastError: null,
};

const boardRows = sweeps
  .flatMap((s) => s.flights)
  .filter((f) => f.goWild && typeof f.allin === 'number' && f.allin > 0 && f.allin <= 50);

recordFirstSeen(state, boardRows, now);
const dates = [...new Set(sweeps.map((s) => s.date))];
for (const d of dates) {
  recordSchedule(state, d, sweeps, now);
  recordObservation(state, d, boardRows.filter((r) => r.date === d));
}

const blob = JSON.stringify(state);
writeFileSync('state.json', blob);
console.log(`seeded state.json from ${files.length} captures: ${blob.length} bytes`);
console.log(`dates=${dates.length} scheduleDates=${Object.keys(state.schedule).length} firstSeen=${Object.keys(state.firstSeen).length}`);
