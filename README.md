# RDU GoWild Board

A zero-cost board of every Frontier **GoWild** departure from **RDU** for today and
tomorrow, filtered to an all-in price of **$50.00 or less**. Read-only: it never touches
booking, payment, or checkout.

## Why this is shaped the way it is

Frontier's fare endpoint is protected by DataDome. Measured on 2026-11-03:

| Client | Result |
|---|---|
| `fetch()` from Node, no cookie | `302` → `/Flight/Redirect`, 20,379-byte challenge, no data |
| Node + a **valid** 31-pair session cookie incl. `datadome` | still `/Flight/Redirect` — blocked |
| Node + that cookie + a full Chrome header profile | still `/Flight/Redirect` — blocked |
| Real Chromium, **logged out** | `200`, 1.09 MB, full GoWild pricing |

So the gate is client fingerprinting, not authentication. **A Cloudflare Worker cannot
fetch Frontier directly**, and no cookie fixes it. A real browser does, and it does not
even need a login.

That single fact dictates the architecture: a headless Chromium collector runs on a free
schedule and writes a JSON snapshot to KV; the Worker only reads KV and renders.

## Architecture

```
GitHub Actions cron (*/15)          Cloudflare Worker (free)
  └─ Playwright Chromium              ├─ /s/<BOARD_TOKEN>  → board page
       └─ 14 routes × 2 dates         ├─ /api/board        → JSON
            (sequential, 2–5 s)       └─ /api/ingest       → snapshot write (token)
                 └─ POST snapshot ─────────────┘
                          └─ KV: "state"
```

KV writes are digest-gated: a quiet board costs **one write per sweep (96/day)** against
the 1,000/day free limit, plus one history row per genuine change.

**Why this repository is public.** Measured 2026-11-03: one run is ~2m05s of wall clock,
billed as 3 minutes. GitHub Free meters a *private* repository at 2,000 Actions minutes per
month, so `*/15` (96 runs/day ≈ 288 billed min/day) would exhaust that in about a week and
Actions would then stop — taking the board down with it, silently. Standard runners are
unmetered for public repositories, so this one is public and the cadence stays at 15
minutes. No secret is in it: `.dev.vars` and `.board-token` are gitignored and have never
been committed.

## Deploy

```bash
npm install
npx wrangler kv namespace create BOARD     # paste the id into wrangler.toml
npx wrangler secret put BOARD_TOKEN        # any long random string
npx wrangler deploy
```

Then give the collector a way to write. The recommended path needs **no Cloudflare
credential at all** — the collector POSTs the snapshot to `/api/ingest` on the Worker,
which does the KV write, authenticated with the board token that already exists:

| Name | Kind | Value |
|---|---|---|
| `BOARD_TOKEN` | secret | the same string you passed to `wrangler secret put BOARD_TOKEN` |
| `BOARD_INGEST_URL` | variable | `https://<worker>.workers.dev/api/ingest` |

The older direct-KV path still works if you prefer it — set `CF_API_TOKEN`
(*Workers KV Storage: Edit*), `CF_ACCOUNT_ID` and `CF_KV_NAMESPACE_ID` as secrets instead.
`/api/ingest` accepts `?dryRun=1`, which proves the credential in one request without
writing anything, so a run can never spend 28 fare requests to discover it cannot write.

Run once by hand (Actions → board-collect → Run workflow) and open
`https://<worker>.workers.dev/s/<BOARD_TOKEN>`.

## Local

```bash
npm run collect          # collector; prints state if KV env vars are absent
npx wrangler dev         # worker at http://localhost:8787
npm test                 # offline acceptance checks
```

`BOARD_TOKEN` goes in `.dev.vars` locally. Nothing else is secret.

## What the payload actually contains

- `goWildFare` is the **full GoWild price**, and there is **no tax or fee field anywhere**
  in the payload, so every price is labelled **"estimated all-in"** rather than presented
  as a verified total. Observed: `$15.41` nonstop, `$25.21` one-stop.
- `goWildFareSeatsRemaining` is `null` **or the string** `"3 Seats Left!"` — never a number.
- GoWild disabled is `isGoWildFareEnabled: false` with `goWildFare: -1`. The code filters
  on `> 0`, so the `-1` sentinel can never surface as a price.
