// Stress and adversarial checks. Not a happy-path test: this hammers the render
// path with malformed state, hostile strings, and volume, and asserts that the
// page never throws and never goes blank.
import assert from 'node:assert';
import { buildBoard } from '../src/board.js';
import { renderPage } from '../src/render.js';
import { appendTransitions, recordObservation, recordFirstSeen, digestRows } from '../src/history.js';
import { frequencyTable } from '../src/frequency.js';
import { bookabilityHeatmap } from '../src/heatmap.mjs';
import { releaseTiming, departureUtcMs, etOffsetHours } from '../src/timing.mjs';
import { recordSchedule, weeklyPattern, weekKey } from '../src/schedule.mjs';
import { mergeSweeps, shouldAbortSweep } from '../collector/parse.mjs';
import { buildAlert, buildWatchAlert, parseWatch } from '../src/alerts.mjs';
import { normalizeSeats, parseRoute, extractJourneys, classifyFailure } from '../collector/parse.mjs';
import worker, { boardAuthorized } from '../src/index.js';
import {
  ROUTES,
  BLACKOUT_DATES,
  MAX_ALL_IN,
  easternDate,
  frontierDateParam,
  isBlackout,
  shardRoutes,
} from '../src/routes.js';
import { recordFares, fareMechanics } from '../src/pricing.mjs';

let passed = 0;
let failed = 0;

// The fixtures sit on 2026-11-03. Judged against the real clock those departures are
// nearly always in the past by now, and the board lists only what can still be
// booked, so every check that counts rows pins a clock before them.
const FIXTURE_NOW = Date.UTC(2026, 10, 2, 12, 0);

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    process.exitCode = 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

// The fare map is updated in the collector's hot path, from whatever the payload
// happened to contain. Half-written or hostile state must degrade, not throw.
check('fare mechanics survives hostile state', () => {
  for (const bad of [null, {}, { fares: null }, { fares: [] }, { fares: 'nope' }, { fares: { x: 'str', 'y|z': null } }]) {
    assert.doesNotThrow(() => fareMechanics(bad));
    assert.doesNotThrow(() => recordFares(bad, [null, {}, { date: 'not-a-date' }, { date: '2026-11-03', dest: 'ATL' }]));
  }
});

check('fare instances are capped so the KV value cannot grow without bound', () => {
  const state = { fares: {} };
  for (let i = 0; i < 8100; i++) {
    state.fares[`2026-11-03|ATL|2026-11-03 06:${String(i % 60).padStart(2, '0')}:00|F${i}`] = {
      n: 1,
      gw: 0,
      first: i,
      firstGw: 0,
      stdMin: 100,
      stdMax: 100,
      gwMin: null,
      gwMax: null,
      last: i,
      seats: null,
    };
  }
  const r = recordFares(state, []);
  assert.ok(r.tracked <= 8000, `tracked ${r.tracked}`);
});

check('instances outside the retention window are dropped by departure date', () => {
  const state = {
    fares: {
      '2026-01-01|ATL|2026-01-01 06:00:00|?': { n: 1, gw: 1, first: 1, firstGw: 1, last: 1 },
      '2026-11-03|MCO|2026-11-03 06:00:00|?': { n: 1, gw: 1, first: 2, firstGw: 2, last: 2 },
    },
  };
  recordFares(state, []);
  assert.ok(!state.fares['2026-01-01|ATL|2026-01-01 06:00:00|?'], 'old instance survived');
  assert.ok(state.fares['2026-11-03|MCO|2026-11-03 06:00:00|?'], 'recent instance was dropped');
});

check('a NaN or zero fare never poisons the medians', () => {
  const state = {};
  recordFares(
    state,
    [
      { date: '2026-11-03', dest: 'ATL', dep: '2026-11-03 06:30:00', goWild: true, allin: Number.NaN, std: Number.NaN },
      { date: '2026-11-03', dest: 'ATL', dep: '2026-11-03 07:30:00', goWild: true, allin: 0, std: 0 },
    ],
    Date.now(),
  );
  const m = fareMechanics(state);
  assert.equal(m.withGoWild, 0);
  assert.equal(m.std.gwMedian, null);
  assert.equal(m.std.fareRatioMedian, null);
});

const CITY = (code) => (ROUTES.find((r) => r.code === code) || {}).city || code;

// The live Worker serves /s/<token> straight out of KV, and a namespace that has
// never been written holds no state at all. That path threw a 500 in production
// on 2026-11-03 because frequencyTable() dereferenced a null state. A missing
// snapshot must render the explicit "no data yet" banner, never an error page.
check('renders a never-swept board instead of throwing', () => {
  const view = buildBoard(null, Date.now());
  const html = renderPage(view, null, frequencyTable(null, ROUTES), Date.now(), { basePath: '/s/testtoken' });
  assert.match(html, /No data yet/);
  assert.doesNotMatch(html, /\$NaN|\$undefined/);
});

let seq = 0;
function flight(over = {}) {
  seq++;
  const date = over.date || '2026-11-03';
  const dest = over.dest || 'MCO';
  const hh = String(6 + (seq % 15)).padStart(2, '0');
  return {
    date,
    dest,
    city: CITY(dest),
    dep: `${date} ${hh}:12:00`,
    arr: `${date} ${hh}:59:00`,
    stops: 'Nonstop',
    nonstop: true,
    dur: '1 hrs 47 min',
    seats: null,
    allin: 15.41,
    goWild: true,
    ...over,
  };
}

function sweep(over = {}) {
  return { date: '2026-11-03', dest: 'MCO', ok: true, blocked: false, flights: [], ...over };
}

check('a 30-date, 840-flight board renders without throwing', () => {
  const sweeps = [];
  for (let d = 0; d < 30; d++) {
    const date = new Date(Date.UTC(2026, 10, 3 + d)).toISOString().slice(0, 10);
    for (const r of ROUTES) {
      const flights = [];
      for (let i = 0; i < 2; i++) flights.push(flight({ date, dest: r.code }));
      sweeps.push(sweep({ date, dest: r.code, flights }));
    }
  }
  const state = { sweeps, updatedAt: Date.now(), routeCount: ROUTES.length };
  // Pinned before the fixture window: on the real clock the early dates are
  // correctly dropped as finished, and this check is about volume, not the clock.
  const view = buildBoard(state, FIXTURE_NOW);
  assert.equal(view.dates.length, 30);
  const t0 = Date.now();
  const html = renderPage(view, state, frequencyTable(state, ROUTES), Date.now());
  const ms = Date.now() - t0;
  assert.ok(html.length > 5000, 'page must not be tiny');
  assert.ok(ms < 800, `render took ${ms}ms`);
  console.log(`      (840 flights, 30 dates, ${html.length} bytes, ${ms}ms)`);
});

check('every date with rows emits real rows, never an empty list', () => {
  const sweeps = ['2026-11-03', '2026-11-04', '2026-11-05'].map((date) =>
    sweep({ date, flights: [flight({ date }), flight({ date, dest: 'ATL' })] }),
  );
  const state = { sweeps, updatedAt: Date.now(), routeCount: 14 };
  // A clock before every fixture departure: afterwards these rows are correctly
  // "departed", and this check is about never emitting an empty row list.
  const NOW = Date.UTC(2026, 10, 2, 12, 0);
  const view = buildBoard(state, NOW);
  const html = renderPage(view, state, [], NOW);
  assert.ok(!/<ul class="rows"><\/ul>/.test(html), 'no empty row list anywhere');
  assert.equal((html.match(/<li class="row"/g) || []).length, 6);
});

