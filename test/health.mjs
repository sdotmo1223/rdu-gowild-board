// TASK A: the HEALTH tier -- quiet until something is wrong, then loudly once.
//
// Two rules make this tier usable rather than noisy:
//   - it fires on a STATE TRANSITION, not on every evaluation. A push that repeats
//     every 15 minutes is a machine talking to itself;
//   - "degraded" means the trigger stopped recovering the board: neither a dispatch
//     nor a successful run inside 90 minutes. That is the Upgrade 1 residual, and it
//     lives here now.
import assert from 'node:assert/strict';
import {
  DEGRADED_AFTER_MIN,
  buildHealthNotice,
  healthFingerprint,
  isDegraded,
} from '../src/health.mjs';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const minsAgo = (m) => NOW - m * 60000;

// --- 1. degraded arithmetic ---------------------------------------------------
{
  eq(DEGRADED_AFTER_MIN, 90, 'ninety minutes is the rule');
  eq(isDegraded(minsAgo(10), null, NOW), false, 'a fresh run is not degraded');
  eq(isDegraded(minsAgo(100), null, NOW), true, 'an old run with no dispatch is degraded');
  eq(isDegraded(minsAgo(100), minsAgo(20), NOW), false, 'a recent dispatch is enough');
  eq(isDegraded(minsAgo(100), minsAgo(200), NOW), true, 'both old is degraded');
  eq(isDegraded(null, null, NOW), true, 'never having run counts as degraded');
  eq(isDegraded(undefined, 'garbage', NOW), true, 'unreadable stamps degrade to degraded');
}

// --- 2. fingerprints are the transition key -----------------------------------
{
  eq(healthFingerprint({ pending: 0, dead: 0, degraded: false }), healthFingerprint({ pending: 0, dead: 0, degraded: false }), 'the same state hashes the same');
  ok(healthFingerprint({ pending: 1, dead: 0, degraded: false }) !== healthFingerprint({ pending: 0, dead: 0, degraded: false }), 'a change in pending changes the key');
  ok(healthFingerprint({ pending: 0, dead: 0, degraded: true }) !== healthFingerprint({ pending: 0, dead: 0, degraded: false }), 'a change in degraded changes the key');
}

// --- 3. what is worth a push --------------------------------------------------
{
  eq(buildHealthNotice({ pending: 0, dead: 0, degraded: false }, null, NOW), null, 'healthy says nothing');
  const pending = buildHealthNotice({ pending: 1, dead: 0, degraded: false, reason: 'push: HTTP 429' }, null, NOW);
  ok(pending, 'a pending delivery raises a notice');
  eq(pending.tier, 'health', 'in the health tier');
  ok(/429/.test(pending.message), 'with the provider reason');
  ok(/retry|held/i.test(pending.message), 'and what is happening to it');

  const dead = buildHealthNotice({ pending: 0, dead: 2, degraded: false, reason: 'push: HTTP 522' }, null, NOW);
  ok(dead, 'a dead delivery raises a notice');
  eq(dead.priority, 'high', 'and it is urgent');

  const degraded = buildHealthNotice({ pending: 0, dead: 0, degraded: true }, null, NOW);
  ok(degraded, 'a degraded trigger raises a notice');
  ok(/trigger|dispatch/i.test(degraded.message), 'naming the thing that stopped');
}

// --- 4. transitions only ------------------------------------------------------
{
  const signal = { pending: 1, dead: 0, degraded: false, reason: 'push: HTTP 429' };
  const first = buildHealthNotice(signal, null, NOW);
  ok(first, 'the first observation of a problem is a notice');
  eq(buildHealthNotice(signal, first.fingerprint, NOW), null, 'the same state again is silent');
  eq(buildHealthNotice(signal, first.fingerprint, NOW + 15 * 60000), null, 'still silent a tick later');

  const worse = { ...signal, dead: 1 };
  const second = buildHealthNotice(worse, first.fingerprint, NOW);
  ok(second, 'a different problem is a new notice');
  ok(second.fingerprint !== first.fingerprint, 'with a new fingerprint');

  eq(buildHealthNotice({ pending: 0, dead: 0, degraded: false }, second.fingerprint, NOW), null, 'recovery does not page anyone');
}

// --- 5. the link probe rides the same tier ------------------------------------
{
  const link = buildHealthNotice({ pending: 0, dead: 0, degraded: false, link: 'broken', linkStatus: 404 }, null, NOW);
  ok(link, 'a broken search link is a health notice');
  ok(/search link|404/i.test(link.message), 'naming the link and the status');
  const drift = buildHealthNotice({ pending: 0, dead: 0, degraded: false, link: 'drifted', linkStatus: 302 }, null, NOW);
  ok(drift, 'pattern drift is a health notice too');
  eq(buildHealthNotice({ pending: 0, dead: 0, degraded: false, link: 'challenged' }, null, NOW), null, 'a bot challenge is not');
}

console.log(`health: ${checks} checks passed`);
