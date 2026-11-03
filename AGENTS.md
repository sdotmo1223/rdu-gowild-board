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
   extra routes. (15 minutes is only affordable because the repo is public:
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
| Route count is **14** | FlightConnections 2026-11-02 + RDU's own table. The "32 destinations" figure is ABC11 **2019-05-01**. BUF is announced, not operating. |

---

## File map

| Path | Responsibility |
|---|---|
| `src/routes.js` | 14 routes, `BLACKOUT_DATES`, `PEAK_LABEL`, `MAX_ALL_IN`, `MAX_STOPS`, `MAX_DURATION_MIN`, `easternDate()`, `frontierDateParam()` |
| `src/board.js` | `buildBoard()` — per-date status machine, nonstop-first sort, fold-vs-show, defensive against malformed state |
| `src/render.js` | `renderPage()` — the entire HTML, all banners, heatmap, timing, pin/ICS/PWA client script |
| `src/history.js` | digest, transitions, `recordObservation()`, `recordFirstSeen()` |
| `src/frequency.js` | weekday open-frequency with honest denominators |
| `src/heatmap.mjs` | bookability by weekday (primary) and by date (secondary) |
| `src/timing.mjs` | release-timing model: median local hour + median lead hours, `MIN_SAMPLES = 3` |
| `src/pricing.mjs` | fare mechanics: records **every** itinerary (pre-flip standard fare included) into `state.fares`, measures when a fare flips, whether it follows the flight or the load, and the GoWild/std ratio |
| `src/schedule.mjs` | per-date operating matrix + week-over-week stable-vs-rotating verdict |
| `src/alerts.mjs` | ntfy.sh push, deduped per error state to once / 6 h |
| `src/index.js` | Worker router: `/s/<TOKEN>`, `/api/board`, `/api/ingest` (token-gated snapshot write), PWA assets |
| `collector/collect.mjs` | Playwright sweep → KV (or `state.json` with no credentials) |
| `collector/parse.mjs` | `extractJourneys`, `normalizeFlight`, `parseRoute`, `classifyFailure` |
| `collector/cookies.mjs` | optional cookie loading, never logs the value |
| `tools/headless-probe.mjs` | one-request diagnostic; `HEADLESS=0` / `IGNORE_COOKIE=1` |
| `tools/render-state.mjs` | render `board.html` from a real collector snapshot |
| `tools/seed-schedule.mjs` | rebuild `state.json` (incl. schedule) from `.sweep/` captures |
| `PLAN.md` | the current ordered plan and its acceptance criteria |
| `tools/render-local.mjs` | render from interactive `.sweep/` captures |
| `test/acceptance.mjs` | 23 spec-level checks |
| `test/stress.mjs` | 44 adversarial checks (hostile input, malformed state, volume, budget, fare retention) |

---

## Commands

```bash
npm test                     # acceptance: 23 checks
npm run stress               # adversarial: 44 checks
node --check <file>          # syntax gate, used on every file

node tools/headless-probe.mjs              # 1 request, proves the pipeline
IGNORE_COOKIE=1 node tools/headless-probe.mjs
HEADLESS=0 node tools/headless-probe.mjs   # headed, parked offscreen

node collector/collect.mjs   # 28 requests, ~2 min, writes state.json without CF envs
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
| `NTFY_TOPIC` | optional phone push, no account needed |
| `WARMUP_URL` | defaults to `https://booking.flyfrontier.com/` — do not change blindly |
| `STATE_OUT`, `STATE_IN` | snapshot paths |
| `SWEEP_DAYS` | dates per sweep, default 2. Do not raise it in the normal cadence: 14 routes × N dates is a burst, and the measured soft throttle starts around the 15th request. |

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
- The collector **aborts on the first refusal** (`shouldAbortSweep`) and keeps the
  previous rows for any date that returned nothing usable (`mergeSweeps`). It is a
  safety net, not a licence to raise `SWEEP_DAYS`.

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
- Assert on generated code, not only on markup. A page that renders correctly can
  ship JavaScript that does not parse.

---

## Definition of done

`npm test` and `npm run stress` both exit 0, `node --check` passes on every
touched file, and any change to the render path is checked against the invariants
above (no empty grid, no unverified price, no silent overwrite).
