# PLAN — tomorrow, and what runs while you are at the gym

Written 2026-11-02, for a session that starts the morning of 2026-11-03.
Everything here is prepared already; nothing is left as "figure this out first".

> **This file is history, as of 2026-11-11.** Every Phase 1 item is done: the repo
> exists and is public, the KV namespace id is in `wrangler.toml`, both tokens are
> set, the Worker is live at `rdu-gowild-board.sdotmo1223.workers.dev`, and
> `sweep.yml` runs on a schedule. The unticked boxes below are kept as the record of
> what was asked, **not as work remaining**. Work that is actually open lives in
> `TASKS.md`; measured evidence lives in `REPORT.md` and `MONITOR.md`.

---

## The one sentence

The system works but does not run by itself. Tomorrow is about **getting it onto
a schedule and making that schedule survive Frontier's throttle** — not about new
features.

Two facts decide the order:

1. ~~A 28-request burst gets soft-throttled around request 15.~~ **Corrected
   2026-11-03:** the same 28-request burst now completes cleanly (28/28 ok, 186
   flights, 0 blocked), and a 14-request burst did the same. The earlier refusal
   was **transient**, not a quota. Keep abort-on-refusal as a safety net; do not
   design around a 14-request budget.
2. The release-timing model and the weekly-schedule matrix both need **scheduled
   uptime**, not more code. Every hour it is not running is an hour of data lost
   permanently, because neither can be backfilled.

---

## Phase 0 — while you are at the gym (no input needed)

These are safe, local, reversible, and spend **zero** Frontier requests.

- [x] Abort-on-refusal in the collector (`shouldAbortSweep`), unit-tested.
      **Not yet observed firing live**: both live runs this morning completed all
      requests, so the stop path is proven by test only, not by production.
- [x] Partial-sweep retention extracted to a pure `mergeSweeps()` and tested — a
      date with no usable payload keeps its previous rows.
- [x] Two live bursts (14 and 28 requests) both completed cleanly, which corrects
      the throttle theory above.
- [x] Add `SWEEP_DAYS` so a deliberate backfill is possible without editing code.
- [x] Re-run `npm test` and `npm run stress`, commit.
- [x] Regenerate `board.html` from real captures so the preview is never a fixture.

Anything that needs a decision from you is **not** in this phase.

## Phase 1 — the 5-minute unblock (you)

- [ ] Create the GitHub repo and push:
      DONE 2026-11-03: repo exists and is **public** (confirmed via `gh repo view`), origin -> https://github.com/sdotmo1223/rdu-gowild-board.git,
      6 commits on main. The scheduled workflow is **disabled_manually** on purpose:
      it has no secrets yet, so enabling it would sweep Frontier every 15 minutes and
      write nothing. Enable it only after phase 2 sets the secrets.
- [ ] `npx wrangler login`
- [ ] `npx wrangler kv namespace create BOARD` → paste the id into `wrangler.toml`
- [ ] `npx wrangler secret put BOARD_TOKEN` (any long random string)
- [ ] `npx wrangler deploy`
- [ ] Add repo secrets: `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`
- [ ] Optional but recommended: `NTFY_TOPIC` → subscribe to that topic in the ntfy app

**Done when:** `https://<worker>.workers.dev/s/<BOARD_TOKEN>` loads on your phone.

## Phase 2 — first scheduled run (10 minutes)

- [ ] Actions → *board-collect* → Run workflow
- [ ] Confirm the KV key `state` exists and the page shows a fresh timestamp
- [ ] Open it on your phone, add to home screen

**Done when:** the page timestamp is under 16 minutes old without you doing anything.

## Phase 3 — prove the alarm (5 minutes)

- [ ] Temporarily set a wrong `BOARD_TOKEN`... no: instead set an **expired
      cookie** by clearing `FRONTIER_COOKIE` and running once with `SWEEP_DAYS=1`
      against a single route. Expect a *partial/blocked* classification.
- [ ] Confirm the ntfy push arrived and names the problem in plain language.

**Done when:** you have seen a real notification on your phone. An alarm never
observed firing is not an alarm.

## Phase 4 — let it run (2 weeks, hands off)

Do **nothing**. The value now comes from elapsed time:

| Day | What accrues |
|---|---|
| Day 1 | every route's first-seen time → timing model at 1 sample |
| Day 3 | 3 samples → `MIN_SAMPLES` met, timing becomes "confident" |
| Day 7 | each weekday × 1 → schedule matrix populated, weekly comparison starts |
| Day 14 | each weekday × 2 → **stable vs rotating verdict becomes possible** |

