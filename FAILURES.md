# FAILURES.md

Every failure this project produced, why it was not caught the first time, and the
rule that catches it now. One section per role, because the same blind spot looks
different from the collector, the renderer, the deploy pipeline and the reviewer.

Read the section for the code you are about to touch. If you change a behaviour named
here, update its entry in the same commit.

## The catalogue

| # | Symptom | Why the first look missed it |
|---|---|---|
| F1 | Deploy workflow green for two days, nothing shipped | The job's definition of success was the step list, not the artifact |
| F2 | Every profile asked the same routes for ~6.5 h | The shard advanced; the clock-driven offset was the hidden variable |
| F3 | A carried row claimed to be fetched now | `mergeSweeps` re-stamped `at` on rows it had not asked about |
| F4 | PHL aborted at request 11 of 16, one route, no fares | One refusal was treated as a burst budget, not as one route failing |
| F5 | A 29-hour-old fare displayed as today's | Freshness was computed from the snapshot timestamp |
| F6 | A healthy board went amber at 76 minutes | The threshold was measured once and then assumed permanent |
| F7 | The shared page URL could overwrite the board | One token served both reads and writes |
| F8 | `"?row=null"` read as a valid price | `null <= 0` is true in JavaScript |
| F9 | A dispatch YAML broke after a scripted edit | The edit tool was trusted instead of the artifact |
| F10 | Coverage figure inverted (8/14 read as 6/14) | Binomial probability was estimated instead of computed |
| F11 | A proven alert reported as broken | The harness passed the topic as an argv, not an env var |
| F12 | Three tests failed against correct code | The assertions were written from the plan, not from the contract |

### F1 — a green pipeline that shipped nothing

The workflow ran `wrangler deploy`, the step failed, and the job still reported success
because the failure was tolerated downstream. Nobody read the log of a green job.

**Fix:** the deploy job preflights the token (`/user/tokens/verify`, `/accounts`, Worker
read), prints the token id, pins the wrangler major, and fails the job when the deploy
fails. **Rule:** a status is not evidence. Assert the artifact: the version id must
change, and the live Worker must serve it.

### F2 — rotation that rotated nothing

`routeShard()` was right; the offset came from the clock, and the clock did not move
because the cron was late by the same amount every hour. The shard index changed while
the route set did not.

**Fix:** the shard advances on writes (`state.lastShard`, `state.routeCursor`), and the
cursor is persisted. **Rule:** when a rotation is claimed, test the *set* asked over two
ticks, not the counter.

### F3 — a carried row wearing a fresh timestamp

Merging kept old rows for routes not asked and stamped them with the sweep time. The
board was honest about the snapshot and dishonest about the row.

**Fix:** provenance per flight (`seenAt`, `carriedAt`), carried rows keep their real
time. **Rule:** freshness belongs to the thing displayed, not to the container it
arrived in.

### F4 — one refusal starving a profile

PHL tried 11 of 16 planned requests, stopped at the first `no-journeys-key`, kept
day-old rows and looked healthy. The abort was written for a burst budget that a later
measurement contradicted (28/28 clean the next morning).

**Fix:** `REFUSAL_ABORT_STREAK = 2`; three strikes retire a single route for a week
instead of ending a sweep. **Rule:** a safety valve tuned to a transient signal must
cost one request, not a tick.

### F5 — the age of the wrong object

The header said "updated 12 min ago" while rows were 29 hours old, because the age came
from `state.updatedAt`. Every individual statement was true.

**Fix:** `MAX_ROW_AGE_MIN = 180` with per-row provenance, `withheld` counts, a `stale`
date status, and two labelled ages in the header ("oldest fare" only when a fare is on
offer, "oldest data" when rows exist but are withheld, nothing when there are no rows).
**Rule:** an aggregate may never stand in for a per-item claim.

### F6 — a threshold that expired

`STALE_AFTER_MIN = 75` was "worst gap plus slack" when the worst gap was 60. The next
sample's worst was 81, so the banner fired on healthy boards -- and a banner that cries
wolf is worse than none.

**Fix:** 180 = three median gaps, and the number is tied to that sentence. **Rule:** a
constant derived from a measurement carries the measurement and its date, and is
re-derived when the sample changes.

### F7 — one secret, two capabilities

Reads and writes shared `BOARD_TOKEN`, which lives in a URL designed to be shared. Any
leak was a write credential.

**Fix:** `BOARD_WRITE_TOKEN` for `POST /api/ingest`; the board token reads only. The
fallback to the old token exists only so the deploy cannot break the cron, and it is
tested. **Rule:** authorisation is per capability; a read credential is not a write one.

### F8 — null is not a price

`if (row.allin <= MAX_ALL_IN)` accepts `null`, because `null <= 50` is true. A guard
that only rejects `-1` lets a missing fare through as free.

**Fix:** explicit `goWild` and numeric checks before comparison. **Rule:** when a
sentinel means "absent", the absent case must be named, not compared.

### F9 — the edit that broke the artifact

A heredoc plus `sed` backreferences wrote a literal `0x01` into YAML. The YAML looked
right in the diff and broke the action.

