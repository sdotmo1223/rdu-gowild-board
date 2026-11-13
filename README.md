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

### The external nudge

GitHub's scheduler drops events under load and a dropped schedule event leaves **no run to
recover inside**, so the recovery entry in `sweep.yml` cannot see it. Measured 2026-11-11: 24
scheduled runs in 24 h, median gap 60 min, and three consecutive recovery slots at 16:35, 16:50
and 17:05 produced no run record at all while the board sat hours stale.

The Worker therefore carries a Cloudflare Cron Trigger every 15 minutes (`[triggers]` in
`wrangler.toml`). It reads its own board age and asks GitHub to dispatch the collector only when
the board is older than 40 minutes, with a 10-minute cooldown so four ticks cannot queue four
overlapping Chrome installs. The workflow's own concurrency group is the third line of defence.

| Name | Kind | Value |
|---|---|---|
| `GH_DISPATCH_TOKEN` | Worker secret | a fine-grained PAT with **Actions: write** on this repo |
| `GH_REPO` | optional variable | defaults to `sdotmo1223/rdu-gowild-board` |

Without the secret the receiver is a clean no-op that logs the reason and names what to create —
the sweep keeps running on GitHub's own schedule. The same gate can be run by hand:
`/api/dispatch?token=<BOARD_TOKEN>` answers with what it decided and why.
`/api/ingest` accepts `?dryRun=1`, which proves the credential in one request without
writing anything, so a run can never spend 28 fare requests to discover it cannot write.

Run once by hand (Actions → `sweep.yml` → Run workflow) and open
`https://<worker>.workers.dev/s/<BOARD_TOKEN>`.

## Watching a route

Each departure on the token page carries a **Watch** button. It opens a small sheet
with the two questions that matter: *which scope* (this date only, or every date until
you stop it) and *how to be told*. The bell stays pressed on every row for that
destination, and a strip under the masthead lists what is being watched plus the
channels that can actually deliver.

What fires an alert, and nothing else:

| Event | When |
|---|---|
| **opened** | the route had no option under the ceiling and now does |
| **gone** | it had one and now does not — sold out, or repriced above $50 |
| **left** | a watched departure passed its time. Reported as *left*, never as *sold out*: the board drops rows that have flown, and confusing the two would page you about every flight you watch |
| **cheaper** | the cheapest option dropped by at least a dollar |
| **soon** | a watched departure is inside 3 hours, once per departure |

A watch is a KV record (`w:<profile>:<DEST>`), not a browser setting, so it survives a
closed tab and a new phone. It is evaluated when a snapshot lands at `/api/ingest`
(the path `sweep.yml` uses), the first look after you arm it only sets a baseline, and
the same event on the same departure never repeats inside six hours. Rows older than
the 3 h ceiling produce **no** event at all: a memory of a seat is not evidence that
one sold. If the collector writes straight to KV instead of through the Worker, watches
are not evaluated — that path has no notification hook.

Delivery is an outbox, not a fire-and-forget POST. An event is queued with its key and
its rendered copy, and `announced`/`lastEvent` move **only after a 2xx**, so a failed push
is retried on later sweeps instead of lost. A recoverable failure (5xx, 429, 408, network)
backs off 1, 2, 4, then 8 minutes and is allowed five attempts in total; a permanent 4xx
kills the entry immediately. A `soon` event is dropped at its departure rather than sent
late — a notification about a plane that has left is not late, it is wrong. After the fifth
failure the entry is kept as a dead tombstone (so the same event is never re-queued) and
the board says **Watch delivery failing** with the provider's own reason. That banner is
the only place a silent bell can be noticed, so it is worth knowing what it means.

A bell only exists on the `/s/<token>` page. The public `/rdu` profile has no token, so
it cannot arm one, and a watch cannot be created without `BOARD_TOKEN`.

### Channels

Phone push comes from **the GoWild app itself** and costs nothing: the Worker signs short
messages with VAPID keys and encrypts them to each enrolled device (RFC 8291), so the
installed app is the only app involved and the update log on the page is the same stream
as the notifications. There is no third-party topic and no second app to trust.

| Channel | Needs | Notes |
|---|---|---|
| push | `VAPID_PUBLIC`, `VAPID_PRIVATE`, and at least one enrolled device | free; the app enrols itself with one tap on the page |
| email | `RESEND_API_KEY`, `ALERT_EMAIL` (optional `ALERT_FROM`) | Resend's free tier. The default sender `onboarding@resend.dev` only delivers to your own account address — a verified domain is needed for anyone else |
| text | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `ALERT_PHONE` | real SMS, and **not free**: Twilio charges per message and the number costs monthly, so this stays off until you add it deliberately |

Set them as Worker secrets (`npx wrangler secret put RESEND_API_KEY`). Generate the push
keypair once, and never commit the private half:

