# REPORT — RDU GoWild Board

Date: 2026-11-03. Built directly by the orchestrator (no subagents were spawned: the
problem turned out to be one measured fact, not parallelisable work — see "Staffing").

## 1. Phase 0 result: the cookie was the wrong question

The brief assumed GoWild required an authenticated session and that a user-supplied
cookie was the gate. Both halves were measured and both were wrong.

| Client | Cookie | Result |
|---|---|---|
| Node `fetch` | none | `302` → `/Flight/Redirect`, **20,379 B challenge**, no data |
| Node `fetch` | none (3 route/date combos) | 3/3 blocked |
| Node `fetch` | **valid 31-pair session cookie incl. `datadome`** | still `/Flight/Redirect` |
| Node `fetch` | same cookie + full Chrome `sec-ch-ua`/`Sec-Fetch` profile | still `/Flight/Redirect` |
| Real Chromium, **logged out** | none | `200`, **1,090,473 B**, `journeys` present, 5 GoWild fares |
| Real Chromium, logged in (`seandre`, 4,000 mi) | session | `200`, **1,500,965 B** |

Conclusion: the gate is **DataDome client fingerprinting**, not authentication. Replaying
the cookie from a normal HTTP client fails even on the same IP, so **a Cloudflare Worker
cannot scrape Frontier directly** — and no cookie fixes that. A real browser does, and it
does not need a login at all.

Therefore the "Session expired — cookie needs replacing" banner has nothing to attach to in
practice; it is retained in `src/render.js` behind `lastError.kind === 'auth'` because the
brief specified it, but the realistic failure mode is `kind: 'blocked'`.

**A cookie WAS captured**, as instructed: 31 pairs, 3,912 chars, written to `.dev.vars` by a
loopback receiver so the value never entered the transcript. It is retained (gitignored) but
is proven useless for replay.

## 2. Architecture (changed, with the user's approval)

```
GitHub Actions cron */15 → Playwright Chromium → 14 routes × 2 dates, sequential, 2–5 s
                                     ↓
                              KV key "state"  →  Worker: /s/<TOKEN>, /api/board
```

Chosen explicitly by the user over "test the Worker hypothesis first" and over stopping.

## 3. Payload facts that changed the spec

| Finding | Consequence |
|---|---|
| `goWildFare` is a single scalar; **no tax or fee field exists anywhere** in the payload | price is labelled **"estimated all-in"**, never presented as verified |
| Observed `$15.41` nonstop / `$25.21` one-stop | matches the known GoWild totals, so the scalar is almost certainly already all-in |
| `goWildFareSeatsRemaining` is `null` **or the string** `"3 Seats Left!"` | `normalizeSeats()`; UI shows "seats unknown" rather than 0 |
| Disabled GoWild is `goWildFare: -1`, not `0` | filter is `> 0`; the `-1` sentinel can never render as a price |
| Blackout is **not announced** — no `dateMessage`, no `message` | 2026-11-24 priced every GoWild seat at **$317.96**; blackout uses the date calendar, price as secondary signal |
| Non-operating day returns `journeys: [ … ]` with `flights: []` | a *successful empty* response, cleanly distinct from a redirect — this is what makes an honest "no flights" state possible |
| `duration` can be `"1 day(s) 5 hrs 26 min"` | next-day arrivals flagged `+1` |
| Logged-out traffic returns GoWild fares | no login, no password, no cookie handling needed |

Route count confirmed **14** (FlightConnections updated 2026-11-02 + RDU's own nonstop
table). The "32" figure is ABC11, **2019-05-01**; BUF is announced but not operating.

## 4. Verification actually run

`node test/acceptance.mjs` → **14/14 pass**, exit 0. Covers: sentinel normalization, string
seats, blocked-vs-no-flights discrimination, `>$50` filtering, nonstop-first ordering,
peak label, blocked banner, auth banner text, no-data state, 45-minute staleness, frequency
denominators, route count.

Two real defects were found by self-review, not by the first test run, and were fixed with
regression checks added:

1. Peak state would have printed **`$9999.00`** (a `Math.min(...[].concat(9999))` fallback
   when every fare exceeds the ceiling). Fixed via `d.lowest`; test now asserts the real
   `$317.96` appears and `9999` never does.