check('hostile city/stop strings are escaped, not executed', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const state = {
    sweeps: [sweep({ flights: [flight({ city: evil }), flight({ dest: 'ATL', stops: evil, nonstop: false })] })],
    updatedAt: Date.now(),
    routeCount: 14,
  };
  const NOW = Date.UTC(2026, 10, 2, 12, 0);
  const html = renderPage(buildBoard(state, NOW), state, [], NOW);
  assert.ok(!html.includes('<img'), 'raw tag must not survive');
  assert.ok(html.includes('&lt;img'), 'it must be escaped instead');
});

check('garbage state never throws and never blanks the page', () => {
  const cases = [
    null,
    {},
    { sweeps: null },
    { sweeps: 'not-an-array' },
    { sweeps: [null, {}, { flights: null }] },
    { sweeps: [{ date: '2026-11-03', flights: [{ dep: null, arr: null, dur: null, allin: NaN }] }] },
    { sweeps: [{ date: '2026-11-03', flights: [{ allin: -1, goWild: true }] }] },
    { sweeps: [sweep()], updatedAt: Date.now() + 86400000 },
  ];
  for (const bad of cases) {
    const view = buildBoard(bad || {});
    const html = renderPage(view, bad || {}, [], Date.now());
    assert.ok(typeof html === 'string' && html.includes('RDU'), 'always a page');
  }
});

check('a future updatedAt cannot produce a negative age', () => {
  const state = { sweeps: [sweep({ flights: [flight()] })], updatedAt: Date.now() + 3600000, routeCount: 14 };
  const view = buildBoard(state, Date.now());
  assert.equal(view.ageMin, 0);
});

check('fares above the ceiling are counted, never rendered as qualified', () => {
  const state = {
    sweeps: [sweep({ flights: [flight({ allin: 49.99 }), flight({ allin: 50.01, dest: 'ATL' }), flight({ allin: 317.96, dest: 'CUN' })] })],
    updatedAt: Date.now(),
    routeCount: 14,
  };
  const d = buildBoard(state, FIXTURE_NOW).dates[0];
  assert.equal(d.rows.length, 1);
  assert.equal(d.above, 2);
  assert.equal(d.lowest, 49.99);
  assert.ok(!renderPage(buildBoard(state), state, [], Date.now()).includes('$50.01'));
});

check('seat normalization: 0, strings, nulls and negatives', () => {
  assert.equal(normalizeSeats('3 Seats Left!'), 3);
  assert.equal(normalizeSeats('0 Seats Left!'), 0);
  assert.equal(normalizeSeats(0), 0, 'numeric zero is still a fact');
  assert.equal(normalizeSeats(-1), null);
  assert.equal(normalizeSeats(null), null);
  assert.equal(normalizeSeats('sold out'), null);
  assert.equal(normalizeSeats(12), 12);
});

check('digest is order-independent and price-sensitive', () => {
  const a = [flight({ allin: 15.41 }), flight({ allin: 25.21, dest: 'ATL' })];
  const b = a.slice().reverse();
  assert.equal(digestRows(a), digestRows(b));
  const c = [flight({ allin: 15.42 }), flight({ allin: 25.21, dest: 'ATL' })];
  assert.notEqual(digestRows(a), digestRows(c));
});

check('history stays capped and never duplicates an unchanged sweep', () => {
  const state = { history: [] };
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(flight({ dest: 'MCO', dep: `2026-11-03 06:${String(i % 60).padStart(2, '0')}:00` }));
  appendTransitions(state, rows, 1000);
  const after = state.history.length;
  appendTransitions(state, rows, 2000);
  assert.equal(state.history.length, after, 'unchanged sweep adds nothing');

  for (let i = 0; i < 60; i++) appendTransitions(state, [flight({ allin: 10 + i })], 3000 + i);
  assert.ok(state.history.length <= 4000, `capped, got ${state.history.length}`);
});

check('state payload stays far inside the KV value limit', () => {
  const state = { history: [], observed: {} };
  for (let i = 0; i < 4000; i++) {
    state.history.push({ ts: 1770000000000 + i, date: '2026-11-03', dest: 'MCO', dep: '2026-11-03 06:00:00', stops: 'Nonstop', dur: '1 hrs 47 min', seats: 3, allin: 15.41 });
  }
  for (let d = 0; d < 400; d++) state.observed[`2026-11-${String((d % 28) + 1).padStart(2, '0')}`] = 1;
  const bytes = JSON.stringify(state).length;
  assert.ok(bytes < 2_000_000, `${bytes} bytes`);
  console.log(`      (4000-row state = ${(bytes / 1024).toFixed(0)} KB; KV limit is 25 MB)`);
});

check('easternDate pins the zone instead of drifting with UTC', () => {
  // 04:00 UTC on Nov 3 is 23:00 on Nov 2 in New York.
  assert.equal(easternDate(0, Date.UTC(2026, 10, 3, 4, 0, 0)), '2026-11-02');
  assert.equal(easternDate(1, Date.UTC(2026, 10, 3, 4, 0, 0)), '2026-11-03');
  assert.equal(frontierDateParam('2026-11-03'), 'Nov%2003,%202026');
  assert.equal(frontierDateParam('2027-01-01'), 'Jan%2001,%202027');
});

check('all 26 blackout dates are covered and normal days are not', () => {
  assert.equal(BLACKOUT_DATES.size, 26);
  for (const d of BLACKOUT_DATES) assert.ok(isBlackout(d), d);
  assert.ok(!isBlackout('2026-11-03'));
  assert.ok(!isBlackout('2026-12-25'), 'Christmas Day is not on the list');
});

check('blackout date outranks a normal-looking fare', () => {
  const state = {
    sweeps: [sweep({ date: '2026-11-24', flights: [flight({ date: '2026-11-24', allin: 15.41 })] })],
    updatedAt: Date.now(),
    routeCount: 14,
  };
  const d = buildBoard(state, FIXTURE_NOW).dates[0];
  assert.equal(d.peak, true, 'the calendar flags the date');
  assert.equal(d.rows.length, 1, 'a genuine sub-$50 fare is shown, not hidden');
  const html = renderPage(buildBoard(state, FIXTURE_NOW), state, [], FIXTURE_NOW);
  assert.ok(html.includes('Peak Day Charge'));
  assert.ok(/Verify the fare at checkout/.test(html), 'the contradiction is stated, not smoothed over');
});

check('frequency denominators are honest', () => {
  const state = { observed: {}, days: {} };
  const mondays = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'];
  mondays.forEach((d, i) => {
    state.observed[d] = 1;
    if (i < 6) state.days[`CUN|${d}`] = 1;
  });
  const row = frequencyTable(state, ROUTES).find((r) => r.dest === 'CUN');
  assert.equal(row.weekday, 'Monday');
  assert.equal(row.opened, 6);
  assert.equal(row.of, 8);
  assert.ok(renderPage(buildBoard({ sweeps: [] }), state, [row], Date.now()).includes('opened on 6 of 8 Monday'));
});

