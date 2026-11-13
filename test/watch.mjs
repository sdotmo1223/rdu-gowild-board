// Watches: a bell is a promise, so the things that decide whether a person hears
// anything are tested here -- the request, the transition, the dedupe, the channel
// that is not configured, and the page that must not offer a bell where a watch
// could not be honoured.
import assert from 'node:assert/strict';
import { buildBoard, MAX_ROW_AGE_MIN } from '../src/board.js';
import { easternDate } from '../src/routes.js';
import { renderPage } from '../src/render.js';
import {
  CHANNELS,
  DEPARTING_SOON_MIN,
  WATCH_REPEAT_MS,
  buildRequests,
  channelStatus,
  deliver,
  describeEvent,
  emailRequest,
  evaluateWatches,
  normalizeWatch,
  observe,
  planWatch,
  appPushPayload,
  shouldNotify,
  textRequest,
  watchKey,
} from '../src/watch.mjs';
import { readOutbox } from '../src/outbox.mjs';
import { VAPID, SUBSCRIPTION, seedDevice, decryptPayload } from './push-stub.mjs';
import { encryptPayload } from '../src/push.mjs';
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

const NOW = Date.UTC(2026, 10, 8, 12, 0); // 07:00 ET, Sun 8 Nov 2026
const D0 = '2026-11-08';
const D1 = '2026-11-09';

const fl = (o = {}) => {
  const date = o.date || D0;
  return {
    date,
    dest: o.dest || 'PHL',
    city: 'Philadelphia',
    dep: `${date} ${o.dep || '19:30'}:00`,
    arr: `${date} ${o.arr || '21:12'}:00`,
    stops: o.stops || 'Nonstop',
    nonstop: !o.stops,
    dur: o.dur || '1 hrs 42 min',
    seats: o.seats === undefined ? 3 : o.seats,
    allin: o.allin === undefined ? 31.27 : o.allin,
    goWild: true,
  };
};

function snap(flights, o = {}) {
  const covAt = o.covAt === undefined ? NOW : o.covAt;
  const dates = [...new Set(flights.map((f) => f.date))];
  if (!dates.length) dates.push(o.date || D0);
  const sweeps = [];
  for (const d of dates) {
    sweeps.push({ date: d, dest: 'PHL', ok: true, blocked: false, at: covAt, flights: flights.filter((f) => f.dest === 'PHL' && f.date === d) });
    sweeps.push({ date: d, dest: 'MCO', ok: true, blocked: false, at: covAt, flights: [] });
  }
  return { updatedAt: o.at === undefined ? NOW : o.at, routeCount: 2, sweeps, coverage: { PHL: { lastOkAt: covAt }, MCO: { lastOkAt: covAt } } };
}

const watch = (o = {}) => ({ dest: 'PHL', mode: 'date', date: D0, channels: ['push'], announced: [], lastEvent: null, ...o });

// --- the request ------------------------------------------------------------
eq(normalizeWatch({ dest: 'phl', date: D0, channels: ['push'] }, NOW).watch.dest, 'PHL', 'a lower-case code is normalised, not refused');
ok(normalizeWatch({ dest: 'P', date: D0, channels: ['push'] }, NOW).ok === false, 'a one-letter code is refused');
ok(normalizeWatch({ dest: 'PHL', mode: 'date', channels: ['push'] }, NOW).ok === false, 'a date watch without a date is refused');
ok(normalizeWatch({ dest: 'PHL', mode: 'always', channels: ['push'] }, NOW).ok === true, '"until further notice" needs no date');
ok(normalizeWatch({ dest: 'PHL', date: D0, channels: [] }, NOW).ok === false, 'a watch with no channel is refused: nobody would hear it');
ok(normalizeWatch({ dest: 'PHL', date: 'Nov 8', channels: ['push'] }, NOW).ok === false, 'a human date is refused rather than guessed');
ok(normalizeWatch({ dest: 'PHL', date: D0, channels: ['push', 'carrier-pigeon'] }, NOW).watch.channels.join() === 'push', 'unknown channels are dropped, never invented');
ok(normalizeWatch({ dest: 'WIL', date: D0, channels: ['push'] }, NOW, ['PHL', 'MCO']).ok === false, 'a code this profile does not serve is refused');
ok(normalizeWatch({ dest: 'PHL', date: D0, channels: ['push'] }, NOW, ['PHL']).ok === true, 'a served code is accepted');
eq(normalizeWatch({ dest: 'PHL', date: D0, channels: ['push'] }, NOW).watch.mode, 'date', 'the default scope is that date');
eq(watchKey('rdu', 'phl'), 'w:rdu:PHL', 'one key per destination, so two edits cannot clobber each other');

