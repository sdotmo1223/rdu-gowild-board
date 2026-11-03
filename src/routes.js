// The 14 current nonstop Frontier routes from RDU.
// Verified 2026-11-03 against FlightConnections (updated 2026-11-02) and RDU's
// own nonstop table. The "32 destinations" figure circulating online is from
// ABC11, 2019-05-01, and is stale. BUF is announced but not yet operating.
export const ROUTES = [
  { code: 'ATL', city: 'Atlanta', intl: false },
  { code: 'BOS', city: 'Boston', intl: false },
  { code: 'CLE', city: 'Cleveland', intl: false },
  { code: 'CUN', city: 'Cancun', intl: true },
  { code: 'DEN', city: 'Denver', intl: false },
  { code: 'DFW', city: 'Dallas/Fort Worth', intl: false },
  { code: 'DTW', city: 'Detroit', intl: false },
  { code: 'FLL', city: 'Fort Lauderdale', intl: false },
  { code: 'IAH', city: 'Houston', intl: false },
  { code: 'MCO', city: 'Orlando', intl: false },
  { code: 'MIA', city: 'Miami', intl: false },
  { code: 'PHL', city: 'Philadelphia', intl: false },
  { code: 'SJU', city: 'San Juan', intl: false },
  { code: 'TPA', city: 'Tampa', intl: false },
];

export const ORIGIN = 'RDU';

// GoWild pass blackout dates (local departure date). Peak Day Charge applies:
// the pass is bookable only at an inflated fare. Frontier does not announce this
// in the payload, so we carry the calendar ourselves.
export const BLACKOUT_DATES = new Set([
  '2026-11-24', '2026-11-25',
  '2026-11-28', '2026-11-29', '2026-11-30',
  '2026-12-19', '2026-12-20', '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24',
  '2026-12-26', '2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-01-14', '2027-01-15', '2027-01-18',
  '2027-02-11', '2027-02-12', '2027-02-15',
]);

export const PEAK_LABEL = 'Peak Day Charge $79+';

// Noise control. A 20-hour connection via MCO is a real GoWild itinerary, but it
// is not a useful answer to "what can I fly?", so it is folded into a disclosure
// rather than deleted. Nothing is ever hidden silently.
export const MAX_STOPS = 1;
export const MAX_DURATION_MIN = 480;
export const MAX_ALL_IN = 50.0;

export function isBlackout(dateISO) {
  return BLACKOUT_DATES.has(dateISO);
}

// Local-date helpers. Frontier's dates are Eastern; a UTC clock would flip the
// wrong day for four hours every night, so pin the zone explicitly.
export function easternDate(offsetDays = 0, now = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(now + offsetDays * 86400000));
}

// Frontier wants dd1=Nov%2003,%202026
export function frontierDateParam(dateISO) {
  const [y, m, d] = dateISO.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]}%20${d},%20${y}`;
}

export function cityFor(code) {
  const hit = ROUTES.find((r) => r.code === code);
  return hit ? hit.city : code;
}
