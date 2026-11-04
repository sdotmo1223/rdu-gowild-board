import { isBlackout, PEAK_LABEL, MAX_ALL_IN, MAX_STOPS, MAX_DURATION_MIN, easternStamp } from './routes.js';

// Measured, not assumed: GitHub throttles the */15 cron to roughly one run an
// hour, and the observed gaps reach 60 minutes. Setting the threshold AT the worst
// measured gap still paints a healthy board amber (ageMin rounds up), so the value
// is the worst gap plus a quarter hour of slack. Stale must mean "a run was
// missed", or the banner trains the reader to ignore it.
export const STALE_AFTER_MIN = 75;

// Frontier publishes no check-in deadline, so this is a planning number and the
// page labels it as one: two hours covers security at RDU plus the gate walk. It
// is never presented as a Frontier rule.
export const AIRPORT_BUFFER_MIN = 120;

// Wall-clock subtraction on the New York timestamp string, which is how the rest
// of this file already compares departures. The 02:00-03:00 DST hour is not
// treated specially: no departure in this dataset falls inside it, and parsing to
// epoch would need the zone offset a second time for no extra accuracy.
function minusMinutes(dep, mins) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(dep || ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - mins * 60000;
  const dt = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`;
}

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
    // Each bookable row carries the time you would have to leave for the airport,
    // so "is this actionable?" is answered on the row instead of in the reader's
    // head. `tight` means the buffer is already gone: still bookable, but only just.
    const decorate = (f) => {
      const leaveBy = minusMinutes(f.dep, AIRPORT_BUFFER_MIN);
      return { ...f, leaveBy, tight: leaveBy ? leaveBy <= stamp : false };
    };
    // Over-limit options are still real departures, so they get the same treatment:
    // one that has already gone must not sit under "show them anyway" looking
    // bookable, and one that is still ahead keeps its date on the board.
    const ahead = qualified.filter((f) => !f.dep || String(f.dep) >= stamp).map(decorate);
    const past = qualified.filter((f) => f.dep && String(f.dep) < stamp);
    const foldedAhead = folded.filter((f) => !f.dep || String(f.dep) >= stamp).map(decorate);
    const foldedPast = folded.filter((f) => f.dep && String(f.dep) < stamp);

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
    // Folded-before-departed on purpose: an over-limit option that has not left is
    // still a real answer for this date, so the date is not finished.
    else if (foldedAhead.length) status = 'folded';
    else if (past.length || foldedPast.length) status = 'departed';
    else if (peak) status = 'peak';
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
      folded: foldedAhead,
      foldedPastCount: foldedPast.length,
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
    // The top-level list is the same promise as the per-date one: bookable only.
    rows.push(...ahead);
  }

  // A date whose bookable departures have all left is no longer an answer to "what
  // can I fly". It leaves the rendered list but is reported once, so it never looks
  // like the day was lost or like the collector failed.
  const departedDates = dates.filter((d) => d.status === 'departed');
  const visibleDates = dates.filter((d) => d.status !== 'departed');

  const updatedAt = src.updatedAt || null;
  const ageMin = updatedAt ? Math.max(0, Math.round((now - updatedAt) / 60000)) : null;

  return {
    dates: visibleDates,
    departed: departedDates,
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
