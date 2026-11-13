// The acceptance tests, against the real phone.
//
// This file is deliberately NOT in run-all.mjs: it needs the device, it creates and
// reverts a real overlay display three times, and it launches a real app. Every
// criterion is read out of an evidence record rather than asserted from memory, and
// the records are written to docs/android-agent/evidence/live-<stamp>/.
//
//   node android/agent/test/live.mjs
//
// Exit codes: 0 all observed · 1 a criterion failed · 3 no device.
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createAdb, defaultAdbPath } from '../lib/adb.mjs';
import { capabilityProbe } from '../lib/probe.mjs';
import { runSession } from '../lib/session.mjs';
import { runStop } from '../lib/stop.mjs';
import { loadPolicy } from '../lib/policy.mjs';

const APP = 'com.freebuff.gowild';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = fileURLToPath(new URL(`../../../docs/android-agent/evidence/live-${stamp}`, import.meta.url));

const adb = createAdb({ adbPath: defaultAdbPath(), serial: process.env.ANDROID_SERIAL || null });
const resolved = await adb.resolveSerial();
if (!resolved.ok) {
  console.error(`no usable device: ${resolved.reason}. Acceptance tests need the phone.`);
  process.exit(3);
}

mkdirSync(OUT, { recursive: true });
console.log(`live acceptance on ${resolved.serial} · evidence ${OUT}\n`);

