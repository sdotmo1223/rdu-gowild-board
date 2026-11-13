// Observed-red evidence, produced rather than claimed.
//
// A green suite proves nothing until it has been seen failing for the right reason.
// For each mutation below this driver copies lib/, applies one documented change that
// removes the behaviour a suite is supposed to protect, runs that suite against the
// copy, and records the checks that turn red. If a mutation does NOT turn its suite
// red, that is itself a failure of this driver and it exits non-zero.
//
//   node android/agent/test/red.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIB = join(ROOT, 'lib');
// Outside the repo on purpose: a mutated copy is scratch, and leaving it under
// android/agent/ makes the lint gate inspect deliberate sabotage.
const WORK = join(tmpdir(), 'android-agent-red');
const DOC = fileURLToPath(new URL('../../../docs/android-agent/evidence/OBSERVED-RED.md', import.meta.url));

const MUTATIONS = [
  {
    id: 'teardown-never-deletes',
    file: 'display.mjs',
    find: "while (setting.value !== 'null' && attempts < 2) {",
    replace: 'while (false) {',
    suite: '06-teardown.mjs',
    why: 'the teardown delete is skipped, so a run leaves the overlay behind',
  },
  {
    id: 'assume-display-id',
    file: 'display.mjs',
    find: 'const found = discovered.value?.found;',
    replace: "const found = { id: 134, name: 'Overlay #1', width: target.width, height: target.height, type: 'OVERLAY' };",
    suite: '01-probe.mjs',
    why: 'the assigned display id is assumed to be 134 instead of discovered',
  },
  {
    id: 'capture-accepts-stub',
    file: 'actions.mjs',
    find: 'if (!info.ok) {',
    replace: 'if (!info.ok && false) {',
    suite: '04-capture.mjs',
    why: 'a 79-byte stub is written out as if it were a screenshot',
  },
  {
    id: 'tiers-always-observe',
    file: 'actions.mjs',
    find: 'return { ok, tier, action, at: nowIso(), display: displayId, ...extra };',
    replace: "return { ok, tier: 'observe', action, at: nowIso(), display: displayId, ...extra };",
    suite: '05-actions.mjs',
    why: 'every action claims to be observe tier, so a transcript lies about what it did',
  },
  {
    id: 'guard-allows-active-owner',
    file: 'guard.mjs',
    find: "if (owner && owner.verdict === 'idle') {",
    replace: 'if (true) {',
    suite: '03-guard.mjs',
    why: 'the guard lets a display-0 action through while the owner is using the phone',
  },
  {
    id: 'stop-keeps-the-setting',
    file: 'stop.mjs',
    find: "teardown = await manager.close({ reason: 'stop-switch', force: true });",
    replace: 'teardown = { ok: true, settingAfter: setting.value, displaysAfter: idsOf(before.displays), residue: false };',
    suite: '07-stop.mjs',
    why: 'the stop switch reports success without reverting the global setting',
  },
  {
    id: 'focus-comparison-always-equal',
    file: 'device.mjs',
    find: 'return left === right;',
    replace: 'return true;',
    suite: '02-display.mjs',
    why: 'the crown invariant can never fail, so stealing focus would go unnoticed',
  },
  {
    id: 'probe-trusts-a-stale-cache',
    file: 'probe.mjs',
    find: 'if (!refresh) {',
    replace: 'if (true) {',
    suite: '01-probe.mjs',
    why: 'a cached verdict is returned even when the caller asked to re-probe',
  },
  {
    id: 'policy-allows-unlisted-apps',
    file: 'policy.mjs',
    find: ": { allow: false, needsApproval: true, reason: 'not-allowlisted', package: pkg };",
    replace: ": { allow: true, needsApproval: false, reason: 'not-allowlisted', package: pkg };",
    suite: '08-tiers-isolation.mjs',
    why: 'any package can be driven without an approval or the isolation tier',
  },
  {
    id: 'capture-ignores-geometry',
    file: 'png.mjs',
    find: 'if (expected && (width !== expected.width || height !== expected.height)) {',
    replace: 'if (false) {',
    suite: '04-capture.mjs',
    why: 'a capture of the wrong display passes as the display under test',
  },
];

