// Origin profiles. The board was built for RDU; LGA exists because Frontier quit
// JFK entirely on 2026-10-05 (its last JFK route was JFK-ATL, cut that day), so a
// JFK board would be permanently and honestly empty. LGA is Frontier's main New
// York station: ATL, CLT, CLE, DEN, DFW, MCO, MIA, RDU and seasonal SJU.
// DTW-LGA starts 2026-11-20 and belongs here only from then.
//
// RDU verified 2026-11-03 against FlightConnections (updated 2026-11-02) and
// RDU's own nonstop table. The "32 destinations" figure circulating online is
// from ABC11, 2019-05-01, and is stale. BUF is announced, not operating.
const RDU_ROUTES = [
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

const LGA_ROUTES = [
  { code: 'ATL', city: 'Atlanta', intl: false },
  { code: 'CLT', city: 'Charlotte', intl: false },
  { code: 'CLE', city: 'Cleveland', intl: false },
  { code: 'DEN', city: 'Denver', intl: false },
  { code: 'DFW', city: 'Dallas/Fort Worth', intl: false },
  { code: 'MCO', city: 'Orlando', intl: false },
  { code: 'MIA', city: 'Miami', intl: false },
  { code: 'RDU', city: 'Raleigh/Durham', intl: false },
  { code: 'SJU', city: 'San Juan', intl: false },
];

// PHL. Frontier treats Philadelphia as a base and serves 23 destinations from it
// (FlightConnections, updated 2026-11-02); the exact list is only partly
// sourceable, so this is the 20 pairs a published table attributes to Frontier
// plus BOS and DEN, which are widely reported as restored and appear on PHL's own
// airline-news page. Those two are the contested ones — if the sweep reports them
// as `route-not-served`, they come out again. That is what the classifier is for.
// Caribbean/Mexico (CUN, PUJ, SDQ, STI) is winter-peaked and the most volatile
// part of Frontier's network, so expect those to churn.
const PHL_ROUTES = [
  { code: 'ATL', city: 'Atlanta', intl: false },
  { code: 'BOS', city: 'Boston', intl: false },
  { code: 'CLT', city: 'Charlotte', intl: false },
  { code: 'CUN', city: 'Cancun', intl: true },
  { code: 'DEN', city: 'Denver', intl: false },
  { code: 'DFW', city: 'Dallas/Fort Worth', intl: false },
  { code: 'DTW', city: 'Detroit', intl: false },
  { code: 'FLL', city: 'Fort Lauderdale', intl: false },
  { code: 'JAX', city: 'Jacksonville', intl: false },
  { code: 'LAS', city: 'Las Vegas', intl: false },
  { code: 'MCO', city: 'Orlando', intl: false },
  { code: 'MIA', city: 'Miami', intl: false },
  { code: 'MSY', city: 'New Orleans', intl: false },
  { code: 'MYR', city: 'Myrtle Beach', intl: false },
  { code: 'ORD', city: "Chicago O'Hare", intl: false },
  { code: 'PBI', city: 'West Palm Beach', intl: false },
  { code: 'PUJ', city: 'Punta Cana', intl: true },
  { code: 'RDU', city: 'Raleigh/Durham', intl: false },
  { code: 'SDQ', city: 'Santo Domingo', intl: true },
  { code: 'SJU', city: 'San Juan', intl: false },
  { code: 'STI', city: 'Santiago de los Caballeros', intl: true },
  { code: 'TPA', city: 'Tampa', intl: false },
];

export const PROFILES = {
  rdu: { origin: 'RDU', city: 'Raleigh/Durham', routes: RDU_ROUTES },
  lga: { origin: 'LGA', city: 'New York LaGuardia', routes: LGA_ROUTES },
  phl: { origin: 'PHL', city: 'Philadelphia', routes: PHL_ROUTES },
};

// One process, one profile. The Worker cannot assign globalThis before its static
// imports evaluate, so a Worker serving two origins passes the origin explicitly
// to the renderer instead, and this resolves the collector's default.
function resolveProfile() {
  const asked =
    (typeof globalThis !== 'undefined' && globalThis.__BOARD_PROFILE__) ||
    (typeof process !== 'undefined' && process.env && process.env.BOARD_PROFILE) ||
    'rdu';
  const key = String(asked).toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROFILES, key) ? key : 'rdu';
}

export const PROFILE = resolveProfile();
export const ORIGIN = PROFILES[PROFILE].origin;
export const ROUTES = PROFILES[PROFILE].routes;

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

// Wall-clock compare without timezone arithmetic: now and a flight's `dep` are
// both Eastern "YYYY-MM-DD HH:MM:SS", so a lexical compare is exact and DST-proof.
export function easternStamp(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const g = (t) => {
    const hit = parts.find((p) => p.type === t);
    return hit ? hit.value : '00';
  };
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
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

// --- Sweep budgeting --------------------------------------------------------
// One request per route per date is the entire cost of a sweep, and the measured
// soft throttle starts well inside a 28-request burst (refusals seen at 4/28 and
// 19/28 on 2026-11-03). A refusal aborts the sweep, so a burst that is too large
// buys LESS data than a smaller one: the second half is spent being told no.
// Two shards of seven give the same coverage — every route re-checked at least
// every 30 minutes — for half the burst.
export const SHARD_SLOT_MS = 15 * 60 * 1000;

// Alternates 0,1,0,1 on consecutive 15-minute slots, and is derived from the
// clock rather than from stored state, so a missed tick cannot desynchronise it.
export function routeShard(now = Date.now()) {
  return Math.floor(now / SHARD_SLOT_MS) % 2;
}

// shard = null returns every route, for a deliberate full sweep (FULL_SWEEP=1).
export function shardRoutes(routes, shard) {
  const list = Array.isArray(routes) ? routes : [];
  if (shard === null || shard === undefined) return list.slice();
  const want = ((Number(shard) % 2) + 2) % 2;
  return list.filter((_, i) => i % 2 === want);
}

// The shard for the *next* tick.
//
// Alternating on the clock looked equivalent to alternating per tick, and is not.
// GitHub fires the fifteen-minute cron about hourly (measured 2026-11-04: 24 runs
// in 24 h, median gap 60 min, range 42-81), and one hour is exactly four 15-minute
// slots, so a run landing at the same minute each hour reads the same parity every
// time. Measured consequence: seven routes carried for 388 minutes while the other
// seven were 28 minutes old. Alternation therefore follows what the previous tick
// actually used; the clock is only the first-run guess.
export function nextShard(lastShard, now = Date.now()) {
  const last = Number(lastShard);
  if (last === 0 || last === 1) return last === 0 ? 1 : 0;
  return routeShard(now);
}

export function easternHour(now = Date.now()) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(now)),
  );
}

// After the last RDU departure there is nothing left to learn about today: the
// schedule has flown. Asking again spends half of the next sweep's budget on a
// day that cannot change. Resets at local midnight, because a new day is live
// again from its first departure.
export const LAST_DEPARTURE_HOUR_ET = 23;

export function departuresFinished(now = Date.now()) {
  return easternHour(now) >= LAST_DEPARTURE_HOUR_ET;
}
