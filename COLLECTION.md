# COLLECTION — making the data pipeline dependable, then what it unlocks

Written 2026-11-04. `MONITOR.md` records what broke; this file says what we are
building so it stops breaking, in what order, and how each step is proven. Part II
is the forward brief: what the system becomes once collection is boring.

The one sentence: **collection is the product.** The board, the timing table, the
weekday grid and the fare mechanics are all views over one stream of observations.
Every hour that stream is thin, late or partly stale, four features quietly lie.
No new feature is worth building until that stream has a contract and a test.

---

## Part I — the collection plan

### What "without fail" can honestly mean

There are three ways this stops, and they need different defences. Conflating them
is how the last two incidents happened.

| Class | Example already seen | Defence | Can we prevent it? |
|---|---|---|---|
| External refusal | DataDome `302 /Flight/Redirect`; transient burst refusals | abort-on-refusal, carry previous rows, never retry | No — only survive it and say so |
| Scheduler | GitHub fired 24 runs in 24 h on a `*/15` cron; 42–81 min gaps | make rotation tick-driven, not clock-driven; archive as heartbeat | No — only stop depending on the assumed cadence |
| Our own code | `boardRows is not defined` after 42 paid requests | lint, dry run, fixture matrix, write-path preflight | Yes, completely — this is the one we own |

So the target is not "no failures". It is: **external failure is visible within one
tick and costs no data; our own failure is caught before a single request is spent.**

### Measured starting point (2026-11-04)

| Claim | Measured | Source |
|---|---|---|
| Requests answered this tick | 14 / 14, `lastError: null`, `aborted: null` | live `/api/ingest` |
| Sweep success across runs | 23 success / 1 failure in 25 runs | `MONITOR.md` |
| Deploy success | 6 / 7 | `MONITOR.md` |
| Actual cron cadence | median 60 min, min 42, max 81 (24 runs/24 h) | GitHub run list |
| Freshness of the *fresh* half | 28 min | live snapshot |
| Freshness of the *carried* half | **388 min** | `carriedAt` on 14 records |
| Snapshot size | 172 KB | live snapshot |
| Dry run wall clock | ~9.5 s | `npm run dry` |

### The contract — five guarantees the pipeline must hold

1. **G1 · Freshness.** Every route in the profile is really fetched at least once
   every two ticks. Carried is allowed; carried for more than two ticks is a bug.
   *Violated today: 7 of 14 routes at 388 min.*
2. **G2 · Coverage.** No route starves because of budget, offset or quarantine.
   A route may be retired only by an explicit `notServed` verdict, and must return
   for a re-check after `QUARANTINE_RETRY_MS` (7 days).
3. **G3 · No loss.** A sweep that produced parseable data is never discarded: the
   alert/notify path is wrapped, and the write is the last thing that can fail.
4. **G4 · Visibility.** Any breach of G1–G3 is visible without reading logs: a
   per-route age is on the page, and a breach older than 3 h raises a push.
5. **G5 · Politeness.** Zero retries to Frontier. A retry is a second request.
   Retries to *our own* Worker are allowed and bounded — that costs Frontier nothing.

### Phase 1 — tick-driven rotation (fixes G1) · highest value

Root cause, measured: `routeShard()` is `floor(now / 15 min) % 2`. GitHub runs
hourly, and one hour is exactly four 15-minute slots, so every run at the same
minute sees the same parity and asks the same half. The other half flips only when
the runner's minute drifts.

Change:
- Write the shard actually used into the snapshot (`state.lastShard`), and plan the
  next tick as `1 - lastShard`; fall back to the clock slot only when the field is
  absent (first run, or a snapshot written by an older build).
- Do the same for the budget `offset = floor(now / 15 min) % list.length` — it has
  the identical phase problem, and with `SWEEP_MAX_REQUESTS` below the shard size it
  would pin the same tail slice forever. Replace with `state.routeCursor`.
- Keep `FULL_SWEEP=1` and `SWEEP_ONLY` deterministic: a forced sweep ignores both.

