// Offline acceptance checks. No network, no Frontier contact.
import assert from 'node:assert/strict';
import { parseRoute, extractJourneys, normalizeSeats } from '../collector/parse.mjs';
import { buildBoard } from '../src/board.js';
import { appendTransitions } from '../src/history.js';
import { renderPage } from '../src/render.js';
import { frequencyTable, headlineFrequency } from '../src/frequency.js';
import { ROUTES, MAX_ALL_IN, PEAK_LABEL } from '../src/routes.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// A payload shaped exactly like the live one, including its traps:
// -1 sentinel when GoWild is off, string seats, a >$50 fare, a next-day arrival.
function payload(flights) {
  return `<html><script>var flight_data = {"journeys":[{"flights":${JSON.stringify(flights)}}]};</script></html>`;
}
const rawFlight = (over = {}) => ({
  isGoWildFareEnabled: true,
  goWildFare: 15.41,
  goWildFareSeatsRemaining: '3 Seats Left!',
  standardFare: 83.98,
  stopsText: 'Nonstop',
  stopCount: 0,
  duration: '1 hrs 57 min',
  legs: [{ departureDate: '2026-11-03 10:12:00' }, { arrivalDate: '2026-11-03 12:09:00' }],
  ...over,
});

check('extractJourneys finds the balanced array', () => {
  const j = extractJourneys(payload([rawFlight()]));
  assert.equal(j.length, 1);
  assert.equal(j[0].flights.length, 1);
});

check('sentinels and string seats normalize correctly', () => {
  assert.equal(normalizeSeats('3 Seats Left!'), 3);
  assert.equal(normalizeSeats(null), null);
  const html = payload([
    rawFlight(),
    rawFlight({ isGoWildFareEnabled: false, goWildFare: -1, goWildFareSeatsRemaining: null }),
    rawFlight({ goWildFare: 317.96, stopsText: '1 Stop DTW', stopCount: 1 }),
  ]);
  const res = parseRoute({ status: 200, url: 'https://booking.flyfrontier.com/Flight/Select', text: html }, '2026-11-03', 'MCO', 'Orlando');
  assert.equal(res.ok, true);
  assert.equal(res.flights.length, 3);
  assert.equal(res.flights[0].allin, 15.41);
  assert.equal(res.flights[0].seats, 3);
  assert.equal(res.flights[1].goWild, false);
  assert.equal(res.flights[1].allin, null, 'disabled GoWild must not become a price');
  assert.equal(res.flights[2].nonstop, false);
});

check('blocked redirect is not silently read as no-flights', () => {
  const res = parseRoute({ status: 200, url: 'https://booking.flyfrontier.com/Flight/Redirect', text: '<html></html>' }, '2026-11-03', 'MCO', 'Orlando');
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
});

check('journeys=1 with flights=0 is a genuine no-flights day', () => {
  const res = parseRoute({ status: 200, url: 'https://booking.flyfrontier.com/Flight/Select', text: payload([]) }, '2026-11-04', 'CUN', 'Cancun');
  assert.equal(res.ok, true);
  assert.equal(res.blocked, false);
  assert.equal(res.reason, 'no-flights');
});

check('filter drops >$50 and sorts nonstops first', () => {
  const state = {
    routeCount: 14,
    updatedAt: Date.now() - 60000,
    sweeps: [
      { date: '2026-11-03', dest: 'MCO', ok: true, blocked: false, flights: [
        { date: '2026-11-03', dest: 'MCO', city: 'Orlando', dep: '2026-11-03 17:26:00', arr: '2026-11-03 19:29:00', stops: 'Nonstop', nonstop: true, dur: '2 hrs 3 min', seats: null, allin: 15.41, goWild: true },
        { date: '2026-11-03', dest: 'ATL', city: 'Atlanta', dep: '2026-11-03 06:30:00', arr: '2026-11-03 11:49:00', stops: '1 Stop ATL', nonstop: false, dur: '5 hrs 19 min', seats: 3, allin: 25.21, goWild: true },
        { date: '2026-11-03', dest: 'DEN', city: 'Denver', dep: '2026-11-03 08:00:00', arr: '2026-11-03 12:00:00', stops: 'Nonstop', nonstop: true, dur: '4 hrs', seats: 1, allin: 74.0, goWild: true },
      ] },
    ],
  };
  const view = buildBoard(state);
  const rows = view.dates[0].rows;
  assert.equal(rows.length, 2, 'the $74 fare must be dropped');
  assert.ok(rows.every((r) => r.allin <= MAX_ALL_IN));
  assert.equal(rows[0].dest, 'MCO', 'nonstop first');
  assert.equal(rows[1].dest, 'ATL');
  assert.equal(view.dates[0].above, 1);
});

