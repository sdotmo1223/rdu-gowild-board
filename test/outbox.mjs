// RANK 2: a watch event is a promise, and a promise that is dropped is a lie.
//
// Measured 2026-11-11: the first real watch event fired, ntfy.sh answered HTTP 522,
// and the event was gone -- `announced` had been advanced before delivery was even
// attempted, so a failed `departing` push was never offered again, and `lastEvent`
// was stamped regardless of the result, so any other failed event went silent for
// six hours. The retry added that day only helped a transient error inside a single
// sweep.
//
// The rule now: an event is enqueued with a key, a rendered payload and an attempt
// count; `announced`/`lastEvent` advance only after a 2xx; failures back off and are
// retried up to MAX_ATTEMPTS and then die visibly on the board.
import assert from 'node:assert/strict';
import { buildBoard } from '../src/board.js';
import { easternDate, easternStamp } from '../src/routes.js';
import { renderPage } from '../src/render.js';
import { evaluateWatches, observe, watchKey } from '../src/watch.mjs';
import { VAPID, SUBSCRIPTION } from './push-stub.mjs';
import {
  MAX_ATTEMPTS,
  outboxKey,
  outboxStatus,
  readOutbox,
  sweepOutbox,
} from '../src/outbox.mjs';

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

const NOW = Date.now();
const TODAY = easternDate(0, NOW);
// 90 minutes out: inside the 3h "departing" window, and every event below is about
// a departure that is still catchable.
const SOON = easternStamp(NOW + 90 * 60000);
const fl = (o = {}) => ({
  date: TODAY,
  dest: 'PHL',
  city: 'Philadelphia',
  dep: o.dep || SOON,
  arr: SOON,
  stops: 'Nonstop',
  nonstop: true,
  dur: '1 hrs 42 min',
  seats: 3,
  allin: 31.27,
  goWild: true,
});
const snap = (flights, at = NOW) => ({
  updatedAt: at,
  routeCount: 2,
  sweeps: [
    { date: TODAY, dest: 'PHL', ok: true, blocked: false, at, flights },
    { date: TODAY, dest: 'MCO', ok: true, blocked: false, at, flights: [] },
  ],
  coverage: { PHL: { lastOkAt: at }, MCO: { lastOkAt: at } },
});

const theWatch = () => ({
  dest: 'PHL',
  mode: 'date',
  date: TODAY,
  channels: ['push'],
  announced: [],
  lastEvent: null,
  last: null,
});

// The baseline is "the same departure, already seen": that leaves `departing` as
// the only event that can fire, so nothing below is confused by an `available`.
async function armedWatch(store, at) {
  const s = snap([fl()], at);
  const w = theWatch();
  w.last = observe(buildBoard(s, at), s, w, at);
  await store.put(watchKey('rdu', 'PHL'), JSON.stringify(w));
  return s;
}

// Push is per-device now, so an env without an enrolled device has nowhere to send.
// The seed goes straight into the stub's map (synchronously) so every existing call
// site keeps its shape.
const pushEnv = (store) => {
  store._m.set('push:rdu-seed', JSON.stringify(SUBSCRIPTION));
  return { BOARD: store, ...VAPID };
};
const realFetch = globalThis.fetch;
const http = (status) => async () => new Response('', { status });