const policy = loadPolicy();
const results = [];
const record = (id, title, pass, evidence, note = null) => {
  results.push({ id, title, pass: Boolean(pass), evidence, note });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${title}`);
  if (note) console.log(`     ${note}`);
  for (const line of [].concat(evidence || [])) console.log(`     ${line}`);
};

// ---------------------------------------------------------------------------
console.log('Phase 0 — capability probe');
const probe = await capabilityProbe({ adb, refresh: true });
const probeOk = probe.verdict !== 'no';
record(
  '0',
  'the probe answers every capability question and leaves no residue',
  probeOk && probe.teardown.residue === false && probe.teardown.settingAfter === 'null',
  [
    `verdict ${probe.verdict.toUpperCase()} · Android ${probe.device.release} (API ${probe.device.sdk})`,
    `input -d ${probe.inputDisplayFlag ? 'supported' : 'MISSING'} · overlay logical id ${probe.overlayId} · screencap id ${probe.overlaySfId}`,
    `teardown setting=${probe.teardown.settingAfter} displays=[${probe.teardown.displaysAfter.join(', ')}] residue=${probe.teardown.residue}`,
    ...probe.limits.map((limit) => `limit: ${limit}`),
  ],
);

record(
  '1',
  'creating an overlay leaves display 0 on the same focused app',
  probe.displayZeroBefore.focusedPackage === probe.displayZeroDuring.focusedPackage && probe.displayZeroBefore.focusedPackage !== null,
  [
    `before  ${probe.displayZeroBefore.currentFocus || 'null'} / ${probe.displayZeroBefore.focusedApp || 'null'}`,
    `during  ${probe.displayZeroDuring.currentFocus || 'null'} / ${probe.displayZeroDuring.focusedApp || 'null'}`,
    `after   ${probe.displayZeroAfter.currentFocus || 'null'} / ${probe.displayZeroAfter.focusedApp || 'null'}`,
    `system focus pointer ${probe.topFocusedBefore} -> ${probe.topFocusedDuring ?? '-'} -> ${probe.topFocusedAfter}`,
    `focused package ${probe.displayZeroBefore.focusedPackage} -> ${probe.displayZeroDuring.focusedPackage}`,
  ],
  'display 0 mCurrentFocus going null while the overlay owns system focus is measured and reported, not treated as a change',
);

record(
  '5',
  'an unknown display id fails loudly instead of returning a 79-byte stub',
  probe.stubProbe.detected === true && probe.stubProbe.reason === 'not-a-png',
  [`${probe.stubProbe.bytes} bytes · reason ${probe.stubProbe.reason} · "${probe.stubProbe.text}"`],
);

// ---------------------------------------------------------------------------
console.log('\nScripted run while the owner may be using the phone');
const session = await runSession({ adb, app: APP, policy, outDir: `${OUT}/smoke`, plan: 'smoke', runId: 'live-smoke' });

const launchStep = session.steps.find((step) => step.action === 'launch');
const stateStep = session.steps.find((step) => step.action === 'read-state' && step.resumed);
const overlayShots = session.steps.filter((step) => step.action === 'capture' && step.display === session.open?.id);
const zeroShots = session.steps.filter((step) => step.action === 'capture' && step.display === 0);
const swipeStep = session.steps.find((step) => step.action === 'swipe');
const tapStep = session.steps.find((step) => step.action === 'tap');
const launchedShot = session.steps.find((step) => step.label === 'launched');
const scrolledShot = session.steps.find((step) => step.label === 'after-scroll');

record(
  '2',
  'the app launched on the discovered display is visible there and absent from display 0',
  Boolean(launchStep?.ok) &&
    Boolean(stateStep) &&
    stateStep.resumed.virtual.some((entry) => entry.package === APP) &&
    !stateStep.resumed.displayZero.some((entry) => entry.package === APP) &&
    overlayShots.length === 3 &&
    zeroShots.length === 2,
  [
    `launch ${launchStep?.component || '?'} on display ${session.open?.id}`,
    `resumed on overlay: ${(stateStep?.resumed?.virtual || []).map((entry) => entry.package).join(', ') || 'none'}`,
    `resumed on display 0: ${(stateStep?.resumed?.displayZero || []).map((entry) => entry.package).join(', ') || 'none'}`,
    `${overlayShots.length} overlay captures ${overlayShots.map((shot) => `${shot.width}x${shot.height}`).join(' ')} · ${zeroShots.length} display-0 captures ${zeroShots.map((shot) => shot.width).join(' ')}`,
  ],
  'absence from display 0 is proven by window attribution, not by pixel identity: the owner\'s own screen changes while the run is live',
);

record(
  '3',
  'display-scoped input reaches the app and never changes display 0',
  Boolean(swipeStep?.ok) &&
    Boolean(tapStep?.ok) &&
    session.crown.attributableViolations === 0 &&
    Boolean(launchedShot && scrolledShot && launchedShot.sha !== scrolledShot.sha),
  [
    `swipe argv: ${swipeStep?.argv || '?'}`,
    `tap argv: ${tapStep?.argv || '?'}`,
    `overlay pixels before/after the swipe: ${launchedShot?.sha || '?'} -> ${scrolledShot?.sha || '?'} (${launchedShot?.sha === scrolledShot?.sha ? 'identical' : 'changed, so the input landed in the app'})`,
    `display-0 changes attributable to this run: ${session.crown.attributableViolations} (${session.crown.attribution.concurrentOwnerChanges} concurrent with owner activity)`,
  ],
  launchedShot?.sha === scrolledShot?.sha ? 'input was delivered but produced no pixel change on this screen; the delivery proof is the argv and the unchanged display 0' : null,
);

record(
  '6',
  'the crown: a full run with the owner active, display 0 untouched',
  session.crown.attributableStable === true && session.ok === true,
  [
    `owner at start: ${session.ownerAtStart.verdict} (${session.ownerAtStart.signals.join(', ')})`,
    `display 0 before: ${session.crown.before.currentFocus || 'null'} / ${session.crown.before.focusedApp || 'null'}`,
    `display 0 after:  ${session.crown.afterTeardown.currentFocus || 'null'} / ${session.crown.afterTeardown.focusedApp || 'null'}`,
    `per-action focus samples differing: ${session.crown.perActionViolations} · attributable: ${session.crown.attributableViolations}`,
    `display-0 reads logged: ${session.disruption.displayZeroTouched.map((touch) => touch.action).join(', ')}`,
  ],
  'human-side confirmation from the owner is still required: the machine proves focus equality, only the owner can confirm the screen never flickered',
);

record(
  '7',
  'every action reports the tier that ran it',
  session.steps.length > 0 && session.steps.every((step) => ['observe', 'virtual', 'isolated'].includes(step.tier)) && Object.keys(session.tierCounts).length === 2,
  [`tiers: ${JSON.stringify(session.tierCounts)}`, ...session.steps.map((step) => `#${step.index} ${step.action} -> ${step.tier}`)],
);

