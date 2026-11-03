# HANDOFF — everything built, measured, broken and fixed

Last updated: 2026-11-02 (local, America/New_York). Companion to `AGENTS.md`
(rules), `README.md` (usage), `REPORT.md` (evidence tables).

---

## 1. What the thing is

A single page listing every Frontier **GoWild** departure from **RDU** for today
and tomorrow with an all-in fare of **$50.00 or less**, plus a JSON endpoint.
Read-only, $0 recurring, no account, no payment path. Two entry points:

- `/s/<BOARD_TOKEN>` — the board
- `/api/board` — the same data as JSON

## 2. Architecture, and why

A Cloudflare Worker **cannot** scrape Frontier: DataDome fingerprints the client,
so even a valid 31-pair session cookie replayed from Node gets a 20,379-byte
challenge at `/Flight/Redirect`. A real browser does not. Hence:

```
GitHub Actions cron */15  →  Playwright Chromium  →  14 routes × 2 dates
            (sequential, 2–5 s)                          ↓
                                                KV key "state"
                                                       ↓
                                    Worker reads KV only: /s/<TOKEN>, /api/board
```

KV: one write per sweep (96/day) against a 1,000/day free limit. History is
append-only and digest-gated, so a quiet board adds zero rows.

## 3. Chronology

**Scout.** Route count resolved as **14** (FlightConnections 2026-11-02 + RDU's
nonstop table). The widely repeated "32 destinations" is an ABC11 article from
**2019-05-01**; BUF is announced but not operating.

**Phase 0 — the cookie question turned out to be the wrong question.** Measured
`fetch()` from Node with no cookie, with a valid cookie, and with a full Chrome
header profile: all blocked at `/Flight/Redirect`. Real Chromium, logged *out*:
`200`, 1.09 MB, full GoWild pricing. Conclusion: the gate is client
fingerprinting, not authentication, and no cookie fixes a non-browser client.

A cookie was still captured as instructed — 31 pairs, 3,912 chars — written by a
loopback receiver so the value never entered the transcript. It is gitignored and
**is not needed** (see §5).

**Payload traps found, each of which would have produced a wrong page:**

- `goWildFare` is a single scalar; **no tax or fee field exists anywhere**. Every
  price is therefore labelled "estimated all-in", never a verified total.
- `goWildFareSeatsRemaining` is `null` **or** the string `"3 Seats Left!"` — never
  a number.
- GoWild disabled is `goWildFare: -1`, not `0`.
- Blackouts are **not announced**: on 2026-11-24 Frontier simply priced every
  GoWild seat at **$317.96** with `dateMessage: null`.
- A non-operating day returns `journeys: [ … ]` with `flights: []` — a *successful
  empty* response, cleanly distinct from a block.
- `duration` can be `"1 day(s) 5 hrs 26 min"`.

**First live sweep** (interactive browser, 28 captures): 74 GoWild fares, 63
qualified. Real fares: nonstop `$15.41`, one-stop via ATL `$25.21`, SJU `$38.01`.
That data is what the board was first rendered from.

**Add-ons.** ntfy push alerts, bookability grid, release-timing model, pin +
calendar export, token-scoped PWA shell.

**Adversarial testing.** `test/stress.mjs`, 28 checks. Four of its first-run
failures were real defects, not test noise (see §4).

**Full collector sweep.** 28/28 requests, 15 routes parsed, 13 genuine
no-flights, 79 flights, 45 history transitions, 30,353-byte snapshot.

## 4. Defects found and fixed

