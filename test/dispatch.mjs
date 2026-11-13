// RANK 4: the schedule GitHub drops has to come from somewhere else.
//
// Measured 2026-11-11: 24 scheduled runs in 24 h, median gap 60 min, and at 17:20Z the
// newest run was 16:24Z -- the 16:35, 16:50 and 17:05 recovery entries produced no run
// record at all. The recovery gate is evaluated inside a run, so it cannot resurrect a
// slot GitHub never created. The fix is an external nudge: a Worker Cron Trigger every
// 15 minutes that asks GitHub to dispatch the collector, but only when the board is
// already stale, and never twice inside its own cooldown.
import assert from 'node:assert/strict';
import {
  DISPATCH_AFTER_MIN,
  DISPATCH_LOCK_MS,
  maybeDispatch,
} from '../src/dispatch.mjs';
import worker from '../src/index.js';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

function kv() {
  const m = new Map();
  return {
    _m: m,
    async get(k, t) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return t === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, String(v));
    },
    async delete(k) {
      m.delete(k);
    },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

const NOW = Date.UTC(2026, 10, 12, 18, 0);
const board = (ageMin) => ({ updatedAt: NOW - ageMin * 60000, sweeps: [{ date: '2026-11-12', dest: 'ATL', ok: true, flights: [] }] });

function envWith(ageMin, o = {}) {
  const store = kv();
  if (ageMin !== null) store.put('state', JSON.stringify(board(ageMin)));
  return { BOARD: store, GH_DISPATCH_TOKEN: o.token === undefined ? 'ghp_example_token_value' : o.token, GH_REPO: o.repo };
}

function stubFetch(status = 204) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    // A 204 may not carry a body in undici, so the stub mirrors the real API.
    return new Response(null, { status });
  };
  return { calls, impl };
}

// --- 1. stale board dispatches ------------------------------------------------
{
  const env = envWith(DISPATCH_AFTER_MIN + 20);
  const { calls, impl } = stubFetch(204);
  const res = await maybeDispatch(env, NOW, { fetchImpl: impl });
  eq(res.dispatched, true, 'a board past the gate asks GitHub to run the collector');
  eq(calls.length, 1, 'exactly one request');
  ok(/\/actions\/workflows\/sweep\.yml\/dispatches$/.test(calls[0].url), 'it targets the sweep workflow');
  ok(/^Bearer ghp_example_token_value$/.test(calls[0].init.headers.Authorization), 'authenticated with the PAT');
  eq(calls[0].init.method, 'POST', 'as a POST');
  eq(JSON.parse(calls[0].init.body).ref, 'main', 'on main');
  eq(await env.BOARD.get('dispatch:last'), String(NOW), 'and the cooldown is recorded');
}

// --- 2. a fresh board dispatches nothing ---------------------------------------
{
  const env = envWith(5);
  const { calls, impl } = stubFetch(204);
  const res = await maybeDispatch(env, NOW, { fetchImpl: impl });
  eq(res.dispatched, false, 'a fresh board costs no dispatch');
  eq(calls.length, 0, 'and no request at all');
  ok(/fresh/i.test(res.reason), 'the reason says the board is fresh');
  eq(await env.BOARD.get('dispatch:last'), null, 'and no cooldown is written');
}

// --- 3. no token: a clean no-op, never a crash ---------------------------------
{
  const env = envWith(999, { token: '' });
  const { calls, impl } = stubFetch(204);
  const res = await maybeDispatch(env, NOW, { fetchImpl: impl });
  eq(res.dispatched, false, 'without a token nothing is dispatched');
  eq(calls.length, 0, 'and nothing is fetched');
  ok(/GH_DISPATCH_TOKEN/.test(res.reason), 'the reason names the secret to set');
  ok(/Actions: write/i.test(res.reason), 'and the permission it needs');
}

// --- 4. the receiver-side double gate ------------------------------------------
{
  const env = envWith(999);
  const first = stubFetch(204);
  await maybeDispatch(env, NOW, { fetchImpl: first.impl });
  const second = stubFetch(204);
  const res = await maybeDispatch(env, NOW + 60000, { fetchImpl: second.impl });
  eq(res.dispatched, false, 'a second cron tick inside the cooldown is a no-op');
  eq(second.calls.length, 0, 'so GitHub is not asked twice');
  ok(/cooldown|locked|recent/i.test(res.reason), 'and the reason says why');
  const third = stubFetch(204);
  const later = await maybeDispatch(env, NOW + DISPATCH_LOCK_MS + 1, { fetchImpl: third.impl });
  eq(later.dispatched, true, 'after the cooldown it dispatches again');
  eq(third.calls.length, 1, 'exactly once');
}

// --- 5. a rejected dispatch does not burn the cooldown -------------------------
{
  const env = envWith(999);
  const bad = stubFetch(422);
  const res = await maybeDispatch(env, NOW, { fetchImpl: bad.impl });
  eq(res.dispatched, false, 'a rejected dispatch is reported as not dispatched');
  ok(/422/.test(res.reason), 'with the status');
  eq(await env.BOARD.get('dispatch:last'), null, 'and no cooldown, so the next tick can try again');
  const good = stubFetch(204);
  const retry = await maybeDispatch(env, NOW + 15 * 60000, { fetchImpl: good.impl });
  eq(retry.dispatched, true, 'the next tick retries');
}

