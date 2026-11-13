// Display lifecycle, and the parsers that make it possible.
//
// Two kinds of evidence here on purpose: a simulated device (deterministic, covers
// refusal and residue paths) and a verbatim slice of real dumpsys output from the S23
// (catches a fake and a parser being wrong together).
import { readFileSync } from 'node:fs';
import { suite, loadLib } from './harness.mjs';
import { createFakeAdb } from './fake-adb.mjs';

const { createDisplayManager, pickNewDisplay } = await loadLib('display.mjs');
const {
  parseDisplays,
  parseFocus,
  parseActivityDisplays,
  parseSurfaceFlingerIds,
  displayZeroFingerprint,
  sameDisplayZero,
  focusExcursion,
  physicalIdIsLossless,
  idsOf,
  sameIds,
  resumedOn,
} = await loadLib('device.mjs');

const s = suite('display');

// ---------------------------------------------------------------------------
// Real device output, captured 2026-11-13 with one overlay display present.
// ---------------------------------------------------------------------------
const fixture = readFileSync(new URL('./fixtures/real-2026-11-13.txt', import.meta.url), 'utf8');
function section(name) {
  const marker = `### ${name}\n`;
  const start = fixture.indexOf(marker);
  if (start < 0) return '';
  const body = fixture.slice(start + marker.length);
  const next = body.indexOf('\n### ');
  return next < 0 ? body : body.slice(0, next);
}

const realDisplays = parseDisplays(section('displays: overlay present'));
const realOverlay = realDisplays.find((display) => display.id !== 0);
const realZero = realDisplays.find((display) => display.id === 0);

await s.eq('real dump: two displays while an overlay exists', realDisplays.length, 2);
await s.ok('real dump: display 0 is the built-in panel at 1080x2316', () => realZero && realZero.name === 'Built-in Screen' && realZero.width === 1080 && realZero.height === 2316 && realZero.type === 'INTERNAL');
await s.ok('real dump: the overlay is named, priced by geometry, and typed OVERLAY', () => realOverlay && realOverlay.name === 'Overlay #1' && realOverlay.width === 720 && realOverlay.height === 1280 && realOverlay.type === 'OVERLAY');
await s.ok('real dump: its logical id is not 0 and not a number we may assume', () => realOverlay && realOverlay.id > 0);

const realFocusBefore = parseFocus(section('window: overlay absent'));
const realFocus = parseFocus(section('window: overlay present, app launched on it'));
await s.eq('real dump: display 0 keeps the same focused APP while the overlay owns focus', displayZeroFingerprint(realFocus).focusedApp, displayZeroFingerprint(realFocusBefore).focusedApp);
await s.ok('real dump: display 0 mCurrentFocus goes null exactly as measured', () => displayZeroFingerprint(realFocusBefore).currentFocus !== 'null' && displayZeroFingerprint(realFocus).currentFocus === 'null');
await s.ok('real dump: the crown comparison therefore passes on the real excursion', () => sameDisplayZero(displayZeroFingerprint(realFocusBefore), displayZeroFingerprint(realFocus)) === true);
await s.ok('real dump: the overlay holds the app, not display 0', () => {
  const overlay = realFocus.displays.find((display) => display.id === realOverlay.id);
  return overlay && /gowild/i.test(overlay.focusedApp || '');
});
await s.eq('real dump: the system focus pointer sits on the overlay', realFocus.topFocusedDisplayId, realOverlay.id);

const realActivities = parseActivityDisplays(section('activities: overlay present, app launched on it'));
await s.ok('real dump: the app is resumed on the overlay only', () => {
  const onOverlay = resumedOn(realActivities, realOverlay.id);
  const onZero = resumedOn(realActivities, 0);
  return onOverlay.some((entry) => entry.package === 'com.freebuff.gowild') && !onZero.some((entry) => entry.package === 'com.freebuff.gowild');
});

const realSf = parseSurfaceFlingerIds(section('surfaceflinger display ids: overlay present'));
await s.ok('real dump: the screencap id is a separate, much larger id space', () => {
  const overlayRow = realSf.find((row) => row.displayName === 'Overlay #1');
  return overlayRow && overlayRow.physicalId !== String(realOverlay.id) && overlayRow.physicalId.length >= 19;
});
await s.ok('real dump: the 64-bit id survives parsing without rounding', () => {
  const overlayRow = realSf.find((row) => row.displayName === 'Overlay #1');
  return overlayRow.physicalId === '11529215047489446367' && physicalIdIsLossless(overlayRow.physicalId) === true;
});
await s.ok('real dump: the built-in display has an HWC row', () => realSf.some((row) => /HWC display/i.test(row.kind)));

