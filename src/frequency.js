// "RDU -> CUN: opened on 6 of 8 Mondays"
// Denominator is the number of that weekday we actually swept, so the number
// can never be flattered by weeks we never looked at.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayIndex(dateISO) {
  // noon UTC avoids any DST / midnight edge on the host clock
  return new Date(`${dateISO}T12:00:00Z`).getUTCDay();
}

export function routeFrequency(state, dest) {
  // A brand-new KV namespace holds no state at all, and the page must still
  // render its "no data yet" banner instead of throwing a 500.
  const src = state || {};
  const observed = src.observed || {};
  const days = src.days || {};
  const byWeekday = WEEKDAYS.map((name) => ({ name, of: 0, opened: 0 }));

  for (const date of Object.keys(observed)) {
    const wd = weekdayIndex(date);
    byWeekday[wd].of += 1;
    if (days[`${dest}|${date}`]) byWeekday[wd].opened += 1;
  }
  return byWeekday;
}

// The most-observed weekday for a route, which is the only one worth quoting.
export function headlineFrequency(state, dest) {
  const rows = routeFrequency(state, dest).filter((w) => w.of > 0);
  if (!rows.length) return null;
  rows.sort((a, b) => b.of - a.of || b.opened - a.opened);
  return rows[0];
}

export function frequencyTable(state, routes) {
  return routes
    .map((r) => {
      const head = headlineFrequency(state, r.code);
      return head ? { dest: r.code, city: r.city, weekday: head.name, opened: head.opened, of: head.of } : null;
    })
    .filter(Boolean);
}
