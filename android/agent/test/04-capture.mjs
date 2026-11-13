// Capture validation. The device hands back exit code 0 and 79 bytes of English when
// the display id is wrong, so the only defence is inspecting the bytes.
import { readFileSync } from 'node:fs';
import { suite, loadLib } from './harness.mjs';
import { createFakeAdb, makePng, stubCapture } from './fake-adb.mjs';

const { inspectPng, describeCaptureFailure, CaptureFailure } = await loadLib('png.mjs');
const { createActions } = await loadLib('actions.mjs');

const s = suite('capture');

// The actual bytes this phone produced for `screencap -d 0 -p`, kept in the repo.
const realStub = readFileSync(new URL('./fixtures/screencap-stub-79.txt', import.meta.url));
const realInfo = inspectPng(realStub);

await s.eq('the real stub is 79 bytes', realStub.length, 79);
await s.ok('the real stub is refused as not-a-png', () => realInfo.ok === false && realInfo.reason === 'not-a-png');
await s.ok('the refusal repeats what screencap actually said, doubled word included', () => /Failed to take take screenshot\. Display Id '0' is not valid/.test(realInfo.text));
await s.ok('the human message is actionable', () => /not a PNG/.test(describeCaptureFailure(realInfo)) && /Failed to take take screenshot/.test(describeCaptureFailure(realInfo)));

await s.ok('an invented stub for another id is also refused', () => inspectPng(stubCapture('999999')).reason === 'not-a-png');
await s.ok('empty output is refused', () => inspectPng(Buffer.alloc(0)).reason === 'empty');
await s.ok('a tiny but valid PNG is refused on size', () => inspectPng(makePng(4, 4, 1)).reason === 'stub-size');
await s.ok('a plausible capture without a known geometry is accepted', () => inspectPng(makePng(400, 400, 2)).ok === true);
await s.ok('a capture of the wrong geometry is refused', () => inspectPng(makePng(720, 1280, 3), { expected: { width: 1080, height: 2316 } }).reason === 'geometry-mismatch');
await s.ok('the geometry refusal names both sizes', () => /expected 1080x2316/.test(describeCaptureFailure(inspectPng(makePng(720, 1280, 3), { expected: { width: 1080, height: 2316 } }))));

const fake = createFakeAdb();
const actions = createActions({ adb: fake, tier: 'virtual', display: { id: 134, sfId: null, width: 720, height: 1280 } });
await s.throws('the virtual tier refuses to capture without a screencap id', () => actions.capture('nope'), 'SurfaceFlinger');

const wrongId = createActions({ adb: fake, tier: 'virtual', display: { id: 134, sfId: '123456789012345', width: 720, height: 1280 } });
const error = await s.throws('a stub capture throws a loud CaptureFailure', () => wrongId.capture('stub'), 'Failed to take take screenshot');
await s.ok('the failure carries the raw bytes for the report', () => error && error.name === 'CaptureFailure' && error.detail.bytes === stubCapture('123456789012345').length && error instanceof CaptureFailure);

const goodFake = createFakeAdb();
await goodFake.shell('settings put global overlay_display_devices 720x1280/320');
const good = createActions({ adb: goodFake, tier: 'virtual', display: { id: 134, sfId: '11529215048562781705', width: 720, height: 1280 } });
const shot = await good.capture('good');
await s.ok('a valid capture reports its real geometry and a hash', () => shot.ok === true && shot.width === 720 && shot.height === 1280 && shot.bytes > 2048 && /^[0-9a-f]{12}$/.test(shot.sha));
await s.ok('a capture with no directory writes no file but still reports', () => shot.path === null);

const zero = await good.captureDisplayZero('display-zero');
await s.ok('display 0 is captured without -d, at the panel geometry', () => zero.ok === true && zero.tier === 'observe' && zero.width === 1080 && zero.height === 2316);
await s.ok('the overlay capture asked for a display id and display 0 did not', () => goodFake.command(/exec-out screencap -d /).length === 1 && goodFake.command('exec-out screencap -p').length === 1);

s.finish();
