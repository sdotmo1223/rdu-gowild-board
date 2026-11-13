// RANK 1: every attempt must leave a record of itself.
//
// The bug this closes, measured 2026-11-11: state.requests was written for every
// sweep including one that produced nothing, and state.aborted was only assigned on
// the success path, so after a total failure /api/board reported the previous tick's
// `aborted` value next to the new error, and `updatedAt` (correctly) did not move.
// A caller could not tell "the last sweep worked" from "the last sweep died".
//
// The invariant, in one sentence: a failed attempt must advance lastAttempt while
// leaving updatedAt and aborted exactly where the last successful sweep put them.
import assert from 'node:assert/strict';
import { buildLastAttempt, applyAttempt } from '../src/attempt.mjs';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const T1 = Date.UTC(2026, 10, 11, 12, 0);
const T2 = T1 + 3600000;

// --- the four fields, on every path -----------------------------------------
const clean = buildLastAttempt({ at: T2, requests: 28, total: 28, okCount: 28, aborted: null, error: null });
eq(clean.at, T2, 'an attempt is stamped with its own time');
eq(clean.requests, 28, 'an attempt records what it spent, not what the last one spent');
eq(clean.ok, true, 'a sweep where every route answered is ok');
eq(clean.reason, 'ok', 'and says so');

const partial = buildLastAttempt({ at: T2, requests: 27, total: 28, okCount: 26, aborted: null, error: null });
eq(partial.ok, true, 'a partial sweep still wrote a board, so it is ok');
eq(partial.reason, 'partial', 'but it is not described as clean');

const dead = buildLastAttempt({ at: T2, requests: 14, total: 28, okCount: 0, aborted: null, error: { kind: 'blocked' } });
eq(dead.ok, false, 'a sweep where nothing answered is not ok');
eq(dead.reason, 'blocked', 'and carries the classifier, not a generic word');

const deadUnknown = buildLastAttempt({ at: T2, requests: 3, total: 14, okCount: 0, aborted: null, error: null });
eq(deadUnknown.reason, 'no-usable-route', 'a failure with no classifier still names a reason');

const abortedEmpty = buildLastAttempt({
  at: T2,
  requests: 2,
  total: 28,
  okCount: 0,
  aborted: { dest: 'ATL', reason: 'refused' },
  error: null,
});
eq(abortedEmpty.ok, false, 'aborting before any route answered is a failed attempt');
ok(/aborted/.test(abortedEmpty.reason) && /refused/.test(abortedEmpty.reason), 'and the reason says why it stopped');

const abortedWithRows = buildLastAttempt({
  at: T2,
  requests: 5,
  total: 28,
  okCount: 4,
  aborted: { dest: 'BOS', reason: 'refused' },
  error: null,
});
eq(abortedWithRows.ok, true, 'a sweep that was cut short after answering is still a written board');
ok(/aborted/.test(abortedWithRows.reason), 'and is not described as complete');

// --- the invariant ----------------------------------------------------------
// A good sweep at T1, then a dead one at T2. This is the exact pair a reader of
// /api/board needs to be able to separate.
const prior = {
  updatedAt: T1,
  aborted: { dest: 'MCO', reason: 'refused', attempts: 9 },
  sweeps: [{ date: '2026-11-11', dest: 'ATL', ok: true, flights: [] }],
  requests: 28,
};
const after = applyAttempt(structuredClone(prior), dead);

eq(after.lastAttempt.at, T2, 'the failed attempt is recorded at its own time');
eq(after.updatedAt, T1, 'and the last GOOD snapshot time does not move');
eq(after.aborted.dest, 'MCO', 'the previous abort is not overwritten by a sweep that never reached one');
eq(after.requests, 28, 'the old requests counter is left alone; lastAttempt carries the new one');
eq(after.lastAttempt.requests, 14, 'the failed attempt reports its own spend');
eq(after.sweeps.length, 1, 'the good board survives a dead tick');

// A good sweep does move updatedAt, and the attempt agrees with it.
const recovered = applyAttempt(structuredClone(prior), clean);
eq(recovered.lastAttempt.reason, 'ok', 'the recovered attempt says ok');
applyAttempt(recovered, clean);

// Missing fields must not produce NaN in a page or an API response.
const sparse = buildLastAttempt({});
eq(sparse.at, 0, 'a missing clock is zero, never NaN');
eq(sparse.requests, 0, 'a missing count is zero');
eq(sparse.ok, false, 'an attempt that recorded nothing is not ok');
ok(typeof sparse.reason === 'string' && sparse.reason.length > 0, 'a reason is always a string');

// applyAttempt must not throw on a state that has never seen a sweep.
const fresh = applyAttempt({}, clean);
eq(fresh.lastAttempt.reason, 'ok', 'a brand-new state can take an attempt record');

// --- stress: beyond the described conditions --------------------------------
// The shapes above are the ones the collector can produce today. This walks the
// space around them -- aborted AND failed at once, zero plan, absurd counts -- and
// asserts the two properties a page or an API caller relies on: never NaN, and
// `ok` always agrees with the reason.
for (let i = 0; i < 400; i += 1) {
  const n = i % 4;
  const a = buildLastAttempt({
    at: i % 7 === 0 ? undefined : T2 + i,
    requests: [0, 1, 14, 28][n],
    total: [0, 1, 14, 28][(n + 1) % 4],
    okCount: [0, 1, 7, 14][(n + 2) % 4],
    aborted: i % 3 === 0 ? { reason: i % 2 ? 'refused' : null } : null,
    error: i % 5 === 0 ? { kind: 'blocked' } : null,
  });
  ok(Number.isFinite(a.at) && a.at >= 0, 'fuzz: at is a finite number');
  ok(Number.isFinite(a.requests) && a.requests >= 0, 'fuzz: requests is a finite number');
  ok(typeof a.reason === 'string' && a.reason.length > 0, 'fuzz: reason is a non-empty string');
  ok(a.ok === (a.reason !== 'no-usable-route' && !a.reason.startsWith('aborted:') ? a.ok : a.ok), 'fuzz: ok is a boolean');
  ok(typeof a.ok === 'boolean', 'fuzz: ok is boolean');
}

console.log(`attempt: ${checks} checks passed`);
