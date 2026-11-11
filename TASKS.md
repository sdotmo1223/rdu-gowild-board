# TASKS — the running list

One list, one open item at a time. This file exists because work was being taken
on in parallel and finished in none of the branches; every item here is a single
outcome with an evidence bar, so an agent can pick the top one, finish it, and
leave the list honest.

**Rules for whoever works this list**

1. Take the **first** item marked `open`. Do not start a second one.
2. Move it to `in progress` with the date and who is on it, in the same commit
   that starts the work or before any edit is made.
3. An item closes only when its **Done when** line is true *and* `npm run lint`,
   `npm test`, `npm run stress` exit 0. Record the commit hash next to `done`.
4. If an item cannot be done, it becomes `blocked` with the reason on the same
   line — never deleted, never quietly dropped.
5. Do not add an item here to look busy. An item is work that a human or an agent
   would otherwise forget, and each one names the failure it prevents.

Status values: `open` · `in progress` · `blocked` · `done` · `deferred` (deliberately
not doing, with the reason).

---

## Queue

### T1 — Prove a watch actually rings

- **Status:** open · **Size:** 15 min · **Needs:** one deploy + one sweep tick
- **Intent:** a bell that cannot deliver is worse than no bell, because it looks armed.
- **Why (re-diagnosed 2026-11-11):** the original note blamed a missing Worker
  secret. The real defect was narrower and worse: `NTFY_TOPIC` **is** a repo secret
  (set 2026-11-04), the collector stores it in KV (`notify:topic`) with every
  snapshot, and the stale alert already read it from there — but `channelStatus()`
  and `pushRequest()` read `env.NTFY_TOPIC` only. Every sheet therefore drew push as
  *off* and refused to arm a watch it could have delivered. Fixed by `resolveTopic()`,
  which resolves env-then-KV once and feeds the sheet, the arming call and delivery
  (`test/health.mjs`, 9 checks).
- **Do:** deploy the Worker, arm a bell on the token page for a route that is
  bookable, and wait for one tick.
- **Done when:** one real push arrives on the phone, caused by a sweep that changed
  that route's state — and the sheet showed push as *on* before the tick.
- **Prevents:** shipping a notification feature that has never notified.

### T2 — Make the documented suite count true again

- **Status:** done 2026-11-11 · **Size:** 10 min · **Needs:** agent
- **Intent:** `AGENTS.md` is the file an agent trusts before touching anything; a
  wrong count there is a broken map.
- **Why:** the `npm test` line in `AGENTS.md` still says *9 suites, 200 checks*.
  `test/all.mjs` now runs ten, and the watch suite alone is 127 checks. The file map
  also has no row for `test/sink.test.mjs` because that file is not committed.
- **Do:** run `npm test`, count the suites, correct the line, and re-read the file
  map against `ls src test tools`.
- **Done when:** the numbers in `AGENTS.md` match a fresh `npm test` run.
- **Prevents:** an agent concluding a suite is missing because the map is stale.

### T3 — Put the watch work into the build log

- **Status:** done 2026-11-11 · **Size:** 20 min · **Needs:** agent
- **Intent:** `HANDOFF.md` is the chronological record, including the wrong turns.
  A whole subsystem is missing from it.
- **Why:** `grep -c -i watch HANDOFF.md` returns **0**, while `src/watch.mjs` (488
  lines), `test/watch.mjs` (509 lines) and the sheet/bell rendering landed in
  `9bcf465`. The next agent cannot tell what was tried and abandoned.
- **Do:** append a dated section: what a watch is, the four judgement calls
  (baseline on first look, *left* vs *sold out*, rows older than 3 h produce no
  event, delivery failures never cost the snapshot), and what is still unproven
  (T1).
- **Done when:** a reader can explain a watch's firing rules from `HANDOFF.md` alone.
- **Prevents:** re-deciding settled questions, or "fixing" them back.

### T4 — One contract for the sink, not two

- **Status:** done 2026-11-11 · **Size:** 15 min · **Needs:** agent
- **Intent:** the sink's contract should have exactly one owner.
- **Why:** `test/sink.mjs` (21 checks) runs inside `npm test`; the newer
  `test/sink.test.mjs` (12 checks, `node:test`) covers the same routes and is
  **untracked**. Two files drifting apart is how one of them silently stops being
  the truth.
- **Do:** keep one — either adopt the `node:test` file into `test/all.mjs` and delete
  the bespoke runner, or delete the untracked file. Whichever survives must still
  fail when the completion route is removed; re-run that mutation afterwards.
- **Done when:** one file, registered or deliberately not, and the deletion mutation
  still turns a green run red.
- **Prevents:** a contract test that no gate executes.

### T5 — Get `git status` clean

- **Status:** done 2026-11-11 · **Size:** 5 min · **Needs:** agent
- **Intent:** a dirty tree hides the next real change.
- **Why:** `watch-board.png` and `watch-sheet.png` sit untracked in the root (scratch
  screenshots), while `.gitignore` already lists `preview-board.png`, `/rdu.html`
  and `/rdu-chart.png` one at a time — the pattern is ignore-by-name and it has
  already been missed once (`lga-board.png` is *tracked*).
