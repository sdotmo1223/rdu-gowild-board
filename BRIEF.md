# BRIEF — RDU GoWild Board

Single source of truth for every agent on this build. Read this file before writing code.
Do not ask the orchestrator to re-paste requirements; they are here.

## Mission
A zero-cost, self-refreshing web page listing every Frontier GoWild departure from **RDU**
for **today and tomorrow**, filtered to **all-in <= $50.00**. Personal tool, one user, never
sold or published. Optimize for exactly three things: it works, it costs $0, and a silent
failure is impossible.

## Non-negotiable constraints
1. **$0 recurring.** Cloudflare Workers Free + KV Free only. No credit card, no R2, no paid
   tier, no third-party API keys. If you find yourself proposing a card, you are wrong.
2. **Scraper base:** CalebJiang-at/Frontier-GoWild-Search (MIT). Fork it, pin it, add cookie
   auth. Do NOT reuse code from fly-metothemoon/GWsearch (CC BY-NC-ND forbids derivatives)
   or sallywhite-git/FrontierWildWatch.
3. **Read-only.** Never touch checkout, payment, or booking. Never store a password.
4. **The cookie is a secret the USER sets.** It is supplied at runtime as the Worker secret
   `FRONTIER_COOKIE` (or locally via `.dev.vars`). It must never appear in source, logs,
   error messages, test fixtures, BRIEF.md, KV, git, or any chat message. Agents are told
   "a secret is configured" and nothing else.
5. **Polite scraping.** Sequential requests only. 2-5 s randomized delay between requests.
   15-minute cadence. **Exactly one agent touches Frontier, ever.** No parallelism against
   Frontier under any circumstance.

## Domain facts you can trust
- GoWild fares require an authenticated Frontier Miles session. There is no anonymous
  endpoint. The user supplies a session cookie; no password is ever handled.
- GoWild = $0.01/segment base + taxes/fees. All-in domestic ~= $15 nonstop, ~= $25 one-stop.
  International ~= $60-110, so the $50 ceiling excludes most international automatically.
- Domestic booking opens the calendar day before departure. Seats release ~12:00 AM local,
  plus random mid-day releases from cancellations. That is why we poll.
- User's pass blackouts (bookable only with a Peak Day Charge of $79-$159):
  - 2026 Nov 24-25, 28-30
  - 2026 Dec 19-24, 26-31
  - 2027 Jan 1-3, 14-15, 18
  - 2027 Feb 11-12, 15

## Required behaviour
- **All-in price is mandatory.** all-in = base fare + taxes + fees, per itinerary. If the
  upstream data cannot be verified to include tax/fee components, sum what is returned and
  label the field **"estimated all-in"** in the UI. Never silently display $0.01.
- Filter `allin <= 50.00`. Drop everything above. Sort by departure time, nonstops first,
  nonstops badged `NONSTOP`.
- Each row: city + IATA, local departure, local arrival, duration, stops, seats left,
  all-in $, blackout badge.
- Blackout dates render as `Peak Day Charge $79+`. Never blank, never "no flights".
- Header shows `updated N min ago`; amber past 45 min. On auth failure show a red banner
  `Session expired - cookie needs replacing` plus the exact command to fix it.
- **An empty grid is a FORBIDDEN failure state.** Absence of data must never be rendered as
  "no flights available". Every non-success state needs its own explicit visual.
- History: append a snapshot only when the digest CHANGES (hash against last). One row per
  transition: `{ts, date, dest, dep, stops, dur, seats, allin}`. This keeps us inside KV's
  1,000 writes/day and 1-write-per-second-per-key limits.
- Second view: per-route weekday opening frequency, e.g. `RDU->CUN: opened on 6 of 8 Mondays`.

## Worker entry points
- `scheduled()` every 15 min -> sweep RDU departures for today + tomorrow.
- `fetch()` `/s/<TOKEN>` -> the page (secret link, unguessable token).
- `fetch()` `/api/board` -> JSON.

## Acceptance checks (VERIFIER owns these; must be a different agent from any builder)
- `curl /api/board` returns JSON; every row <= $50; sort order correct.
- Page renders at 390px viewport with no horizontal scroll.
- Two devices on different networks both load via the secret link.
- Simulated auth failure shows the red banner, not an empty grid.
- Cloudflare dashboard reads $0.00 with no billing method attached.
- History: force two consecutive sweeps with different data; confirm exactly one new row.
- State the route count found, sweeps completed, KV writes/day.

## Stop conditions
- Cookie doesn't work -> stop at Phase 0, report, do nothing else.
- Any step would require a credit card -> stop and report.
- All-in pricing can't be determined -> ship labelled "estimated all-in" and say so.
- More agents will not fix it -> say so instead of spawning more.

## File ownership (ONE WRITER PER FILE, split by file not by function)
| File | Owner |
|---|---|
| `BRIEF.md`, `AGENTS.md`, `REPORT.md` | ORCHESTRATOR |
| `scraper/` (all files) | BUILDER-A |
| `src/board.js`, `src/render.js` (page) | BUILDER-B |
| `src/history.js`, `src/frequency.js` | BUILDER-C |
| `test/` acceptance scripts | VERIFIER |

Never edit a file you do not own. If you need a change in someone else's file, report it.