**Fix:** scripted edits assert their anchors and scan for control characters before
writing; YAML is parsed after editing. **Rule:** validate the file you produced, not the
intent you had.

### F10 — arithmetic stated as fact

An 8/14 coverage figure was reported as 6/14 from a guessed binomial. The direction of
the error flattered the system.

**Fix:** compute it, and print the denominator. **Rule:** no probability, rate or
percentage without its denominator and the code that produced it.

### F11 — the harness lied about the system

The end-to-end proof delivered zero pushes. The code was right: `node -e '...' T="$TOPIC"`
passes an argv, not an environment variable, so the payload carried no topic and the
Worker correctly refused to send. Reading the KV afterwards showed the dedupe marker
from an earlier run, which is what made "no push" look like a code defect.

**Fix:** pass values as real environment or arguments, and print the payload you actually
sent. **Rule:** when a test fails, suspect the instrument before the subject; a harness
without its own assertions is a second unverified system.

### F12 — tests written from intent

Three assertions in one session failed against correct code: a date with no rows was
expected to report an age, a write token was expected to satisfy the legacy fallback, and
a bootstrap payload was expected to be assembled by the shell. Each expectation came from
the plan in my head rather than from the contract in the file.

**Fix:** write the assertion after reading the branch it covers, and prefer a message
that states the contract ("a date with no rows has no provenance to age"). **Rule:** a
failing test is a claim about two things; establish which one is wrong before editing
either.

## The four patterns behind all twelve

1. **Trusted the badge, not the artifact.** A green job, a "success" response, a header
   saying "updated 12 min ago". Each was a claim about a process; none was a claim about
   the thing the user sees. Check the artifact.
2. **Trusted an aggregate where the claim was per item.** Snapshot age instead of row
   age; request count instead of routes asked; shard index instead of route set.
3. **Treated a measured constant as permanent.** 75 minutes, 14 requests, "one refusal
   means a block". Measurements expire; the expiry must be written next to the number.
4. **Verified the happy path and the total failure, never the partial one.** A sweep
   that returns 11/16, a token that authenticates but sees no accounts, a date with
   rows but no fares. The interesting states are the in-between ones.

## Role drills

Each role reads its own list before finishing a change.

### Collector (`collector/`, `src/routes.js`)

- Two refusals abort, never one. A retry is a second request; do not add one.
- A carried row keeps its real timestamp and is not recorded as an observation.
- Retirement is per route (3 strikes, 7 days), never per sweep.
- Rotation: prove the route *set* changes across two ticks.
- Nothing may run after the snapshot is written that can throw before it. Alerting is
  wrapped; the write is the deliverable.
- Before spending requests: `npm run lint` (a `no-undef` failure once burned 42 paid
  requests and discarded the snapshot).

### Renderer (`src/board.js`, `src/render.js`)

- Every date renders a reason: blocked, error, peak, no-flights, no-GoWild, folded,
  stale. Empty is forbidden.
- A number in the header must describe the object beside it: fares offered, not rows
  held; data age when nothing is offered; no age at all when there are no rows.
- Prices are "estimated all-in", never `$0.01`, `$NaN`, `$undefined`, `-1`.
- Assert on emitted JavaScript (`new Function`), not only on markup. No `
` inside the
  HTML template.

### Deploy and infrastructure (`.github/workflows/`, `wrangler.toml`)

- A run is successful when the version id changed and the live URL serves it.
- Preflight credentials before any expensive step, and fail loudly when absent.
- A secret used for writes is not a secret shared for reads.
- After rotating a credential, exercise the write path in the same session.
- Schedule death is invisible from inside: the Worker-side stale push and the board
  banner are the only witnesses. Keep them working.

### Reviewer (`REVIEW.md`, `AGENTS.md`, `FAILURES.md`)

- Review the failure paths first: partial sweeps, empty dates, stale snapshots, 401/503,
  a token that authenticates but is unauthorised.
- Enumerate hypotheses before changing code; one refused route was diagnosed as a quota
  and cost two days.
- When a doc states a rule, check it against the code in the same pass. AGENTS.md said
  "aborts on the first refusal" for a day after the code stopped doing that.
- Report what was not tested. "Compiled" is not "verified".

### Measurement and reporting (`REPORT.md`, `HANDOFF.md`, `MONITOR.md`)

- Every rate carries its denominator and its window.
- `null` is not `0`; a missing sample is not a zero.
- One-sided bounds and guessed probabilities are not measurements.
- Record the wrong turns. The next reader's time is the budget you are protecting.

### Documentation (`AGENTS.md`, `README.md`, `PLAN.md`)

- The invariant list is the contract; a rule that changed in code changes here in the
  same commit.
- Counts in the file map are asserted by tests or updated with them.
- Never put a secret, a token, a cookie value or a topic in a doc, a log or a commit.

## The sixty-second audit

```bash
npm run lint                  # no-undef: the defect class parsing cannot see
npm test                      # every suite, exit status preserved
npm run stress                # adversarial input and malformed state
node --check <every touched file>
git status --porcelain        # what actually changed
```

Then check, by hand, the three claims that matter: the page shows a reason for every
date, every price is labelled estimated all-in, and the snapshot on the server is newer
than the last successful sweep.