**Acceptance:** a new `test/rotation.mjs` proves, over a simulated 12-tick sequence
at 60-minute spacing, that (a) each half is asked on alternating ticks, (b) every
route in a 14-route pool is asked within any 2 consecutive ticks, (c) with
`SWEEP_MAX_REQUESTS=8` every route is asked within any 4 ticks. Plus: after the next
two live ticks, `max(carriedAt)` on the live snapshot is under 2 ticks.

### Phase 2 — freshness ledger and a health endpoint (fixes G4)

- `state.coverage[code] = { lastFetchAt, lastOkAt, fails, carriedFrom }`, written
  every tick from data already in hand — no extra requests.
- `/api/board` already exposes `requests`, `lastSweep`, `aborted`, `sweepError`.
  Add `coverage` and `oldestRouteAgeMin` (token-gated, same as the board).
- The page keeps its per-date "7/14 routes re-checked · 7 carried from HH:MM ET"
  line and gains the worst-case age across routes, phrased as fact: *"oldest route
  reading is 6 h 28 m old"* — never a green check while that number is large.
- Alert: `oldestRouteAgeMin > 180` → one ntfy push per 6 h, deduped like the rest.

**Acceptance:** `test/stress.mjs` gains cases for a snapshot with no `coverage`
(renders, no crash), one route 400 min old (banner names it), and all routes fresh
(no banner). The existing "empty grid is forbidden" invariant is untouched: this
adds a reason, never removes one.

### Phase 3 — the fixture matrix (kills the "our own code" class)

The dry harness currently replays **one** journey: dep 21:30, $30.81, nonstop. It
proves wiring, not breadth — a parser regression that only affects multi-leg or
sold-out rows would pass every gate and be found by the cron.

Add fixtures captured from `.sweep/` (no new requests) for each shape Frontier
actually emits:

| Fixture | Shape | What it must prove |
|---|---|---|
| `nonstop.json` | 1 leg, $15.41 | the cheapest true case survives the whole path |
| `onestop.json` | 2 legs, $25.21 / $30.81 | segment count, `+1` arrival flag |
| `soldout.json` | `goWildFareSeatsRemaining: "0"`-style string / none | `0` survives as sold out, never as "seats available" |
| `noflights.json` | `journeys: [{flights: []}]` | renders "no flights", not an error banner |
| `blackout.json` | every `goWildFare` inflated (~$317.96) | renders `Peak Day Charge $79+`, never blank |
| `notserved.json` | city pair not sold | classified `notServed`, does not trip the "all failed" guard |
| `blocked.json` | 302 + challenge body | aborts the sweep, preserves previous rows, sets `lastError` |

`npm run dry` runs the whole matrix through `collector/main()` in dry mode and
asserts: parsed fields, the emitted page contains the right reason per date, the
snapshot is *not* overwritten for `blocked.json`, and the emitted client script
still parses (`new Function`) — the pin/ICS/PWA failure mode already recorded in
`AGENTS.md`.

**Acceptance:** `npm run dry` covers 7 fixtures; deleting any parser branch makes at
least one fixture fail. Verified once by deliberately breaking `normalizeSeats()`.

### Phase 4 — refusal as recorded data, not a surprise (supports G1/G3)

- `state.refusals` keeps the last refusal `{ at, dest, reason, attempts, total }`
  and the page already shows the carried stamp; add the refusal time explicitly.
- After a refusal for a profile, set `state.coolDownUntil = now + 1 tick`. The next
  tick for that profile sweeps nothing and says so, instead of walking into a
  refusal that spends the whole burst.
- Still zero retries. The cool-down is a *skip*, which is the cheapest possible
  response to a refusal.

**Acceptance:** unit test that a recorded refusal causes exactly one skipped tick,
then normal service; and that the skip is visible in `/api/board`, not silent.

### Phase 5 — stop depending on the assumed scheduler (fixes G1's premise)

Two facts we cannot change: GitHub is best-effort on `*/15` (measured hourly), and
**GitHub disables scheduled workflows in a public repo after 60 days without
repository activity** — a cron-only repo can go dark with no error anywhere. That
is the quietest failure mode in the system.

- Keep `*/15`; add a second schedule entry at a different minute (`7,22,37,52 * * * *`)
  so a throttled slot still has a second chance.
