// Screenshot a rendered board.html at a phone viewport.
//
// The design directive's rule: a design change you have not SEEN is not done. The
// board is a single HTML file with no build step, so the fastest honest check is to
// render it exactly as the Worker would and look at the pixels at the primary
// device's width (S23: 412 CSS px at 2.625 density).
//
//   node tools/shot.mjs board.html .dry/before.png
//   SHOT_FULL=0 node tools/shot.mjs board.html .dry/fold.png     # first screen only
//
// file:// is enough: the page makes no external request, and its localStorage and
// service-worker calls are already guarded against a non-http origin.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = resolve(process.argv[2] || 'board.html');
const out = resolve(process.argv[3] || '.dry/shot.png');
const width = Number(process.env.SHOT_W || 412);
const height = Number(process.env.SHOT_H || 915);
const fullPage = process.env.SHOT_FULL !== '0';

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.waitForTimeout(350);
  // SHOT_BODYCLASS lets a review prove a state the page only enters through a click
  // (pins live in localStorage) without scripting a tap at the page.
  const bodyClass = process.env.SHOT_BODYCLASS;
  if (bodyClass) {
    /* eslint-disable no-undef */ // this callback runs inside the page, not in node
    await page.evaluate((c) => {
      document.body.classList.add(c);
      const lbl = document.getElementById('pinlist');
      if (lbl) lbl.textContent = 'MCO \u00b7 ATL';
    }, bodyClass);
    /* eslint-enable no-undef */
    await page.waitForTimeout(120);
  }
  const scrollTo = Number(process.env.SHOT_SCROLL || 0);
  if (scrollTo > 0) {
    await page.evaluate((y) => globalThis.scrollTo(0, y), scrollTo);
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: out, fullPage });
  const dims = await page.evaluate(() => ({
    scrollH: globalThis.document.documentElement.scrollHeight,
    scrollW: globalThis.document.documentElement.scrollWidth,
    viewW: globalThis.innerWidth,
  }));
  console.log(`shot: ${out} (${width}x${height} css, fullPage=${fullPage}, page ${dims.scrollW}x${dims.scrollH})`);
  if (dims.scrollW > dims.viewW + 1) console.log(`WARN horizontal overflow: content ${dims.scrollW}px in ${dims.viewW}px viewport`);
  if (errors.length) {
    console.log(`ERRORS: ${errors.slice(0, 3).join(' | ')}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
