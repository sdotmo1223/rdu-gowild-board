// A mixed run reports a tier for every action, and the isolation seam exposes the
// same Action API with a different backend.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, loadLib } from './harness.mjs';
import { createFakeAdb } from './fake-adb.mjs';

const { runSession } = await loadLib('session.mjs');
const { loadPolicy, decide } = await loadLib('policy.mjs');
const { createIsolationBackend, SEAM_METHODS } = await loadLib('isolation.mjs');

const s = suite('tiers + isolation');

// ---------------------------------------------------------------------------
// A full scripted run on the simulated device, while the owner is active.
// ---------------------------------------------------------------------------
const fake = createFakeAdb();
const outDir = mkdtempSync(join(tmpdir(), 'agent-run-'));
const policy = loadPolicy();
const report = await runSession({
  adb: fake,
  app: 'com.freebuff.gowild',
  policy,
  outDir,
  plan: 'smoke',
  runId: 'test-smoke',
  activePath: join(outDir, 'active.json'),
});

await s.ok('a full run completes while the owner is active', () => report.ownerAtStart.verdict === 'active' && report.ok === true);
await s.ok('every step carries a tier, and both tiers appear', () => {
  const tiers = new Set(report.steps.map((step) => step.tier));
  return report.steps.every((step) => ['observe', 'virtual', 'isolated'].includes(step.tier)) && tiers.has('virtual') && tiers.has('observe');
});
await s.eq('the run counts its tiers', report.tierCounts, { observe: 3, virtual: 7 });
await s.ok('the crown invariant holds across the run', () => report.crown.applies === true && report.crown.displayZeroStable === true && report.crown.perActionViolations === 0);
await s.ok('the overlay was discovered and used, not display 0', () => report.open.id === 134 && report.steps.some((step) => step.action === 'launch' && step.ok === true));
await s.ok('captures are real PNGs of the overlay geometry', () => {
  const shots = report.steps.filter((step) => step.action === 'capture' && step.display === 134);
  return shots.length === 3 && shots.every((step) => step.width === 720 && step.height === 1280 && step.bytes > 2048 && existsSync(step.path));
});
await s.ok('the display-0 captures are observe tier and are the panel geometry', () => {
  const zero = report.steps.filter((step) => step.action === 'capture' && step.display === 0);
  return zero.length === 2 && zero.every((step) => step.tier === 'observe' && step.width === 1080);
});
await s.ok('the app is resumed on the overlay and absent from display 0', () => {
  const state = report.steps.find((step) => step.action === 'read-state' && step.resumed);
  const onOverlay = state.resumed.virtual.some((entry) => entry.package === 'com.freebuff.gowild');
  const onZero = state.resumed.displayZero.some((entry) => entry.package === 'com.freebuff.gowild');
  return onOverlay && !onZero;
});
await s.ok('the two allowed churn moments are recorded and nothing else', () => report.disruption.churnMoments.length === 2 && report.disruption.churnMoments[0].moment === 'overlay-create' && report.disruption.churnMoments[1].moment === 'overlay-teardown');
await s.ok('display-0 reads are reported with why they were allowed', () => report.disruption.displayZeroTouched.length === 2 && report.disruption.displayZeroTouched.every((touch) => /read-only/i.test(touch.why)));
await s.ok('the teardown is clean and reported', () => report.teardown.ok === true && report.teardown.settingAfter === 'null' && report.teardown.displaysAfter.join(',') === '0');
await s.ok('battery cost is a number and names its source', () => typeof report.battery.measureMah === 'number' && report.battery.source === 'batterystats-estimate');
await s.ok('the evidence is retained: run.json and a human summary', () => {
  const json = JSON.parse(readFileSync(join(outDir, 'run.json'), 'utf8'));
  const summary = readFileSync(join(outDir, 'SUMMARY.md'), 'utf8');
  return json.runId === 'test-smoke' && /The crown invariant/.test(summary) && /Every action, and the tier that ran it/.test(summary);
});
await s.ok('the summary states the invisibility limit', () => /not isolation/i.test(readFileSync(join(outDir, 'SUMMARY.md'), 'utf8')));

