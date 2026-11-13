// Phase 0 — the capability probe.
//
// Nothing acts before the probe speaks. It answers four questions with commands, not
// assumptions: what Android level is this, does `input` accept `-d`, what displays
// exist, and can an overlay display be created AND torn down leaving zero residue.
//
// It re-probes at the start of every session by default. A cached verdict is offered
// for reporting only, with an explicit age and a device check, because a stale
// verdict that is silently trusted is worse than no cache at all.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDisplayManager, DEFAULT_GEOMETRY } from './display.mjs';
import {
  readProps,
  readFocus,
  readDisplays,
  readSurfaceFlingerIds,
  displayZeroFingerprint,
  sameDisplayZero,
  idsOf,
} from './device.mjs';
import { inspectPng, describeCaptureFailure } from './png.mjs';
import { readOwnerState } from './guard.mjs';
import { nowIso, oneLine } from './util.mjs';

export const PROBE_CACHE_PATH = fileURLToPath(new URL('../.runs/probe.json', import.meta.url));
export const PROBE_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

export function loadProbeCache(path = PROBE_CACHE_PATH, { maxAgeMs = PROBE_CACHE_MAX_AGE_MS, serial = null } = {}) {
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8'));
    const ageMs = Date.now() - Date.parse(cache.at);
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
    const sameDevice = serial ? cache.serial === serial : true;
    return {
      ...cache,
      ageMs,
      fresh: fresh && sameDevice,
      staleReason: !fresh ? 'expired' : !sameDevice ? 'different-device' : null,
    };
  } catch {
    return null;
  }
}

