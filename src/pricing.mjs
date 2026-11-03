// What actually drives a GoWild fare?
//
// Frontier publishes no fare rules and no release schedule, so every answer here
// has to be measured forward and stated with its sample count. Three questions:
//
//   1. WHEN does a flight flip from its standard fare into a GoWild fare?
//   2. WHY — does it track particular flight numbers, or any under-sold flight?
//   3. WHAT does the fare correlate with: departure hour, weekday, standard fare?
//
// The collector records every itinerary it sees, GoWild or not, into `fares`.
// That is the raw material, and it is the whole reason this module exists:
// `history` stores only rows that ALREADY qualify, so it can never show the
// moment of the flip, because the pre-flip state is invisible to it.
//
// Two honesty rules:
//   - a percentage is never shown without its denominator;
//   - below MIN_SAMPLES observations a cell is reported "unproven", not "0%".

export const MIN_SAMPLES = 3;

// 21 days covers the two-week planning horizon with a week of slack, and keeps
// the KV value small enough to write every 15 minutes without ceremony.
const MAX_DAYS = 21;
const MAX_INSTANCES = 8000;

function parseKey(key) {
  const parts = String(key).split('|');
  if (parts.length < 4) return null;
  const [date, dest, dep, id] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !dep) return null;
  return { date, dest, dep, id: id === '?' ? null : id };
}

// `dep` is already a New York wall-clock string ("2026-11-03 06:30:00"), so the
// hour is a substring. No Date parsing, no timezone trap.
function depHour(dep) {
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):/.exec(String(dep));
  return m ? Number(m[1]) % 24 : null;
}

function weekdayIndex(dateISO) {
  return new Date(`${dateISO}T12:00:00Z`).getUTCDay();
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function median(nums) {
  const s = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid])) / 2;
}

// A flight instance is one (date, dest, departure). Identity prefers the flight
// number so "is this the same flight that always gets GoWild?" is answerable; if
// the payload does not carry one, identity falls back to the departure time and
// every report says so rather than pretending the stronger claim.
function identityOf(f) {
  const candidate = f.flt ?? f.flightNumber ?? null;
  return candidate ? String(candidate) : null;
}

export function recordFares(state, flights, ts = Date.now()) {
  if (!state || typeof state !== 'object' || !Array.isArray(flights)) return { tracked: 0, created: 0 };
  if (!state.fares || typeof state.fares !== 'object') state.fares = {};
  let created = 0;

  for (const f of flights) {
    if (!f || typeof f !== 'object') continue;
    if (!f.date || !f.dest || !f.dep) continue;
    const key = `${f.date}|${f.dest}|${f.dep}|${identityOf(f) || '?'}`;
    let rec = state.fares[key];
    if (!rec || typeof rec !== 'object') {
      rec = { n: 0, gw: 0, first: ts, firstGw: 0, stdMin: null, stdMax: null, gwMin: null, gwMax: null, last: ts, seats: null };
      state.fares[key] = rec;
      created += 1;
    }
    rec.n = (Number(rec.n) || 0) + 1;
    rec.last = ts;

    const std = typeof f.std === 'number' && f.std > 0 ? f.std : null;
    if (std !== null) {
      rec.stdMin = rec.stdMin === null || rec.stdMin === undefined ? std : Math.min(rec.stdMin, std);
      rec.stdMax = rec.stdMax === null || rec.stdMax === undefined ? std : Math.max(rec.stdMax, std);
    }

    const priced = f.goWild && typeof f.allin === 'number' && f.allin > 0;
    if (priced) {
      rec.gw = (Number(rec.gw) || 0) + 1;
      if (!rec.firstGw) rec.firstGw = ts;
      rec.gwMin = rec.gwMin === null || rec.gwMin === undefined ? f.allin : Math.min(rec.gwMin, f.allin);
      rec.gwMax = rec.gwMax === null || rec.gwMax === undefined ? f.allin : Math.max(rec.gwMax, f.allin);
      if (typeof f.seats === 'number') rec.seats = f.seats;
    }
  }

  pruneFares(state);
  return { tracked: Object.keys(state.fares).length, created };
}

