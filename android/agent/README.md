# Quiet workspace — Android agent automation without screen theft

Infrastructure that lets an AI agent install, launch, tap, swipe, type, screenshot and
observe an app **on the owner's Samsung S23 while the owner keeps using the phone**.

The one invariant everything routes through:

> **The owner's screen is never stolen.** Agents get a private, invisible display.
> The owner keeps display 0. When in doubt, decline politely instead of interrupting.

`README.md` at the repo root is the GoWild board. This file is only about the harness.

---

## Quick start

```bash
node android/agent/cli.mjs probe                      # Phase 0: nothing acts before this speaks
node android/agent/cli.mjs status                     # read-only: owner state, displays, residue
node android/agent/cli.mjs run --app com.freebuff.gowild        # scripted run on the private display
node android/agent/cli.mjs run --app com.freebuff.gowild --plan throw   # the forced-exception path
node android/agent/cli.mjs stop                       # put the phone back, report what is left
node android/agent/cli.mjs run --app com.example.rogue --isolated --backend emulator
```

Exit codes: `0` ok · `1` failed · `2` refused (a normal result with a reason) · `3` no device.

Every run writes `docs/android-agent/evidence/<run>/run.json` plus a human `SUMMARY.md`
and the captures it took. Nothing is a session-throwaway path.

## The three tiers

| Tier | What runs | Disruption | Honest limit |
|---|---|---|---|
| **observe** | `dumpsys`, `screencap`, `logcat`, notification dumps, `uiautomator dump` | none — nothing on screen changes | read-only; cannot drive the app |
| **virtual** | the same actions against an overlay display (`input -d <id>`, `am start --display <id>`) | none on display 0 | **invisibility, NOT isolation**: same user, same app data, same accounts |
| **isolated** | an emulator, or a work profile (`am start --user <n>`) through the same Action API | none on the phone when the emulator runs | needs a second Android instance; not installed on this laptop |

Every action result carries `tier`, and the run record counts them. A transcript that
says "a tap happened" without saying where is not evidence.

## Display lifecycle

`lib/display.mjs` owns the whole cycle:

