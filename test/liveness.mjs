// TASK A / 1c: the Frontier search link is the product's front door and the one
// thing that can rot without anyone noticing.
//
// The measured hazard: a cold request to Frontier's /Flight/Select bounces to
// /Flight/Redirect (their bot challenge) on a perfectly healthy site. A probe that
// calls any non-200 "broken" would cry wolf every single week. So the classifier
// separates four outcomes -- alive, challenged, drifted, broken -- and only the last
// two are worth waking the owner for.
import assert from 'node:assert/strict';
import {
  bookingUrl,
  classifyProbe,
  buildLivenessNotice,
  livenessDue,
  LIVENESS_REPEAT_DAYS,
} from '../src/liveness.mjs';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

// --- 1. the link itself -------------------------------------------------------
{
  const url = bookingUrl('ATL', '2026-11-18', 'RDU');
  ok(url.startsWith('https://booking.flyfrontier.com/'), 'it points at Frontier');
  ok(/o1=RDU/.test(url), 'origin is carried');
  ok(/d1=ATL/.test(url), 'destination is carried');
  ok(/dd1=Nov%2018,%202026/.test(url), 'the date uses the same param shape the collector already builds');
  ok(!/token|BOARD_TOKEN/i.test(url), 'the link carries no secret of ours');
  eq(bookingUrl('ATL', '2026-11-18'), bookingUrl('ATL', '2026-11-18', 'RDU'), 'RDU is the default origin');
  eq(bookingUrl('bad', 'x'), null, 'an unbuildable link is null, never a wrong link');
}

// --- 2. classification --------------------------------------------------------
{
  eq(classifyProbe({ status: 200 }).state, 'alive', '200 is alive');
  eq(classifyProbe({ status: 404 }).state, 'broken', '404 is broken');
  eq(classifyProbe({ status: 410 }).state, 'broken', '410 is broken');
  eq(classifyProbe({ status: 403 }).state, 'challenged', '403 is the bot challenge, not a dead link');
  eq(classifyProbe({ status: 302, location: 'https://booking.flyfrontier.com/Flight/Redirect' }).state, 'challenged', 'their own challenge redirect is expected');
  eq(classifyProbe({ status: 301, location: 'https://booking.flyfrontier.com/Flight/Select?x=1' }).state, 'alive', 'a redirect that stays on Frontier is alive');
  eq(classifyProbe({ status: 302, location: 'https://example.com/landing' }).state, 'drifted', 'a redirect off Frontier is pattern drift');
  eq(classifyProbe({ status: 0, error: 'ENOTFOUND' }).state, 'broken', 'a DNS failure is broken');
  eq(classifyProbe({ status: 500 }).state, 'broken', 'a 5xx is broken');
  eq(classifyProbe(null).state, 'broken', 'no result at all is broken');
}

// --- 3. which outcomes raise a notice ----------------------------------------
{
  eq(buildLivenessNotice({ state: 'alive' }), null, 'alive says nothing');
  eq(buildLivenessNotice({ state: 'challenged' }), null, 'a challenge says nothing -- it is normal');
  const broken = buildLivenessNotice({ state: 'broken', status: 404, url: 'https://booking.flyfrontier.com/x' });
  ok(broken, 'broken raises one notice');
  ok(Array.isArray(broken) ? broken.length === 1 : true, 'exactly one, never a batch');
  ok(/search link/i.test(broken.title), 'the title names the search link');
  ok(/404/.test(broken.message || broken.body || ''), 'the body carries the status');
  eq(broken.tier, 'health', 'it belongs to the health tier');
  const drift = buildLivenessNotice({ state: 'drifted', status: 302, location: 'https://example.com' });
  ok(/drift/i.test(`${drift.title} ${drift.message}`), 'drift says what it is');
}

// --- 4. weekly cadence --------------------------------------------------------
{
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  eq(LIVENESS_REPEAT_DAYS, 7, 'weekly');
  eq(livenessDue(null, now), true, 'never probed means due');
  eq(livenessDue(now - 3 * 86400000, now), false, 'three days ago is not due');
  eq(livenessDue(now - 8 * 86400000, now), true, 'eight days ago is due');
  eq(livenessDue('nope', now), true, 'an unreadable stamp is due -- silence is worse');
}

console.log(`liveness: ${checks} checks passed`);
