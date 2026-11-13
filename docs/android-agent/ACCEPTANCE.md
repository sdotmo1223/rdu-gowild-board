# Acceptance evidence

Produced by `node android/agent/test/live.mjs` against the S23 over wireless adb, while
the owner was using the phone (`mWakefulness=Awake`, Instagram in front). Every line
below is copied from the run record, not summarised from memory.

- Evidence: `evidence/live-2026-11-13T15-17-25-141Z/`
- Machine records: `smoke/run.json`, `smoke/SUMMARY.md`, `forced-throw/run.json`
- The probe record, all eight criteria and the stop switch: `live.json`, `ACCEPTANCE.md`
  in that directory

## The passing run

| # | Criterion | Observed |
|---|---|---|
| 0 | Probe answers every capability question, leaves no residue | **pass** — verdict OK, overlay 141, screencap id 11529215050125242667, `setting=null displays=[0] residue=false` |
| 1 | Creating an overlay leaves display 0 on the same focused app | **pass** — `com.instagram.android` before, during and after; `mCurrentFocus` went `null` during, which is the measured focus excursion and is reported, not counted as a change |
| 2 | The app is visible on the overlay only, absent from display 0 | **pass** — `com.freebuff.gowild` resumed on display 142 and absent from display 0; 3 overlay captures at 720×1280, 2 display-0 captures at 1080×2316 |
| 3 | `input -d <id>` reaches the app and never changes display 0 | **pass** — `input -d 142 swipe 360 1050 360 358 400`; overlay pixels changed `ef593ca38a96 → 5609514fc61c`; 0 display-0 changes attributable to the run |
| 4 | Teardown returns to one display and a null setting even when the run throws | **pass** — forced exception mid-run; `setting=null displays=[0] residue=false`; captures kept |
| 5 | An unknown display capture fails loudly instead of returning a stub | **pass** — 84 bytes, `not-a-png`, `"Failed to take take screenshot. Display Id '999999' is not valid."` |
| 6 | The crown: a full run with the owner active, display 0 untouched | **pass (machine side)** — 0 per-action changes, 0 attributable, controls unchanged, no display-0 input call, no launch without `--display`, app never resumed on display 0 |
| 7 | The tool reports the tier used for every action | **pass** — `{observe: 3, virtual: 7}` across 10 steps |
| 8 | Battery delta per run, with its source named | **pass** — `-1 mAh (batterystats-estimate)` over 26.7 s, flagged as at/below the 1 mAh counter resolution while charging |
| S | The stop switch leaves no display, no setting and no app of ours running | **pass** — overlay already null, `force-stop com.freebuff.gowild → ok`, adb disconnect skipped (the run did not create the connection), 0 tasks on other displays |

**10/10 criteria observed passing.**

### Criterion 6, stated precisely

There are three separate claims and only one of them is machine-provable:

1. *"Our actions never target display 0."* Structural: every input argv is
   `input -d <overlay id> …` and every launch is `am start --display <overlay id> …`.
   Counted per run (`crown.structural`), and no code path in `actions.mjs` can produce
   anything else.
2. *"Display 0's focused app is unchanged."* Measured: the display-0 fingerprint before
   the action phase, after every action, and after teardown.
3. *"The owner saw nothing."* **Not machine-provable.** It needs the human who was
   holding the phone. **Still pending.**

The harness also separates owner churn from ours. In the first live look the owner
switched Facebook → Amazon during the run; that produced four per-action focus deltas.
Control samples (two focus reads with no action between them, at the same cadence) and
the run-level comparison now decide whether a delta is concurrent with owner activity.
A delta with stable controls and a stable run-level comparison would be `unexplained`
and would fail the run.

## The first live look, and what it caught

The first run of this suite (`evidence/first-live-look-2026-11-13/`) failed three
criteria. All three were real defects in the harness, not in the device:

| Failure | Cause | Fix |
|---|---|---|
| 3, 6 | Per-action focus compared the full `ActivityRecord`, so the owner navigating inside their own app (`com.facebook.katana/.LoginActivity` → `.ImmersiveActivity`) looked like a violation | compare the focused **package**; add control samples and report concurrent owner changes separately |
| 8 | `batterystats` parse assumed `Capacity, Computed drain` were adjacent; this build inserts `Rated` and `Typical` | parse the two fields independently |
| 0 | The probe's run-level check used the same strict comparison | same package-level fix; verdict went `DEGRADED` → `OK` |

That is the same law the offline suites follow: the suite was trusted only after it was
seen failing, and here it failed against the real device for reasons that were written
down before they were fixed.

## Offline evidence

`android/agent/test/run-all.mjs` — 148 checks in 8 suites, no device required.

`android/agent/test/red.mjs` — the observed-red driver. It copies `lib/`, removes one
behaviour at a time (10 mutations), runs the suite that claims to protect it, and records
the checks that fail. All 10 turned their suite red with the expected checks:

| Mutation | Suite that caught it |
|---|---|
| teardown never deletes the setting | `06-teardown.mjs` |
| display id assumed to be 134 | `01-probe.mjs` |
| a 79-byte stub accepted as a capture | `04-capture.mjs` |
| every action tagged `observe` | `05-actions.mjs` |
| the guard allows an active owner | `03-guard.mjs` |
| the stop switch reports success without reverting | `07-stop.mjs` |
| the crown comparison always equal | `02-display.mjs` |
| the probe trusts a stale cache | `01-probe.mjs` |
| the policy allows unlisted apps | `08-tiers-isolation.mjs` |
| capture ignores expected geometry | `04-capture.mjs` |

Full output: `evidence/OBSERVED-RED.md`.
