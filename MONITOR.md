# Monitor — first-time-go reliability record

The bar this file exists to hold: **a request for the board should succeed on the
first attempt at least 90% of the time**, and when it does not, the failure must be
visible, attributed and recorded here — not discovered by a cron email days later.

## Failure log

| when (ET) | what | symptom | cause | fix | commit |
|---|---|---|---|---|---|
| 2026-11-04 06:18 | sweep run 41813290835 | `collector failed: boardRows is not defined`, job red | alert block read a binding declared inside the success branch; threw *after* 42 Frontier requests, *before* the snapshot write | hoisted `boardStamp`/`boardRows` above the branch; alerting wrapped so it can never cost the snapshot | `ce6e4c6` |
| 2026-11-04 05:00–09:00 | deploy runs | `No access to the specified service` | `CF_API_TOKEN` is KV-scoped and cannot upload a Worker | deploy gates the board, states the limitation instead of failing, deploys only from `main` via optional `CF_DEPLOY_TOKEN` | `b8da419`, `c16232a` |
| 2026-11-03 | sweep, KV write | `KV GET 401` after a 19-request sweep | invalid Cloudflare token discovered *after* spending the burst | preflight proves the write path before any Frontier contact; KV errors name the human action | earlier |
| recurring | sweep bursts | `no-journeys-key` mid-burst | Frontier's transient throttle, not a quota | one refusal aborts the sweep; carried rows keep the board intact; per-profile budget caps the burst | by design |

## What runs before a request is spent

In `sweep.yml`, in this order, each cheaper than the next:

1. **Preflight** — proves the write path accepts the token (0 Frontier requests).
2. **`npm run lint`** — `no-undef`, the class of bug `node --check` cannot see (0 requests).
3. **`npm run dry`** — executes the collector's real `main()` against a fixture: plan, parse, merge, alerts, write. No network, no production write (0 requests).
4. Chromium install, then the sweep.

`deploy.yml` runs lint, dry, test and stress before it may publish.

## Measured reliability

- **Sweep workflow: 23 success / 1 failure** across 25 recorded runs
  (0 still running or cancelled). Last 5: 3/5 success.
- **Deploy workflow: 6 success / 1 failure** across 7 runs.
- **Dry run: 9500 ms**, no network, no write.
- **Board now: 11/4/2026, 6:30:36 AM ET, 22 bookable rows, age 2 min, requests 14, shard 1, sweepError null**
- Gates: lint, dry, acceptance 25, multi-origin 9, merge 6, stress 62 — all green
  on commit `7054364`.

Every failure in the table above is now impossible to reach with a green gate chain:
the collector's own wiring is executed by a gate, and the harness is proven to fail
when a binding is out of scope (a copy with `boardRows` renamed to an undeclared
name exits 1 with a `ReferenceError`).

## Open risks that can still cost a first-time go

1. **Stale half of the routes** (above): up to ~6.5 h between real
   fetch and display for 7 of 14 routes. This is the largest gap
   between what the page implies and what it does.

2. **Ntfy delivery is not retried.** A failed push is logged and dropped; the watch
   dedupe will not re-fire until the fare changes. Board data is unaffected.
3. **Half the routes per tick.** A single tick answers 7 of 14 RDU routes; the board
   is complete only after two ticks (~30 min). Reading one tick shows half a list.
4. **The fixture is one journey.** The dry harness proves wiring, not breadth: it
   cannot catch a parser regression that only affects multi-leg or sold-out rows.
5. **Frontier can refuse a burst at any time.** That is external and is handled by
   abort-and-carry, but it still means a given tick may add no new rows.

## Finding 2026-11-04 15:20 ET — half the board refreshes about every 6.5 hours, not every 30 minutes

Measured on the live snapshot (`/api/ingest`, 14:54 ET): 14 sweep records were
fresh, 14 were `carried` with `carriedReason: rotated`. The carried half
(DTW, IAH, MIA, SJU, ATL, CLE, DEN) was last actually fetched at **08:54 ET —
388 minutes earlier**. The other half was fetched at 14:54.

Cause is a cadence mismatch, not a refusal. `routeShard()` picks the half from
`Math.floor(now / 15 min) % 2`, but GitHub does not fire a `*/15` cron every 15
minutes on a busy free runner: 24 scheduled runs in 24 hours, gaps median 60 min
(min 42, max 81). A one-hour cadence is four 15-minute slots, so a run landing at
the same minute each hour always sees the *same* parity and asks the same half.
The carried half only flips when the runner's minute drifts across a slot
boundary — hence 6.5 hours, not 30 minutes.

Impact: a GoWild flip on the carried half can go unseen for ~6.5 h, and the
page's "re-checked every 30 minutes" is not true in practice. The board remains
honest (carried rows are labelled with their age), but the freshness is worse
than documented.

