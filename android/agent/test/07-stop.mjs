// The stop switch: no display residue, no app left running because of us, no
// connection of ours left open, and a report of anything still there.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, loadLib } from './harness.mjs';
import { createFakeAdb } from './fake-adb.mjs';

const { runStop } = await loadLib('stop.mjs');
const { writeActiveRecord, readActiveRecord } = await loadLib('report.mjs');

const s = suite('stop');
const dir = mkdtempSync(join(tmpdir(), 'agent-stop-'));

// 1. a full cleanup: display, app, connection
const fake = createFakeAdb();
await fake.shell('settings put global overlay_display_devices 720x1280/320');
await fake.shell('am start --display 134 -n com.freebuff.gowild/.MainActivity');
const recordPath = join(dir, 'active-1.json');
writeActiveRecord({ runId: 'run-1', apps: ['com.freebuff.gowild'], connection: { createdByRun: true, host: 'phone:5555' } }, recordPath);

const cleaned = await runStop({ adb: fake, recordPath });
await s.ok('stop removes the overlay setting and the display', () => cleaned.ok === true && cleaned.leftovers.overlaySetting === 'null' && cleaned.leftovers.displays.length === 1 && cleaned.leftovers.displays[0] === 0);
await s.ok('stop force-stops the app the run launched', () => cleaned.actions.some((action) => action.action === 'force-stop' && action.package === 'com.freebuff.gowild' && action.ok === true) && cleaned.leftovers.appsStillRunning.length === 0);
await s.ok('stop disconnects only because the run created the connection', () => cleaned.disconnected && cleaned.disconnected.ok === true && cleaned.actions.some((action) => action.action === 'adb-disconnect' && action.ok === true));
await s.ok('stop clears the active pointer', () => readActiveRecord(recordPath) === null);

// 2. the owner has the app on screen: do not stop it
const busy = createFakeAdb();
await busy.shell('settings put global overlay_display_devices 720x1280/320');
await busy.shell('am start -n com.freebuff.gowild/.MainActivity');
const busyPath = join(dir, 'active-2.json');
writeActiveRecord({ runId: 'run-2', apps: ['com.freebuff.gowild'], connection: { createdByRun: false } }, busyPath);
const busyResult = await runStop({ adb: busy, recordPath: busyPath });
const skipped = busyResult.actions.find((action) => action.action === 'force-stop');
await s.ok('an app the owner has on display 0 is left alone, with the reason', () => skipped && skipped.skipped === true && skipped.reason === 'resumed-on-display-0');
await s.ok('and it is reported as still running rather than quietly ignored', () => busyResult.leftovers.appsStillRunning.some((entry) => entry.package === 'com.freebuff.gowild'));
await s.ok('a connection the run did not create is not disconnected', () => busyResult.actions.some((action) => action.action === 'adb-disconnect' && action.skipped === true) && busy.fake.disconnected === false);

// 3. dry run changes nothing
const dry = createFakeAdb();
await dry.shell('settings put global overlay_display_devices 720x1280/320');
const dryPath = join(dir, 'active-3.json');
writeFileSync(dryPath, JSON.stringify({ runId: 'run-3', apps: [] }));
const dryResult = await runStop({ adb: dry, recordPath: dryPath, dryRun: true });
await s.ok('a dry run plans the deletion and performs none of it', () => dryResult.actions.some((action) => action.action === 'delete-overlay-setting' && action.planned === true) && dryResult.leftovers.overlaySetting === '720x1280/320');
await s.ok('a dry run is not reported as clean', () => dryResult.ok === false);

// 4. no record at all: the device is still put back
const orphan = createFakeAdb();
await orphan.shell('settings put global overlay_display_devices 720x1280/320');
const orphanResult = await runStop({ adb: orphan });
await s.ok('stop cleans a stale overlay even with no run record', () => orphanResult.ok === true && orphanResult.leftovers.overlaySetting === 'null' && orphanResult.runId === null);

// 5. --keep-apps
const keeping = createFakeAdb();
await keeping.shell('settings put global overlay_display_devices 720x1280/320');
await keeping.shell('am start --display 134 -n com.freebuff.gowild/.MainActivity');
const keepPath = join(dir, 'active-5.json');
writeFileSync(keepPath, JSON.stringify({ runId: 'run-5', apps: ['com.freebuff.gowild'] }));
const keepResult = await runStop({ adb: keeping, recordPath: keepPath, forceStopApps: false });
await s.ok('--keep-apps skips the stop and says why', () => keepResult.actions.some((action) => action.action === 'force-stop' && action.skipped === true && action.reason === 'disabled-by-caller'));

s.finish();
