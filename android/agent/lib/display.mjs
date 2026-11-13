// Display lifecycle.
//
// The overlay mechanism is `settings put global overlay_display_devices "<W>x<H>/<DPI>"`.
// Measured on the S23 (2026-11-13):
//   * the assigned *logical* id is not fixed — two consecutive creates produced 135
//     and 136, so the id is always DISCOVERED as the difference between the display
//     list before and after, never assumed;
//   * `screencap -d` does not accept that logical id at all. It wants the
//     SurfaceFlinger physical id, joined here by display name ("Overlay #1");
//   * teardown restores the setting to `null` and the display list to exactly what
//     it was, and `mTopFocusedDisplayId` returns to 0.
//
// A left-behind overlay is treated as a failure everywhere in this file: `close()`
// reports `residue` and `withDisplay()` refuses to call a run successful when one
// remains.
import {
  readDisplays,
  readFocus,
  readSurfaceFlingerIds,
  displayZeroFingerprint,
  sameDisplayZero,
  idsOf,
  sameIds,
} from './device.mjs';
import { nowIso, waitFor, oneLine } from './util.mjs';

export const DEFAULT_GEOMETRY = { width: 720, height: 1280, dpi: 320 };

export function overlaySpec({ width, height, dpi }) {
  return `${width}x${height}/${dpi}`;
}

export function pickNewDisplay(before, after, want) {
  const known = new Set((before || []).map((display) => display.id));
  const fresh = (after || []).filter((display) => !known.has(display.id));
  if (fresh.length === 0) return null;
  return fresh.find((display) => display.width === want.width && display.height === want.height) || fresh[0];
}

export class OverlayError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'OverlayError';
    this.reason = reason;
    this.detail = detail;
  }
}

