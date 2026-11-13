// Every exit path tears down: success, throw, interrupt-shaped rejection, refusal.
// Plus the crash-safety pointer the stop switch reads.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, loadLib } from './harness.mjs';
import { createFakeAdb } from './fake-adb.mjs';

const { createDisplayManager } = await loadLib('display.mjs');
const { writeActiveRecord, readActiveRecord, clearActiveRecord } = await loadLib('report.mjs');

const s = suite('teardown');
const clean = (teardown) => teardown && teardown.ok === true && teardown.settingAfter === 'null' && teardown.displaysAfter.length === 1 && teardown.displaysAfter[0] === 0;

// 1. success
const okFake = createFakeAdb();
const okManager = createDisplayManager({ adb: okFake });
const okRun = await okManager.withDisplay(async (display) => ({ ok: true, id: display.id }));
await s.ok('success: the body ran on the discovered display and the phone is clean', () => okRun.ok === true && okRun.value.id === 134 && clean(okRun.teardown));
await s.ok('success: the manager forgets the display so a second close is a no-op', () => okManager.id === null && okManager.current === null);

// 2. throw
const throwFake = createFakeAdb();
const throwManager = createDisplayManager({ adb: throwFake });
let thrown = null;
try {
  await throwManager.withDisplay(async () => {
    throw new Error('exploded halfway');
  });
} catch (error) {
  thrown = error;
}
await s.ok('throw: the error still reaches the caller', () => thrown && thrown.message === 'exploded halfway');
await s.ok('throw: the teardown is attached to the error', () => thrown && clean(thrown.teardown));
await s.ok('throw: the device is genuinely clean, not just reported clean', async () => {
  const setting = await throwFake.shell('settings get global overlay_display_devices');
  const displays = await throwFake.shell('dumpsys display');
  return setting.text.trim() === 'null' && (displays.text.match(/^  Display \d+:/gm) || []).length === 1;
});

// 3. interrupt-shaped rejection
const abortFake = createFakeAdb();
let interrupted = null;
try {
  await createDisplayManager({ adb: abortFake }).withDisplay(async () => {
    const error = new Error('interrupted by the owner');
    error.name = 'AbortError';
    throw error;
  });
} catch (error) {
  interrupted = error;
}
await s.ok('interrupt: an AbortError tears down like any other exit', () => interrupted && interrupted.name === 'AbortError' && clean(interrupted.teardown));

// 4. refusal: nothing was created, so nothing is deleted, and nothing is claimed
const busyFake = createFakeAdb().set({ overlaySetting: '720x1280/320' });
const refused = await createDisplayManager({ adb: busyFake }).withDisplay(async () => ({ ok: true }));
await s.ok('refusal: a pre-existing overlay is reported, not adopted or deleted', () => refused.ok === false && refused.refused === true && busyFake.command(/settings delete/).length === 0);

// 5. residue is a failure, not a warning
const stuck = createFakeAdb();
const stuckManager = createDisplayManager({ adb: stuck, teardownVerifyMs: 300, pollMs: 50 });
await stuckManager.open();
stuck.failNext(/settings delete global overlay_display_devices/, { times: 5 });
const stuckRun = await stuckManager.withDisplay(async () => ({ ok: true }));
await s.ok('residue: a run that cannot tear down is not ok', () => stuckRun.ok === false);
await s.ok('residue: the leftover setting is named', () => stuckRun.teardown.residue === true && stuckRun.teardown.residues.setting !== null);

// 6. the crash-safety pointer
const dir = mkdtempSync(join(tmpdir(), 'agent-pointer-'));
const path = join(dir, 'active.json');
writeActiveRecord({ runId: 'r-1', apps: ['com.freebuff.gowild'], connection: { createdByRun: true } }, path);
await s.ok('the active pointer survives a crash for the stop switch to find', () => readActiveRecord(path)?.runId === 'r-1');
clearActiveRecord(path);
await s.ok('the pointer is removed once teardown succeeds', () => readActiveRecord(path) === null);

s.finish();