// --- channels that are not configured must say so ---------------------------
const bare = channelStatus({});
ok(CHANNELS.every((c) => bare[c].ready === false), 'no configuration means no channel claims to be ready');
ok(/VAPID/.test(bare.push.reason), 'the push reason names the keys to set, not a third-party topic');
ok(/RESEND_API_KEY/.test(bare.email.reason), 'the email reason names the first missing variable');
ok(/TWILIO_ACCOUNT_SID/.test(bare.text.reason), 'the text reason names the first missing variable');
ok(!/secret-value/.test(JSON.stringify(bare)), 'a reason never contains a value');
const full = channelStatus({
  ...VAPID,
  RESEND_API_KEY: 're_123',
  ALERT_EMAIL: 'me@example.com',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_FROM: '+15550000000',
  ALERT_PHONE: '+15551111111',
});
ok(CHANNELS.every((c) => full[c].ready === true), 'every channel is ready when its variables exist');
ok(channelStatus({ VAPID_PUBLIC: 'only-half' }).push.ready === false, 'half a keypair is not a channel');
ok(channelStatus({ RESEND_API_KEY: 're_1' }).email.ready === false, 'half an email configuration is not configured');

// --- observation ------------------------------------------------------------
const oneRow = snap([fl()]);
const view1 = buildBoard(oneRow, NOW);
const obs1 = observe(view1, oneRow, watch(), NOW);
eq(obs1.rows.length, 1, 'the observation sees the watched destination');
eq(obs1.cheapest, 31.27, 'the cheapest watched fare is recorded');
ok(obs1.stale === false, 'a route answered minutes ago is evidence');

const bothDates = snap([fl(), fl({ date: D1 })]);
const always = watch({ mode: 'always', date: null });
eq(observe(buildBoard(bothDates, NOW), bothDates, always, NOW).rows.length, 2, '"until further notice" spans both dates');
eq(observe(buildBoard(bothDates, NOW), bothDates, watch(), NOW).rows.length, 1, 'a date watch sees only its date');

const oldCov = snap([fl()], { covAt: NOW - (MAX_ROW_AGE_MIN + 60) * 60000 });
const staleObs = observe(buildBoard(oldCov, NOW), oldCov, watch(), NOW);
ok(staleObs.stale === true, 'a route older than the ceiling is not evidence');
eq(staleObs.sig, 'stale', 'a stale observation has no comparable signature');

const noLedger = snap([fl()]);
delete noLedger.coverage;
ok(observe(buildBoard(noLedger, NOW), noLedger, watch(), NOW).stale === true, 'no coverage ledger means no claim');

// --- transitions ------------------------------------------------------------
const empty = snap([]);
const evOpen = planWatch(observe(buildBoard(empty, NOW), empty, watch(), NOW), obs1, watch(), NOW).events;
eq(evOpen.length, 1, 'nothing -> something is one event');
eq(evOpen[0].kind, 'available', 'and it is called available');

const evGone = planWatch(obs1, observe(buildBoard(empty, NOW), empty, watch(), NOW), watch(), NOW).events;
eq(evGone.length, 1, 'something -> nothing is one event');
eq(evGone[0].kind, 'soldout', 'and it is called sold out');

