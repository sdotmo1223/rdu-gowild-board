// The Action API.
//
// Every action is display-scoped and every result carries the tier that executed it,
// so a transcript says not just "a tap happened" but "a tap happened on the private
// overlay display, and display 0 was never targeted". Input without a display is
// refused by construction: there is no code path here that can tap display 0 by
// accident, which is a stronger guarantee than checking a flag at each call site.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFocus, readPower, readActivityDisplays, resumedOn } from './device.mjs';
import { inspectPng, describeCaptureFailure, CaptureFailure } from './png.mjs';
import { nowIso, oneLine, shortHash } from './util.mjs';

const slug = (value) => String(value || 'shot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shot';

export function createActions({ adb, tier = 'virtual', display = null, outDir = null, user = null } = {}) {
  let shots = 0;
  const displayId = display && display.id != null ? display.id : null;

  function result(action, ok, extra = {}) {
    return { ok, tier, action, at: nowIso(), display: displayId, ...extra };
  }

  function outOfBounds(x, y) {
    if (!display || display.width == null || display.height == null) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return `coordinates must be numbers, got ${x},${y}`;
    if (x < 0 || y < 0 || x >= display.width || y >= display.height) {
      return `${Math.round(x)},${Math.round(y)} is outside ${display.width}x${display.height}`;
    }
    return null;
  }

  async function resolveComponent(pkg) {
    const attempts = [
      `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`,
      `cmd package resolve-activity --brief ${pkg}`,
    ];
    for (const command of attempts) {
      const response = await adb.shell(command);
      const lines = response.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const candidate = [...lines].reverse().find((line) => /^[\w.]+\/[\w.$]+$/.test(line));
      if (candidate) return candidate;
    }
    return null;
  }

  async function launch(pkg, options = {}) {
    if (!pkg) return result('launch', false, { reason: 'no-package' });
    if (tier === 'virtual' && displayId == null) {
      return result('launch', false, { package: pkg, reason: 'virtual-tier-needs-display' });
    }
    const component = options.component || (await resolveComponent(pkg));
    if (!component) {
      return result('launch', false, { package: pkg, reason: 'component-unresolved', detail: `no launcher activity found for ${pkg}` });
    }
    const parts = ['am', 'start'];
    if (user != null) parts.push('--user', String(user));
    if (displayId != null) parts.push('--display', String(displayId));
    parts.push('-n', component);
    for (const extra of options.amArgs || []) parts.push(String(extra));

    const response = await adb.shell(parts.join(' '));
    const output = oneLine(`${response.text} ${response.err}`);
    const failed = !response.ok || /\bError\b|\bException\b|does not exist|not found/i.test(output);
    return result('launch', !failed, {
      package: pkg,
      component,
      argv: parts.join(' '),
      ms: response.ms,
      output,
      reason: failed ? 'am-start-failed' : null,
    });
  }

  function inputArgs(command) {
    // An isolated backend may drive a device whose only display is its own default,
    // and then there is no -d to give. The virtual tier still cannot reach here
    // without a discovered id.
    return displayId == null ? `input ${command}` : `input -d ${displayId} ${command}`;
  }

  async function tap(x, y, options = {}) {
    if (tier === 'virtual' && displayId == null) {
      return result('tap', false, { reason: 'input-needs-display', detail: 'input is only ever sent with -d <discovered id>' });
    }
    const invalid = outOfBounds(x, y);
    if (invalid) return result('tap', false, { reason: 'out-of-bounds', detail: invalid, x, y });
    const argv = inputArgs(`tap ${Math.round(x)} ${Math.round(y)}`);
    const response = await adb.shell(argv);
    return result('tap', response.ok, {
      x: Math.round(x),
      y: Math.round(y),
      label: options.label || 'tap',
      argv,
      ms: response.ms,
      output: oneLine(response.err || response.text),
      reason: response.ok ? null : 'input-failed',
    });
  }

  async function swipe(x1, y1, x2, y2, durationMs = 300, options = {}) {
    if (tier === 'virtual' && displayId == null) return result('swipe', false, { reason: 'input-needs-display' });
    const invalid = outOfBounds(x1, y1) || outOfBounds(x2, y2);
    if (invalid) return result('swipe', false, { reason: 'out-of-bounds', detail: invalid });
    const argv = inputArgs(`swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`);
    const response = await adb.shell(argv);
    return result('swipe', response.ok, {
      from: [Math.round(x1), Math.round(y1)],
      to: [Math.round(x2), Math.round(y2)],
      label: options.label || 'swipe',
      argv,
      ms: response.ms,
      reason: response.ok ? null : 'input-failed',
    });
  }

  async function text(value, options = {}) {
    if (tier === 'virtual' && displayId == null) return result('text', false, { reason: 'input-needs-display' });
    if (typeof value !== 'string' || value === '') return result('text', false, { reason: 'empty-text' });
    // Device-side shell quoting: single quotes survive, spaces become %s.
    const escaped = value.replace(/'/g, "'\\''").replace(/ /g, '%s');
    const argv = inputArgs(`text '${escaped}'`);
    const response = await adb.shell(argv);
    return result('text', response.ok, {
      characters: value.length,
      label: options.label || 'text',
      argv,
      ms: response.ms,
      reason: response.ok ? null : 'input-failed',
    });
  }

  async function key(code, options = {}) {
    if (tier === 'virtual' && displayId == null) return result('key', false, { reason: 'input-needs-display' });
    const argv = inputArgs(`keyevent ${code}`);
    const response = await adb.shell(argv);
    return result('key', response.ok, { code, label: options.label || `key-${code}`, argv, ms: response.ms });
  }

  async function back(options = {}) {
    return key(4, { label: options.label || 'back' });
  }

  // Captures throw CaptureFailure on purpose: a 79-byte text stub must stop the run
  // loudly, not become a PNG file that a later reader treats as evidence.
  async function capture(label = null) {
    if (!display) throw new CaptureFailure('capture needs a display object', { display: displayId });
    if (tier === 'virtual' && !display.sfId) {
      throw new CaptureFailure('capture needs a display with a SurfaceFlinger id', {
        display: displayId,
        detail: 'the logical id is not the id screencap accepts',
      });
    }
    const response = display.sfId
      ? await adb.execOut(['screencap', '-d', String(display.sfId), '-p'])
      : await adb.execOut(['screencap', '-p']);
    const expected = display.width && display.height ? { width: display.width, height: display.height } : null;
    const info = inspectPng(response.out, { expected });
    if (!info.ok) {
      throw new CaptureFailure(describeCaptureFailure(info), {
        info,
        display: displayId,
        sfId: display.sfId,
        bytes: response.out.length,
        argv: response.argv,
      });
    }
    shots += 1;
    const name = label || `capture-${shots}`;
    const path = outDir ? join(outDir, `${String(shots).padStart(2, '0')}-${slug(name)}.png`) : null;
    if (path) writeFileSync(path, response.out);
    return result('capture', true, {
      label: name,
      path,
      bytes: info.bytes,
      width: info.width,
      height: info.height,
      sha: shortHash(response.out),
      sfId: display.sfId,
      ms: response.ms,
    });
  }

  // Display 0 read-only capture. No `-d`, because on this build `-d 0` is invalid
  // and `screencap -p` already means the default display.
  async function captureDisplayZero(label = 'display-zero', expected = null) {
    const response = await adb.execOut(['screencap', '-p']);
    const info = inspectPng(response.out, { expected: expected || undefined });
    if (!info.ok) throw new CaptureFailure(describeCaptureFailure(info), { info, display: 0, bytes: response.out.length });
    shots += 1;
    const path = outDir ? join(outDir, `${String(shots).padStart(2, '0')}-${slug(label)}.png`) : null;
    if (path) writeFileSync(path, response.out);
    return { ok: true, tier: 'observe', action: 'capture', at: nowIso(), display: 0, label, path, bytes: info.bytes, width: info.width, height: info.height, sha: shortHash(response.out), ms: response.ms };
  }

  async function readState() {
    const [focus, power, activity] = await Promise.all([readFocus(adb), readPower(adb), readActivityDisplays(adb)]);
    return result('read-state', true, {
      tier: 'observe',
      focus: focus.fingerprint,
      topFocusedDisplayId: focus.focus.topFocusedDisplayId,
      wakefulness: power.power.wakefulness,
      resumed: {
        displayZero: resumedOn(activity.displays, 0),
        virtual: displayId == null ? [] : resumedOn(activity.displays, displayId),
      },
    });
  }

  return { tier, display: displayId, launch, tap, swipe, text, key, back, capture, captureDisplayZero, readState, resolveComponent, outOfBounds };
}
