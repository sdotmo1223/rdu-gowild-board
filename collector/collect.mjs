import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ROUTES,
  ORIGIN,
  MAX_ALL_IN,
  easternDate,
  frontierDateParam,
  shardRoutes,
  nextShard,
  departuresFinished,
  easternStamp,
  leadProbeDue,
  leadProbePlan,
  PROFILE,
} from '../src/routes.js';
import {
  parseRoute,
  classifyFailure,
  shouldAbortSweep,
  refusalEndsSweep,
  routeRetired,
  mergeSweeps,
} from './parse.mjs';
import { appendTransitions, recordObservation, recordFirstSeen } from '../src/history.js';
import {
  buildAlert,
  buildZeroAlert,
  buildWatchAlert,
  buildHeartbeatAlert,
  parseWatch,
  sendAlert,
} from '../src/alerts.mjs';
import { recordSchedule } from '../src/schedule.mjs';
import { recordFares } from '../src/pricing.mjs';
import { readCookieString, applyCookies } from './cookies.mjs';

const KV_KEY = 'state';
// QUARANTINE_AFTER / QUARANTINE_RETRY_MS live in parse.mjs with routeRetired(), so
// the retirement rule is testable without a browser.
// The largest burst this project has evidence for is 28 requests (28/28 clean on
// 2026-11-03). "Ask everything" on a 22-route profile would be 44, so forced
// sweeps are capped and the remainder is deferred to the rotation.
const FORCED_BUDGET_CEILING = 30;
const API_BASE = 'https://api.cloudflare.com/client/v4';
const BASE_URL = 'https://booking.flyfrontier.com/Flight/Select';
// The booking root keeps the fetches same-origin; /Flight/Select redirects to
// /Flight/Redirect and then the fare request can be bounced to www.
const WARMUP_URL = process.env.WARMUP_URL || 'https://booking.flyfrontier.com/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Mandated politeness: 2-5 s randomized, strictly sequential.
const jitter = () => 2000 + Math.floor(Math.random() * 3000);

function kvEnv() {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const ns = process.env.CF_KV_NAMESPACE_ID;
  if (!token || !account || !ns) return null;
  return { token, account, ns };
}

const VERIFY_HINT =
  'Check the credential without printing it: powershell -NoProfile -ExecutionPolicy Bypass -File tools/verify-cf-token.ps1';

async function kvGet(env) {
  const url = `${API_BASE}/accounts/${env.account}/storage/kv/namespaces/${env.ns}/values/${KV_KEY}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.token}` } });
  if (res.status === 404) return null;
  // A bare "KV GET 401" cost a whole 19-request sweep on 2026-11-03: the run had
  // already scraped everything, then died writing. Say what to fix instead.
  if (res.status === 401) {
    throw new Error(
      'KV GET 401 - CF_API_TOKEN was rejected. The token value is invalid, expired, or for another account. ' + VERIFY_HINT,
    );
  }
  if (res.status === 403) {
    throw new Error(
      'KV GET 403 - CF_API_TOKEN is valid but lacks Workers KV Storage: Edit on this account. ' + VERIFY_HINT,
    );
  }
  if (!res.ok) throw new Error(`KV GET ${res.status}`);
  return res.json();
}

