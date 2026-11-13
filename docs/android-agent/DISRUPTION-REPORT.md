# Disruption report

What touched display 0, when, and why it was allowed. Compiled from the run records in
`evidence/`; every run writes its own version into `SUMMARY.md`.

## Rules these runs were held to

- Input and launch are display-scoped by construction (`input -d <id>`,
  `am start --display <id>`). No action can target display 0 on the virtual tier.
- Overlay **creation** and **teardown** are the only allowed churn moments.
- Reads of display 0 are allowed at any time: `dumpsys` and `screencap` change nothing.
- Anything that would *act* on display 0 goes through the guard and is refused while the
  owner is active. That path was never taken in these runs.

## Per run

| Run | Owner at start | Churn moments | Display-0 reads | Input to display 0 | Focus pointer |
|---|---|---|---|---|---|
| probe (15:17) | active, Instagram in front | overlay create (`141`), teardown | `dumpsys` only | none | `0 → 0 → 0` |
| smoke (15:17) | active, Instagram in front | overlay create (`142`), teardown | 2 × `screencap -p` (before/after) | none | `0 → 142 → 0` |
| forced throw (15:18) | active | overlay create, teardown | none | none | recorded in `run.json` |
| stop switch (15:18) | active | none (setting already null) | `force-stop` of the app **we** launched | n/a | n/a |
| probe (15:12, first look) | active, Facebook in front | overlay create (`138`), teardown | `dumpsys` only | none | `0 → 138 → 0` |

Display 0 read log for the smoke run, verbatim from `smoke/run.json`:

```json
"displayZeroTouched": [
  { "action": "capture display 0 (before)", "tier": "observe",
    "why": "read-only screencap of the default display; changes nothing on screen" },
  { "action": "capture display 0 (after)", "tier": "observe",
    "why": "read-only screencap of the default display; proves the app under test is not on it" }
]
```

## What the owner would have seen

- The probe and smoke runs create one overlay display each and delete it. The owner's
  panel is untouched by that: display 0 keeps its window, its app and its resumed
  activity in every record.
- `mTopFocusedDisplayId` moved to the overlay in two of four observations and stayed on
  display 0 in the others. It is situational, and it is reported per run rather than
  asserted. **Consequence that is documented, not hidden:** while the overlay holds system
  focus, a hardware keyboard would type into the overlay. Touch on the physical panel is
  unaffected. Closing the display (which every run does) returns the pointer to 0.
- Display 0's `mCurrentFocus` can read `null` while the overlay owns focus; the focused
  app is unchanged. The harness compares the app, and reports the excursion.

## What was NOT done

- No tap, swipe, key, text or launch ever named display 0. The run records count this
  (`crown.structural.displayZeroInputCalls` and `.displayZeroLaunch`), and the structural
  count is asserted to be zero.
- No accessibility service, no root, no device admin, no daemon, no always-on service.
- No global setting other than `overlay_display_devices` was written, and it is reverted
  in the same run — with a residue check that fails the run if it is not.
- No third-party app was driven. The only app launched was `com.freebuff.gowild`, which
  this repository owns and which is on the allowlist.

## Open item

The human-side half of acceptance 6 — "the owner watched the phone and saw nothing" — is
the one claim these records cannot make. The owner was using the phone throughout; the
machine side shows focus equality, zero attributable changes and zero display-0 input.
That last confirmation is the owner's to give.
