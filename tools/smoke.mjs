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

// Optional visual gate. A page that renders, runs its script and logs nothing can
// still be laid out wrong -- the header could be pushed off the first screen, or the
// rows could reflow at 412px. With SMOKE_SHOT set, the smoke run also captures the
// page at the owner's device width; with SMOKE_BASELINE set it diffs against a known
// good shot and fails when more than SMOKE_MAX_DIFF percent of pixels moved.
async function visualCheck(target) {
  const shotPath = process.env.SMOKE_SHOT;
  if (!shotPath) return null;
  const { chromium: cc } = await import('playwright');
  const browser = await cc.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: shotPath, fullPage: false });
    // Structure, measured rather than eyeballed: the decision header has to be inside
    // the first screen at the owner's device width, against real KV state.
    /* eslint-disable no-undef */ // this callback runs inside the page, not in node
    const decideTop = await page.evaluate(() => {
      const el = document.querySelector('.decide');
      return el ? Math.round(el.getBoundingClientRect().top + globalThis.scrollY) : null;
    });
    /* eslint-enable no-undef */
    if (process.env.SMOKE_ASSERT_DECIDE) {
      const limit = Number(process.env.SMOKE_DECIDE_MAX_Y || 300);
      if (decideTop === null) problems.push('no .decide header on the live page');
      else if (decideTop >= limit) problems.push(`.decide starts at y=${decideTop}, limit ${limit}`);
      else console.log(`smoke decide: header starts at y=${decideTop} (limit ${limit})`);
    }
    return shotPath;
  } finally {
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
  if (problems.length === 0 && (process.env.SMOKE_SHOT || process.env.SMOKE_BASELINE)) {
    try {
      const shot = await visualCheck(url);
      if (shot) console.log(`smoke shot: ${shot}`);
      if (shot && process.env.SMOKE_BASELINE) {
        const { diffPngs } = await import('./pngdiff.mjs');
        const d = await diffPngs(process.env.SMOKE_BASELINE, shot);
        const max = Number(process.env.SMOKE_MAX_DIFF || 2);
        console.log(`smoke visual: ${d.pct.toFixed(2)}% of pixels differ from baseline (limit ${max}%)`);
        if (d.pct > max) problems.push(`visual change ${d.pct.toFixed(2)}% exceeds ${max}%`);
      }
    } catch (err) {
      problems.push(`screenshot failed: ${String((err && err.message) || err).slice(0, 160)}`);
    }
  }
  if (problems.length === 0) {
    console.log(`smoke ok: ${url} (${result.title || 'no title'}, ${result.text.length} chars, ${result.scripts} script tag(s))`);
    process.exit(0);
  }
  console.error(`smoke attempt ${attempt}/${ATTEMPTS} failed: ${problems.join('; ')}`);
}

console.error(`smoke FAILED for ${url}`);
process.exit(1);