check('heatmap reflects recorded days and never invents cells', () => {
  const state = { observed: { '2026-11-02': 1, '2026-11-03': 1, '2026-11-04': 1 }, days: { 'MCO|2026-11-02': 1, 'MCO|2026-11-04': 1 } };
  const heat = bookabilityHeatmap(state);
  assert.equal(heat.dates.length, 3);
  const mco = heat.routes.find((r) => r.dest === 'MCO');
  assert.deepEqual(mco.cells, [1, 0, 1]);
  assert.equal(mco.hits, 2);
  assert.equal(bookabilityHeatmap({}).dates.length, 0);
});

check('weekday grid credits only days that were actually observed', () => {
  const state = {
    observed: { '2026-11-02': 1, '2026-11-09': 1, '2026-11-03': 1 },
    days: { 'CUN|2026-11-02': 1, 'CUN|2026-11-09': 1 },
  };
  const heat = bookabilityHeatmap(state);
  const cun = heat.weekday.find((r) => r.dest === 'CUN');
  const monday = cun.days[1];
  const tuesday = cun.days[2];
  assert.equal(heat.observedCount, 3);
  assert.equal(monday.of, 2, 'two Mondays were swept');
  assert.equal(monday.opened, 2, 'both were bookable');
  assert.equal(tuesday.of, 1);
  assert.equal(tuesday.opened, 0, 'a closed Tuesday is recorded as 0 of 1');
  const sunday = cun.days[0];
  assert.equal(sunday.of, 0, 'a weekday never swept has no denominator');
});

check('release timing derives lead hours across the DST boundary', () => {
  // Nov 3 2026 is EST (-5); Jul 1 2026 is EDT (-4).
  assert.equal(etOffsetHours('2026-11-03'), 5);
  assert.equal(etOffsetHours('2026-07-01'), 4);
  const depMs = departureUtcMs('2026-11-03 06:30:00');
  assert.equal(depMs, Date.UTC(2026, 10, 3, 11, 30), '06:30 EST is 11:30 UTC');

  const state = {
    firstSeen: {
      '2026-11-03|MCO|2026-11-03 06:30:00': Date.UTC(2026, 10, 2, 12, 0),
      '2026-11-04|MCO|2026-11-04 06:30:00': Date.UTC(2026, 10, 3, 12, 0),
      '2026-11-05|MCO|2026-11-05 06:30:00': Date.UTC(2026, 10, 4, 12, 0),
    },
  };
  const t = releaseTiming(state).find((r) => r.dest === 'MCO');
  assert.equal(t.samples, 3);
  assert.ok(t.medianLead >= 23 && t.medianLead <= 24, `lead was ${t.medianLead}h`);
});

check('firstSeen survives a history wipe and stays bounded', () => {
  const state = { history: [], firstSeen: {} };
  const rows = [{ date: '2026-11-03', dest: 'MCO', dep: '2026-11-03 06:30:00' }];
  recordFirstSeen(state, rows, 2000);
  recordFirstSeen(state, rows, 1000);
  assert.equal(Object.keys(state.firstSeen).length, 1);
  assert.equal(state.firstSeen['2026-11-03|MCO|2026-11-03 06:30:00'], 1000, 'earliest sighting wins');
  assert.equal(releaseTiming({ history: [], firstSeen: state.firstSeen })[0].samples, 1, 'usable with no history');
  for (let i = 0; i < 900; i++) {
    recordFirstSeen(state, [{ date: '2026-11-03', dest: 'MCO', dep: `2026-11-03 0${i % 10}:00:00` }], 3000 + i);
  }
  assert.ok(Object.keys(state.firstSeen).length <= 800, 'bounded');
});

check('release timing refuses to claim a pattern from one sample', () => {
  const one = { history: [{ ts: Date.UTC(2026, 10, 2, 5, 0, 0), date: '2026-11-03', dest: 'MCO' }] };
  const t1 = releaseTiming(one)[0];
  assert.equal(t1.samples, 1);
  assert.equal(t1.confident, false);

  const three = {
    history: [
      { ts: Date.UTC(2026, 10, 2, 5, 0, 0), date: '2026-11-03', dest: 'MCO' },
      { ts: Date.UTC(2026, 10, 3, 5, 10, 0), date: '2026-11-04', dest: 'MCO' },
      { ts: Date.UTC(2026, 10, 4, 5, 20, 0), date: '2026-11-05', dest: 'MCO' },
    ],
  };
  const t3 = releaseTiming(three)[0];
  assert.equal(t3.samples, 3);
  assert.equal(t3.confident, true);
  assert.equal(t3.medianHour, 0);
});

check('alerts fire on change, dedupe on repeat, and stay quiet when nothing moved', () => {
  const fresh = [{ date: '2026-11-03', dest: 'MCO', dep: '2026-11-03 10:12:00', allin: 15.41, stops: 'Nonstop' }];
  assert.equal(buildAlert({ lastError: null }, [], 1000), null, 'no rows, no alert');

  const first = buildAlert({ lastError: null, lastAlert: null }, fresh, 1000);
  assert.ok(first && first.kind === 'fares');
  assert.ok(/1 new under \$50/.test(first.title));

  const blocked = buildAlert({ lastError: { kind: 'blocked', detail: '14/14' }, lastAlert: null }, [], 1000);
  assert.ok(blocked && blocked.kind === 'blocked');

  const again = buildAlert({ lastError: { kind: 'blocked', detail: '14/14' }, lastAlert: { kind: 'blocked', at: 1000 } }, [], 1000 + 60000);
  assert.equal(again, null, 'must not buzz every sweep');

  const later = buildAlert({ lastError: { kind: 'blocked', detail: '14/14' }, lastAlert: { kind: 'blocked', at: 1000 } }, [], 1000 + 7 * 3600 * 1000);
  assert.ok(later, 'must resurface after six hours');

  const auth = buildAlert({ lastError: { kind: 'auth' }, lastAlert: null }, [], 1000);
  assert.ok(/session expired/i.test(auth.title));
  assert.ok(!/cookie/i.test(auth.message) || /FRONTIER_COOKIE/.test(auth.message));
});

check('a 1.5 MB page with no journeys key is not read as no-flights', () => {
  const filler = 'x'.repeat(1_500_000);
  const r = parseRoute({ status: 200, url: 'https://www.flyfrontier.com/Flight/Redirect', text: filler }, '2026-11-03', 'MCO', 'Orlando');
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'datadome-redirect');

  const missing = parseRoute({ status: 200, url: 'https://www.flyfrontier.com/Flight/Select', text: filler }, '2026-11-03', 'MCO', 'Orlando');
  assert.equal(missing.ok, false);
  assert.equal(missing.blocked, false);
  assert.equal(missing.reason, 'no-journeys-key');
});

