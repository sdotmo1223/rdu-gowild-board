// The app's push channel has failure modes ntfy never had, and the outbox was tuned
// for ntfy's (429 / 522 -- "try again later"). Chrome's are different in kind:
//
//   1. 410 Gone is permanent. The device uninstalled or cleared its subscription, and
//      the only honest response is to forget it -- retrying five times would report a
//      device fact as an outage.
//   2. A payload Chrome cannot decrypt is dropped WITHOUT an error. The push service
//      answers 201, the Worker records a delivery, and the phone shows nothing. That
//      is precisely the silent failure this project exists to make impossible, and it
//      cannot be detected from the Worker alone -- it needs the device to say "I got
//      something" so a delivery nobody acknowledged can be called what it is.
//
// So: a delivery log, an acknowledgement from the device, and a canary that raises
// exactly one health notice when a delivery goes unacknowledged past the threshold.
import assert from 'node:assert/strict';
import {
  sendToAll,
  listSubscriptions,
  recordSeen,
  readCanary,
  DELIVERY_KEY,
  SEEN_KEY,
  CANARY_GAP_MIN,
  PUSH_PREFIX,
} from '../src/push.mjs';
import { buildHealthNotice } from '../src/health.mjs';
import { VAPID, seedDevice } from './push-stub.mjs';

let checks = 0;
let failed = 0;
const ok = (cond, msg) => {
  checks += 1;
  if (!cond) {
    failed += 1;
    console.error(`FAIL: ${msg}`);
  }
};
const eq = (actual, expected, msg) => {
  checks += 1;
  try {
    assert.deepEqual(actual, expected);
  } catch {
    failed += 1;
    console.error(`FAIL: ${msg}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

// A KV shaped like the real binding, so these checks exercise the same code the Worker
// runs rather than a re-implementation of it.
function makeKV(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(key, type) {
      if (!map.has(key)) return null;
      const raw = map.get(key);
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const env = (kv) => ({ BOARD: kv, ...VAPID });
const realFetch = globalThis.fetch;
function withFetch(handler, fn) {
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = realFetch;
    });
}

const NOW = 1_800_000_000_000;

// --- 1. 410 Gone is a device fact, not an outage -------------------------------
{
  const kv = makeKV();
  await seedDevice(kv);
  const subs = await listSubscriptions(env(kv));
  eq(subs.length, 1, 'one device is enrolled before the send');
  const out = await withFetch(
    async () => new Response('', { status: 410 }),
    () => sendToAll(env(kv), subs, { title: 'x', body: 'y' }, NOW),
  );
  eq(out.failed.length, 1, 'a 410 is reported as a failed delivery');
  eq(
    await kv.get(`${PUSH_PREFIX}0`, 'json').catch(() => null),
    null,
    'and no tombstone record is invented for the removed device',
  );
  eq((await listSubscriptions(env(kv))).length, 0, 'a 410 removes the subscription instead of remembering it');
}

// --- 2. The delivery log the canary reads -------------------------------------
{
  const kv = makeKV();
  await seedDevice(kv);
  const subs = await listSubscriptions(env(kv));
  await withFetch(
    async () => new Response('', { status: 201 }),
    () => sendToAll(env(kv), subs, { title: 'x', body: 'y' }, NOW),
  );
  const logged = await kv.get(DELIVERY_KEY, 'json');
  ok(logged && Number(logged.at) === NOW, 'a successful send records when it was delivered');
  eq(Number(logged && logged.devices), 1, 'and how many devices took it');
}

// --- 3. The device's acknowledgement ------------------------------------------
{
  const kv = makeKV();
  eq((await recordSeen(env(kv), NOW, NOW)).ok, true, 'an acknowledgement is accepted');
  eq(Number((await kv.get(SEEN_KEY, 'json')).at), NOW, 'and stored as the last seen timestamp');
  const older = await recordSeen(env(kv), NOW - 60_000, NOW);
  eq(Number((await kv.get(SEEN_KEY, 'json')).at), NOW, 'an older acknowledgement never moves the clock backwards');
  eq(older.stale, true, 'and says so');
  const future = await recordSeen(env(kv), NOW + 3600_000, NOW);
  eq(future.ok, false, 'a timestamp from the future is refused');
}

// --- 4. What the canary says ---------------------------------------------------
{
  const empty = await readCanary(env(makeKV()), NOW);
  eq(empty.state, 'unknown', 'with no delivery yet the canary claims nothing');

  const kv = makeKV({ [DELIVERY_KEY]: JSON.stringify({ at: NOW - 5 * 60_000, devices: 1 }) });
  const waiting = await readCanary(env(kv), NOW);
  eq(waiting.state, 'waiting', 'a delivery inside the threshold is waiting, not a gap');

  await recordSeen(env(kv), NOW - 5 * 60_000 + 2000, NOW);
  const good = await readCanary(env(kv), NOW);
  eq(good.state, 'ok', 'a delivery the device confirmed is ok');

  const gapKV = makeKV({
    [DELIVERY_KEY]: JSON.stringify({ at: NOW - 45 * 60_000, devices: 1 }),
    [SEEN_KEY]: JSON.stringify({ at: NOW - 90 * 60_000 }),
  });
  const gap = await readCanary(env(gapKV), NOW);
  eq(gap.state, 'gap', 'a delivery nobody acknowledged past the threshold is a gap');
  ok(Number(gap.gapMin) >= CANARY_GAP_MIN, `the gap is reported in minutes (got ${gap.gapMin})`);
}

// --- 5. And it reaches a human, once -----------------------------------------
{
  const signal = { pending: 0, dead: 0, degraded: false, link: 'ok', canary: { state: 'gap', gapMin: 45 } };
  const first = buildHealthNotice(signal, null, NOW);
  ok(first !== null, 'a canary gap raises a health notice');
  ok(first && /acked|acknowledg/i.test(first.message), 'and says the app never acknowledged a push');
  const fp = first && first.fingerprint;
  eq(buildHealthNotice(signal, fp, NOW), null, 'the same gap is silent on the next tick');

  const fine = { pending: 0, dead: 0, degraded: false, link: 'ok', canary: { state: 'ok' } };
  eq(buildHealthNotice(fine, null, NOW), null, 'a confirmed delivery raises nothing');
  const waiting = { pending: 0, dead: 0, degraded: false, link: 'ok', canary: { state: 'waiting' } };
  eq(buildHealthNotice(waiting, null, NOW), null, 'and neither does one still inside the threshold');
}

console.log(`push: ${checks} checks, ${failed} failed`);
if (failed) process.exit(1);
