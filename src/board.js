import { isBlackout, PEAK_LABEL, MAX_ALL_IN, MAX_STOPS, MAX_DURATION_MIN } from './routes.js';

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

  for (const date of dateKeys) {
    const forDate = sweeps.filter((s) => s.date === date);
    // Only every route blocked counts as blocked; one blocked route among 13
    // quiet ones is not the same thing.
    const blocked = forDate.length > 0 && forDate.every((s) => s.blocked);
    const failed = forDate.filter((s) => !s.ok);
    const flights = forDate
      .flatMap((s) => (Array.isArray(s.flights) ? s.flights : []))
      .filter((f) => f && typeof f === 'object');
    const goWild = flights.filter((f) => f.goWild && typeof f.allin === 'number' && f.allin > 0);
    const priced = goWild.filter((f) => f.allin <= MAX_ALL_IN);
    const qualified = priced.filter(withinLimits).sort(rank);
    const folded = priced.filter((f) => !withinLimits(f)).sort(rank);

    // Frontier never announces a blackout; it just inflates the GoWild fare
    // (observed $317.96 on 2026-11-24 vs $15.41 normally). Trust the calendar,
    // and use price as a secondary signal in case the calendar drifts.
    const peak = isBlackout(date) || goWild.some((f) => f.allin >= 200);

    let status;
    if (!flights.length && blocked) status = 'blocked';
    else if (!flights.length && failed.length) status = 'error';
    else if (!flights.length) status = peak ? 'peak' : 'noflights';
    else if (!qualified.length) status = peak ? 'peak' : priced.length ? 'folded' : goWild.length ? 'above' : 'nogowild';
    else status = 'ok';

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
      rows: qualified,
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
  };
}
