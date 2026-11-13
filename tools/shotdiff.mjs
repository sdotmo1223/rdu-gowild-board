// CLI for the pixel diff.
//
//   node tools/shotdiff.mjs .dry/before.png .dry/after.png
//
// Prints the share of pixels that moved and the bounding box of the change, and exits
// 1 when the images are identical -- a design change that changed nothing is reported
// as such instead of being described.
import { diffPngs } from './pngdiff.mjs';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('usage: node tools/shotdiff.mjs <before.png> <after.png>');
  process.exit(2);
}

const r = await diffPngs(aPath, bPath);
const sameSize = r.aW === r.bW && r.aH === r.bH;
console.log(
  `diff: ${r.pct.toFixed(2)}% of pixels changed of ${r.w}x${r.h}` +
    (sameSize ? '' : ` (size ${r.aW}x${r.aH} -> ${r.bW}x${r.bH})`),
);
if (r.box) console.log(`  changed area x ${r.box.minX}-${r.box.maxX}, y ${r.box.minY}-${r.box.maxY}`);
process.exit(r.changed > 0 ? 0 : 1);