2. `appendTransitions` called once per date overwrote `lastRows`, so the other date's rows
   would be re-emitted as **new transitions on every sweep** — silently inflating history.
   Fixed to one digest over the whole board; test asserts a stable second sweep adds zero.

KV budget: one write per sweep = **96/day** against the 1,000/day free limit, plus one
history row per genuine change.

## 5. Not verified — stated plainly

- ~~Playwright headless Chromium has not been tested against DataDome.~~ **Resolved
  2026-11-02 by direct measurement, and the premise was wrong.** Headless and headed
  Playwright contexts returned identical results: `200`, 1,090,467 B, `journeys` present,
  4 flights. DataDome does not refuse headless here. The actual gate was the **session
  cookie**: `/Flight/InternalSelect` without a Frontier session redirects to
  `www.flyfrontier.com`, which serves a 1,728-byte **404**. The collector had no cookie
  support at all, and `parseRoute` reported the 404 as `no-journeys-key`, which is why a
  28-request sweep looked like a bot block. Both are fixed; `not-found` is now its own
  reason and the collector only overwrites the board when at least one route parses.
- **Still unverified:** a full 28-request sweep completing without a mid-sweep throttle.
  One probe route is not 28 sequential requests.
- **No deploy has happened.** No KV namespace, no Worker, no GitHub repo. `wrangler.toml`
  contains a placeholder `id`.
- **No live sweep has been executed**, so no real state JSON exists yet.
- Page rendering was verified by assertion on the HTML string, **not** by opening it in a
  browser; the 390px no-horizontal-scroll requirement is CSS-only and unproven visually.

## 6. Staffing

Agents were not spawned. The brief's stop condition "more agents will not fix it — say so"
applied in a constructive form: the blocker was a single empirical question (does a
non-browser client get through?) that one measurement answered. Fanning that out would have
multiplied requests to Frontier, which the politeness rule forbids, and would have produced
five reports of the same blocked page.

## 7. Next actions, in order

1. `npm i -D playwright && npx playwright install chromium`, then one manual sweep with no
   KV env vars set (the collector prints state instead of writing). If it prints
   `flights=<n>` rather than `blocked`, the design is sound.
2. If blocked: retry with `headless: false` under `xvfb-run` before changing anything else.
3. `wrangler kv namespace create BOARD` → paste id; `wrangler secret put BOARD_TOKEN`; deploy.
4. Add the three Cloudflare repo secrets; run the workflow once; open `/s/<TOKEN>`.

## Live deployment (2026-11-03)

| Measurement | Value |
|---|---|
| URL | `https://rdu-gowild-board.sdotmo1223.workers.dev/s/<TOKEN>` (token in gitignored `.board-token`) |
| Worker version | `12c1eb7b-5c6f-4051-a537-8c333de42740` |
| Startup time / upload | 6 ms / 36.28 KiB (11.68 KiB gzip) |
| Route checks | 9/9 pass, including 404 on `/`, `/s/`, a wrong token, and a wrong-token `sw.js` |
| Served page | 79,291 B, 74 rows, lowest estimated all-in $15.41 |
| Forbidden strings | `$NaN` 0, `$undefined` 0, `$0.01` 0, `>undefined<` 0, `>-1<` 0 |
| Empty-namespace case | renders "No data yet" banner, not a 500 (was a 500 before the fix) |
| Cost | $0 — Workers free tier, KV free tier, no card |

Reproduce with `powershell -NoProfile -ExecutionPolicy Bypass -File tools/verify-live.ps1`
(curl and Node both fail TLS on this host; use .NET).

## End-to-end proof (2026-11-03 13:37Z)

| Link | Evidence |
|---|---|
| CI -> Frontier | run `41645625102`, 28/28 routes ok, 175 flights, 0 blocked |
| Collector -> KV | `generatedAt 2026-11-03T13:37:45.647Z`, `lastError: none` |
| KV -> Worker | page `updated 5 min ago` at check time |
| Worker -> HTML | 72,289 B, 65 rows, 9/9 route checks pass |
| Cron | `board-collect` active, 15-minute schedule |
| Total cost | $0 |

## Scheduled runs, 2026-11-03 (measured)