| # | Defect | Consequence if shipped | Fix |
|---|---|---|---|
| 1 | Peak state used a `Math.min(...[9999])` fallback | board printed **`$9999.00`** | use `d.lowest` |
| 2 | `appendTransitions` called per date overwrote `lastRows` | other date's rows re-emitted as new history **every sweep** | one digest over the whole board |
| 3 | `state.sweeps = sweeps` assigned **before** the blocked guard | a blocked sweep **wiped the board** while the log claimed it was preserved | assign only in the success branch |
| 4 | `blocked` used `.some()` | one blocked route among 13 quiet ones marked a whole date blocked | `.every()` |
| 5 | Folded-by-duration counted as "above $50" | wrong count in the UI | split `priced` / `folded` |
| 6 | `seats: 0` rendered "seats unknown" | hid a sold-out fact | "sold out"; `normalizeSeats` keeps `0` |
| 7 | `buildBoard` threw on non-array `sweeps` | **500 on the live page** from a malformed KV blob | array guards + `src` fallback |
| 8 | Client script was never wired in | pin/calendar buttons rendered but **did nothing** | full client script added |
| 9 | `parseRoute` reported a 404 as `no-journeys-key` | a 404-shaped failure looked like "no data" | `not-found` reason + `classifyFailure` |
| 10 | Guard counted only `blocked` | the 28-request no-cookie run took the **success** path and wrote a digest over good data | `okCount === 0` is the failure test |
| 11 | Collector had no cookie support | banner told you to set a cookie nothing read | `collector/cookies.mjs`, value never logged |
| 12 | Expired session surfaced as generic error | brief's own banner never fired | all-404 sweep ⇒ `kind: 'auth'` ⇒ exact command |

## 5. The two corrected conclusions (important)

**The cookie is not required.** Suppressing cookies entirely
(`IGNORE_COOKIE=1`), warming up at `https://booking.flyfrontier.com/`, headless
Chromium returns `200`, **1,090,472 B**, `journeys` present, 4 flights — versus
1,090,467 B with the cookie. The original failure was the **warm-up URL**:
`/Flight/Select` redirects to `/Flight/Redirect`, and subsequent `InternalSelect`
calls then bounce to `www.flyfrontier.com`, which answers a 1,728-byte
**404 "Page not found"**. That 404 was misread as a DataDome block for an entire
sweep. Practical result: **there is no secret to rotate.** The cookie is applied
when present, purely for resilience.

**Headless Chromium is fine.** Headless and headed return identical payloads.
The earlier "highest risk to the design" is retired.

## 6. Heatmap: what was wrong and the fix

The first version was a 14-route × last-14-days grid. On day one it read
"last 2 days", and it will read that for a fortnight — a nearly empty panel that
looks broken. A *forward* 7-day grid would need 98 requests per sweep instead of
28, tripling load on Frontier for data GoWild cannot populate yet (seats open the
day before).

Fix: a **weekday rollup** is now the primary view — 14 routes × 7 weekdays, each
cell reading `opened / observed`. It is useful immediately ("CUN: 2/2 Mondays")
and sharpens with every sweep. The date grid remains underneath it. Denominators
are always days actually swept, so a route is never credited for a day nobody
looked at.

## 7. Release timing: what is knowable and what is not

**Nobody publishes Frontier's release schedule**, and past release times cannot be
scraped — the data does not exist publicly. So the model must be built forward:

- Every sweep records the first instant each `(date, dest, dep)` became visible.
- Stored in `state.firstSeen`, deliberately **outside** `history` so the 4,000-row
  cap cannot evict the oldest — and therefore most valuable — observations.
- Model output per route: median local hour + **median lead hours before
  departure**, with a hard `MIN_SAMPLES = 3` gate. Under three observations it
  says "not yet a pattern" instead of inventing a time.

Status: implemented and tested (including the DST boundary, where 06:30 EST must
resolve to 11:30 UTC). **Not yet conclusive** — it needs ~3 sweeps per route, which
at a 15-minute cadence is under a day of uptime once the scheduler runs.

## 8. Verification state

- `npm test` → **17/17**, exit 0
- `npm run stress` → **28/28**, exit 0 (840 flights / 30 dates → 650 KB page in
  63–300 ms; 4,000-row state = 567 KB against a 25 MB KV limit)
- `node --check` → all source files parse
- A full 28-request collector sweep completes with **0 blocked**
- The rendered board is the collector's own snapshot, not a fixture

## 9. Open items

1. **Not deployed.** No KV namespace, no Worker, no remote repo. Blocked on
   Cloudflare credentials and `gh` not being installed.
2. **PWA / ICS / pins never clicked in a browser.** Asserted on HTML only.
3. **No mid-sweep throttle has been observed**, but only a handful of sweeps have
   run; the risk is unproven rather than disproven.
