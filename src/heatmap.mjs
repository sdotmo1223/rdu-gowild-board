// Bookability grid.
//
// Two axes, because the date axis is useless on day one and the weekday axis is
// not: a 14-day history grid shows "last 2 days" for a fortnight, while the
// weekday rollup answers the planning question immediately — "is Orlando ever
// bookable on a Monday?" — and gets sharper with every sweep.
//
// This is history, not a forecast. A forward 7-day grid would need 98 requests per
// sweep instead of 28, tripling the load on Frontier for data GoWild cannot even
// populate yet (seats open the day before departure).

import { ROUTES } from './routes.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayIndex(dateISO) {
  // noon UTC avoids any DST / midnight edge on the host clock
  return new Date(`${dateISO}T12:00:00Z`).getUTCDay();
}

export function bookabilityHeatmap(state, maxDates = 14) {
  const observed = Object.keys((state && state.observed) || {}).sort();
  const dates = observed.slice(-maxDates);
  const days = (state && state.days) || {};

  const routes = ROUTES.map((r) => ({
    dest: r.code,
    city: r.city,
    cells: dates.map((d) => (days[`${r.code}|${d}`] ? 1 : 0)),
    hits: dates.reduce((n, d) => n + (days[`${r.code}|${d}`] ? 1 : 0), 0),
  }));

  // Weekday rollup: for each route and weekday, how many swept dates produced a
  // sub-$50 GoWild itinerary. Denominator is dates actually observed, so a route
  // is never credited for a day nobody looked at.
  const weekday = ROUTES.map((r) => ({
    dest: r.code,
    city: r.city,
    days: WEEKDAYS.map((name) => ({ name, of: 0, opened: 0 })),
  }));
  const byDest = new Map(weekday.map((w) => [w.dest, w]));

  for (const date of observed) {
    const wd = weekdayIndex(date);
    for (const r of ROUTES) {
      const bucket = byDest.get(r.code).days[wd];
      bucket.of += 1;
      if (days[`${r.code}|${date}`]) bucket.opened += 1;
    }
  }

  return { dates, routes, weekday, observedCount: observed.length };
}
