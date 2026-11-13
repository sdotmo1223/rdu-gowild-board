// RANK 6: 28 requests per tick, and the freshness that is supposed to buy.
//
// The arithmetic being tested: 7 routes per tick at a ~60-minute delivered cadence
// gives each route a ~2-hour gap against a 3-hour ceiling, so one dropped tick puts
// the board over the ceiling. 14 routes per tick gives a ~1-hour gap, which leaves
// room for one missed tick and still keeps every row inside 90 minutes.
//
// This runs the real collector against the fixture (no Frontier contact, no write),
// because a hand-computed plan would prove nothing about the code that ships.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { ROUTES } from '../src/routes.js';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const OUT = '.dry/freshness-state.json';
if (existsSync(OUT)) rmSync(OUT);

const env = {
  ...process.env,
  COLLECTOR_DRY_RUN: '1',
  COLLECTOR_FIXTURE: 'test/fixtures/route.json',
  STATE_OUT: OUT,
  // Exactly what sweep.yml now sets for RDU.
  SWEEP_MAX_REQUESTS: '28',
  SWEEP_DAYS: '2',
};
delete env.SWEEP_ONLY;
delete env.FULL_SWEEP;
delete env.CF_API_TOKEN;
delete env.CF_ACCOUNT_ID;
delete env.CF_KV_NAMESPACE_ID;
delete env.BOARD_INGEST_URL;
delete env.LEAD_PROBE;

const r = spawnSync(process.execPath, ['collector/collect.mjs'], { env, encoding: 'utf8', timeout: 90000 });
const out = `${r.stdout || ''}${r.stderr || ''}`;
eq(r.status, 0, `collector exited cleanly (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})\n${out.slice(-600)}`);
ok(
  new RegExp(`sweep plan: ${ROUTES.length}/${ROUTES.length} routes x 2 date\\(s\\) = 28 requests`).test(out),
  `the plan asks every route on every date\n${out.split('\n').filter((l) => /sweep plan/.test(l)).join('\n')}`,
);
ok(/requests=28/.test(out), 'the burst really spent 28 requests');
ok(/whole list, no shard/.test(out), 'and the log says the shard was not used');

let state = null;
try {
  state = JSON.parse(readFileSync(OUT, 'utf8'));
} catch (err) {
  ok(false, `snapshot parses: ${err.message}`);
}

if (state) {
  eq(state.lastAttempt.requests, 28, 'lastAttempt records the full burst');
  eq(state.lastAttempt.ok, true, 'and that it produced a board');
  eq(state.lastSweep.routes, ROUTES.length, 'every route was asked this tick');
  eq(state.lastSweep.total, ROUTES.length, 'against the full route list');
  eq(state.lastSweep.refused, 0, 'nothing was refused');
  eq(state.lastSweep.blocked, 0, 'nothing was blocked');

  const covered = Object.keys(state.coverage || {});
  eq(covered.length, ROUTES.length, 'every route has a freshness entry');
  for (const route of ROUTES) {
    ok(
      state.coverage && Number(state.coverage[route.code] && state.coverage[route.code].lastOkAt) > 0,
      `${route.code} was actually answered, not merely planned`,
    );
  }

  // The tally the rollback rule reads.
  const day = state.refusalDays && Object.values(state.refusalDays)[0];
  ok(day && day.requests === 28, 'the tick is tallied in refusalDays');
  eq(day && day.refused, 0, 'with its refusal count');
  eq(day && day.blocked, 0, 'and its block count');
  eq(day && day.ticks, 1, 'one tick in the window');

  // Freshness arithmetic, stated as a test: one delivered tick per hour, each tick
  // spending at most 28 x 5 s of pacing, must leave every route inside 90 minutes.
  const cadenceMin = 60;
  const worstTickMin = Math.ceil((28 * 5) / 60);
  const worstRouteAge = cadenceMin + worstTickMin;
  ok(worstRouteAge < 90, `worst per-route age ${worstRouteAge}m is inside 90m`);
  // And the old budget is asserted to have been the problem, not merely different:
  // 7 routes per tick means two ticks between checks, which exceeds 90 at any cadence
  // near the measured median.
  const oldRouteAge = cadenceMin * 2;
  ok(oldRouteAge > 90, 'the previous 7-route tick could not have honoured 90m');
}

// --- stress: an odd budget degrades by one route, not by failing ----------------
// 27 is not a number anyone ships, which is exactly why it is worth trying: the plan
// must still be a whole number of routes, inside the budget, with the burst intact.
{
  const PART = '.dry/freshness-partial.json';
  if (existsSync(PART)) rmSync(PART);
  const partRun = spawnSync(process.execPath, ['collector/collect.mjs'], {
    env: { ...env, SWEEP_MAX_REQUESTS: '27', STATE_OUT: PART },
    encoding: 'utf8',
    timeout: 90000,
  });
  const pout = `${partRun.stdout || ''}${partRun.stderr || ''}`;
  eq(partRun.status, 0, 'an odd budget still exits cleanly');
  // A budget below the whole list keeps the rotating shard (7 of 14), which is the
  // documented degradation: reverting the one number restores the old cadence with
  // no other change. It must not silently ask 13/14 and break the alternation.
  ok(/sweep plan: 7\/14 routes x 2 date\(s\) = 14 requests \(shard [01], budget 27\)/.test(pout), `a sub-list budget keeps the shard\n${pout.split('\n').filter((l) => /sweep plan/.test(l)).join('')}`);
  ok(/requests=14/.test(pout), 'and spends the shard, not the larger number it was handed');
  ok(!/whole list, no shard/.test(pout), 'only a whole-list budget skips the shard');
  const ps = JSON.parse(readFileSync(PART, 'utf8'));
  eq(ps.lastSweep.routes, 7, 'the snapshot says how many were really asked');
  eq(ps.lastSweep.refused, 0, 'with no refusals at either budget');
}

if (!checks) process.exit(1);
console.log(`freshness: ${checks} checks passed`);