async function kvPut(env, state) {
  const url = `${API_BASE}/accounts/${env.account}/storage/kv/namespaces/${env.ns}/values/${KV_KEY}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`KV PUT ${res.status} - cannot write the snapshot. ${VERIFY_HINT} Cloudflare said: ${detail}`);
    }
    throw new Error(`KV PUT ${res.status}: ${detail}`);
  }
}

// Write path B: post the snapshot to our own Worker, which owns the KV write.
// CI then needs no Cloudflare API token at all — only BOARD_TOKEN, which the
// page already requires, so there is no fourth credential to get wrong.
const addParam = (u, p) => u + (u.includes('?') ? '&' : '?') + p;

function ingestEnv() {
  const url = process.env.BOARD_INGEST_URL;
  // Two credentials, two directions. GET /api/ingest accepts only BOARD_TOKEN and
  // POST /api/ingest accepts only BOARD_WRITE_TOKEN. One shared variable here is
  // what broke every sweep on 2026-11-05: the pre-flight read presented the write
  // token, was refused with 401, and the run died before a single Frontier request.
  const readToken = process.env.BOARD_TOKEN;
  const writeToken = process.env.BOARD_WRITE_TOKEN || process.env.BOARD_TOKEN;
  if (!url || !readToken || !writeToken) return null;
  // A second origin writes its own KV key through the same Worker, so CI needs
  // no new secret and no second endpoint: only the profile name changes where
  // the snapshot lands.
  return { url: PROFILE === 'rdu' ? url : addParam(url, `profile=${PROFILE}`), readToken, writeToken };
}

async function ingestFetch(env, url, { method = 'GET', body, token } = {}) {
  // The caller names the credential; there is no default, so a new call site cannot
  // silently borrow the wrong one.
  if (!token) throw new Error(`ingest ${method} has no token — refusing to borrow one`);
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, parsed, text };
}

// Real acquisition: a warmed-up Chromium page. CORRECTED 2026-11-02: headless
// Chromium is NOT refused. An earlier conclusion blamed headless when the real
// cause was the warm-up URL — /Flight/Select redirects to /Flight/Redirect, after
// which fare calls bounce to www and 404. Headless and headed return identical
// payloads; HEADLESS=0 exists for a scheduler that prefers an offscreen window.
async function openFaresPage() {
  const { chromium } = await import('playwright');
  const headless = process.env.HEADLESS !== '0';
  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      ...(headless ? [] : ['--window-position=-32000,-32000', '--window-size=1280,800']),
    ],
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 768 },
  });
  // Measured 2026-11-02: the session cookie is NOT required. Warming up on the
  // booking root gives a cookie-less headless browser the full fare payload
  // (200 / 1,090,472 B / journeys present). The cookie is still applied when one
  // exists, purely for resilience, and 0 is a fully supported mode.
  const cookieCount = await applyCookies(context, readCookieString());
  console.log(`cookies loaded: ${cookieCount} (optional; 0 is supported)`);

  const page = await context.newPage();
  // Warm up on the booking origin so the in-page fetches stay same-origin and any
  // DataDome JS challenge runs before we ask for fares.
  await page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);
  return { page, close: () => browser.close() };
}

// Fixture acquisition: the same page interface with no network at all. Used by
// `npm run dry` (test/dry.mjs) so the collector's own wiring — plan, parse, merge,
// alerts, write — is executed by a gate. On 2026-11-04 a branch-scoped binding
// threw here after 42 paid requests and no gate could see it, because nothing ran
// this function outside the cron.
function openFixturePage() {
  const file = process.env.COLLECTOR_FIXTURE || 'test/fixtures/route.json';
  const raw = JSON.parse(readFileSync(file, 'utf8')); // corrupt fixture = loud failure
  // A committed fixture would fall out of the 48-hour window by tomorrow, and an
  // all-past fixture would skip every interesting path (transitions, fares,
  // watchlist). Re-base the departure dates onto this sweep's today, keeping the
  // real captured clock times and fares.
  const today = easternDate(0);
  const rebase = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? `${today}${s.slice(10)}` : s);
  let payload = null;
  try {
    payload = JSON.parse(raw.text);
  } catch {
    payload = null;
  }
  if (payload && Array.isArray(payload.journeys)) {
    for (const j of payload.journeys) {
      for (const f of j.flights || []) {
        for (const leg of f.legs || []) {
          leg.departureDate = rebase(leg.departureDate);
          leg.arrivalDate = rebase(leg.arrivalDate);
        }
      }
    }
  }
  const text = payload ? JSON.stringify(payload) : raw.text;
  const page = {
    async goto() {},
    async evaluate() {
      return { status: 200, url: WARMUP_URL, text };
    },
  };
  return Promise.resolve({ page, close: async () => {} });
}

async function main() {
  // Two dates by default. SWEEP_DAYS raises the window for a deliberate backfill
  // (e.g. SWEEP_DAYS=4 once), but each extra day costs 7 more requests and the
  // measured soft throttle starts well inside a two-date burst, so raising it in
  // the normal 15-minute cadence is a bad trade.
  // Resolve and PROVE the write path before Frontier is touched. On 2026-11-03 a
  // rejected token was only discovered after 19 fare requests had been spent,
  // which is exactly the waste invariant 4 forbids.
  // A dry run must never touch production: no Worker ingest, no KV, no cookie, no
  // Frontier. It exists so a gate executes this function instead of the cron.
  const dry = process.env.COLLECTOR_DRY_RUN === '1';
  const ingest = dry ? null : ingestEnv();
  const kv = dry || ingest ? null : kvEnv();
  let previous = null;
  if (ingest) {
    const probe = await ingestFetch(ingest, addParam(ingest.url, 'dryRun=1'), { method: 'POST', body: '{}', token: ingest.writeToken });
    if (!probe.ok) {
      throw new Error(
        `ingest dry run rejected (HTTP ${probe.status}): ${probe.text.slice(0, 200)} — no Frontier requests were made`,
      );
    }
    const got = await ingestFetch(ingest, ingest.url, { method: 'GET', token: ingest.readToken });
    if (!got.ok) throw new Error(`ingest read failed (HTTP ${got.status}) — no Frontier requests were made`);
    previous = got.parsed && got.parsed.state ? got.parsed.state : null;
    console.log('write path: worker-ingest (dry run + read ok)');
  } else if (kv) {
    // The read doubles as the credential check.
    previous = await kvGet(kv);
    console.log('write path: cloudflare-kv (read ok)');
  } else {
    console.log('write path: local-file (no write credentials configured)');
  }

  const dayCount = Math.max(1, Math.min(7, Number(process.env.SWEEP_DAYS) || 2));
  const startedAt = Date.now();
  const prevSweeps = previous && Array.isArray(previous.sweeps) ? previous.sweeps : [];
  const todayISO = easternDate(0, startedAt);

  // Once the last departure has gone there is nothing left to learn about today.
  // Asking again would spend half of this sweep's budget on a schedule that has
  // already flown. It is skipped ONLY when the previous snapshot actually holds
  // today: with nothing to carry forward, the date would disappear from the
  // board entirely, and a vanished date is the one state the page must never show.
  const todayHasRows = prevSweeps.some((s) => s && s.date === todayISO);
  // The real end of today is the last departure already observed, not 23:00. From
  // that moment this slot in the two-date window can only return flights nobody can
  // book, so it goes to the date that keeps the window a full 48 hours ahead. Same
  // request count: two dates, seven routes per tick.
  const lastDepToday = prevSweeps
    .filter((s) => s && s.date === todayISO)
    .flatMap((s) => (Array.isArray(s.flights) ? s.flights : []))
    .map((f) => String((f && f.dep) || ''))
    .filter(Boolean)
    .sort()
    .pop();
  const todayDone =
    departuresFinished(startedAt) || (lastDepToday ? easternStamp(startedAt) > lastDepToday : false);
  const skipToday = process.env.SWEEP_ALL_DATES !== '1' && todayDone && todayHasRows;
  let dates = Array.from({ length: dayCount }, (_, i) => easternDate((skipToday ? 1 : 0) + i, startedAt));
  const skippedDates = skipToday ? [todayISO] : [];

  // Half the routes per tick, alternating on the clock. 14 routes x 2 dates is a
  // 28-request burst every 15 minutes and the measured refusals land at 4/28 and
  // 19/28, so a burst that big spends requests being told no. Two shards of seven
  // give the same coverage every 30 minutes for half the burst. FULL_SWEEP=1 asks
  // all 14 for a deliberate backfill.
  // SWEEP_ONLY=ATL,MCO asks exactly the routes named. A one-round-trip question
  // ("does Frontier sell PHL-BOS?") should not cost a CI queue slot, and a
  // diagnostic must never hide behind the rotation.
  const onlyCodes = String(process.env.SWEEP_ONLY || '')
    .toUpperCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // A city pair that answers "not sold" is not an outage (see parse.mjs), but it
  // must not be paid for forever. Three sightings retire it; FULL_SWEEP=1 or
  // SWEEP_ONLY=CODE puts it back deliberately.
  const watch = previous && previous.routeWatch && typeof previous.routeWatch === 'object' ? previous.routeWatch : {};
  const quarantined = Object.keys(watch).filter((c) => routeRetired(watch[c], startedAt));
  const forced = onlyCodes.length > 0 || process.env.FULL_SWEEP === '1';
  let routePool = onlyCodes.length ? ROUTES.filter((r) => onlyCodes.includes(r.code)) : ROUTES.slice();
  if (quarantined.length && !forced) routePool = routePool.filter((r) => !quarantined.includes(r.code));
  if (onlyCodes.length && !routePool.length) {
    // A diagnostic aimed at one route list must not fail the other origins: a
    // dispatch with only=BOS across three profiles would otherwise turn the job
    // red for a correct question. Skip with zero Frontier requests.
    console.warn(
      `SWEEP_ONLY=${onlyCodes.join(',')} matches no route in ${ORIGIN} ` +
        `(${ROUTES.map((r) => r.code).join(',')}); skipping this profile with 0 requests`,
    );
    return;
  }
  // --- Weekly lead probe -----------------------------------------------------
  // The two-date window censors every release observation at 48 hours, so lead time
  // is unobservable by construction: no amount of waiting fixes a window that never
  // opens. Once a week the SAME budget buys a longer horizon for two routes instead
  // of a short one for seven -- 14 requests, one process, no extra burst.
  // Off for a forced sweep, a dry run, an explicit LEAD_PROBE=0, and a profile with
  // no board yet (learning release timing before the board has ever rendered is the
  // wrong order, and the first tick must produce rows).
  const probeBudget = Number(process.env.SWEEP_MAX_REQUESTS) || routePool.length * 2;
  const hasBoard = Boolean(previous && Array.isArray(previous.sweeps) && previous.sweeps.length);
  // LEAD_PROBE=force is the gate's hook: it runs this branch against the fixture, so
  // a collector branch that has never executed cannot ship. That is exactly how a
  // branch-scoped ReferenceError cost 42 Frontier requests on 2026-11-04.
  const probeForce = process.env.LEAD_PROBE === 'force';
  const probePlan =
    !forced && process.env.LEAD_PROBE !== '0' && (hasBoard || (dry && probeForce))
      ? leadProbePlan(routePool, probeBudget, previous && previous.leadProbeCursor)
      : null;
  const probeDue = Boolean(
    probePlan && leadProbeDue(previous && previous.leadProbe && previous.leadProbe.at, startedAt),
  );
  if (probeDue) {
    // Tomorrow onwards: the probe never re-asks what the board window already covers.
    dates = Array.from({ length: probePlan.dates }, (_, i) => easternDate(1 + i, startedAt));
  }

  // Tick-driven, not clock-driven (see nextShard). SWEEP_SHARD=0|1 is the manual
  // override for a deliberate single-half probe and is not used by the cron.
  const explicitShard = Number(process.env.SWEEP_SHARD);
  // A probe asks a different question and must not advance the rotation: the next
  // normal tick continues where the last normal tick left off.
  const shard =
    forced || probeDue
      ? null
      : explicitShard === 0 || explicitShard === 1
        ? explicitShard
        : nextShard(previous && previous.lastShard, startedAt);
  const shardList = probeDue ? probePlan.routes : shardRoutes(routePool, shard);
  // A per-profile request budget. Several origins in one job would otherwise add
  // up to a burst big enough to earn a refusal, and a refusal aborts. The budget
  // keeps each profile's burst small and simply defers the rest to the next tick,
  // where the rotation picks it up. Budget is in requests, not routes.
  // FULL_SWEEP/SWEEP_ONLY mean "ask everything named", so the per-profile budget
  // must not silently halve a deliberate backfill (it did: FULL_SWEEP asked 7 of
  // 14 routes). The normal rotating tick is unaffected. A forced sweep is still
  // capped by FORCED_BUDGET_CEILING, because "ask everything" on PHL would be 44.
  const wantedBudget = forced
    ? routePool.length * dates.length
    : probeDue
      ? probePlan.routes.length * dates.length
      : Number(process.env.SWEEP_MAX_REQUESTS) || shardList.length * dates.length;
  const budget = Math.max(1, forced ? Math.min(wantedBudget, FORCED_BUDGET_CEILING) : wantedBudget);
  const maxRoutes = Math.max(1, Math.floor(budget / dates.length));
  // Slice with a clock-driven offset instead of always taking the first N. Taking
  // the head every tick would starve the tail of each shard forever: with a budget
  // of 8 out of 11 routes, three routes would never be asked again.
  // The budget slice had the same phase lock: with a budget below the shard size
  // (LGA asks 5 of 7, PHL 8 of 11) a clock-derived offset pins the same tail
  // forever. Advance a stored cursor by exactly what the last tick asked instead.
  const priorCursor = Number(previous && previous.routeCursor);
  const offset = shardList.length
    ? Number.isInteger(priorCursor) && priorCursor >= 0
      ? priorCursor % shardList.length
      : Math.floor(startedAt / (15 * 60 * 1000)) % shardList.length
    : 0;
  const plannedRoutes = probeDue
    ? probePlan.routes
    : Array.from(
        { length: Math.min(maxRoutes, shardList.length) },
        (_, i) => shardList[(offset + i) % shardList.length],
      );
  console.log(
    `sweep plan: ${plannedRoutes.length}/${routePool.length} routes x ${dates.length} date(s) = ${
      dates.length * plannedRoutes.length
    } requests (shard ${shard === null ? 'full' : shard}, budget ${budget}${
      probeDue ? '; LEAD PROBE, board rows untouched' : ''
    }${skipToday ? '; today skipped, departures finished' : ''
    }${onlyCodes.length ? `; SWEEP_ONLY=${onlyCodes.join(',')}` : ''}${
      quarantined.length && !forced ? `; ${quarantined.length} retired as not-sold` : ''
    }${wantedBudget > budget ? `; capped from ${wantedBudget} to ${budget}` : ''})`,
  );

  const { page, close } = await (dry ? openFixturePage() : openFaresPage());

  const sweeps = [];
  const notServedHits = [];
  const refusedHits = [];
  const servedHits = [];
  const total = dates.length * plannedRoutes.length;
  let requests = 0;
  let abortedAt = null;

  // Labelled so a refusal can end both loops at once: there is no point asking
  // the remaining routes once Frontier has started refusing the burst.
  outer: for (const date of dates) {
    // Consecutive refusals on this date. Reset by any usable answer.
    let refusals = 0;
    for (const route of plannedRoutes) {
      const path = `/Flight/InternalSelect?o1=${ORIGIN}&d1=${route.code}&dd1=${frontierDateParam(date)}&ADT=1&mon=true&promo=`;
      let response = null;
      try {
        response = await page.evaluate(async (u) => {
          const r = await fetch(u, { credentials: 'include' });
          const t = await r.text();
          return { status: r.status, url: r.url, text: t };
        }, path);
        requests++;
      } catch (err) {
        sweeps.push({
          date,
          dest: route.code,
          ok: false,
          blocked: false,
          flights: [],
          reason: `fetch-failed: ${err.message}`,
          at: Date.now(),
        });
        abortedAt = { date, dest: route.code, reason: 'fetch-failed', attempts: sweeps.length };
        break outer;
      }

      const parsed = parseRoute(response, date, route.code, route.city);
      // `at` is the fetch time of THIS row. Without it, the first time the row is
      // carried mergeSweeps has nothing older than "now" to stamp it with, and the
      // page reports data one tick fresher than it is.
      sweeps.push({ date, dest: route.code, ...parsed, at: Date.now() });
      if (parsed.notServed) notServedHits.push(route.code);
      else if (parsed.ok && watch[route.code]) servedHits.push(route.code);
      console.log(`${date} ${route.code}: ${parsed.reason} flights=${parsed.flights.length} blocked=${parsed.blocked}`);
      if (shouldAbortSweep(parsed)) {
        refusedHits.push(route.code);
        refusals += 1;
        // One refusal is not proof the burst is blocked: a single route can answer
        // without a journeys array while the rest of the sweep is fine. PHL died at
        // MYR on every tick because of this, never reaching the seven routes after it.
        if (refusalEndsSweep(refusals)) {
          abortedAt = {
            date,
            dest: route.code,
            reason: parsed.reason,
            attempts: sweeps.length,
            streak: refusals,
          };
          console.error(
            `${route.code} refused twice in a row (${parsed.reason}); stopping after ${sweeps.length}/${total} requests. ` +
              'Two consecutive refusals read as a burst-level block; continuing spends the budget being told no.',
          );
          break outer;
        }
        console.warn(
          `${route.code} refused (${parsed.reason}); continuing, one route is not yet a burst block.`,
        );
      } else {
        refusals = 0;
      }
      // A dry run talks to a fixture, so there is no host to be polite to and a
      // fourteen-request probe would otherwise spend a minute of gate time asleep.
      if (!dry) await sleep(jitter());
    }
  }

  await close();

  const now = Date.now();

  const allFlights = sweeps.flatMap((s) => s.flights || []);
  const blockedCount = sweeps.filter((s) => s.blocked).length;
  const okCount = sweeps.filter((s) => s.ok).length;

  const state = previous || { history: [] };

  // Durable first-look. This is the only fact that can tell a Frontier release from
  // our own cron, and it cannot live in `sweeps`: that array holds ONE tick, so every
  // sighting whose date left the two-date window came back uncensored and voted on the
  // median (measured 2026-11-06: 66 of 111 sightings were in that blind spot). Written
  // for every date this tick asked about, including a date every route refused -- the
  // question was still asked, which is what censoring needs to know. Kept for 21 days,
  // comfortably longer than a date stays interesting and shorter than KV's own cap.
  state.firstLook = state.firstLook && typeof state.firstLook === 'object' ? state.firstLook : {};
  for (const d of dates) {
    if (!Number.isFinite(Number(state.firstLook[d]))) state.firstLook[d] = startedAt;
  }
  const lookFloor = easternDate(-21, startedAt);
  for (const d of Object.keys(state.firstLook)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < lookFloor) delete state.firstLook[d];
  }

  // Per-route freshness ledger, from answers this tick already paid for. The header's
  // "updated N min ago" is the age of the SNAPSHOT, not of each route, so a single
  // starving route used to be invisible without reading KV by hand.
  // A probe tick deliberately writes nothing here: it asks far-out dates about two
  // routes, and refreshing two entries would make the other twelve look abandoned on a
  // tick that never intended to check them.
  if (!probeDue) {
    state.coverage = state.coverage && typeof state.coverage === 'object' ? state.coverage : {};
    for (const s of sweeps) {
      if (!s || !s.dest) continue;
      const prior = state.coverage[s.dest] && typeof state.coverage[s.dest] === 'object' ? state.coverage[s.dest] : {};
      const priorOk = Number(prior.lastOkAt);
      // lastOkAt is the last time this route ANSWERED, not the last time it was asked:
      // a route refused six times in a row is not fresh, and that is exactly the age
      // the page needs to state.
      state.coverage[s.dest] = {
        lastFetchAt: Number(s.at) || now,
        lastOkAt: s.ok
          ? Number(s.at) || now
          : Number.isFinite(priorOk) && priorOk > 0
            ? priorOk
            : null,
        fails: s.ok ? 0 : Number(prior.fails || 0) + 1,
        lastReason: typeof s.reason === 'string' ? s.reason.slice(0, 60) : null,
      };
    }
    const known = new Set(ROUTES.map((r) => r.code));
    for (const c of Object.keys(state.coverage)) if (!known.has(c)) delete state.coverage[c];
  }
  // Retire confirmed "not sold" pairs, and un-retire any that answered normally.
  state.routeWatch = state.routeWatch && typeof state.routeWatch === 'object' ? state.routeWatch : {};
  // A probe asks dates Frontier may not have loaded yet, where "not sold" can simply
  // mean "not published", so it must never move the three-strikes quarantine.
  for (const code of new Set(probeDue ? [] : notServedHits)) {
    const w =
      state.routeWatch[code] && typeof state.routeWatch[code] === 'object'
        ? state.routeWatch[code]
        : { notServed: 0, firstAt: now };
    w.notServed = Number(w.notServed || 0) + 1;
    w.lastAt = now;
    state.routeWatch[code] = w;
  }
  // A route that refuses repeatedly is retired exactly like a pair Frontier does
  // not fly: three strikes, then a week off before it is asked again.
  for (const code of new Set(probeDue ? [] : refusedHits)) {
    const w =
      state.routeWatch[code] && typeof state.routeWatch[code] === 'object'
        ? state.routeWatch[code]
        : { refused: 0, firstAt: now };
    w.refused = Number(w.refused || 0) + 1;
    w.lastAt = now;
    state.routeWatch[code] = w;
  }
  for (const code of new Set(servedHits)) delete state.routeWatch[code];

  state.version = 1;
  state.routeCount = ROUTES.length;
  state.requests = requests;
  // What this tick actually asked, so the next one alternates from fact. A forced
  // sweep must not move the rotation: a diagnostic would otherwise advance it.
  if (shard !== null) {
    state.lastShard = shard;
    state.routeCursor = shardList.length ? (offset + plannedRoutes.length) % shardList.length : 0;
  }
  state.generatedAt = now;
  // Liveness: a resumed cron, or one profile that stopped writing while the others
  // ran. Wrapped, because a notification must never cost a paid-for sweep.
  try {
    const heartbeat = buildHeartbeatAlert(previous, now);
    if (heartbeat) {
      await sendAlert(process.env.NTFY_TOPIC, heartbeat);
      state.lastHeartbeatAt = now;
      console.log(`heartbeat: previous snapshot was ${Math.round((now - previous.updatedAt) / 60000)} min old`);
    }
  } catch (err) {
    console.error(`heartbeat alert failed: ${err.message}`);
  }
  // NOTE: state.sweeps is assigned only in the success branch below. Assigning it
  // here would replace the last good board with fourteen empty results on a sweep
  // where every route was blocked.

  // If every route came back blocked, keep the last good board on screen and
  // raise the banner. Never replace real data with nothing.
  // Usable means at least one route returned a parseable payload. "No journeys
  // key, fourteen times" is bot protection wearing a different costume than
  // /Flight/Redirect, and counting only `blocked` let it overwrite good data.
  // Declared here, NOT inside the success branch below. The alert block further
  // down runs on both paths, and referencing a branch-scoped binding from there
  // threw "boardRows is not defined" after a full sweep had already been paid for
  // in 42 Frontier requests and before the snapshot was written -- so every tick
  // of 2026-11-04 10:18 lost its data.
  const boardStamp = easternStamp(now);
  const boardRows = allFlights.filter(
    (f) => f.goWild && f.allin !== null && f.allin <= MAX_ALL_IN && (!f.dep || String(f.dep) >= boardStamp),
  );

  const everythingFailed = okCount === 0;
  if (probeDue) {
    // A lead probe answers a different question from a board sweep, so it must never
    // reach the board. state.sweeps is left exactly as it was: twelve routes were
    // never asked about these dates, and a date the page can only partly answer is
    // the empty grid this project forbids. Only the release-timing model grows.
    const before = Object.keys(state.firstSeen || {}).length;
    const probeRows = allFlights.filter((f) => f.goWild && f.allin !== null && f.allin <= MAX_ALL_IN);
    recordFirstSeen(state, probeRows, now);
    const grown = Object.keys(state.firstSeen || {}).length - before;
    const fareTrack = recordFares(state, allFlights, now);
    state.leadProbeCursor = probePlan.cursor;
    state.leadProbe = {
      at: now,
      routes: plannedRoutes.map((r) => r.code),
      dates: dates.slice(),
      requests,
      ok: okCount > 0,
      newFirstSeen: grown,
      fares: fareTrack.tracked,
      aborted: abortedAt ? abortedAt.reason : null,
    };
    console.log(
      `lead probe: ${plannedRoutes.map((r) => r.code).join(',')} x ${dates.length} date(s), ` +
        `${requests} requests, ${grown} new first sighting(s); board rows untouched`,
    );
  } else if (everythingFailed) {
    const kind = classifyFailure(sweeps) || 'error';
    state.lastError = {
      kind,
      at: now,
      detail:
        kind === 'auth'
          ? `${sweeps.length} of ${total} requests 404'd on www — the session cookie has expired or the warm-up URL regressed`
          : kind === 'profile'
            ? `all ${sweeps.length} routes answered with the no-route page; this profile's route list is probably wrong`
            : `${sweeps.length}/${total} requests attempted: ${blockedCount} hit the DataDome redirect, ` +
            `${sweeps.length - okCount} returned no journeys array` +
            (abortedAt ? ` (stopped early at ${abortedAt.dest})` : ''),
    };
    console.error('No route returned usable data; preserving previous board.');
  } else {
    // A date where every route failed must not erase a good earlier sweep for that
    // same date. Keep the previous rows for it and say plainly that they are old.
    // Measured 2026-11-02: sustained sweeping gets soft-throttled partway through,
    // so "half the sweep died" is a routine outcome, not an edge case.
    const { sweeps: merged, deadDates, kept, partial, skipped } = mergeSweeps(state.sweeps, sweeps, dates, {
      expectedRoutes: plannedRoutes.length,
      plannedDests: plannedRoutes.map((r) => r.code),
      skippedDates,
      now,
    });
    for (const s of skipped) {
      console.log(`date ${s.date}: departures finished; kept ${s.rows} rows and stopped asking about it`);
    }
    for (const k of kept) {
      console.error(`date ${k.date}: no usable route this sweep; kept ${k.rows} previous results`);
    }
    for (const p of partial) {
      console.error(
        `date ${p.date}: sweep stopped after ${p.attempted}/${p.expected} planned routes; ` +
          `kept ${p.missing} previous results for routes never asked`,
      );
    }
    for (const p of partial.filter((x) => x.rotated)) {
      console.log(
        `date ${p.date}: ${p.rotated} routes are the other half of the rotation and were not asked this tick`,
      );
    }

    state.lastError =
      deadDates.length || abortedAt
        ? {
            kind: 'partial',
            at: now,
            detail: [
              deadDates.length
                ? `${deadDates.length} of ${dates.length} date(s) returned nothing usable; kept ${kept.reduce((a, k) => a + k.rows, 0)} previous rows.`
                : '',
              abortedAt
                ? `Sweep stopped at ${abortedAt.dest} after ${abortedAt.attempts}/${total} requests (${abortedAt.reason}).`
                : '',
              partial.length
                ? partial
                    .map(
                      (p) =>
                        `${p.date} only reached ${p.attempted}/${p.expected} planned routes; ${p.missing} rows carried from the previous sweep`,
                    )
                    .join('; ') + '.'
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          }
        : null;
    state.aborted = abortedAt;
    state.updatedAt = now;
    state.sweeps = merged;
    // Recorded so the page can say plainly that it is sweeping half the routes
    // per run, and so a later reader can tell a rotation from a shortfall.
    state.lastSweep = {
      at: now,
      shard: shard === null ? null : shard,
      routes: plannedRoutes.length,
      total: ROUTES.length,
      skippedToday: skipToday,
      quarantined: quarantined.length,
    };

    // Free schedule data: record what each route did on each swept date. No extra
    // requests, and it is what makes a week-over-week rotation verdict possible.
    // Carried rows are the PREVIOUS sweep's answer. Feeding them back in would
    // claim a route was re-checked when it was never asked, and would make a
    // throttled sweep look like fresh evidence in the weekly matrix.
    const askedThisSweep = merged.filter((s) => s && !s.carried);
    const schedDates = [...new Set(askedThisSweep.map((s) => s.date))];
    for (const d of schedDates) recordSchedule(state, d, askedThisSweep, now);
    // One digest for the whole board (both dates). Calling this per-date would
    // overwrite lastRows and re-emit the other date's rows as new transitions.
    // Bookable means bookable: a departure that has already left is not a new
    // opportunity, so it must not create a history transition or a push. Without
    // this a watchlist could buzz about a flight that left an hour ago.
    // (boardRows/boardStamp are computed above, before the branch, because the
    // alert block outside it reads them.)
    // A board that is healthy and empty looks exactly like one nobody is running.
    // Count consecutive empty sweeps so the page can state a verdict instead of
    // repeating "no seats" forever, and so an alert can say "still nothing".
    // A "clean" sweep is one where every planned route on every date answered.
    // An aborted or half-refused sweep is not evidence that Frontier released
    // nothing, so it must not build toward a "N healthy sweeps" verdict.
    const cleanSweep =
      !abortedAt && sweeps.length === dates.length * plannedRoutes.length && sweeps.every((s) => s && s.ok);
    if (boardRows.length > 0) {
      state.zero = null;
    } else if (cleanSweep) {
      const priorZero = state.zero && typeof state.zero === 'object' ? state.zero : null;
      state.zero = {
        count: priorZero ? Number(priorZero.count || 0) + 1 : 1,
        since: priorZero && priorZero.since ? priorZero.since : now,
      };
    }
    const transition = appendTransitions(state, boardRows, now);
    console.log(`digest=${transition.digest} changed=${transition.changed} newTransitions=${transition.added}`);
    // Durable first-seen timestamps feed the release-timing model; they live
    // outside `history` so the 4,000-row cap cannot evict them.
    recordFirstSeen(state, boardRows, now);
    // Fare mechanics: record EVERY itinerary this sweep saw, not only the ones
    // that qualify. A flight still carrying its standard fare is the pre-flip
    // evidence that makes "when does it turn into GoWild?" answerable at all;
    // recording only qualifying rows would hide the transition on both sides.
    // allFlights is the fresh response set, so a refused route contributes
    // nothing and cannot be mistaken for "no GoWild seats today".
    const fareTrack = recordFares(state, allFlights, now);
    console.log(`fares: tracked=${fareTrack.tracked} new=${fareTrack.created}`);
    // Bookability for a date uses every row we hold for it (fresh + carried) so a
    // route that was not re-asked is never counted as "not bookable". Whether the
    // date counts as OBSERVED is a different question and needs a this-sweep
    // answer: recording a date where every route was refused would add a
    // denominator for a day we never actually saw.
    const flightsFor = (dateISO) =>
      merged
        .filter((s) => s && s.date === dateISO)
        .flatMap((s) => (Array.isArray(s.flights) ? s.flights : []))
        .filter((f) => f && f.goWild && f.allin !== null && f.allin <= MAX_ALL_IN);
    for (const date of dates) {
      const answered = askedThisSweep.filter((s) => s.date === date && s.ok);
      if (!answered.length) {
        console.error(`date ${date}: no route answered this sweep; not recording an observation`);
        continue;
      }
      // Only routes that were asked AND answered can be recorded as "not
      // bookable" for this date. In half-sweep mode the other seven were
      // deliberately skipped, and writing a 0 for them here would erase a real 1
      // recorded twenty minutes earlier.
      recordObservation(state, date, flightsFor(date), { asked: answered.map((s) => s.dest) });
    }
  }

  // Push alerts: only on real change, and deduped per error state inside
  // buildAlert so a blocked sweep cannot buzz the phone every 15 minutes.
  const topic = process.env.NTFY_TOPIC;
  // A standing question that can never be answered is a silent failure, so say it
  // in the run log where a reader will see it.
  if (!topic && process.env.WATCH) {
    console.warn(`WATCH=${process.env.WATCH} is set but NTFY_TOPIC is not, so no watch alert can be sent`);
  }
  // Alerting is a side effect and must never cost the snapshot: a throw in here
  // used to abort main() before the write, discarding a sweep already paid for.
  try {
  // A probe tick must not buzz the phone about far-out dates that are not on the
  // board: the reader would be told about a departure the page does not list.
  if (topic && !probeDue) {
    const fresh = (state.history || []).filter((h) => h.ts === now);
    // The watchlist is answered first because it is the more specific question, and
    // one event must not buzz the phone twice.
    // Judged against what is bookable right now, not against this run's
    // transitions: a fare already under the watch price when WATCH was set never
    // produces a transition, and a send that failed must be retried next tick
    // instead of being lost with its transition.
    const watchAlert = buildWatchAlert(state, boardRows, process.env.WATCH, now);
    // Only a delivered watch alert may suppress the digest. Recording the intent
    // instead meant one ntfy outage dropped both pushes for the same fare.
    let watchSent = false;
    if (watchAlert) {
      try {
        await sendAlert(topic, watchAlert);
        const fired =
          state.watchFired && typeof state.watchFired === 'object' ? state.watchFired : {};
        fired[watchAlert.key] = now;
        const keys = Object.keys(fired).sort((a, b) => Number(fired[b]) - Number(fired[a]));
        for (const k of keys.slice(200)) delete fired[k];
        state.watchFired = fired;
        watchSent = true;
        console.log(`watch alert sent: ${watchAlert.title}`);
      } catch (err) {
        console.error(`watch alert failed: ${err.message}`);
      }
    }
    // The watch already reported its own rows. Drop just those rows from the digest
    // rather than the whole digest, which would swallow every other fare found in
    // the same tick.
    const watched = parseWatch(process.env.WATCH);
    const digestRows = watchSent
      ? fresh.filter(
          (r) => !watched.some((w) => r.dest === w.dest && typeof r.allin === 'number' && r.allin <= w.max),
        )
      : fresh;
    const alert = buildAlert(state, digestRows, now) || buildZeroAlert(state, now);
    if (alert) {
      try {
        await sendAlert(topic, alert);
        state.lastAlert = { kind: alert.kind, at: now };
        if (alert.kind === 'zero') state.lastZeroAt = now;
        console.log(`alert sent: ${alert.title}`);
      } catch (err) {
        console.error(`alert failed: ${err.message}`);
      }
    }
  }
  } catch (err) {
    console.error(`alerting failed (snapshot still written): ${err.message}`);
  }

  console.log(
    `sweeps=${sweeps.length}/${total} requests=${requests} flights=${allFlights.length} blocked=${blockedCount} ` +
      `history=${state.history.length} aborted=${abortedAt ? abortedAt.reason : 'no'}`,
  );

  if (ingest) {
    // The topic rides along with the snapshot so the Worker can push without a
    // second secret the owner cannot read back. The Worker strips it before storing.
    const notifyTopic = process.env.NTFY_TOPIC;
    const blob = JSON.stringify(notifyTopic ? { ...state, notifyTopic } : state);
    const res = await ingestFetch(ingest, ingest.url, { method: 'POST', body: blob, token: ingest.writeToken });
    if (!res.ok) throw new Error(`ingest write failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    console.log(`ingest write complete: ${blob.length} bytes via the Worker.`);
    return;
  }
  if (!kv) {
    // No write path at all: emit the snapshot locally so the real renderer can
    // be exercised against the collector's own output instead of a fixture.
    const out = process.env.STATE_OUT || 'state.json';
    mkdirSync(dirname(out), { recursive: true });
    const blob = JSON.stringify(state);
    writeFileSync(out, blob);
    console.error(`No write credentials; wrote ${out} instead of uploading.`);
    console.log(`state=${out} bytes=${blob.length} sweeps=${sweeps.length}`);
    return;
  }
  await kvPut(kv, state);
  console.log('KV write complete.');
}

main().catch((err) => {
  console.error('collector failed:', err.message);
  process.exit(1);
});
