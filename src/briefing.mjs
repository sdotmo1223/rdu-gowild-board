// The BRIEFING tier: one push a day, and the one line that turns a price into a
// judgment.
//
// "Cheapest DTW fare seen in 14 days" is computed from state.history, which this
// board has been accumulating since 2026-11-03. It costs no Frontier request. What it
// must never do is speak from too little evidence: MIN_HISTORY_POINTS is the floor,
// and below it the line is omitted rather than softened.
import { easternDate, easternStamp, MAX_ALL_IN, ORIGIN } from './routes.js';

export const MIN_HISTORY_POINTS = 5;
export const BRIEFING_WINDOW_DAYS = 14;

function clockOf(dep) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(dep == null ? '' : dep));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function farePercentile(state, dest, allin, now = Date.now(), windowDays = BRIEFING_WINDOW_DAYS) {
  const code = String(dest == null ? '' : dest).trim().toUpperCase();
  const target = Number(allin);
  if (!/^[A-Z]{3}$/.test(code) || !Number.isFinite(target)) return null;
  const rows = state && Array.isArray(state.history) ? state.history : [];
  const today = easternDate(0, now);
  const [y, m, d] = today.split('-').map(Number);
  const since = new Date(Date.UTC(y, m - 1, d) - (windowDays - 1) * 86400000).toISOString().slice(0, 10);
  const values = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (String(r.dest || '').toUpperCase() !== code) continue;
    const date = String(r.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < since) continue;
    const v = Number(r.allin);
    if (Number.isFinite(v) && v > 0) values.push(v);
  }
  // Below the floor there is no percentile, only a number that looks like one.
  if (values.length < MIN_HISTORY_POINTS) return null;
  const below = values.filter((v) => v < target).length;
  return {
    n: values.length,
    pct: Math.round((100 * below) / values.length),
    cheapest: below === 0,
    windowDays,
  };
}

export function buildBriefing(state, board, settings, now = Date.now()) {
  const today = easternDate(0, now);
  const stamp = easternStamp(now).slice(11, 16);
  const dates = board && Array.isArray(board.dates) ? board.dates : [];
  const todays = dates.filter((d) => d && d.date === today);
  const rows = todays.flatMap((d) => (Array.isArray(d.rows) ? d.rows : []));
  const lines = [];

  if (board && board.stale) {
    const hours = Math.max(1, Math.round((Number(board.ageMin) || 0) / 60));
    lines.push(`The board has not been re-checked for ${hours}h, so these numbers may be old.`);
  }

  const best = rows
    .filter((r) => Number.isFinite(Number(r.allin)))
    .sort((a, b) => Number(a.allin) - Number(b.allin))[0];

  let clickPath = `/${String(ORIGIN).toLowerCase()}`;
  if (best) {
    lines.push(`Best today: ${best.dest} at ${Number(best.allin).toFixed(2)} (${clockOf(best.dep)}), estimated all-in.`);
    const p = farePercentile(state, best.dest, best.allin, now);
    if (p) {
      lines.push(
        `Cheapest ${best.dest} fare seen in ${p.windowDays} days: seen ${p.n} times, and this one sits at the bottom of that range.`,
      );
    }
    clickPath = `/${String(ORIGIN).toLowerCase()}?focus=${encodeURIComponent(`${best.date}|${best.dest}|${best.dep}`)}`;
  } else {
    const why = todays[0] && todays[0].status && todays[0].status !== 'ok' ? todays[0].status : 'no GoWild under $50';
    lines.push(`Nothing bookable from ${ORIGIN} today: ${why}.`);
  }

  const sweep = state && state.lastSweep;
  if (sweep && Number(sweep.routes) > 0) {
    lines.push(`${sweep.routes} routes re-checked${sweep.at ? ` at ${easternStamp(sweep.at).slice(11, 16)} ET` : ''}.`);
  }

  return {
    kind: 'briefing',
    tier: 'briefing',
    title: `GoWild briefing: ${today}`,
    message: lines.join('\n'),
    priority: 'default',
    clickPath,
    stamp,
    ceiling: MAX_ALL_IN,
    settings: settings || null,
  };
}