- Phase 6's daily archive commit is also the heartbeat that keeps schedules enabled.
- Record the real cadence in `README.md` (hourly measured) instead of implying
  fifteen minutes, so the freshness claims match behaviour.

**Acceptance:** `README.md` and `AGENTS.md` state the measured cadence; a one-line
check in the health endpoint reports `runsLast24h`.

### Phase 6 — durable archive (protects the only irreplaceable data)

KV prunes at 21 days / 8,000 instances (`src/pricing.mjs`). `firstSeen` and
`schedule` are not reproducible — they are the timing and weekday models' only
source, and a bad write or a KV reset destroys them.

- Once a day the sweep job appends a compact JSONL line set (compressed) under
  `data/YYYY-MM.jsonl.gz` and commits it with `GITHUB_TOKEN`. Estimated a few KB/day;
  keeps the repo active (Phase 5) and gives analysis beyond 21 days.
- Weekly, a `tools/rebuild-state.mjs` proves the archive can reconstruct
  `firstSeen` + `schedule` into a working snapshot — an archive never restored is
  not an archive.

**Acceptance:** a dry-run rebuild from the committed archive produces a snapshot
that renders and whose `firstSeen` matches the live one exactly.

### Phase 7 — capacity accounting (so we notice limits before they bite)

| Limit | Free allowance | Our use | Headroom |
|---|---|---|---|
| KV writes | 1,000/day | ~1/sweep + history rows; measured 96/day at hourly | 10× |
| KV value size | 25 MB | 172 KB snapshot | large, but `fares` grows |
| Actions minutes | unmetered (public repo) | ~3 min/run | must stay public |
| Frontier requests | our own politeness budget | 14/tick RDU, 10 LGA, 16 PHL | fixed by design |
| Chromium install | ~40–70 s/run | cached by lockfile hash | fine |

**Acceptance:** `/api/board` reports `snapshotBytes`; a snapshot over 5 MB logs a
warning in the sweep that names pruning, not silence.

### What we will not do

No retries to Frontier. No parallel route fetches. No `SWEEP_DAYS > 2` in the normal
cadence. No second process. No cookie in the repo. No checkout/payment/booking path,
ever. No raising the burst to "catch up" — a refusal costs more than a gap.

### Which features those phases actually unblock

| Feature | Data it needs | Have now | Unblocked by |
|---|---|---|---|
| Release timing per route | pre-flip rows, ≥3 per route | 13 total, ~1/dest | Phases 1+3, then ~2 weeks |
| Weekday open rate | 2 dates per weekday | 1 per Tue–Thu, 0 Fri–Mon | ~2026-11-17 at 2 dates/day |
| Stable vs rotating schedule | 2 weeks of dates | 1 week → all `sampled` | ~2026-11-17 |
| Fare mechanics / ratio | every itinerary + flip moment | 179 instances, 108 GoWild, 13 pre-flip | **already satisfied** |
| Seat depletion | a sold-out sighting | 54 with seat text, 0 sold out | Phase 3 fixture + time |
| Trustworthy freshness line | per-route age | board-level only | Phase 2 |

---

## Part II — the brief: where this goes next

### The asset we are actually accumulating

Not a list of cheap flights. A **time series of a capacity-controlled inventory
channel**: for 14 city pairs, every day, what Frontier offered, at what price, from
when, and for how long. That series does not exist anywhere public. It is the only
reason this project can say something a fare aggregator cannot: *when* GoWild opens
for a given route, and how often it opens at all.

### Block N1 — a five-day horizon instead of two

Today: 7 routes × 2 dates. The same 14 requests can become 5 routes × 3 dates, or —
better — keep 7 routes and rotate *dates* so that over three ticks the horizon
reaches five days. Cost: zero extra requests, one day of latency per far date.

Why it matters: "can I plan a weekend?" is the actual question behind a same-week
board. It also triples the weekday denominators per unit time, which is exactly what
the open-rate table is starved of.

Risk: a far date is re-checked less often, so a flip on day+4 is noticed late. That
is acceptable for planning and must be labelled per date, never averaged away.

