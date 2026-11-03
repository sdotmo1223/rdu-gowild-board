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

  const rows = (fresh || []).filter((r) => typeof r.allin === 'number' && r.allin <= 50);
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

export async function sendAlert(topic, alert) {
  if (!topic || !alert) return { sent: false, reason: 'no-topic-or-alert' };
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
