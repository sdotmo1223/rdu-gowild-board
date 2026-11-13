// Render board.html from a snapshot the collector actually produced.
// Distinct from render-local.mjs, which reads the interactive .sweep captures.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildBoard } from '../src/board.js';
import { renderPage } from '../src/render.js';
import { frequencyTable } from '../src/frequency.js';
import { ROUTES, ORIGIN } from '../src/routes.js';

const src = process.env.STATE_IN || 'state.json';
let state;
try {
  state = JSON.parse(readFileSync(src, 'utf8'));
} catch (err) {
  console.error(`cannot read ${src}: ${err.message}`);
  process.exit(1);
}

// NOW lets a design review render against the same clock the fixture was built for.
// Default stays the real clock: nothing in a deploy path should pin time.
const now = process.env.NOW ? Number(process.env.NOW) : Date.now();
const view = buildBoard(state, now);

// OUTBOX lets a design review show the alert log without a live Worker: the file is
// a plain array of outbox entries, which is exactly what the KV key holds.
let outbox = null;
if (process.env.OUTBOX) {
  const entries = JSON.parse(readFileSync(process.env.OUTBOX, 'utf8'));
  const store = { get: async () => entries, put: async () => {} };
  const { outboxStatus } = await import('../src/outbox.mjs');
  outbox = await outboxStatus(store, 'rdu', now);
}
const html = renderPage(view, state, frequencyTable(state, ROUTES), now, {
  basePath: '/s/LOCALPREVIEW',
  origin: ORIGIN,
  outbox,
});
writeFileSync('board.html', html);

console.log(`state: ${src}`);
console.log(`updatedAt=${view.updatedAt} ageMin=${view.ageMin} stale=${view.stale} error=${view.error ? view.error.kind : 'none'}`);
let shown = 0;
let folded = 0;
for (const d of view.dates) {
  console.log(
    `=== ${d.date} status=${d.status} flights=${d.total} goWild=${d.goWild} shown=${d.rows.length} folded=${d.folded.length} above50=${d.above} blocked=${d.blockedRoutes} failed=${d.failedRoutes}`,
  );
  for (const r of d.rows) {
    console.log(`  ${r.dest} ${String(r.dep).slice(11, 16)}->${String(r.arr).slice(11, 16)} ${r.stops.padEnd(12)} ${String(r.dur).padEnd(18)} $${r.allin.toFixed(2)}`);
  }
  shown += d.rows.length;
  folded += d.folded.length;
}
console.log(`TOTAL shown=${shown} folded=${folded} dates=${view.dates.length}`);
console.log(`wrote board.html (${html.length} bytes)`);