// --- 1. a 522 sequence: no advance, growing backoff, dead at MAX_ATTEMPTS -------
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  globalThis.fetch = http(522);

  const r1 = await evaluateWatches(env, 'rdu', s, s, NOW);
  ok(r1 !== null, 'evaluation survives a provider outage');
  let saved = await store.get(watchKey('rdu', 'PHL'), 'json');
  eq(saved.announced.length, 0, 'a failed departing push does not advance announced');
  eq(saved.lastEvent, null, 'and does not stamp lastEvent');
  let list = await readOutbox(store, 'rdu');
  eq(list.length, 1, 'the event is kept in the outbox instead of being dropped');
  eq(list[0].state, 'pending', 'it is pending');
  eq(list[0].attempts, 1, 'the first attempt is counted');
  eq(list[0].kind, 'departing', 'and the event kind is preserved');
  ok(list[0].nextAt > NOW, 'a retry is scheduled in the future');
  const firstDelay = list[0].nextAt - NOW;

  // Re-evaluating must not duplicate the event: the same departure is already
  // queued, and `announced` correctly has not moved yet.
  await evaluateWatches(env, 'rdu', s, s, NOW + 1000);
  list = await readOutbox(store, 'rdu');
  eq(list.length, 1, 'a second evaluation enqueues nothing new for the same event');

  // Walk the remaining attempts by their own schedule.
  const delays = [firstDelay];
  let at = list[0].nextAt;
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const before = (await readOutbox(store, 'rdu'))[0];
    const res = await sweepOutbox(env, 'rdu', at);
    const after = (await readOutbox(store, 'rdu'))[0] || null;
    eq(res.attempted, 1, `attempt ${attempt} really tried`);
    if (after && after.state === 'pending') {
      delays.push(after.nextAt - at);
      at = after.nextAt;
    } else {
      ok(after === null || after.state === 'dead', `attempt ${attempt} ends the entry`);
    }
    ok(before.attempts >= attempt - 1, `attempt ${attempt} is counted`);
  }
  list = await readOutbox(store, 'rdu');
  eq(list.length, 1, 'a dead event is kept as a tombstone, not silently deleted');
  eq(list[0].state, 'dead', `it is dead after ${MAX_ATTEMPTS} attempts`);
  eq(list[0].attempts, MAX_ATTEMPTS, 'and the count says how many times it was tried');
  ok(/522/.test(list[0].lastReason || ''), 'the reason names the provider status');
  ok(delays.length >= 2 && delays[1] > delays[0], 'backoff grows between attempts');

  saved = await store.get(watchKey('rdu', 'PHL'), 'json');
  eq(saved.announced.length, 0, 'a dead event never advances announced');
  eq(saved.lastEvent, null, 'and never records a delivery');

  const status = await outboxStatus(store, 'rdu');
  eq(status.dead, 1, 'the board can count the dead event');
  eq(status.pending, 0, 'and there is nothing left to retry');
  ok(/522/.test(status.lastReason || ''), 'the board can say why');

  // Visible on the board: a dead event is a promise the owner must know about.
  const view = buildBoard(s, NOW);
  const page = renderPage(view, s, [], NOW, {
    basePath: '/s/abcdefgh1234',
    origin: 'RDU',
    canWatch: true,
    watches: [saved],
    channels: { push: { ready: true } },
    outbox: status,
  });
  ok(/Watch delivery failing/i.test(page), 'the board says watch delivery is failing');
  ok(/522/.test(page), 'and shows the provider status');
  ok(!/gowild-abc/.test(page), 'without putting the topic on the page');
}

// --- 2. recovery mid-sequence: attempt 3 delivers -------------------------------
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return new Response('', { status: call <= 2 ? 522 : 200 });
  };
  await evaluateWatches(env, 'rdu', s, s, NOW); // attempt 1 fails
  let list = await readOutbox(store, 'rdu');
  eq(list[0].attempts, 1, 'attempt 1 failed');
  await sweepOutbox(env, 'rdu', list[0].nextAt); // attempt 2 fails
  list = await readOutbox(store, 'rdu');
  eq(list[0].attempts, 2, 'attempt 2 failed');
  eq(list[0].state, 'pending', 'a recoverable failure stays pending');
  const landedAt = list[0].nextAt;
  const res = await sweepOutbox(env, 'rdu', landedAt); // attempt 3 succeeds
  eq(res.delivered, 1, 'attempt 3 delivers');
  list = await readOutbox(store, 'rdu');
  // Reversed on purpose 2026-11-13: this used to assert the entry was gone. A log that
  // empties the moment something works cannot show the reader that it worked, and a
  // notification's focus key then points at nothing.
  eq(list.length, 1, 'a delivered event is remembered, not deleted');
  eq(list[0].state, 'sent', 'marked sent rather than left as a tombstone');
  eq(Number(list[0].deliveredAt), landedAt, 'stamped with the moment it landed');
  ok(list[0].payload == null && !(list[0].channels || []).length, 'and carrying no payload or channel to remember');
  const saved = await store.get(watchKey('rdu', 'PHL'), 'json');
  ok(Array.isArray(saved.lastEvent && saved.lastEvent.sent) && saved.lastEvent.sent.includes('push'), 'the watch records the delivery');
  eq(saved.lastEvent.kind, 'departing', 'and records which event landed');
  eq(saved.announced.length, 1, 'only now does announced advance');
  ok(/^\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}$/.test(saved.announced[0]), 'announced keeps the same dep key shape as before');
  const status = await outboxStatus(store, 'rdu');
  eq(status.dead, 0, 'nothing is marked dead after a recovery');
  eq(status.pending, 0, 'and nothing is left pending');
}