check('blackout date renders Peak Day Charge, never blank', () => {
  const state = {
    routeCount: 14,
    updatedAt: Date.now(),
    sweeps: [
      { date: '2026-11-24', dest: 'MCO', ok: true, blocked: false, flights: [
        { date: '2026-11-24', dest: 'MCO', city: 'Orlando', dep: '2026-11-24 13:28:00', arr: '2026-11-24 22:51:00', stops: '1 Stop DTW', nonstop: false, dur: '9 hrs 23 min', seats: 3, allin: 317.96, goWild: true },
      ] },
    ],
  };
  const view = buildBoard(state);
  assert.equal(view.dates[0].status, 'peak');
  const html = renderPage(view, state, [], Date.now());
  assert.ok(html.includes(PEAK_LABEL), 'peak label must be present');
});

check('blocked sweep raises the banner instead of an empty grid', () => {
  const state = {
    routeCount: 14,
    updatedAt: Date.now(),
    lastError: { kind: 'blocked', detail: '14/14 routes hit the DataDome redirect' },
    sweeps: [{ date: '2026-11-03', dest: 'MCO', ok: false, blocked: true, flights: [] }],
  };
  const view = buildBoard(state);
  const html = renderPage(view, state, [], Date.now());
  assert.equal(view.dates[0].status, 'blocked');
  assert.ok(/bot protection/i.test(html));
  assert.ok(!/<ul class="rows"><\/ul>/.test(html), 'must never emit an empty row list');
});

check('auth failure banner shows the exact command', () => {
  const state = { routeCount: 14, updatedAt: Date.now(), lastError: { kind: 'auth', detail: 'expired' }, sweeps: [] };
  const html = renderPage(buildBoard(state), state, [], Date.now());
  assert.ok(html.includes('Session expired — cookie needs replacing'));
  assert.ok(html.includes('wrangler secret put FRONTIER_COOKIE'));
});

check('no snapshot at all is an explicit state', () => {
  const state = { routeCount: 14, updatedAt: null, sweeps: [] };
  const html = renderPage(buildBoard(state), state, [], Date.now());
  assert.ok(/No data yet/.test(html));
  assert.ok(/not "no flights"/.test(html));
});

check('staleness turns amber past 45 minutes', () => {
  const fresh = buildBoard({ routeCount: 14, updatedAt: Date.now() - 10 * 60000, sweeps: [] });
  const old = buildBoard({ routeCount: 14, updatedAt: Date.now() - 90 * 60000, sweeps: [] });
  assert.equal(fresh.stale, false);
  assert.equal(old.stale, true);
  assert.ok(renderPage(old, {}, [], Date.now()).includes('class="stamp stale"'));
});

check('frequency uses honest denominators', () => {
  const state = {
    observed: { '2026-11-02': 1, '2026-11-09': 1, '2026-11-16': 1 },
    days: { 'CUN|2026-11-02': 1, 'CUN|2026-11-09': 0, 'CUN|2026-11-16': 1 },
  };
  const head = headlineFrequency(state, 'CUN');
  assert.equal(head.name, 'Monday');
  assert.equal(head.of, 3);
  assert.equal(head.opened, 2);
  const table = frequencyTable(state, ROUTES);
  assert.ok(table.some((t) => t.dest === 'CUN' && t.opened === 2 && t.of === 3));
});

check('route list is the verified 14', () => {
  assert.equal(ROUTES.length, 14);
  assert.ok(ROUTES.some((r) => r.code === 'CUN' && r.intl));
  assert.ok(!ROUTES.some((r) => r.code === 'BUF'), 'BUF is announced, not operating');
});

check('peak state quotes the real lowest fare, never a sentinel', () => {
  const state = {
    routeCount: 14,
    updatedAt: Date.now(),
    sweeps: [{ date: '2026-11-24', dest: 'MCO', ok: true, blocked: false, flights: [
      { date: '2026-11-24', dest: 'MCO', city: 'Orlando', dep: '2026-11-24 13:28:00', arr: '2026-11-24 22:51:00', stops: '1 Stop DTW', nonstop: false, dur: '9 hrs 23 min', seats: 3, allin: 317.96, goWild: true },
    ] }],
  };
  const view = buildBoard(state);
  assert.equal(view.dates[0].lowest, 317.96);
  const html = renderPage(view, state, [], Date.now());
  assert.ok(html.includes('$317.96'), 'the real peak fare must be quoted');
  assert.ok(!html.includes('9999'), 'never leak the min() fallback sentinel');
});

