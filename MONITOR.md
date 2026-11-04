# Monitor — first-time-go reliability record

The bar this file exists to hold: **a request for the board should succeed on the
first attempt at least 90% of the time**, and when it does not, the failure must be
visible, attributed and recorded here — not discovered by a cron email days later.

## Failure log

| when (ET) | what | symptom | cause | fix | commit |
|---|---|---|---|---|---|
| 2026-11-04 06:18 | sweep run 41813290835 | `collector failed: boardRows is not defined`, job red | alert block read a binding declared inside the success branch; threw *after* 42 Frontier requests, *before* the snapshot write | hoisted `boardStamp`/`boardRows` above the branch; alerting wrapped so it can never cost the snapshot | `ce6e4c6` |
| 2026-11-04 05:00–09:00 | deploy runs | `No access to the specified service` on every push | `CF_API_TOKEN` is KV-scoped and cannot upload a Worker | deploy job now gates the board, reports the limitation, and deploys only from `main` with an optional `CF_DEPLOY_TOKEN` | `b8da419`, `c16232a` |
| 2026-11-03 | sweep, KV write | `KV GET 401` after a 19-request sweep | invalid/expired Cloudflare token discovered *after* spending the burst | preflight proves the write path before any Frontier contact; KV errors name the human action | earlier |
| recurring | sweep bursts | `no-journeys-key` mid-burst | Frontier's transient throttle, not a quota | one refusal aborts the sweep, carried rows keep the board intact, per-profile budget caps the burst | by design |

## What now runs before any request is spent

In `sweep.yml`, in this order, each cheaper than the one after it:

1. **Preflight** — one request that proves the write path accepts the token (0 Frontier requests).
2. **`npm run lint`** — `no-undef`: the class of bug `node --check` cannot see (0 requests).
3. **`npm run dry`** — executes the collector's real `main()` against a fixture payload: plan, parse, merge, alerts, write. No network, no production write (0 requests).
4. **Chromium install**, then the sweep itself.

`deploy.yml` runs lint, dry, test, stress before it is allowed to publish.

## Measured reliability (measured 23/25 sweep runs)

- sweep workflow: =1 failure=1 success=23
- deploy workflow: failure=1 success=6
- last 5 sweep runs: 3/5 success
- board at time of writing: 

## Open risks that still cost first-time-go

1. **Ntfy delivery is not retried.** A failed push is logged and dropped; the watch
   dedupe will not re-fire until the fare changes. Board data is unaffected.
2. **One origin per tick.** The rotation means a single tick answers 7 of 14 RDU
   routes; the board is complete only after two ticks (~30 min). Anything reading a
   single tick sees half a route list.
3. **The fixture is one journey.** The dry harness proves wiring, not breadth: it
   cannot catch a parser change that only affects multi-leg or sold-out itineraries.
4. **`STATE_OUT` default is a repo file.** A dry run without `STATE_OUT` writes
   `state.json`; the harness always sets it, a human might not.

## How to check health in 30 seconds

```bash
npm run lint && npm run dry && npm test && npm run stress   # chain integrity
gh run list --workflow gowild-sweep -L 5                    # did the crons land?
curl -s "$BOARD/api/board?token=$TOKEN" | jq '{updatedAt,ageMinutes,stale,requests,lastSweep,sweepError}'
```
