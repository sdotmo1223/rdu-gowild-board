// TASK 3a: the route-day schedule ledger.
//
// Why this exists: "the next ATL->RDU is Wednesday 15:30" is a projection the
// system can already afford, because every sweep has been recording departure
// times since 2026-11-03. It costs zero Frontier requests -- it is post-processing
// of state.history and state.firstSeen -- and it gets sharper every day it exists.
//
// The contract the UI depends on:
//   - a window (default 14 days, the same freshness horizon the board reasons in);
//   - per route, per weekday, the departure times actually observed, each with the
//     number of distinct dates it appeared on and those dates;
//   - confidence stated as a count plus a word, never a bare guess. One sighting is
//     "single", two is "repeated", and the projection says so out loud.
import assert from 'node:assert/strict';
import { buildLedger, projectLeg, nextDateForDow, confidenceFor } from '../src/ledger.mjs';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const NOW = Date.UTC(2026, 10, 13, 15, 0, 0); // Friday 2026-11-13 10:00 ET

// A seeded observation record: [date, dest, dep]. Dates are chosen so the window
// contains exactly two Wednesdays, which is the floor for "repeated".
function row(date, dest, dep) {
  return { ts: Date.parse(`${date}T12:00:00Z`), date, dest, dep: `${date} ${dep}:00`, stops: 'Nonstop', dur: '1 hr 0 min', seats: null, allin: 15.41 };
}

const history = [
  // ATL: a real pattern -- Wednesday 15:30, twice. Plus one stray Wednesday 06:30.
  row('2026-11-04', 'ATL', '15:30'),
  row('2026-11-11', 'ATL', '15:30'),
  row('2026-11-04', 'ATL', '06:30'),
  // DTW: one lone sighting, which must not be dressed up as a pattern.
  row('2026-11-05', 'DTW', '10:12'),
  // MCO: appears only on a Tuesday, so Wednesday's projection for it is null.
  row('2026-11-03', 'MCO', '09:40'),
  // Outside the window: this must not leak into a 14-day projection.
  row('2026-10-21', 'ATL', '15:30'),
];

const state = {
  updatedAt: NOW,
  history,
  // firstSeen carries rows the digest gate may never have promoted into history.
  firstSeen: {
    '2026-11-12|PHL|2026-11-12 21:53:00': Date.parse('2026-11-12T18:00:00Z'),
  },
};

// --- 1. shape and window ------------------------------------------------------
{
  const led = buildLedger(state, NOW);
  eq(led.windowDays, 14, 'the default window is 14 days');
  eq(led.since, '2026-10-31', 'the window is stated as an inclusive start date');
  ok(led.routes && typeof led.routes === 'object', 'routes are keyed by destination');
  ok(led.routes.ATL, 'ATL has observations');
  eq(led.routes.ATL.observations, 3, 'only in-window observations are counted');
  ok(!led.routes.ATL.byDow['3'].some((t) => t.dep === '06:30' && t.n > 1), 'a one-off time is kept, but with n=1');
}

// --- 2. the projection --------------------------------------------------------
{
  const led = buildLedger(state, NOW);
  const wed = projectLeg(led, 'ATL', 3);
  ok(wed, 'ATL has a Wednesday projection');
  eq(wed.dep, '15:30', 'the modal Wednesday time wins over the stray 06:30');
  eq(wed.n, 2, 'confidence is the number of distinct dates behind it');
  eq(wed.dates.length, 2, 'and the dates themselves are available to the UI');
  eq(wed.confidence, 'repeated', 'two sightings is stated as repeated, not as a pattern');
  eq(projectLeg(led, 'DTW', 4).confidence, 'single', 'one sighting is stated as single');
  eq(projectLeg(led, 'MCO', 3), null, 'no Wednesday observations means no claim at all');
  eq(projectLeg(led, 'NOPE', 3), null, 'an unknown route is null, never a throw');
}

// --- 3. weekdays and the next occurrence --------------------------------------
{
  const led = buildLedger(state, NOW);
  eq(led.routes.ATL.byDow['3'][0].weekday, 'Wednesday', 'the day is named for the reader');
  // 2026-11-13 is a Friday; the next Wednesday is 2026-11-18.
  eq(nextDateForDow(3, '2026-11-13'), '2026-11-18', 'next Wednesday from Friday');
  eq(nextDateForDow(3, '2026-11-18'), '2026-11-25', 'a weekday counts as next week, not today');
  eq(nextDateForDow(5, '2026-11-13'), '2026-11-20', 'next Friday skips today');
}

// --- 4. confidence wording ----------------------------------------------------
{
  eq(confidenceFor(0), null, 'zero sightings is not a confidence level');
  eq(confidenceFor(1), 'single', 'one is single');
  eq(confidenceFor(2), 'repeated', 'two is repeated');
  eq(confidenceFor(3), 'repeated', 'three is still repeated, not a strong pattern');
  eq(confidenceFor(6), 'established', 'six or more earns established');
}

// --- 5. hostile input degrades, never throws ----------------------------------
{
  for (const bad of [null, undefined, {}, { history: 'nope' }, { history: [null, 1, {}, { date: 'x' }] }]) {
    const led = buildLedger(bad, NOW);
    ok(led && led.routes && Object.keys(led.routes).length === 0, 'malformed state yields an empty ledger');
  }
  // A dep string with no clock is skipped, not counted as midnight.
  const led = buildLedger({ history: [row('2026-11-04', 'ATL', '15:30'), { date: '2026-11-04', dest: 'ATL', dep: 'garbage' }] }, NOW);
  eq(led.routes.ATL.observations, 1, 'a row with no parseable clock is skipped');
}

// --- 6. firstSeen fills gaps history cannot ----------------------------------
{
  const led = buildLedger(state, NOW);
  ok(led.routes.PHL, 'a destination known only from firstSeen is present');
  eq(projectLeg(led, 'PHL', 4).dep, '21:53', 'and its time projects');
}

// --- 7. the window moves with time -------------------------------------------
{
  const later = NOW + 30 * 24 * 3600 * 1000;
  const led = buildLedger(state, later);
  ok(!led.routes.ATL, 'thirty days on, the November observations have aged out');
}

console.log(`ledger: ${checks} checks passed`);