check('multi-date history does not duplicate on an unchanged sweep', () => {
  const state = { history: [] };
  const rows = [
    { date: '2026-11-03', dest: 'MCO', dep: '2026-11-03 10:12:00', stops: 'Nonstop', dur: '1h 57m', seats: 3, allin: 15.41 },
    { date: '2026-11-04', dest: 'TPA', dep: '2026-11-04 08:00:00', stops: 'Nonstop', dur: '1h 30m', seats: 1, allin: 15.41 },
  ];
  const first = appendTransitions(state, rows, 1000);
  assert.equal(first.added, 2);
  const second = appendTransitions(state, rows, 2000);
  assert.equal(second.changed, false, 'identical board must not change the digest');
  assert.equal(second.added, 0);
  assert.equal(state.history.length, 2, 'no duplicate transitions across two dates');
});

check('long connections are folded, not dropped and not hidden', () => {
  const mk = (over) => ({
    date: '2026-11-03', dest: 'ATL', city: 'Atlanta', dep: '2026-11-03 10:12:00', arr: '2026-11-03 12:00:00',
    stops: 'Nonstop', nonstop: true, dur: '1 hrs 57 min', seats: null, allin: 15.41, goWild: true, ...over,
  });
  const state = {
    routeCount: 14,
    updatedAt: Date.now(),
    sweeps: [{ date: '2026-11-03', dest: 'ATL', ok: true, blocked: false, flights: [
      mk({}),
      mk({ dest: 'MCO', city: 'Orlando', stops: '1 Stop MCO', nonstop: false, dur: '22 hrs 50 min' }),
      mk({ dest: 'PHL', city: 'Philadelphia', stops: '2 Stops MCO, ATL', nonstop: false, dur: '6 hrs' }),
    ] }],
  };
  const view = buildBoard(state);
  const d = view.dates[0];
  assert.equal(d.rows.length, 1, 'only the short nonstop qualifies');
  assert.equal(d.folded.length, 2, 'the 22h and 2-stop options are folded, not dropped');
  assert.equal(d.above, 0, 'folded fares are not counted as above $50');
  const html = renderPage(view, state, [], Date.now());
  assert.ok(html.includes('22h 50m'), 'a folded itinerary is still reachable (duration is humanized)');
  assert.ok(/beyond 1 stop \/ 8h/.test(html), 'the limit is stated in the UI');
});

check('a two-stop or day-long-only date still shows something', () => {
  const state = {
    routeCount: 14,
    updatedAt: Date.now(),
    sweeps: [{ date: '2026-11-03', dest: 'MCO', ok: true, blocked: false, flights: [
      { date: '2026-11-03', dest: 'MCO', city: 'Orlando', dep: '2026-11-03 06:30:00', arr: '2026-11-04 05:20:00', stops: '1 Stop MCO', nonstop: false, dur: '22 hrs 50 min', seats: null, allin: 25.21, goWild: true },
    ] }],
  };
  const view = buildBoard(state);
  assert.equal(view.dates[0].status, 'folded', 'an all-folded date must state that, not render empty');
  const html = renderPage(view, state, [], Date.now());
  assert.ok(!/<ul class="rows"><\/ul>/.test(html), 'never an empty row list');
  assert.ok(/Show them anyway/.test(html));
});

check('zero seats renders as sold out, not unknown', () => {
  // 0 is preserved (not nulled) so the renderer can say "sold out" rather than
  // "seats unknown" — those are different facts.
  assert.equal(normalizeSeats('0 Seats Left!'), 0);
  const view = { dates: [{ date: '2026-11-03', blackout: false, peak: false, peakLabel: '', status: 'ok', total: 1, goWild: 1, above: 0, folded: [], blockedRoutes: 0, failedRoutes: 0, routesScanned: 14, rows: [{ city: 'Orlando', dest: 'MCO', dep: '2026-11-03 10:12:00', arr: '2026-11-03 12:09:00', stops: 'Nonstop', nonstop: true, dur: '1 hrs 57 min', seats: 0, allin: 15.41 }] }], rows: [], ageMin: 1, stale: false, error: null, routeCount: 14 };
  assert.ok(renderPage(view, {}, [], Date.now()).includes('sold out'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
