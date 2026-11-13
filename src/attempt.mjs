// What the LAST ATTEMPT did, kept separate from what the last GOOD SWEEP left.
//
// Measured 2026-11-11: `state.requests` was assigned for every sweep including one
// that produced nothing, `state.aborted` was only assigned on the success path, and
// `updatedAt` (deliberately) did not move on a total failure. So a reader of
// /api/board saw a new request count and a stale abort reason sitting under an old
// timestamp, and could not tell a dead tick from a clean one.
//
// The rule: every attempt writes one record of itself. A failed attempt advances
// `lastAttempt` while `updatedAt` and `aborted` stay exactly where the last
// successful sweep put them, so the two facts are always separable.

// `ok` means "this attempt produced a board that can be written", not "everything
// went perfectly": a sweep aborted after four routes answered still wrote a board.
export function buildLastAttempt({ at, requests, total, okCount, aborted, error } = {}) {
  const answered = Math.max(0, Number(okCount) || 0);
  const planned = Math.max(0, Number(total) || 0);
  let reason;
  if (aborted) {
    reason = `aborted: ${String(aborted.reason || 'refused')}`;
  } else if (!answered) {
    // The collector's own classifier, so a blocked sweep and an empty one are not
    // both flattened into "error".
    reason = (error && error.kind) || 'no-usable-route';
  } else if (answered < planned) {
    reason = 'partial';
  } else {
    reason = 'ok';
  }
  return {
    at: Number(at) || 0,
    requests: Math.max(0, Number(requests) || 0),
    ok: answered > 0,
    reason,
  };
}

// Only the attempt record. Touching updatedAt here would erase the one fact that
// makes the board's age honest, and touching aborted would overwrite the reason a
// previous sweep stopped with the empty value of a sweep that never reached one.
export function applyAttempt(state, attempt) {
  const target = state && typeof state === 'object' ? state : {};
  target.lastAttempt = attempt;
  return target;
}
