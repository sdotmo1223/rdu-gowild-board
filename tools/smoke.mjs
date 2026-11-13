// The one check no unit test can make: does the deployed page actually load in a
// browser, run its own script, and stay quiet in the console?
//
// Why it exists: the client script is generated markup. Every assertion about the
// page is made against an HTML string, and a string cannot tell you that the emitted
// script threw on line 1 -- that exact bug shipped once, with every markup check
// green. `new Function()` in the watch suite proves the script parses; this proves it
// runs.
//
// Deliberately small, so it can gate a deploy without becoming the flaky test people
// learn to ignore: one page, one load, a bounded wait, and a single retry.
import { chromium } from 'playwright';

const url = process.argv[2] || 'https://rdu-gowild-board.sdotmo1223.workers.dev/rdu';
const ATTEMPTS = 2;
const TIMEOUT_MS = 45000;

async function once(target) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => failedRequests.push(`${req.url()} ${req.failure() && req.failure().errorText}`));
  try {
    const res = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    const status = res ? res.status() : 0;
    // The board's own script runs after DOMContentLoaded; give it a beat to throw.
    await page.waitForTimeout(1500);
    // globalThis, not `document`: this callback runs in the page, where the global is
    // real but the linter has no browser env for it.
    const body = await page.evaluate(() => globalThis.document && globalThis.document.body && globalThis.document.body.innerText);
    const title = await page.title();
    return {
      status,
      title,
      text: String(body || ''),
      errors,
      failedRequests,
      scripts: await page.evaluate(() => globalThis.document.querySelectorAll('script').length),
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

const problems = [];
let result = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  problems.length = 0;
  try {
    result = await once(url);
  } catch (err) {
    problems.push(`navigation failed: ${String((err && err.message) || err).slice(0, 200)}`);
    continue;
  }
  if (result.status !== 200) problems.push(`HTTP ${result.status}`);
  if (!/GoWild/i.test(result.text)) problems.push('the page text does not mention GoWild');
  if (result.text.length < 200) problems.push(`the page text is only ${result.text.length} chars`);
  if (!result.scripts) problems.push('no client script was emitted');
  if (result.errors.length) problems.push(`console errors: ${result.errors.slice(0, 3).join(' | ')}`);
  if (problems.length === 0) {
    console.log(`smoke ok: ${url} (${result.title || 'no title'}, ${result.text.length} chars, ${result.scripts} script tag(s))`);
    process.exit(0);
  }
  console.error(`smoke attempt ${attempt}/${ATTEMPTS} failed: ${problems.join('; ')}`);
}

console.error(`smoke FAILED for ${url}`);
process.exit(1);
