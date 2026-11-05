# AGENTS.md — read this first

You are working on **RDU GoWild Board**: a zero-cost page showing every Frontier
GoWild departure from RDU for today and tomorrow, filtered to an all-in price of
$50.00 or less. One user, personal tool. It is graded on three things only: **it
works, it costs $0, and silent failure is impossible.**

`README.md` = how to run and deploy. `REPORT.md` = measured evidence. `HANDOFF.md`
= chronological build log, including every wrong turn. This file = the rules.

---

## Hard invariants — do not break these

1. **An empty grid is a forbidden state.** Every date that has no rows must render
   an explicit reason (blocked / error / peak / no-flights / no-GoWild / folded).
   Always render something a human can act on.
2. **Never overwrite a good snapshot with a failed sweep.** The board is written
   only when at least one route returns a parseable payload
   (`classifyFailure(sweeps) === null`). Otherwise keep the previous snapshot and
   set `lastError`.
3. **Never present a price as verified.** Frontier returns a single `goWildFare`
   scalar with **no tax or fee field anywhere**. Every price is labelled
   **"estimated all-in"**. Never show `$0.01`, `$NaN`, `$undefined`, or a `-1`
   sentinel.
4. **Politeness is not negotiable.** Strictly sequential, 2–5 s randomized delay,
   15-minute cadence, exactly one process touching Frontier. Do not parallelize
   route fetches, do not add retries that multiply requests, do not "warm up"
   extra routes. Half the routes per tick (7 of 14, alternating on the clock) is
   the burst budget: two refusals in a row abort the sweep, so a burst that is too
   large can return less than 14. (15 minutes is only affordable because the repo is public:
   GitHub Free meters 2,000 Actions minutes/month on private repos, which a
   15-minute Playwright cron exhausts in about a week. Keep it public.)
5. **Read-only.** Never request checkout, payment, or booking paths.
6. **The session cookie is optional and secret.** It is never logged, printed,
   committed, or pasted into chat. Only the pair count may be reported. It lives
   in `FRONTIER_COOKIE` or the gitignored `.dev.vars`.
7. **Blackout dates are not announced by Frontier.** They come from the calendar
   in `src/routes.js` (`BLACKOUT_DATES`), with an inflated GoWild fare
   (observed **$317.96**) as a secondary signal. Render `Peak Day Charge $79+`,
   never blank and never "no flights".
8. **All date math is `America/New_York`.** A UTC clock flips the wrong day for
   four hours every night. Use `easternDate()`, never `new Date().getDate()`.

---

## Measured facts that dictate the architecture

These were measured on 2026-11-02 and cost real debugging time to establish.

| Fact | Evidence |
|---|---|
| A Cloudflare Worker **cannot** fetch Frontier directly | Node `fetch` → `302 /Flight/Redirect`, 20,379 B challenge, even with a valid 31-pair cookie and Chrome headers. DataDome fingerprints the client. |
| A real (even **headless**) Chromium **can** | `200`, ~1,090,47x B, `journeys` present |
| The session cookie is **not required** | identical payload with `IGNORE_COOKIE=1` |
| The warm-up URL **is** critical | warm up at `https://booking.flyfrontier.com/` (root). `/Flight/Select` lands on `/Flight/Redirect` and subsequent `InternalSelect` calls bounce to `www`, which 404s in 1,728 B |
| `journeys: [{flights: []}]` is a genuine "no flights" day | distinct from a block; this is what makes an honest empty state possible |
| GoWild disabled is `goWildFare: -1` | filter on `> 0` |
| `goWildFareSeatsRemaining` is `null` or `"3 Seats Left!"` — never a number | `normalizeSeats()`; `0` must survive as "sold out" |
| `duration` can be `"1 day(s) 5 hrs 26 min"` | parse with `durationMinutes()` |
| GoWild is **$0.01 fare per segment + taxes/fees**, not a dynamic discount | Frontier T&C §14 and every 2026 release say "only $0.01 in airfare per flight segment (plus taxes, fees and charges)"; Frontier puts domestic taxes at "approximately $15.40". Our cheapest observed all-in is **$15.41**. A ratio against `standardFare` is a by-product, never a rate Frontier applies. |
| GoWild availability is **capacity controlled per flight** | Frontier: "not all Frontier flights will be available", "seats are capacity controlled, limited in quantity... first-come, first-served", "last seat availability is not guaranteed". No seat count per flight is published. |
| Time-of-day GoWild availability is **undocumented** | No Frontier statement and no credible third-party analysis. Our hour table is the only evidence we will have, so it stays labelled with its denominators. |
| Route count is **14** | FlightConnections 2026-11-02 + RDU's own table. The "32 destinations" figure is ABC11 **2019-05-01**. BUF is announced, not operating. |

---

## File map

