import { writeFileSync } from 'node:fs';
import {
  ROUTES,
  ORIGIN,
  easternDate,
  frontierDateParam,
  routeShard,
  shardRoutes,
  departuresFinished,
} from '../src/routes.js';
import { parseRoute, classifyFailure, shouldAbortSweep, mergeSweeps } from './parse.mjs';
import { appendTransitions, recordObservation, recordFirstSeen } from '../src/history.js';
import { buildAlert, sendAlert } from '../src/alerts.mjs';
import { recordSchedule } from '../src/schedule.mjs';
import { readCookieString, applyCookies } from './cookies.mjs';

const KV_KEY = 'state';
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
function ingestEnv() {
  const url = process.env.BOARD_INGEST_URL;
  const token = process.env.BOARD_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function ingestFetch(env, url, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${env.token}` };
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

async function main() {
  // Two dates by default. SWEEP_DAYS raises the window for a deliberate backfill
  // (e.g. SWEEP_DAYS=4 once), but each extra day costs 7 more requests and the
  // measured soft throttle starts well inside a two-date burst, so raising it in
  // the normal 15-minute cadence is a bad trade.
  // Resolve and PROVE the write path before Frontier is touched. On 2026-11-03 a
  // rejected token was only discovered after 19 fare requests had been spent,
  // which is exactly the waste invariant 4 forbids.
  const ingest = ingestEnv();
  const kv = ingest ? null : kvEnv();
  let previous = null;
  if (ingest) {
    const probe = await ingestFetch(ingest, `${ingest.url}?dryRun=1`, { method: 'POST', body: '{}' });
    if (!probe.ok) {
      throw new Error(
        `ingest dry run rejected (HTTP ${probe.status}): ${probe.text.slice(0, 200)} — no Frontier requests were made`,
      );
    }
    const got = await ingestFetch(ingest, ingest.url, { method: 'GET' });
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
  const skipToday = process.env.SWEEP_ALL_DATES !== '1' && departuresFinished(startedAt) && todayHasRows;
  const dates = Array.from({ length: dayCount }, (_, i) => easternDate((skipToday ? 1 : 0) + i, startedAt));
  const skippedDates = skipToday ? [todayISO] : [];

  // Half the routes per tick, alternating on the clock. 14 routes x 2 dates is a
  // 28-request burst every 15 minutes and the measured refusals land at 4/28 and
  // 19/28, so a burst that big spends requests being told no. Two shards of seven
  // give the same coverage every 30 minutes for half the burst. FULL_SWEEP=1 asks
  // all 14 for a deliberate backfill.
  const shard = process.env.FULL_SWEEP === '1' ? null : routeShard(startedAt);
  const plannedRoutes = shardRoutes(ROUTES, shard);
  const { chromium } = await import('playwright');

  console.log(
    `sweep plan: ${plannedRoutes.length}/${ROUTES.length} routes x ${dates.length} date(s) = ${
      dates.length * plannedRoutes.length
    } requests (shard ${shard === null ? 'full' : shard}${skipToday ? '; today skipped, departures finished' : ''})`,
  );

  // CORRECTED 2026-11-02: headless Chromium is NOT refused. An earlier conclusion
  // blamed headless when the real cause was the warm-up URL — /Flight/Select
  // redirects to /Flight/Redirect, after which fare calls bounce to www and 404.
  // Headless and headed return identical payloads. HEADLESS=0 still exists for a
  // scheduler that prefers an offscreen window, not because it is required.
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

  // Warm up on the booking origin so the in-page fetches stay same-origin and
  // any DataDome JS challenge runs before we ask for fares.
  await page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);

  const sweeps = [];
  const total = dates.length * plannedRoutes.length;
  let requests = 0;
  let abortedAt = null;

  // Labelled so a refusal can end both loops at once: there is no point asking
  // the remaining routes once Frontier has started refusing the burst.
  outer: for (const date of dates) {
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
        sweeps.push({ date, dest: route.code, ok: false, blocked: false, flights: [], reason: `fetch-failed: ${err.message}` });
        abortedAt = { date, dest: route.code, reason: 'fetch-failed', attempts: sweeps.length };
        break outer;
      }

      const parsed = parseRoute(response, date, route.code, route.city);
      sweeps.push({ date, dest: route.code, ...parsed });
      console.log(`${date} ${route.code}: ${parsed.reason} flights=${parsed.flights.length} blocked=${parsed.blocked}`);
      if (shouldAbortSweep(parsed)) {
        abortedAt = { date, dest: route.code, reason: parsed.reason, attempts: sweeps.length };
        console.error(
          `${route.code} was refused (${parsed.reason}); stopping after ${sweeps.length}/${total} requests. ` +
            'Once one fare request is refused, the rest of the burst is refused too.',
        );
        break outer;
      }
      await sleep(jitter());
    }
  }

  await browser.close();

  const now = Date.now();

  const allFlights = sweeps.flatMap((s) => s.flights || []);
  const blockedCount = sweeps.filter((s) => s.blocked).length;
  const okCount = sweeps.filter((s) => s.ok).length;

  const state = previous || { history: [] };
  state.version = 1;
  state.routeCount = ROUTES.length;
  state.requests = requests;
  state.generatedAt = now;
  // NOTE: state.sweeps is assigned only in the success branch below. Assigning it
  // here would replace the last good board with fourteen empty results on a sweep
  // where every route was blocked.

  // If every route came back blocked, keep the last good board on screen and
  // raise the banner. Never replace real data with nothing.
  // Usable means at least one route returned a parseable payload. "No journeys
  // key, fourteen times" is bot protection wearing a different costume than
  // /Flight/Redirect, and counting only `blocked` let it overwrite good data.
  const everythingFailed = okCount === 0;
  if (everythingFailed) {
    const kind = classifyFailure(sweeps) || 'error';
    state.lastError = {
      kind,
      at: now,
      detail:
        kind === 'auth'
          ? `${sweeps.length} of ${total} requests 404'd on www — the session cookie has expired or the warm-up URL regressed`
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
    const boardRows = allFlights.filter((f) => f.goWild && f.allin !== null && f.allin <= 50);
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
    const { recordFares } = await import('../src/pricing.mjs');
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
        .filter((f) => f && f.goWild && f.allin !== null && f.allin <= 50);
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
  if (topic) {
    const fresh = (state.history || []).filter((h) => h.ts === now);
    const alert = buildAlert(state, fresh, now);
    if (alert) {
      try {
        await sendAlert(topic, alert);
        state.lastAlert = { kind: alert.kind, at: now };
        console.log(`alert sent: ${alert.title}`);
      } catch (err) {
        console.error(`alert failed: ${err.message}`);
      }
    }
  }

  console.log(
    `sweeps=${sweeps.length}/${total} requests=${requests} flights=${allFlights.length} blocked=${blockedCount} ` +
      `history=${state.history.length} aborted=${abortedAt ? abortedAt.reason : 'no'}`,
  );

  if (ingest) {
    const blob = JSON.stringify(state);
    const res = await ingestFetch(ingest, ingest.url, { method: 'POST', body: blob });
    if (!res.ok) throw new Error(`ingest write failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    console.log(`ingest write complete: ${blob.length} bytes via the Worker.`);
    return;
  }
  if (!kv) {
    // No write path at all: emit the snapshot locally so the real renderer can
    // be exercised against the collector's own output instead of a fixture.
    const out = process.env.STATE_OUT || 'state.json';
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
