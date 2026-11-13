// Dry run: execute the collector's real main() end to end with zero Frontier
// contact and zero writes to production.
//
// Why this exists. On 2026-11-04 a scheduled sweep paid for all 42 Frontier
// requests and then threw `boardRows is not defined`, discarding the lot: the
// binding was declared inside one branch and read from the alert block outside it.
// Every gate was green, because `node --check` only proves a file parses and no
// test ever executed main(). Reviewers had asked for this harness three times and
// it was never built. This is that harness: it runs the same plan, parse, merge,
// alert and write path against a fixture payload, so an unresolved identifier or a
// dead branch fails a gate in under a second instead of failing the 10:18 cron.
//
// WATCH is set on purpose: the handover line names it, and the 2026-11-04 bug lived
// in the alert block that used to read it. The collector now says out loud that the
// Worker owns delivery, and this harness fails if that line ever disappears.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { easternStamp } from '../src/routes.js';

const STATE = '.dry/state.json';
if (existsSync(STATE)) rmSync(STATE);

const env = {
  ...process.env,
  COLLECTOR_DRY_RUN: '1',
  COLLECTOR_FIXTURE: 'test/fixtures/route.json',
  STATE_OUT: STATE,
  WATCH: 'ATL<=25',
  // Deterministic single-date, single-route sweep: the harness tests wiring, not
  // rotation, and the budget keeps the fixture parse cheap.
  SWEEP_ONLY: 'ATL',
  SWEEP_DAYS: '1',
  SWEEP_MAX_REQUESTS: '2',
};
delete env.CF_API_TOKEN;
delete env.CF_ACCOUNT_ID;
delete env.CF_KV_NAMESPACE_ID;
delete env.BOARD_INGEST_URL;

const r = spawnSync(process.execPath, ['collector/collect.mjs'], { env, encoding: 'utf8', timeout: 60000 });
const out = `${r.stdout || ''}${r.stderr || ''}`;
console.log(out.trim().split('\n').slice(-12).join('\n'));

