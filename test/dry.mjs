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
// NTFY_TOPIC is set on purpose (with NTFY_DRY=1 so nothing is delivered): the
// alert block is the exact code path that broke, and skipping it would make this
// harness blind to the bug it was built for.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';

const STATE = '.dry/state.json';
if (existsSync(STATE)) rmSync(STATE);

const env = {
  ...process.env,
  COLLECTOR_DRY_RUN: '1',
  COLLECTOR_FIXTURE: 'test/fixtures/route.json',
  STATE_OUT: STATE,
  NTFY_TOPIC: 'dry-run',
  NTFY_DRY: '1',
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
expect('alert block executed', /\[dry\] alert|alert sent|alert failed|WATCH=/.test(out));
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
}

if (failures.length) {
  console.error(`\nDRY: ${failures.length} failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nDRY: all checks passed (no Frontier contact, no production write)');