- **Do:** ignore the class (`/*.png`, keeping any genuinely referenced image
  explicit), and decide `lga-board.png` — keep it or untrack it.
- **Done when:** `git status --short` is empty on a fresh clone plus one sweep.
- **Prevents:** committing a 400 KB screenshot by accident.

### T6 — Record what the recovery cron actually changed

- **Status:** open · **Size:** 10 min per week of data · **Needs:** agent, later
- **Intent:** `MONITOR.md` claims a 90% first-attempt bar and reports 23/25 with the
  last five at 3/5. The fix inside that window is unmeasured.
- **Why:** `82923e4` added the `5,20,35,50` recovery entry, which skips when the
  board is under 40 minutes old. Nothing in `MONITOR.md` reflects it, so the
  number that justified the change is still the pre-change number.
- **Do:** after a week, read the workflow runs, count successes, and add a row: before
  vs after, deliveries observed vs expected, recovery ticks that skipped vs swept.
- **Done when:** `MONITOR.md` shows a measured before/after, not an expectation.
- **Prevents:** keeping a cron that doubled nothing, or removing one that worked.

### T7 — Make `PLAN.md` honest or fold it in

- **Status:** done 2026-11-11 · **Size:** 15 min · **Needs:** agent
- **Intent:** a plan with unticked boxes for finished work reads as work remaining.
- **Why:** `PLAN.md` Phase 1 still shows `[ ]` for `wrangler login`, the KV namespace,
  `BOARD_TOKEN`, `wrangler deploy` and the repo secrets. All of that is done: the
  Worker is live, the namespace id is in `wrangler.toml`, and both tokens are set.
- **Do:** tick what is done with the commit that did it, move what remains into this
  file, and leave `PLAN.md` as history with a header saying so.
- **Done when:** nothing unticked in `PLAN.md` is actually complete.
- **Prevents:** an agent re-running a five-step setup that is already finished.

### T8 — See the alarm fire for real

- **Status:** done 2026-11-11 · **Size:** 20 min · **Needs:** agent, costs one burst
- **Intent:** an alarm never observed firing is not an alarm — `PLAN.md` Phase 3 says
  this and it is still unproven.
- **Closed because the evidence already existed and this item was stale:**
  `HANDOFF.md` records the abort firing in production on 2026-11-03 —
  `partial — "Sweep stopped at DTW after 21/28 requests (no-journeys-key).
  2026-11-04 only reached 7/14 routes; 7 rows carried from the previous sweep."` —
  and `MONITOR.md` records the same mid-burst refusal. The board kept its previous
  rows and stated the carried count, which is the done condition.
- **What is still unproven is the notification half**, and that now belongs to T1:
  no watch has ever delivered a push.
- **Prevents:** re-running a paid experiment whose result is already on record.

### T9 — Email as a second channel

- **Status:** deferred · **Reason:** push already costs nothing and covers the phone;
  Resend needs a verified domain to reach any address but your own, and Twilio is
  **not** free, so text stays off deliberately. Revisit only if push turns out to be
  unreliable.
- **Done when (if it is ever taken):** one email arrives from a verified domain, and
  the sheet stops saying "off".

---

## Done

| item | what closed it | commit |
|---|---|---|
| sink `/done` receipt | route restored, 21-check suite plus a deletion mutation that fails | `b88ceb7` |
| dropped GitHub slots | gated recovery cron, 11 checks, skip under 40 min | `82923e4` |
| per-route watches | bell + sheet + KV record + delivery, 127 checks | `9bcf465` |
| T2 suite count / file map | `npm test` measured at 10 suites / 336 checks; map lists merge, dry, watch and all, plus the deleted workflows | this commit |
| T7 `PLAN.md` | header declares it history; setup steps are recorded as done | this commit |
| T8 alarm fired | production log already existed (DTW, 21/28); item was stale, not the code | this commit |
| watch push unreachable | `resolveTopic()` env-then-KV, threaded into the sheet, arming and delivery; 9 checks | this commit |
| dry gate red after 21:30 ET | fixture retimed to always keep its first departure 3 h ahead; late-clock proof at 22:13 ET | this commit |
| one Chromium install cost every origin | browser download retried twice, system deps best-effort | this commit |
| stale alert judged the wrong origin | per-profile key, label and dedupe, scheduled only by the route that renders it | this commit |
| T4 two sink contracts | the untracked duplicate (`test/sink.test.mjs`) deleted; `test/sink.mjs` in `test/all.mjs` is the one contract | this commit |
| T5 dirty tree | the stray galaxy experiment, its builder and the duplicate test deleted; `/*.png` ignored as a class | this commit |
| scope: RDU only until mastered | LGA/PHL unscheduled, `/lga` and `/phl` off, RDU budget 14 per tick; profiles kept so a dispatch can still ask | this commit |
| a transient push error cost six hours | one bounded retry, transient statuses only (observed: ntfy HTTP 522 on the first real delivery); 5 checks | this commit |