check('disabled and null GoWild fares never become $0.01 or NaN', () => {
  const text = '"journeys":[{"flights":[{"legs":[{"departureDate":"2026-11-03 06:30:00","arrivalDate":"2026-11-03 08:39:00"}],"stopsText":"Nonstop","duration":"2 hrs 9 min","goWildFare":-1,"isGoWildFareEnabled":false,"goWildFareSeatsRemaining":null},{"legs":[{"departureDate":"2026-11-03 09:00:00","arrivalDate":"2026-11-03 11:00:00"}],"stopsText":"Nonstop","duration":"2 hrs 0 min","goWildFare":15.41,"isGoWildFareEnabled":true,"goWildFareSeatsRemaining":"3 Seats Left!"}]}]';
  const r = parseRoute({ status: 200, url: 'https://x/Flight/Select', text }, '2026-11-03', 'MCO', 'Orlando');
  assert.equal(r.flights.length, 2);
  assert.equal(r.flights[0].goWild, false);
  assert.equal(r.flights[0].allin, null, 'disabled fare is absent, not $0.01');
  assert.equal(r.flights[1].allin, 15.41);
  assert.equal(r.flights[1].seats, 3);

  const state = { sweeps: [{ date: '2026-11-03', dest: 'MCO', ok: true, blocked: false, flights: r.flights }], updatedAt: Date.now(), routeCount: 14 };
  const html = renderPage(buildBoard(state), state, [], Date.now());
  assert.ok(!/\$0\.01|\$NaN|\$undefined/.test(html));
});

check('rows carry the data needed to export a calendar event', () => {
  const state = { sweeps: [sweep({ flights: [flight()] })], updatedAt: Date.now(), routeCount: 14 };
  const NOW = Date.UTC(2026, 10, 2, 12, 0);
  const html = renderPage(buildBoard(state, NOW), state, [], NOW);
  for (const attr of ['data-dep=', 'data-arr=', 'data-dest=', 'data-date=', 'data-allin=']) assert.ok(html.includes(attr), attr);
  assert.ok(html.includes('class="act ics"'));
});

// The board's promise is that everything shown can still be booked. A date whose
// options have all flown must say so, never render an empty list and never keep
// offering a departure that has left.
check('a date whose departures all left states it instead of listing them', () => {
  const date = '2026-11-03';
  const state = {
    sweeps: [sweep({ date, flights: [flight({ date }), flight({ date, dest: 'ATL' })] })],
    updatedAt: Date.now(),
    routeCount: 14,
  };
  const LATER = Date.UTC(2026, 10, 3, 23, 0); // 18:00 ET, after the fixtures
  const view = buildBoard(state, LATER);
  assert.equal(view.dates.length, 0, 'a finished day is not a bookable date');
  assert.equal(view.departed.length, 1, 'it is reported, not silently dropped');
  assert.equal(view.departed[0].status, 'departed');
  assert.equal(view.departed[0].rows.length, 0, 'nothing bookable is listed');
  assert.equal(view.departed[0].past.length, 2, 'the departed ones are still counted');
  const html = renderPage(view, state, [], LATER);
  assert.ok(/already left/.test(html), 'the reason is stated, never a blank section');
  assert.ok(!/No data yet/.test(html), 'a finished day is not a missing collector');
});

check('a mixed date lists only what is still ahead and states the rest', () => {
  const date = '2026-11-03';
  const state = {
    sweeps: [
      sweep({
        date,
        flights: [
          flight({ date, dep: '2026-11-03 16:20:00' }),
          flight({ date, dest: 'ATL', dep: '2026-11-03 21:30:00' }),
        ],
      }),
    ],
    updatedAt: Date.now(),
    routeCount: 14,
  };
  const MID = Date.UTC(2026, 10, 3, 22, 0); // 17:00 ET
  const view = buildBoard(state, MID);
  assert.equal(view.dates[0].status, 'ok');
  assert.equal(view.dates[0].rows.length, 1, 'only the 21:30 departure is bookable');
  assert.equal(view.dates[0].pastCount, 1);
  const html = renderPage(view, state, [], MID);
  assert.ok(html.includes('2026-11-03 21:30'), 'the live row is rendered');
  assert.ok(!html.includes('2026-11-03 16:20'), 'the departed row is not offered');
});

check('service worker is only offered when the page knows its secret path', () => {
  const state = { sweeps: [sweep({ flights: [flight()] })], updatedAt: Date.now(), routeCount: 14 };
  const view = buildBoard(state);
  const bare = renderPage(view, state, [], Date.now());
  assert.ok(!bare.includes('rel="manifest"'), 'no manifest at an unknown base path');
  const scoped = renderPage(view, state, [], Date.now(), { basePath: '/s/abcdefgh1234' });
  assert.ok(scoped.includes('rel="manifest"'));
  assert.ok(scoped.includes('window.__basePath = "/s/abcdefgh1234"'), 'path is injected for the client');
  assert.ok(scoped.includes("'/sw.js'"), 'worker is registered relative to the secret base');
});

check('a single route blocked does not mark the whole date blocked', () => {
  const state = {
    sweeps: [
      sweep({ dest: 'ATL', blocked: true, ok: false }),
      sweep({ dest: 'MCO', flights: [] }),
      sweep({ dest: 'PHL', flights: [] }),
    ],
    updatedAt: Date.now(),
    routeCount: 14,
  };
  const d = buildBoard(state, FIXTURE_NOW).dates[0];
  assert.equal(d.blockedRoutes, 1);
  assert.notEqual(d.status, 'blocked', 'one blocked route is not an outage');
});

check('an all-blocked state keeps the board and raises the banner', () => {
  const state = {
    sweeps: ROUTES.map((r) => sweep({ dest: r.code, blocked: true, ok: false })),
    updatedAt: Date.now(),
    routeCount: 14,
  };
  const d = buildBoard(state, FIXTURE_NOW).dates[0];
  assert.equal(d.status, 'blocked');
  const html = renderPage(buildBoard(state), state, [], Date.now());
  assert.ok(/bot protection/i.test(html));
});

check('each bookable row says when to leave for the airport', () => {
  const state = {
    sweeps: [
      sweep({
        date: '2026-11-03',
        flights: [flight({ date: '2026-11-03', dep: '2026-11-03 21:30:00', arr: '2026-11-03 23:40:00' })],
      }),
    ],
    updatedAt: FIXTURE_NOW,
    routeCount: 14,
  };
  const d = buildBoard(state, FIXTURE_NOW).dates[0];
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].leaveBy, '2026-11-03 19:30', 'two hours of buffer before departure');
  assert.equal(d.rows[0].tight, false, 'plenty of time, so it is not flagged');
  const html = renderPage(buildBoard(state, FIXTURE_NOW), state, [], FIXTURE_NOW);
  assert.ok(/leave by 7:30 PM/.test(html), 'the row states the leave time, not just the departure');
});

check('a departure inside the check-in buffer is flagged, never dropped', () => {
  const state = {
    sweeps: [
      sweep({
        date: '2026-11-03',
        flights: [flight({ date: '2026-11-03', dep: '2026-11-03 21:30:00', arr: '2026-11-03 23:40:00' })],
      }),
    ],
    updatedAt: FIXTURE_NOW,
    routeCount: 14,
  };
  // 21:00 ET: the flight still has not left, but the two-hour buffer has.
  const d = buildBoard(state, Date.UTC(2026, 10, 4, 1, 0)).dates[0];
  assert.equal(d.rows.length, 1, 'it is still bookable, so it is still listed');
  assert.equal(d.rows[0].tight, true, 'and it says the buffer is gone');
});

