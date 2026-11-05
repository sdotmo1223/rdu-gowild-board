import { ORIGIN, MAX_ALL_IN } from './routes.js';

// Zero-cost push notifications via ntfy.sh.
// No account, no key, no card: the topic name is the only secret and it lives in
// an env var. The collector posts plain text; the phone subscribes to the topic.
//
// Deliberate restraint: an alert only fires when the digest changes and there are
// genuinely new rows, or when the collector's error state changes. A blocked
// sweep repeating every 15 minutes must not turn into 96 notifications a day.

const ERROR_REPEAT_MS = 6 * 3600 * 1000;

export function alertKind(state) {
  const err = state && state.lastError;
  if (!err) return null;
  return err.kind === 'auth' ? 'auth' : err.kind === 'blocked' ? 'blocked' : 'error';
}

export function shouldAlert(state, kind, now) {
  const last = state && state.lastAlert;
  if (!last) return true;
  if (last.kind !== kind) return true;
  return now - last.at >= ERROR_REPEAT_MS;
}

// Silence is ambiguous: a board with zero qualifying rows and a board whose cron
// is dead both show nothing. This fires when a HEALTHY sweep keeps finding
// nothing, at most once a day, so an empty page is a statement and not a void.
export const ZERO_REPEAT_MS = 24 * 3600 * 1000;

