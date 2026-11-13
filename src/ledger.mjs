// The route-day schedule ledger.
//
// Every sweep since 2026-11-03 has recorded what actually departed: date, destination
// and departure clock. That is a schedule nobody had to pay for -- it is already in
// state.history and state.firstSeen -- and it is the only way to answer "when does
// the return leg usually leave?" without asking Frontier about a date the board is
// not collecting.
//
// Post-processing only. This module never builds a request, never reads KV, and never
// looks at the network: it takes a snapshot and a clock and returns what has been
// observed. Two consequences worth stating out loud:
//   - a projection is a count first and a sentence second. `n: 1` is "single" and the
//     UI is expected to render it as such, not as a pattern;
//   - nothing is invented. A weekday with no observations projects to null, and the
//     caller must say nothing rather than guess a plausible time.
import { easternDate } from './routes.js';

export const LEDGER_WINDOW_DAYS = 14;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Six distinct dates is where a weekday time stops being a coincidence: with a
// 14-day window that is every occurrence of that weekday (two) plus the same time
// showing up on neighbouring days, so it is deliberately hard to reach.
export const ESTABLISHED_AT = 6;

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoAddDays(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  const t = Date.UTC(y, m - 1, d) + Number(days) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function dowOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

// A departure clock, or null. "garbage" must never become midnight: an unparseable
// time is a missing observation, not a 12:00 AM flight.
function clockOf(dep) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(dep == null ? '' : dep));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

export function confidenceFor(n) {
  const count = Number(n);
  if (!Number.isFinite(count) || count < 1) return null;
  if (count >= ESTABLISHED_AT) return 'established';
  if (count >= 2) return 'repeated';
  return 'single';
}

// The next date (strictly after `fromISO`) that falls on `dow`. "Next Wednesday"
// said on a Wednesday means the following week, because a schedule line is a plan
// for a flight that has not left yet.
export function nextDateForDow(dow, fromISO) {
  const want = Number(dow);
  if (!Number.isInteger(want) || want < 0 || want > 6) return null;
  let cursor = isoAddDays(fromISO, 1);
  for (let i = 0; i < 8; i += 1) {
    if (dowOf(cursor) === want) return cursor;
    cursor = isoAddDays(cursor, 1);
  }
  return null;
}

export function buildLedger(state, now = Date.now(), opts = {}) {
  const asked = Number(opts.windowDays);
  const windowDays = Number.isFinite(asked) && asked >= 1 ? Math.min(60, Math.round(asked)) : LEDGER_WINDOW_DAYS;
  const today = easternDate(0, now);
  const since = isoAddDays(today, -(windowDays - 1));
  const routes = {};
  const seen = new Set();

  const add = (dest, date, dep) => {
    const code = String(dest == null ? '' : dest).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
    // The window is measured on the date the flight departs, in the same civil
    // calendar the board uses. A future date still counts: it is a schedule fact.
    if (!since || date < since) return;
    const clock = clockOf(dep);
    if (!clock) return;
    const key = `${code}|${date}|${clock}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes[code] = routes[code] || { observations: 0, byDow: {} };
    const route = routes[code];
    const dow = dowOf(date);
    if (dow == null) return;
    route.observations += 1;
    const bucket = (route.byDow[dow] = route.byDow[dow] || []);
    let slot = bucket.find((t) => t.dep === clock);
    if (!slot) {
      slot = { dep: clock, weekday: WEEKDAYS[dow], dates: [], lastSeen: null };
      bucket.push(slot);
    }
    slot.dates.push(date);
    slot.lastSeen = Math.max(Number(slot.lastSeen) || 0, Date.parse(`${date}T23:59:59Z`) || 0);
  };

  const history = state && Array.isArray(state.history) ? state.history : [];
  for (const row of history) {
    if (!row || typeof row !== 'object') continue;
    add(row.dest, row.date, row.dep);
  }

  // firstSeen carries rows the digest gate never promoted into history, which is
  // most of the long tail. Key shape is `date|dest|dep`.
  const firstSeen = state && state.firstSeen && typeof state.firstSeen === 'object' ? state.firstSeen : {};
  for (const key of Object.keys(firstSeen)) {
    const parts = String(key).split('|');
    if (parts.length < 3) continue;
    add(parts[1], parts[0], parts[2]);
  }

  for (const route of Object.values(routes)) {
    for (const dow of Object.keys(route.byDow)) {
      route.byDow[dow].sort((a, b) => b.dates.length - a.dates.length || a.dep.localeCompare(b.dep));
      for (const slot of route.byDow[dow]) {
        slot.n = slot.dates.length;
        slot.dates.sort();
        slot.confidence = confidenceFor(slot.n);
      }
    }
  }

  return { windowDays, since, today, routes };
}

// One leg's projection: the most-observed departure time for that route on that
// weekday, with the evidence attached. Null when there is nothing to say.
export function projectLeg(ledger, dest, dow) {
  const code = String(dest == null ? '' : dest).trim().toUpperCase();
  const route = ledger && ledger.routes ? ledger.routes[code] : null;
  if (!route) return null;
  const bucket = route.byDow[String(Number(dow))];
  if (!Array.isArray(bucket) || !bucket.length) return null;
  const best = bucket[0];
  return {
    dest: code,
    dow: Number(dow),
    weekday: WEEKDAYS[Number(dow)] || best.weekday,
    dep: best.dep,
    n: best.n,
    dates: best.dates.slice(),
    confidence: best.confidence,
    // The honest restatement the UI can print verbatim.
    phrase: `${best.weekday} ${best.dep}, seen ${best.n} time${best.n === 1 ? '' : 's'} in the last ${ledger.windowDays} days`,
  };
}
