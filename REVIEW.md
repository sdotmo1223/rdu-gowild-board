# REVIEW.md — totality review, 2026-11-03

What this is: a grading of the *operator experience* of RDU GoWild Board (how hard it
is to run, read, trust and repair), a catalogue of every clash and bottleneck hit
while building the three-origin board today, the peer-review findings, and the
ordered fixes that raise the score. Numbers here are measured, not estimated.

---

## Scorecard

| Dimension | Start of day | Now | Evidence |
|---|---|---|---|
| Run a sweep by hand | 6 | 9 | `SWEEP_ONLY=BOS,DEN` = 4 requests in ~20 s, no CI queue |
| Read the board when it is empty | 5 | 8 | every date states a reason; a long zero is now a verdict |
| Know a board is *alive* when empty | 3 | 7 | zero-streak counter + `buildZeroAlert` (coded, **inert**: no `NTFY_TOPIC`) |
| Diagnose a failure | 4 | 6 | preflight write-path check, `profile` vs `blocked`, no-route classifier |
| Add a fourth origin | 4 | 7 | profile + one word in `PUBLIC_PROFILE` + one budget line |
| Recover from a bad sweep | 8 | 8 | abort-on-refusal, carry-forward, never overwrite good data |
| Politeness safety | 6 | 8 | per-profile budget, rotating slice, forced cap at 30, failure isolation |

**Overall: 5.1 → 7.6 / 10.** Everything still open in "Fixes" is worth the last 1.4.

---

## Clashes hit today, in order

1. **Three workflows, one concurrency group.** Each paid its own `npm ci` + Chromium
   install; a dispatched run waited ~4 minutes behind the cron. → one workflow.
2. **One wrong city pair killed a whole sweep.** An unserved pair returns a 596 KB
   Frontier shell with no `journeys`, indistinguishable from the 20 KB DataDome
   challenge. → `APP_SHELL_MIN_BYTES` + a Frontier marker.
3. **`FULL_SWEEP=1` asked 7 of 14 routes.** The per-profile budget silently halved
   the deliberate backfill. → forced sweeps compute their own budget.
4. **A 22-route forced sweep is 44 requests.** My fix for (3) unlocked a burst twice
   the measured-clean size. → `FORCED_BUDGET_CEILING = 30`, remainder deferred.
5. **Consolidation created a new failure mode.** One job, `set -e`: the first origin
   to fail skipped the rest. → `set -u`, per-origin `if/else`, aggregate exit.
6. **Quarantine was permanent.** A retired pair could never come back. → 7-day retry.
7. **`wrangler kv key get "state:phl"` reported nothing** while the key existed and
   was readable through the Worker. Cost a false "no snapshot" alarm. → read profiles
   via `GET /api/ingest?profile=`.
8. **A ~6 KB shell heredoc was truncated**, leaving patch scaffolding in the tree and
   committing `.snips/`. → `write_file` / `str_replace`, never long heredocs.
9. **`gh workflow run <file>.yml` 404s** for a freshly pushed workflow. → dispatch by
   numeric id via `gh api`.
10. **The host's link to api.github.com flaked mid-dispatch.** The dispatch landed; the
    poll returned 404s and looked like failure. → retry, then verify by state, not by
    the poll.
11. **KV eventual consistency (~1–2 min)** made a successful write look missing.

---

## Bottlenecks, measured

| Bottleneck | Cost | Fixable? |
|---|---|---|
| Queue latency before a dispatched run starts | 4+ min (observed twice) | Only by not using CI for one-off questions → `SWEEP_ONLY` |
| Chromium install | 40–70 s cold, cached after | Already cached on `package-lock` hash |
| Warm-up on the booking root | ~8 s, mandatory | No |
| Jitter per request (2–5 s) | 28 requests ≈ 100 s floor | No — this is the politeness budget |
| GitHub cron punctuality | best-effort; 47 min late seen | No, structural |
| Renderer change → visible | edit → `wrangler deploy` (~10 s) → verify | No, Worker is server-side |
| Collector change → visible | push → CI run (~3 min) | `SWEEP_ONLY` locally |
| Integrity gap on a *failed write* | one full sweep wasted | Preflight dry-run already prevents it |

---

## Peer review

### Why the first attempt failed (diagnosed 2026-11-03)

`spawn_agents` is not the OpenCode registry. On this install it exposes exactly one
spawnable agent, and every other name its description advertises is absent:

```
Agent "code-reviewer-multi-prompt" is not available to spawn
Agent "code-searcher"            is not available to spawn
Agent "gpt-5-agent"              is not available to spawn
Agent "opus-agent"              is not available to spawn
Agent "basher"                   is not available to spawn
```

The reviewers that do exist are OpenCode personas on disk:
`~/.config/opencode/agents/{surgeon-reviewer, security-auditor, multi-agent-coordinator,
research-analyst, rea, voice-smith}.md`.

Dispatch through `opencode-cli.exe` (v2.2.3) was then attempted for real. What works
and what does not, each with evidence:

