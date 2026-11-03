// Profile + classification checks. Separate from acceptance.mjs because these
// cover the multi-origin seam: a wrong route list must never look like bot
// protection, and a second origin must never re-derive its own renderer.
import assert from 'node:assert';
import { PROFILES, PROFILE, ORIGIN, ROUTES } from '../src/routes.js';
import { parseRoute, shouldAbortSweep, classifyFailure } from '../collector/parse.mjs';
import { renderPage } from '../src/render.js';
import { buildBoard } from '../src/board.js';
import { frequencyTable } from '../src/frequency.js';

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`ok ${String(n).padStart(2)} - ${msg}`);
};
const URL_OK = 'https://booking.flyfrontier.com/Flight/InternalSelect?o1=PHL&d1=ATL';

ok('all three origins are defined');
assert.equal(PROFILES.rdu.origin, 'RDU');
assert.equal(PROFILES.lga.origin, 'LGA');
assert.equal(PROFILES.phl.origin, 'PHL');

ok('default profile stays RDU so an unset env cannot silently move the board');
assert.equal(PROFILE, 'rdu');
assert.equal(ORIGIN, 'RDU');
assert.equal(ROUTES.length, PROFILES.rdu.routes.length);

ok('PHL has a plausible route count and no duplicates');
assert.ok(PROFILES.phl.routes.length >= 18 && PROFILES.phl.routes.length <= 24);
assert.equal(new Set(PROFILES.phl.routes.map((r) => r.code)).size, PROFILES.phl.routes.length);

// The bug this guards: an unserved city pair (596 KB app shell, no journeys) used
// to classify identically to a DataDome refusal (20 KB challenge, no journeys),
// so one wrong city pair in a route list aborted the entire sweep.
const shell = `<title>Frontier Airlines</title><script src="https://booking.flyfrontier.com/app.js"></script>${'x'.repeat(600000)}`;
const challenge = 'x'.repeat(20000);
const unserved = parseRoute({ status: 200, url: URL_OK, text: shell }, '2026-11-03', 'ATL', 'Atlanta');
ok('large Frontier page with no journeys = route not served');
assert.equal(unserved.reason, 'route-not-served');
assert.equal(unserved.notServed, true);

ok('an unserved route must NOT abort the sweep');
assert.equal(shouldAbortSweep(unserved), false);

const refused = parseRoute({ status: 200, url: URL_OK, text: challenge }, '2026-11-03', 'ATL', 'Atlanta');
ok('small page with no journeys is still a refusal, and still aborts');
assert.equal(refused.reason, 'no-journeys-key');
assert.equal(shouldAbortSweep(refused), true);

const junk = parseRoute({ status: 200, url: URL_OK, text: 'x'.repeat(1500000) }, '2026-11-03', 'ATL', 'Atlanta');
ok('a large page that is NOT Frontier is still a refusal (looksLikeFrontier)');
assert.equal(junk.reason, 'no-journeys-key');

ok('a sweep where every route is unserved is a wrong route list, not an outage');
assert.equal(classifyFailure([unserved, unserved]), 'profile');
assert.equal(classifyFailure([unserved, refused]), 'error');

const state = {
  generatedAt: Date.now(),
  history: [],
  sweeps: [{ date: '2026-11-03', dest: 'ATL', ok: true, blocked: false, reason: 'ok', flights: [] }],
};
const view = buildBoard(state, Date.now());
const html = renderPage(view, state, frequencyTable(state, PROFILES.phl.routes), Date.now(), {
  basePath: '/phl',
  origin: 'PHL',
});
ok('a PHL page titles itself and leaves no origin token behind');
assert.ok(/<title>PHL GoWild<\/title>/.test(html));
assert.ok(!html.includes('{ORIGIN}'));
assert.ok(html.includes('No Frontier departures from PHL on this date.'));

console.log(`\nPROFILES: ${n} checks passed`);