// --- 3. TTL: a departing event past its departure is dropped, never retried -----
{
  const store = kv();
  const env = pushEnv(store);
  const stale = {
    key: 'departing|PHL|2026-11-08|19:30|31.27',
    kind: 'departing',
    dest: 'PHL',
    announce: '2026-11-08|19:30',
    payload: { title: 'GoWild soon: PHL', body: 'x', priority: 'high' },
    channels: ['push'],
    attempts: 1,
    nextAt: NOW - 60000,
    state: 'pending',
    expAt: NOW - 1000,
    lastReason: null,
  };
  await store.put(outboxKey('rdu'), JSON.stringify([stale]));
  let tried = 0;
  globalThis.fetch = async () => {
    tried += 1;
    return new Response('', { status: 200 });
  };
  const res = await sweepOutbox(env, 'rdu', NOW);
  eq(tried, 0, 'an expired departing event costs no provider request');
  eq(res.dropped, 1, 'it is reported as dropped');
  const list = await readOutbox(store, 'rdu');
  eq(list[0].state, 'dropped', 'and never retried');
  ok(/expired/i.test(list[0].lastReason || ''), 'the reason says the window passed');
}

// --- 4. a permanent 4xx is not retried into a loop ------------------------------
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  globalThis.fetch = http(400);
  await evaluateWatches(env, 'rdu', s, s, NOW);
  const list = await readOutbox(store, 'rdu');
  eq(list.length, 1, 'the event is recorded');
  eq(list[0].state, 'dead', 'a 400 kills it on the first attempt');
  eq(list[0].attempts, 1, 'without spending four more attempts');
  ok(/400/.test(list[0].lastReason || ''), 'and the reason names it');
}

// --- 5. no channel configured is not a delivery failure ------------------------
// buildRequests drops an unconfigured channel, so `deliver` returns sent=[] and
// failed=[] with nothing to retry. That must not become a 522-shaped outage on the
// board: there is nothing to retry and no provider that failed.
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = { BOARD: store };
  await evaluateWatches(env, 'rdu', s, s, NOW);
  const status = await outboxStatus(store, 'rdu');
  eq(status.dead, 0, 'an unconfigured channel is not a dead delivery');
  eq(status.pending, 0, 'and is not queued forever');
}

// --- 6. stress: the last allowed attempt can still succeed ---------------------
// MAX_ATTEMPTS is a ceiling on retries, not a promise that the fifth one fails.
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return new Response('', { status: call < MAX_ATTEMPTS ? 522 : 200 });
  };
  await evaluateWatches(env, 'rdu', s, s, NOW);
  let at = (await readOutbox(store, 'rdu'))[0].nextAt;
  for (let i = 2; i <= MAX_ATTEMPTS; i += 1) {
    const res = await sweepOutbox(env, 'rdu', at);
    if (res.delivered) break;
    const entry = (await readOutbox(store, 'rdu'))[0];
    at = entry ? entry.nextAt : at;
  }
  const left = await readOutbox(store, 'rdu');
  eq(left.length, 1, 'a success on the final permitted attempt is recorded as sent, not cleared');
  eq(left[0].state, 'sent', 'with the state the log renders');
  const saved = await store.get(watchKey('rdu', 'PHL'), 'json');
  eq(saved.announced.length, 1, 'and advances announced exactly once');
}

// --- 7. stress: a network throw is retryable, not permanent -------------------
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  globalThis.fetch = async () => {
    throw new Error('socket hang up');
  };
  await evaluateWatches(env, 'rdu', s, s, NOW);
  const list = await readOutbox(store, 'rdu');
  eq(list[0].state, 'pending', 'a network error is retried');
  ok(/socket hang up/.test(list[0].lastReason || ''), 'and the reason survives');
}

// --- 8. stress: the watch can vanish between enqueue and delivery -------------
// Un-watching while an event is queued must not throw, must not resurrect the
// record, and must not leave a phantom pending entry forever.
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  globalThis.fetch = http(522);
  await evaluateWatches(env, 'rdu', s, s, NOW);
  const queuedNow = await readOutbox(store, 'rdu');
  eq(queuedNow.length, 1, 'the event is pending after a failed attempt');
  await store.delete(watchKey('rdu', 'PHL'));
  let at = (await readOutbox(store, 'rdu'))[0].nextAt;
  globalThis.fetch = http(200);
  const res = await sweepOutbox(env, 'rdu', at);
  eq(res.delivered, 1, 'delivery still counts as delivered');
  const left = await readOutbox(store, 'rdu');
  eq(left.length, 1, 'and the entry is recorded even with no watch record to stamp');
  eq(left[0].state, 'sent', 'as sent rather than pending');
  eq(await store.get(watchKey('rdu', 'PHL'), 'json'), null, 'no watch is resurrected by a late delivery');
  ok(at > 0, 'the retry time was real');
}