// A row that leaves the list because the plane left is not a sold-out seat. The
// board drops departures that have pushed back, so this distinction is load-bearing.
const flewPrev = {
  sig: 'gone',
  rows: [{ date: D0, dep: `${D0} 06:30:00`, allin: 31.27, seats: 3 }],
  cheapest: 31.27,
  stale: false,
  at: NOW - 3600000,
};
const flewNext = observe(buildBoard(empty, NOW), empty, watch(), NOW);
const evFlew = planWatch(flewPrev, flewNext, watch(), NOW).events;
eq(evFlew.length, 1, 'a watched departure that has gone is one event');
eq(evFlew[0].kind, 'departed', 'and it is called departed, not sold out');
ok(!/sold out|repriced/i.test(describeEvent(evFlew[0], 'RDU').body), 'the copy does not claim seats sold');

const same = planWatch(obs1, obs1, watch(), NOW).events;
eq(same.length, 0, 'an unchanged board sends nothing');

const cheap = snap([fl({ allin: 24.9 })]);
const evCheap = planWatch(obs1, observe(buildBoard(cheap, NOW), cheap, watch(), NOW), watch(), NOW).events;
eq(evCheap.length, 1, 'a fare that drops a dollar is news');
eq(evCheap[0].kind, 'cheaper', 'and it is called cheaper');

const dear = snap([fl({ allin: 31.28 })]);
eq(planWatch(obs1, observe(buildBoard(dear, NOW), dear, watch(), NOW), watch(), NOW).events.length, 0, 'a fare rounding up one cent is not news');

const staleNext = observe(buildBoard(oldCov, NOW), oldCov, watch(), NOW);
eq(planWatch(obs1, staleNext, watch(), NOW).events.length, 0, 'a stale reading cannot prove a seat disappeared');

// A departure close enough to catch is its own event, once per departure.
const soon = snap([fl({ dep: '09:30' })]);
const soonView = buildBoard(soon, NOW);
const soonObs = observe(soonView, soon, watch(), NOW);
const p1 = planWatch(null, soonObs, watch(), NOW);
ok(p1.events.some((e) => e.kind === 'departing'), 'a departure inside the window is announced');
eq(p1.announced.length, 1, 'and remembered so it is announced once');
const p2 = planWatch(null, soonObs, watch({ announced: p1.announced }), NOW + 5 * 60000);
eq(p2.events.filter((e) => e.kind === 'departing').length, 0, 'the same departure is not announced again five minutes later');
ok(DEPARTING_SOON_MIN <= 240, 'the window stays inside the 3h freshness ceiling');

const far = snap([fl({ dep: '22:00' })]);
eq(
  planWatch(null, observe(buildBoard(far, NOW), far, watch(), NOW), watch(), NOW).events.filter((e) => e.kind === 'departing').length,
  0,
  'a departure ten hours out is not "soon"',
);

// Dedupe: same event, same departure, six hours.
const ev = { kind: 'soldout', key: 'soldout|PHL|2026-11-08|19:30|31.27' };
ok(shouldNotify(watch(), ev, NOW) === true, 'a first event always notifies');
const fired = watch({ lastEvent: { kind: ev.kind, key: ev.key, at: NOW } });
ok(shouldNotify(fired, ev, NOW + 60000) === false, 'the same event is silent a minute later');
ok(shouldNotify(fired, ev, NOW + WATCH_REPEAT_MS + 1) === true, 'and re-fires after six hours');
ok(shouldNotify(fired, { ...ev, kind: 'available' }, NOW + 60000) === true, 'a different event is never swallowed');