export function buildZeroAlert(state, now) {
  if (!state || state.lastError) return null;
  const z = state.zero;
  if (!z || !(Number(z.count) >= 3) || !z.since) return null;
  // Its own timestamp, not state.lastAlert: a blocked alert in between used to
  // overwrite the record and let the "still nothing" push fire again the same day.
  const lastAt = Number(state.lastZeroAt) || 0;
  if (lastAt && now - lastAt < ZERO_REPEAT_MS) return null;
  const hrs = Math.max(1, Math.round((now - z.since) / 3600000));
  return {
    kind: 'zero',
    title: `GoWild: still nothing from ${ORIGIN}`,
    message:
      `${z.count} healthy sweeps over ${hrs}h and not one GoWild seat under $50.\n` +
      'The collector is running; Frontier is simply not releasing seats here.\n' +
      `Open /${String(ORIGIN).toLowerCase()} to see the current state.`,
    priority: 'low',
  };
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function shortDate(iso) {
  const [y, m, d] = String(iso).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

function clockOf(dep) {
  const m = String(dep || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  let h = Number(m[1]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

// Titles go into an HTTP header, so they stay ASCII and short.
export function buildAlert(state, fresh, now) {
  const kind = alertKind(state);

  if (kind === 'auth') {
    if (!shouldAlert(state, kind, now)) return null;
    return {
      kind,
      title: 'GoWild board: session expired',
      message:
        'The Frontier session cookie was rejected.\n' +
        'Repair: npx wrangler secret put FRONTIER_COOKIE\n' +
        'Then re-run the collect workflow.',
      priority: 'high',
    };
  }

  if (kind === 'blocked') {
    if (!shouldAlert(state, kind, now)) return null;
    return {
      kind,
      title: 'GoWild board: collector blocked',
      message:
        `Frontier bot protection blocked the sweep.\n` +
        `${(state.lastError && state.lastError.detail) || ''}\n` +
        'The board still shows the last good sweep.',
      priority: 'default',
    };
  }

  // The ceiling comes from routes.js, never a literal: the push and the page must
  // agree the day MAX_ALL_IN moves.
  const rows = (fresh || []).filter((r) => typeof r.allin === 'number' && r.allin <= MAX_ALL_IN);
  if (!rows.length) return null;

  rows.sort((a, b) => String(a.dep).localeCompare(String(b.dep)));
  const lines = rows.slice(0, 12).map(
    (r) => `${r.dest} ${shortDate(r.date)} ${clockOf(r.dep)} ${money(r.allin)} ${r.stops || ''}`.trim(),
  );
  if (rows.length > 12) lines.push(`+${rows.length - 12} more`);

  return {
    kind: 'fares',
    title: `GoWild: ${rows.length} new under $50`,
    message: lines.join('\n'),
    priority: 'default',
  };
}

// A watchlist is a promise, so it is its own alert: "tell me when ATL is under
// $25" is not the same question as "tell me when the board changed". Parsed from
// WATCH="ATL<=25,MCO<=30"; a malformed entry is dropped, never guessed at.
export function parseWatch(spec) {
  return String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^([A-Z]{3})\s*<=?\s*(\d+(?:\.\d+)?)$/i.exec(s);
      return m ? { dest: m[1].toUpperCase(), max: Number(m[2]) } : null;
    })
    .filter(Boolean);
}

// Long enough that a fare sitting under the watch price all evening buzzes once,
// short enough that a genuinely new departure is still reported the same night.
export const WATCH_REPEAT_MS = 6 * 3600 * 1000;

export function buildWatchAlert(state, fresh, spec, now) {
  const want = parseWatch(spec);
  if (!want.length) return null;

  const hits = (fresh || []).filter((r) =>
    want.some((w) => r && r.dest === w.dest && typeof r.allin === 'number' && r.allin <= w.max),
  );
  if (!hits.length) return null;

  const fired = state && state.watchFired && typeof state.watchFired === 'object' ? state.watchFired : {};
  // The fare is part of the identity. A departure that drops under the watch
  // price, rises back above it and drops again is a NEW answer; keying on the
  // departure alone would swallow that second chance for six hours.
  const key = hits
    .map((r) => `${r.date}|${r.dest}|${r.dep}|${Number(r.allin).toFixed(2)}`)
    .sort()
    .join(',');
  if (fired[key] && now - Number(fired[key]) < WATCH_REPEAT_MS) return null;

  hits.sort((a, b) => String(a.dep).localeCompare(String(b.dep)));
  const lines = hits
    .slice(0, 8)
    .map((r) => `${r.dest} ${shortDate(r.date)} ${clockOf(r.dep)} ${money(r.allin)}`);
  if (hits.length > 8) lines.push(`+${hits.length - 8} more`);

  return {
    kind: 'watch',
    key,
    title: `GoWild watch: ${hits[0].dest} at ${money(hits[0].allin)}`,
    message: lines.join('\n'),
    priority: 'high',
  };
}

export async function sendAlert(topic, alert) {
  if (!topic || !alert) return { sent: false, reason: 'no-topic-or-alert' };
  // The dry-run harness must execute this branch (it is where the 2026-11-04
  // ReferenceError lived) without pushing anything to a real phone.
  if (process.env.NTFY_DRY === '1') {
    console.log(`[dry] alert would be sent: ${alert.title}`);
    return { sent: true, dry: true };
  }
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: alert.title,
      Priority: alert.priority || 'default',
      Tags: 'airplane',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: alert.message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  return { sent: true };
}

// --- Liveness ----------------------------------------------------------------
// The board cannot report its own absence: nothing inside the collector runs to say
// that the collector stopped. Two probes cover the two ways it can die.
export const STALE_ALERT_AFTER_MIN = 180; // 3x the measured median gap (58 min)
export const HEARTBEAT_REPEAT_MS = 6 * 3600 * 1000;

// Collector side: the snapshot this sweep is about to replace was already too old.
// That is either a cron that resumed after a gap or one profile that stopped writing
// while the others kept going. At most once every six hours.
export function buildHeartbeatAlert(state, now, thresholdMin = STALE_ALERT_AFTER_MIN) {
  const updated = Number(state && state.updatedAt) || 0;
  if (!updated) return null;
  const ageMin = Math.max(0, Math.round((now - updated) / 60000));
  if (ageMin <= thresholdMin) return null;
  const lastAt = Number(state && state.lastHeartbeatAt) || 0;
  if (lastAt && now - lastAt < HEARTBEAT_REPEAT_MS) return null;
  const hours = Math.max(1, Math.round(ageMin / 60));
  return {
    kind: 'heartbeat',
    title: `GoWild: ${ORIGIN} collector silent ${hours}h`,
    message:
      `The last snapshot for ${ORIGIN} was ${hours}h old when this sweep started.\n` +
      'Nothing wrote for longer than the 3h limit, so the cron or the write path stopped.\n' +
      'The board keeps serving the last good sweep, which is why it still looks alive.',
    priority: 'high',
  };
}

// Worker side: the only component still running when the cron is dead. Pure, so the
// decision is testable without a KV binding or a network call.
export function shouldSendStaleAlert(ageMin, lastAt, now, thresholdMin = STALE_ALERT_AFTER_MIN) {
  const age = Number(ageMin);
  if (!Number.isFinite(age) || age <= thresholdMin) return false;
  const last = Number(lastAt) || 0;
  return !(last && now - last < HEARTBEAT_REPEAT_MS);
}
