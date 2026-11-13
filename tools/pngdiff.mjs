// Pixel diff between two PNGs, decoded by Chromium's canvas so this stays
// dependency-free. Shared by tools/shotdiff.mjs (CLI) and tools/smoke.mjs (gate).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

export async function diffPngs(aPath, bPath) {
  const a = readFileSync(aPath).toString('base64');
  const b = readFileSync(bPath).toString('base64');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><canvas id="c"></canvas>');
    /* eslint-disable no-undef */ // this callback runs inside the page, not in node
    return await page.evaluate(async ({ aB64, bB64 }) => {
      const load = (b64) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('decode failed'));
          img.src = `data:image/png;base64,${b64}`;
        });
      const A = await load(aB64);
      const B = await load(bB64);
      const w = Math.min(A.width, B.width);
      const h = Math.min(A.height, B.height);
      const c = document.getElementById('c');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(A, 0, 0);
      const da = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(B, 0, 0);
      const db = ctx.getImageData(0, 0, w, h).data;
      let changed = 0;
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
          if (d > 12) {
            changed += 1;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      return {
        aW: A.width,
        aH: A.height,
        bW: B.width,
        bH: B.height,
        w,
        h,
        changed,
        pct: (changed / (w * h)) * 100,
        box: changed ? { minX, minY, maxX, maxY } : null,
      };
    }, { aB64: a, bB64: b });
    /* eslint-enable no-undef */
  } finally {
    await browser.close();
  }
}
