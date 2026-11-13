# Acceptance evidence — quiet workspace

Live run on `adb-R5CW1040A1A-Utkq1e._adb-tls-connect._tcp` · 2026-11-13T15:13:02.880Z

7/10 criteria observed passing.

| # | criterion | observed |
|---|---|---|
| 0 | the probe answers every capability question and leaves no residue | pass |
| 1 | creating an overlay leaves display 0 on the same focused app | pass |
| 5 | an unknown display id fails loudly instead of returning a 79-byte stub | pass |
| 2 | the app launched on the discovered display is visible there and absent from display 0 | pass |
| 3 | display-scoped input reaches the app and never changes display 0 | **FAIL** |
| 6 | the crown: a full run with the owner active, display 0 untouched | **FAIL** |
| 7 | every action reports the tier that ran it | pass |
| 8 | battery cost is measured per run, with its source named | **FAIL** |
| 4 | teardown restores the phone even when the run throws mid-way | pass |
| S | the stop switch leaves no display, no global setting and no app of ours running | pass |

## 0 — the probe answers every capability question and leaves no residue

**Observed**

- verdict DEGRADED · Android 17 (API 37)
- input -d supported · overlay logical id 138 · screencap id 11529215049306993292
- teardown setting=null displays=[0] residue=false
- limit: display 0 changed focus across create/teardown
- limit: the system moved input focus to the overlay display (mTopFocusedDisplayId 0 -> 138); display 0 kept its own window, but a hardware keyboard would now type into the overlay

## 1 — creating an overlay leaves display 0 on the same focused app

**Observed**

- before  Window{c27a43d u0 com.facebook.katana/com.facebook.katana.LoginActivity} / ActivityRecord{198000027 u0 com.facebook.katana/.LoginActivity t5199}
- during  null / ActivityRecord{198000027 u0 com.facebook.katana/.LoginActivity t5199}
- after   Window{77eca89 u0 com.facebook.katana/com.facebook.katana.immersiveactivity.ImmersiveActivity} / ActivityRecord{138991597 u0 com.facebook.katana/.immersiveactivity.ImmersiveActivity t5199}
- system focus pointer 0 -> 138 -> 0

> display 0 mCurrentFocus going null while the overlay owns system focus is measured and reported, not treated as a change

## 5 — an unknown display id fails loudly instead of returning a 79-byte stub

**Observed**

- 84 bytes · reason not-a-png · "Failed to take take screenshot. Display Id '999999' is not valid. Capturing failed."

## 2 — the app launched on the discovered display is visible there and absent from display 0

**Observed**

- launch com.freebuff.gowild/.MainActivity on display 139
- resumed on overlay: com.freebuff.gowild, com.sec.android.app.launcher
- resumed on display 0: com.facebook.katana
- 3 overlay captures 720x1280 720x1280 720x1280 · 2 display-0 captures 1080 1080

> absence from display 0 is proven by window attribution, not by pixel identity: the owner's own screen changes while the run is live

## 3 — display-scoped input reaches the app and never changes display 0

**FAILED**

- swipe argv: ?
- tap argv: ?
- overlay pixels before/after the swipe: b40e0a5e95d1 -> a9a5d618aae8 (changed, so the input landed in the app)
- display-0 focus stable around every action: false

## 6 — the crown: a full run with the owner active, display 0 untouched

**FAILED**

- owner at start: active (wakefulness=Awake)
- display 0 before: Window{c27a43d u0 com.facebook.katana/com.facebook.katana.LoginActivity} / ActivityRecord{198000027 u0 com.facebook.katana/.LoginActivity t5199}
- display 0 after:  Window{5b036dd u0 com.amazon.mShop.android.shopping/com.amazon.mShop.navigation.MainActivity} / ActivityRecord{167396008 u0 com.amazon.mShop.android.shopping/com.amazon.mShop.navigation.MainActivity t4899}
- per-action focus violations: 4 · churn moments: overlay-create, overlay-teardown
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

**FAILED**

- null mAh (none) over 27.1s
- charge counter delta 0 uAh · charging true · batterystats delta null mAh
- device was charging, so the charge counter cannot fall; the batterystats estimate is reported instead
- batterystats drain estimate unavailable
- no battery cost could be measured for this run

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