// --- copy -------------------------------------------------------------------
const openMsg = describeEvent({ kind: 'available', dest: 'PHL', date: D0, dep: `${D0} 19:30:00`, allin: 31.27, count: 1 }, 'RDU');
ok(/PHL/.test(openMsg.title) && /Nov 8/.test(openMsg.title), 'the title names the route and the date');
ok(/estimated all-in|est\. all-in/.test(openMsg.body), 'the copy keeps the price labelled estimated');
ok(!/verified/i.test(openMsg.body), 'no notification ever calls a fare verified');
const soldMsg = describeEvent({ kind: 'soldout', dest: 'PHL', date: D0, count: 0 }, 'RDU');
ok(/sold out|above \$50/.test(soldMsg.body), 'a departure that is still ahead but empty is reported as sold out');
const goneMsg = describeEvent({ kind: 'soldout', dest: 'PHL', date: D0, count: 0 }, 'RDU');
ok(/sold out|above \$50/.test(goneMsg.body), 'the sold-out copy says what actually happened to the option');
ok(goneMsg.body.indexOf('\n') !== -1, 'the body uses real newlines');
ok(goneMsg.body.indexOf('\\n') === -1, 'and never a literal backslash-n');

// --- delivery payloads ------------------------------------------------------
const env = {
  NTFY_TOPIC: 'gowild-abc',
  RESEND_API_KEY: 're_key',
  ALERT_EMAIL: 'me@example.com',
  ALERT_FROM: 'Board <board@example.com>',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'twtok',
  TWILIO_FROM: '+15550000000',
  ALERT_PHONE: '+15551111111',
};
const alert = { title: 'GoWild open: PHL Nov 8', body: 'Body', priority: 'high', dest: 'PHL', key: '2026-11-08|10:12|PHL' };
// Push is no longer a plain request to a provider: it is one encrypted message per
// enrolled device. What is asserted here is the payload the app renders and the link
// the tap follows, not an HTTP header.
const payload = appPushPayload({ ...env, BOARD_TOKEN: 'tok12345678' }, alert);
ok(/^\/s\/tok12345678\?focus=/.test(payload.url), 'the tap links to the board at this event');
ok(decodeURIComponent(payload.url).indexOf('2026-11-08|10:12|PHL') > 0, 'the focus key is the event, not a guess');
ok(appPushPayload(env, alert).url === '/rdu', 'without a token the link stays on the public board');
ok(
  appPushPayload(env, { ...alert, clickPath: '/s/tok12345678?focus=stored-key' }).url === '/s/tok12345678?focus=stored-key',
  'a link stored at enqueue time wins, so a retried delivery still opens its own row',
);
ok(payload.tag === 'gowild-PHL', 'the tag collapses repeat notices for one destination');
ok(payload.urgency === 'high', 'a high-priority alert rides as a high-urgency push');
ok(payload.title === alert.title && payload.body === alert.body, 'the title and body are the alert\u2019s own');

const email = emailRequest(env, alert);
ok(email.url === 'https://api.resend.com/emails', 'email uses the provider endpoint');
ok(/^Bearer re_key$/.test(email.init.headers.Authorization), 'the email key is a bearer header');
ok(!/re_key/.test(email.url), 'the email key is never in a URL');
const emailBody = JSON.parse(email.init.body);
eq(emailBody.to[0], 'me@example.com', 'email goes to the configured address');
ok(/board@example.com/.test(emailBody.from), 'the sender is the configured one');
ok(typeof emailBody.text === 'string' && emailBody.text.length > 0, 'the email carries a text body');

const text = textRequest(env, alert);
ok(/Accounts\/AC123\/Messages\.json$/.test(text.url), 'text uses the account path');
ok(/^Basic /.test(text.init.headers.Authorization), 'text authenticates with basic auth');
const form = new URLSearchParams(text.init.body);
eq(form.get('To'), '+15551111111', 'text goes to the configured phone');
eq(form.get('From'), '+15550000000', 'text comes from the configured number');
ok(Buffer.from(text.init.headers.Authorization.slice(6), 'base64').toString() === 'AC123:twtok', 'the basic auth pair is the account and token');
ok(!/twtok/.test(text.url) && !/twtok/.test(text.init.body), 'the auth token never appears in the URL or body');
ok(textRequest({ ...env, ALERT_PHONE: '' }, alert) === null, 'half a text configuration builds no request');