| Path | Responsibility |
|---|---|
| `src/routes.js` | 14 routes, `BLACKOUT_DATES`, `PEAK_LABEL`, `MAX_ALL_IN`, `MAX_STOPS`, `MAX_DURATION_MIN`, `easternDate()`, `frontierDateParam()`; the sweep budget: `routeShard()`, `shardRoutes()`, `easternHour()`, `departuresFinished()` |
| `src/board.js` | `buildBoard()` — per-date status machine, nonstop-first sort, fold-vs-show, defensive against malformed state |
| `src/render.js` | `renderPage()` — the entire HTML, all banners, heatmap, timing, pin/ICS/PWA client script |
| `src/history.js` | digest, transitions, `recordObservation()`, `recordFirstSeen()` |
| `src/frequency.js` | weekday open-frequency with honest denominators |
| `src/heatmap.mjs` | bookability by weekday (primary) and by date (secondary) |
| `src/timing.mjs` | release-timing model: median local hour + median lead hours, `MIN_SAMPLES = 3` |
| `src/pricing.mjs` | fare mechanics: records **every** itinerary (pre-flip standard fare included) into `state.fares`, measures when a fare flips, whether it follows the flight or the load, and the GoWild/std ratio |
| `src/schedule.mjs` | per-date operating matrix + week-over-week stable-vs-rotating verdict |
| `src/alerts.mjs` | ntfy.sh push, deduped per error state to once / 6 h |
| `.github/workflows/sweep.yml` | the only collector cron: every origin, sequential, per-profile request budget |
| `src/index.js` | Worker router: `/s/<TOKEN>`, `/api/board` (token-gated), `/api/ingest` (token-gated snapshot write), PWA assets |
| `collector/collect.mjs` | Playwright sweep → KV (or `state.json` with no credentials) |
| `collector/parse.mjs` | `extractJourneys`, `normalizeFlight`, `parseRoute`, `classifyFailure` |
| `collector/cookies.mjs` | optional cookie loading, never logs the value |
| `tools/headless-probe.mjs` | one-request diagnostic; `HEADLESS=0` / `IGNORE_COOKIE=1` |
| `tools/route-probe.mjs` | one-request "does Frontier sell this city pair?" probe: real Chromium + the collector parser |
| `tools/render-state.mjs` | render `board.html` from a real collector snapshot |
| `tools/seed-schedule.mjs` | rebuild `state.json` (incl. schedule) from `.sweep/` captures |
| `FAILURES.md` | every failure, why the first look missed it, the four patterns behind them, and a drill list per role. Read your role before touching its code |
| `PLAN.md` | the current ordered plan and its acceptance criteria |
| `REVIEW.md` | totality review: scorecard, clash catalogue, bottlenecks, ordered fixes, exam standard |
| `COLLECTION.md` | collection reliability contract (G1-G5), ordered phases, fixture matrix, next-level brief |
| `tools/render-local.mjs` | render from interactive `.sweep/` captures |
| `test/acceptance.mjs` | 25 spec-level checks |
| `test/profiles.mjs` | 9 multi-origin checks: profile resolution, unserved-vs-refused classification, per-origin rendering |
| `test/rotation.mjs` | 53 checks: tick-driven shard alternation, two-tick and budgeted coverage |
| `test/carry.mjs` | 7 checks: a carried row keeps its real fetch time, never re-stamps |
| `test/resilience.mjs` | 34 checks: one refusal must not end a sweep, three strikes retire a route, and a fare older than 3 h is withheld |
| `test/health.mjs` | 34 checks: heartbeat, Worker-side stale alert, the collector-to-Worker topic bootstrap, and the read/write token split — including which credential each collector call site presents |
| `test/stress.mjs` | 48 adversarial checks (hostile input, malformed state, volume, budget, fare retention) |

---

## Commands

```bash
npm run lint                 # no-undef: the defect class `node --check` cannot see
npm test                     # acceptance 25 + multi-origin 9; both must pass
npm run stress               # adversarial: 62 checks
node test/profiles.mjs       # multi-origin: 9 checks
node --check <file>          # syntax gate, used on every file

node tools/headless-probe.mjs              # 1 request, proves the pipeline
IGNORE_COOKIE=1 node tools/headless-probe.mjs
HEADLESS=0 node tools/headless-probe.mjs   # headed, parked offscreen

node collector/collect.mjs   # 14 requests (7 routes x 2 dates), ~1 min, writes state.json without CF envs
node tools/render-state.mjs  # renders board.html from state.json
```

Deploy (needs Cloudflare credentials this repo does not hold):

```bash
npx wrangler kv namespace create BOARD   # paste id into wrangler.toml
npx wrangler secret put BOARD_TOKEN
npx wrangler deploy
```

---

## Environment

