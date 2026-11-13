// Parsers for the read-only commands the harness depends on, plus the thin readers
// that run them.
//
// Every parser here is exercised against a slice of real output captured from the
// S23 on 2026-11-13 (test/fixtures/real-2026-11-13.txt). That matters: a fake
// transport can agree with a wrong parser forever, and only a real capture cannot.
import { nowIso } from './util.mjs';

const field = (block, re) => {
  const match = block.match(re);
  return match ? match[1].trim().replace(/\r$/, '') : null;
};

// `dumpsys display` prints one `  Display <id>:` header per *logical* display,
// followed by its mBaseDisplayInfo. The DisplayInfo line nests braces, so it is
// parsed field-by-field rather than by matching the whole object.
export function parseDisplays(text) {
  const source = String(text || '');
  const headers = [...source.matchAll(/^[ \t]*Display (\d+):[ \t]*$/gm)];
  const displays = [];
  headers.forEach((header, index) => {
    const start = header.index + header[0].length;
    const end = index + 1 < headers.length ? headers[index + 1].index : source.length;
    const block = source.slice(start, end);
    const size = block.match(/real (\d+) x (\d+)/);
    displays.push({
      id: Number(header[1]),
      name: field(block, /DisplayInfo\{"([^"]*)"/),
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : null,
      type: field(block, /\btype ([A-Z_]+)/),
      state: field(block, /\bstate ([A-Z_]+)/),
    });
  });
  return displays;
}

// `dumpsys window` prints a per-display section, each with the focus record for
// *that* display. The global `mCurrentFocus` earlier in the dump belongs to no
// section and is deliberately not attributed to display 0.
export function parseFocus(text) {
  const source = String(text || '');
  const tops = [...source.matchAll(/mTopFocusedDisplayId=(\d+)/g)];
  const marks = [...source.matchAll(/^[ \t]*Display: mDisplayId=(\d+)[^\n]*$/gm)];
  const displays = marks.map((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = index + 1 < marks.length ? marks[index + 1].index : source.length;
    const block = source.slice(start, end);
    return {
      id: Number(mark[1]),
      currentFocus: field(block, /^[ \t]*mCurrentFocus=(.*)$/m),
      focusedApp: field(block, /^[ \t]*mFocusedApp=(.*)$/m),
      focusedWindow: field(block, /^[ \t]*mFocusedWindow=(.*)$/m),
    };
  });
  return {
    at: nowIso(),
    topFocusedDisplayId: tops.length ? Number(tops[tops.length - 1][1]) : null,
    displays,
  };
}

// `dumpsys activity activities` groups tasks under `Display #<id> (activities ...)`.
export function parseActivityDisplays(text) {
  const source = String(text || '');
  const marks = [...source.matchAll(/^Display #(\d+) \([^)]*\):/gm)];
  return marks.map((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = index + 1 < marks.length ? marks[index + 1].index : source.length;
    const block = source.slice(start, end);
    const activities = [...block.matchAll(/topResumedActivity=ActivityRecord\{[^ ]+ [^ ]+ ([^/\s]+)\/([^\s}]+)(?: t(\d+))?/g)]
      .map((m) => ({ package: m[1], component: m[2], taskId: m[3] ? Number(m[3]) : null }));
    return { id: Number(mark[1]), activities };
  });
}

// `dumpsys SurfaceFlinger --display-id` is the ONLY id space `screencap -d` accepts.
// Measured: the overlay's logical id was 136 while its physical id was
// 11529215048562781705, and `screencap -d 136` fails. The join key is displayName.
export function parseSurfaceFlingerIds(text) {
  const source = String(text || '');
  const rows = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*Display (\d+) \(([^)]*)\):(.*)$/);
    if (!match) continue;
    rows.push({
      physicalId: match[1],
      kind: match[2].trim(),
      displayName: field(match[3], /displayName="([^"]*)"/),
      raw: line.trim(),
    });
  }
  return rows;
}

export function parsePower(text) {
  const source = String(text || '');
  const wake = source.match(/mWakefulness=([A-Za-z]+)/);
  return {
    wakefulness: wake ? wake[1] : null,
    screenOn: /Display Power:.*state=ON/i.test(source) ? true : null,
  };
}

export function parseKeyguard(text) {
  const source = String(text || '');
  const flag = (re) => {
    const match = source.match(re);
    return match ? match[1] === 'true' : null;
  };
  const showing = flag(/mShowingLockscreen=(true|false)/) ?? flag(/keyguardShowing=(true|false)/) ?? false;
  return {
    showing,
    dreaming: flag(/mDreamingLockscreen=(true|false)/),
    dismissed: flag(/mKeyguardDismissed=(true|false)/),
    focusOnKeyguard: /mCurrentFocus=.*Keyguard/.test(source),
  };
}

export function parseBattery(text) {
  const source = String(text || '');
  const num = (re) => {
    const match = source.match(re);
    return match ? Number(match[1]) : null;
  };
  const flag = (re) => {
    const match = source.match(re);
    return match ? match[1] === 'true' : null;
  };
  const temperature = num(/^\s*temperature:\s*(\d+)/m);
  return {
    level: num(/^\s*level:\s*(\d+)/m),
    chargeCounterUAh: num(/^\s*Charge counter:\s*(\d+)/m),
    status: num(/^\s*status:\s*(\d+)/m),
    temperatureC: temperature === null ? null : temperature / 10,
    powered: {
      ac: flag(/^\s*AC powered:\s*(true|false)/m),
      usb: flag(/^\s*USB powered:\s*(true|false)/m),
      wireless: flag(/^\s*Wireless powered:\s*(true|false)/m),
    },
  };
}

