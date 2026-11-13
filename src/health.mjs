// The HEALTH tier: silent until something is wrong, and then exactly once.
//
// Three things belong here, and they share nothing except the tier:
//   - a watch delivery that is retrying or dead (the outbox already knows);
//   - the stale-board receiver having stopped recovering the board -- the Upgrade 1
//     residual, now that GH_DISPATCH_TOKEN exists;
//   - the weekly search-link probe finding the front door broken.
//
// Everything is decided from data already stored. This module builds no request.
export const DEGRADED_AFTER_MIN = 90;

// "Recovered" means either a successful run or a dispatch happened recently. Both
// clocks matter: a dispatch that queued a run that never started is not recovery.
export function isDegraded(lastSuccessAt, lastDispatchAt, now = Date.now(), thresholdMin = DEGRADED_AFTER_MIN) {
  const window = thresholdMin * 60000;
  const success = Number(lastSuccessAt);
  const dispatch = Number(lastDispatchAt);
  if (Number.isFinite(success) && success > 0 && now - success < window) return false;
  if (Number.isFinite(dispatch) && dispatch > 0 && now - dispatch < window) return false;
  return true;
}

export function healthFingerprint(signal) {
  const s = signal && typeof signal === 'object' ? signal : {};
  const link = String(s.link || 'ok');
  return `${Number(s.pending) || 0}|${Number(s.dead) || 0}|${s.degraded ? 1 : 0}|${link}`;
}

export function buildHealthNotice(signal, lastFingerprint, now = Date.now()) {
  const s = signal && typeof signal === 'object' ? signal : {};
  const pending = Math.max(0, Number(s.pending) || 0);
  const dead = Math.max(0, Number(s.dead) || 0);
  const degraded = Boolean(s.degraded);
  const link = String(s.link || 'ok');
  const linkBad = link === 'broken' || link === 'drifted';
  if (!pending && !dead && !degraded && !linkBad) return null;

  const fingerprint = healthFingerprint(s);
  // Transition only: the caller stores this fingerprint, so a problem that persists
  // across a hundred cron ticks is still one push.
  if (lastFingerprint && lastFingerprint === fingerprint) return null;
  const lines = [];
  if (dead) lines.push(`${dead} watch notification${dead === 1 ? '' : 's'} could not be delivered after every retry${s.reason ? ` (${s.reason})` : ''}. The watch is still armed; that event will not be retried.`);
  if (pending) lines.push(`${pending} watch notification${pending === 1 ? '' : 's'} is retrying, not lost${s.reason ? `: ${s.reason}` : ''}.`);
  if (degraded) lines.push(`The stale-board trigger has not recovered the board in over ${DEGRADED_AFTER_MIN} minutes: no dispatch and no successful run. The board may be serving an old snapshot.`);
  if (linkBad) {
    lines.push(
      link === 'broken'
        ? `The weekly check of the Frontier search link found it answering ${s.linkStatus ? `HTTP ${s.linkStatus}` : 'nothing'}: the search link may be broken.`
        : `The Frontier search link has drifted to another host (pattern drift); the search link may be broken.`,
    );
  }

  return {
    kind: 'health',
    tier: 'health',
    title: dead ? 'GoWild health: delivery failing' : degraded ? 'GoWild health: trigger degraded' : 'GoWild health: search link may be broken',
    message: lines.join('\n'),
    priority: dead || link === 'broken' ? 'high' : 'default',
    fingerprint,
    now,
  };
}