// --- 9. stress: only due entries are attempted --------------------------------
{
  const store = kv();
  const env = pushEnv(store);
  const base = { kind: 'available', dest: 'PHL', announce: null, payload: { title: 't', body: 'b', priority: 'high' }, channels: ['push'], attempts: 0, state: 'pending', expAt: NOW + 86400000, lastReason: null };
  await store.put(outboxKey('rdu'), JSON.stringify([
    { ...base, key: 'due|1', nextAt: NOW - 1 },
    { ...base, key: 'later|1', nextAt: NOW + 60000 },
  ]));
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    return new Response('', { status: 522 });
  };
  const res = await sweepOutbox(env, 'rdu', NOW);
  eq(res.attempted, 1, 'a backoff that has not elapsed costs nothing');
  eq(hits, 1, 'and one provider request, not two');
  const list = await readOutbox(store, 'rdu');
  eq(list.find((e) => e.key === 'later|1').attempts, 0, 'the future entry is untouched');
  eq(list.find((e) => e.key === 'due|1').attempts, 1, 'the due entry advanced');
}

// --- 10. stress: random provider outcomes stay bounded -------------------------
// Whatever the provider does, an entry must end delivered, dead or dropped, inside
// MAX_ATTEMPTS -- never pending forever, never attempted past the ceiling.
{
  const statuses = [200, 400, 408, 429, 500, 502, 522, 0];
  for (let seed = 0; seed < 24; seed += 1) {
    const store = kv();
    const env = pushEnv(store);
    const entry = {
      key: `fuzz|${seed}`,
      kind: 'cheaper',
      dest: 'MCO',
      announce: null,
      payload: { title: 't', body: 'b', priority: 'default' },
      channels: ['push'],
      attempts: 0,
      nextAt: NOW,
      state: 'pending',
      expAt: NOW + 86400000,
      lastReason: null,
    };
    await store.put(outboxKey('rdu'), JSON.stringify([entry]));
    let n = seed;
    globalThis.fetch = async () => {
      n = (n * 7 + 3) % statuses.length;
      const code = statuses[n];
      if (code === 0) throw new Error('network down');
      return new Response('', { status: code });
    };
    let at = NOW;
    for (let step = 0; step < MAX_ATTEMPTS * 2; step += 1) {
      await sweepOutbox(env, 'rdu', at);
      const cur = (await readOutbox(store, 'rdu'))[0];
      if (!cur || cur.state !== 'pending') break;
      ok(cur.attempts <= MAX_ATTEMPTS, 'fuzz: an entry never exceeds the attempt ceiling');
      at = Number(cur.nextAt) || at + 60000;
    }
    const end = (await readOutbox(store, 'rdu'))[0];
    ok(!end || end.state !== 'pending', 'fuzz: every entry reaches a terminal state');
  }
}

// --- 11. a pending failure is stated, not silent -------------------------------
// Measured 2026-11-13: an always-watch on PHL was armed 2.7 min before an ingest. The
// event WAS planned on that first ingest and ntfy.sh answered HTTP 429, so the entry
// sat `pending` with `lastReason: "push: HTTP 429"` for over half an hour while
// /api/watch showed `lastEvent: null` and the page showed nothing at all. Both of
// those were individually correct -- `lastEvent` may only advance after a 2xx, and a
// pending entry is not a dead one -- and together they made a ringing bell
// indistinguishable from a watch that never fired.
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  globalThis.fetch = async () => new Response('', { status: 429 });
  await evaluateWatches(env, 'rdu', s, s, NOW);

  const list = await readOutbox(store, 'rdu');
  eq(list.length, 1, 'a 429 holds the event instead of losing it');
  eq(list[0].state, 'pending', 'and a 429 is retryable, so it stays pending');
  ok(/429/.test(list[0].lastReason || ''), 'the outbox records the provider status');

  const saved = await store.get(watchKey('rdu', 'PHL'), 'json');
  eq(saved.lastEvent, null, 'lastEvent still waits for a 2xx');

  const status = await outboxStatus(store, 'rdu');
  eq(status.pending, 1, 'the status counts the pending delivery');
  ok(/429/.test(status.pendingReason || ''), 'and states why it has not arrived yet');
  ok(Number(status.nextAttemptAt) > NOW, 'and when the next attempt is due');
  eq(status.lastReason, null, 'a pending failure is never reported as a dead one');

  const view = buildBoard(s, NOW);
  const page = renderPage(view, s, [], NOW, {
    basePath: '/s/abcdefgh1234',
    origin: 'RDU',
    canWatch: true,
    watches: [saved],
    channels: { push: { ready: true } },
    outbox: status,
  });
  ok(/delivery retrying/i.test(page), 'the board says a delivery is retrying');
  ok(/429/.test(page), 'and names the provider status before the event dies');
  ok(!/gowild-abc/.test(page), 'without putting the topic on the page');
}