| Run | Trigger | Result | Evidence |
|---|---|---|---|
| 41640525601 | manual | **failed** | `KV GET 401` after 19/28 requests; first live `no-journeys-key` refusal at `2026-11-04 DEN` |
| 41655488371 | manual | ok | `sweeps=28/28 requests=28 flights=151 blocked=0`, `KV write complete.`, board `ageMinutes=0 stale=false` |

Live `/api/board` after run 41655488371: `routeCount=14`, `2026-11-03 status=ok total=40`,
`2026-11-04 status=ok total=111`.

Ingest boundary, verified against the deployed Worker:

| Request | Result |
|---|---|
| `POST /api/ingest?dryRun=1` with the board token | `200 {"ok":true,"dryRun":true,"creds":"valid"}` |
| same, no `Authorization` header | `401` |
| same, `Bearer wrong-token-value` | `401` |
| all-blocked sweep body | `409`, KB untouched (offline stress test) |

## Fare mechanics (measured, 2026-11-03)

| Metric | Value | Basis |
|---|---|---|
| Itinerary instances tracked | 101 (first full day) | 2 dates x 14 routes, real snapshot |
| Carried a GoWild fare | 62 (61%) | real |
| GoWild as share of standard fare | ~12-15% | 62 real comparisons |
| Distinct departure hours with GoWild | 7 | real |
| Flight number in payload | **present** | 81 of 140 flights carry one |
| Flips observed | 0 on the first recorder sweep | expected: all were already GoWild at first sight |
| Live render | version `d029541b`, section present, 44 rows, no `$NaN`/`>undefined<` | verified over HTTPS |

## Efficiency pass, 2026-11-03 (replayed against the live snapshot)

**The burst was the limiter, not the cadence.** A refusal aborts the sweep
(`shouldAbortSweep`), and refusals had now been observed at 4/28 and 19/28 requests
in otherwise identical bursts — so a 28-request burst every 15 minutes can return
*less* data than a 14-request one. Measured by replaying the next tick through the
real `mergeSweeps` -> `buildBoard` -> `renderPage` path against the live KV snapshot
(`sweeps=28`, dates `2026-11-03` + `2026-11-04`). **No Frontier request was made.**

| Tick | Requests | Sweeps kept | Partial | Carried | Page |
|---|---|---|---|---|---|
| 10:30 ET, both dates, shard 0 | 14 | 28 | 0 | 14 | 58,063 B, 0 forbidden strings, client script parses |
| 23:30 ET, tomorrow only, shard 0 | 7 | 28 | 0 | 21 | 58,064 B, 0 forbidden strings, client script parses |

1. **Half-sweep rotation.** `routeShard()` alternates 0/1 on 15-minute slots and
   `shardRoutes()` splits the 14 routes into two disjoint halves of 7, so a two-date
   sweep is 14 requests and every route is re-checked within 30 minutes. The half
   not asked is carried as `carriedReason: 'rotated'` and never counts as a partial
   sweep — a banner that fires every tick is a banner nobody reads. An abort inside
   the asked half still reports a genuine partial sweep.
2. **Overnight skip.** After 23:00 Eastern (`departuresFinished`, ET-pinned) the
   collector asks only about tomorrow: 7 requests instead of 14, for a day whose
   schedule has already flown. Only when the previous snapshot actually holds today,
   because a date with nothing to carry would vanish from the board — and a vanished
   date is the one state the page must never show.
3. **Carried age on the page.** Each date now renders
   `7/14 routes re-checked · 7 carried from 22:45 ET`; a finished day renders
   `14 routes carried from 23:30 ET · departures for this date have finished`.
   Before this, carried rows looked exactly as fresh as the board timestamp.

**Defect found while doing it.** `recordObservation` wrote `days[route|date] = 0` for
*every* known route absent from the sweep's rows. Under rotation that would have
zeroed the half nobody asked, erasing a real `1` recorded twenty minutes earlier. It
now takes `opts.asked` and records a verdict only for routes that were asked and
answered; omitting the option keeps the old whole-list behaviour.

**Residual risk, stated rather than hidden:** the shard is derived from the clock
slot, so two runs landing inside the same 15-minute slot (a delayed runner) repeat a
half and postpone the other by one tick — a worst case of a 45-minute gap for that
half, self-correcting on the next slot. GitHub's schedule delay is the only cause.