check('a date with only above-ceiling fares names the cheapest and the gap', () => {
  const state = {
    sweeps: [sweep({ date: '2026-11-03', flights: [flight({ allin: 63.4 })] })],
    updatedAt: FIXTURE_NOW,
    routeCount: 14,
  };
  const view = buildBoard(state, FIXTURE_NOW);
  assert.equal(view.dates[0].status, 'above');
  const html = renderPage(view, state, [], FIXTURE_NOW);
  assert.ok(/\$63\.40/.test(html), 'the cheapest fare is stated');
  assert.ok(/over the ceiling/.test(html), 'and how far over it was');
});

check('"all above" counts only what is still ahead, never a departed cheap fare', () => {
  // Observed live on PHL 2026-11-05: "11 GoWild departures, all above $50.00. Cheapest
  // was $15.41, $-34.59 over the ceiling." The cheap fare had already flown.
  // 21:00 ET on the fixture date: 06:05 has gone, 21:30 has not.
  const NOW = Date.UTC(2026, 10, 4, 1, 0);
  const state = {
    sweeps: [
      sweep({
        date: '2026-11-03',
        flights: [
          flight({ date: '2026-11-03', dep: '2026-11-03 06:05:00', allin: 15.41 }),
          flight({ date: '2026-11-03', dep: '2026-11-03 21:30:00', allin: 114.39 }),
        ],
      }),
    ],
    updatedAt: NOW,
    routeCount: 14,
  };
  const view = buildBoard(state, NOW);
  const d = view.dates[0];
  assert.equal(d.status, 'above', 'only over-ceiling fares are still ahead');
  assert.equal(d.aboveAhead, 1, 'the departed cheap fare is not counted as ahead');
  assert.equal(d.lowestAbove, 114.39, 'nor does it set the ceiling gap');
  assert.equal(d.cheapDeparted, 1, 'it is counted as departed instead');
  const html = renderPage(view, state, [], NOW);
  assert.ok(!/\$-/.test(html), 'no negative money is ever printed');
  assert.ok(/still ahead, all above \$50\.00/.test(html), 'the claim is scoped to what is ahead');
  assert.ok(/\$64\.39 over the ceiling/.test(html), 'the gap uses the cheapest fare still ahead');
  assert.ok(/1 cheaper option on this date already departed/.test(html), 'and the departed one is said out loud');
});

check('a watchlist entry alerts once, and only under the watched price', () => {
  assert.equal(parseWatch('ATL<=25, mco<=30, junk').length, 2, 'malformed entries are dropped, not guessed');
  const fresh = [{ dest: 'ATL', date: '2026-11-03', dep: '2026-11-03 21:30:00', allin: 15.41 }];
  const a = buildWatchAlert({}, fresh, 'ATL<=25', 1);
  assert.ok(a && /ATL/.test(a.title), 'a hit under the watched price alerts');
  assert.equal(buildWatchAlert({ watchFired: { [a.key]: 1000 } }, fresh, 'ATL<=25', 2000), null, 'deduped');
  assert.equal(
    buildWatchAlert({}, [{ ...fresh[0], allin: 40 }], 'ATL<=25', 1),
    null,
    'a fare above the watched price is not a hit',
  );
});

check('the board JSON is refused without a token and served with one', () => {
  const env = { BOARD_TOKEN: 'tok-12345678' };
  assert.equal(boardAuthorized(new Request('https://b.test/api/board'), env), false, 'no credential');
  assert.equal(boardAuthorized(new Request('https://b.test/api/board?token=nope'), env), false, 'wrong token');
  assert.equal(boardAuthorized(new Request('https://b.test/api/board?token=tok-12345678'), env), true, 'query token');
  assert.equal(
    boardAuthorized(new Request('https://b.test/api/board', { headers: { Authorization: 'Bearer tok-12345678' } }), env),
    true,
    'bearer header',
  );
  assert.equal(
    boardAuthorized(new Request('https://b.test/api/board?token=tok-12345678'), {}),
    false,
    'an unset server token refuses rather than opening up',
  );
});

check('folded options carry the same leave-by advice as listed ones', () => {
  const state = {
    sweeps: [
      sweep({
        date: '2026-11-03',
        flights: [
          flight({ date: '2026-11-03', dep: '2026-11-03 10:12:00', arr: '2026-11-03 12:09:00' }),
          flight({
            date: '2026-11-03',
            dest: 'MCO',
            dep: '2026-11-03 06:30:00',
            arr: '2026-11-04 05:20:00',
            stops: '1 Stop MCO',
            nonstop: false,
            dur: '22 hrs 50 min',
            allin: 25.21,
          }),
        ],
      }),
    ],
    updatedAt: FIXTURE_NOW,
    routeCount: 14,
  };
  const view = buildBoard(state, FIXTURE_NOW);
  assert.equal(view.dates[0].folded.length, 1, 'the 22h option is folded, not dropped');
  assert.ok(view.dates[0].folded[0].leaveBy, 'an over-limit row still gets a leave time');
  const html = renderPage(view, state, [], FIXTURE_NOW);
  const rows = (html.match(/<li class="row"/g) || []).length;
  const leaves = (html.match(/leave by /g) || []).length;
  assert.equal(leaves, rows, 'every rendered row says when to leave for the airport');
});

check('a date is not called finished while a folded option is still ahead', () => {
  const state = {
    sweeps: [
      sweep({
        date: '2026-11-03',
        flights: [
          flight({ date: '2026-11-03', dep: '2026-11-03 06:30:00', arr: '2026-11-03 08:30:00' }),
          flight({
            date: '2026-11-03',
            dest: 'MCO',
            dep: '2026-11-03 20:00:00',
            arr: '2026-11-04 18:50:00',
            stops: '1 Stop MCO',
            nonstop: false,
            dur: '22 hrs 50 min',
            allin: 25.21,
          }),
        ],
      }),
    ],
    updatedAt: FIXTURE_NOW,
    routeCount: 14,
  };
  // 18:00 ET: the nonstop has gone, the folded night flight has not.
  const view = buildBoard(state, Date.UTC(2026, 10, 3, 23, 0));
  assert.equal(view.departed.length, 0, 'something on this date is still ahead');
  assert.equal(view.dates[0].status, 'folded');
  assert.equal(view.dates[0].folded.length, 1);
});

check('a fare that drops again after rising is a new watch answer', () => {
  const low = [{ dest: 'ATL', date: '2026-11-03', dep: '2026-11-03 21:30:00', allin: 20 }];
  const first = buildWatchAlert({}, low, 'ATL<=25', 1);
  assert.ok(first, 'a fare under the watch price alerts');
  const fired = { watchFired: { [first.key]: 1000 } };
  assert.equal(buildWatchAlert(fired, low, 'ATL<=25', 2000), null, 'the same fare is deduped');
  assert.equal(buildWatchAlert(fired, [{ ...low[0], allin: 30 }], 'ATL<=25', 2000), null, 'above the price is no hit');
  const cheaper = buildWatchAlert(fired, [{ ...low[0], allin: 18 }], 'ATL<=25', 2000);
  assert.ok(cheaper && cheaper.key !== first.key, 'a cheaper fare is a new answer, not a duplicate');
});

