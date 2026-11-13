# Phase 0 — capability probe

The probe is `android/agent/lib/probe.mjs`. It answers four questions with commands,
not assumptions, and it re-runs at the start of every session (`cli.mjs run` calls it
unless `--skip-probe` is passed, and refuses the run when the verdict is `NO`).

A cached verdict exists for reporting only: it carries its device serial and its age,
and a cache from another device or older than 15 minutes is reported as stale rather
than trusted.

## What it asks, and what it got on 2026-11-13 (S23, wireless adb)

| Question | Command | Answer |
|---|---|---|
| Android level | `getprop ro.build.version.sdk` / `.release` | **37 / 17**, SM-S918U |
| Does `input` accept `-d`? | `input` (usage text) | **yes** — `Usage: input [<source>] [-d DISPLAY_ID] <command>` |
| What displays exist? | `dumpsys display` | `[0]`, Built-in Screen 1080×2316 INTERNAL |
| Can an overlay be created and torn down with zero residue? | create → verify → delete → verify | **yes** |

The create/verify/delete/verify cycle from the passing probe run:

```
verdict OK · Android 17 (API 37)
input -d supported · overlay logical id 141 · screencap id 11529215050125242667
teardown setting=null displays=[0] residue=false
```

The probe also provokes the failure path on purpose, with an id that cannot exist, so
the refusal is measured rather than described:

```
84 bytes · reason not-a-png · "Failed to take take screenshot. Display Id '999999' is not valid. Capturing failed."
```

## Verdict rules

| Verdict | Means |
|---|---|
| `ok` | `input -d` advertised, overlay created, capture validates, stub refused, teardown clean, display 0 unchanged |
| `degraded` | the display lifecycle works but something is missing — e.g. capture of the overlay fails, or display 0 changed focus |
| `no` | no `input -d`, no overlay, or residue after teardown. `run` refuses to act |

The probe's `limits[]` names each degradation in words, and the same lines are printed
by `cli.mjs probe`.

## Measured facts that contradict the brief

These were each observed on the device, and each one changes the implementation:

1. **The overlay's logical id is not 134.** Consecutive creates produced 135, 136, 137,
   138, 141, 142. The harness discovers the id as the set difference before/after and
   verifies the geometry; `test/red.mjs` proves that assuming 134 fails a suite.
2. **`screencap -d` does not take the logical id.** It takes the SurfaceFlinger physical
   id (`11529215050125242667` for logical `141`), joined here by display name
   (`Overlay #1`). See `dumpsys SurfaceFlinger --display-id`.
3. **`screencap -d 0` is invalid on this build.** It returns **exit code 0** and 79 bytes
   that are *text*: `Failed to take take screenshot. Display Id '0' is not valid.`
   Display 0 must therefore be captured with plain `screencap -p`.
4. **Exit status is worthless for captures.** A stub exits 0. Validation is by PNG
   signature, byte floor, IHDR geometry and expected geometry — in that order.
5. **SurfaceFlinger display ids are 64-bit.** `11529215050125242667` is larger than
   `Number.MAX_SAFE_INTEGER`, so `Number(id)` silently becomes a *different* display.
   They are strings from parse to report; `physicalIdIsLossless()` states the rule and a
   test pins it.
6. **`mTopFocusedDisplayId` can move to the overlay**, and display 0's `mCurrentFocus`
   can go `null` while it does. Measured in some runs (0→138→0) and not others
   (0→142→0): it is situational. Display 0's **focused app** stayed the same in every
   observation, which is why the crown invariant is defined on the app (and the resumed
   activity), not on `mCurrentFocus`.
7. **Teardown does not stop the app.** The display goes away, the process does not; the
   stop switch force-stops it. The crash-safety pointer therefore survives teardown.
8. **`dumpsys batterystats` is not adjacent.** This build prints
   `Capacity: 5000, Rated: 4855, Typical: 5000, Computed drain: 2372, actual drain: 2372`.
9. **`uiautomator dump` has no per-display option**, so it can only describe display 0.
   Absence from display 0 is proven by window attribution instead.

## Evidence

- `evidence/live-2026-11-13T15-17-25-141Z/live.json` — the probe record inside the
  acceptance run, including the display table, the SurfaceFlinger rows and the stub text.
- `android/agent/test/fixtures/real-2026-11-13.txt` — verbatim dumpsys slices, used by
  `test/02-display.mjs` so the parsers are tested against the device, not only the fake.
