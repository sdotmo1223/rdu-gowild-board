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

- **Status:** open · **Size:** 15 min · **Needs:** you (one secret) + one sweep tick
- **Intent:** a bell that cannot deliver is worse than no bell, because it looks armed.
- **Why:** the Worker holds `BOARD_TOKEN` and `BOARD_WRITE_TOKEN` and nothing else.
  Every watch sheet therefore draws push as *off* and names the missing variable.
  Nothing has ever been delivered by a watch in production.
- **Do:** subscribe to a topic in the ntfy app, then `npx wrangler secret put NTFY_TOPIC`
  with that name, then arm a bell on the token page for a route that is currently
  bookable.
- **Done when:** one real push arrives on the phone, caused by a sweep that changed
  that route's state — and the sheet showed push as *on* before the tick.
- **Prevents:** shipping a notification feature that has never notified.

### T2 — Make the documented suite count true again

- **Status:** open · **Size:** 10 min · **Needs:** agent
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

- **Status:** open · **Size:** 20 min · **Needs:** agent
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

- **Status:** open · **Size:** 15 min · **Needs:** agent
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

- **Status:** open · **Size:** 5 min · **Needs:** agent
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

- **Status:** open · **Size:** 15 min · **Needs:** agent
- **Intent:** a plan with unticked boxes for finished work reads as work remaining.
- **Why:** `PLAN.md` Phase 1 still shows `[ ]` for `wrangler login`, the KV namespace,
  `BOARD_TOKEN`, `wrangler deploy` and the repo secrets. All of that is done: the
  Worker is live, the namespace id is in `wrangler.toml`, and both tokens are set.
- **Do:** tick what is done with the commit that did it, move what remains into this
  file, and leave `PLAN.md` as history with a header saying so.
- **Done when:** nothing unticked in `PLAN.md` is actually complete.
- **Prevents:** an agent re-running a five-step setup that is already finished.

### T8 — See the alarm fire for real

- **Status:** open · **Size:** 20 min · **Needs:** agent, costs one burst
- **Intent:** an alarm never observed firing is not an alarm — `PLAN.md` Phase 3 says
  this and it is still unproven.
- **Why:** `refusalEndsSweep` is proven by test only; both live bursts completed
  cleanly. The stale banner and the abort path have never run against a real
  refusal in production.
- **Do:** force one refusal deliberately (`SWEEP_ONLY=ATL` with the payload shape the
  parser refuses, or a warmed-up page that returns `no-journeys-key`), watch it abort
  after two in a row, and confirm the board keeps its previous rows and sets
  `lastError`.
- **Done when:** the refusal is visible on the page and in the notification, the
  snapshot was **not** overwritten, and the request count is in the log.
- **Prevents:** the first real Frontier refusal being discovered by the board going
  blank.

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