check('a folded-only finished date counts its departures instead of saying zero', () => {
  const state = {
    sweeps: [
      sweep({
        date: '2026-11-03',
        flights: [
          flight({
            date: '2026-11-03',
            dest: 'MCO',
            dep: '2026-11-03 06:30:00',
            arr: '2026-11-04 05:20:00',
            stops: '1 Stop MCO',
            nonstop: false,
            dur: '22 hrs 50 min',
            allin: 25.21,
          }),
        ],
      }),
    ],
    updatedAt: FIXTURE_NOW,
    routeCount: 14,
  };
  const LATE = Date.UTC(2026, 10, 3, 23, 0); // 18:00 ET, it has gone
  const view = buildBoard(state, LATE);
  assert.equal(view.dates.length, 0);
  assert.equal(view.departed.length, 1);
  assert.equal(view.departed[0].departedCount, 1, 'the folded row is still a departure that left');
  assert.equal(view.departed[0].pastCount, 0, 'but it was never bookable');
  const html = renderPage(view, state, [], LATE);
  assert.ok(/1 departure on 2026-11-03 already left/.test(html), 'the banner states the real count');
  assert.ok(!/0 departures on/.test(html), 'never "0 departures already left"');
});

check('a date whose only fares were above $50 and have flown is finished, not "above"', () => {
  const state = {
    sweeps: [
      sweep({
        date: '2026-11-03',
        flights: [flight({ date: '2026-11-03', dep: '2026-11-03 06:30:00', arr: '2026-11-03 08:00:00', allin: 63.4 })],
      }),
    ],
    updatedAt: FIXTURE_NOW,
    routeCount: 14,
  };
  const view = buildBoard(state, Date.UTC(2026, 10, 3, 23, 0));
  assert.equal(view.dates.length, 0, 'nothing is ahead, so nothing is offered');
  assert.equal(view.departed[0].status, 'departed');
  assert.equal(view.departed[0].departedCount, 1);
});

check('a dead collector still raises the stale banner when no dates are left', () => {
  const state = {
    sweeps: [
      sweep({
        date: '2026-11-03',
        flights: [flight({ date: '2026-11-03', dep: '2026-11-03 06:30:00', arr: '2026-11-03 08:00:00' })],
      }),
    ],
    updatedAt: FIXTURE_NOW,
    routeCount: 14,
  };
  const LATE = Date.UTC(2026, 10, 3, 20, 0);
  const view = buildBoard(state, LATE);
  assert.equal(view.dates.length, 0, 'nothing is ahead');
  const html = renderPage(view, state, [], LATE);
  assert.ok(/Data is stale/.test(html), 'an empty board plus a dead collector must say so');
});

check('rendering another origin first cannot relabel this board', () => {
  const state = { sweeps: [], updatedAt: FIXTURE_NOW, routeCount: 14 };
  const lga = renderPage(buildBoard(state, FIXTURE_NOW), state, [], FIXTURE_NOW, {
    origin: 'LGA',
    basePath: '/lga',
  });
  assert.ok(lga.includes('LGA <span>GoWild</span>'), 'the LGA board is labelled LGA');
  // Same isolate, no origin passed, exactly as the /s/<token> route calls it.
  const rdu = renderPage(buildBoard(state, FIXTURE_NOW), state, [], FIXTURE_NOW, { basePath: '/s/tok' });
  assert.ok(rdu.includes('RDU <span>GoWild</span>'), 'the default is RDU, not whatever rendered last');
  assert.ok(!rdu.includes('LGA <span>GoWild</span>'), 'a previous render must not leak its origin');
});

check('MAX_ALL_IN is the only price gate', () => {
  assert.equal(MAX_ALL_IN, 50);
  const state = { sweeps: [sweep({ flights: [flight({ allin: 50.0 }), flight({ allin: 50.0 + 0.004, dest: 'ATL' })] })], updatedAt: Date.now(), routeCount: 14 };
  const d = buildBoard(state, FIXTURE_NOW).dates[0];
  assert.equal(d.rows.length, 1, '$50.00 exactly is in; $50.004 rounds to $50.00 too');
});

check('observations are recorded for both dates without inflating counts', () => {
  const state = { history: [], observed: {}, days: {} };
  recordObservation(state, '2026-11-03', [flight({ dest: 'MCO' })]);
  recordObservation(state, '2026-11-03', [flight({ dest: 'MCO' })]);
  assert.equal(Object.keys(state.observed).length, 1);
  assert.equal(state.days['MCO|2026-11-03'], 1);
});

check('an expired cookie is classified as auth, not as a bot block', () => {
  const nf = (n) => Array.from({ length: n }, () => ({ ok: false, blocked: false, reason: 'not-found' }));
  const blocked = (n) => Array.from({ length: n }, () => ({ ok: false, blocked: true, reason: 'datadome-redirect' }));
  assert.equal(classifyFailure(nf(14)), 'auth');
  assert.equal(classifyFailure(blocked(14)), 'blocked');
  assert.equal(classifyFailure([...nf(9), ...blocked(5)]), 'auth');
  assert.equal(classifyFailure([{ ok: true }, ...nf(13)]), null, 'one good route is not an outage');
  assert.equal(classifyFailure([{ ok: false, blocked: false, reason: 'unparseable-journeys' }]), 'error');
  assert.equal(classifyFailure([]), 'error');
});

check('an auth-classified state shows the exact repair command', () => {
  const state = { sweeps: [], updatedAt: Date.now(), routeCount: 14, lastError: { kind: 'auth', detail: '14/14 routes redirected' } };
  const html = renderPage(buildBoard(state), state, [], Date.now());
  assert.ok(/Session expired — cookie needs replacing/.test(html));
  assert.ok(html.includes('wrangler secret put FRONTIER_COOKIE'));
});

check('extractJourneys survives a truncated payload', () => {
  assert.equal(extractJourneys('"journeys":[{"flights":[]'), undefined);
  assert.equal(extractJourneys('nothing here'), null);
  assert.deepEqual(extractJourneys('"journeys":[]'), []);
});

check('the schedule never records a failed request as "does not fly"', () => {
  const state = {};
  const ok = (dest, n) => ({
    date: '2026-11-02',
    dest,
    ok: true,
    blocked: false,
    flights: Array.from({ length: n }, () => ({ goWild: true, allin: 15 })),
  });
  const bad = (dest) => ({ date: '2026-11-02', dest, ok: false, blocked: false, flights: [] });
  recordSchedule(state, '2026-11-02', [ok('MCO', 2), ok('CUN', 0), bad('ATL')], 1000);
  const day = state.schedule['2026-11-02'];
  assert.equal(day.MCO.operates, true);
  assert.equal(day.CUN.operates, false, 'a successful empty response is a real absence');
  assert.equal(day.ATL.ok, undefined, 'a failed request teaches nothing about the schedule');
});