```bash
node -e "const {generateKeyPairSync}=require('crypto');const p=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pub=p.publicKey.export({format:'jwk'});const priv=p.privateKey.export({format:'jwk'});const point=Buffer.concat([Buffer.from([4]),Buffer.from(pub.x,'base64url'),Buffer.from(pub.y,'base64url')]).toString('base64url');console.log(point);console.log(priv.d)"
npx wrangler secret put VAPID_PUBLIC     # the 87-character point
npx wrangler secret put VAPID_PRIVATE    # the 43-character d
```

A channel whose
variables are missing is drawn as *off* with the missing variable named, and a watch that
asks for it is saved with a warning rather than silently dropped. Nothing is sent with a
secret in a URL, and a provider having a bad day never costs the snapshot.

### Enrolling the phone (one tap, on the phone)

The enrolment is the app's own, so nobody has to copy a topic string anywhere.

1. **Install the app** from the board itself: open `/s/<token>` in Chrome, menu → *Add to
   Home screen* → **Install**. The manifest carries PNG 192 and 512, which is what Chrome
   needs to mint a real WebAPK (an SVG-only icon shows the dialog and then installs
   nothing — see `HANDOFF.md`, 2026-11-12).

2. **Open the installed app and press “Enable app notifications”.** The page asks for
   permission, subscribes with the Worker's VAPID public key, and stores the subscription
   in KV. The line under the log then reads *This device is enrolled*.

3. **Prove the path by hand** before trusting a watch:

   ```bash
   curl -X POST "https://rdu-gowild-board.sdotmo1223.workers.dev/api/push/test?token=$BOARD_TOKEN"
   ```

   A notification titled `GoWild test` should land within a few seconds, and tapping it
   should open the board. `GET /api/push/state` lists the enrolled devices and when each
   last succeeded.

4. **Prove the real path.** Press the bell on a departure inside three hours and wait for
   the next sweep (or `gh workflow run sweep.yml --repo sdotmo1223/rdu-gowild-board -f profiles=rdu`).

5. **If nothing arrives**, the failure is almost never the Worker: a 201 from the push
   service only means *accepted*, not *shown*. Check, in this order: the OS-level
   notification permission for the WebAPK (`adb shell cmd appops get org.chromium.webapk.*
   POST_NOTIFICATION` — `ignore` here means Android is dropping them, not the Worker); the
   service worker actually being the deployed one (`/s/<token>/sw.js` contains
   `addEventListener('push'`); and the board's own **Watch delivery failing** banner, which
   names the status the push service returned. An undecryptable payload is dropped by
   Chrome without any message at all, which is why the suite decrypts what the Worker
   encrypts instead of trusting a 201.

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
| Data > 180 min old (three measured median cron gaps) | amber stale banner, amber timestamp |
| A fare older than 180 min | withheld, and the date states when it was last checked — an old price is a memory, not an offer |
| All routes blocked | red bot-protection banner, previous board preserved |
| Some routes failed | per-date "`n`/14 routes re-checked · `n` failed" |
| Half the routes carried (rotation) | per-date "7/14 routes re-checked · 7 carried from HH:MM ET" |
| Departures finished for the day | "14 routes carried from 23:30 ET · departures for this date have finished" |
| Blackout date | `Peak Day Charge $79+` |
| GoWild all above $50 | "`n` departures, all above $50.00" |
| Two other airports | Not served right now. `/rdu` is the only board; `/lga` and `/phl` are switched off until this one is solid |
| No GoWild seats released | "`n` departures, but no GoWild seats" |
| Route not operating | "No Frontier departures from RDU on this date." |

## Route count

**14** current nonstop Frontier routes from RDU: ATL BOS CLE CUN DEN DFW DTW FLL IAH
MCO MIA PHL SJU TPA. Verified against FlightConnections (updated 2026-11-02) and RDU's
own nonstop table. The widely repeated "32 destinations" is an ABC11 article from
**2019-05-01**; BUF is announced but not yet operating.

## Constraints honoured

- **$0**: Workers Free + KV Free + GitHub Actions free minutes. No card, no R2, no paid tier.
- **Politeness**: strictly sequential, 2–5 s randomized, **one origin swept — RDU — at
  14 requests per tick**, one process ever (enforced by a GitHub Actions `concurrency`
  group). LGA and PHL stay defined in the code but are not scheduled: three airports on
  this budget could not stay inside the 3-hour freshness ceiling. The cron asks for 15 minutes; GitHub delivers about hourly
  on a free runner (measured 2026-11-04: 24 runs in 24 h, gaps median 60 min,
  range 42–81), so rotation alternates per tick rather than per clock slot.
  A second entry (`5,20,35,50`) fills the slots GitHub drops: it sweeps only when
  the board is already 40 minutes old and skips otherwise, so a healthy hour still
  costs a single burst (measured 2026-11-07: 9 deliveries in 24 h, gaps up to 434 min).
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