### Block N2 — prediction with error bars, or none

The timing model currently reports a median hour that is really our window entry
(histogram: 00:00→16, 01:00→15, 03:00→9, 04:00→50). The honest version:

- Split every instance into `before window` / `in window` — only in-window sightings
  are evidence of a Frontier decision (already identified in `PLAN.md`, still unbuilt).
- Model "time to first GoWild sighting" as a survival problem with right-censoring:
  an instance still closed at the edge of our window is not a "no", it is censored.
- Publish per-route release hour only at `n ≥ 3` pre-flip rows, with a Wilson
  interval on the open rate, and print the denominator next to every number.
- Target after four weeks: per-route median release hour with an interval, and a
  route-level open rate at 2 dates/weekday.

The failure to avoid: a confident-looking 3 AM that is our own cron. A wrong model
here is worse than no model, because it sends someone to look at the wrong hour.

### Block N3 — the reverse lane (round trips)

`/Flight/InternalSelect?o1=ATL&d1=RDU` answers a different question, and one that
doubles the practical value: a GoWild out and back is the actual trip. Start with
ATL only (+2 requests/tick, tagged `dir: 'return'`, excluded from the board, history
and schedule, paired with the outbound at +48 h). Only expand if the refusal rate
stays at zero for a week.

### Block N4 — alerts that are actionable

`WATCH` exists (`ATL<=25,MCO<=30`). Next tier, all from data already collected:

- **Leave-by windows**: departure time minus arrival-at-airport buffer, so the push
  says "be at RDU by 05:10" rather than "a flight exists".
- **Seats urgency**: when `goWildFareSeatsRemaining` reports a small count, that is
  the one signal that says *act now* — and it is currently unmeasured because we
  have seen no depletion. Track it per instance.
- **Price-drop**: a flip from above $50 to below it is a different event from a first
  appearance, and worth a separate alert kind.
- **Quiet hours**: no pushes 23:00–06:00 ET except a first-ever sighting for a
  watched route.

### Block N5 — survive an outage

A static mirror on GitHub Pages (free, same repo, built from the last snapshot) means
a Cloudflare incident is a stale board, not a dead link. The Worker stays the source
of truth; the mirror is a fallback that states its own age.

### Block N6 — data products, in value order

1. **CSV/JSON export** of `fares` + `history` per date — makes the archive useful to
   anyone, costs one route handler.
2. **Weekly digest** (ntfy, plain text): opens per route, cheapest seen, flips missed.
3. **Open-rate table by weekday** once four weeks exist — the first genuinely
   predictive artefact.
4. **Cost per hour of travel**: `allin / block time`, which ranks an $30 one-stop
   against a $15 nonstop honestly instead of by sticker price.

### What would make the whole thing worth more than $0 spent

A single sentence, earned by data, that a traveller cannot get elsewhere:
*"For MCO, GoWild historically opens around 16:00 ET two days out and is bookable
about 60% of weekdays; the all-in is $25.21 and it does not move."*
Everything in Part I exists to make that sentence true and to make it say so when
it is not.

### The scorecard to judge Part I by

| Metric | Now | Target |
|---|---|---|
| First-time request success | 23/25 runs (92%), 28/28 requests | ≥95% requests, 0 self-inflicted failures |
| Freshness, worst route | 388 min | ≤ 2 ticks (≤120 min at measured cadence) |
| Self-inflicted failures caught before a request | 1 of 1 since the gates | 100% |
| Snapshot writes lost | 0 since the alert wrap | 0 |
| Features with honest denominators | 4 of 6 | 6 of 6 |
| Frontier requests per tick | 14 | 14 (this is a ceiling, not a budget to grow) |

### Three decisions that need you, not me

1. **Horizon vs freshness** (Block N1): accept 5-day reach with day+4 data a few
   hours old, or keep the sharp 48-hour board? I recommend the horizon, labelled.
2. **Round trips** (Block N3): +2 requests per tick for ATL only — yes or not yet?
3. **Public mirror** (Block N5): a GitHub Pages copy of the last board is public and
   token-free. Add it, or keep the board token-gated as the only surface?
