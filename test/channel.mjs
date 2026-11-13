// U-A..U-D: the channel's own truth. The app is the notifier, so the page has to say
// when the notifier is deaf (U-A), let the owner prove the channel from the phone (U-B),
// report what the phone itself confirmed (U-C), and stop implying the log is complete
// when it is only as old as its storage (U-D).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  dates: { [TODAY]: { rows: [], routesScanned: 14, freshRoutes: 14 } },
};
const view = buildBoard(state, NOW);
const OLD = '2026-11-13|10:12|DTW';

const entry = (over) => ({
  key: OLD,
  announce: '2026-11-13|10:12',
  state: 'sent',
  kind: 'opened',
  dest: 'DTW',
  createdAt: NOW - 300000,
  at: NOW - 290000,
  reason: null,
  ...over,
});

const base = {
  basePath: '/s/abcdefgh1234',
  origin: 'RDU',
  canWatch: true,
  watches: [{ dest: 'ATL', date: TODAY, mode: 'always', channels: ['push'] }],
  outbox: { recent: [entry({})], pending: 0, dead: 0, dropped: 0 },
  push: { devices: 1, lastOk: NOW - 3 * 60000 },
};
const build = (over) => renderPage(view, state, [], NOW, { ...base, ...over });
const scriptOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('');

// --- U-A: a deaf notifier is a masthead statement, not a silence --------------
// Measured production event 2026-11-13: every subscription was gone, the tier kept
// retrying into zero devices, and the page said nothing above the fold.
{
  const deaf = build({ push: { devices: 0, lastOk: null } });
  ok(/class="pushbanner"/.test(deaf), 'zero devices with something to say is a banner, not a footnote');
  ok(/nothing can notify you/i.test(deaf), 'and it says, in words, that nothing can notify');
  eq((deaf.match(/id="push-enable"/g) || []).length, 1, 'the enable affordance is the same button, never a second copy');
  ok(deaf.indexOf('class="pushbanner"') < deaf.indexOf('id="updates"'), 'the banner belongs to the masthead area, above the log');

  const healthy = build({});
  ok(!/class="pushbanner"/.test(healthy), 'healthy and enrolled stays silent');
  eq((healthy.match(/id="push-enable"/g) || []).length, 1, 'and still carries exactly one enrol control');

  const quiet = build({
    push: { devices: 0, lastOk: null },
    watches: [],
    outbox: { recent: [], pending: 0, dead: 0, dropped: 0 },
  });
  ok(!/class="pushbanner"/.test(quiet), 'zero devices with nothing watching does not shout');
  ok(/id="push-enable"/.test(quiet), 'but the affordance is still reachable from the log');
}

// --- U-B: prove the channel from the page ------------------------------------
{
  const page = build({});
  ok(/id="push-check"/.test(page), 'an enrolled device can test the channel without a terminal');
  ok(/Check now/.test(page), 'the control names what it does');
  ok(/id="push-result"/.test(page), 'and the result lands in a stated place');
  const src = scriptOf(page);
  ok(/\/api\/push\/test/.test(src), 'it calls the Worker test route');
  ok(/\/api\/push\/state/.test(src), 'and re-reads the channel state to look for the phone\u2019s acknowledgement');
  ok(/not confirmed|unconfirmed|waiting for the phone/i.test(src), 'a sent push is not called delivered before the phone says so');
  ok(/(shown|confirmed)/.test(src), 'and there is a distinct confirmed branch once the ack lands');
}

// --- U-C: the phone's word, in the log's own ink -----------------------------
{
  const mixed = build({
    outbox: {
      recent: [
        entry({ ack: 'shown', dest: 'DTW' }),
        entry({ ack: 'sent', dest: 'DFW', key: '2026-11-13|12:51|DFW', announce: '2026-11-13|12:51' }),
        entry({ state: 'pending', dest: 'MCO', key: '2026-11-13|18:00|MCO', announce: '2026-11-13|18:00', reason: 'push: HTTP 429' }),
      ],
      pending: 1,
      dead: 0,
      dropped: 0,
    },
  });
  ok(/class="evstate">delivered \u00b7 shown/.test(mixed), 'an acknowledged push reads delivered and shown');
  ok(/class="evstate warn">delivered \u00b7 unconfirmed/.test(mixed), 'a sent-but-unacknowledged push is unconfirmed, not delivered');
  ok(/class="evstate warn">retrying/.test(mixed), 'the existing ladder is untouched');
  // No new vocabulary: every state label must be the existing family plus the one
  // acknowledgement suffix. A separate word ("acknowledged", "verified") would be a
  // second scale the reader has to learn.
  const labels = [...mixed.matchAll(/class="evstate[^"]*">([^<]+)</g)].map((m) => m[1]);
  ok(labels.length >= 3, 'every entry states its delivery');
  ok(
    labels.every((t) => /^(delivered( \u00b7 (shown|unconfirmed))?|retrying|dead|expired)$/.test(t)),
    'the ack extends delivered/retrying/dead/expired rather than inventing a tier: ' + labels.join(' | '),
  );
}

// --- U-D: deeper memory, bounded page ---------------------------------------
{
  const deep = [];
  for (let i = 0; i < 200; i += 1) {
    const at = NOW - i * 50 * 60000; // ~7 days at 50-minute spacing
    const day = easternDate(0, at);
    deep.push(
      entry({
        key: `${day}|${String(6 + (i % 12)).padStart(2, '0')}:00|DTW`,
        announce: `${day}|${String(6 + (i % 12)).padStart(2, '0')}:00`,
        createdAt: at,
        at,
        kind: i % 3 === 0 ? 'briefing' : 'opened',
      }),
    );
  }
  const page = build({ outbox: { recent: deep, pending: 0, dead: 0, dropped: 0, retentionDays: 7 } });
  const drawn = (page.match(/<li class="ev /g) || []).length;
  ok(drawn > 0, 'a deeper log still draws');
  ok(drawn <= 32, 'but the always-open window is bounded, so the page budget does not grow with retention');
  ok(/class="evolder"/.test(page) && /<summary/.test(page), 'the rest sits behind a disclosure, not thrown away');
  ok(/Older updates/i.test(page), 'and the disclosure is named in words');
  ok(/class="evday"/.test(page), 'day headers survive into the older list');
  ok(/kind-info/.test(page) && /kind-good/.test(page), 'kind ink is preserved across the whole log, not just the window');

  // The old 24-hour store has no depth to disclose. It must not borrow the wording.
  const shallow = build({ outbox: { recent: [entry({})], pending: 0, dead: 0, dropped: 0 } });
  const section = (html) => html.slice(html.indexOf('id="updates"'), html.indexOf('</section>', html.indexOf('id="updates"')));
  ok(!/evolder/.test(section(shallow)), 'a 24-hour store does not fake a disclosure it cannot fill');
  ok(/evolder/.test(section(page)), 'and the deeper store does fill it, inside the updates block');
}

// --- the generated script still parses --------------------------------------
{
  const page = build({});
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parsed = true;
  try {
    new Function(scripts[scripts.length - 1]);
  } catch {
    parsed = false;
  }
  ok(parsed, 'the client script parses');
  ok(readFileSync(new URL('../src/render.js', import.meta.url), 'utf8').includes('focusRow('), 'the focus machinery is still the shared one');
}

console.log(`channel: ${checks} checks passed`);