export function createDisplayManager({
  adb,
  geometry = DEFAULT_GEOMETRY,
  discoverTimeoutMs = 8000,
  pollMs = 400,
  teardownVerifyMs = 6000,
} = {}) {
  const want = { ...DEFAULT_GEOMETRY, ...geometry };
  let state = null;

  async function overlaySetting() {
    const result = await adb.shell('settings get global overlay_display_devices');
    const raw = String(result.text || '').replace(/\r/g, '').trim();
    if (!result.ok) return { value: null, readable: false, raw, detail: oneLine(result.err) };
    return { value: raw === '' ? 'null' : raw, readable: true, raw };
  }

  async function listDisplays() {
    return readDisplays(adb);
  }

  // Delete the setting until the device agrees it is gone. Bounded at two goes: a
  // delete is idempotent and cheap, but an unbounded retry loop is how a "cleanup"
  // turns into a hang.
  async function deleteSetting() {
    let setting = await overlaySetting();
    let attempts = 0;
    while (setting.value !== 'null' && attempts < 2) {
      attempts += 1;
      await adb.shell('settings delete global overlay_display_devices');
      const settled = await waitFor(() => overlaySetting(), (value) => value.value === 'null', {
        timeoutMs: teardownVerifyMs,
        pollMs,
      });
      setting = settled.value;
    }
    return { setting, attempts };
  }

  function publicState() {
    if (!state || state.pending) return null;
    return {
      id: state.id,
      sfId: state.sfId,
      sfIdSource: state.sfIdSource,
      name: state.name,
      width: state.width,
      height: state.height,
      spec: state.spec,
      openedAt: state.openedAt,
      baselineDisplays: state.baselineIds,
      focus: {
        before: state.focusBefore,
        after: state.focusAfter,
        displayZeroUnchanged: sameDisplayZero(state.focusBefore, state.focusAfter),
        topFocusedBefore: state.focusBefore?.topFocusedDisplayId ?? null,
        topFocusedAfter: state.focusAfter?.topFocusedDisplayId ?? null,
      },
    };
  }

  async function open(options = {}) {
    if (state && !state.pending) return { ok: true, reused: true, ...publicState() };
    const target = { ...want, ...(options.geometry || {}) };

    const before = await listDisplays();
    if (!before.ok) {
      return { ok: false, reason: 'display-list-unreadable', detail: oneLine(before.err) };
    }
    const baselineIds = idsOf(before.displays);
    const sfBefore = await readSurfaceFlingerIds(adb);
    const setting = await overlaySetting();

    if (!setting.readable) return { ok: false, reason: 'overlay-setting-unreadable', detail: setting.detail };
    if (setting.value !== 'null') {
      return {
        ok: false,
        refused: true,
        reason: 'overlay-setting-already-present',
        setting: setting.value,
        displays: baselineIds,
        detail: 'another overlay display is already configured; this run will not clobber it. Use the stop switch if it is stale.',
      };
    }
    if (baselineIds.some((id) => id !== 0)) {
      // Two virtual displays at once makes "which one is mine" a guess, and a guess
      // here is how an agent drives the wrong screen.
      return {
        ok: false,
        refused: true,
        reason: 'extra-displays-already-present',
        displays: baselineIds,
        detail: 'a non-zero display already exists; refusing to add a second ambiguous one.',
      };
    }

    // Stored as a display-0 fingerprint (not the whole focus dump) because every
    // comparison in this file is about display 0 specifically.
    const focusBefore = displayZeroFingerprint((await readFocus(adb)).focus);
    const spec = overlaySpec(target);
    const put = await adb.shell(`settings put global overlay_display_devices ${spec}`);
    if (!put.ok) {
      return { ok: false, reason: 'overlay-create-failed', spec, detail: oneLine(put.err || put.text) };
    }

    state = { spec, target, baselineIds, sfBefore: sfBefore.rows, focusBefore, openedAt: nowIso(), pending: true };

    try {
      const discovered = await waitFor(
        async () => {
          const now = await listDisplays();
          return { displays: now.displays, found: pickNewDisplay(before.displays, now.displays, target) };
        },
        (value) => Boolean(value.found) && value.found.width === target.width && value.found.height === target.height,
        { timeoutMs: discoverTimeoutMs, pollMs },
      );

      const found = discovered.value?.found;
      if (!found) {
        throw new OverlayError('overlay-display-never-appeared', { spec, waitedMs: discovered.waitedMs, displays: idsOf(discovered.value?.displays) });
      }
      if (found.width !== target.width || found.height !== target.height) {
        throw new OverlayError('overlay-geometry-mismatch', {
          want: `${target.width}x${target.height}`,
          got: `${found.width}x${found.height}`,
          id: found.id,
        });
      }

      // The screencap id space is separate. Join on the display name, fall back to
      // "the only virtual display that was not there before".
      const sfAfter = await waitFor(
        async () => {
          const rows = (await readSurfaceFlingerIds(adb)).rows;
          const byName = rows.find((row) => row.displayName && row.displayName === found.name) || null;
          const known = new Set((sfBefore.rows || []).map((row) => row.raw));
          const fresh = rows.filter((row) => !known.has(row.raw) && !/HWC display/i.test(row.kind));
          return { byName, fresh };
        },
        (value) => Boolean(value.byName) || value.fresh.length === 1,
        { timeoutMs: 4000, pollMs: 300 },
      );
      const sfId = sfAfter.value?.byName?.physicalId || sfAfter.value?.fresh?.[0]?.physicalId || null;
      const sfIdSource = sfAfter.value?.byName ? 'display-name' : sfId ? 'only-new-virtual' : 'none';

      const focusAfter = displayZeroFingerprint((await readFocus(adb)).focus);
      state = {
        ...state,
        pending: false,
        id: found.id,
        sfId,
        sfIdSource,
        name: found.name,
        width: found.width,
        height: found.height,
        type: found.type,
        focusAfter,
      };
      return { ok: true, created: true, ...publicState() };
    } catch (error) {
      const revert = await close({ reason: 'open-failed', force: true });
      return {
        ok: false,
        reason: error.reason || 'overlay-open-failed',
        detail: error.message,
        revert,
      };
    }
  }

  async function close({ reason = 'end', force = false } = {}) {
    const at = nowIso();
    const owned = state;
    if (!owned && !force) {
      // Nothing of ours to undo. Report the device as-is without touching it.
      const setting = await overlaySetting();
      const displays = await listDisplays();
      return {
        ok: setting.value === 'null',
        residue: setting.value !== 'null',
        skipped: true,
        reason: 'nothing-open',
        at,
        settingAfter: setting.value,
        displaysAfter: idsOf(displays.displays),
      };
    }

    const baselineIds = owned?.baselineIds || null;
    const { setting, attempts } = await deleteSetting();

    const settled = await waitFor(
      async () => (await listDisplays()).displays,
      (list) => {
        const ids = idsOf(list);
        return baselineIds ? sameIds(ids, baselineIds) : ids.every((id) => id === 0);
      },
      { timeoutMs: teardownVerifyMs, pollMs },
    );

    const focusAfter = (await readFocus(adb)).focus;
    const displaysAfter = idsOf(settled.value);
    const expected = baselineIds || [0];
    const residues = {
      setting: setting.value !== 'null' ? setting.value : null,
      displays: sameIds(displaysAfter, expected) ? null : displaysAfter,
    };
    const residue = Boolean(residues.setting || residues.displays);
    const result = {
      ok: !residue,
      residue,
      at,
      reason,
      attempts,
      settingAfter: setting.value,
      displaysAfter,
      expectedDisplays: expected,
      residues,
      focusAfter: displayZeroFingerprint(focusAfter),
      topFocusedAfter: focusAfter.topFocusedDisplayId,
      displayZeroUnchangedAcrossTeardown: owned?.focusBefore
        ? sameDisplayZero(owned.focusBefore, displayZeroFingerprint(focusAfter))
        : null,
    };
    state = null;
    return result;
  }

  // The deferred-teardown path. `close()` runs after `fn` resolves OR throws, and a
  // teardown that leaves residue makes the whole run a failure.
  async function withDisplay(fn) {
    const opened = await open();
    if (!opened.ok) {
      return { ok: false, refused: Boolean(opened.refused), reason: opened.reason, detail: opened.detail || null, opened };
    }
    let value = null;
    let error = null;
    try {
      value = await fn(opened);
    } catch (thrown) {
      error = thrown;
    }
    let teardown = null;
    try {
      teardown = await close({ reason: error ? 'action-threw' : 'complete' });
    } catch (thrown) {
      teardown = { ok: false, reason: 'teardown-threw', detail: String((thrown && thrown.message) || thrown) };
    }
    if (error) {
      error.teardown = teardown;
      throw error;
    }
    const valueOk = !value || value.ok !== false;
    return { ok: Boolean(teardown.ok) && valueOk, value, teardown, opened };
  }

  return {
    want,
    open,
    close,
    withDisplay,
    listDisplays,
    overlaySetting,
    get id() {
      return state && !state.pending ? state.id : null;
    },
    get sfId() {
      return state && !state.pending ? state.sfId : null;
    },
    get current() {
      return publicState();
    },
  };
}
