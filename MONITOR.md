# Monitor — first-time-go reliability record

The bar this file exists to hold: **a request for the board should succeed on the
first attempt at least 90% of the time**, and when it does not, the failure must be
visible, attributed and recorded here — not discovered by a cron email days later.

## Failure log

| when (ET) | what | symptom | cause | fix | commit |
|---|---|---|---|---|---|
| 2026-11-04 06:18 | sweep run 41813290835 | `collector failed: boardRows is not defined`, job red | alert block read a binding declared inside the success branch; threw *after* 42 Frontier requests, *before* the snapshot write | hoisted `boardStamp`/`boardRows` above the branch; alerting wrapped so it can never cost the snapshot | `ce6e4c6` |
| 2026-11-04 05:00–09:00 | deploy runs | `No access to the specified service` | `CF_API_TOKEN` is KV-scoped and cannot upload a Worker | deploy gates the board, states the limitation instead of failing, deploys only from `main` via optional `CF_DEPLOY_TOKEN` | `b8da419`, `c16232a` |
| 2026-11-03 | sweep, KV write | `KV GET 401` after a 19-request sweep | invalid Cloudflare token discovered *after* spending the burst | preflight proves the write path before any Frontier contact; KV errors name the human action | earlier |
| recurring | sweep bursts | `no-journeys-key` mid-burst | Frontier's transient throttle, not a quota | one refusal aborts the sweep; carried rows keep the board intact; per-profile budget caps the burst | by design |

## What runs before a request is spent

In `sweep.yml`, in this order, each cheaper than the next:

1. **Preflight** — proves the write path accepts the token (0 Frontier requests).
2. **`npm run lint`** — `no-undef`, the class of bug `node --check` cannot see (0 requests).
3. **`npm run dry`** — executes the collector's real `main()` against a fixture: plan, parse, merge, alerts, write. No network, no production write (0 requests).
4. Chromium install, then the sweep.

`deploy.yml` runs lint, dry, test and stress before it may publish.

## Measured reliability

- **Sweep workflow: 23 success / 1 failure** across 25 recorded runs
  (0 still running or cancelled). Last 5: 3/5 success.
- **Deploy workflow: 6 success / 1 failure** across 7 runs.
- **Dry run: 9500 ms**, no network, no write.
- **Board now: 11/4/2026, 6:30:36 AM ET, 22 bookable rows, age 2 min, requests 14, shard 1, sweepError null**
- Gates: lint, dry, acceptance 25, multi-origin 9, merge 6, stress 62 — all green
  on commit `7054364`.

Every failure in the table above is now impossible to reach with a green gate chain:
the collector's own wiring is executed by a gate, and the harness is proven to fail
when a binding is out of scope (a copy with `boardRows` renamed to an undeclared
name exits 1 with a `ReferenceError`).

## Open risks that can still cost a first-time go

1. **Ntfy delivery is not retried.** A failed push is logged and dropped; the watch
   dedupe will not re-fire until the fare changes. Board data is unaffected.
2. **Half the routes per tick.** A single tick answers 7 of 14 RDU routes; the board
   is complete only after two ticks (~30 min). Reading one tick shows half a list.
3. **The fixture is one journey.** The dry harness proves wiring, not breadth: it
   cannot catch a parser regression that only affects multi-leg or sold-out rows.
4. **Frontier can refuse a burst at any time.** That is external and is handled by
   abort-and-carry, but it still means a given tick may add no new rows.

## How to check health in 30 seconds

```bash
npm run lint && npm run dry && npm test && npm run stress   # chain integrity
gh run list --workflow gowild-sweep -L 5                    # did the crons land?
curl -s "$BOARD/api/board?token=$TOKEN" | jq '{updatedAt,ageMinutes,stale,requests,lastSweep,sweepError}'
```
