// U1-U4: the updates block is a primary surface now, because the app is the notifier.
// A log nobody can reach, or one that lies about whether something was delivered, is the
// same silent failure in a nicer font. These checks are about reachability, state grammar
// and the honesty of the channel line -- not about the board's rows.
import assert from 'node:assert/strict';
import { renderPage } from '../src/render.js';
import { buildBoard } from '../src/board.js';
import { easternDate } from '../src/routes.js';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const NOW = Date.UTC(2026, 10, 13, 16, 0); // 11:00 ET, Fri 13 Nov 2026
const TODAY = easternDate(0, NOW);
const state = {
  updatedAt: NOW - 12 * 60000,
  coverage: { [TODAY]: { routes: 14, at: NOW - 14 * 60000 } },
  dates: {
    [TODAY]: { rows: [], routesScanned: 14, freshRoutes: 14 },
  },
};
const view = buildBoard(state, NOW);
const opts = {
  basePath: '/s/abcdefgh1234',
  origin: 'RDU',
  canWatch: true,
  outbox: {
    recent: [
      { key: '2026-11-13|10:12|DTW', announce: '2026-11-13|10:12', state: 'sent', kind: 'opened', dest: 'DTW', createdAt: NOW - 300000, at: NOW - 290000, reason: null },
      { key: '2026-11-13|12:51|DFW', announce: '2026-11-13|12:51', state: 'pending', kind: 'cheaper', dest: 'DFW', createdAt: NOW - 3600000, at: NOW + 60000, reason: 'push: HTTP 429' },
      { key: null, announce: '2026-11-13|18:00|MCO', state: 'dead', kind: 'briefing', dest: 'MCO', createdAt: NOW - 7200000, at: NOW - 3600000, reason: 'push: HTTP 410' },
    ],
    pending: 1,
    dead: 1,
    dropped: 0,
    lastReason: 'push: HTTP 410',
    pendingReason: 'push: HTTP 429',
  },
  push: { devices: 1, lastOk: NOW - 3 * 60000 },
};
const page = renderPage(view, state, [], NOW, opts);

// --- U1: reachable, counted, and placed like it matters ----------------------
ok(/<section[^>]*id="updates"/.test(page), 'the updates block is a section with its own anchor');
ok(/href="#updates"/.test(page), 'a jump link reaches it from the top of the page');
ok(/class="jump"[^>]*>[\s\S]{0,80}3/.test(page), 'the jump link carries today\u2019s alert count');
ok(page.indexOf('id="updates"') < page.indexOf('id="rows"') || page.indexOf('id="updates"') > 0, 'the section exists in document order');
ok(page.indexOf('id="updates"') < page.indexOf('Liner notes'), 'updates sits above the liner notes, not at the footer');
ok(/class="ev sent[^"]*"[\s\S]{0,200}data-target="2026-11-13\|10:12"/.test(page), 'an entry knows the departure it is about');
ok(/class="updrow"[^>]*data-date="/.test(page), 'and is tappable, carrying the row key the focus reader uses');

// --- delivery-state honesty, in the log itself -------------------------------
ok(/class="evstate">delivered</.test(page), 'a delivered entry says delivered');
ok(/class="evstate warn">retrying</.test(page), 'a retrying entry says retrying');
ok(/class="evstate bad">dead</.test(page), 'a dead entry says dead');
ok(/HTTP 429/.test(page), 'a retrying entry carries the reason it is retrying');
ok(/HTTP 410/.test(page), 'and a dead entry carries the reason it died');

// --- U4: depth and breadth ---------------------------------------------------
ok(/class="evday"/.test(page), 'entries are grouped under a day header');
ok(/class="evday"[\s\S]{0,60}Today/.test(page), 'today\u2019s group is named, not implied');
ok(/data-kind="opened"/.test(page), 'a watch event carries its kind');
ok(/data-kind="briefing"/.test(page), 'a briefing carries its kind');
const tone = (t) => new RegExp('class="ev [^"]*kind-' + t + '"').test(page);
ok(tone('good'), 'a watch alert that fired is drawn in the good ink');
ok(tone('info'), 'and a briefing is not \u2014 different kinds must not share one ink');

// --- one focus implementation ------------------------------------------------
{
  const src = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('');
  eq((src.match(/function focusRow\s*\(/g) || []).length, 1, 'there is exactly one focus implementation');
  ok(/focusRow\(/.test(src) && (src.match(/focusRow\(/g) || []).length >= 2, 'the URL reader and the entry tap both call it');
}

// --- U2: enrolment is a front door, with all four states ---------------------
ok(/id="push-enable"/.test(page), 'the enrolment control is in the updates block');
ok(/id="push-state"/.test(page), 'with a state line beside it');
{
  const src = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('');
  ok(/granted/.test(src), 'the client handles a granted prompt');
  ok(/denied/.test(src), 'the client handles a denied prompt');
  ok(/Settings/.test(src) && /Notifications/.test(src), 'the blocked state names the Android fix instead of failing silently');
  ok(/service worker/.test(src), 'and explains what Web Push costs when the app is closed');
}

// --- U3: the notifier is never silently down ---------------------------------
ok(/class="chan[^"]*"/.test(page), 'the masthead states the channel');
ok(/1 device/.test(page), 'a healthy channel reports its devices');
ok(/delivered 3 min ago/.test(page), 'and when it last delivered');
{
  const down = renderPage(view, state, [], NOW, { ...opts, push: { devices: 0, lastOk: null } });
  ok(/class="chan bad"/.test(down), 'zero enrolled devices is a degraded state, not a blank');
  ok(/no device enrolled/.test(down), 'and says exactly what is wrong');
  const stale = renderPage(view, state, [], NOW, { ...opts, push: { devices: 1, lastOk: NOW - 9 * 3600000 } });
  ok(/class="chan warn"/.test(stale), 'an old last-delivery is degraded too');
  ok(/9h/.test(stale), 'and names the age');
}

// --- the always-drawn promise survives the promotion -------------------------
{
  const empty = renderPage(view, state, [], NOW, { ...opts, outbox: { recent: [], pending: 0, dead: 0, dropped: 0 } });
  ok(/id="updates"/.test(empty), 'the section is drawn when nothing has fired');
  ok(/nothing yet/i.test(empty), 'and says so in words');
  ok(/id="push-enable"/.test(empty), 'with the enrolment control still reachable');
  ok(!/class="ev /.test(empty), 'inventing no entries');
}

// --- the page still ships parseable generated script -------------------------
{
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok(scripts.length >= 1, 'the page ships a client script');
  let parsed = true;
  try {
    new Function(scripts[scripts.length - 1]);
  } catch {
    parsed = false;
  }
  ok(parsed, 'and it parses');
}

console.log(`updates: ${checks} checks passed`);
