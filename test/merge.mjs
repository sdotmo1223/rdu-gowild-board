// Regression checks for mergeSweeps, found by the independent reviewer on
// 2026-11-03. Both failures were silent: a refused route vanished from the board,
// and a stale row claimed to be fresh.
import assert from 'node:assert';
import { mergeSweeps, extractJourneys } from '../collector/parse.mjs';

let n = 0;
const ok = (label) => {
  n += 1;
  console.log(`ok  ${n} - ${label}`);
};

const prev = [
  { date: '2026-11-04', dest: 'ATL', ok: true, flights: [{ dest: 'ATL', goWild: true, allin: 30 }] },
  { date: '2026-11-04', dest: 'BOS', ok: true, flights: [{ dest: 'BOS', goWild: true, allin: 35 }] },
];

// This tick ATL answered and BOS was refused.
const fresh = [
  { date: '2026-11-04', dest: 'ATL', ok: true, flights: [{ dest: 'ATL', goWild: true, allin: 31 }] },
  { date: '2026-11-04', dest: 'BOS', ok: false, blocked: true, flights: [], reason: 'datadome-redirect' },
];

const r1 = mergeSweeps(prev, fresh, ['2026-11-04'], {
  plannedDests: ['ATL', 'BOS'],
  expectedRoutes: 2,
  now: 2000,
});
const bos1 = r1.sweeps.filter((s) => s.dest === 'BOS');
ok('a refused route keeps exactly one row, and it is the good one');
assert.equal(bos1.length, 1);
assert.equal(bos1[0].carried, true);
assert.equal(bos1[0].carriedReason, 'aborted');
assert.equal(bos1[0].flights[0].allin, 35);
// The failed row must not survive next to its carried copy.
assert.equal(r1.sweeps.filter((s) => s.dest === 'BOS' && s.ok === false).length, 0);

ok('a carried row reports a partial sweep rather than a quiet one');
assert.equal(r1.partial.length, 1);
assert.equal(r1.partial[0].attempted, 1);
assert.equal(r1.partial[0].expected, 2);

// Carry it again a tick later: the age of the data must not reset.
const r2 = mergeSweeps(r1.sweeps, [{ date: '2026-11-04', dest: 'ATL', ok: true, flights: [] }], ['2026-11-04'], {
  plannedDests: ['ATL', 'BOS'],
  expectedRoutes: 2,
  now: 9000,
});
const bos2 = r2.sweeps.filter((s) => s.dest === 'BOS');
ok('carriedAt survives a second carry instead of restamping to now');
assert.equal(bos2.length, 1);
assert.equal(bos2[0].carriedAt, 2000);

// A rotating sweep is not a partial sweep: the other half was never asked.
const r3 = mergeSweeps(
  [
    { date: '2026-11-04', dest: 'ATL', ok: true, flights: [] },
    { date: '2026-11-04', dest: 'BOS', ok: true, flights: [] },
  ],
  [{ date: '2026-11-04', dest: 'ATL', ok: true, flights: [] }],
  ['2026-11-04'],
  { plannedDests: ['ATL'], expectedRoutes: 1, now: 12000 },
);
ok('a rotated half is carried as rotated and raises no partial banner');
assert.equal(r3.partial.length, 0);
assert.equal(r3.sweeps.filter((s) => s.dest === 'BOS')[0].carriedReason, 'rotated');

// extractJourneys must not treat a non-array journeys value plus a later '[' as a
// journeys list: that is how a refusal gets reported as an honest empty day.
ok('a non-array journeys value is a refusal, not an empty day');
assert.equal(extractJourneys('{"journeys":null,"other":[1,2,3]}'), null);
ok('a journeys array with odd spacing still parses');
assert.deepEqual(extractJourneys('{"journeys"  :  [{"a":1}]}'), [{ a: 1 }]);

console.log(`\nMERGE: ${n} checks passed`);