// --- 6. no snapshot at all is maximally stale, and still dispatches ------------
{
  const env = envWith(null);
  const { calls, impl } = stubFetch(204);
  const res = await maybeDispatch(env, NOW, { fetchImpl: impl });
  eq(res.dispatched, true, 'a board that has never been written is not fresh');
  eq(calls.length, 1, 'so the collector is asked to run');
}

// --- 7. never throws into the platform ----------------------------------------
{
  const env = envWith(999);
  const res = await maybeDispatch(env, NOW, {
    fetchImpl: async () => {
      throw new Error('dns is down');
    },
  });
  eq(res.dispatched, false, 'a network failure is a result, not an exception');
  ok(/dns is down/.test(res.reason), 'and the reason is kept');
  const broken = await maybeDispatch({ GH_DISPATCH_TOKEN: 'x', BOARD: null }, NOW, {
    fetchImpl: async () => new Response('', { status: 204 }),
  });
  eq(broken.dispatched, false, 'a missing KV binding is a result too');
  ok(typeof broken.reason === 'string' && broken.reason.length > 0, 'with a reason');
}

// --- 8. the Worker exposes both entry points ----------------------------------
{
  const env = envWith(999);
  env.BOARD_TOKEN = 'tok-abcdefgh';
  let waited = null;
  const ctx = { waitUntil: (p) => { waited = p; } };
  const realFetch = globalThis.fetch;
  const { calls, impl } = stubFetch(204);
  globalThis.fetch = impl;

  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: NOW }, env, ctx);
  ok(waited && typeof waited.then === 'function', 'the cron handler schedules the work off the platform path');
  await waited;
  eq(calls.length, 1, 'and the cron really dispatches a stale board');

  const anon = await worker.fetch(new Request('https://b.test/api/dispatch'), env, {});
  eq(anon.status, 401, 'the manual route is gated by the board token');
  const okRes = await worker.fetch(
    new Request('https://b.test/api/dispatch', { headers: { Authorization: 'Bearer tok-abcdefgh' } }),
    env,
    {},
  );
  eq(okRes.status, 200, 'and answers with a token');
  const body = await okRes.json();
  ok(typeof body.dispatched === 'boolean' && typeof body.reason === 'string', 'the manual route reports what it did');

  // A cron event object with no fields at all must still work: the platform's shape
  // is not something this code should depend on.
  await worker.scheduled({}, env, { waitUntil() {} });
  globalThis.fetch = realFetch;
}

// --- 9. stress: an hour of ticks cannot flood the collector -------------------
// The cron fires four times an hour. The cooldown is the only thing standing between
// that and four overlapping Chrome installs, so it is asserted over the whole hour
// rather than on a single pair.
{
  const env = envWith(999);
  const { calls, impl } = stubFetch(204);
  let sent = 0;
  for (let tick = 0; tick < 60; tick += 1) {
    // Keep the board stale for the whole hour, which is the hostile case.
    await env.BOARD.put('state', JSON.stringify(board(999)));
    const res = await maybeDispatch(env, NOW + tick * 60000, { fetchImpl: impl });
    if (res.dispatched) sent += 1;
  }
  ok(sent >= 1, 'the hour still dispatches at least once');
  ok(sent <= Math.ceil((60 * 60000) / DISPATCH_LOCK_MS) + 1, 'and never more often than the cooldown allows');
  eq(calls.length, sent, 'one request per dispatch, no silent extras');
}

// --- 10. stress: a repo override is honoured, and the token stays out of the reason
{
  const env = envWith(999, { repo: 'someone/fork' });
  const { calls, impl } = stubFetch(204);
  const res = await maybeDispatch(env, NOW, { fetchImpl: impl });
  eq(res.dispatched, true, 'a configured repo is used');
  ok(/\/repos\/someone\/fork\/actions\//.test(calls[0].url), 'and the URL follows it');
  ok(!JSON.stringify(res).includes('ghp_example_token_value'), 'the token never surfaces in a result');
  const failEnv = envWith(999);
  const failed = await maybeDispatch(failEnv, NOW, {
    fetchImpl: async () => {
      throw new Error('socket closed');
    },
  });
  ok(!JSON.stringify(failed).includes('ghp_example_token_value'), 'not even when the call throws');
}

// --- 11. stress: a KV read failure is reported, not thrown -------------------
{
  const env = {
    GH_DISPATCH_TOKEN: 'ghp_example_token_value',
    BOARD: {
      async get() {
        throw new Error('kv unavailable');
      },
      async put() {},
    },
  };
  const res = await maybeDispatch(env, NOW, { fetchImpl: async () => new Response(null, { status: 204 }) });
  eq(res.dispatched, false, 'a KV read failure does not dispatch blindly');
  ok(/kv unavailable/.test(res.reason), 'and the reason is reported');
}

console.log(`dispatch: ${checks} checks passed`);