| Invocation | Result |
|---|---|
| `opencode-cli debug agents` | `ServiceUnavailableError: Location plugins did not finish activating` |
| `run --agent surgeon-reviewer --auto "Reply with exactly: READY"` | **exit 0, replied** — the dispatch path itself is sound |
| `run --agent surgeon-reviewer --auto "Read AGENTS.md and reply ..."` | no output within 100 s — **tool use stalls**, consistent with the plugin failure |
| `run --agent surgeon-reviewer --auto <task file>` | `Error: You must provide a message` — `--file` attaches but does not replace the message |
| `run --agent surgeon-reviewer --auto <14.6 KB prompt>` | `ETIMEDOUT` at 250 s; stderr shows the model is **`pulse-alpha-free`** |

Conclusion: the persona layer works, but a real review cannot run headlessly here
today — tool activation is broken and the free model cannot chew a 15 KB prompt inside
a tool-call timeout. Two fixes, both outside this repo: start the OpenCode desktop
service so plugins activate, and select a faster model with `--model`. Until then the
review below is a **second pass by the same agent against the written invariants**, not
an independent reviewer. Re-run `.agents/dispatch/peer-review.md` once both are fixed;
the spec and the dispatch path are ready and proven up to the model call.

### Fixed during the review

- **F1 (high)** Origin failure isolation — a failing profile skipped the remaining
  profiles in the shared job. Now per-origin `if/else` + aggregated non-zero exit.
- **F2 (high)** Forced burst of 44 on PHL — capped at 30, deferred remainder, cap
  printed in the sweep-plan line.
- **F3 (medium)** Permanent quarantine — retired pairs return after 7 days.

### Open

- **F4 (medium)** The empty-board heartbeat cannot fire: `gh secret list` shows
  `BOARD_TOKEN`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_KV_NAMESPACE_ID` and no
  `NTFY_TOPIC`. The code is live; the channel is not configured.
- **F5 (medium)** Route lists are hand-maintained. PHL's BOS and DEN are unverified;
  a wrong pair costs 2 requests per tick until the 3-strike quarantine retires it.
- **F6 (low)** `npm test` chains with `&&`, so acceptance output is replaced by the
  profiles tail. A failure still fails the command, but the reason is buried.
- **F7 (low)** Docs drift on test counts and the new env vars (`SWEEP_ONLY`,
  `SWEEP_MAX_REQUESTS`, forced cap).
- **F8 (medium)** Single job is a single point of failure for the install step: if
  Chromium install fails, no origin sweeps. Health is only visible in Actions.
- **F9 (low)** No expiry or rotation on `.board-token`; no record of when it was made.

---

## Fixes, in order, each with an acceptance test

1. **Set `NTFY_TOPIC`** (owner action — the topic name is the credential).
   *Accept:* one push arrives for a real transition; `lastAlert.kind` in the snapshot
   changes.
2. **Print both suites** — run acceptance, then profiles, and print each summary
   instead of chaining with `&&`. *Accept:* `npm test` shows two summaries.
3. **Settle PHL BOS/DEN** — `SWEEP_ONLY=BOS,DEN`, 4 requests, delete the pairs that
   answer `route-not-served`. *Accept:* `state:phl` route count reflects reality.
4. **Per-origin status strip on the page** — last successful sweep per origin, so
   health is visible without opening Actions (mitigates F8).
   *Accept:* a stale origin is named on its own page.
5. **Docs pass** — AGENTS env table, test counts, link this file. *Accept:* every
   command in AGENTS runs as written.

---

## Standard for the next exam (definition of done)

- `npm test` **and** `npm run stress` exit 0, with profiles inside `npm test`.
- No date can render empty without a stated reason; a long zero is a verdict.
- No price without "estimated all-in"; never `$0.01` / `$NaN` / `$undefined` / `-1`.
- A failed sweep cannot overwrite a good snapshot (`classifyFailure === null`).
- One workflow, per-profile budgets, forced sweeps capped at 30 requests.
- Per-origin failure isolation present and readable in the YAML.
- Every origin: a snapshot, a public page, and a stated route coverage (n of m).
- No secret in chat, logs, or git; only pair counts reported.
- Every claim in REPORT.md traceable to a run id or a measured payload size.

## 60-second health check

```bash
# 1. snapshots and their age (no wrangler: colon keys read back empty)
curl -s -H "Authorization: Bearer $BOARD_TOKEN" "$BASE/api/ingest"                | head -c 200
curl -s -H "Authorization: Bearer $BOARD_TOKEN" "$BASE/api/ingest?profile=lga"    | head -c 200
curl -s -H "Authorization: Bearer $BOARD_TOKEN" "$BASE/api/ingest?profile=phl"    | head -c 200
# 2. pages render and state their own coverage
for p in "" /lga /phl; do curl -s "$BASE$p" | grep -o '[0-9]*/[0-9]* routes re-checked'; done
# 3. suites
npm test && npm run stress
```