eq(buildRequests(env, alert, ['push']).length, 0, 'push is not a plain request any more: it is built per device');
eq(buildRequests(env, alert, ['email']).length, 1, 'only the requested channel is built');
eq(buildRequests({ NTFY_TOPIC: 'gowild-abc' }, alert, ['push', 'email', 'text']).length, 0, 'an unconfigured channel is skipped, not attempted');
eq(buildRequests(env, alert, []).length, 0, 'no channels means no requests');

// --- delivery never throws --------------------------------------------------
const realFetch = globalThis.fetch;
let seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), init });
  return new Response('ok', { status: 200 });
};
const devStore = kv();
await seedDevice(devStore);
const pushEnv = { ...env, ...VAPID, BOARD: devStore };
const delivered = await deliver(pushEnv, alert, ['push', 'email']);
eq(delivered.sent.length, 2, 'two configured channels both send');
eq(delivered.failed.length, 0, 'and none fail');
const pushCall = seen.find((r) => /fcm\.googleapis\.com/.test(r.url));
ok(Boolean(pushCall), 'the push goes to the enrolled device endpoint');
eq(pushCall.init.headers['Content-Encoding'], 'aes128gcm', 'and it is an encrypted body, not a provider form');
ok(!Buffer.from(pushCall.init.body).toString('latin1').includes('GoWild open'), 'the title is not readable on the wire');
const decoded = await decryptPayload(pushCall.init.body);
eq(decoded.title, alert.title, 'the device receives the alert\u2019s own title');
ok(decoded.url.startsWith('/'), 'and a path the app can open');
globalThis.fetch = async () => {
  throw new Error('network down');
};
const broke = await deliver(pushEnv, alert, ['push']);
eq(broke.sent.length, 0, 'a dead provider sends nothing');
eq(broke.failed.length, 1, 'but says which channel failed');
ok(/network down/.test(broke.failed[0].reason), 'the reason is reported, not swallowed');
globalThis.fetch = realFetch;

// --- storage and end-to-end evaluation --------------------------------------
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

const store = kv();
const cfgEnv = { BOARD: store, ...VAPID };
await seedDevice(store);
await store.put(watchKey('rdu', 'PHL'), JSON.stringify(watch()));

seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), init });
  return new Response('ok', { status: 200 });
};
const run1 = await evaluateWatches(cfgEnv, 'rdu', null, oneRow, NOW);
eq(run1.watched, 1, 'the stored watch is evaluated');
// The first sweep after arming sets the baseline: alerting about a seat that was
// already on the page when the bell was pressed is noise, not news.
eq(seen.length, 0, 'the first evaluation stores a baseline instead of alerting');
const saved1 = await store.get(watchKey('rdu', 'PHL'), 'json');
ok(saved1.last && saved1.last.sig.length > 0, 'the observation is stored, so the next run has a baseline');
ok(saved1.lastEvent === null, 'no event is invented for the first look');

seen = [];
await evaluateWatches(cfgEnv, 'rdu', null, oneRow, NOW + 60000);
eq(seen.length, 0, 'the same board a minute later sends nothing');

const goneSnap = snap([]);
seen = [];
await evaluateWatches(cfgEnv, 'rdu', oneRow, goneSnap, NOW + 120000);
eq(seen.length, 1, 'a destination that vanishes is reported');
{
  const body = await decryptPayload(seen[0].init.body);
  ok(/gone/i.test(body.title), 'and the push says it is gone');
}