export function saveProbeCache(verdict, path = PROBE_CACHE_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export async function capabilityProbe({
  adb,
  geometry = DEFAULT_GEOMETRY,
  refresh = true,
  cachePath = PROBE_CACHE_PATH,
  includeOwner = true,
} = {}) {
  if (!refresh) {
    const cached = loadProbeCache(cachePath, { serial: adb.serial });
    if (cached && cached.fresh) return { ...cached, fromCache: true };
  }

  const at = nowIso();
  const props = await readProps(adb);
  const inputUsage = await adb.shell('input');
  const inputDisplayFlag = /-d\s+DISPLAY_ID|-d\s+<display/i.test(inputUsage.text);

  const before = await readDisplays(adb);
  const sfBefore = await readSurfaceFlingerIds(adb);
  const settingBefore = (await adb.shell('settings get global overlay_display_devices')).text.replace(/\r/g, '').trim();
  const focusBefore = (await readFocus(adb)).focus;
  const owner = includeOwner ? await readOwnerState(adb) : null;

  const manager = createDisplayManager({ adb, geometry });
  const probe = {
    schema: 1,
    at,
    serial: adb.serial || null,
    device: props,
    inputDisplayFlag,
    inputUsage: oneLine(inputUsage.text.split('\n')[0] || ''),
    displaysBefore: idsOf(before.displays),
    displayTableBefore: before.displays,
    overlaySettingBefore: settingBefore === '' ? 'null' : settingBefore,
    surfaceFlingerBefore: (sfBefore.rows || []).map((row) => ({ physicalId: row.physicalId, kind: row.kind, displayName: row.displayName })),
    displayZeroBefore: displayZeroFingerprint(focusBefore),
    topFocusedBefore: focusBefore.topFocusedDisplayId,
    owner,
    open: null,
    overlayCapture: null,
    stubProbe: null,
    teardown: null,
    verdict: 'no',
    limits: [],
  };

  const opened = await manager.open();
  probe.open = opened;

  if (opened.ok) {
    probe.overlayId = opened.id;
    probe.overlaySfId = opened.sfId;
    probe.overlaySfIdSource = opened.sfIdSource;
    probe.overlayName = opened.name;
    probe.overlaySize = `${opened.width}x${opened.height}`;
    probe.topFocusedDuring = opened.focus.topFocusedAfter;
    probe.displayZeroDuring = opened.focus.after;

    // A real capture of the overlay, validated end to end.
    if (opened.sfId) {
      const shot = await adb.execOut(['screencap', '-d', String(opened.sfId), '-p']);
      const info = inspectPng(shot.out, { expected: { width: opened.width, height: opened.height } });
      probe.overlayCapture = {
        ok: info.ok,
        bytes: shot.out.length,
        width: info.width ?? null,
        height: info.height ?? null,
        reason: info.reason,
        detail: info.ok ? null : describeCaptureFailure(info),
      };
    }

    // The stub path, provoked deliberately with an id that cannot exist. This is the
    // behaviour the validator must refuse; measuring it here means the refusal is
    // proven rather than described.
    const stub = await adb.execOut(['screencap', '-d', '999999', '-p']);
    const stubInfo = inspectPng(stub.out);
    probe.stubProbe = {
      bytes: stub.out.length,
      reason: stubInfo.reason,
      detected: !stubInfo.ok,
      text: stubInfo.text || null,
    };
  }

  probe.teardown = await manager.close({ reason: 'probe', force: true });

  const after = await readDisplays(adb);
  const focusAfter = (await readFocus(adb)).focus;
  probe.displayZeroAfter = displayZeroFingerprint(focusAfter);
  probe.topFocusedAfter = focusAfter.topFocusedDisplayId;
  probe.displaysAfter = idsOf(after.displays);

  const restored = probe.teardown && probe.teardown.ok === true;
  const focusStable = sameDisplayZero(probe.displayZeroBefore, probe.displayZeroAfter);
  const captureWorks = Boolean(probe.overlayCapture && probe.overlayCapture.ok);
  const stubDetected = Boolean(probe.stubProbe && probe.stubProbe.detected);

  if (!inputDisplayFlag) probe.limits.push('this build does not advertise `input -d DISPLAY_ID`, so display-scoped input is unavailable');
  if (!opened.ok) probe.limits.push(`overlay display could not be created: ${opened.reason}`);
  if (opened.ok && !captureWorks) probe.limits.push(`the overlay cannot be captured on this build: ${probe.overlayCapture ? probe.overlayCapture.detail : 'no capture attempted'}`);
  if (!restored) probe.limits.push('teardown left residue; the stop switch is required before another run');
  if (!focusStable) probe.limits.push('display 0 changed focus across create/teardown');
  if (opened.ok && opened.focus && opened.focus.topFocusedBefore !== opened.focus.topFocusedAfter) {
    probe.limits.push(
      `the system moved input focus to the overlay display (mTopFocusedDisplayId ${opened.focus.topFocusedBefore} -> ${opened.focus.topFocusedAfter}); display 0 kept its own window, but a hardware keyboard would now type into the overlay`,
    );
  }
  if (!stubDetected) probe.limits.push('a stub capture was NOT refused, which means capture validation cannot be trusted');

  if (!inputDisplayFlag || !opened.ok || !restored) probe.verdict = 'no';
  else if (!captureWorks || !focusStable || !stubDetected) probe.verdict = 'degraded';
  else probe.verdict = 'ok';

  saveProbeCache(probe, cachePath);
  return probe;
}

export function probeSummary(probe) {
  const lines = [];
  lines.push(`device        ${probe.device.model} · Android ${probe.device.release} · API ${probe.device.sdk}`);
  lines.push(`serial        ${probe.serial || 'unknown'}`);
  lines.push(`input -d      ${probe.inputDisplayFlag ? 'supported' : 'NOT supported'}`);
  lines.push(`displays      before [${probe.displaysBefore.join(', ')}] · after [${(probe.displaysAfter || []).join(', ')}]`);
  lines.push(`overlay       ${probe.open && probe.open.ok ? `logical ${probe.overlayId} · screencap id ${probe.overlaySfId} (${probe.overlaySfIdSource}) · ${probe.overlaySize}` : `not created (${probe.open ? probe.open.reason : 'no attempt'})`}`);
  lines.push(`display 0     before ${probe.displayZeroBefore.currentFocus || 'null'} / ${probe.displayZeroBefore.focusedApp || 'null'}`);
  lines.push(`              after  ${(probe.displayZeroAfter || {}).currentFocus || 'null'} / ${(probe.displayZeroAfter || {}).focusedApp || 'null'}`);
  lines.push(`top focused   before ${probe.topFocusedBefore} · during ${probe.topFocusedDuring ?? '-'} · after ${probe.topFocusedAfter}`);
  lines.push(`capture       ${probe.overlayCapture ? `${probe.overlayCapture.ok ? 'ok' : 'FAILED'} ${probe.overlayCapture.bytes} B ${probe.overlayCapture.width || '?'}x${probe.overlayCapture.height || '?'}` : 'not attempted'}`);
  lines.push(`stub probe    ${probe.stubProbe ? `${probe.stubProbe.bytes} B · ${probe.stubProbe.reason} · ${probe.stubProbe.detected ? 'detected and refused' : 'NOT DETECTED'}` : 'not attempted'}`);
  lines.push(`teardown      setting=${probe.teardown ? probe.teardown.settingAfter : '?'} displays=[${probe.teardown ? probe.teardown.displaysAfter.join(', ') : '?'}] residue=${probe.teardown ? probe.teardown.residue : '?'}`);
  lines.push(`verdict       ${probe.verdict.toUpperCase()}`);
  for (const limit of probe.limits) lines.push(`  limit       ${limit}`);
  return lines.join('\n');
}