- `duration` can be `"1 day(s) 5 hrs 26 min"`; next-day arrivals are flagged `+1`.
- Blackouts are **not announced**. On 2026-11-24 Frontier simply priced every GoWild seat
  at **$317.96** with `dateMessage: null`. Blackout detection therefore uses the date
  calendar, with price as a secondary signal.
- A non-operating day returns `journeys: [ … ]` with `flights: []` — a *successful* empty
  response, cleanly distinct from a DataDome redirect. That is what makes an honest
  "no flights" message possible.

## Failure states (an empty grid is never one of them)

| Condition | What you see |
|---|---|
| No snapshot ever written | red "No data yet — not 'no flights'" banner |
| Data > 45 min old | amber stale banner, amber timestamp |
| All routes blocked | red bot-protection banner, previous board preserved |
| Some routes failed | per-date "`n` routes scanned · `n` failed" |
| Blackout date | `Peak Day Charge $79+` |
| GoWild all above $50 | "`n` departures, all above $50.00" |
| No GoWild seats released | "`n` departures, but no GoWild seats" |
| Route not operating | "No Frontier departures from RDU on this date." |

## Route count

**14** current nonstop Frontier routes from RDU: ATL BOS CLE CUN DEN DFW DTW FLL IAH
MCO MIA PHL SJU TPA. Verified against FlightConnections (updated 2026-11-02) and RDU's
own nonstop table. The widely repeated "32 destinations" is an ABC11 article from
**2019-05-01**; BUF is announced but not yet operating.

## Constraints honoured

- **$0**: Workers Free + KV Free + GitHub Actions free minutes. No card, no R2, no paid tier.
- **Politeness**: strictly sequential, 2–5 s randomized, 15-minute cadence, one process
  ever (enforced by a GitHub Actions `concurrency` group).
- **Read-only**: no checkout, payment, or booking path is ever requested.
- **No stored password**: there is no login at all — only a session cookie you paste once.

## Corrections, measured after the first build (2026-11-02)

Three earlier conclusions were wrong. They are superseded here rather than quietly edited
out, because each one would have cost real debugging time.

1. **The cookie looked required, then turned out not to be.** `/Flight/InternalSelect`
   without a session bounced to `www`, which has no such path and answers **404** in 1,728
   bytes — misread for a whole sweep as a DataDome block. With the 31-pair cookie the
   request returned `200`, 1,090,467 bytes, `journeys` present. **Superseded 2026-11-02:** a
   cookie-less headless browser warming up on the booking *root* returns the full payload
   (measured, identical bytes). The cookie is applied when present, purely for resilience;
   **0 pairs is a supported mode** and is what every scheduled run has used. It is read
   from `FRONTIER_COOKIE` or the gitignored `.dev.vars`; only the pair count is ever logged.
2. **Headless Chromium is fine.** Measured headless and headed side by side: byte-identical
   payloads. The "DataDome probably blocks headless" risk is retired.
3. **A sweep where no route parses is a failure, not an empty day.** The board is only
   overwritten when at least one route returns a parseable payload; otherwise the previous
   snapshot is kept and `lastError` explains why. Counting only `blocked` made a 404-shaped
   failure look like success.

Also added: `NTFY_TOPIC` phone alerts, a recorded-history bookability grid, release timing
with honest sample sizes, pin and calendar export, and a token-scoped PWA shell.

## Collector environment

| Variable | Meaning |
|---|---|
| `FRONTIER_COOKIE` | **optional**; falls back to `.dev.vars`, 0 pairs is fine |
| `BOARD_INGEST_URL`, `BOARD_TOKEN` | recommended write path: POST to the Worker, which writes KV |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID` | alternative direct-KV write path |
| *(none of the above)* | writes `state.json` locally instead of uploading |
| `HEADLESS=0` | run headed, parked offscreen (for a local scheduler) |
| `NTFY_TOPIC` | optional phone push, no account needed |
| `WARMUP_URL` | defaults to `https://booking.flyfrontier.com/` |

A no-credential run now writes `state.json`; render it with `node tools/render-state.mjs`.
