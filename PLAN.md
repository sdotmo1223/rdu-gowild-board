# PLAN — tomorrow, and what runs while you are at the gym

Written 2026-11-02, for a session that starts the morning of 2026-11-03.
Everything here is prepared already; nothing is left as "figure this out first".

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
      Create the empty repo at https://github.com/new (name: rdu-gowild-board, no README),
      then run these two lines separately — PowerShell 5.1 rejects `&&`:

      `git remote add origin https://github.com/sdotmo1223/rdu-gowild-board.git`
      `git push -u origin main`
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