function runSuite(suite, libDir = null) {
  const result = spawnSync(process.execPath, [join(ROOT, 'test', suite)], {
    encoding: 'utf8',
    env: libDir ? { ...process.env, AGENT_LIB_DIR: libDir } : process.env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const failedChecks = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('FAIL '))
    .map((line) => line.slice(5).trim());
  return { status: result.status, output, failedChecks };
}

console.log('baseline: every suite must be green before a mutation means anything');
const baseline = [];
for (const file of ['01-probe.mjs', '02-display.mjs', '03-guard.mjs', '04-capture.mjs', '05-actions.mjs', '06-teardown.mjs', '07-stop.mjs', '08-tiers-isolation.mjs']) {
  const run = runSuite(file);
  baseline.push({ file, status: run.status });
  console.log(`  ${run.status === 0 ? 'green' : 'RED  '} ${file}`);
}

const rows = [];
rmSync(WORK, { recursive: true, force: true });
for (const mutation of MUTATIONS) {
  const dir = join(WORK, mutation.id);
  mkdirSync(dir, { recursive: true });
  cpSync(LIB, join(dir, 'lib'), { recursive: true });
  const target = join(dir, 'lib', mutation.file);
  const source = readFileSync(target, 'utf8');
  const occurrences = source.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    rows.push({ ...mutation, applied: false, detail: `the pattern appears ${occurrences} times, so this mutation is stale` });
    console.log(`  STALE ${mutation.id}: pattern appears ${occurrences} times`);
    continue;
  }
  writeFileSync(target, source.replace(mutation.find, mutation.replace));
  const run = runSuite(mutation.suite, join(dir, 'lib'));
  const red = run.status !== 0;
  rows.push({ ...mutation, applied: true, exitCode: run.status, red, failedChecks: run.failedChecks });
  console.log(`  ${red ? 'red  ' : 'GREEN'} ${mutation.id} -> ${mutation.suite}${red ? ` (${run.failedChecks.join('; ') || 'non-zero exit'})` : ' — MUTATION DID NOT TURN IT RED'}`);
}

const stale = rows.filter((row) => row.applied && !row.red);
const baselineRed = baseline.filter((row) => row.status !== 0);

const lines = [];
lines.push('# Observed red — android agent harness');
lines.push('');
lines.push(`Generated by \`node android/agent/test/red.mjs\` on ${new Date().toISOString()}.`);
lines.push('');
lines.push('A suite is trusted green only after it has been seen failing for the right reason.');
lines.push('Each row below removes exactly one behaviour from a copy of `lib/`, runs the suite');
lines.push('that claims to protect it, and records which checks turned red.');
lines.push('');
lines.push(`Baseline: ${baseline.filter((row) => row.status === 0).length}/${baseline.length} suites green.`);
lines.push('');
lines.push('| mutation | file | suite | exit | went red | failing checks |');
lines.push('|---|---|---|---|---|---|');
for (const row of rows) {
  const exit = row.applied ? String(row.exitCode) : 'stale';
  lines.push(`| \`${row.id}\` | \`${row.file}\` | \`${row.suite}\` | ${exit} | ${row.red ? 'yes' : '**NO**'} | ${(row.failedChecks || []).map((check) => `\`${check}\``).join('<br>') || '—'} |`);
}
lines.push('');
lines.push('## What each mutation removes');
lines.push('');
for (const row of rows) {
  lines.push(`### \`${row.id}\``);
  lines.push('');
  lines.push(`${row.why}.`);
  lines.push('');
  lines.push('```diff');
  lines.push(`- ${row.find}`);
  lines.push(`+ ${row.replace}`);
  lines.push('```');
  lines.push('');
}
if (stale.length || baselineRed.length) {
  lines.push('## Failures of this evidence');
  lines.push('');
  for (const row of stale) lines.push(`- \`${row.id}\` did not turn \`${row.suite}\` red, so that suite is not proven.`);
  for (const row of baselineRed) lines.push(`- \`${row.file}\` was already red before any mutation.`);
  lines.push('');
} else {
  lines.push('## Result');
  lines.push('');
  lines.push(`All ${rows.length} mutations turned their suite red, and every suite was green before the mutation.`);
  lines.push('');
}

mkdirSync(join(DOC, '..'), { recursive: true });
writeFileSync(DOC, `${lines.join('\n')}\n`);
console.log(`\nwrote ${DOC}`);

if (stale.length || baselineRed.length || rows.some((row) => !row.applied)) {
  console.error('observed-red evidence is incomplete');
  process.exit(1);
}
console.log(`\nall ${rows.length} mutations turned their suite red; baseline was green`);