const failures = [];
const expect = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name} (${detail})` : name);
};

expect('collector exited cleanly', r.status === 0, `exit ${r.status}, signal ${r.signal}`);
expect('no unresolved identifier', !/is not defined/.test(out));
expect('sweep ran to completion', /sweeps=\d+\/\d+ requests=\d+/.test(out), out.slice(-200));
// The collector no longer sends anything: the ingest call is where every watch is
// evaluated, and a second delivery path from CI is exactly the duplicate that hides a
// failure. The harness asserts the handover instead of a push.
expect('the Worker owns delivery', /alerts: the Worker owns delivery/.test(out));
expect('snapshot written', existsSync(STATE));

let state = null;
try {
  state = JSON.parse(readFileSync(STATE, 'utf8'));
} catch (err) {
  expect('snapshot parses', false, err.message);
}
if (state) {
  expect('snapshot has sweeps', Array.isArray(state.sweeps) && state.sweeps.length > 0);
  expect('snapshot records requests', Number(state.requests) > 0, String(state.requests));
  // RANK 1: an attempt that produced this snapshot must describe itself, or a dead
  // tick is indistinguishable from a clean one on /api/board.
  expect(
    'snapshot records the attempt',
    Boolean(state.lastAttempt && Number(state.lastAttempt.at) > 0),
    JSON.stringify(state.lastAttempt || null),
  );
  expect(
    'a clean attempt says ok',
    state.lastAttempt && state.lastAttempt.ok === true && state.lastAttempt.reason === 'ok',
    JSON.stringify(state.lastAttempt || null),
  );
  expect(
    'the attempt agrees with updatedAt when it succeeded',
    state.lastAttempt && state.lastAttempt.at === state.updatedAt,
    `attempt ${state.lastAttempt && state.lastAttempt.at} vs updatedAt ${state.updatedAt}`,
  );
  // The two facts the timing model and the header need from the collector itself. A
  // first-look that is never written leaves censoring blind; a coverage ledger that is
  // never written leaves the oldest-route line empty forever, and both failures are
  // invisible in the run log.
  expect(
    'first look is recorded for the date asked',
    state.firstLook && Object.keys(state.firstLook).length === 1 && Number(state.firstLook[Object.keys(state.firstLook)[0]]) > 0,
    JSON.stringify(state.firstLook || null),
  );
  expect(
    'coverage is recorded per route that answered',
    Boolean(state.coverage && state.coverage.ATL && Number(state.coverage.ATL.lastOkAt) > 0),
    JSON.stringify(state.coverage || null),
  );
  // The check that would have caught the 21:30 bug. The fixture is re-timed to keep
  // its first departure ahead of now, because a fixture whose only flight has flown
  // makes the alert block legitimately silent and the harness grade nothing. Without
  // this assertion the repair could regress and the gate would only go red at night.
  const stamp = easternStamp(Date.now());
  const legs = (state.sweeps || [])
    .flatMap((s) => (s && s.flights) || [])
    .filter((f) => f && f.dep);
  expect(
    'the fixture still has a departure ahead of now',
    legs.some((f) => String(f.dep) >= stamp),
    `${legs.length} flight(s), latest ${legs.map((f) => f.dep).sort().pop() || 'none'} vs now ${stamp}`,
  );
}

// --- The weekly lead probe, against the same fixture -------------------------
// This branch decides, once a week, to spend the whole budget on two routes and
// seven dates. It touches firstSeen, fares, the cursor and the write path, and it
// must leave state.sweeps alone -- a two-route sweep must never plant a date the
// board would then render for twelve routes nobody asked. Nothing else exercises
// it, so it runs here for free.
const PROBE_STATE = '.dry/probe-state.json';
if (existsSync(PROBE_STATE)) rmSync(PROBE_STATE);
const probeEnv = {
  ...env,
  LEAD_PROBE: 'force',
  STATE_OUT: PROBE_STATE,
  // The RDU budget, so the probe plans the real 2 routes x 7 dates rather than a
  // smaller shape than production would ever use.
  SWEEP_MAX_REQUESTS: '14',
  SWEEP_DAYS: '2',
};
delete probeEnv.SWEEP_ONLY;
delete probeEnv.FULL_SWEEP;
const pr = spawnSync(process.execPath, ['collector/collect.mjs'], { env: probeEnv, encoding: 'utf8', timeout: 60000 });
const pout = `${pr.stdout || ''}${pr.stderr || ''}`;
console.log(pout.trim().split('\n').slice(-6).join('\n'));

expect('probe: collector exited cleanly', pr.status === 0, `exit ${pr.status}, signal ${pr.signal}`);
expect('probe: the branch really ran', /lead probe: \w+,\w+ x 7 date\(s\)/.test(pout), pout.slice(-300));
expect('probe: burst stayed inside the budget', /requests=14/.test(pout), pout.slice(-300));

try {
  const ps = JSON.parse(readFileSync(PROBE_STATE, 'utf8'));
  expect('probe: state records the probe', Boolean(ps.leadProbe && ps.leadProbe.ok), JSON.stringify(ps.leadProbe || null));
  expect('probe: two routes, seven dates', ps.leadProbe && ps.leadProbe.routes.length === 2 && ps.leadProbe.dates.length === 7);
  expect('probe: the cursor moves for next week', Number.isInteger(ps.leadProbeCursor) && ps.leadProbeCursor === 2);
  // The invariant, asserted rather than assumed.
  expect('probe: never writes board rows', ps.sweeps === undefined, JSON.stringify(ps.sweeps || '').slice(0, 120));
  expect('probe: leaves the rotation alone', ps.lastShard === undefined, String(ps.lastShard));
  expect('probe: leaves the error banner alone', ps.lastError === undefined, JSON.stringify(ps.lastError || null));
  expect('probe: feeds the timing model', Number(ps.leadProbe.newFirstSeen) > 0, String(ps.leadProbe.newFirstSeen));
  // A probe asks far-out dates about two routes. Refreshing the freshness ledger for
  // those two would make the other twelve read as starving on a tick that never meant
  // to check them, so the ledger must be left exactly as it was.
  expect('probe: leaves the freshness ledger alone', ps.coverage === undefined, JSON.stringify(ps.coverage || null));
  expect(
    'probe: still records the first look for its dates',
    ps.firstLook && Object.keys(ps.firstLook).length === 7,
    JSON.stringify(ps.firstLook || null),
  );
} catch (err) {
  expect('probe: snapshot parses', false, err.message);
}

if (failures.length) {
  console.error(`\nDRY: ${failures.length} failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nDRY: all checks passed (no Frontier contact, no production write)');
