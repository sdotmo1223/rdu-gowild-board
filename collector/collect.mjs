import { writeFileSync } from 'node:fs';
import { ROUTES, ORIGIN, easternDate, frontierDateParam } from '../src/routes.js';
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

async function main() {
  // Two dates by default. SWEEP_DAYS raises the window for a deliberate backfill
  // (e.g. SWEEP_DAYS=4 once), but each extra day costs 14 more requests and the
  // measured soft throttle starts around the fifteenth request in a burst, so
  // raising it in the normal 15-minute cadence is a bad trade.
  const dayCount = Math.max(1, Math.min(7, Number(process.env.SWEEP_DAYS) || 2));
  const dates = Array.from({ length: dayCount }, (_, i) => easternDate(i));
  const { chromium } = await import('playwright');

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
  const total = dates.length * ROUTES.length;
  let requests = 0;
  let abortedAt = null;

  // Labelled so a refusal can end both loops at once: there is no point asking
  // the remaining routes once Frontier has started refusing the burst.
  outer: for (const date of dates) {
    for (const route of ROUTES) {
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
  const env = kvEnv();
  const previous = env ? await kvGet(env) : null;

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
    const { sweeps: merged, deadDates, kept } = mergeSweeps(state.sweeps, sweeps, dates);
    for (const k of kept) {
      console.error(`date ${k.date}: no usable route this sweep; kept ${k.rows} previous results`);
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
            ]
              .filter(Boolean)
              .join(' '),
          }
        : null;
    state.aborted = abortedAt;
    state.updatedAt = now;
    state.sweeps = merged;

    // Free schedule data: record what each route did on each swept date. No extra
    // requests, and it is what makes a week-over-week rotation verdict possible.
    const schedDates = [...new Set(merged.map((s) => s.date))];
    for (const d of schedDates) recordSchedule(state, d, merged, now);
    // One digest for the whole board (both dates). Calling this per-date would
    // overwrite lastRows and re-emit the other date's rows as new transitions.
    const boardRows = allFlights.filter((f) => f.goWild && f.allin !== null && f.allin <= 50);
    const transition = appendTransitions(state, boardRows, now);
    console.log(`digest=${transition.digest} changed=${transition.changed} newTransitions=${transition.added}`);
    // Durable first-seen timestamps feed the release-timing model; they live
    // outside `history` so the 4,000-row cap cannot evict them.
    recordFirstSeen(state, boardRows, now);
    for (const date of dates) {
      recordObservation(state, date, boardRows.filter((f) => f.date === date));
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

  if (!env) {
    // No Cloudflare credentials: emit the snapshot locally so the real renderer
    // can be exercised against the collector's own output instead of a fixture.
    const out = process.env.STATE_OUT || 'state.json';
    const blob = JSON.stringify(state);
    writeFileSync(out, blob);
    console.error(`Cloudflare KV env vars missing; wrote ${out} instead of uploading.`);
    console.log(`state=${out} bytes=${blob.length} sweeps=${sweeps.length}`);
    return;
  }
  await kvPut(env, state);
  console.log('KV write complete.');
}

main().catch((err) => {
  console.error('collector failed:', err.message);
  process.exit(1);
});