// Device-wide cumulative estimate. The *delta* between two reads is the run's
// share, which is the only battery number available while the phone is charging
// and the charge counter therefore cannot fall.
// Measured line on this build (2026-11-13):
//   Capacity: 5000, Rated: 4855, Typical: 5000, Computed drain: 2372, actual drain: 2372
// so the two numbers this needs are NOT adjacent.
export function parseBatterystats(text) {
  const source = String(text || '');
  const capacity = source.match(/Capacity:\s*([\d.]+)/);
  const drain = source.match(/Computed drain:\s*([\d.]+)/);
  if (!capacity && !drain) return { capacityMah: null, computedDrainMah: null };
  return {
    capacityMah: capacity ? Number(capacity[1]) : null,
    computedDrainMah: drain ? Number(drain[1]) : null,
  };
}

const packageOf = (record) => {
  const match = String(record || '').match(/([\w.]+)\/[\w.$]+/);
  return match ? match[1] : null;
};

export function displayZeroFingerprint(focus) {
  const display = (focus?.displays || []).find((entry) => entry.id === 0) || {};
  return {
    displayId: 0,
    currentFocus: display.currentFocus ?? null,
    focusedApp: display.focusedApp ?? null,
    focusedPackage: packageOf(display.focusedApp),
    focusedWindow: display.focusedWindow ?? null,
    topFocusedDisplayId: focus?.topFocusedDisplayId ?? null,
    at: focus?.at || nowIso(),
  };
}

// The crown invariant, defined from measurement rather than from the obvious guess.
//
// Captured 2026-11-13 on the S23 with the overlay up and an app running on it:
//
//   display 0, overlay absent:   mCurrentFocus=Window{...instagram...}  mFocusedApp=...instagram...
//   display 0, overlay present:  mCurrentFocus=null                    mFocusedApp=...instagram...
//
// So `mCurrentFocus` goes null while the system hands focus to the overlay, and the
// app on display 0 is untouched. Comparing `currentFocus` would therefore report a
// violation on every run and get the check disabled within a day. The invariant is
// the focused APP (plus the resumed activity, checked by the caller); the null is
// reported separately as the measured focus excursion.
// Compared at PACKAGE level. Measured 2026-11-13 while the owner used the phone: the
// record went from com.facebook.katana/.LoginActivity to
// com.facebook.katana/.immersiveactivity.ImmersiveActivity with no action of ours in
// between, so component-level equality would fail on the owner's own navigation.
// Package-level equality is the question that matters: is the owner still looking at
// their own app?
export function sameDisplayZero(a, b) {
  if (!a || !b) return false;
  const left = a.focusedPackage ?? a.focusedApp;
  const right = b.focusedPackage ?? b.focusedApp;
  return left === right;
}

export function focusExcursion(a, b) {
  if (!a || !b) return null;
  return {
    focusedAppChanged: a.focusedApp !== b.focusedApp,
    currentFocusChanged: a.currentFocus !== b.currentFocus,
    currentFocusBefore: a.currentFocus,
    currentFocusAfter: b.currentFocus,
  };
}

export function describeDisplayZero(fp) {
  if (!fp) return 'unknown';
  return `display 0 focus=${fp.currentFocus || 'null'} app=${fp.focusedApp || 'null'}`;
}

// SurfaceFlinger display ids are 64-bit and exceed Number.MAX_SAFE_INTEGER. They are
// kept as strings everywhere: Number('11529215048562781705') is 11529215048562782000,
// which is a different display. This helper exists so the rule is stated once.
export function physicalIdIsLossless(value) {
  return typeof value === 'string' && /^\d+$/.test(value) && value === BigInt(value).toString();
}

export function resumedOn(activityDisplays, displayId) {
  const display = (activityDisplays || []).find((entry) => entry.id === displayId);
  return display ? display.activities : [];
}

export function idsOf(displays) {
  return (displays || []).map((display) => display.id).sort((a, b) => a - b);
}

export function sameIds(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

export async function readDisplays(adb) {
  const result = await adb.shell('dumpsys display');
  return { ...result, displays: parseDisplays(result.text) };
}

export async function readFocus(adb) {
  const result = await adb.shell('dumpsys window');
  return { ...result, focus: parseFocus(result.text), fingerprint: displayZeroFingerprint(parseFocus(result.text)) };
}

export async function readActivityDisplays(adb) {
  const result = await adb.shell('dumpsys activity activities');
  return { ...result, displays: parseActivityDisplays(result.text) };
}

export async function readSurfaceFlingerIds(adb) {
  const result = await adb.shell('dumpsys SurfaceFlinger --display-id');
  return { ...result, rows: parseSurfaceFlingerIds(result.text) };
}

export async function readPower(adb) {
  const result = await adb.shell('dumpsys power');
  return { ...result, power: parsePower(result.text) };
}

export async function readBattery(adb) {
  const result = await adb.shell('dumpsys battery');
  return { ...result, battery: parseBattery(result.text) };
}

export async function readBatterystats(adb) {
  const result = await adb.shell('dumpsys batterystats --charged');
  return { ...result, stats: parseBatterystats(result.text) };
}

export async function readProps(adb) {
  const [model, release, sdk] = await Promise.all([
    adb.shell('getprop ro.product.model'),
    adb.shell('getprop ro.build.version.release'),
    adb.shell('getprop ro.build.version.sdk'),
  ]);
  return {
    model: model.text.trim(),
    release: release.text.trim(),
    sdk: Number(sdk.text.trim()),
  };
}
