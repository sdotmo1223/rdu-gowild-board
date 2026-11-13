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

`deploy.yml` runs lint, the doc lint, dry, test and stress before it may publish, then
loads the live page in a browser after the upload.

## 2026-11-12 — every claim has to survive a test

Ten changes, each written as a failing test first. The theme is the same in all of
them: the board was honest about fares and vague about itself.

- **`lastAttempt`** (`src/attempt.mjs`). Every sweep writes `{at, requests, ok, reason}`.
  A dead tick advances it while `updatedAt` and `aborted` stay where the last good
  sweep put them, so `/api/board` can no longer show a new request count under an old
  timestamp.
- **Delivery outbox** (`src/outbox.mjs`). Events are queued with a key and rendered
  copy; `announced`/`lastEvent` move only after a 2xx. Recoverable failures back off
  1/2/4/8 min to a five-attempt ceiling, then the entry is DEAD, kept as a tombstone,
  and the board says **Watch delivery failing** with the provider's own status. A
  `departing` event past its departure is dropped, never sent late.
- **Cron dispatch receiver** (`src/dispatch.mjs`, `[triggers]` in `wrangler.toml`).
  Every 15 min the Worker reads its own board age and asks GitHub to dispatch the
  collector when the board is older than 40 min, with a 10-minute cooldown. Deploy log
  confirms `schedule: */15 * * * *`. **Inert until `GH_DISPATCH_TOKEN` exists** — the
  route reports exactly that instead of failing.
- **Zero-alert coverage union.** "Not one GoWild seat from RDU" now requires the union
  of routes asked to be all 14; the page's station-level sentence uses the same rule.
- **28 requests per tick.** RDU asks 14 routes x 2 dates; pacing is untouched
  (sequential, 2-5 s). Per-tick refusals are tallied in `state.refusalDays` and the
  rollback rule is written in both `sweep.yml` and `collector/collect.mjs`.
- **Shape matrix** (`test/shapes.mjs`). Eleven payload shapes plus a 120-blob fuzz. It
  found a real 500: `src/timing.mjs` iterated `state.sweeps` without checking it was an
  array, so a corrupted KV blob would have taken the page down.
- **Doc lint** (`tools/doc-lint.mjs`, a deploy gate). It failed immediately on two
  references that were already dead — README's `board-collect`, and AGENTS naming the
  deleted `board.yml`/`lga.yml` — and the health suite count in AGENTS (34 -> 48).
- **Fixture dating.** `state.live.json` carries `capturedOn: 2026-11-03`; `lga-board.png`
  carries a PNG `tEXt` comment with the same date. Both were captured then, not today.

Live evidence, sweep run `43334067291` (2026-11-13 00:04Z):

```
sweep plan: 14/14 routes x 2 date(s) = 28 requests (whole list, no shard, budget 28)
sweeps=28/28 requests=28 flights=197 blocked=0 aborted=no
ingest write complete: 623289 bytes
```

After it: `lastAttempt {requests: 28, ok: true}`, `lastSweep {routes: 14, refused: 0,
blocked: 0, ok: 28}`, oldest route **2 min** (was 727 min), withheld rows **0** (was
15), rows offered **20** (was 11). Deploy run `43333872528` reports `Deployed
triggers` + `smoke ok`.

Still on the owner: subscribe the phone to the topic (README has the literal steps),
and mint `GH_DISPATCH_TOKEN` so the cron receiver stops being a no-op.

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

## 2026-11-11 — three red runs, and one lie the gate told itself

25 scheduled runs: **22 success / 3 failure (88%)**, below this file's own 90% bar.
Two of the three failures had a single, reproducible cause.

### The dry gate was red for 2.5 hours every day

Runs `42949370900` (21:56 ET) and `2026-11-10 02:39Z` (21:39 ET) both failed in **16 s**
with `DRY: 1 failed — alert block executed`. Not flaky: **deterministic**. The fixture
carries a real capture whose only departure is **21:30:00**, re-based onto today. After
21:30 ET every row is in the past, so `boardRows` is empty, `appendTransitions` adds
nothing, `buildAlert`/`buildWatchAlert` return null by design, and the harness sees no
alert line at all. The gate was correct and the fixture was stale.

Fixed: the fixture is re-timed to keep its first departure **three hours ahead of now**,
preserving inter-leg offsets. Proof at a simulated 22:13 ET clock — the exact case that
was red — now prints `[dry] alert would be sent` and a departure of `01:13`. A new
assertion (`the fixture still has a departure ahead of now`) fails if this regresses at
any hour, instead of only at night.

### One apt DNS blip cost every origin

Run `43058005681`: `Temporary failure resolving 'azure.archive.ubuntu.com'` during
`playwright install --with-deps`, `exit 100` after **10 m 27 s**, zero Frontier requests.
Because all three origins share one job, RDU, LGA **and** PHL all lost that tick; PHL
went 8 h 58 m without a snapshot.

Fixed: the browser download is retried twice and the system-package step is best-effort.
A missing font costs nothing (launch happens before any Frontier request); a failed
install cost the whole sweep.

### The recovery entry cannot do what it was added for