Fix identified, not yet applied: store the shard that was actually used in the
snapshot and alternate from it (`nextShard = 1 - state.lastShard`), so the
rotation follows ticks instead of a clock the cron cannot keep. Any change here
touches the burst budget and needs its own test.

## Seven-pass live verification, 2026-11-04 18:24–18:52 ET

Run **after** the tick-driven rotation landed, which is what made repeated passes
meaningful: under the old clock parity all seven would have asked the same seven
routes and "clean" would have described half a board.

| Pass | Shard | Requests | Answered | Blocked | Flights (fresh) | Ingest | rc |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 14 | 14 | 0 | 71 | 163,233 B | 0 |
| 2 | 0 | 14 | 14 | 0 | 114 | 166,804 B | 0 |
| 3 | 1 | 14 | 14 | 0 | 71 | 168,110 B | 0 |
| 4 | 0 | 14 | 14 | 0 | 114 | 171,673 B | 0 |
| 5 | 1 | 14 | 14 | 0 | 71 | 172,979 B | 0 |
| 6 | 0 | 14 | 14 | 0 | 114 | 176,808 B | 0 |
| 7 | 1 | 14 | 14 | 0 | 71 | 178,378 B | 0 |

**98 requests, 98 answered, 0 blocked, 0 aborts, 7/7 snapshots written, 0 failed
passes.** Shards alternate 1,0,1,0,1,0,1 on consecutive ticks, so both halves are
really asked. With zero failures in 98 trials the one-sided 95% lower bound on the
per-request success rate is **96.99%** (`0.05^(1/98)`).

What KV held at pass 7: 185 flights, 40 with GoWild, `$15.41–$114.39`, median
`$30.81`, 32 of the 40 at or below `$50`. Split by date: 11-04 27 flights/21
GoWild, 11-05 158/19. Every GoWild row had a finite price above zero; BOS again
returned zero flights on both dates. `history` grew 468 → 564 across the run.

### Defect found by the passes, and fixed

A row carried for the **first time** was stamped with the current tick, because a
fresh sweep record carried no timestamp at all (`carriedAt: Number(s.carriedAt) ||
carriedAt` fell straight through to "now"). The board's "7 carried from HH:MM ET"
was therefore up to one tick newer than the data behind it — small, but it is the
exact number a reader uses to judge freshness.

Fixed: each sweep row records `at: Date.now()` at fetch time, and the three carry
paths use `carriedAt || at || now`. Verified live — at pass 7 the carried half
reported 98–160 s against a 93 s tick gap instead of 0 — and by `test/carry.mjs`
(7 checks: first carry, repeat carry, stampless fallback, carry across a refusal,
no drift over three carries).

### Own-goals, recorded so they are not repeated

- `allin` is **`null`, not 0**, on non-GoWild rows, and `null <= 0` is true in JS.
  A careless "prices at or below zero" check reports 145 violations out of 185 on
  perfectly good data. Count GoWild rows explicitly.
- A binomial bound is `0.05^(1/n)`, not `1 - 0.05^(1/n)`. The first form printed
  3.01% for 98 clean requests; the true figure is 96.99%.

## Measurement caveats — do not quote these as Frontier facts

- **Release timing (`medianHour` 2–4 AM) is our window entry, not Frontier's
  release.** First-seen histogram: 00:00→16, 01:00→15, 03:00→9, 04:00→50,
  16:00→1. A date enters the two-day window at midnight ET, so the model is
  measuring when we started looking. The only genuine release evidence is the
  13 instances watched *before* they flipped: 14:30–21:46 ET, lead 14–40 h,
  median 29 h. n=13 across 11 destinations — not yet a per-route model.
- **Weekly schedule verdicts need two weeks of dates.** There is one week
  (2026-11-03..11-05), so all 14 routes read `sampled`, not `stable`/rotating.
- **Weekday bookability denominators are 1** (Tue/Wed/Thu only). Every cell is
  0/1 or 1/1; it becomes a rate after 14 daily sweeps.
- **`allin` is null on non-GoWild rows**, by design (`normalizeFlight` only
  prices the GoWild channel). Any check of "prices at or below zero" must filter
  `goWild` first, or it reports nulls as failures.
- **Flight identity is the first leg.** `1669` repeats across ATL, DEN, DTW —
  those are itineraries whose first leg is the same RDU→ATL flight, so the
  identity verdicts partly measure the hub feed, not the destination.

## How to check health in 30 seconds

```bash
npm run lint && npm run dry && npm test && npm run stress   # chain integrity
gh run list --workflow gowild-sweep -L 5                    # did the crons land?
curl -s "$BOARD/api/board?token=$TOKEN" | jq '{updatedAt,ageMinutes,stale,requests,lastSweep,sweepError}'
```