// ---------------------------------------------------------------------------
// Policy.
// ---------------------------------------------------------------------------
await s.ok('an allowlisted app is allowed', () => decide(policy, { app: 'com.freebuff.gowild' }).allow === true);
await s.ok('an unlisted app needs approval', () => {
  const decision = decide(policy, { app: 'com.example.rogue' });
  return decision.allow === false && decision.needsApproval === true && decision.reason === 'not-allowlisted';
});
await s.ok('an explicit approval lets an unlisted app run, and says it was approved', () => {
  const decision = decide(policy, { app: 'com.example.rogue', approvals: ['com.example.rogue'] });
  return decision.allow === true && decision.approved === true;
});
await s.ok('a sensitive app needs approval even when named in the list', () => {
  const decision = decide(policy, { app: 'com.paypal.android.p2pmobile' });
  return decision.allow === false && decision.reason === 'sensitive-needs-approval';
});
await s.ok('the isolation tier bypasses the allowlist deliberately', () => decide(policy, { app: 'com.paypal.android.p2pmobile', tier: 'isolated' }).allow === true);

const refusedRun = await runSession({ adb: createFakeAdb(), app: 'com.example.rogue', policy, outDir: join(outDir, 'refused'), runId: 'test-refused' });
await s.ok('a refused app produces a refusal record, not an exception', () => refusedRun.refused === true && refusedRun.ok === false && refusedRun.reason === 'not-allowlisted');

// ---------------------------------------------------------------------------
// Isolation seam.
// ---------------------------------------------------------------------------
const missingEmulator = createIsolationBackend({ kind: 'emulator', baseAdb: createFakeAdb(), avd: 'Pixel_9' });
const previous = process.env.EMULATOR;
process.env.EMULATOR = join(tmpdir(), 'definitely-not-an-emulator', 'emulator.exe');
const unavailable = await missingEmulator.available();
const startRefused = await missingEmulator.start();
if (previous === undefined) delete process.env.EMULATOR;
else process.env.EMULATOR = previous;

await s.ok('a missing emulator is refused with the path it looked for', () => unavailable.ok === false && unavailable.reason === 'emulator-binary-missing');
await s.ok('start() returns a refusal instead of throwing', () => startRefused.ok === false && startRefused.refused === true && startRefused.reason === 'emulator-binary-missing');

const noProfile = createIsolationBackend({ kind: 'workprofile', baseAdb: createFakeAdb() });
await s.ok('a phone with only user 0 has no work profile to isolate into', async () => {
  const available = await noProfile.available();
  const start = await noProfile.start();
  return available.ok === false && available.reason === 'no-work-profile' && start.refused === true;
});

const withProfile = createFakeAdb().set({ users: [{ id: 0, name: 'Andre Moore' }, { id: 10, name: 'Work' }] });
await withProfile.shell('settings put global overlay_display_devices 720x1280/320');
const profileBackend = createIsolationBackend({ kind: 'workprofile', baseAdb: withProfile });
const started = await profileBackend.start();
await s.ok('a work profile is found and started', () => started.ok === true && started.user === 10);
const profileActions = profileBackend.actions({ display: { id: 134, sfId: '11529215048562781705', width: 720, height: 1280 } });
const profileLaunch = await profileActions.launch('com.freebuff.gowild');
await s.ok('the isolated launch runs as the work user on the private display', () => profileLaunch.ok === true && withProfile.command(/am start --user 10 --display 134 -n com\.freebuff\.gowild/).length === 1);
await s.eq('and every isolated action is tagged isolated', profileLaunch.tier, 'isolated');

await s.ok('both backends expose the same Action API surface', () => SEAM_METHODS.every((method) => typeof profileActions[method] === 'function'));

s.finish();