| Variable | Meaning |
|---|---|
| `FRONTIER_COOKIE` | optional; falls back to `.dev.vars` |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID` | write to KV; absent ⇒ writes `state.json` |
| `HEADLESS=0` | run headed, offscreen (for a local scheduler) |
| `NTFY_TOPIC` | optional phone push, no account needed. The collector sends it with each snapshot, so the Worker can push without a second secret; a Worker secret of the same name overrides it |
| `WATCH` | optional standing question, e.g. `ATL<=25,MCO<=30`; alerts once per 6 h per matching departure set |
| `WARMUP_URL` | defaults to `https://booking.flyfrontier.com/` — do not change blindly |
| `STATE_OUT`, `STATE_IN` | snapshot paths |
| `SWEEP_DAYS` | dates per sweep, default 2. Do not raise it in the normal cadence: 7 routes × N dates is the burst, and one refusal aborts the sweep. |
| `FULL_SWEEP=1` | ask every route in the profile instead of the rotating half (deliberate backfill or probe). The per-profile budget no longer halves it; the burst is capped at `FORCED_BUDGET_CEILING` (30). |
| `SWEEP_ONLY=ATL,MCO` | ask exactly these routes, ignoring shard and budget. This is the one-round-trip diagnostic: 2 routes × 2 dates = 4 requests in ~20 s, no CI queue. |
| `SWEEP_MAX_REQUESTS` | per-profile request budget for a normal tick (14 rdu / 10 lga / 16 phl). Requests, not routes: `budget / SWEEP_DAYS` routes per date, taken from a clock-driven offset so the tail of a shard is not starved. |
| `SWEEP_ALL_DATES=1` | keep asking about today after its last departure instead of carrying it. |

## The throttle (updated 2026-11-03)

The evidence moved, so read this carefully rather than trusting the first story.

- **2026-11-03:** a 28-request two-date burst completed **cleanly** — 28/28 ok,
  186 flights, 0 blocked. A 14-request burst did the same minutes earlier.
- **2026-11-02:** the *same* 28-request sweep returned 14 `no-flights` then 14
  straight `no-journeys-key`, which looked like a hard per-burst budget.

Correct reading: the refusal is **transient**, not a fixed quota. It followed a
day of repeated heavy probing (many sweeps plus single-route probes). Do not
encode a 14-request budget as fact.

Rules that hold under either reading:

- Sequential only, 2–5 s jitter, exactly one process touching Frontier.
- Never add retries. A retry is a second request.
- The collector **aborts on two refusals in a row** (`refusalEndsSweep`) and keeps the
  previous rows for any date that returned nothing usable (`mergeSweeps`). It is a
  safety net, not a licence to raise `SWEEP_DAYS`.

- **The burst is capped, not the cadence.** 7 routes per tick
  (`routeShard`/`shardRoutes`), so a two-date sweep is **14 requests** and every
  route is still re-checked every 30 minutes. `FULL_SWEEP=1` asks all 14. Once the
  last observed departure for today has gone (`departuresFinished`, or the last
  `dep` in the snapshot), the collector stops asking about today and spends that
  slot on the day after tomorrow, so the two-date window stays a full 48 hours
  ahead at the same 14 requests. Today's rows are carried, the page states their
  age (`7/14 routes re-checked · 7 carried from 22:45 ET`), and a date whose
  departures have all flown leaves the list and is reported once instead. A
  carried row is never recorded as a fresh observation or a fresh schedule sample.

---

## Host gotchas (cost hours if forgotten)

- `str_replace` needs **backslash** paths on this Windows host (`src\board.js`).
  Forward slashes fail with "The file does not exist".
- The host clock reads a day behind UTC; always reason in `America/New_York`.
- `process_read` / `process_stop` need a UUID id; use `netstat -ano` +
  `taskkill //PID` for stray servers.
- Never kill by process-name pattern — the agent's own command line can match.
- **Never write `\n` or `\r\n` as an escape inside the HTML template in
  `src/render.js`.** Template literals collapse it into a real newline, which
  breaks the emitted client script while the page still renders perfectly — pin,
  calendar export and the PWA all die silently. Use `String.fromCharCode(13, 10)`.
  `test/stress.mjs` now runs `new Function()` on the emitted script to catch this.
- **`node --check` does not resolve identifiers.** On 2026-11-04 10:18 ET a
  scheduled sweep died with `boardRows is not defined` *after* spending all 42
  Frontier requests and *before* writing the snapshot: the binding was declared
  inside `if (!everythingFailed)` but read from the alert block outside it. Every
  gate was green, because the file parsed and no test executes `collector/main()`.
  `npm run lint` (`no-undef`) is now the gate for this, and `sweep.yml` runs it
  before installing Chromium so a broken collector never spends a request.
- **Side effects must never be able to cost the snapshot.** The alert block used
  to run outside any `try`, so one throw in notification code discarded a paid-for
  sweep. Alerting is wrapped; the write is what matters.
- Assert on generated code, not only on markup. A page that renders correctly can
  ship JavaScript that does not parse.

---

## Definition of done

`npm run lint`, `npm test` and `npm run stress` all exit 0, `node --check` passes
on every touched file, and any change to the render path is checked against the invariants
above (no empty grid, no unverified price, no silent overwrite).