1. refuse if an overlay setting already exists (never clobber someone else's display);
2. refuse if any display other than 0 already exists (two is ambiguous);
3. create with `settings put global overlay_display_devices "<W>x<H>/<DPI>"`;
4. **discover** the assigned logical id as the difference between the display list
   before and after — never assume it;
5. find the matching **SurfaceFlinger** id by display name, because that is the only id
   `screencap -d` accepts;
6. record display 0's own window record before and after;
7. tear down after the body resolves **or throws**, and treat residue as a failure.

`withDisplay(fn)` is the deferred path; `test/06-teardown.mjs` proves it for success,
throw, interrupt-shaped rejection and refusal.

## The Action API

`lib/actions.mjs`: `launch`, `tap`, `swipe`, `text`, `key`, `back`, `capture`,
`captureDisplayZero`, `readState`. Input is display-scoped **by construction** — there
is no code path that taps display 0, which is a stronger guarantee than checking a flag
at each call site. An out-of-bounds coordinate is refused before it reaches the device.

`lib/isolation.mjs` exposes the same surface for the isolated tier, so a test script
points at either backend without changing a line.

## The disruption guard

`lib/guard.mjs` is used for any operation that *would* touch display 0. It asks
`dumpsys power` (wakefulness) and `dumpsys window` (keyguard), plus `dumpsys telecom`
for a call, and returns a **refusal value** when the owner is active:

```js
{ allowed: false, refused: true, reason: 'owner-active', detail: 'owner is using the phone (Awake); display 0 is left alone.' }
```

A refusal is never an exception and never an interruption. The guard does **not** block
the virtual tier — working while the owner is active is the point.

## What it costs, per run

`lib/battery.mjs` reports two numbers and says which one is trustworthy:

| Source | When it is right |
|---|---|
| charge counter (µAh) | only while discharging |
| `dumpsys batterystats` "Computed drain" delta | always, but whole mAh — a 27 s run lands at or below the resolution floor, and the report says so instead of printing "0" |

## Measured device facts (S23, 2026-11-13 — all of these contradict a reasonable guess)

| Fact | Evidence |
|---|---|
| `input` on this build accepts `-d DISPLAY_ID` | the first line of `input` usage |
| The overlay's **logical** id is not stable | 135, 136, 137, 138, 141, 142 across runs; **134 was never observed** |
| `screencap -d` does **not** take the logical id | `11529215050125242667` (SurfaceFlinger) vs `141` (logical) |
| `screencap -d 0` is **invalid** | 79 bytes, exit code **0**, and the bytes are the text `Failed to take take screenshot. Display Id '0' is not valid.` |
| …so display 0 is captured with plain `screencap -p` | 1.28 MB, 1080×2316 |
| A wrong id is a **text stub, not a PNG** | exit status is worthless; only the bytes can refuse it |
| SurfaceFlinger ids are **64-bit** | `11529215050125242667` > `Number.MAX_SAFE_INTEGER`; parsing with `Number` silently changes the display |
| `mTopFocusedDisplayId` **may** move to the overlay | observed 0→138→0 and 0→142→0 in different runs; situational |
| display 0's `mCurrentFocus` **may become `null`** while the overlay owns focus | same event; its **focused app** is unchanged |
| The owner navigating inside their app changes the activity | Facebook `LoginActivity` → `ImmersiveActivity`, same package |
| `am start --display <id>` really does confine the task | the app is resumed on the overlay and absent from display 0 |
| Teardown restores `null` + exactly display 0 | every run; `mTopFocusedDisplayId` returns to 0 |
| Teardown does **not** stop the app it launched | the process survives; the stop switch force-stops it |
| `uiautomator dump` has no per-display option | it dumps the default display only — which is why the harness proves absence by window attribution |

## Honest limits

- **Invisibility is not isolation.** The virtual tier shares the user, the app data and
  every account with the owner's phone. Only the emulator/work-profile tier is isolation.
- **A hardware keyboard would type into the overlay** while it holds system focus
  (`mTopFocusedDisplayId`). Touch on display 0 is unaffected. Measured, stated in every
  probe, not hidden.
- **Absence from display 0 is proven by window attribution**, not by pixel identity: the
  owner's own screen changes while a run is live, so a pixel comparison would prove
  nothing either way.
- **The emulator and work-profile tiers are not runnable on this machine** — no emulator
  package, no hypervisor, and `pm list users` shows only user 0. Their refusals are
  tested; the seam is exercised on the recorded transport.
- **The owner-active test is machine-proven only until the owner says otherwise.** The
  harness can prove focus equality; only a human can confirm the screen never flickered.

## Tests

```bash
node android/agent/test/run-all.mjs     # 148 offline checks, 8 suites, no device needed
node android/agent/test/red.mjs         # observed-red: 10 mutations, each must turn a suite red
node android/agent/test/live.mjs        # the 8 acceptance criteria on the real phone (needs hardware)
```

`red.mjs` is the reason the green means anything: it copies `lib/`, removes one behaviour
at a time, and records which checks fail. Results go to
`docs/android-agent/evidence/OBSERVED-RED.md`. A suite that does not go red is reported
as unproven and the driver exits non-zero.

`test/fixtures/real-2026-11-13.txt` is a verbatim slice of device output, and
`test/fixtures/screencap-stub-79.txt` is the actual 79-byte stub. The simulated transport
is modelled on those, so the fake cannot quietly agree with a wrong parser.

## Files

| Path | Responsibility |
|---|---|
| `lib/adb.mjs` | one place that knows adb, serial targeting, and whether the run created the connection |
| `lib/device.mjs` | parsers for `dumpsys display/window/activity/SurfaceFlinger/power`, battery, keyguard; the display-0 fingerprint |
| `lib/display.mjs` | create / discover / verify / tear down the overlay display |
| `lib/actions.mjs` | the Action API, display-scoped and tier-tagged |
| `lib/guard.mjs` | owner-idle check and refusal semantics |
| `lib/battery.mjs` | per-run battery delta with its source named |
| `lib/policy.mjs` + `config/apps.json` | the safe-to-drive allowlist and the approval rule |
| `lib/isolation.mjs` | the isolation seam (emulator, work profile) |
| `lib/stop.mjs` | the stop switch |
| `lib/report.mjs` | run evidence and the crash-safety pointer |
| `lib/session.mjs` | the orchestrator: probe → policy → display → script → teardown → battery |
| `lib/probe.mjs` | Phase 0 capability probe and its cache |
| `cli.mjs` | `probe`, `status`, `run`, `stop` |
| `example/isolation-smoke.mjs` | one working example of the seam |
