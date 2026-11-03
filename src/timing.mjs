// When do GoWild seats actually appear, and how far ahead of departure?
//
// Nobody publishes Frontier's release schedule, so it cannot be scraped from
// history: it has to be observed forward. Every sweep records the first instant a
// (date, dest, dep) itinerary became visible; those observations become the model.
//
// Two signals are produced per route:
//   medianHour  — local clock time the seats showed up
//   medianLead  — hours between first sighting and scheduled departure
//
// Deliberately shy: under MIN_SAMPLES observations a route is flagged unproven
// rather than dressed up as a pattern. One sweep is not a trend.

const MIN_SAMPLES = 3;

function localHour(ts) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  const h = Number(fmt.format(new Date(ts)));
  return Number.isFinite(h) ? h % 24 : null;
}

// Returns 4 (EDT) or 5 (EST) for a given calendar date, without a tz library.
function etOffsetHours(dateISO) {
  const probe = new Date(`${dateISO}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(probe);
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  return 12 - h;
}

// "2026-11-03 06:30:00" is a New York wall-clock time.
function departureUtcMs(dep) {
  const m = String(dep || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const offset = etOffsetHours(`${y}-${mo}-${d}`);
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) + offset * 3600000;
}

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Prefers the durable firstSeen map; falls back to history for older snapshots.
export function firstSeenMap(state) {
  const map = new Map();
  const fs = (state && state.firstSeen) || {};
  for (const [k, ts] of Object.entries(fs)) {
    if (!k.includes('|') || !Number.isFinite(ts)) continue;
    map.set(k, ts);
  }
  for (const h of ((state && state.history) || [])) {
    if (!h || !h.ts || !h.dest || !h.date) continue;
    // `dep` can be absent in older snapshots. The observation still counts toward
    // the clock-time model; it simply cannot contribute a lead time.
    const k = `${h.date}|${h.dest}|${h.dep || ''}`;
    const cur = map.get(k);
    if (cur === undefined || h.ts < cur) map.set(k, h.ts);
  }
  return map;
}

export function releaseTiming(state) {
  const map = firstSeenMap(state);
  const byDest = new Map();

  for (const [key, ts] of map) {
    const [date, dest, dep] = key.split('|');
    const hour = localHour(ts);
    if (hour === null) continue;
    const depMs = departureUtcMs(dep);
    const lead = depMs === null ? null : Math.round((depMs - ts) / 3600000);

    if (!byDest.has(dest)) byDest.set(dest, { hours: [], leads: [] });
    const bucket = byDest.get(dest);
    bucket.hours.push(hour);
    if (lead !== null && lead >= 0) bucket.leads.push(lead);
  }

  return [...byDest.entries()]
    .map(([dest, b]) => ({
      dest,
      samples: b.hours.length,
      medianHour: median(b.hours),
      medianLead: median(b.leads),
      confident: b.hours.length >= MIN_SAMPLES,
    }))
    .sort((a, b) => a.dest.localeCompare(b.dest));
}

export { MIN_SAMPLES, departureUtcMs, etOffsetHours };
