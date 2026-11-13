// TASK A: the BRIEFING tier -- one push a day that says what today looks like.
//
// The rule that matters is the deal-currency line: "cheapest DTW fare seen in 14
// days" is only allowed when the history can actually support it. Fewer than five
// observations means the line is omitted entirely, because a percentile computed
// from three numbers is a guess wearing a percentage.
import assert from 'node:assert/strict';
import { buildBriefing, farePercentile, MIN_HISTORY_POINTS } from '../src/briefing.mjs';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0); // 07:00 ET, after the 06:00 briefing
const TODAY = '2026-11-13';

// A tiny observation record: n fares for one route over the window.
function historyFor(dest, fares, dates) {
  return fares.map((allin, i) => ({
    ts: NOW - (i + 1) * 3600000,
    date: dates ? dates[i % dates.length] : '2026-11-12',
    dest,
    dep: `${dates ? dates[i % dates.length] : '2026-11-12'} 10:12:00`,
    stops: 'Nonstop',
    allin,
  }));
}

const state = {
  updatedAt: NOW - 5 * 60000,
  lastSweep: { at: NOW - 5 * 60000, routes: 14, ok: 28, refused: 0 },
  coverage: { DTW: { lastOkAt: NOW - 5 * 60000, fails: 0, lastReason: 'ok' } },
  history: [
    ...historyFor('DTW', [15.41, 17.2, 22.5, 15.41, 30.1, 19.9]),
    ...historyFor('ATL', [15.41, 15.41]), // thin: two points only
  ],
  days: {},
};

const board = {
  dates: [
    {
      date: TODAY,
      status: 'ok',
      total: 1,
      rows: [{ dest: 'DTW', city: 'Detroit', date: TODAY, dep: `${TODAY} 15:30:00`, allin: 15.41, stops: 'Nonstop', seats: null }],
    },
  ],
  stale: false,
  ageMin: 5,
};

const settings = { briefing: true, briefingTime: '06:00', health: true, windowDays: 2 };

// --- 1. percentile machinery --------------------------------------------------
{
  eq(MIN_HISTORY_POINTS, 5, 'five observations is the floor for a percentile');
  const p = farePercentile(state, 'DTW', 15.41, NOW);
  ok(p, 'DTW has enough history for a percentile');
  eq(p.n, 6, 'the count behind it is reported');
  ok(p.pct <= 20, 'the cheapest fare sits at the bottom of its own distribution');
  eq(farePercentile(state, 'ATL', 15.41, NOW), null, 'two points is not enough, and says so by returning null');
  eq(farePercentile(state, 'NOPE', 15.41, NOW), null, 'an unknown route is null');
}

// --- 2. the briefing itself ---------------------------------------------------
{
  const b = buildBriefing(state, board, settings, NOW);
  ok(b, 'a briefing is produced');
  eq(b.tier, 'briefing', 'it names its tier');
  eq(b.kind, 'briefing', 'and its kind');
  ok(/Nov 13|2026-11-13/.test(b.title), 'the title carries the date it is about');
  ok(/DTW/.test(b.message) && /15\.41/.test(b.message), 'the best deal is named');
  ok(/14 days/i.test(b.message), 'the deal-currency line states its window');
  ok(/seen \d+ times|cheapest/i.test(b.message), 'and speaks in observations, not vibes');
  ok(b.clickPath && b.clickPath.startsWith('/rdu'), 'it opens the board');
  ok(!/token/i.test(b.clickPath), 'without a token');
}

// --- 3. thin history omits the line rather than guessing ----------------------
{
  const thin = { ...state, history: historyFor('ATL', [15.41, 16.0]) };
  const thinBoard = {
    dates: [
      { date: TODAY, status: 'ok', total: 1, rows: [{ dest: 'ATL', date: TODAY, dep: `${TODAY} 09:00:00`, allin: 15.41, stops: 'Nonstop' }] },
    ],
    stale: false,
    ageMin: 5,
  };
  const b = buildBriefing(thin, thinBoard, settings, NOW);
  ok(b, 'a briefing still exists with thin history');
  ok(!/14 days/i.test(b.message), 'but the percentile line is absent');
}

// --- 4. honest emptiness ------------------------------------------------------
{
  const emptyBoard = { dates: [{ date: TODAY, status: 'no-gowild', total: 0, rows: [] }], stale: false, ageMin: 5 };
  const b = buildBriefing(state, emptyBoard, settings, NOW);
  ok(b, 'a briefing is sent even when today offers nothing');
  ok(/nothing|no GoWild|empty/i.test(b.message), 'and says so plainly instead of being silent');
}

// --- 5. stale and broken state are stated, not hidden -------------------------
{
  const staleBoard = { dates: [], stale: true, ageMin: 240 };
  const b = buildBriefing({ ...state, updatedAt: NOW - 240 * 60000 }, staleBoard, settings, NOW);
  ok(/stale|hours old|not been re-checked/i.test(b.message), 'a stale board is named in the briefing');
}

console.log(`briefing: ${checks} checks passed`);