check('week over week decides stable vs rotating', () => {
  const mk = (date, dest, operates) => ({
    date,
    dest,
    ok: true,
    blocked: false,
    flights: operates ? [{ goWild: true, allin: 15 }] : [],
  });
  const state = {};
  recordSchedule(state, '2026-11-02', [mk('2026-11-02', 'MCO', true), mk('2026-11-02', 'CUN', true)], 1000);
  recordSchedule(state, '2026-11-09', [mk('2026-11-09', 'MCO', true), mk('2026-11-09', 'CUN', false)], 2000);
  const pat = weeklyPattern(state);
  const mco = pat.rows.find((r) => r.dest === 'MCO');
  const cun = pat.rows.find((r) => r.dest === 'CUN');
  assert.equal(pat.dates, 2);
  assert.equal(pat.weeks, 2, 'two Mondays a week apart');
  assert.equal(mco.cells[1].of, 2);
  assert.equal(mco.cells[1].operates, 2);
  assert.equal(mco.verdict, 'stable');
  assert.equal(cun.verdict, 'rotating', 'CUN differed between the two Mondays');
  assert.equal(mco.cells[2].of, 0, 'an unswept Tuesday has no denominator');
  assert.equal(weekKey('2026-11-02'), '2026-11-02', 'a Monday starts its own week');
  assert.equal(weekKey('2026-11-08'), '2026-11-02', 'Sunday belongs to the preceding Monday');
});

check('one refusal ends the sweep instead of spending the rest of the budget', () => {
  assert.equal(shouldAbortSweep({ ok: false, reason: 'no-journeys-key' }), true);
  assert.equal(shouldAbortSweep({ ok: false, reason: 'datadome-redirect' }), true);
  assert.equal(shouldAbortSweep({ ok: false, reason: 'not-found' }), true);
  assert.equal(shouldAbortSweep({ ok: false, reason: 'fetch-failed: boom' }), true);
  assert.equal(shouldAbortSweep({ ok: true, reason: 'no-flights', flights: [] }), false, 'a real no-flight day is not a refusal');
  assert.equal(shouldAbortSweep({ ok: true, reason: 'ok', flights: [1] }), false);
});

check('a date that failed completely keeps its previous rows instead of being erased', () => {
  const prev = [
    { date: '2026-11-02', dest: 'MCO', ok: true, flights: [{ goWild: true, allin: 15 }] },
    { date: '2026-11-03', dest: 'MCO', ok: true, flights: [{ goWild: true, allin: 25 }] },
  ];
  const fresh = [
    { date: '2026-11-02', dest: 'MCO', ok: true, flights: [] },
    { date: '2026-11-03', dest: 'MCO', ok: false, blocked: false, flights: [], reason: 'no-journeys-key' },
  ];
  const { sweeps, deadDates, kept } = mergeSweeps(prev, fresh, ['2026-11-02', '2026-11-03']);
  assert.equal(deadDates.length, 1);
  assert.equal(deadDates[0], '2026-11-03');
  const day3 = sweeps.filter((s) => s.date === '2026-11-03');
  assert.equal(day3.length, 1, 'the previous row survives');
  assert.equal(day3[0].flights[0].allin, 25, 'and it is the real earlier fare, not an empty result');
  assert.equal(sweeps.filter((s) => s.date === '2026-11-02').length, 1, 'the healthy date is replaced, not duplicated');
  assert.equal(kept.reduce((a, k) => a + k.rows, 0), 1);
});

// The bug this guards against: the client script is emitted from a template
// literal, so a \r\n written as an escape collapses into a real line break
// inside a string literal. The page still renders perfectly — only pin, calendar
// export and the PWA wiring die, with one console exception nobody sees. Every
// HTML assertion passed while the feature was completely dead.
check('the delivered page ships a client script that actually parses', () => {
  const state = { sweeps: [sweep({ flights: [flight()] })], updatedAt: Date.now(), routeCount: 14 };
  const html = renderPage(buildBoard(state), state, [], Date.now());
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'the page must carry its client script');
  assert.doesNotThrow(() => new Function(m[1]), 'a syntax error here silently kills pin and calendar export');
});

// A sweep that stops at request 19 must not shrink tomorrow from 14 routes to
// the 5 it happened to ask about. The routes never asked keep their previous
// result, flagged, instead of vanishing without a word.
check('a truncated sweep keeps the routes it never asked about', () => {
  const prev = ROUTES.map((r) => ({
    date: '2026-11-04',
    dest: r.code,
    ok: true,
    blocked: false,
    flights: [{ goWild: true, allin: 15 }],
  }));
  const fresh = ROUTES.slice(0, 5).map((r) => ({
    date: '2026-11-04',
    dest: r.code,
    ok: true,
    blocked: false,
    flights: [],
  }));
  const { sweeps, partial } = mergeSweeps(prev, fresh, ['2026-11-04'], { expectedRoutes: ROUTES.length });
  const forDate = sweeps.filter((s) => s.date === '2026-11-04');
  assert.equal(forDate.length, ROUTES.length, 'all 14 routes survive the refusal');
  assert.equal(partial.length, 1);
  assert.equal(partial[0].attempted, 5);
  assert.equal(partial[0].missing, ROUTES.length - 5);
  const carried = forDate.filter((s) => s.carried);
  assert.equal(carried.length, ROUTES.length - 5);
  assert.ok(carried.every((s) => s.flights.length === 1), 'carried rows are the real prior fares');

  const full = ROUTES.map((r) => ({ date: '2026-11-04', dest: r.code, ok: true, blocked: false, flights: [] }));
  const done = mergeSweeps(prev, full, ['2026-11-04'], { expectedRoutes: ROUTES.length });
  assert.equal(done.partial.length, 0, 'a complete sweep carries nothing');
  assert.equal(done.sweeps.filter((s) => s.carried).length, 0);
  assert.equal(mergeSweeps(prev, [], ['2026-11-04']).kept.length, 1, 'the old signature still works');
});

// Halving the burst is only safe if the other half is carried and labelled. A
// planned rotation must not look like a broken sweep, or the banner would fire
// on every single tick and stop meaning anything — and on a 15-minute cadence
// nobody would read it.
check('a rotating half-sweep carries the other half without crying partial', () => {
  const prev = ROUTES.map((r) => ({
    date: '2026-11-04',
    dest: r.code,
    ok: true,
    blocked: false,
    flights: [{ goWild: true, allin: 15 }],
  }));
  const half = shardRoutes(ROUTES, 0);
  const codes = half.map((r) => r.code);
  const fresh = half.map((r) => ({ date: '2026-11-04', dest: r.code, ok: true, blocked: false, flights: [] }));

  const out = mergeSweeps(prev, fresh, ['2026-11-04'], { expectedRoutes: codes.length, plannedDests: codes, now: 5000 });
  const forDate = out.sweeps.filter((s) => s.date === '2026-11-04');
  assert.equal(forDate.length, 14, 'no route disappears from the board');
  assert.equal(out.partial.length, 0, 'a planned half is not a partial sweep');
  const carried = forDate.filter((s) => s.carried);
  assert.equal(carried.length, 7);
  assert.ok(carried.every((s) => s.carriedReason === 'rotated'), 'labelled as rotation, not as a failure');
  assert.ok(carried.every((s) => s.carriedAt === 5000), 'and stamped so the page can show its age');
  assert.equal(carried.filter((s) => s.flights.length === 1).length, 7, 'the real prior fares survive');

  // A refusal inside the half that was asked is still a partial sweep.
  const aborted = mergeSweeps(prev, fresh.slice(0, 4), ['2026-11-04'], {
    expectedRoutes: codes.length,
    plannedDests: codes,
    now: 6000,
  });
  assert.equal(aborted.partial.length, 1);
  assert.equal(aborted.partial[0].attempted, 4);
  assert.equal(aborted.partial[0].expected, 7);
  assert.equal(aborted.partial[0].missing, 3, 'only the routes it failed to ask are missing');
  assert.equal(aborted.partial[0].rotated, 7);
  assert.equal(aborted.sweeps.filter((s) => s.date === '2026-11-04').length, 14, 'and nothing is lost there either');
});