record(
  '8',
  'battery cost is measured per run, with its source named',
  typeof session.battery.measureMah === 'number' && session.battery.source !== 'none',
  [
    `${session.battery.measureMah} mAh (${session.battery.source})${session.battery.resolutionLimited ? ' — below the counter resolution' : ''} over ${session.battery.elapsedS}s`,
    `charge counter delta ${session.battery.chargeDeltaUAh} uAh · charging ${session.battery.charging} · batterystats delta ${session.battery.drainDeltaMah} mAh`,
    ...session.battery.notes,
  ],
);

// ---------------------------------------------------------------------------
console.log('\nAcceptance 4 — a forced exception, and the deferred teardown');
const thrown = await runSession({ adb, app: APP, policy, outDir: `${OUT}/forced-throw`, plan: 'throw', runId: 'live-throw' });
record(
  '4',
  'teardown restores the phone even when the run throws mid-way',
  thrown.ok === false &&
    thrown.failed === true &&
    thrown.teardown.ok === true &&
    thrown.teardown.settingAfter === 'null' &&
    thrown.teardown.displaysAfter.length === 1 &&
    thrown.teardown.displaysAfter[0] === 0,
  [
    `forced failure: ${thrown.failure?.message || '?'}`,
    `teardown setting=${thrown.teardown.settingAfter} displays=[${thrown.teardown.displaysAfter.join(', ')}] residue=${thrown.teardown.residue}`,
    `captures kept as evidence: ${thrown.steps.filter((step) => step.path).length}`,
  ],
);

// ---------------------------------------------------------------------------
console.log('\nStop switch');
const stopped = await runStop({ adb });
record(
  'S',
  'the stop switch leaves no display, no global setting and no app of ours running',
  stopped.ok === true && stopped.leftovers.overlaySetting === 'null' && stopped.leftovers.displays.length === 1 && stopped.leftovers.displays[0] === 0,
  [
    ...stopped.actions.map((action) => `${action.action}${action.package ? ` ${action.package}` : ''} -> ${action.ok === true ? 'ok' : action.skipped ? `skipped (${action.reason})` : 'FAILED'}`),
    `apps still running: ${stopped.leftovers.appsStillRunning.map((entry) => entry.package).join(', ') || 'none'}`,
    `tasks on other displays: ${stopped.leftovers.tasksOnOtherDisplays.length}`,
  ],
);

// ---------------------------------------------------------------------------
const failed = results.filter((result) => !result.pass);
const lines = [];
lines.push('# Acceptance evidence — quiet workspace');
lines.push('');
lines.push(`Live run on \`${resolved.serial}\` · ${new Date().toISOString()}`);
lines.push('');
lines.push(`${results.length - failed.length}/${results.length} criteria observed passing.`);
lines.push('');
lines.push('| # | criterion | observed |');
lines.push('|---|---|---|');
for (const result of results) lines.push(`| ${result.id} | ${result.title} | ${result.pass ? 'pass' : '**FAIL**'} |`);
lines.push('');
for (const result of results) {
  lines.push(`## ${result.id} — ${result.title}`);
  lines.push('');
  lines.push(`**${result.pass ? 'Observed' : 'FAILED'}**`);
  lines.push('');
  for (const line of [].concat(result.evidence || [])) lines.push(`- ${line}`);
  if (result.note) {
    lines.push('');
    lines.push(`> ${result.note}`);
  }
  lines.push('');
}
lines.push('## Records');
lines.push('');
lines.push('- `smoke/run.json` + `smoke/SUMMARY.md` — the scripted run, its captures, tiers, crown and battery');
lines.push('- `forced-throw/run.json` + `forced-throw/SUMMARY.md` — the same harness failing on purpose');
lines.push('- `live.json` — this file, as data');
lines.push('');

writeFileSync(`${OUT}/ACCEPTANCE.md`, `${lines.join('\n')}\n`);
writeFileSync(`${OUT}/live.json`, `${JSON.stringify({ at: new Date().toISOString(), serial: resolved.serial, probe, results }, null, 2)}\n`);
console.log(`\n${results.length - failed.length}/${results.length} criteria observed passing`);
console.log(`evidence: ${OUT}`);
if (failed.length) {
  console.error(`FAILED criteria: ${failed.map((result) => result.id).join(', ')}`);
  process.exit(1);
}
