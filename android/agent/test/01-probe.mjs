// Phase 0. Every claim here is answered by a command, and the probe's own create and
// teardown is part of the answer: a device that cannot be put back is not capable.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, loadLib } from './harness.mjs';
import { createFakeAdb } from './fake-adb.mjs';

const { capabilityProbe, loadProbeCache, probeSummary } = await loadLib('probe.mjs');
const s = suite('probe');

const dir = mkdtempSync(join(tmpdir(), 'agent-probe-'));
const cachePath = join(dir, 'probe.json');
const fake = createFakeAdb();
const probe = await capabilityProbe({ adb: fake, cachePath, refresh: true });

await s.eq('the Android level is read from the device', probe.device.sdk, 37);
await s.ok('input -d support comes from the usage text, not a version guess', () => probe.inputDisplayFlag === true);
await s.ok('the overlay logical id is discovered, never assumed', () => probe.overlayId === 134 && probe.overlaySfId !== String(probe.overlayId));
await s.ok('the screencap id is joined by display name', () => probe.overlaySfId === '11529215048562781705');
await s.ok('the overlay has the requested geometry', () => probe.overlaySize === '720x1280');
await s.ok('display 0 keeps the same focused app across creation', () => {
  const { displayZeroBefore, displayZeroDuring } = probe;
  return displayZeroBefore.focusedApp === displayZeroDuring.focusedApp && displayZeroBefore.focusedApp !== null;
});
await s.ok('the mCurrentFocus excursion is reported, not silently treated as a change', () => {
  const { displayZeroBefore, displayZeroDuring } = probe;
  return displayZeroBefore.currentFocus !== displayZeroDuring.currentFocus && probe.limits.some((line) => /input focus/i.test(line));
});
await s.ok('display 0 is fully restored across teardown, currentFocus included', () => {
  const { displayZeroBefore, displayZeroAfter } = probe;
  return displayZeroBefore.currentFocus === displayZeroAfter.currentFocus && displayZeroBefore.focusedApp === displayZeroAfter.focusedApp;
});
await s.ok('a real overlay capture validates end to end', () => probe.overlayCapture.ok && probe.overlayCapture.width === 720 && probe.overlayCapture.height === 1280);
await s.ok('the text stub is detected and refused, and names the id it refused', () => probe.stubProbe.detected === true && probe.stubProbe.reason === 'not-a-png' && /Failed to take take screenshot\. Display Id '999999' is not valid/.test(probe.stubProbe.text));
await s.ok('teardown leaves a null setting and exactly display 0', () => probe.teardown.settingAfter === 'null' && probe.teardown.displaysAfter.length === 1 && probe.teardown.displaysAfter[0] === 0 && probe.teardown.residue === false);
await s.ok('the probe states the focus move instead of hiding it', () => probe.limits.some((line) => /input focus/i.test(line)));
await s.eq('a capable device gets verdict ok', probe.verdict, 'ok');
await s.ok('the verdict is cached with the device it describes', () => {
  const cached = loadProbeCache(cachePath, { maxAgeMs: 60000, serial: fake.serial });
  return cached && cached.fresh === true && cached.serial === fake.serial;
});
await s.ok('an expired cache is not trusted', () => {
  const cached = loadProbeCache(cachePath, { maxAgeMs: -1 });
  return cached.fresh === false && cached.staleReason === 'expired';
});
await s.ok('another device invalidates the cache', () => {
  const cached = loadProbeCache(cachePath, { maxAgeMs: 60000, serial: 'a-different-serial' });
  return cached.fresh === false && cached.staleReason === 'different-device';
});

fake.set({ nextDisplayId: 140 });
const again = await capabilityProbe({ adb: fake, cachePath, refresh: true });
await s.ok('a second create gets a different id, which is why discovery is required', () => again.overlayId === 140 && again.overlayId !== probe.overlayId);
await s.ok('refresh:true ignores a fresh cache', () => again.fromCache !== true);
await s.ok('the summary names every fact it measured', () => /verdict\s+OK/.test(probeSummary(probe)) && /stub probe/.test(probeSummary(probe)));

s.finish();
