// RANK 5: "not one seat" is a claim about every route.
//
// Measured 2026-11-11: RDU sweeps seven of fourteen routes per tick. `state.zero`
// counted consecutive CLEAN sweeps, and a clean sweep only had to answer the routes
// it asked -- so three half-shard sweeps (which may have asked the same seven twice)
// produced a push saying "3 healthy sweeps over 3h and not one GoWild seat under $50"
// while half the route list had never been asked. The board was honest; the alert was
// not.
//
// The rule now: the alert waits until the union of routes covered across the counting
// window is every route, and then says so.
import assert from 'node:assert/strict';
import { buildZeroAlert, zeroCoverage } from '../src/alerts.mjs';
import { ROUTES } from '../src/routes.js';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const NOW = Date.UTC(2026, 10, 12, 18, 0);
const ALL = ROUTES.map((r) => r.code);
const SHARD_A = ALL.filter((_, i) => i % 2 === 0);
const SHARD_B = ALL.filter((_, i) => i % 2 === 1);

const stateZero = (zero) => ({ routeCount: ROUTES.length, lastError: null, zero });

// --- the accumulation rule ---------------------------------------------------
const afterA = zeroCoverage(null, SHARD_A);
eq(afterA.length, SHARD_A.length, 'the first shard is recorded');
eq(zeroCoverage({ routes: afterA }, SHARD_A).length, SHARD_A.length, 'asking the same shard twice adds nothing');
const afterB = zeroCoverage({ routes: afterA }, SHARD_B);
eq(afterB.length, ALL.length, 'the second shard completes the union');
eq(new Set(afterB).size, ALL.length, 'and the union holds no duplicates');
eq(zeroCoverage({ routes: afterA }, SHARD_B).join(','), ALL.slice().sort().join(','), 'the union is sorted and complete');
eq(zeroCoverage(null, []).length, 0, 'no routes asked means no coverage');
eq(zeroCoverage({ routes: ['ATL'] }, null).length, 1, 'a missing code list does not erase prior coverage');
// A prior record written before this field existed must not crash or claim coverage.
eq(zeroCoverage({ count: 4 }, ['ATL']).length, 1, 'an old zero record starts its coverage at what it has now');

// --- the alert -----------------------------------------------------------------
const since = NOW - 3 * 3600000;
const full = buildZeroAlert(stateZero({ count: 3, since, routes: ALL }), NOW);
ok(full !== null, 'a fully covered empty window fires the alert');
ok(/all 14 routes|all \d+ routes/.test(full.message), 'and the copy states the coverage it actually has');
ok(/not one GoWild seat under \$50/i.test(full.message), 'while keeping the finding');
eq(full.priority, 'low', 'a quiet finding stays quiet');

const half = buildZeroAlert(stateZero({ count: 3, since, routes: SHARD_A }), NOW);
eq(half, null, 'half the routes are not enough to claim "not one seat"');

const none = buildZeroAlert(stateZero({ count: 3, since, routes: [] }), NOW);
eq(none, null, 'no routes at all is not a finding');

const legacy = buildZeroAlert(stateZero({ count: 5, since }), NOW);
eq(legacy, null, 'a zero record with no coverage field does not fire');

// --- the guards that were already there still hold -----------------------------
eq(buildZeroAlert(stateZero({ count: 2, since, routes: ALL }), NOW), null, 'fewer than three sweeps is not a verdict');
eq(buildZeroAlert({ ...stateZero({ count: 9, since, routes: ALL }), lastError: { kind: 'blocked' } }, NOW), null, 'an erroring collector is not a finding');
// lastZeroAt is a top-level state field (that is where the collector writes it), not
// part of the zero record.
eq(buildZeroAlert({ ...stateZero({ count: 9, since, routes: ALL }), lastZeroAt: NOW }, NOW), null, 'the once-a-day cap still applies');
ok(
  buildZeroAlert({ ...stateZero({ count: 9, since, routes: ALL }), lastZeroAt: NOW - 25 * 3600000 }, NOW) !== null,
  'and it re-fires after a day',
);

// --- stress: any union short of complete, in any order, stays silent -----------
// The failure being fixed was a coverage claim, so the stress is the claim itself:
// for every proper subset size, no alert. Then the full set, in a shuffled order,
// does alert. 200 shuffles is enough to catch an order-dependent comparison.
let alerted = 0;
let silent = 0;
for (let cut = 0; cut < ALL.length; cut += 1) {
  const subset = ALL.slice(0, cut);
  if (buildZeroAlert(stateZero({ count: 3, since, routes: subset }), NOW) === null) silent += 1;
  else alerted += 1;
}
eq(silent, ALL.length, 'every proper subset of routes is silent');
eq(alerted, 0, 'and none of them fires');

for (let seed = 0; seed < 200; seed += 1) {
  const shuffled = ALL.slice();
  let x = seed + 7;
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const union = new Set();
  for (const code of shuffled) union.add(code);
  const alert = buildZeroAlert(stateZero({ count: 3, since, routes: [...union] }), NOW);
  ok(alert !== null, 'fuzz: the complete union fires regardless of order');
  ok(new RegExp(`all ${ALL.length} routes`).test(alert.message), 'fuzz: and the copy names the real coverage');
}

console.log(`zero: ${checks} checks passed`);