// Armed on an empty route, then seats appear: that is the promise the bell makes.
const store3 = kv();
const emptySnap = snap([]);
const armedEmpty = watch({ last: observe(buildBoard(emptySnap, NOW), emptySnap, watch(), NOW) });
await store3.put(watchKey('rdu', 'PHL'), JSON.stringify(armedEmpty));
seen = [];
await seedDevice(store3);
await evaluateWatches({ BOARD: store3, ...VAPID }, 'rdu', emptySnap, oneRow, NOW + 120000);
eq(seen.length, 1, 'a watch armed on nothing is told when seats appear');
{
  const body = await decryptPayload(seen[0].init.body);
  ok(/open/i.test(body.title), 'and the push says the route opened');
}
ok(/fcm\.googleapis\.com/.test(seen[0].url), 'delivered by the app to its own device');

// A provider that is down must not stop the record being kept.
globalThis.fetch = async () => {
  throw new Error('provider down');
};
const store2 = kv();
const baseline = observe(buildBoard(oneRow, NOW), oneRow, watch(), NOW);
await store2.put(watchKey('rdu', 'PHL'), JSON.stringify(watch({ last: baseline })));
await seedDevice(store2);
const failedRun = await evaluateWatches({ BOARD: store2, ...VAPID }, 'rdu', oneRow, goneSnap, NOW + 180000);
ok(failedRun !== null, 'evaluation returns instead of throwing');
const saved2 = await store2.get(watchKey('rdu', 'PHL'), 'json');
// RANK 2 changed where a failure lives: it is no longer stamped on the watch as if
// it had been sent, it is held in the outbox and retried.
ok(saved2.lastEvent === null, 'a failed delivery is not recorded as if it had been sent');
const held = await readOutbox(store2, 'rdu');
ok(held.length === 1 && held[0].state === 'pending' && held[0].attempts === 1, 'the failure is held in the outbox for a retry');
globalThis.fetch = realFetch;

// A profile with no watches costs nothing and does not touch the network.
seen = [];
const none = await evaluateWatches({ BOARD: kv(), NTFY_TOPIC: 'gowild-abc' }, 'rdu', null, oneRow, NOW);
eq(none.watched, 0, 'no watches means no work');
eq(seen.length, 0, 'and no notification');

