// Pure parser for the Frontier Select page. Shared by the collector and tests.
// The payload is a JSON blob embedded in the HTML, so we locate "journeys" and
// extract the balanced array rather than regex-matching the whole document.

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function extractJourneys(html) {
  const label = html.indexOf('"journeys"');
  if (label === -1) return null;
  const start = html.indexOf('[', label);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// goWildFareSeatsRemaining is either null or a string like "3 Seats Left!".
// It is never a plain number, so naive rendering would show "undefined".
export function normalizeSeats(value) {
  // 0 is a fact (sold out) and must survive; only negatives and jokes are nulled.
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const m = value.match(/\d+/);
    if (m) return Number(m[0]);
  }
  return null;
}

export function normalizeFlight(f, dateISO, dest, city) {
  const legs = f.legs || [];
  const first = legs[0] || {};
  const last = legs[legs.length - 1] || first;
  const fare = typeof f.goWildFare === 'number' ? f.goWildFare : -1;
  const goWild = Boolean(f.isGoWildFareEnabled) && fare > 0;
  const stopText = f.stopsText || (f.stopCount === 0 ? 'Nonstop' : `${f.stopCount} Stops`);

  return {
    date: dateISO,
    dest,
    city,
    dep: first.departureDate || null,
    arr: last.arrivalDate || null,
    stops: stopText,
    nonstop: /^nonstop$/i.test(stopText.trim()),
    dur: f.duration || null,
    seats: normalizeSeats(f.goWildFareSeatsRemaining),
    // goWildFare is the full GoWild price. There is no tax or fee field anywhere
    // in the payload, so the UI labels this "estimated all-in".
    allin: goWild ? round2(fare) : null,
    std: typeof f.standardFare === 'number' && f.standardFare > 0 ? round2(f.standardFare) : null,
    goWild,
  };
}

// Why did a whole sweep fail? The distinct signatures matter because they need
// different human responses: a blocked sweep means wait, a 404-everywhere sweep
// means the session cookie expired and the user must replace it.
export function classifyFailure(sweeps) {
  if (!Array.isArray(sweeps) || !sweeps.length) return 'error';
  const ok = sweeps.filter((s) => s.ok).length;
  if (ok > 0) return null;
  const blocked = sweeps.filter((s) => s.blocked).length;
  if (blocked === sweeps.length) return 'blocked';
  const notFound = sweeps.filter((s) => s.reason === 'not-found').length;
  if (notFound === sweeps.length) return 'auth';
  if (notFound > sweeps.length / 2) return 'auth';
  return 'error';
}

// Any refused route ends the sweep. Measured 2026-11-02: once Frontier starts
// answering without a journeys array, every following request in the same burst
// is refused too — 28 requests produced 14 refusals in a row. Continuing spends
// the remaining budget and deepens the throttle for nothing, so one refusal is
// treated as the end of the sweep rather than as a single unlucky route.
export function shouldAbortSweep(result) {
  return Boolean(result) && result.ok === false;
}

// Decide what gets written when only part of a sweep produced usable data.
// A date where every route failed keeps its previous rows instead of being
// erased; a date with at least one usable payload is fully replaced. This is the
// routine path, not an edge case: the burst throttle commonly kills the second
// half of a sweep.
export function mergeSweeps(prevSweeps, sweeps, dates) {
  const prev = Array.isArray(prevSweeps) ? prevSweeps : [];
  const fresh = Array.isArray(sweeps) ? sweeps : [];
  const deadDates = (dates || []).filter((d) => !fresh.some((s) => s && s.date === d && s.ok));

  let merged = fresh.slice();
  const kept = [];
  for (const d of deadDates) {
    const rows = prev.filter((s) => s && s.date === d);
    if (!rows.length) continue;
    merged = merged.filter((s) => s.date !== d).concat(rows);
    kept.push({ date: d, rows: rows.length });
  }
  return { sweeps: merged, deadDates, kept };
}

export function parseRoute(response, dateISO, dest, city) {
  const { status, url, text } = response;
  const blocked = /\/Flight\/Redirect/.test(url || '') || status === 403 || status === 429;

  // A missing session bounces InternalSelect to the www host, which has no such
  // path and answers 404. Calling that a "block" hid the real cause for a whole
  // sweep, so it gets its own reason and its own banner.
  if (status === 404) return { ok: false, blocked: false, flights: [], reason: 'not-found' };

  const journeys = extractJourneys(text || '');

  if (blocked || journeys === null) {
    return { ok: false, blocked, flights: [], reason: blocked ? 'datadome-redirect' : 'no-journeys-key' };
  }
  if (journeys === undefined) {
    return { ok: false, blocked: false, flights: [], reason: 'unparseable-journeys' };
  }

  const flights = [];
  for (const j of journeys) for (const f of j.flights || []) flights.push(normalizeFlight(f, dateISO, dest, city));
  // journeys=1 with flights=0 is a normal "does not operate this day" answer.
  return { ok: true, blocked: false, flights, reason: flights.length ? 'ok' : 'no-flights' };
}
