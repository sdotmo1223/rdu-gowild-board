import { isBlackout, PEAK_LABEL, MAX_ALL_IN, MAX_STOPS, MAX_DURATION_MIN, easternStamp } from './routes.js';

// Three missed 15-minute sweeps is a real fault, not jitter. Tighter than this
// would paint the board amber during one slow GitHub runner start; looser would
// let a dead cron look healthy for an hour.
export const STALE_AFTER_MIN = 45;

const byDep = (a, b) => String(a.dep).localeCompare(String(b.dep));

// Nonstops first, then departure time.
const rank = (a, b) => {
  if (a.nonstop !== b.nonstop) return a.nonstop ? -1 : 1;
  return byDep(a, b);
};

// Both "1 hrs 57 min" and "1 day(s) 5 hrs 26 min" occur in the payload.
function durationMinutes(dur) {
  if (!dur) return null;
  const d = /(\d+)\s*day/i.exec(dur);
  const h = /(\d+)\s*hrs?/i.exec(dur);
  const m = /(\d+)\s*min/i.exec(dur);
  if (!d && !h && !m) return null;
  return (d ? Number(d[1]) * 1440 : 0) + (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

function stopsOf(f) {
  if (f.nonstop) return 0;
  const m = /(\d+)\s*stop/i.exec(f.stops || '');
  return m ? Number(m[1]) : 0;
}

// A 20-hour connection is kept, just folded out of the way.
function withinLimits(f) {
  if (stopsOf(f) > MAX_STOPS) return false;
  const durMin = durationMinutes(f.dur);
  if (durMin !== null && durMin > MAX_DURATION_MIN) return false;
  return true;
}

export function buildBoard(state, now = Date.now()) {
  const src = state || {};
  // Half-written or hostile state must degrade, not throw: the collector writes
  // this blob and the Worker has to render something even if it is malformed.
  const sweeps = Array.isArray(src.sweeps) ? src.sweeps.filter((s) => s && typeof s === 'object') : [];
  const dateKeys = [...new Set(sweeps.map((s) => s.date).filter(Boolean))].sort();
  const dates = [];
  const rows = [];
  // One clock reading for the whole build, so a row cannot be judged ahead on one
  // date and departed on the next.
  const stamp = easternStamp(now);

  for (const date of dateKeys) {
    const forDate = sweeps.filter((s) => s.date === date);
    // Only every route blocked counts as blocked; one blocked route among 13
    // quiet ones is not the same thing.
    const blocked = forDate.length > 0 && forDate.every((s) => s.blocked);
    const failed = forDate.filter((s) => !s.ok);
    // A rotating sweep re-checks half the routes per tick and carries the rest.
    // Carried rows are real fares, but their age is not the board's age, so the
    // page has to be able to say so instead of implying a fresh check.
    const carriedRows = forDate.filter((s) => s.carried);
    const carriedStamps = carriedRows
      .map((s) => Number(s.carriedAt))
      .filter((n) => Number.isFinite(n) && n > 0);
    const carriedAt = carriedStamps.length ? Math.min(...carriedStamps) : null;
    const carriedReason = carriedRows.length
      ? carriedRows.some((s) => s.carriedReason === 'day-over')
        ? 'day-over'
        : carriedRows.some((s) => s.carriedReason === 'rotated')
          ? 'rotated'
          : 'aborted'
      : null;
    const flights = forDate
      .flatMap((s) => (Array.isArray(s.flights) ? s.flights : []))
      .filter((f) => f && typeof f === 'object');
    const goWild = flights.filter((f) => f.goWild && typeof f.allin === 'number' && f.allin > 0);
    const priced = goWild.filter((f) => f.allin <= MAX_ALL_IN);
    const qualified = priced.filter(withinLimits).sort(rank);
    const folded = priced.filter((f) => !withinLimits(f)).sort(rank);
    // A departure that has already left cannot be booked, so it must not sit in the
    // list looking like an option. It is kept and counted, never deleted: "everything
    // shown is actionable" is only honest if the departed ones are stated out loud.
    // A missing departure time is kept, because an unknown is not a gone one.
    const ahead = qualified.filter((f) => !f.dep || String(f.dep) >= stamp);
    const past = qualified.filter((f) => f.dep && String(f.dep) < stamp);

    // Frontier never announces a blackout; it just inflates the GoWild fare
    // (observed $317.96 on 2026-11-24 vs $15.41 normally). Trust the calendar,
    // and use price as a secondary signal in case the calendar drifts.
    const peak = isBlackout(date) || goWild.some((f) => f.allin >= 200);

    let status;
    if (!flights.length && blocked) status = 'blocked';
    else if (!flights.length && failed.length) status = 'error';
    else if (!flights.length) status = peak ? 'peak' : 'noflights';
    else if (ahead.length) status = 'ok';
    // Every bookable option already left. Saying that is the difference between a
    // quiet board and a board that looks empty because something broke.
    else if (past.length) status = 'departed';
    else if (peak) status = 'peak';
    else if (priced.length) status = 'folded';
    else if (goWild.length) status = 'above';
    else status = 'nogowild';

    dates.push({
      date,
      blackout: isBlackout(date),
      peak,
      peakLabel: PEAK_LABEL,
      status,
      total: flights.length,
      goWild: goWild.length,
      // lowest GoWild fare seen at all, including ones above the $50 ceiling
      lowest: goWild.length ? Math.min(...goWild.map((f) => f.allin)) : null,
      above: goWild.length - priced.length,
      folded,
      blockedRoutes: forDate.filter((s) => s.blocked).length,
      failedRoutes: failed.length,
      routesScanned: forDate.length,
      freshRoutes: forDate.length - carriedRows.length,
      carriedRoutes: carriedRows.length,
      carriedAt,
      carriedReason,
      // `rows` is exactly what the page offers: departures that can still be booked.
      // Anything already gone is in `past`, counted by `pastCount`, never listed.
      rows: ahead,
      past,
      pastCount: past.length,
    });
    rows.push(...qualified);
  }

  const updatedAt = src.updatedAt || null;
  const ageMin = updatedAt ? Math.max(0, Math.round((now - updatedAt) / 60000)) : null;

  return {
    dates,
    rows,
    updatedAt,
    ageMin,
    stale: ageMin === null || ageMin > STALE_AFTER_MIN,
    error: src.lastError || null,
    routeCount: src.routeCount || 0,
    zero: src.zero && typeof src.zero === 'object' ? src.zero : null,
    sweep: src.lastSweep && typeof src.lastSweep === 'object' ? src.lastSweep : null,
  };
}
