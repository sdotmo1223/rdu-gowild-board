// The external nudge, because GitHub drops schedule events and a dropped event leaves
// no run to recover inside.
//
// Measured 2026-11-11: 24 scheduled runs in 24 h, median gap 60 min; at 17:20Z the
// newest run was 16:24Z and the 16:35/16:50/17:05 recovery entries had produced no run
// record at all. sweep.yml's recovery gate only runs INSIDE a run, so it cannot
// resurrect a slot GitHub never created. A Cloudflare Cron Trigger does not depend on
// GitHub's scheduler, so this Worker asks GitHub to dispatch the collector when -- and
// only when -- its own board is already stale.
//
// Two gates, on purpose:
//   1. freshness: a healthy board is never double-swept (that would cost Frontier 28
//      requests for a board that does not need them);
//   2. cooldown: a KV stamp means 15-minute ticks cannot queue four dispatches while
//      the first one is still installing Chromium.
// The workflow's own concurrency group remains the third line of defence.
export const DISPATCH_AFTER_MIN = 40;
export const DISPATCH_LOCK_MS = 10 * 60 * 1000;
export const DISPATCH_LOCK_KEY = 'dispatch:last';
export const WORKFLOW_FILE = 'sweep.yml';
export const DEFAULT_REPO = 'sdotmo1223/rdu-gowild-board';

export const TOKEN_REASON =
  'GH_DISPATCH_TOKEN is not set on the Worker: create a fine-grained PAT with Actions: write on this repo, then npx wrangler secret put GH_DISPATCH_TOKEN';

// Never throws: a scheduled handler that throws is a platform-level failure with no
// useful report, and this is a best-effort nudge, not a paid-for sweep.
export async function maybeDispatch(env, now = Date.now(), deps = {}) {
  const e = env || {};
  if (!e.BOARD || typeof e.BOARD.get !== 'function') {
    return { dispatched: false, reason: 'BOARD KV binding is not configured on this Worker' };
  }
  const token = String(e.GH_DISPATCH_TOKEN || '');
  if (!token) return { dispatched: false, reason: TOKEN_REASON };
  const fetchImpl = deps.fetchImpl || ((url, init) => fetch(url, init));
  try {
    const last = Number(await e.BOARD.get(DISPATCH_LOCK_KEY)) || 0;
    if (last && now - last < DISPATCH_LOCK_MS) {
      return {
        dispatched: false,
        reason: `cooldown: last dispatch was ${Math.round((now - last) / 1000)}s ago`,
      };
    }
    const state = await e.BOARD.get('state', 'json');
    const updated = Number(state && state.updatedAt) || 0;
    // No snapshot at all is not "fresh": it is the strongest possible case for a
    // dispatch, and it is exactly the state a never-run collector leaves behind.
    const ageMin = updated ? Math.round((now - updated) / 60000) : null;
    if (ageMin !== null && ageMin <= DISPATCH_AFTER_MIN) {
      return { dispatched: false, reason: `fresh: board is ${ageMin}m old (gate ${DISPATCH_AFTER_MIN}m)`, ageMin };
    }
    const repo = String(e.GH_REPO || DEFAULT_REPO);
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          // GitHub rejects an unlabelled request agent; this also makes the call
          // identifiable in the repo's audit log.
          'User-Agent': 'rdu-gowild-board',
        },
        body: JSON.stringify({ ref: String(e.GH_REF || 'main') }),
      },
    );
    const status = res && Number(res.status) ? Number(res.status) : 0;
    if (!res || !res.ok) {
      // No cooldown: a rejected dispatch must be retried on the next tick, not
      // silenced for ten minutes.
      return { dispatched: false, reason: `dispatch rejected: HTTP ${status || '000'}`, ageMin };
    }
    await e.BOARD.put(DISPATCH_LOCK_KEY, String(now));
    return {
      dispatched: true,
      reason: ageMin === null ? 'no snapshot yet' : `board was ${ageMin}m old`,
      ageMin,
      at: now,
    };
  } catch (err) {
    return { dispatched: false, reason: String((err && err.message) || err).slice(0, 160) };
  }
}
