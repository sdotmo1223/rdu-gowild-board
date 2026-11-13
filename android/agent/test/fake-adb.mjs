// A simulated device transport for the offline suites.
//
// It is modelled on measurements, not on hopes:
//   * `screencap -d <logical id>` answers the real 79-byte text stub;
//   * `screencap -d <SurfaceFlinger id>` answers a real PNG of the right geometry;
//   * creating an overlay moves `mTopFocusedDisplayId` to it, because the S23 did;
//   * the assigned display id increments, so a parser that assumes one fails.
//
// A fake that agrees with a wrong parser proves nothing, which is why test 02 also
// parses a verbatim slice of real dumpsys output.
import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable = null;
function crcOf(buffer) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crcOf(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

// A valid 8-bit RGBA PNG whose bytes change when `seed` changes, so "did the screen
// change" is answerable with a hash instead of a pixel decoder.
export function makePng(width, height, seed = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  let state = (seed * 2654435761 + width * 97 + height * 31) >>> 0;
  for (let y = 0; y < height; y += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const row = Buffer.alloc(1 + width * 4);
    row[1] = state & 0xff;
    row[2] = (state >>> 8) & 0xff;
    row[3] = (state >>> 16) & 0xff;
    row[4] = 0xff;
    rows.push(row);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// Verbatim device output, doubled word and all: the screencap binary prints
// "Failed to take " and then "take screenshot...". Captured 2026-11-13.
export function stubCapture(id) {
  return Buffer.from(`Failed to take take screenshot. Display Id '${id}' is not valid.\nCapturing failed.\n`, 'utf8');
}

const INPUT_USAGE = `Usage: input [<source>] [-d DISPLAY_ID] <command> [<arg>...]

The sources are:
      touchnavigation
      touchscreen
      keyboard
`;

function matches(pattern, command) {
  if (pattern instanceof RegExp) return pattern.test(command);
  return command.includes(pattern);
}

export function createFakeAdb(options = {}) {
  const serial = options.serial || 'fake-serial';
  const device = {
    sdk: options.sdk || 37,
    model: options.model || 'SM-S918U',
    release: options.release || '17',
    displays: [{ id: 0, name: 'Built-in Screen', width: 1080, height: 2316, type: 'INTERNAL' }],
    nextDisplayId: options.nextDisplayId || 134,
    overlayCount: 0,
    overlaySetting: 'null',
    focus: {
      top: 0,
      byDisplay: {
        0: {
          currentFocus: 'Window{258dd38 u0 NotificationShade}',
          focusedApp: 'ActivityRecord{56583794 u0 com.android.chrome/com.google.android.apps.chrome.Main t5213}',
        },
      },
    },
    apps: {},
    pids: {},
    appTouches: {},
    inputEvents: 0,
    battery: { level: 100, chargeCounterUAh: 4650000, powered: { ac: true, usb: false, wireless: false }, computedDrainMah: 1234 },
    wakefulness: 'Awake',
    keyguard: false,
    inCall: false,
    users: [{ id: 0, name: 'Andre Moore' }],
    knownPackages: ['com.freebuff.gowild', 'com.android.deskclock', 'com.android.settings', 'com.android.chrome', 'com.example.rogue'],
    sfIds: new Map([['Built-in Screen', '4630947093241269891']]),
    failures: [],
    calls: [],
    captures: 0,
    disconnected: false,
  };

  const calls = device.calls;

  function takeFailure(command) {
    for (let index = 0; index < device.failures.length; index += 1) {
      const failure = device.failures[index];
      if (!matches(failure.pattern, command)) continue;
      failure.times -= 1;
      if (failure.times <= 0) device.failures.splice(index, 1);
      return failure;
    }
    return null;
  }

  function renderDisplays() {
    const lines = [];
    for (const display of device.displays) {
      lines.push(`  Display ${display.id}:`);
      lines.push(`    mDisplayId=${display.id}`);
      lines.push(
        `    mBaseDisplayInfo=DisplayInfo{"${display.name}", displayId ${display.id}, displayGroupId 0, real ${display.width} x ${display.height}, largest app ${display.width} x ${display.height}, state ON, type ${display.type}, canHostTasks true}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  function renderWindow() {
    const lines = ['WINDOW MANAGER WINDOWS (dumpsys window windows)'];
    lines.push(`  mShowingLockscreen=${device.keyguard}`);
    lines.push(`  mDreamingLockscreen=false`);
    for (const display of device.displays) {
      const focus = device.focus.byDisplay[display.id] || { currentFocus: 'null', focusedApp: 'null' };
      lines.push(`  Display: mDisplayId=${display.id} (organized)`);
      lines.push(`    mCurrentFocus=${focus.currentFocus}`);
      lines.push(`    mFocusedApp=${focus.focusedApp}`);
    }
    lines.push(`  mTopFocusedDisplayId=${device.focus.top}`);
    return `${lines.join('\n')}\n`;
  }

  function renderActivities() {
    const lines = [];
    for (const display of device.displays) {
      const app = device.apps[display.id] || (display.id === 0 ? 'com.android.chrome' : null);
      lines.push(`Display #${display.id} (activities from top to bottom):`);
      if (app) lines.push(`    topResumedActivity=ActivityRecord{100 u0 ${app}/.MainActivity t${5000 + display.id}}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  function renderSurfaceFlinger() {
    const lines = [];
    for (const [name, physicalId] of device.sfIds) {
      const kind = name === 'Built-in Screen' ? 'HWC display 0' : 'Virtual display';
      lines.push(`Display ${physicalId} (${kind}): displayName="${name}"`);
    }
    return `${lines.join('\n')}\n`;
  }

  function renderBattery() {
    const b = device.battery;
    return `Current Battery Service state:
  AC powered: ${b.powered.ac}
  USB powered: ${b.powered.usb}
  Wireless powered: ${b.powered.wireless}
  Charge counter: ${b.chargeCounterUAh}
  status: 5
  health: 2
  present: true
  level: ${b.level}
  scale: 100
  voltage: 4312
  temperature: 297
`;
  }

  function createOverlay(spec) {
    const match = spec.match(/(\d+)x(\d+)\/(\d+)/);
    if (!match) return { ok: false };
    const width = Number(match[1]);
    const height = Number(match[2]);
    const id = device.nextDisplayId;
    device.nextDisplayId += 1;
    device.overlayCount += 1;
    const name = `Overlay #${device.overlayCount}`;
    device.displays.push({ id, name, width, height, type: 'OVERLAY' });
    // Built as a STRING on purpose: SurfaceFlinger ids are 64-bit and
    // 11529215048562781705 is already past Number.MAX_SAFE_INTEGER, so arithmetic
    // would silently produce a different display id.
    device.sfIds.set(name, `11529215048562${String(781705 + device.overlayCount - 1)}`);
    device.overlaySetting = spec;
    // Measured 2026-11-13: the system hands focus to the new display, display 0's own
    // mCurrentFocus goes null, and display 0's focused APP is unchanged.
    if (!device.focusBaseline) device.focusBaseline = { ...device.focus.byDisplay[0] };
    device.focus.byDisplay[0].currentFocus = 'null';
    // Samsung also starts a secondary launcher on the new display.
    device.focus.byDisplay[id] = {
      currentFocus: 'Window{9795050 u0 com.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher}',
      focusedApp: 'ActivityRecord{235952228 u0 com.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher t5228}',
    };
    device.focus.top = id;
    return { ok: true, id, name, width, height };
  }

  function destroyOverlays() {
    const removed = device.displays.filter((display) => display.id !== 0).map((display) => display.id);
    device.displays = device.displays.filter((display) => display.id === 0);
    for (const id of removed) {
      delete device.focus.byDisplay[id];
      delete device.apps[id];
    }
    if (device.focusBaseline) {
      device.focus.byDisplay[0] = { ...device.focusBaseline };
      device.focusBaseline = null;
    }
    device.overlaySetting = 'null';
    device.focus.top = 0;
    return removed;
  }

  function handle(command) {
    if (command === 'input') return { code: 0, out: INPUT_USAGE };

    let m = command.match(/^getprop ro\.product\.model$/);
    if (m) return { code: 0, out: `${device.model}\n` };
    m = command.match(/^getprop ro\.build\.version\.release$/);
    if (m) return { code: 0, out: `${device.release}\n` };
    m = command.match(/^getprop ro\.build\.version\.sdk$/);
    if (m) return { code: 0, out: `${device.sdk}\n` };
    m = command.match(/^getprop sys\.boot_completed$/);
    if (m) return { code: 0, out: '1\n' };

    if (command === 'settings get global overlay_display_devices') return { code: 0, out: `${device.overlaySetting}\n` };
    m = command.match(/^settings put global overlay_display_devices (.+)$/);
    if (m) {
      const created = createOverlay(m[1].trim());
      return created.ok ? { code: 0, out: '' } : { code: 1, out: '', err: 'bad overlay spec' };
    }
    if (command === 'settings delete global overlay_display_devices') {
      destroyOverlays();
      return { code: 0, out: '' };
    }
    if (/^settings get global /.test(command)) return { code: 0, out: 'null\n' };

    if (command === 'dumpsys display') return { code: 0, out: renderDisplays() };
    if (command === 'dumpsys window') return { code: 0, out: renderWindow() };
    if (command === 'dumpsys activity activities') return { code: 0, out: renderActivities() };
    if (command === 'dumpsys SurfaceFlinger --display-id') return { code: 0, out: renderSurfaceFlinger() };
    if (command === 'dumpsys power') return { code: 0, out: `POWER MANAGER (dumpsys power)\n  mWakefulness=${device.wakefulness}\n  Display Power: state=${device.wakefulness === 'Awake' ? 'ON' : 'OFF'}\n` };
    if (command === 'dumpsys battery') return { code: 0, out: renderBattery() };
    if (command === 'dumpsys batterystats --charged') {
      return { code: 0, out: `  Estimated power use (mAh):\n    Capacity: 5000, Computed drain: ${device.battery.computedDrainMah}, excess 1.2\n` };
    }
    if (command === 'dumpsys telecom') return { code: 0, out: `Telecom Service state:\n  mIsInCall: ${device.inCall}\n` };
    if (command === 'pm list users') {
      const rows = device.users.map((user) => `\tUserInfo{${user.id}:${user.name}:4c13} running`);
      return { code: 0, out: `Users:\n${rows.join('\n')}\n` };
    }

    m = command.match(/^am start (.*)$/);
    if (m) {
      const rest = m[1];
      const displayMatch = rest.match(/--display (\d+)/);
      const componentMatch = rest.match(/-n (\S+)/);
      const userMatch = rest.match(/--user (\d+)/);
      const displayId = displayMatch ? Number(displayMatch[1]) : 0;
      if (!device.displays.some((display) => display.id === displayId)) {
        return { code: 1, out: '', err: `Error: Activity not started, display ${displayId} not found` };
      }
      if (!componentMatch) return { code: 1, out: '', err: 'Error: no component' };
      const pkg = componentMatch[1].split('/')[0];
      device.apps[displayId] = pkg;
      device.pids[pkg] = 4000 + displayId;
      device.focus.byDisplay[displayId] = {
        currentFocus: `Window{19762ef u0 ${pkg}/${pkg}.MainActivity}`,
        focusedApp: `ActivityRecord{231562119 u0 ${pkg}/.MainActivity t${5198 + displayId}}`,
      };
      device.focus.top = displayId;
      const userNote = userMatch ? ` user ${userMatch[1]}` : '';
      return { code: 0, out: `Starting: Intent { cmp=${componentMatch[1]} }${userNote}\n` };
    }

    m = command.match(/^am force-stop (\S+)$/);
    if (m) {
      const pkg = m[1];
      for (const [id, running] of Object.entries(device.apps)) if (running === pkg) delete device.apps[id];
      delete device.pids[pkg];
      return { code: 0, out: '' };
    }

    m = command.match(/^cmd package resolve-activity --brief.*?([\w.]+)$/);
    if (m) {
      const pkg = m[1];
      return device.knownPackages.includes(pkg)
        ? { code: 0, out: `priority=0\n${pkg}/.MainActivity\n` }
        : { code: 0, out: 'No activity found\n' };
    }

    m = command.match(/^pidof (\S+)$/);
    if (m) return { code: 0, out: device.pids[m[1]] ? `${device.pids[m[1]]}\n` : '' };

    m = command.match(/^input (?:-d (\d+) )?(.*)$/);
    if (m && command.startsWith('input ')) {
      const displayId = m[1] ? Number(m[1]) : 0;
      device.inputEvents += 1;
      if (device.apps[displayId]) device.appTouches[displayId] = (device.appTouches[displayId] || 0) + 1;
      return { code: 0, out: '' };
    }

    if (/^uiautomator dump/.test(command)) return { code: 0, out: 'UI hierchary dumped to: /sdcard/window_dump.xml\n' };
    if (/^ps -A$/.test(command)) return { code: 0, out: '' };

    return { code: 0, out: '', err: `fake-adb: unhandled command: ${command}` };
  }

  function respond(command) {
    calls.push(command);
    const failure = takeFailure(command);
    if (failure) return { code: failure.code ?? 1, out: failure.stdout || '', err: failure.stderr || 'injected failure' };
    return handle(command);
  }

  const state = { adbPath: 'fake-adb', serial, calls: 0, connection: { createdByRun: false, host: null, at: null } };

  const api = {
    state,
    fake: device,
    calls,
    serial,
    get callsCount() {
      return calls.length;
    },
    get connection() {
      return state.connection;
    },
    async run(argv) {
      const command = argv[argv.length - 1];
      const result = respond(command);
      return { ok: result.code === 0, code: result.code, out: Buffer.from(result.out || ''), text: result.out || '', err: result.err || '', argv, ms: 1 };
    },
    async shell(command) {
      const text = Array.isArray(command) ? command.join(' ') : String(command);
      const result = respond(text);
      return { ok: result.code === 0, code: result.code, out: Buffer.from(result.out || ''), text: result.out || '', err: result.err || '', argv: ['shell', text], ms: 1 };
    },
    async execOut(args) {
      const command = Array.isArray(args) ? args.join(' ') : String(args);
      calls.push(`exec-out ${command}`);
      const failure = takeFailure(command);
      if (failure) return { ok: false, code: failure.code ?? 1, out: Buffer.alloc(0), text: '', err: failure.stderr || 'injected failure', argv: args, ms: 1 };
      const displayArg = args.indexOf('-d');
      if (displayArg >= 0) {
        const id = args[displayArg + 1];
        const entry = [...device.sfIds.entries()].find(([, physicalId]) => physicalId === String(id));
        if (!entry) {
          device.captures += 1;
          // Real behaviour: exit 0 with a text stub. The validator is what refuses it.
          return { ok: true, code: 0, out: stubCapture(id), text: '', err: '', argv: args, ms: 1 };
        }
        const display = device.displays.find((entryDisplay) => entryDisplay.name === entry[0]);
        device.captures += 1;
        const png = makePng(display.width, display.height, device.inputEvents + 1);
        return { ok: true, code: 0, out: png, text: '', err: '', argv: args, ms: 1 };
      }
      device.captures += 1;
      return { ok: true, code: 0, out: makePng(1080, 2316, device.inputEvents + 1), text: '', err: '', argv: args, ms: 1 };
    },
    async devices() {
      return { ok: true, code: 0, text: `List of devices attached\n${serial}\tdevice\n`, devices: [{ serial, state: 'device' }] };
    },
    async resolveSerial() {
      return { ok: true, serial, source: 'given' };
    },
    async connect(host) {
      state.connection = { createdByRun: true, host, at: new Date().toISOString() };
      return { ok: true, host, text: `connected to ${host}` };
    },
    async disconnect() {
      device.disconnected = true;
      return { ok: true, serial, text: `disconnected ${serial}` };
    },
    set(patch) {
      Object.assign(device, patch);
      return api;
    },
    failNext(pattern, { times = 1, code = 1, stderr = 'injected failure', stdout = '' } = {}) {
      device.failures.push({ pattern, times, code, stderr, stdout });
      return api;
    },
    advanceBattery({ drainMah = 3, chargeUAh = -1000, level = 0 } = {}) {
      device.battery.computedDrainMah += drainMah;
      device.battery.chargeCounterUAh += chargeUAh;
      device.battery.level += level;
      return api;
    },
    command(needle) {
      return calls.filter((entry) => matches(needle, entry));
    },
  };

  return api;
}