**Done when:** `Weekly schedule` says either "same every week" or "varies by week"
per route, and `When seats appear` states a time instead of "not yet a pattern".

## Phase 5 — then, and only then, more features

Ranked by value per unit of risk:

1. Verify pins / `.ics` / PWA install by actually clicking them (never tested in a browser).
2. Static GitHub Pages mirror, so a Cloudflare outage is not a total outage.
3. Multi-origin (CLT/GSO) — 2× requests, so only after throttle handling is proven.
4. Fare history sparkline per route (data already in `history`).

---

## What "done" looks like tomorrow night

- Page reachable on a phone, refreshing itself every 15 minutes
- One real alert seen on that phone
- Sweep runs that have not been throttled to zero
- Schedule matrix accumulating, timing model counting down to 3 samples

## Guardrails for whoever runs this

- Never raise `SWEEP_DAYS` above 2 in the normal cadence.
- Never add retries. A retry is a second request, and the throttle is per burst.
- Never delete `state.firstSeen` or `state.schedule` to "clean up" — both are the
  only non-reproducible data in the system.

---

## The mechanism questions, and the experiments that answer them

Added 2026-11-03. Frontier documents the *structure* of GoWild (a $0.01 fare plus
taxes; seats capacity controlled per flight) and documents nothing about the
*allocation*. These are the experiments that convert the unknowns into either a
measurement or a stated limit. Every one of them is ranked by requests spent,
because requests are the scarce resource.

### Zero extra requests — pure analysis of what we already store

1. **Is the fare spread just tax arithmetic?** Record `stops` per instance and
   tabulate all-in by segment count and domestic/international. If nonstop sits
   near $15-16, a connection near $25-31, and SJU/CUN near $94-103, then the whole
   spread is per-segment taxes and no pricing algorithm is involved at all. This
   is the single most decisive test we can run and it costs nothing.
   *Acceptance:* medians with denominators per bucket; a plain statement either
   way, never a bare number.

2. **Does the standard fare collapse near departure, or stay flat?** We already
   store `stdMin` per instance. Plot it against lead hours. A collapsing standard
   fare means Frontier is dumping inventory; a flat one means GoWild is a separate
   channel, not a discount ladder. *Acceptance:* slope over at least 3 lead-hour
   buckets, or an explicit "not enough spread yet".

3. **Designated flight, or any under-sold flight?** For every flight number seen
   on 3+ date-instances, tabulate GoWild yes/no. Perfectly consistent per flight
   number = designated. The same flight alternating = load-based.
   *Acceptance:* per-flight verdicts only at `MIN_SAMPLES`; below that, nothing.

4. **Does a GoWild seat run out?** `goWildFareSeatsRemaining` occasionally reads
   "3 Seats Left!". Record those strings. A flight showing seats and later none is
   depletion, and that is Frontier's "first-come, first-served" made visible.
   *Acceptance:* a seats-over-time log per instance.

5. **Is the peak-day fare really the Peak Day Charge?** Our `BLACKOUT_DATES` plus
   the observed inflated GoWild fare (once $317.96) should line up with Frontier's
   published $79-159 surcharge. Next blackout: 2026-11-24/25. No extra requests.
   *Acceptance:* one recorded blackout observation comparing the inflated fare to
   the published range, or an explicit "does not line up".

### One deliberate extra burst

6. **When exactly does a flight enter the window?** Sweep the same routes at
   ~23:55 ET and again at ~00:05 ET. That is the only way to tell "released at
   midnight in the departure city" from "released whenever Frontier chooses".
   Cost: 14 requests, once. *Acceptance:* first-observed GoWild time distribution,
   showing whether it clusters in the 00:00-01:00 hour.

### Needs the reverse lane

7. **Round trip.** Reverse-direction sweeps (`ATL->RDU`) tagged `dir:'return'`,
   excluded from the board, history and schedule, paired with the outbound leg at
   +48 h. Cost: +2 requests per sweep for ATL alone.

### The distinction that decides how we read everything else

8. **Window vs exclusion.** An instance observed before its day-before window has
   opened is *not offered yet*; an instance inside the window with no GoWild is
   *refused by capacity control*. Only the second is a Frontier decision. Until
   this split exists, part of our "no GoWild" count is just our own sweep timing.
   Recorded per instance from timestamps we already have, so it costs nothing.
   *Acceptance:* every instance carries before/in-window; the hour table reports
   the refused rate only over in-window sightings.

**Order of work:** 8 first (it changes the meaning of every other number), then 1
and 2 (decisive, free), then 4 and 5 as they occur naturally, then 6, then 7.
