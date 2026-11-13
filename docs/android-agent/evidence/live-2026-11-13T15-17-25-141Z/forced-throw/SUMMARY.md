# Run live-throw

2026-11-13T15:18:02.133Z → 2026-11-13T15:18:17.343Z · SM-S918U · Android 17 (API 37)

**Outcome:** FAILED — run-threw: forced exception: acceptance test 4

## The crown invariant

- display 0 before: `Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity}` / `ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}`
- display 0 after the action phase: `null` / `ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}`
- display 0 after teardown: `Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity}` / `ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}`
- display 0 window identical in every sample: **yes**
- attributable to this run: **yes** (0 unexplained, 0 concurrent with owner activity)
- control samples changed: NO · run-level comparison changed: NO
- structural checks: 0 display-0 input calls, 0 launches without --display, app resumed on display 0: NO
- system focus pointer: 0 → 143 → 0
- focus changes during actions: none

## Every action, and the tier that ran it

| # | action | tier | ok | display | detail |
|---|---|---|---|---|---|
| 1 | capture (display-zero-before) | observe | yes | 0 | `01-display-zero-before.png` 1080x2316 1296141 B |
| 2 | launch (launch com.freebuff.gowild) | virtual | yes | 143 | launch com.freebuff.gowild |
| 3 | capture (before-throw) | virtual | yes | 143 | `02-before-throw.png` 720x1280 413390 B |

Tier counts: **observe** 1 · **virtual** 2

## Battery

- 15 s of run
- measure: 0 mAh (batterystats-estimate)
- charge counter delta: 0 µAh · charging: yes · level delta: 0%
- batterystats drain delta: 0 mAh
- note: device was charging, so the charge counter cannot fall; the batterystats estimate is reported instead
- note: 0 mAh over 15s is below the counter's 1 mAh resolution: this run's cost is under the measurable floor, not zero

## Disruption report

- owner at start: active (wakefulness=Awake)
- display-0 touches: 1
  - capture display 0 (before) — read-only screencap of the default display; changes nothing on screen
- churn moments (allowed): overlay-create, overlay-teardown
- forbidden touches: 0

## Teardown

- overlay setting after: `null`
- displays after: [0] (expected [0])
- residue: NO · attempt(s): 1

## Limits stated by this run

- the virtual display is invisibility, not isolation: same user, same app data, same accounts
- display-0 focus is sampled before and after each action, not continuously
- the system moved input focus to the overlay (mTopFocusedDisplayId 0 -> 143). Touch on display 0 is not affected; a hardware keyboard would type into the overlay while it exists.

