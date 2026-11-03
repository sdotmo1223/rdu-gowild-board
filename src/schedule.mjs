// Weekly schedule recorder.
//
// Frontier does not publish a schedule API, and past release times cannot be
// scraped — the data simply does not exist publicly. So the only way to learn
// whether each route runs on a fixed weekly pattern (or rotates week to week) is
// to observe it forward and compare the same weekday across weeks.
//
// This costs ZERO extra requests. The collector already sweeps today and
// tomorrow; recording what it saw per date is free. After 14 daily sweeps every
// weekday has been observed twice, which is the minimum needed for a
// week-over-week verdict.
//
// One rule matters more than the maths: a route only counts as "not operating"
// when the request SUCCEEDED and returned no flights. A blocked or throttled
// request is an absence of evidence, and recording it as "doesn't fly" would
// corrupt the pattern permanently.

import { ROUTES } from './routes.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MAX_DATES = 28;

function weekdayIndex(dateISO) {
  return new Date(`${dateISO}T12:00:00Z`).getUTCDay();
}

// Monday-based week bucket, so Sunday pairs with the week that contains it.
export function weekKey(dateISO) {
  const d = new Date(`${dateISO}T12:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export function recordSchedule(state, dateISO, sweeps, now = Date.now()) {
  if (!state || !dateISO) return;
  state.schedule = state.schedule || {};
  const day = (state.schedule[dateISO] = state.schedule[dateISO] || {});

  for (const s of sweeps || []) {
    if (!s || !s.dest || s.date !== dateISO) continue;
    if (!s.ok) {
      // Learned nothing. Keep any earlier observation, mark the attempt only.
      const prev = day[s.dest] || {};
      day[s.dest] = { ...prev, lastAttemptAt: now, lastAttemptOk: false };
      continue;
    }
    const flights = Array.isArray(s.flights) ? s.flights.length : 0;
    const goWild = (Array.isArray(s.flights) ? s.flights : []).filter((f) => f && f.goWild).length;
    day[s.dest] = { ok: true, operates: flights > 0, flights, goWild, seenAt: now, lastAttemptOk: true };
  }

  const keys = Object.keys(state.schedule).sort();
  if (keys.length > MAX_DATES) {
    for (const k of keys.slice(0, keys.length - MAX_DATES)) delete state.schedule[k];
  }
}

// Per route: seven cells, each holding every swept instance of that weekday.
// verdict is per weekday; the route-level verdict only claims 'stable' when
// every sampled weekday looked the same across the weeks we saw.
export function weeklyPattern(state, routes = ROUTES) {
  const schedule = (state && state.schedule) || {};
  const dates = Object.keys(schedule).sort();
  const weeks = [...new Set(dates.map(weekKey))];

  const rows = routes.map((r) => {
    const cells = WEEKDAYS.map((name, i) => {
      const hits = dates
        .filter((d) => weekdayIndex(d) === i && schedule[d] && schedule[d][r.code] && schedule[d][r.code].ok)
        .map((d) => ({ date: d, week: weekKey(d), operates: Boolean(schedule[d][r.code].operates) }));
      const values = new Set(hits.map((h) => h.operates));
      const verdict =
        hits.length === 0 ? 'unknown' : hits.length === 1 ? 'sampled' : values.size === 1 ? 'consistent' : 'rotating';
      return {
        name,
        of: hits.length,
        operates: hits.filter((h) => h.operates).length,
        weeks: [...new Set(hits.map((h) => h.week))].length,
        verdict,
      };
    });

    const sampled = cells.filter((c) => c.of > 0);
    const verdict = !sampled.length
      ? 'unknown'
      : sampled.some((c) => c.verdict === 'rotating')
        ? 'rotating'
        : sampled.every((c) => c.verdict === 'consistent')
          ? 'stable'
          : 'sampled';

    return { dest: r.code, city: r.city, cells, verdict };
  });

  return { dates: dates.length, weeks: weeks.length, rows };
}