// --- the endpoint -----------------------------------------------------------
const apiStore = kv();
const apiEnv = { BOARD: apiStore, BOARD_TOKEN: 'tok-abcdefgh', NTFY_TOPIC: 'gowild-abc' };
const post = (body, token) =>
  new Request('https://b.test/api/watch', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const denied = await worker.fetch(post({ dest: 'PHL', date: D0, channels: ['push'] }), apiEnv, {});
eq(denied.status, 401, 'an anonymous watch is refused');

const wrong = await worker.fetch(post({ dest: 'PHL', date: D0, channels: ['push'] }, 'nope'), apiEnv, {});
eq(wrong.status, 401, 'a wrong token is refused');

const accepted = await worker.fetch(post({ dest: 'phl', date: D0, channels: ['push'] }, 'tok-abcdefgh'), apiEnv, {});
eq(accepted.status, 200, 'the board token may arm a watch');
const acceptedBody = await accepted.json();
ok(acceptedBody.ok === true, 'the response says it worked');
eq(acceptedBody.watch.dest, 'PHL', 'and returns the normalised record');
ok(apiStore._m.has('w:rdu:PHL'), 'the watch is stored under its own key');

const listed = await worker.fetch(
  new Request('https://b.test/api/watch', { headers: { Authorization: 'Bearer tok-abcdefgh' } }),
  apiEnv,
  {},
);
const listedBody = await listed.json();
eq(listedBody.watches.length, 1, 'GET lists the watch');
eq(listedBody.canWatch, true, 'and says watching is possible here');

const badProfile = await worker.fetch(post({ dest: 'ZZZ', date: D0, channels: ['push'] }, 'tok-abcdefgh'), apiEnv, {});
eq(badProfile.status, 400, 'a code this profile does not serve is refused with a reason');

const removed = await worker.fetch(post({ dest: 'PHL', remove: true }, 'tok-abcdefgh'), apiEnv, {});
eq(removed.status, 200, 'a watch can be removed');
ok(!apiStore._m.has('w:rdu:PHL'), 'and leaving nothing behind');

// --- the ingest path is what actually fires a watch -------------------------
// The pieces above all work in isolation; this is the wiring the cron really hits.
// The handler reads the real clock, so this fixture is anchored to today rather
// than to the pinned NOW the pure checks use.
const RNOW = Date.now();
const TODAY = easternDate(0, RNOW);
const liveFlight = {
  date: TODAY,
  dest: 'PHL',
  city: 'Philadelphia',
  dep: `${TODAY} 23:59:00`,
  arr: `${TODAY} 23:58:00`,
  stops: 'Nonstop',
  nonstop: true,
  dur: '1 hrs 42 min',
  seats: 3,
  allin: 31.27,
  goWild: true,
};
const liveSnap = {
  updatedAt: RNOW,
  routeCount: 2,
  sweeps: [
    { date: TODAY, dest: 'PHL', ok: true, blocked: false, at: RNOW, flights: [liveFlight] },
    { date: TODAY, dest: 'MCO', ok: true, blocked: false, at: RNOW, flights: [] },
  ],
  coverage: { PHL: { lastOkAt: RNOW }, MCO: { lastOkAt: RNOW } },
};
const emptyLive = { ...liveSnap, sweeps: liveSnap.sweeps.map((s) => ({ ...s, flights: [] })) };
const todayWatch = watch({ date: TODAY });
const ingestStore = kv();
const baselineLive = observe(buildBoard(emptyLive, RNOW), emptyLive, todayWatch, RNOW);
await ingestStore.put(watchKey('rdu', 'PHL'), JSON.stringify({ ...todayWatch, last: baselineLive }));
const ingestEnv = {
  BOARD: ingestStore,
  BOARD_TOKEN: 'tok-abcdefgh',
  BOARD_WRITE_TOKEN: 'wtok-abcdefgh',
  ...VAPID,
};
await seedDevice(ingestStore);
let waited = null;
const ctx = { waitUntil: (p) => { waited = p; } };
seen = [];
// The provider-down check above restored the real fetch; re-stub it, or this test
// pushes to a live topic and then asserts against an empty array.
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), init });
  return new Response('ok', { status: 200 });
};
const ingest = await worker.fetch(
  new Request('https://b.test/api/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer wtok-abcdefgh', 'Content-Type': 'application/json' },
    body: JSON.stringify(liveSnap),
  }),
  ingestEnv,
  ctx,
);
eq(ingest.status, 200, 'the snapshot is accepted');
ok(waited && typeof waited.then === 'function', 'watch evaluation is scheduled off the response path');
await waited;
eq(seen.length, 1, 'and a snapshot landing reaches the push channel');
ok(/fcm\.googleapis\.com/.test(seen[0].url), 'on the app\u2019s own device endpoint');
const ingestPush = await decryptPayload(seen[0].init.body);
ok(/open/i.test(ingestPush.title), 'and the notification it renders is the event that fired');
const ingestSaved = await ingestStore.get(watchKey('rdu', 'PHL'), 'json');
eq(ingestSaved.lastEvent.kind, 'available', 'the event is recorded against the watch');

// A refused snapshot must not fire anything: no write, no notification.
seen = [];
const refused = await worker.fetch(
  new Request('https://b.test/api/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer wtok-abcdefgh', 'Content-Type': 'application/json' },
    body: JSON.stringify({ updatedAt: NOW, sweeps: [{ date: D0, dest: 'PHL', ok: false, blocked: true, flights: [] }] }),
  }),
  ingestEnv,
  { waitUntil() {} },
);
eq(refused.status, 409, 'a failed sweep is still refused at the write boundary');
eq(seen.length, 0, 'and a refused sweep notifies nobody');
globalThis.fetch = realFetch;

