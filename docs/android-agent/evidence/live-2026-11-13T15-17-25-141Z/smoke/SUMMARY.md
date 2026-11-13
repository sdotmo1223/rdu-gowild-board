# Run live-smoke

2026-11-13T15:17:35.170Z → 2026-11-13T15:18:02.124Z · SM-S918U · Android 17 (API 37)

**Outcome:** ok

## The crown invariant

- display 0 before: `Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity}` / `ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}`
- display 0 after the action phase: `null` / `ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}`
- display 0 after teardown: `Window{673c3de u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity}` / `ActivityRecord{113297694 u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity t5197}`
- display 0 window identical in every sample: **yes**
- attributable to this run: **yes** (0 unexplained, 0 concurrent with owner activity)
- control samples changed: NO · run-level comparison changed: NO
- structural checks: 0 display-0 input calls, 0 launches without --display, app resumed on display 0: NO
- system focus pointer: 0 → 142 → 0
- focus changes during actions: none

## Every action, and the tier that ran it

| # | action | tier | ok | display | detail |
|---|---|---|---|---|---|
| 1 | capture (display-zero-before) | observe | yes | 0 | `01-display-zero-before.png` 1080x2316 1283040 B |
| 2 | launch (launch com.freebuff.gowild) | virtual | yes | 142 | launch com.freebuff.gowild |
| 3 | read-state (state-after-launch) | observe | yes | 142 | state-after-launch |
| 4 | capture (launched) | virtual | yes | 142 | `02-launched.png` 720x1280 413191 B |
| 5 | swipe (scroll) | virtual | yes | 142 | scroll |
| 6 | capture (after-scroll) | virtual | yes | 142 | `03-after-scroll.png` 720x1280 411872 B |
| 7 | tap (center-tap) | virtual | yes | 142 | center-tap |
| 8 | capture (after-tap) | virtual | yes | 142 | `04-after-tap.png` 720x1280 413191 B |
| 9 | back (back) | virtual | yes | 142 | back |
| 10 | capture (display-zero-after) | observe | yes | 0 | `05-display-zero-after.png` 1080x2316 714473 B |

Tier counts: **observe** 3 · **virtual** 7

## Battery

- 26.7 s of run
- measure: -1 mAh (batterystats-estimate)
- charge counter delta: 0 µAh · charging: yes · level delta: 0%
- batterystats drain delta: -1 mAh
- note: device was charging, so the charge counter cannot fall; the batterystats estimate is reported instead

## Disruption report

- owner at start: active (wakefulness=Awake)
- display-0 touches: 2
  - capture display 0 (before) — read-only screencap of the default display; changes nothing on screen
  - capture display 0 (after) — read-only screencap of the default display; proves the app under test is not on it
- churn moments (allowed): overlay-create, overlay-teardown
- forbidden touches: 0

## Teardown

- overlay setting after: `null`
- displays after: [0] (expected [0])
- residue: NO · attempt(s): 1

## Limits stated by this run

- the virtual display is invisibility, not isolation: same user, same app data, same accounts
- display-0 focus is sampled before and after each action, not continuously
- the system moved input focus to the overlay (mTopFocusedDisplayId 0 -> 142). Touch on display 0 is not affected; a hardware keyboard would type into the overlay while it exists.

