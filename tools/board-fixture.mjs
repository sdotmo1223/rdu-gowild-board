// Board fixtures for design review: a real capture, rebased to a morning clock so
// every departure is still ahead, plus the three shapes the page has to survive.
//
//   node tools/board-fixture.mjs
//   NOW=$(cat .dry/fixture-now.txt) STATE_IN=.dry/state-fresh.json node tools/render-state.mjs
//
// Deliberately NOT part of npm test: this exists so a design change can be looked at
// at 412px wide, against data that looks like a real sweep, instead of against an
// eleven-day-old snapshot with no rows (which is what state.json is by now).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = JSON.parse(readFileSync(process.env.STATE_IN || 'state.json', 'utf8'));
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

const today = etDate(Date.now());
const firstDate = (src.sweeps || []).map((s) => s.date).filter(Boolean).sort()[0];
const shift = dayIndex(today) - dayIndex(firstDate);
// A morning clock is the only time of day when a two-date window has every row still
// ahead of it, so the board looks like the one the owner actually reads at 7am.
const at = Date.parse(`${today}T06:00:00-05:00`);
const rebaseTime = (iso) => {
  if (!iso || typeof iso !== 'string' || iso.length < 10) return iso;
  return addDays(iso.slice(0, 10), shift) + iso.slice(10);
};

const rebuild = (state, { updatedAgoMin = 6, oldestRouteMin = null, blockedDate = null, noFlights = false } = {}) => {
  const updatedAt = at - updatedAgoMin * 60000;
  const coverage = Object.fromEntries(
    Object.entries(state.coverage || {}).map(([k, v], i) => [
      k,
      { ...v, lastOkAt: oldestRouteMin && i % 5 === 0 ? at - oldestRouteMin * 60000 : updatedAt },
    ]),
  );
  return {
    ...state,
    updatedAt,
    sweeps: (state.sweeps || []).map((s) => ({
      ...s,
      date: rebaseTime(s.date),
      at: updatedAt,
      blocked: blockedDate && rebaseTime(s.date) === blockedDate ? true : Boolean(s.blocked),
      ok: blockedDate && rebaseTime(s.date) === blockedDate ? false : s.ok !== false,
      flights: noFlights ? [] : (s.flights || []).map((f) => ({ ...f, date: rebaseTime(f.date), dep: rebaseTime(f.dep), arr: rebaseTime(f.arr) })),
    })),
    coverage,
  };
};

mkdirSync('.dry', { recursive: true });
const write = (name, obj) => {
  writeFileSync(`.dry/${name}.json`, `${JSON.stringify(obj)}\n`);
  const rows = (obj.sweeps || []).reduce((n, s) => n + (s.flights || []).length, 0);
  console.log(`.dry/${name}.json  sweeps=${(obj.sweeps || []).length} flights=${rows}`);
};

write('state-fresh', rebuild(src));
write('state-thin', rebuild(src, { updatedAgoMin: 20, oldestRouteMin: 95 }));
write('state-empty', rebuild(src, { noFlights: true }));
write('state-blocked', rebuild(src, { noFlights: true, blockedDate: addDays(today, 0) }));

writeFileSync('.dry/fixture-now.txt', String(at));
console.log(`fixture now: ${at} (${new Date(at).toISOString()}, 06:00 ET ${today})`);