At 17:20Z the newest run was 16:24Z, and the `16:35 / 16:50 / 17:05` recovery entries had
produced **no run record at all**. That is the documented behaviour: a `schedule` event
GitHub drops never creates a run, and the freshness gate is evaluated *inside* a run.
A second cron entry is a second event in the same congested queue, so the gate can only
suppress duplicate work — it cannot resurrect a missing slot. Measured live: all three
boards 6–9 h stale while every recovery entry silently did nothing.

The only real fix is external dispatch (`workflow_dispatch` is a separate queue and
starts in seconds) from a free 15-minute trigger holding a token with `Actions: write`.
Until that exists, do not read a green recovery run as evidence the cron is delivering.

### The bell said push was off while a working topic sat in KV

`NTFY_TOPIC` has been a repo secret since 2026-11-04 and the collector stores it in KV
with every snapshot; the stale alert read it from there. But `channelStatus()` and
`pushRequest()` read `env.NTFY_TOPIC` only, so every sheet drew push as *off* and refused
to arm a watch it could have delivered. `resolveTopic()` now resolves once (env, then
KV) and feeds the sheet, the arming call and delivery.

### The stale alert judged the wrong origin

`maybeStaleAlert` read the RDU key on **every** path and shared one dedupe key, so
opening `/phl` evaluated RDU's age, a healthy RDU masked a dead PHL, and the first
profile to alert silenced the others. Now keyed per profile, labelled with the origin,
and scheduled only by the route that renders that profile.

### Restored, measured

Manual dispatch `43069695681` (all three profiles): **success**. Immediately after,
`/rdu` 7 min, `/lga` 6 min, `/phl` 4 min — all fresh, all reporting `status=ok` with zero
bookable rows, which is Frontier releasing nothing under the ceiling at midday, not a
rendering failure. The page states that rather than showing an empty grid.

## How to check health in 30 seconds

```bash
npm run lint && npm run dry && npm test && npm run stress   # chain integrity
gh run list --workflow gowild-sweep -L 5                    # did the crons land?
curl -s "$BOARD/api/board?token=$TOKEN" | jq '{updatedAt,ageMinutes,stale,requests,lastSweep,sweepError}'
```

## The deploy pipeline shipped nothing for two days, 2026-11-04

Found while verifying fix 1 of the infrastructure list. The evidence, in order:

- `wrangler deployments list` shows exactly **one** deployment ever:
  `2026-11-03T17:32:32Z`, version `56b8e9df`. Everything committed to `src/` since
  then has never reached the edge.
- `gowild-deploy` reported **success** on every push. Run `41935363347` proves why:
  step conclusions `Gates = success`, `Deploy to Cloudflare = skipped`,
  `Say why nothing was deployed = success`. `CF_DEPLOY_TOKEN` was absent, and the
  workflow turned that into an `::notice::` instead of a failure.
- A green run whose only effectful step is skipped is the same class of lie as an
  empty grid: it asserts something happened when nothing did.

### The token that then failed, and how it was named

`CF_DEPLOY_TOKEN` was set on 2026-11-05 and the deploy failed with Cloudflare's
`No access to the specified service`. That message covers an invalid value, a token
in another account, a token with no account grants, and a missing script. Three
cheap preflight questions separated them, and each run removed one hypothesis:

| Run | Question asked | Answer |
|---|---|---|
| 41943400735 | deploy with configured wrangler | `No access to the specified service` (wrangler **3.90.0**, action default) |
| 41943638741 | can the token read this Worker? | HTTP **403**, `No access to the specified resource.` |
| 41943828676 | is the value a live token? | HTTP 200, `status: active` — valid |
| 41943828676 | which accounts can it see? | `{"result":[],"total_count":0}` — **none** |
| 41944796677 | same, with the message split out | *"This token has NO account permissions at all"* |

Root cause: token `00611db77d9a4b6ea17e31a2e03e001a` is active but was created with
**Account resources left empty**, so it can reach no Worker in any account. Adding
`Workers Scripts: Edit` to it is not enough — the account grant is the missing half.

The workflow now asks those questions before deploying, prints the token id, and
pins `wranglerVersion: '4'` (the action default was three majors behind this repo
and cannot read `preview_urls`).

### Own-goal

A `sed` backreference written through a shell heredoc reached the file as a literal
`0x01`. YAML does not allow control characters in a scalar, so GitHub stopped reading
`name: gowild-deploy`, listed the workflow as `.github/workflows/deploy.yml`, and
`gh workflow run gowild-deploy` answered *"could not find any workflows named"*.
The deploy was fine; the file was not. Check for `[[:cntrl:]]` after any scripted
YAML edit, and confirm `gh workflow list` still shows the workflow by name.

### 2026-11-13 — I0: the ledger suite was proved able to fail

`test/ledger.mjs` passed on its first run, so nothing had ever been seen rejecting
anything. The modal-time sort in `src/ledger.mjs` was inverted deliberately
(`b.dates.length - a.dates.length` became `a.dates.length - b.dates.length`):

```
AssertionError [ERR_ASSERTION]: the modal Wednesday time wins over the stray 06:30
  actual: '06:30'
  expected: '15:30'
LEDGER_RED_EXIT=1
```

The module was restored byte-for-byte from a copy and re-run:

```
ledger: 32 checks passed
LEDGER_GREEN_EXIT=0
```

Rule from here: a new suite is not finished until it has been *seen* failing for the
reason it claims to test. "Written first" is not the same as "watched fail".
