// One-route diagnostic: does a scripted Chromium get real GoWild data, and does
// headless vs headed change the answer?
//
// Costs exactly one Frontier request, so it is safe to run against the politeness
// budget. Prints the status, the bytes, whether the journeys array exists, and
// whether the body carries any bot-protection markers.
import { chromium } from 'playwright';
import { readCookieString, applyCookies } from '../collector/cookies.mjs';

const HEADLESS = process.env.HEADLESS !== '0';
const DEST = process.env.PROBE_DEST || 'MCO';
const DATE = process.env.PROBE_DATE || 'Nov%2003,%202026';
const BASE = process.env.WARMUP_URL || 'https://booking.flyfrontier.com/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const path = `/Flight/InternalSelect?o1=RDU&d1=${DEST}&dd1=${DATE}&ADT=1&mon=true&promo=`;

const browser = await chromium.launch({
  headless: HEADLESS,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    ...(HEADLESS ? [] : ['--window-position=-32000,-32000', '--window-size=1280,800']),
  ],
});

try {
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 768 },
  });
  // IGNORE_COOKIE=1 runs the same probe with no session, which is the only way
  // to answer "is the cookie actually required, or was the warm-up URL the bug?".
  const cookieCount = process.env.IGNORE_COOKIE === '1' ? 0 : await applyCookies(context, readCookieString());
  const page = await context.newPage();

  const nav = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);

  const out = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    const t = await res.text();
    const title = (t.match(/<title[^>]*>([^<]*)/i) || [])[1] || '';
    return {
      status: res.status,
      finalUrl: res.url,
      bytes: t.length,
      hasJourneys: t.includes('"journeys"'),
      flights: (t.match(/"flights"/g) || []).length,
      title: title.trim().slice(0, 80),
      markers: ['datadome', 'captcha', 'are you a robot', 'access denied', 'blocked'].filter((m) =>
        t.toLowerCase().includes(m),
      ),
      head: t.slice(0, 180).replace(/\s+/g, ' '),
    };
  }, path);

  console.log(
    JSON.stringify(
      {
        headless: HEADLESS,
        cookies: cookieCount,
        warmupStatus: nav ? nav.status() : null,
        warmupUrl: nav ? nav.url() : null,
        route: DEST,
        ...out,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
