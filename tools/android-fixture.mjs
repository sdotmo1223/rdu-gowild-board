// Build the Android app's sample board from a real collector snapshot.
//
// The app ships a bundled snapshot so the five designs can be judged on design
// rather than on whether a laptop can reach the Worker. It is NOT invented data:
// every row here was observed from Frontier, and the only edit is that the capture
// is rebased forward so the days it shows are today and tomorrow.
//
//   node tools/android-fixture.mjs
//
// Writes android/app/src/main/assets/board.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildBoard } from '../src/board.js';

const SOURCE = process.argv[2] || 'state.live.json';
const OUT = 'android/app/src/main/assets/board.json';
// 04:00 local, in November (EST). The fixture is a *morning board* on purpose: it is
// the moment of the day with the most still-bookable departures, and every row is
// ahead of the snapshot's own clock. It is 04:00 and not 06:00 because the earliest
// RDU departure is 06:30 and the airport buffer is 2 h: a 06:00 clock marks every
// morning row "leave now", which is an artefact of the fixture, not of the data.
const MORNING = 'T04:00:00-05:00';

const etDate = (ms) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));

const dayIndex = (iso) => Math.round(Date.parse(`${iso}T12:00:00Z`) / 86400000);
const addDays = (iso, n) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const state = JSON.parse(readFileSync(SOURCE, 'utf8'));
const today = etDate(Date.now());
const firstDate = (state.sweeps || []).map((s) => s.date).filter(Boolean).sort()[0];
if (!firstDate) throw new Error(`${SOURCE} has no dated sweeps`);
const shift = dayIndex(today) - dayIndex(firstDate);
const fixtureNow = Date.parse(`${today}${MORNING}`);

const rebase = (iso) => {
  if (!iso || typeof iso !== 'string' || iso.length < 10) return iso;
  const day = addDays(iso.slice(0, 10), shift);
  return day + iso.slice(10);
};

const next = {
  ...state,
  updatedAt: fixtureNow - 6 * 60000,
  sweeps: (state.sweeps || []).map((s) => ({
    ...s,
    date: rebase(s.date),
    at: fixtureNow - 6 * 60000,
    flights: (s.flights || []).map((f) => ({ ...f, date: rebase(f.date), dep: rebase(f.dep), arr: rebase(f.arr) })),
  })),
  coverage: Object.fromEntries(
    Object.entries(state.coverage || {}).map(([k, v]) => [k, { ...v, lastOkAt: fixtureNow - 6 * 60000 }]),
  ),
};

const view = buildBoard(next, fixtureNow);
if (!view.dates.length) throw new Error('rebased snapshot produced no visible dates');

const weekday = (iso) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${iso}T12:00:00Z`));
const month = (iso) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(new Date(`${iso}T12:00:00Z`)).toUpperCase();

const clock12 = (stamp) => {
  const [h, m] = stamp.slice(11, 16).split(':').map(Number);
  const pm = h >= 12;
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`;
};

// "1 hrs 46 min" / "1 day(s) 5 hrs 26 min" -> "1H 46M" / "1D 5H 26M"
const compactDur = (raw) => {
  const s = String(raw || '');
  const day = /(\d+)\s*day/.exec(s);
  const hrs = /(\d+)\s*hrs?/.exec(s);
  const min = /(\d+)\s*min/.exec(s);
  const out = [];
  if (day) out.push(`${day[1]}D`);
  if (hrs) out.push(`${hrs[1]}H`);
  if (min) out.push(`${min[1]}M`);
  return out.join(' ') || '—';
};

const days = view.dates.map((d, i) => {
  // Chronological, not the board's own rank order: on a phone a departure board is
  // read as a timeline, and “nonstop first” only reorders rows it should not.
  const rows = d.rows
    .slice()
    .sort((a, b) => String(a.dep).localeCompare(String(b.dep)))
    .slice(0, 12)
    .map((r) => ({
    dep: r.dep,
    clock: r.dep.slice(11, 16),
    clock12: clock12(r.dep),
    dest: r.dest,
    city: String(r.city || r.dest).toUpperCase(),
    stops: String(r.stops || '').toUpperCase(),
    dur: compactDur(r.dur),
    seats: typeof r.seats === 'number' ? r.seats : null,
    allin: r.allin,
    leaveBy: r.leaveBy ? clock12(r.leaveBy) : null,
    tight: Boolean(r.tight),
  }));
  return {
    date: d.date,
    weekday: weekday(d.date),
    dayNum: d.date.slice(8, 10),
    month: month(d.date),
    label: i === 0 ? 'TODAY' : i === 1 ? 'TOMORROW' : weekday(d.date).toUpperCase(),
    options: rows.length,
    from: rows.length ? Math.min(...rows.map((r) => r.allin)) : null,
    rows,
  };
});

const board = {
  // Not a live board, and the app says so on every design. Wiring this to
  // GET /api/board is the next step; it needs the deployed origin, which the repo
  // does not hold.
  sample: true,
  source: `${SOURCE} @ ${new Date(state.updatedAt).toISOString()}`,
  origin: 'RDU',
  originCity: 'RALEIGH/DURHAM',
  routeCount: view.routeCount || 14,
  ageMinutes: 6,
  stale: Boolean(view.stale),
  days,
};

mkdirSync(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(board, null, 1)}\n`);

console.log(`wrote ${OUT}`);
console.log(`  source   ${board.source}`);
console.log(`  fixture  ${new Date(fixtureNow).toISOString()} (${MORNING.slice(1, 3)}:00 ET, ${today})`);
console.log(`  days     ${days.map((d) => `${d.label} ${d.date} ${d.rows.length} rows from $${d.from}`).join(' | ')}`);
console.log(`  flights  ${days.reduce((n, d) => n + d.rows.length, 0)}`);
