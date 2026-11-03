// "Does Frontier sell this city pair?" — one request, Chromium, sequential.
// Plain Node fetch is refused by DataDome (proven 2026-11-02), so a route probe
// must use the same real-browser path as the collector or it reports a false
// negative. Uses the collector's own parser, so the answer means the same thing
// the board would mean.
//   node tools/route-probe.mjs JFK MCO 0
import { chromium } from 'playwright';
import { parseRoute } from '../collector/parse.mjs';
import { frontierDateParam, easternDate } from '../src/routes.js';

const origin = (process.argv[2] || 'RDU').toUpperCase();
const dest = (process.argv[3] || 'MCO').toUpperCase();
const days = Number(process.argv[4] || 0);
const date = easternDate(days);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  userAgent: UA,
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1366, height: 768 },
});
const page = await ctx.newPage();
// Warm up at the booking root: /Flight/Select redirects to /Flight/Redirect and
// subsequent fare calls then bounce to www, which 404s.
await page.goto('https://booking.flyfrontier.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await sleep(3000);
const url = `/Flight/InternalSelect?o1=${origin}&d1=${dest}&dd1=${frontierDateParam(date)}&ADT=1&mon=true&promo=`;
const r = await page.evaluate(async (u) => {
  const res = await fetch(u, { credentials: 'include' });
  const t = await res.text();
  return { status: res.status, url: res.url, text: t };
}, url);
await browser.close();

const p = parseRoute(r, date, dest, dest);
const flights = p.flights || [];
console.log(
  JSON.stringify(
    {
      route: `${origin}-${dest}`,
      date,
      http: r.status,
      bytes: r.text.length,
      ok: p.ok,
      blocked: p.blocked,
      reason: p.reason,
      flights: flights.length,
      goWild: flights.filter((f) => f.goWild).length,
    },
    null,
    1,
  ),
);