await s.ok('the crown comparison notices a changed app and tolerates a nulled currentFocus', () => {
  const a = { currentFocus: 'Window{A}', focusedApp: 'ActivityRecord{a}', focusedPackage: 'app.a' };
  const b = { currentFocus: 'Window{B}', focusedApp: 'ActivityRecord{a}', focusedPackage: 'app.a' };
  const c = { currentFocus: 'null', focusedApp: 'ActivityRecord{a}', focusedPackage: 'app.a' };
  const d = { currentFocus: 'Window{A}', focusedApp: 'ActivityRecord{d}', focusedPackage: 'app.d' };
  return sameDisplayZero(a, b) === true && sameDisplayZero(a, c) === true && sameDisplayZero(a, d) === false;
});
await s.ok('the crown comparison tolerates the owner navigating inside their own app', () => {
  const login = { focusedApp: 'ActivityRecord{198000027 u0 com.facebook.katana/.LoginActivity t5199}', focusedPackage: 'com.facebook.katana' };
  const immersive = { focusedApp: 'ActivityRecord{138991597 u0 com.facebook.katana/.immersiveactivity.ImmersiveActivity t5199}', focusedPackage: 'com.facebook.katana' };
  return sameDisplayZero(login, immersive) === true;
});
await s.ok('the display-0 fingerprint picks display 0 and reports the excursion', () => {
  const fingerprint = displayZeroFingerprint(realFocus);
  const excursion = focusExcursion(displayZeroFingerprint(realFocusBefore), fingerprint);
  return fingerprint.displayId === 0 && excursion.currentFocusChanged === true && excursion.focusedAppChanged === false;
});

// ---------------------------------------------------------------------------
// Lifecycle on the simulated device.
// ---------------------------------------------------------------------------
const fake = createFakeAdb();
const manager = createDisplayManager({ adb: fake });
const opened = await manager.open();

await s.eq('open discovers the id the device assigned', opened.id, 134);
await s.ok('open records both id spaces', () => opened.sfId === '11529215048562781705' && opened.sfIdSource === 'display-name');
await s.ok('open asserts display 0 is unchanged', () => opened.focus.displayZeroUnchanged === true);
await s.ok('open reports the focus move rather than pretending it did not happen', () => opened.focus.topFocusedBefore === 0 && opened.focus.topFocusedAfter === 134);
await s.eq('open is idempotent', (await manager.open()).reused, true);

const closed = await manager.close({ reason: 'test' });
await s.ok('close restores a null setting and exactly display 0', () => closed.settingAfter === 'null' && closed.displaysAfter.length === 1 && closed.displaysAfter[0] === 0 && closed.residue === false);
await s.ok('close asserts display 0 survived teardown', () => closed.displayZeroUnchangedAcrossTeardown === true);
await s.ok('close is idempotent and touches nothing the second time', () => {
  const second = manager.close({ reason: 'again' });
  return second.then((value) => value.skipped === true && value.ok === true);
});

const present = createDisplayManager({ adb: createFakeAdb().set({ overlaySetting: '720x1280/320' }) });
const refused = await present.open();
await s.ok('open refuses to clobber an overlay it did not create', () => refused.ok === false && refused.refused === true && refused.reason === 'overlay-setting-already-present');

const extra = createFakeAdb();
extra.set({ displays: [...extra.fake.displays, { id: 99, name: 'Ghost', width: 800, height: 600, type: 'VIRTUAL' }] });
const ambiguous = await createDisplayManager({ adb: extra }).open();
await s.ok('open refuses when another non-zero display already exists', () => ambiguous.refused === true && ambiguous.reason === 'extra-displays-already-present');

const blocked = createFakeAdb();
const blockedManager = createDisplayManager({ adb: blocked, teardownVerifyMs: 300, pollMs: 50 });
await blockedManager.open();
await blocked.failNext(/settings delete global overlay_display_devices/, { times: 5 });
const residue = await blockedManager.close({ reason: 'blocked' });
await s.ok('a teardown that cannot delete reports residue as a failure', () => residue.ok === false && residue.residue === true && residue.residues.setting === '720x1280/320');
await s.ok('residue keeps the leftover display in the report', () => residue.displaysAfter.length === 2 && residue.residues.displays.length === 2);

const success = await createDisplayManager({ adb: createFakeAdb() }).withDisplay(async (display) => ({ ok: true, id: display.id }));
await s.ok('withDisplay runs a body and tears down', () => success.ok === true && success.value.id === 134 && success.teardown.settingAfter === 'null');

const throwing = createFakeAdb();
let caught = null;
try {
  await createDisplayManager({ adb: throwing }).withDisplay(async () => {
    throw new Error('forced mid-run failure');
  });
} catch (error) {
  caught = error;
}
await s.ok('withDisplay tears down when the body throws, and rethrows', () => caught && caught.message === 'forced mid-run failure' && caught.teardown && caught.teardown.ok === true && caught.teardown.settingAfter === 'null');

const refusedWith = await createDisplayManager({ adb: createFakeAdb().set({ overlaySetting: '720x1280/320' }) }).withDisplay(async () => ({ ok: true }));
await s.ok('withDisplay returns a refusal instead of throwing', () => refusedWith.ok === false && refusedWith.refused === true);

await s.ok('pickNewDisplay prefers the fresh display with the requested geometry', () => {
  const before = [{ id: 0, width: 1080, height: 2316 }];
  const after = [...before, { id: 7, width: 800, height: 600 }, { id: 9, width: 720, height: 1280 }];
  return pickNewDisplay(before, after, { width: 720, height: 1280 }).id === 9;
});
await s.ok('id comparison is order-insensitive and length-strict', () => sameIds(idsOf([{ id: 5 }, { id: 0 }]), [0, 5]) && !sameIds([0], [0, 5]));

s.finish();
