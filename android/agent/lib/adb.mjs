// The one place that knows how to reach adb.
//
// Two properties matter more than convenience:
//   1. every call is serial-targeted, because this machine can have a USB device and
//      a wireless one at the same time and guessing is how you tap the wrong phone;
//   2. the harness records whether *it* created the connection, because the stop
//      switch is only allowed to disconnect a connection the run created.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function defaultAdbPath() {
  if (process.env.ADB) return process.env.ADB;
  const local = process.env.LOCALAPPDATA || process.env.HOME || '';
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [local && join(local, 'Android', 'Sdk', 'platform-tools', exe), 'adb'];
  for (const candidate of candidates) {
    if (candidate && (candidate === 'adb' || existsSync(candidate))) return candidate;
  }
  return 'adb';
}

export function parseDevices(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || /^List of devices/.test(line) || /^\*/.test(line)) continue;
    const [serial, state] = line.trim().split(/\s+/);
    if (!serial || !state) continue;
    out.push({ serial, state });
  }
  return out;
}

export function createAdb({ adbPath = defaultAdbPath(), serial = null, timeoutMs = 30000 } = {}) {
  const state = { adbPath, serial, calls: 0, connection: { createdByRun: false, host: null, at: null } };

  function argvWithSerial(argv, withSerial) {
    const out = [];
    if (withSerial && state.serial) out.push('-s', state.serial);
    return out.concat(argv);
  }

  function run(argv, { input = null, timeout = timeoutMs, withSerial = true } = {}) {
    const full = argvWithSerial(argv, withSerial);
    return new Promise((resolve) => {
      const started = Date.now();
      state.calls += 1;
      let child;
      try {
        child = spawn(state.adbPath, full, { windowsHide: true });
      } catch (error) {
        resolve({ ok: false, code: 'spawn-error', out: Buffer.alloc(0), text: '', err: String(error.message), argv: full, ms: 0 });
        return;
      }
      const out = [];
      const err = [];
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, timeout);
      const finish = (code, extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const buf = Buffer.concat(out);
        resolve({
          ok: code === 0,
          code,
          out: buf,
          text: buf.toString('utf8'),
          err: Buffer.concat(err).toString('utf8'),
          argv: full,
          ms: Date.now() - started,
          ...extra,
        });
      };
      child.stdout.on('data', (b) => out.push(b));
      child.stderr.on('data', (b) => err.push(b));
      child.on('error', (error) => finish('spawn-error', { err: String(error.message) }));
      child.on('close', (code) => finish(timedOut ? 'timeout' : code));
      child.stdin.on('error', () => {});
      child.stdin.end(input || undefined);
    });
  }

  // A shell command goes over as ONE argument so the device side re-parses it the
  // way a terminal would. Passing it as many argv items makes `input text 'a b'`
  // depend on adb's own re-joining rules.
  async function shell(command, opts = {}) {
    const text = Array.isArray(command) ? command.join(' ') : String(command);
    return run(['shell', text], opts);
  }

  async function execOut(args, opts = {}) {
    return run(['exec-out'].concat(args), opts);
  }

  async function devices() {
    const result = await run(['devices', '-l'], { withSerial: false });
    return { ...result, devices: parseDevices(result.text) };
  }

  async function resolveSerial() {
    if (state.serial) return { ok: true, serial: state.serial, source: 'given' };
    const listed = await devices();
    const ready = listed.devices.filter((entry) => entry.state === 'device');
    if (ready.length === 0) {
      return { ok: false, reason: 'no-device', detail: listed.text.trim(), candidates: listed.devices };
    }
    if (ready.length > 1) {
      // Owner rule: never assume which device. A wrong pick taps the wrong phone.
      return { ok: false, reason: 'ambiguous-serial', candidates: ready };
    }
    state.serial = ready[0].serial;
    return { ok: true, serial: state.serial, source: 'discovered' };
  }

  async function connect(host) {
    const result = await run(['connect', host], { withSerial: false, timeout: 15000 });
    const ok = /connected to/i.test(result.text) && !/failed|cannot/i.test(result.text);
    if (ok) state.connection = { createdByRun: true, host, at: new Date().toISOString() };
    return { ok, host, text: result.text.trim() };
  }

  async function disconnect(target = state.serial) {
    if (!target) return { ok: false, reason: 'no-serial', text: '' };
    const result = await run(['disconnect', target], { withSerial: false, timeout: 15000 });
    return { ok: result.ok, serial: target, text: result.text.trim() };
  }

  return {
    state,
    run,
    shell,
    execOut,
    devices,
    resolveSerial,
    connect,
    disconnect,
    get serial() {
      return state.serial;
    },
    get calls() {
      return state.calls;
    },
    get connection() {
      return state.connection;
    },
  };
}
