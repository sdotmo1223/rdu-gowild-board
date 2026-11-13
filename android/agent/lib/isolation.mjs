// Tier 3 — isolation.
//
// Honest limit, first line: the virtual display is INVISIBILITY, not isolation. Same
// user, same app data, same accounts. This file exists for the case where that is not
// good enough: an app that misbehaves on a virtual display (licence checks, DRM,
// camera, a payment flow) or a flow that must not touch the owner's data at all.
//
// Two backends, one action surface, so a test script can be pointed at either without
// changing a line:
//   * emulator    — a separate Android instance on the PC. Real isolation. Needs the
//                   emulator package and an AVD; on this laptop neither is installed
//                   and hypervisor support is absent, so it answers with a refusal
//                   that names exactly what is missing.
//   * workprofile — `am start --user <n>` for an Android work profile. Separate app
//                   data on the same device. Still needs the virtual display to stay
//                   invisible, which is why it is a *data* isolation tier, not a
//                   screen one.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAdb } from './adb.mjs';
import { createActions } from './actions.mjs';
import { sleep, oneLine } from './util.mjs';

export const SEAM_METHODS = ['launch', 'tap', 'swipe', 'text', 'key', 'back', 'capture', 'captureDisplayZero', 'readState'];

export function emulatorPath() {
  if (process.env.EMULATOR) return process.env.EMULATOR;
  const local = process.env.LOCALAPPDATA || process.env.HOME || '';
  const exe = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
  return join(local, 'Android', 'Sdk', 'emulator', exe);
}

export function parseUsers(text) {
  const users = [];
  for (const match of String(text || '').matchAll(/UserInfo\{(\d+):([^:]*):/g)) {
    users.push({ id: Number(match[1]), name: match[2] });
  }
  return users;
}

export function createIsolationBackend({ kind = 'emulator', baseAdb, adbPath = null, avd = process.env.AVD || null, bootTimeoutMs = 180000 } = {}) {
  const backend = {
    tier: 'isolated',
    kind,
    serial: null,
    user: null,
    started: false,
    emulator: null,
  };

  async function listAvds() {
    const path = emulatorPath();
    if (!existsSync(path)) return { ok: false, reason: 'emulator-binary-missing', path, avds: [] };
    return new Promise((resolve) => {
      const child = spawn(path, ['-list-avds'], { windowsHide: true });
      const out = [];
      child.stdout.on('data', (b) => out.push(b));
      child.on('error', () => resolve({ ok: false, reason: 'emulator-not-runnable', path, avds: [] }));
      child.on('close', () => {
        const avds = Buffer.concat(out).toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        resolve({ ok: true, path, avds });
      });
    });
  }

  async function available() {
    if (kind === 'emulator') {
      const listed = await listAvds();
      if (!listed.ok) return { ok: false, reason: listed.reason, detail: `looked for ${listed.path}`, path: listed.path };
      if (listed.avds.length === 0) return { ok: false, reason: 'no-avd', detail: 'the emulator is installed but no AVD exists', path: listed.path };
      if (!avd) return { ok: false, reason: 'no-avd-selected', avds: listed.avds };
      if (!listed.avds.includes(avd)) return { ok: false, reason: 'avd-not-found', avd, avds: listed.avds };
      return { ok: true, path: listed.path, avd };
    }
    if (kind === 'workprofile') {
      const users = await baseAdb.shell('pm list users');
      const others = parseUsers(users.text).filter((user) => user.id !== 0);
      if (others.length === 0) return { ok: false, reason: 'no-work-profile', detail: 'pm list users shows only user 0' };
      return { ok: true, user: others[0].id, users: parseUsers(users.text) };
    }
    return { ok: false, reason: 'unknown-backend', kind };
  }

  async function start() {
    const ready = await available();
    if (!ready.ok) return { ok: false, refused: true, backend: kind, reason: ready.reason, detail: ready.detail || null, ...ready };

    if (kind === 'emulator') {
      const child = spawn(
        ready.path,
        ['-avd', ready.avd, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-gpu', 'swiftshader_indirect'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
      backend.emulator = child.pid || null;
      backend.serial = 'emulator-5554';
      const emu = createAdb({ adbPath: adbPath || baseAdb.state.adbPath, serial: backend.serial, timeoutMs: 20000 });
      const deadline = Date.now() + bootTimeoutMs;
      let booted = false;
      while (Date.now() < deadline) {
        const boot = await emu.shell('getprop sys.boot_completed');
        if (boot.text.trim() === '1') {
          booted = true;
          break;
        }
        await sleep(2000);
      }
      backend.started = booted;
      return booted
        ? { ok: true, backend: kind, serial: backend.serial, avd: ready.avd, pid: backend.emulator }
        : { ok: false, backend: kind, reason: 'emulator-did-not-boot', serial: backend.serial, waitedMs: bootTimeoutMs };
    }

    backend.user = ready.user;
    backend.serial = baseAdb.serial;
    backend.started = true;
    return { ok: true, backend: kind, serial: backend.serial, user: backend.user };
  }

  async function stop() {
    const notes = [];
    if (kind === 'emulator' && backend.started && backend.serial) {
      const emu = createAdb({ adbPath: adbPath || baseAdb.state.adbPath, serial: backend.serial });
      const killed = await emu.shell('emu kill');
      notes.push({ action: 'emu kill', ok: killed.ok, output: oneLine(killed.text || killed.err) });
    }
    backend.started = false;
    return { ok: true, backend: kind, notes };
  }

  // The same Action API, tagged `isolated`, so a caller's transcript distinguishes
  // "drove a private screen" from "drove a separate device/user".
  function actions({ display = null, outDir = null } = {}) {
    const emu = kind === 'emulator' && backend.serial
      ? createAdb({ adbPath: adbPath || baseAdb.state.adbPath, serial: backend.serial })
      : baseAdb;
    return createActions({ adb: emu, tier: 'isolated', display, outDir, user: kind === 'workprofile' ? backend.user : null });
  }

  return { ...backend, available, start, stop, actions, listAvds, describe: () => ({ tier: 'isolated', kind, serial: backend.serial, user: backend.user }) };
}