4. **Seats are usually `null`**, so most rows read "seats unknown".
5. **Today's date decays to nothing by evening** (4 flights, 0 GoWild after 21:00
   on Nov 2, versus 56 GoWild for Nov 3).
6. **The URL token is the only access control** — a bearer secret, no rate limit.

## 10. First five minutes for a new agent

```bash
npm test; npm run stress          # establish a baseline (PowerShell: `;` not `&&`)
node tools/headless-probe.mjs       # 1 request, confirms Frontier still answers
node collector/collect.mjs          # 28 requests, writes state.json
node tools/render-state.mjs         # board.html from real data
```

Then read `AGENTS.md` invariants before touching `src/board.js` or `src/render.js`.

---

## Defect: the client script was dead and every test passed (2026-11-03)

Found by opening the rendered page in a browser, which no test had ever done.

**Symptom:** one console exception, `SyntaxError: Invalid or unexpected token`.
Nothing else. The page rendered perfectly, every row appeared, the timestamp was
correct, and all 35 HTML assertions passed. Pin, calendar export and the PWA
wiring were simply never defined.

**Cause:** the client script is emitted from a template literal in `render.js`,
which contained:

    return L.join('\r\n') + '\r\n';

Inside a template literal, `\r\n` is not text — it becomes a real CR/LF. So the
browser received a string literal broken across two lines:

    return L.join('
    ') + '
    ';

**Fix:** `return L.join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10);`
No escape, nothing to collapse. The ICS still gets proper CRLF.

**Why the tests missed it:** every test asserted on the *markup*, and the markup
was fine. Nothing verified that the delivered JavaScript parses. The new stress
check extracts `<script>…</script>` from a rendered page and runs `new Function()`
on it; a mutation test (reintroducing the escape) proves it fails on the old bug
and passes on the fix.

**Lesson that generalises:** when one file generates another language, assert the
generated language is valid. Rendering tests that only inspect the outer document
cannot see a dead inner script.

---

## Deployed, and the first request found a 500 (2026-11-03)

The Worker is live at `https://rdu-gowild-board.sdotmo1223.workers.dev`, version
`12c1eb7b`, KV namespace `fec311a9eda84b90a8490061cda5d4bf`, secret `BOARD_TOKEN`
set. It was seeded with the last good sweep (28/28 ok, 186 flights) so the page
has real rows before any cron runs.

**Two defects only a live request could show, both invisible to the test suite:**

1. **`/s/<TOKEN>` returned 500 on an empty namespace.** Every test built a board
   from a real snapshot, so nothing had ever rendered the state a brand-new KV
   namespace actually holds: nothing. `frequencyTable()` began
   `const observed = state.observed || {}` — a null dereference, not a guard, so
   the whole page threw. `/api/board` survived only because it returns before
   that call. Fixed by defending in `routeFrequency()`, plus a stress check that
   renders `buildBoard(null)` and asserts the "No data yet" banner appears. This
   is invariant 1 failing in the one way the suite could not see: an empty grid
   rendered as an error page.

2. **curl and Node could not verify the deploy at all.** Both failed the TLS
   handshake (`SEC_E_ILLEGAL_MESSAGE` / alert 40) while `example.com` failed the
   same way through the same curl — a host-level TLS path problem, not the
   Worker. .NET reaches it fine, so `tools/verify-live.ps1` uses
   `Invoke-WebRequest` and checks nine routes, the forbidden strings, and that
   the pin/ICS client code is actually in the served bytes. First run of any
   check tool should be against a known-good URL, or you will debug the wrong
   side of the wire.

**Verified live (9/9 checks, `tools/verify-live.ps1`):** `/` 404 · wrong token 404
· `/s/` 404 · right token 200 `text/html` · `/api/board` 200 JSON · token-scoped
`sw.js`, `manifest.webmanifest`, `icon.svg` 200 · `sw.js` at a wrong token 404.
Served page 79,291 B, 74 rows, lowest fare $15.41, zero occurrences of `$NaN`,
`$undefined`, `$0.01`, `>undefined<`, `>-1<`.

**Still open:** the 15-minute collector cron. `.github/workflows/board-collect`
stays `disabled_manually` until `CF_API_TOKEN` (Workers KV Storage:Edit, Account
Settings:Read) exists as a repo secret — the other two are already set.

---

## First CI run: the sweep worked, the credential did not (2026-11-03)

`CF_API_TOKEN` was added and `board-collect` went active, so I dispatched one run
by hand: [41640525601](https://github.com/sdotmo1223/rdu-gowild-board/actions/runs/41640525601).

**What worked in CI:** checkout, node, the missing-secret guard, `playwright
install chromium`, and 17 of 19 flyfrontier requests — ATL 10 flights, PHL 10, SJU
10, CLE 6, DEN 5, DFW 4, IAH 5, MCO 5, FLL 1, MIA 1, TPA 2. BOS and CUN came back
`no-flights` twice, which is the honest empty state, not a block. **A GitHub
runner can therefore reach Frontier**, which was the biggest unknown.

**What failed:** `KV GET 401` at write time. The token is sent as a plain
`Authorization: Bearer`, so a 401 means the *value* was rejected — a 403 would
have meant missing permission. Wrangler's OAuth writes to the same namespace
fine, so the account id and namespace id are correct; only the token is wrong.
Cost: the sweep was scraped and then thrown away.

**Second finding — the throttle moved again.** On a fresh runner IP with no prior
probing, the burst was refused at request **19 of 28** (`2026-11-04 DEN:
no-journeys-key`), where the same machine had done 28/28 clean earlier the same
day. So the refusal is not a per-IP budget either; it is Frontier's own
transient mood. `shouldAbortSweep` ended the sweep correctly, and the remaining
9 requests were never spent.

**Actions taken:**

1. Disabled the workflow again, because a 15-minute cron that spends ~20 requests
   and writes nothing is exactly the impoliteness the rules forbid. Re-enable
   only once a token is verified working.
2. `collector/collect.mjs` now names the fix on 401/403 instead of printing
   `KV GET 401`, because that message cost a full sweep to decode.
3. `tools/verify-cf-token.ps1` checks token shape, `/user/tokens/verify`, and a
   real KV read, printing neither the token nor any part of it.

---

## The token was valid; my checker mangled it (2026-11-03)

A real token was pasted at the prompt and the checker reported
`6003 Invalid request headers`. The token was fine. **The checker corrupted it.**

Cloudflare now issues tokens in two formats, and the current UI hands out the
first:

| Format | Example shape | Where |
|---|---|---|
| `cfut_` + 48 chars = **53** | user-scoped API token | My Profile → API Tokens (current) |
| `cfat_` + chars | account-owned API token | Account API Tokens |
| legacy bare **40** alnum | old tokens still in the wild | older tokens |

The checker was written against the 40-char legacy shape and "helpfully" pulled a
40-char window out of any longer paste. Cutting four characters off a 53-char
token produces a syntactically plausible but wrong credential, and Cloudflare's
reply to that is `6003 invalid request headers` — which reads exactly like a
permissions problem. Nothing about the error pointed at the truncation.

**Fix:** match the prefixed forms first and take them verbatim; accept a legacy
40-char value only when the whole input is exactly 40; extract from surrounding
text only by the prefix, never by width. Verified with a synthetic 53-char token
(now `401 invalid api token`, the honest answer for a fake), an embedded
53-char token, a legacy 40-char value, and plain permissions text (sends nothing).

**Also:** that token was pasted into a chat transcript, so it is burned and must
be deleted at the dashboard regardless. Two credentials have now leaked this way.
The rule already in `AGENTS.md` — never paste a token into chat — keeps earning
its place.

**Lesson:** a validator that rewrites its input can turn a good secret into a bad
one while blaming the user. Parse secrets verbatim; the only safe transformation
is whitespace trimming.

---

## The whole chain works (2026-11-03 13:37Z)

Run [41645625102](https://github.com/sdotmo1223/rdu-gowild-board/actions/runs/41645625102)
finished `success` in 150 s and the board changed under it. This is the first time
every link has worked at once:

    GitHub runner -> Frontier (28/28 ok) -> collector -> KV -> Worker -> HTML

Measured immediately after, three independent ways:

| Source | Evidence |
|---|---|
| KV (`wrangler kv key get state`) | `generatedAt 2026-11-03T13:37:45Z`, 28 sweeps, 28 ok, 0 blocked, 175 flights, `lastError: none` |
| Live page (`finish-pipeline.ps1 -DryRun`) | `updated 5 min ago`, 65 rows, 72,289 B |
| Nine route checks (`verify-live.ps1`) | 9/9 pass, `RESULT: 0 failed check(s)` |

No Frontier refusal in this burst: 28/28, unlike the 19-request stop an hour
earlier — further evidence the refusal is transient rather than a budget.

Row and flight counts moved between sweeps (186 flights / 74 rows at 09:15Z vs
175 / 65 at 13:37Z). That is GoWild availability changing, not a defect; the page
labels every price "estimated all-in" and shows its own age.

**The token detour, in one line:** the credential was never the problem. A
validator written for Cloudflare's legacy 40-char tokens sliced four characters
off a 53-char `cfut_` token, and Cloudflare's `6003 invalid request headers`
read as a permissions error. Two credentials were exposed in chat before that
was understood; both were deleted at the dashboard.

**Tooling left behind:** `tools/verify-cf-token.ps1` (verifies without printing,
uploads only on PASS) and `tools/finish-pipeline.ps1` (enables, dispatches one
run, waits, and compares the visitor-visible age before/after). `-DryRun` on the
second is the cheapest health check: it reads the page and the workflow and
changes nothing.

---

## 12:57–14:40 EST, 2026-11-03 — the write path was the outage

The cron was re-enabled and the first two runs are the whole story.

**Run 41640525601 failed with `collector failed: KV GET 401`** — after 19 of 28
fare requests had already been spent. 401 (not 403) means Cloudflare rejected the
credential outright, so the namespace and account were fine; the token was not.
Two fixes, both in this commit:

1. **The write path is now proved before Frontier is touched.** `collect.mjs`
   resolves the transport and does one cheap call first (an ingest dry run, or the
   KV read it needs anyway) and exits with a plain-English message if that fails.
   The workflow does the same check as its own step, so a bad credential costs one
   request instead of nineteen. `KV GET`/`KV PUT` 401 and 403 now say what to fix.
2. **CI no longer needs a Cloudflare API token at all.** `POST /api/ingest` on the
   Worker accepts the snapshot with `Authorization: Bearer <BOARD_TOKEN>` — the
   token that already gates the page — and performs the KV write. `GET` returns the
   raw state; `?dryRun=1` proves the path and writes nothing. The endpoint re-checks
   the "never overwrite a good board with a failed sweep" invariant at the boundary
   (409 if no sweep is `ok`), so a collector bug cannot erase the board.

**The first refusal was also observed live, for the first time.** Run 41640525601
stopped at `2026-11-04 DEN: no-journeys-key` after 19 of 28 requests. The abort
worked, but `mergeSweeps` only protected a date with *zero* usable routes — so the
5 routes it had asked about on 11-04 would have replaced all 14, silently deleting
8 routes (DTW FLL IAH MCO MIA PHL SJU TPA) with no marker. `mergeSweeps` now takes
`expectedRoutes` and carries the previous result for every route never asked,
flagged `carried`, and the banner says how many rows came from the older sweep.

**The $0 invariant had a timer on it.** A run is 2m05s of wall clock, billed as 3
minutes. `*/15` = 96 runs/day ≈ 288 billed minutes/day against GitHub Free's 2,000
minutes/month for a private repo: the allowance is gone in about a week and Actions
then simply stops, which is a silent outage of the only thing this project does. The
cron is now `0 */2 * * *` (12 runs/day ≈ 1,080 min/month). The way back to 15-minute
freshness at $0 is a public repository, not a bigger allowance. `STALE_AFTER_MIN`
moved 45 → 150 to match, so amber still means "a sweep was missed" instead of being
permanently on.

Run 41655488371 then completed: 28/28 ok, 151 flights, 0 blocked, `KV write complete.`,
board `ageMinutes=0`, `stale=false`.
