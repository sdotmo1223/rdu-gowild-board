# Acceptance evidence — quiet workspace

Live run on `adb-R5CW1040A1A-Utkq1e._adb-tls-connect._tcp` · 2026-11-13T15:18:19.472Z

10/10 criteria observed passing.

| # | criterion | observed |
|---|---|---|
| 0 | the probe answers every capability question and leaves no residue | pass |
| 1 | creating an overlay leaves display 0 on the same focused app | pass |
| 5 | an unknown display id fails loudly instead of returning a 79-byte stub | pass |
| 2 | the app launched on the discovered display is visible there and absent from display 0 | pass |
| 3 | display-scoped input reaches the app and never changes display 0 | pass |
| 6 | the crown: a full run with the owner active, display 0 untouched | pass |
| 7 | every action reports the tier that ran it | pass |
| 8 | battery cost is measured per run, with its source named | pass |
| 4 | teardown restores the phone even when the run throws mid-way | pass |
| S | the stop switch leaves no display, no global setting and no app of ours running | pass |

## 0 — the probe answers every capability question and leaves no residue

**Observed**

- verdict OK · Android 17 (API 37)
- input -d supported · overlay logical id 141 · screencap id 11529215050125242667
- teardown setting=null displays=[0] residue=false

## 1 — creating an overlay leaves display 0 on the same focused app

**Observed**

- before  Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity} / ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}
- during  Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity} / ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}
- after   Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity} / ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}
- system focus pointer 0 -> 0 -> 0
- focused package com.instagram.android -> com.instagram.android

> display 0 mCurrentFocus going null while the overlay owns system focus is measured and reported, not treated as a change

## 5 — an unknown display id fails loudly instead of returning a 79-byte stub

**Observed**

- 84 bytes · reason not-a-png · "Failed to take take screenshot. Display Id '999999' is not valid. Capturing failed."

## 2 — the app launched on the discovered display is visible there and absent from display 0

**Observed**

- launch com.freebuff.gowild/.MainActivity on display 142
- resumed on overlay: com.freebuff.gowild, com.sec.android.app.launcher
- resumed on display 0: com.instagram.android
- 3 overlay captures 720x1280 720x1280 720x1280 · 2 display-0 captures 1080 1080

> absence from display 0 is proven by window attribution, not by pixel identity: the owner's own screen changes while the run is live

## 3 — display-scoped input reaches the app and never changes display 0

**Observed**

- swipe argv: input -d 142 swipe 360 1050 360 358 400
- tap argv: input -d 142 tap 360 640
- overlay pixels before/after the swipe: ef593ca38a96 -> 5609514fc61c (changed, so the input landed in the app)
- display-0 changes attributable to this run: 0 (0 concurrent with owner activity)

## 6 — the crown: a full run with the owner active, display 0 untouched

**Observed**

- owner at start: active (wakefulness=Awake)
- display 0 before: Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity} / ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}
- display 0 after:  Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity} / ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}
- per-action focus samples differing: 0 · attributable: 0
- display-0 reads logged: capture display 0 (before), capture display 0 (after)

> human-side confirmation from the owner is still required: the machine proves focus equality, only the owner can confirm the screen never flickered

## 7 — every action reports the tier that ran it

**Observed**

- tiers: {"observe":3,"virtual":7}
- #1 capture -> observe
- #2 launch -> virtual
- #3 read-state -> observe
- #4 capture -> virtual
- #5 swipe -> virtual
- #6 capture -> virtual
- #7 tap -> virtual
- #8 capture -> virtual
- #9 back -> virtual
- #10 capture -> observe

## 8 — battery cost is measured per run, with its source named

**Observed**

- -1 mAh (batterystats-estimate) over 26.7s
- charge counter delta 0 uAh · charging true · batterystats delta -1 mAh
- device was charging, so the charge counter cannot fall; the batterystats estimate is reported instead

## 4 — teardown restores the phone even when the run throws mid-way

**Observed**

- forced failure: forced exception: acceptance test 4
- teardown setting=null displays=[0] residue=false
- captures kept as evidence: 2

## S — the stop switch leaves no display, no global setting and no app of ours running

**Observed**

- delete-overlay-setting -> skipped (already-null)
- force-stop com.freebuff.gowild -> ok
- adb-disconnect -> skipped (the run did not create the connection)
- apps still running: none
- tasks on other displays: 0

## Records

- `smoke/run.json` + `smoke/SUMMARY.md` — the scripted run, its captures, tiers, crown and battery
- `forced-throw/run.json` + `forced-throw/SUMMARY.md` — the same harness failing on purpose
- `live.json` — this file, as data

