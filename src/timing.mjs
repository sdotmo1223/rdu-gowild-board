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
//
// 3 was a floor against absurdity, not evidence of a pattern: a median hour from
// three sightings is one refused connection away from being a different hour, and
// the page was printing "seats open around 14:00" off exactly that. Ten is the
// point where a median stops being an anecdote -- an 80% interval on a median of
// ten sightings is roughly +/-2 hours, which is the coarsest claim worth printing.
// Below it the page states the count and how many more it needs, and names no time.

const MIN_SAMPLES = 10;

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

// A first sighting at the very first moment we ever looked at that date is not a
// release time: it is our own cron. Measured on the live snapshot 2026-11-06, every
// route reported "seats open around 4 AM local" -- exactly the hour the collector
// happened to start, which is a confident-looking falsehood. So a sighting within a
// few minutes of the first sweep that asked about that date is recorded as censored
// and excluded from the hour and lead medians. It is still counted as a sighting.
const CENSOR_SLACK_MS = 5 * 60 * 1000;

function firstAskedByDate(state) {
  const map = new Map();
  const note = (date, at) => {
    if (!date || !Number.isFinite(at)) return;
    const cur = map.get(date);
    if (cur === undefined || at < cur) map.set(date, at);
  };
  for (const s of (state && state.sweeps) || []) {
    if (s && typeof s === 'object') note(s.date, Number(s.at));
  }
  // A probe deliberately does not write `sweeps`, so its dates would otherwise look
  // uncensored even though the probe was the first (and only) look at them.
  const probe = state && state.leadProbe;
  if (probe && Number.isFinite(Number(probe.at)) && Array.isArray(probe.dates)) {
    for (const d of probe.dates) note(d, Number(probe.at));
  }
  return map;
}

export function releaseTiming(state) {
  const map = firstSeenMap(state);
  const asked = firstAskedByDate(state);
  const byDest = new Map();

  for (const [key, ts] of map) {
    const [date, dest, dep] = key.split('|');
    const hour = localHour(ts);
    if (hour === null) continue;
    if (!byDest.has(dest)) byDest.set(dest, { hours: [], leads: [], censored: 0 });
    const bucket = byDest.get(dest);

    const firstLook = asked.get(date);
    if (firstLook !== undefined && ts <= firstLook + CENSOR_SLACK_MS) {
      bucket.censored += 1;
      continue;
    }

    const depMs = departureUtcMs(dep);
    const lead = depMs === null ? null : Math.round((depMs - ts) / 3600000);
    bucket.hours.push(hour);
    if (lead !== null && lead >= 0) bucket.leads.push(lead);
  }

  return [...byDest.entries()]
    .map(([dest, b]) => ({
      dest,
      // samples = usable (a release moment was actually observed); seen = every
      // sighting including the censored ones, so the reader sees the real progress.
      samples: b.hours.length,
      censored: b.censored,
      seen: b.hours.length + b.censored,
      medianHour: median(b.hours),
      medianLead: median(b.leads),
      confident: b.hours.length >= MIN_SAMPLES,
      // How many more timed sightings before this route may name a time. Rendered so
      // the reader can watch it climb instead of wondering why the row is quiet.
      needed: Math.max(0, MIN_SAMPLES - b.hours.length),
    }))
    .sort((a, b) => a.dest.localeCompare(b.dest));
}

export { MIN_SAMPLES, CENSOR_SLACK_MS, departureUtcMs, etOffsetHours };