// After the last departure the day is over, not broken. Calling it a dead date
// would raise a warning banner every night for a sweep that did nothing wrong.
check('a date whose departures have finished is carried, never reported as dead', () => {
  const prev = [
    ...ROUTES.map((r) => ({ date: '2026-11-03', dest: r.code, ok: true, blocked: false, flights: [{ goWild: true, allin: 15 }] })),
    ...ROUTES.map((r) => ({ date: '2026-11-04', dest: r.code, ok: true, blocked: false, flights: [] })),
  ];
  const half = shardRoutes(ROUTES, 1).map((r) => r.code);
  const tomorrow = half.map((r) => ({ date: '2026-11-04', dest: r, ok: true, blocked: false, flights: [] }));
  const out = mergeSweeps(prev, tomorrow, ['2026-11-04'], {
    expectedRoutes: half.length,
    plannedDests: half,
    skippedDates: ['2026-11-03'],
    now: 7000,
  });
  assert.equal(out.deadDates.length, 0, 'a deliberate skip is not a failure');
  assert.equal(out.kept.length, 0);
  assert.deepEqual(out.skipped.map((s) => s.date), ['2026-11-03']);
  const today = out.sweeps.filter((s) => s.date === '2026-11-03');
  assert.equal(today.length, 14, 'today still renders instead of vanishing from the board');
  assert.ok(today.every((s) => s.carried && s.carriedReason === 'day-over'));
  assert.equal(out.partial.length, 0, 'and it is not a partial sweep');
});

// The whole point of the flag: a carried fare must never look freshly checked.
check('carried rows show their age instead of implying a fresh check', () => {
  const carriedAt = Date.now() - 50 * 60000;
  const fresh = shardRoutes(ROUTES, 0).map((r) => ({ date: '2026-11-04', dest: r.code, ok: true, blocked: false, flights: [] }));
  const stale = shardRoutes(ROUTES, 1).map((r) => ({
    date: '2026-11-04',
    dest: r.code,
    ok: true,
    blocked: false,
    flights: [],
    carried: true,
    carriedAt,
    carriedReason: 'rotated',
  }));
  const state = {
    sweeps: fresh.concat(stale),
    updatedAt: Date.now(),
    routeCount: 14,
    lastSweep: { routes: 7, total: 14, shard: 0 },
  };
  const view = buildBoard(state);
  const d = view.dates[0];
  assert.equal(d.freshRoutes, 7);
  assert.equal(d.carriedRoutes, 7);
  assert.equal(d.carriedAt, carriedAt);
  const html = renderPage(view, state, [], Date.now());
  assert.match(html, /7\/14 routes re-checked/);
  assert.match(html, /7 carried from \d\d:\d\d ET/);
  assert.match(html, /Half-sweep mode: 7 of 14 routes per run/);
  assert.doesNotMatch(html, /Partial sweep/, 'rotation is not an error');
});

// A route that was never asked must not be recorded as "not bookable": that
// would erase a real observation from twenty minutes earlier.
check('a route that was not asked is never given a verdict', () => {
  const state = { observed: {}, days: {}, seenDests: { MCO: 1, CUN: 1 } };
  recordObservation(state, '2026-11-04', [{ date: '2026-11-04', dest: 'MCO', goWild: true, allin: 15 }], { asked: ['MCO'] });
  assert.equal(state.days['MCO|2026-11-04'], 1);
  assert.equal(state.days['CUN|2026-11-04'], undefined, 'CUN was the other half; it gets no verdict');

  const full = { observed: {}, days: {}, seenDests: { MCO: 1, CUN: 1 } };
  recordObservation(full, '2026-11-04', [{ date: '2026-11-04', dest: 'MCO', goWild: true, allin: 15 }]);
  assert.equal(full.days['CUN|2026-11-04'], 0, 'asked and absent is a real 0');
});

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    process.exitCode = 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

// The Worker is the write path now. If this door is not locked, anyone who can
// reach the origin can replace the board.
await checkAsync('the ingest endpoint is a closed door without the board token', async () => {
  const kv = new Map();
  const env = {
    BOARD_TOKEN: 'tok_abcdefgh',
    BOARD: {
      get: async () => (kv.has('state') ? JSON.parse(kv.get('state')) : null),
      put: async (k, v) => kv.set(k, v),
    },
  };
  const call = (method, { token, body, qs = '' } = {}) =>
    worker.fetch(
      new Request(`https://board.test/api/ingest${qs}`, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body,
      }),
      env,
    );

  assert.equal((await call('POST', { body: '{}' })).status, 401, 'no token must not write');
  assert.equal((await call('POST', { token: 'wrong', body: '{}' })).status, 401, 'wrong token must not write');
  assert.equal((await call('GET', {})).status, 401, 'reading the raw state needs the token too');
  assert.equal((await call('DELETE', { token: 'tok_abcdefgh' })).status, 405);
  assert.equal(kv.size, 0, 'nothing reached KV');

  const dry = await call('POST', { token: 'tok_abcdefgh', body: '{}', qs: '?dryRun=1' });
  assert.equal(dry.status, 200, 'the dry run proves the path');
  assert.equal(kv.size, 0, 'and writes nothing');
});

await checkAsync('the ingest endpoint refuses to overwrite a good board with a failed sweep', async () => {
  const kv = new Map();
  kv.set('state', JSON.stringify({ sweeps: [{ date: '2026-11-03', dest: 'MCO', ok: true, flights: [] }], updatedAt: 1 }));
  const env = {
    BOARD_TOKEN: 'tok_abcdefgh',
    BOARD: {
      get: async () => JSON.parse(kv.get('state')),
      put: async (k, v) => kv.set(k, v),
    },
  };
  const post = (payload) =>
    worker.fetch(
      new Request('https://board.test/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok_abcdefgh', 'Content-Type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      }),
      env,
    );

  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ nope: true })).status, 400, 'the shape is checked');
  const denied = await post({
    sweeps: ROUTES.map((r) => ({ date: '2026-11-03', dest: r.code, ok: false, blocked: true, flights: [] })),
  });
  assert.equal(denied.status, 409, 'an all-blocked sweep must not land');
  assert.equal(JSON.parse(kv.get('state')).sweeps.length, 1, 'the previous board is intact');

  const good = { updatedAt: 2, sweeps: [{ date: '2026-11-03', dest: 'MCO', ok: true, blocked: false, flights: [] }] };
  assert.equal((await post(good)).status, 200);
  assert.equal(JSON.parse(kv.get('state')).updatedAt, 2, 'a usable sweep replaces the board');
});

console.log(`\nSTRESS: ${passed} passed, ${failed} failed`);