// Bounded by departure date, not by insertion time: the point of the map is a
// moving two-week window, and an early-swept far-future date should not evict a
// recent one just because it was inserted later.
function pruneFares(state) {
  const fares = state && state.fares;
  if (!fares || typeof fares !== 'object') return;
  const keys = Object.keys(fares);
  if (!keys.length) return;

  const dates = keys.map((k) => String(k).split('|')[0]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (dates.length) {
    const newest = new Date(`${dates[dates.length - 1]}T12:00:00Z`).getTime();
    const cutoff = new Date(newest - MAX_DAYS * 86400000).toISOString().slice(0, 10);
    for (const k of keys) {
      if (String(k).split('|')[0] < cutoff) delete fares[k];
    }
  }

  const left = Object.keys(fares);
  if (left.length > MAX_INSTANCES) {
    // Keep the instances seen most recently; oldest observations are the least
    // useful for a forward-looking model.
    const ranked = left.sort((a, b) => (Number(fares[b].last) || 0) - (Number(fares[a].last) || 0));
    for (const k of ranked.slice(MAX_INSTANCES)) delete fares[k];
  }
}

// Everything the board needs to answer "how does this thing behave", with the
// sample count attached to every number.
export function fareMechanics(state) {
  const fares = (state && state.fares) || {};
  const keys = Object.keys(fares).filter((k) => fares[k] && typeof fares[k] === 'object');
  const rows = keys.map((k) => ({ key: k, ...parseKey(k), rec: fares[k] })).filter((r) => r.date && r.dep);

  const instances = rows.length;
  const withGoWild = rows.filter((r) => Number(r.rec.gw) > 0);
  // We watched it while it still carried only a standard fare, then watched it
  // become GoWild. That transition is the only direct evidence of a release.
  const sawPreFlip = rows.filter((r) => Number(r.rec.gw) > 0 && r.rec.firstGw && r.rec.first && Number(r.rec.first) < Number(r.rec.firstGw));
  const gonWildFirstSight = rows.filter((r) => Number(r.rec.gw) > 0 && Number(r.rec.firstGw) === Number(r.rec.first));

  const leadHours = [];
  const flipHours = [];
  for (const r of sawPreFlip) {
    const depMs = departureMs(r.dep);
    const flipMs = Number(r.rec.firstGw);
    if (Number.isFinite(depMs) && Number.isFinite(flipMs)) {
      const lead = Math.round((depMs - flipMs) / 3600000);
      if (lead >= 0) leadHours.push(lead);
    }
    const h = new Date(Number(r.rec.firstGw));
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(h)) % 24;
    if (Number.isFinite(hour)) flipHours.push(hour);
  }

  // Does GoWild follow the flight, or the day's load? If identity is stable the
  // same flight shows GoWild on most days it operates; if it tracks under-sales,
  // any given flight is GoWild on an arbitrary subset.
  const byIdentity = new Map();
  const identityKnown = rows.some((r) => r.id);
  for (const r of rows) {
    const id = r.id || `dep ${String(r.dep).slice(11, 16)}`;
    const slot = `${r.dest}|${id}`;
    if (!byIdentity.has(slot)) byIdentity.set(slot, { dest: r.dest, id, days: 0, gwDays: 0 });
    const b = byIdentity.get(slot);
    b.days += 1;
    if (Number(r.rec.gw) > 0) b.gwDays += 1;
  }
  const identities = [...byIdentity.values()]
    .filter((b) => b.days >= MIN_SAMPLES)
    .map((b) => ({
      ...b,
      share: b.gwDays / b.days,
      verdict: b.gwDays === b.days ? 'always' : b.gwDays === 0 ? 'never' : 'sometimes',
    }))
    .sort((a, b) => b.days - a.days || a.dest.localeCompare(b.dest));

  // Departure-hour profile: the "what time of day is GoWild cheapest" question.
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, instances: 0, gw: 0, fares: [] }));
  for (const r of rows) {
    const h = depHour(r.dep);
    if (h === null) continue;
    byHour[h].instances += 1;
    if (Number(r.rec.gw) > 0) {
      byHour[h].gw += 1;
      if (typeof r.rec.gwMin === 'number') byHour[h].fares.push(r.rec.gwMin);
    }
  }

  const byWeekday = WEEKDAYS.map((name) => ({ name, instances: 0, gw: 0 }));
  for (const r of rows) {
    const wd = weekdayIndex(r.date);
    if (!Number.isFinite(wd)) continue;
    byWeekday[wd].instances += 1;
    if (Number(r.rec.gw) > 0) byWeekday[wd].gw += 1;
  }

  // The "is it a discount ladder off the standard fare" question: compare the
  // standard fare on instances that went GoWild with those that did not.
  const stdGw = withGoWild.map((r) => r.rec.stdMin).filter((n) => typeof n === 'number');
  const stdNo = rows.filter((r) => !Number(r.rec.gw)).map((r) => r.rec.stdMin).filter((n) => typeof n === 'number');
  const ratios = withGoWild
    .filter((r) => typeof r.rec.stdMin === 'number' && typeof r.rec.gwMin === 'number' && r.rec.stdMin > 0)
    .map((r) => r.rec.gwMin / r.rec.stdMin);

  const soldOutLike = withGoWild.filter((r) => r.rec.seats === 0).length;
  const knownSeats = withGoWild.filter((r) => typeof r.rec.seats === 'number').length;

  return {
    instances,
    withGoWild: withGoWild.length,
    gwShare: instances ? withGoWild.length / instances : null,
    preFlipObserved: sawPreFlip.length,
    gonWildAtFirstSight: gonWildFirstSight.length,
    medianLeadHours: median(leadHours),
    medianFlipHour: median(flipHours),
    leadSamples: leadHours.length,
    identities,
    identityKnown,
    byHour,
    byWeekday,
    std: {
      gwMedian: median(stdGw),
      noGwMedian: median(stdNo),
      gwSamples: stdGw.length,
      noGwSamples: stdNo.length,
      fareRatioMedian: ratios.length ? Math.round(median(ratios.map((x) => x * 100))) / 100 : null,
      ratioSamples: ratios.length,
    },
    seats: { soldOut: soldOutLike, known: knownSeats, samples: withGoWild.length },
    confident: sawPreFlip.length >= MIN_SAMPLES,
  };
}

// Local wall-clock departure to epoch ms, using the same no-library approach as
// timing.mjs: probe the zone offset for that date and apply it.
export function departureMs(dep) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(dep || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(probe);
  const localNoon = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const offset = 12 - localNoon;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) + offset * 3600000;
}