// A correctly expired `departing` event is the system working, so its reason must
// never be printed under "could not be delivered". Found in the pixel review on
// 2026-11-12: the dead banner quoted "departure passed" from a dropped tombstone.
{
  const deadEntry = {
    key: 'k1',
    kind: 'soldout',
    dest: 'PHL',
    payload: { title: 'PHL sold out' },
    channels: ['push'],
    attempts: MAX_ATTEMPTS,
    state: 'dead',
    createdAt: NOW - 7200000,
    deadAt: NOW - 3000000,
    lastReason: 'push: HTTP 522',
  };
  const expired = {
    key: 'k2',
    kind: 'departing',
    dest: 'DEN',
    payload: { title: 'DEN departing' },
    channels: ['push'],
    attempts: 1,
    state: 'dropped',
    createdAt: NOW - 7000000,
    deadAt: NOW - 600000,
    lastReason: 'departure passed',
  };
  const store = { get: async () => [deadEntry, expired], put: async () => {} };
  const status = await outboxStatus(store, 'rdu', NOW);
  eq(status.lastReason, 'push: HTTP 522', 'the dead banner quotes a dead event, not an expired one');
  eq(status.dead, 1, 'one dead event');
  eq(status.recent.length, 2, 'both events are in the page alert log');
  const deadRow = status.recent.find((e) => e.state === 'dead');
  ok(deadRow && !('payload' in deadRow) && !('channels' in deadRow), 'the log carries no push payload or topic');
}

// --- 12. every event carries its own front door --------------------------------
// Task A / Phase A. A tap must land on the board (token-free), and the board must
// offer a Frontier SEARCH link -- never a checkout, and never anything carrying the
// board token. The focus key is the outbox key verbatim, because that is what the
// page's reader already looks up.
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  globalThis.fetch = async () => new Response('', { status: 500 }); // held, so it survives planning
  await evaluateWatches(env, 'rdu', s, s, NOW);

  const list = await readOutbox(store, 'rdu');
  eq(list.length, 1, 'the event is held for inspection');
  const e = list[0];
  ok(/^https:\/\/booking\.flyfrontier\.com\/Flight\/Select\?/.test(e.bookingUrl || ''), 'the entry stores its Frontier search link');
  ok(/\bd1=PHL\b/.test(e.bookingUrl || ''), 'carrying the destination');
  ok(/dd1=Nov%20/.test(e.bookingUrl || ''), 'and the date in Frontier\'s own param shape');
  ok(/^\/rdu\?focus=/.test(e.focusPath || ''), 'the entry stores a token-free focus path');
  eq(decodeURIComponent(String(e.focusPath).split('focus=')[1] || ''), e.key, 'the focus key is the outbox key verbatim');
  ok(!/token/i.test(String(e.bookingUrl) + String(e.focusPath)), 'neither link carries a secret');
}

// --- 13. a delivered event stays in the log -----------------------------------
// Measured 2026-11-13: the CLE departing push was delivered and acknowledged, and the
// UPDATES block was empty -- because a sent entry was deleted from the outbox the
// moment it succeeded. The reader could not see what had rung, and a tap had nothing
// to land on.
{
  const store = kv();
  const s = await armedWatch(store, NOW - 60000);
  const env = pushEnv(store);
  globalThis.fetch = async () => new Response('', { status: 201 });
  await evaluateWatches(env, 'rdu', s, s, NOW);
  const list = await readOutbox(store, 'rdu');
  eq(list.length, 1, 'a delivered event is remembered, not deleted');
  eq(list[0].state, 'sent', 'with its delivered state');
  ok(Number(list[0].deliveredAt) === NOW, 'and when it was delivered');
  ok(!('payload' in list[0]) || list[0].payload == null, 'without keeping the rendered payload for a week');
  const status = await outboxStatus(store, 'rdu', NOW);
  eq(status.recent.length, 1, 'so the page log can show it');
  eq(status.pending, 0, 'while nothing is left pending');
}

globalThis.fetch = realFetch;
console.log(`outbox: ${checks} checks passed`);
