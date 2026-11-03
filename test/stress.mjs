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
import { buildAlert } from '../src/alerts.mjs';
import { normalizeSeats, parseRoute, extractJourneys, classifyFailure } from '../collector/parse.mjs';
import worker from '../src/index.js';
import {
  ROUTES,
  BLACKOUT_DATES,
  MAX_ALL_IN,
  easternDate,
  frontierDateParam,
  isBlackout,
} from '../src/routes.js';

let passed = 0;
let failed = 0;

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
  const view = buildBoard(state);
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
  const view = buildBoard(state);
  const html = renderPage(view, state, [], Date.now());
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
  const html = renderPage(buildBoard(state), state, [], Date.now());
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
  const d = buildBoard(state).dates[0];
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
  const d = buildBoard(state).dates[0];
  assert.equal(d.peak, true, 'the calendar flags the date');
  assert.equal(d.rows.length, 1, 'a genuine sub-$50 fare is shown, not hidden');
  const html = renderPage(buildBoard(state), state, [], Date.now());
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
  const html = renderPage(buildBoard(state), state, [], Date.now());
  for (const attr of ['data-dep=', 'data-arr=', 'data-dest=', 'data-date=', 'data-allin=']) assert.ok(html.includes(attr), attr);
  assert.ok(html.includes('class="act ics"'));
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
  const d = buildBoard(state).dates[0];
  assert.equal(d.blockedRoutes, 1);
  assert.notEqual(d.status, 'blocked', 'one blocked route is not an outage');
});

check('an all-blocked state keeps the board and raises the banner', () => {
  const state = {
    sweeps: ROUTES.map((r) => sweep({ dest: r.code, blocked: true, ok: false })),
    updatedAt: Date.now(),
    routeCount: 14,
  };
  const d = buildBoard(state).dates[0];
  assert.equal(d.status, 'blocked');
  const html = renderPage(buildBoard(state), state, [], Date.now());
  assert.ok(/bot protection/i.test(html));
});

check('MAX_ALL_IN is the only price gate', () => {
  assert.equal(MAX_ALL_IN, 50);
  const state = { sweeps: [sweep({ flights: [flight({ allin: 50.0 }), flight({ allin: 50.0 + 0.004, dest: 'ATL' })] })], updatedAt: Date.now(), routeCount: 14 };
  const d = buildBoard(state).dates[0];
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
