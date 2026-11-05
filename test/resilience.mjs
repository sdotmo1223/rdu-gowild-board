// Two behaviours that cost real data before they were fixed.
//
// 1. A single refusing route ended a whole profile's sweep. Measured 2026-11-05:
//    PHL answered `no-journeys-key` at MYR every tick, stopped there, and served
//    two-day-old fares while the page said "updated 47 min ago".
// 2. The page reported the snapshot's age, not the fare's. A row carried for a day
//    still rendered as a bookable price.
import assert from 'node:assert/strict';
import { shouldAbortSweep, refusalEndsSweep, routeRetired } from '../collector/parse.mjs';
import { buildBoard, MAX_ROW_AGE_MIN } from '../src/board.js';
import { renderPage } from '../src/render.js';
import { easternDate } from '../src/routes.js';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};

const HOUR = 3600000;
const now = Date.now();
const DATE = easternDate(0, now);
const DEP = `${DATE} 23:59:00`;
const flight = (dest) => ({
  date: DATE,
  dest,
  city: dest,
  dep: DEP,
  arr: DEP,
  stops: 'Nonstop',
  nonstop: true,
  dur: '1 hrs 30 min',
  seats: null,
  allin: 25.21,
  std: 59,
  flt: 'F9 1',
  goWild: true,
});
const sweep = (dest, at, extra = {}) => ({
  date: DATE,
  dest,
  ok: true,
  blocked: false,
  flights: [flight(dest)],
  reason: 'ok',
  at,
  ...extra,
});

// --- refusal streak -------------------------------------------------------
ok(refusalEndsSweep(1) === false, 'one refusal must not end a sweep');
ok(refusalEndsSweep(2) === true, 'two refusals in a row end a sweep');
ok(refusalEndsSweep(3) === true, 'a longer streak still ends it');
ok(shouldAbortSweep({ ok: false, reason: 'no-journeys-key' }) === true, 'a refusal is still recognised');
ok(shouldAbortSweep({ ok: false, reason: 'x', notServed: true }) === false, 'an unserved pair is not a refusal');
ok(shouldAbortSweep({ ok: true, reason: 'no-flights', flights: [] }) === false, 'an empty day is not a refusal');

// --- retirement ----------------------------------------------------------
ok(routeRetired({ refused: 2 }, now) === false, 'two refusals do not retire a route');
ok(routeRetired({ refused: 3 }, now) === true, 'three refusals retire it');
ok(routeRetired({ notServed: 3 }, now) === true, 'three "not sold" answers retire it');
ok(routeRetired({ refused: 2, notServed: 1 }, now) === true, 'strikes add up across both kinds');
ok(routeRetired({ refused: 3, lastAt: now - 8 * 24 * HOUR }, now) === false, 'a retired route returns after a week');
ok(routeRetired({}, now) === false, 'an unknown route is not retired');

// --- row age ceiling -----------------------------------------------------
let state = { sweeps: [sweep('ATL', now - 5 * 60000)], updatedAt: now, routeCount: 14 };
let view = buildBoard(state, now);
let d = view.dates[0];
ok(d.status === 'ok', `fresh rows should render, got ${d.status}`);
ok(d.rows.length === 1, `expected 1 bookable row, got ${d.rows.length}`);
ok(d.withheld === 0, 'nothing withheld when the row is fresh');
ok(d.oldestAgeMin !== null && d.oldestAgeMin < 10, `oldest age should be minutes, got ${d.oldestAgeMin}`);
let html = renderPage(view, state, [], now);
ok(!/more than 3 hours/.test(html), 'a fresh board must not claim old data');

// Four hours old: the price is real but it is not evidence of a seat now.
const staleAt = now - (MAX_ROW_AGE_MIN + 60) * 60000;
state = { sweeps: [sweep('ATL', staleAt, { carried: true, carriedAt: staleAt, carriedReason: 'dead' })], updatedAt: now, routeCount: 14 };
view = buildBoard(state, now);
d = view.dates[0];
ok(d.status === 'stale', `a 4-hour-old row should report stale, got ${d.status}`);
ok(d.rows.length === 0, 'an old fare must not be offered as bookable');
ok(d.withheld === 1, `expected 1 withheld row, got ${d.withheld}`);
ok(d.oldestAgeMin >= MAX_ROW_AGE_MIN, `oldest age ${d.oldestAgeMin} should exceed the ceiling`);
ok(view.oldestAgeMin >= MAX_ROW_AGE_MIN, 'the header must inherit the worst row age');
html = renderPage(view, state, [], now);
ok(/more than 3 hours/.test(html), 'the page must say why nothing is offered');
ok(/oldest data/.test(html), 'with nothing offered the header states the data age');

// Mixed: one fresh route and one stale route. The fresh one is shown, the stale one
// is named rather than silently dropped or silently priced.
state = {
  sweeps: [
    sweep('ATL', now - 5 * 60000),
    sweep('MCO', staleAt, { carried: true, carriedAt: staleAt, carriedReason: 'rotated' }),
  ],
  updatedAt: now,
  routeCount: 14,
};
view = buildBoard(state, now);
d = view.dates[0];
ok(d.status === 'ok', `a mixed date is still a usable date, got ${d.status}`);
ok(d.rows.length === 1 && d.rows[0].dest === 'ATL', 'only the fresh row is offered');
ok(d.withheld === 1, 'the stale row is counted');
html = renderPage(view, state, [], now);
ok(/1 older option withheld/.test(html), 'the withheld row is stated, not hidden');
ok(/oldest fare/.test(html), 'an offered row makes the age a fare age');

// A stampless snapshot (older collector) must not be treated as infinitely old:
// unknown age is not the same as bad age, and hiding everything on upgrade would
// be a worse failure than showing it.
state = { sweeps: [sweep('ATL', null)], updatedAt: now, routeCount: 14 };
view = buildBoard(state, now);
ok(view.dates[0].rows.length === 1, 'a row with no stamp is shown, not withheld');

// A date with no fares on offer has no "oldest fare". Quoting one would be an age
// for something that does not exist, and the header must downgrade to data age.
state = {
  sweeps: [{ date: DATE, dest: 'ATL', ok: true, blocked: false, reason: 'no-flights', flights: [], at: staleAt }],
  updatedAt: now,
  routeCount: 14,
};
view = buildBoard(state, now);
ok(view.dates[0].status === 'noflights', `an empty date should read noflights, got ${view.dates[0].status}`);
ok(view.oldestOffered === false, 'nothing offered means the header reports data age');
html = renderPage(view, state, [], now);
ok(!/oldest fare/.test(html), 'an empty date must not claim an oldest fare');
ok(view.oldestAgeMin === null, 'a date with no rows has no provenance to age');

console.log(`resilience: ${checks} checks passed`);