// --- the page ---------------------------------------------------------------
const channels = { push: { ready: true }, email: { ready: false, reason: 'RESEND_API_KEY is not set on the Worker' }, text: { ready: false, reason: 'TWILIO_FROM is not set on the Worker' } };
const tokPage = renderPage(buildBoard(oneRow, NOW), oneRow, [], NOW, {
  basePath: '/s/abcdefgh1234',
  origin: 'RDU',
  canWatch: true,
  watches: [watch()],
  channels,
});
ok(tokPage.includes('class="act bell"'), 'a token page offers the bell');
ok(tokPage.includes('data-dest="PHL" data-date="2026-11-08" aria-pressed="true"'), 'the watched route renders as pressed');
ok(tokPage.includes('Watching'), 'and the row says so');
ok(/class="watchbar"/.test(tokPage), 'the watch strip is on the page');
ok(/alert channel is set up|Alerts: push/.test(tokPage), 'the strip names the channels that can deliver');
ok(tokPage.includes('window.__wcfg'), 'the sheet gets its configuration');
ok(!/re_key|twtok|tok-abcdefgh/.test(tokPage), 'no secret reaches the page');

const publicPage = renderPage(buildBoard(oneRow, NOW), oneRow, [], NOW, { basePath: '/rdu', origin: 'RDU', canWatch: false });
ok(!publicPage.includes('act bell'), 'a public page has no bell, because it has no token to arm one with');
ok(!/class="watchbar"/.test(publicPage), 'and no watch strip it cannot honour');
ok(publicPage.includes('class="act ics"'), 'the calendar button survives the redesign');

const offered = renderPage(buildBoard(oneRow, NOW), oneRow, [], NOW, {
  basePath: '/s/abcdefgh1234',
  origin: 'RDU',
  canWatch: true,
  watches: [],
  channels,
});
ok(/act bell/.test(offered), 'an unwatched token page still offers the bell');
ok(/class="act bell"[^>]*aria-pressed="false"/.test(offered), 'and it renders unpressed');
ok(!/class="act bell"[^>]*aria-pressed="true"/.test(offered), 'no route is marked watched when nothing is watched');
ok(/Tap <b>Watch<\/b>/.test(offered), 'and says what the bell will do');

// The emitted client script is generated code; parse it rather than trusting it.
const scripts = [...tokPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(scripts.length >= 1, 'the page ships a client script');
let parsed = true;
try {
  new Function(scripts[scripts.length - 1]);
} catch {
  parsed = false;
}
ok(parsed, 'the script with the watch sheet actually parses');

// --- the tap lands on the event, and only the device can read the link -------
// A notification that opens a topic list is a dead end. The link is the whole handoff,
// and it may carry the board token only because the body is encrypted to the device's
// own key: there is no provider cache any more, so nothing sits at rest holding it.
{
  const eventAlert = { title: 'GoWild soon: PHL Nov 12', body: 'body', priority: 'high', key: '2026-11-12|21:53|PHL' };
  const withTok = appPushPayload({ BOARD_TOKEN: 'tok-abcdefgh' }, eventAlert);
  eq(withTok.url, '/s/tok-abcdefgh?focus=2026-11-12%7C21%3A53%7CPHL', 'the tap opens the private board at this event');
  ok(decodeURIComponent(withTok.url).endsWith('focus=2026-11-12|21:53|PHL'), 'with the event key, not a guess');
  eq(appPushPayload({}, eventAlert).url, '/rdu', 'without a token the link stays on the public board');
  eq(appPushPayload({ BOARD_TOKEN: 'tok-abcdefgh' }, { title: 't', body: 'b' }).url, '/s/tok-abcdefgh', 'an alert with no event key still lands on the board');

  const sealed = await encryptPayload(withTok, SUBSCRIPTION.keys.p256dh, SUBSCRIPTION.keys.auth);
  ok(!Buffer.from(sealed).toString('latin1').includes('tok-abcdefgh'), 'the token is not readable on the wire');
  eq((await decryptPayload(sealed)).url, withTok.url, 'only the device recovers the link');
}

console.log(`watch: ${checks} checks passed`);
