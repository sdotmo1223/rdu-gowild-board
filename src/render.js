import { MAX_ALL_IN, PEAK_LABEL, MAX_STOPS, MAX_DURATION_MIN, ORIGIN } from './routes.js';
import { bookabilityHeatmap } from './heatmap.mjs';
import { releaseTiming, MIN_SAMPLES } from './timing.mjs';
import { weeklyPattern } from './schedule.mjs';
import { fareMechanics, median, MIN_SAMPLES as FARE_MIN } from './pricing.mjs';
import { projectLeg, WEEKDAYS } from './ledger.mjs';

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(dt) {
  if (!dt) return '--:--';
  const m = String(dt).match(/(\d{1,2}):(\d{2})/);
  if (!m) return esc(dt);
  let h = Number(m[1]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

function dayOf(dt) {
  const m = String(dt || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function fmtDuration(d) {
  if (!d) return '';
  return String(d).replace(/\s*hrs?\s*/, 'h ').replace(/\s*min/, 'm').replace(/day\(s\)/, 'day').trim();
}

function shortDay(iso) {
  // Refuses garbage instead of printing "Invalid Date" on the owner's page. A watch
  // record with a broken date is a record to repair, not a word to render.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso == null ? '' : iso))) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Local clock label for a carried-row timestamp. Its whole purpose is that the
// reader can compare it against the board's own "updated N min ago" and see that
// this route was not re-checked just now.
function hhmm(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(n));
  } catch {
    return '';
  }
}

function ago(min) {
  if (min == null) return 'never updated';
  if (min < 1) return 'updated just now';
  if (min === 1) return 'updated 1 min ago';
  if (min < 60) return `updated ${min} min ago`;
  const h = Math.floor(min / 60);
  return `updated ${h}h ${min % 60}m ago`;
}

// "6h 40m" — a span, not a sentence, so it can sit inside one.
function spanText(min) {
  if (min == null) return 'unknown';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// Per-route freshness. The header already states the snapshot's age, which is not
// the same claim: a rotating sweep re-checks half the routes per tick, so the page
// could read "updated 9 min ago" over a route last answered hours ago. Under an
// hour this is the normal state and saying it every tick is noise; past it, the
// line names the route instead of leaving a starving route invisible.
function coverageHtml(view) {
  const c = view && view.coverage;
  if (!c) return '';
  const showAge = c.oldestRouteAgeMin !== null && c.oldestRouteAgeMin !== undefined && c.oldestRouteAgeMin >= 60;
  if (!showAge && !c.neverAnswered) return '';
  const parts = [];
  if (showAge) {
    parts.push(`oldest route reading ${spanText(c.oldestRouteAgeMin)} old${c.oldestRoute ? ` (${esc(c.oldestRoute)})` : ''}`);
  }
  if (c.neverAnswered) {
    parts.push(`${c.neverAnswered} route${c.neverAnswered === 1 ? '' : 's'} never answered a sweep`);
  }
  const text = parts.join(' &middot; ');
  return `<p class="meta cov">${c.warn ? `<strong>${text}</strong>` : text}</p>`;
}

function rowKey(r) {
  return `${r.dest}|${r.dep}`;
}

// Cheapest-first, then the earlier departure as the tie-break. A list in clock order
// answers "what happens next"; the owner's question is "what is the move", and a
// sorted price column answers it before the copy is read. Rows keep their real data;
// ranking is the only thing this changes, so a pinned or watched row cannot be lost.
function rankRows(rows) {
  const cheapestOnRoute = new Map();
  const secondOnRoute = new Map();
  for (const r of rows) {
    const v = Number(r.allin);
    const low = cheapestOnRoute.get(r.dest);
    const next = secondOnRoute.get(r.dest);
    if (low === undefined || v < low) {
      if (low !== undefined) secondOnRoute.set(r.dest, low);
      cheapestOnRoute.set(r.dest, v);
    } else if (v > low && (next === undefined || v < next)) {
      secondOnRoute.set(r.dest, v);
    }
  }
  const isCheapest = (r) => Number(r.allin) === cheapestOnRoute.get(r.dest);
  // The badge only earns its space where it distinguishes something: on a route with
  // a single option it would mark every row on the page and mean nothing.
  // Plain fare-ascending: the price column then reads as a sorted column, which is
  // the fastest thing the eye can check. Tiering route-cheapest above cheaper rows
  // elsewhere made the column jump ($38.01 above three $25.21s) and cost the glance.
  const sorted = rows.slice().sort((a, b) => {
    if (Number(a.allin) !== Number(b.allin)) return Number(a.allin) - Number(b.allin);
    return String(a.dep).localeCompare(String(b.dep));
  });
  // The badge has to be worth a line of chrome: it marks a departure that is strictly
  // cheaper than another departure to the same place. Ties and one-option routes drop
  // it — marking ten of sixteen rows said nothing, and "lowest fare" on a tie is not a
  // saving. The slot stays for the percentile work (bottom-25%, cheapest-seen).
  const best = new Set();
  const marked = new Set();
  for (const r of sorted) {
    const spread = secondOnRoute.get(r.dest);
    if (isCheapest(r) && spread !== undefined && spread > Number(r.allin) && !marked.has(r.dest)) {
      best.add(rowKey(r));
      marked.add(r.dest);
    }
  }
  return { rows: sorted, best };
}

// The one freshness sentence the header is allowed to say. It reuses the coverage
// rule the stale-alert path uses, so the header cannot claim more than a push would:
// a snapshot that is fresh over a route that never answered is not a fresh board.
function freshnessRuling(view) {
  const cov = view && view.coverage;
  const neverN = Number(cov && cov.neverAnswered) || 0;
  const oldest = cov && Number.isFinite(Number(cov.oldestRouteAgeMin)) ? Number(cov.oldestRouteAgeMin) : null;
  if (view && view.stale) {
    return { tone: 'bad', line: `last full check ${spanText(view.ageMin)} ago \u2014 treat every fare here as thin` };
  }
  if (!view || !Array.isArray(view.dates) || !view.dates.length) {
    return { tone: 'bad', line: 'no snapshot has been written \u2014 this is a missing run, not an empty board' };
  }
  // Carried rows are real fares from an earlier sweep, so the route ledger can look
  // fresh while a whole date was never re-asked. Measured on the live board
  // 2026-11-12: the ledger said "all 14 routes checked within the hour" directly above
  // a banner saying 13 rows were carried -- the header overclaiming, which is the one
  // thing this line exists to prevent. Carried or partial now outranks fresh.
  const dates = Array.isArray(view.dates) ? view.dates : [];
  const carried = dates.reduce((n, d) => n + (Number(d.carriedRoutes) || 0), 0);
  const carriedFrom = dates.map((d) => Number(d.carriedAt)).filter((n) => Number.isFinite(n) && n > 0);
  const partial = Boolean(view && view.error && view.error.kind === 'partial');
  if (partial || carried > 0) {
    const when = carriedFrom.length ? ` from ${hhmm(Math.min(...carriedFrom))} ET` : '';
    const what = carried
      ? `${carried} row${carried === 1 ? '' : 's'} carried${when}`
      : 'the last sweep was partial';
    return { tone: 'warn', line: `${what} \u2014 not re-checked this hour` };
  }
  if (!cov) {
    return { tone: 'warn', line: 'no route ledger yet \u2014 cannot say when each route was last checked' };
  }
  if (neverN) {
    return {
      tone: 'warn',
      line: `${neverN} route${neverN === 1 ? '' : 's'} never answered a sweep \u2014 coverage is incomplete`,
    };
  }
  if (oldest !== null && oldest >= 60) {
    return { tone: 'warn', line: `oldest route reading is ${spanText(oldest)} old \u2014 treat this board as thin` };
  }
  return {
    tone: 'ok',
    line: `all ${Number(view.routeCount) || 0} routes checked within the hour \u00b7 snapshot ${spanText(view.ageMin)} old`,
  };
}

// Above the fold, always: the single best bookable departure and the ruling on how
// much to trust it. The hero is a real row (same data attributes, same pin/calendar
// controls), so it cannot drift from the list it summarises.
function bestDealHtml(view, now, ctx) {
  const pool = [];
  for (const d of view.dates) for (const r of d.rows) pool.push({ r, d });
  pool.sort((a, b) => Number(a.r.allin) - Number(b.r.allin) || String(a.r.dep).localeCompare(String(b.r.dep)));
  const ruling = freshnessRuling(view);
  const pick = pool[0] || null;
  const stamp = pick ? `${shortDay(pick.d.date)} \u00b7 ${ago(view.ageMin)}` : ago(view.ageMin);
  const body = pick
    ? `<ul class="rows drows">${rowHtml(pick.r, ctx)}</ul>`
    : `<p class="dnone">${view.dates.length ? 'Nothing under the ceiling is bookable right now. Every date below says why.' : 'Nothing is loaded yet.'}</p>`;
  return `<section class="decide" aria-label="Best move right now">
    <div class="dtop"><span class="dk">Best move</span><span class="dage">${esc(stamp)}</span></div>
    ${body}
    <p class="drule ${ruling.tone}">${esc(ruling.line)}</p>
  </section>`;
}

// A reason is not a footnote. Each empty date gets a card that says what happened in
// the words the board already uses, plus what the reader can do about it. The copy
// itself is unchanged: this is presentation, not new logic.
function stateCard(cls, title, html, hint) {
  const ico = cls === 'bad' ? '!' : cls === 'warn' ? '\u00b7' : 'i';
  return `<div class="state ecard ${cls}"><span class="ico" aria-hidden="true">${ico}</span><div class="cbody"><b>${esc(title)}</b><p>${html}</p>${hint ? `<em>${esc(hint)}</em>` : ''}</div></div>`;
}

const ALERT_KIND = {
  available: 'seats opened',
  soldout: 'sold out',
  cheaper: 'cheaper',
  departing: 'departing soon',
  departed: 'left',
};

// A push that fired must leave a trace the board can show, or the reader taps a
// notification and lands on a list with no memory of it. Entries come from the
// outbox that already exists in KV; nothing is fetched and nothing is invented.
function eventLogHtml(ob) {
  const list = ob && Array.isArray(ob.recent) ? ob.recent : [];
  if (!list.length) return '';
  const state = { sent: 'delivered', pending: 'retrying', dead: 'dead', dropped: 'expired' };
  const rows = list
    .map(
      (e) =>
        `<li class="ev ${esc(e.state)}"${e.key ? ` data-ev="${esc(e.key)}"` : ''}${e.announce ? ` data-target="${esc(e.announce)}"` : ''}><b>${esc(e.dest)}</b><span class="ek">${esc(ALERT_KIND[e.kind] || e.kind)}</span><time>${esc(hhmm(e.at))}</time><span class="est">${esc(state[e.state] || e.state)}</span></li>`,
    )
    .join('');
  return `<details class="evlog"${Number(ob.dead) > 0 ? ' open' : ''}><summary>Last 24h of alerts \u00b7 ${list.length}</summary><p class="evnote">Times are ET. A dead event is one that never reached you; the watch that fired it is still armed.</p><ul class="evlist">${rows}</ul></details>`;
}

// How old this row's route reading is, under the price. It says "checked" and not
// "this fare was checked", because the ledger is per route per sweep and the row has
// no timestamp of its own.
// What the schedule ledger has actually seen, on the destinations this owner has
// chosen to watch. A projection is a count wearing a clock: the ink carries the
// count, so "established" and "single sighting" cannot be mistaken for each other,
// and neither is ever drawn like a row that is on sale right now.
const CONFIDENCE_INK = {
  established: { cls: 'ok', label: 'established' },
  repeated: { cls: 'mid', label: 'repeated' },
  single: { cls: 'weak', label: 'single sighting' },
};

function planHtml(ledger, ctx) {
  const watches = (ctx && Array.isArray(ctx.watches) ? ctx.watches : []).filter((w) => w && w.dest);
  if (!ledger || !ledger.routes || !watches.length) return '';
  const cards = [];
  for (const w of watches) {
    const dest = String(w.dest).toUpperCase();
    const route = ledger.routes[dest];
    if (!route || !route.byDow) continue;
    const picks = [];
    for (const dow of Object.keys(route.byDow)) {
      const p = projectLeg(ledger, dest, dow);
      if (p) picks.push(p);
    }
    picks.sort((a, b) => b.n - a.n || a.dow - b.dow);
    if (!picks.length) continue;
    const legs = picks
      .slice(0, 2)
      .map((p) => {
        const ink = CONFIDENCE_INK[p.confidence] || { cls: 'weak', label: p.confidence };
        return `<li class="pleg ${ink.cls}"><div class="ptime"><b>${esc(String(WEEKDAYS[p.dow] || '').slice(0, 3))}</b> ${esc(fmtTime(p.dep))}</div><div class="pmeta"><span class="pconf ${ink.cls}">${esc(ink.label)}</span> \u00b7 seen ${p.n}\u00d7 in ${Number(ledger.windowDays) || 14} days</div></li>`;
      })
      .join('');
    cards.push(
      `<li class="pcard"><div class="phead"><b>${esc(dest)}</b><span>${esc(w.mode === 'date' ? 'one date' : 'every day')}</span></div><ul class="plegs">${legs}</ul>${ctx.canWatch ? `<button type="button" class="act arm" data-dest="${esc(dest)}">Arm a watch on ${esc(dest)}</button>` : ''}</li>`,
    );
  }
  if (!cards.length) return '';
  return `<section class="plan" aria-label="Projected legs">
    <div class="dtop"><span class="dk">Projected legs</span><span class="dage">from ${Number(ledger.windowDays) || 14} days of sweeps</span></div>
    <p class="plead">A projection is a pattern, not a ticket: this board only sweeps departures from its own origin, so these are that route's real departure times, never a held seat. Arming one puts it under the normal watch, where it has to be confirmed by an actual sweep before anything fires.</p>
    <ul class="pcards">${cards.join('')}</ul>
  </section>`;
}

// Why an origin that exists is not on this page. Copy, not state: the scheduling
// decision is recorded in AGENTS.md (2026-11-11 — three airports on one budget could
// not hold the freshness ceiling) and this is how a reader is told, in one line.
const ORIGIN_LATER =
  'defined but not scheduled: one request budget cannot keep three origins inside the freshness ceiling (2026-11-11)';

function searchHtml(view, ctx) {
  const origins = Array.isArray(ctx.origins) ? ctx.origins : [];
  const total = view.dates.reduce((n, d) => n + d.rows.length, 0);
  // Nothing to search is not a search box with a zero under it: a control over an
  // empty page is both a dead end and a false statement about the board.
  if (!total) return '';
  const seen = new Set();
  const hints = [];
  for (const d of view.dates) {
    for (const r of d.rows) {
      if (seen.has(r.dest)) continue;
      seen.add(r.dest);
      hints.push(r.city);
    }
  }
  const off = origins.filter((o) => !o.live).map((o) => o.code);
  const chips = origins
    .map((o) =>
      o.live
        ? `<b class="origin on" aria-current="true">${esc(o.code)}</b>`
        : `<span class="origin off">${esc(o.code)} <em>available later</em></span>`,
    )
    .join('');
  return `<section class="find" aria-label="Find a departure">
    <div class="findrow">
      <label for="q">Find</label>
      <input id="q" type="search" inputmode="search" autocomplete="off" spellcheck="false" placeholder="${esc(hints.slice(0, 2).join(' \u00b7 ') || 'destination')}">
      <button type="button" class="act qclear" id="qclear" hidden>Clear</button>
    </div>
    <p class="findmeta" id="qcount" aria-live="polite">${total} departure${total === 1 ? '' : 's'} on this board</p>
    ${chips ? `<div class="origins"><span class="olabel">Origin</span>${chips}</div><p class="olater">${esc(off.join(' and '))} ${off.length === 1 ? 'is' : 'are'} ${esc(ORIGIN_LATER)}.</p>` : ''}
  </section>`;
}

function routeCheck(r, ctx) {
  const ages = ctx && ctx.routeAges;
  if (!ages || !Object.prototype.hasOwnProperty.call(ages, r.dest)) return '';
  const age = Number(ages[r.dest]);
  if (!Number.isFinite(age)) return '';
  return `<span class="rcheck${age >= 60 ? ' warn' : ''}">checked \u2264 ${esc(spanText(age))}</span>`;
}

function rowHtml(r, ctx = {}) {
  const watched = Boolean(ctx && ctx.canWatch && ctx.watched && ctx.watched.has(r.dest));
  const nextDay = dayOf(r.arr) && dayOf(r.dep) && dayOf(r.arr) !== dayOf(r.dep);
  const arrive = `${fmtTime(r.arr)}${nextDay ? ' <span class="nd">+1</span>' : ''}`;
  const data =
    `data-date="${esc(r.date)}" data-dest="${esc(r.dest)}" data-city="${esc(r.city)}" ` +
    `data-dep="${esc(r.dep)}" data-arr="${esc(r.arr)}" data-allin="${esc(r.allin)}" ` +
    `data-stops="${esc(r.stops)}"`;
  // Departure time is the left rail because it is what the eye scans first; the
  // time is never repeated downstream, so the row reads once, left to right.
  const seats =
    r.seats === 0
      ? '<span class="seat out">sold out</span>'
      : r.seats
        ? `<span class="seat">${r.seats} seat${r.seats === 1 ? '' : 's'} left</span>`
        : '<span class="seat unk">seats n/a</span>';
  return `<li class="row" ${data}>
      <div class="dep"><time>${fmtTime(r.dep)}</time></div>
      <div class="main">
        <p class="dest">${esc(r.city)}<b>${esc(r.dest)}</b></p>
        <p class="sub">
          <span class="arr">${arrive}</span>
          <span>${esc(fmtDuration(r.dur))}</span>
          ${r.nonstop ? '<span class="badge nonstop">nonstop</span>' : `<span class="badge stops">${esc(r.stops)}</span>`}
          ${ctx && ctx.best && ctx.best.has(rowKey(r)) ? '<span class="badge best">lowest fare</span>' : ''}
          ${seats}
          ${r.leaveBy ? `<span class="leave ${r.tight ? 'tight' : ''}">leave by ${fmtTime(r.leaveBy)}${r.tight ? ' &middot; leave now' : ''}</span>` : ''}
        </p>
        <div class="acts">
          ${ctx && ctx.canWatch ? `<button type="button" class="act bell" data-dest="${esc(r.dest)}" data-date="${esc(r.date)}" aria-pressed="${watched ? 'true' : 'false'}" title="Watch ${esc(r.dest)}">${watched ? 'Watching' : 'Watch'}</button>` : ''}
          <button type="button" class="act pin" aria-pressed="false">Pin ${esc(r.dest)}</button>
          <button type="button" class="act ics">Calendar</button>
        </div>
      </div>
      <div class="fare">
        <span class="amt">$${r.allin.toFixed(2)}</span>
        <span class="unit">est. all-in</span>
        ${routeCheck(r, ctx)}
        <a class="act book" href="https://booking.flyfrontier.com/Flight/InternalSelect?o1={ORIGIN}&d1=${esc(r.dest)}&dd1=${esc(r.date)}&ADT=1&mon=true&promo=" target="_blank" rel="noopener noreferrer" title="Opens Frontier's own search for this date. The fare there is live; the fare here is a snapshot.">Search &#8599;</a>
      </div>
    </li>`;
}

// Which origin this page shows. STATE_COPY is built at module load, before any
// call knows the origin, so origin-bearing strings carry a {ORIGIN} token that is
// filled in exactly once, at the end of renderPage.
let PAGE_ORIGIN = 'RDU';
const ORIGIN_TOKEN = /\{ORIGIN\}/g;
const fillOrigin = (s) => s.replace(ORIGIN_TOKEN, () => PAGE_ORIGIN);

const STATE_COPY = {
  blocked: 'Blocked — Frontier bot protection returned a challenge page. Last known data shown.',
  error: 'Collector error for this date. No data was returned.',
  noflights: 'No Frontier departures from {ORIGIN} on this date.',
  above: (d) => {
    // Only departures still ahead can be "all above" the ceiling.
    const n = d.aboveAhead || d.goWild;
    return `${n} GoWild departure${n === 1 ? '' : 's'} still ahead, all above $${MAX_ALL_IN.toFixed(2)}.`;
  },
  nogowild: (d) => `${d.total} departure${d.total === 1 ? '' : 's'}, but Frontier released no GoWild seats.`,
};

// The page's own day, in the zone the board reasons in. "Today" below is a claim
// about America/New_York, so it must not come from the host clock's UTC date.
function etDay(now) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

// What a reader can learn from the panel's own roof: which day it is, how many
// options are on it, and the cheapest one. The counts are read off the rows the
// panel actually renders, so the summary cannot drift from the list under it.
function dateSub(d, now) {
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const cheapest = rows.reduce((m, r) => {
    const v = Number(r.allin);
    return Number.isFinite(v) && (m === null || v < m) ? v : m;
  }, null);
  const today = etDay(now);
  const tomorrow = etDay(Number(now) + 86400000);
  const rel = d.date === today ? 'Today' : d.date === tomorrow ? 'Tomorrow' : '';
  const parts = [rel];
  parts.push(rows.length ? `${rows.length} option${rows.length === 1 ? '' : 's'}` : 'no bookable options');
  if (cheapest !== null) parts.push(`from <span class="from">$${cheapest.toFixed(2)}</span>`);
  return parts.filter(Boolean).join(' &middot; ');
}

// The watch strip is the board's standing questions, stated on the page. It also
// names the channels that are actually wired: a watch accepted by a Worker with no
// NTFY_TOPIC would be a promise nobody keeps.
function watchBar(ctx) {
  if (!ctx || !ctx.canWatch) return '';
  const list = Array.isArray(ctx.watches) ? ctx.watches : [];
  const st = ctx.channels || {};
  const names = ['push', 'email', 'text'];
  const ready = names.filter((c) => st[c] && st[c].ready);
  const off = names.filter((c) => !st[c] || !st[c].ready);
  const alertLine = ready.length
    ? `Alerts: ${ready.join(' + ')}${off.length ? ` \u00b7 ${off.join(', ')} not set up` : ''}`
    : 'No alert channel is set up yet \u2014 set NTFY_TOPIC on the Worker to receive these';
  if (!list.length) {
    return `<div class="watchbar empty"><span class="wb">Watch</span><span class="wb-note">Tap <b>Watch</b> on a departure to be told when its seats open, sell out, get cheaper, or get close to leaving.</span><span class="wb-ch">${esc(alertLine)}</span></div>`;
  }
  const chips = list
    .map((w) => {
      const day = shortDay(w.date);
      const scope = w.mode === 'always' ? 'every date' : esc(day || 'one date');
      const live = (w.channels || []).filter((c) => st[c] && st[c].ready);
      return `<span class="wchip"><b>${esc(w.dest)}</b><em>${scope}</em><i>${esc(live.length ? live.join(' + ') : 'no channel ready')}</i><button type="button" class="act unwatch" data-dest="${esc(w.dest)}">stop</button></span>`;
    })
    .join('');
  return `<div class="watchbar"><span class="wb">Watching</span><div class="wchips">${chips}</div><span class="wb-ch">${esc(alertLine)}</span></div>`;
}

function dateSection(d, view, now, index = 0, ctx = {}) {
  // Ranked for action, not chronology: cheapest seat on each route first.
  const ranked = d.status === 'ok' ? rankRows(d.rows) : { rows: d.rows || [], best: new Set() };
  const rowCtx = { ...ctx, best: ranked.best };
  const label = d.blackout || d.peak ? `<span class="badge peak">${esc(PEAK_LABEL)}</span>` : '';
  const freshN = d.freshRoutes == null ? d.routesScanned : d.freshRoutes;
  const carriedNote = d.carriedRoutes
    ? ` &middot; ${d.carriedRoutes} carried${d.carriedAt ? ` from ${esc(hhmm(d.carriedAt))} ET` : ''}`
    : '';
  let body;

  if (d.status === 'ok') {
    // Only departures that can still be booked are listed. If some of this date's
    // options have already flown, that is stated rather than left as a silent gap.
    const live = ranked.rows;
    body = `<ul class="rows">${live.map((r) => rowHtml(r, rowCtx)).join('')}</ul>`;
    const gone = Number(d.pastCount) || 0;
    if (gone) {
      body += `<div class="state">${gone} more under $${MAX_ALL_IN.toFixed(2)} on this date already departed and cannot be booked.</div>`;
    }
    if (Number(d.withheld)) {
      body += `<div class="state warn">${d.withheld} older option${d.withheld === 1 ? '' : 's'} withheld: last checked more than 3 hours ago.</div>`;
    }
    if (d.folded && d.folded.length) {
      const cap = `${MAX_STOPS} stop${MAX_STOPS === 1 ? '' : 's'} / ${Math.round(MAX_DURATION_MIN / 60)}h`;
      body += `<details class="folded"><summary>${d.folded.length} more under $${MAX_ALL_IN.toFixed(2)} — beyond ${cap}</summary><ul class="rows">${d.folded.map((f) => rowHtml(f, ctx)).join('')}</ul></details>`;
    }
    if (Number(d.foldedPastCount)) {
      body += `<div class="state">${d.foldedPastCount} further over-limit option${d.foldedPastCount === 1 ? '' : 's'} on this date already departed.</div>`;
    }
    if (d.peak) {
      body += d.rows.length
        ? `<p class="note">${esc(PEAK_LABEL)} is on the blackout calendar for this date, yet Frontier returned sub-$${MAX_ALL_IN.toFixed(2)} GoWild fares. Verify the fare at checkout before planning on it.</p>`
        : `<p class="note">${esc(PEAK_LABEL)} applies on this date — GoWild is only bookable at a peak fare.</p>`;
    }
    if (d.above > 0) body += `<p class="note">${d.above} further GoWild departure${d.above === 1 ? '' : 's'} priced above $${MAX_ALL_IN.toFixed(2)}.</p>`;
  } else if (d.status === 'peak') {
    body = stateCard('warn', PEAK_LABEL, `GoWild is not bookable at the normal fare on this date${d.lowest ? ` — lowest GoWild fare seen $${d.lowest.toFixed(2)}` : ''}.`, 'Blackout dates come from the calendar in src/routes.js, not from Frontier.');
  } else if (d.status === 'blocked') {
    body = stateCard('bad', 'Frontier blocked the check', esc(STATE_COPY.blocked), 'The next sweep tries again; nothing on this date is hidden.');
  } else if (d.status === 'error') {
    body = stateCard('bad', 'The check failed', esc(STATE_COPY.error), 'No reading came back — different from a date with no seats.');
  } else if (d.status === 'stale') {
    // The rows exist and are priced, but their provenance is older than the board
    // will stand behind. Withholding them is the only honest option.
    body = stateCard('warn', 'Too old to stand behind', `Every option on this date was last checked more than 3 hours ago${d.carriedAt ? ` (${esc(hhmm(d.carriedAt))} ET)` : ''}, so none is offered as bookable.`, 'A stale fare shown as an offer would be a lie, so it is withheld instead.');
  } else if (d.status === 'folded') {
    const cap = `${MAX_STOPS} stop${MAX_STOPS === 1 ? '' : 's'} / ${Math.round(MAX_DURATION_MIN / 60)}h`;
    body = `${stateCard('warn', 'Under the ceiling, over the limits', `${d.folded.length} GoWild option${d.folded.length === 1 ? '' : 's'} under $${MAX_ALL_IN.toFixed(2)}, all beyond ${cap}.`, 'Real departures, just long ones — open them if time is cheaper than money today.')}<details class="folded" open><summary>Show them anyway</summary><ul class="rows">${d.folded.map((f) => rowHtml(f, rowCtx)).join('')}</ul></details>`;
    // The cheaper rows that already left are stated here too: showing only the
    // over-limit options would imply this date had nothing better to offer.
    const goneHere = Number(d.pastCount) || 0;
    if (goneHere) {
      body += `<div class="state">${goneHere} cheaper nonstop option${goneHere === 1 ? '' : 's'} on this date already departed.</div>`;
    }
  } else if (d.status === 'above') {
    // "Nothing under $50" is only useful if it says how far off it was. The
    // cheapest GoWild fare is already measured, so the gap is stated rather than
    // leaving the reader to guess whether it was $51 or $300.
    // The gap is measured against the cheapest fare still ahead; the overall cheapest
    // may be a departure that already left, which would make the gap negative and the
    // sentence nonsense.
    const gap = typeof d.lowestAbove === 'number' ? d.lowestAbove - MAX_ALL_IN : null;
    let detail = '';
    if (gap !== null && gap > 0) {
      detail = ` Cheapest still ahead was <strong>$${d.lowestAbove.toFixed(2)}</strong>, $${gap.toFixed(2)} over the ceiling.`;
    }
    if (Number(d.cheapDeparted)) {
      detail += ` ${d.cheapDeparted} cheaper option${d.cheapDeparted === 1 ? '' : 's'} on this date already departed.`;
    }
    body = stateCard('warn', 'Everything is above the ceiling', `${esc(STATE_COPY.above(d))}${detail}`, 'Raising the ceiling is a code change (MAX_ALL_IN), not a setting.');
  } else if (d.status === 'noflights') {
    body = stateCard('', 'No departures published', esc(STATE_COPY.noflights), 'An empty schedule, not a failed check.');
  } else if (
    d.status === 'nogowild' &&
    view &&
    view.zero &&
    Number(view.zero.count) >= 3 &&
    view.zero.since &&
    // "No GoWild from RDU in N sweeps" is a station-level claim, so it needs the whole
    // route list behind it, not one half-shard. Same rule as the push in
    // buildZeroAlert; without it the page and the alert disagreed about honesty.
    Array.isArray(view.zero.routes) &&
    view.zero.routes.length >= (Number(view.routeCount) || Infinity)
  ) {
    const hrs = Math.max(1, Math.round((now - view.zero.since) / 3600000));
    body = stateCard('warn', 'No GoWild seats released', `${d.total} departure${d.total === 1 ? '' : 's'}, but Frontier released no GoWild seats. <strong>No GoWild from ${esc(PAGE_ORIGIN)} in ${view.zero.count} sweeps over ${hrs}h</strong> &mdash; that reads as a station-level decision, not a quiet day.`, 'Every route in the profile was asked, so this is a station-wide claim.');
  } else {
    body = stateCard('warn', 'No GoWild on this date yet', esc(STATE_COPY.nogowild(d)), 'Frontier releases GoWild seats close-in; the next sweeps will say if that changes.');
  }

  return `<section class="date" id="d-${esc(d.date)}">
    <div class="dhead">
      <span class="idx">${String(index + 1).padStart(2, '0')}</span>
      <div class="dtitles">
        <h2>${esc(shortDay(d.date))}${label}</h2>
        <span class="dsub">${dateSub(d, now)}</span>
      </div>
      ${d.rows.length ? `<span class="agechip${Number(d.oldestAgeMin) > 60 ? ' warn' : ''}">checked \u2264 ${esc(spanText(d.oldestAgeMin))}</span>` : ''}
      <a class="perm" href="#d-${esc(d.date)}" aria-label="Link to ${esc(d.date)}">#</a>
    </div>
    ${body}
    <p class="meta">${
      d.carriedReason === 'day-over' && !freshN
        ? `${d.routesScanned} routes carried${d.carriedAt ? ` from ${esc(hhmm(d.carriedAt))} ET` : ''} &middot; departures for this date have finished`
        : `${freshN}/${d.routesScanned} routes re-checked${d.failedRoutes ? ` &middot; ${d.failedRoutes} failed` : ''}${d.blockedRoutes ? ` &middot; ${d.blockedRoutes} blocked` : ''}${carriedNote}${d.rows.length && Number(d.oldestAgeMin) > 60 ? ` &middot; oldest fare ${esc(ago(d.oldestAgeMin))}` : ''}`
    }</p>
  </section>`;
}

function hourLabel(h) {
  if (h === null || h === undefined || !Number.isFinite(h)) return 'unknown';
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12} ${ampm}`;
}

function weekdayCell(d) {
  if (!d.of) return '<td class="wk none">&middot;</td>';
  const cls = d.opened === d.of && d.opened > 0 ? 'wk on' : d.opened > 0 ? 'wk part' : 'wk off';
  return `<td class="${cls}">${d.opened}/${d.of}</td>`;
}

function scheduleHtml(state) {
  const pat = weeklyPattern(state);
  if (!pat.dates) return '';
  const cell = (c) => {
    if (!c.of) return '<td class="sc none">&middot;</td>';
    const cls = c.operates === c.of ? 'sc on' : c.operates === 0 ? 'sc off' : 'sc part';
    return `<td class="${cls}">${c.operates}/${c.of}</td>`;
  };
  const body = pat.rows
    .map((r) => {
      const flag =
        r.verdict === 'rotating'
          ? ' <span class="scflag rot">varies by week</span>'
          : r.verdict === 'stable'
            ? ' <span class="scflag sta">same every week</span>'
            : '';
      return `<tr><th scope="row">${esc(r.dest)}${flag}</th>${r.cells.map(cell).join('')}</tr>`;
    })
    .join('');
  const stable = pat.rows.filter((r) => r.verdict === 'stable').length;
  const rotating = pat.rows.filter((r) => r.verdict === 'rotating').length;
  const thin = pat.rows.filter((r) => r.verdict === 'sampled' || r.verdict === 'unknown').length;
  const head = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<th>${d}</th>`).join('');
  return `<details><summary>Weekly schedule: ${pat.dates} date${pat.dates === 1 ? '' : 's'} across ${pat.weeks} week${pat.weeks === 1 ? '' : 's'}</summary>
    <div class="heat"><table><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="note">Cells read <strong>days operating / days swept</strong> for that weekday. ${stable} route${stable === 1 ? '' : 's'} look the same every week, ${rotating} vary week to week, ${thin} need another week before they can be judged. A failed or throttled request is never recorded as "does not fly".</p>
  </details>`;
}

function heatmapHtml(state) {
  const heat = bookabilityHeatmap(state);
  if (!heat.dates.length) return '';
  const head = heat.dates.map((d) => `<th>${esc(d.slice(5).replace('-', '/'))}</th>`).join('');
  const body = heat.routes
    .map(
      (r) =>
        `<tr><th scope="row">${esc(r.dest)}</th>${r.cells
          .map((c) => `<td>${c ? '<i class="cell on"></i>' : '<i class="cell"></i>'}</td>`)
          .join('')}<td class="hits">${r.hits}</td></tr>`,
    )
    .join('');
  const wkHead = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<th>${d}</th>`).join('');
  const wkBody = heat.weekday
    .map((r) => `<tr><th scope="row">${esc(r.dest)}</th>${r.days.map(weekdayCell).join('')}</tr>`)
    .join('');
  return `<details><summary>Bookability: ${heat.observedCount} day${heat.observedCount === 1 ? '' : 's'} observed</summary>
    <div class="heat"><table><thead><tr><th></th>${wkHead}</tr></thead><tbody>${wkBody}</tbody></table></div>
    <p class="note">Cells read <strong>opened / observed</strong> per weekday, so a route is never credited for a day nobody swept. Green means every observed instance of that weekday produced an all-in &le; $${MAX_ALL_IN.toFixed(2)} GoWild itinerary.</p>
    <div class="heat"><table><thead><tr><th></th>${head}<th>&Sigma;</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="note">Recorded history, not a forecast — GoWild seats normally open only a day ahead.</p>
  </details>`;
}

function timingHtml(state) {
  const rows = releaseTiming(state);
  if (!rows.length) return '';
  const body = rows
    .map((r) => {
      const lead =
        r.medianLead === null || r.medianLead === undefined ? '' : ` &middot; ~${r.medianLead}h before departure`;
      // Below the floor the page refuses to print an hour at all: "seen 14:00" from
      // one sighting reads as a claim even with "not yet a pattern" after it. And a
      // sighting that was already on sale at our first look is our cron, not a
      // release, so it is counted but never timed.
      const label = r.confident
        ? `seats open around ${esc(hourLabel(r.medianHour))} local${lead}`
        : r.censored > 0
          ? `${r.samples} timed of ${r.seen} sightings &middot; ${r.censored} ${r.censored === 1 ? 'was' : 'were'} already on sale at first check &middot; ${r.needed} more timed before a time is claimed`
          : `${r.seen} observation${r.seen === 1 ? '' : 's'} &middot; ${r.needed} more before a time is claimed`;
      return `<tr><td>${esc(r.dest)}</td><td>${label}</td></tr>`;
    })
    .join('');
  return `<details><summary>When seats appear</summary><table>${body}</table>
    <p class="note">A route needs ${MIN_SAMPLES}+ timed observations before this claims a time of day. A sighting already on sale the first time we checked that date is our own sweep clock, not a release, so it is excluded from the median. Lead hours are only observable inside the two-day window, so a weekly long-horizon probe is what widens them.</p></details>`;
}

// Visible, not buried in a details block: "when do fares actually flip" is the one
// piece of advice a departures board can give that a timetable cannot.
function flipHtml(state) {
  const m = fareMechanics(state);
  if (!m.instances) return '';
  if (m.preFlipObserved < FARE_MIN) {
    return `<p class="note">Fare-flip timing: ${m.preFlipObserved} flip${m.preFlipObserved === 1 ? '' : 's'} watched of ${FARE_MIN} needed, so no time of day is claimed yet.</p>`;
  }
  const lead =
    m.medianLeadHours === null || m.medianLeadHours === undefined ? '' : `, about ${m.medianLeadHours}h before departure`;
  return `<p class="note">Fare-flip timing: fares watched turning GoWild around <strong>${esc(hourLabel(m.medianFlipHour))} local</strong>${lead} (${m.preFlipObserved} flips out of ${m.instances} itineraries tracked).</p>`;
}

function pct(part, whole) {
  if (!whole) return '\u2014';
  return `${Math.round((part / whole) * 100)}%`;
}

// The mechanism section: when a fare flips, whether it follows the flight or the
// load, and how the GoWild fare sits against the standard fare. Every number
// carries its denominator, and below the sample floor the section says so instead
// of implying a pattern.
function pricingHtml(state) {
  const m = fareMechanics(state);
  if (!m.instances) {
    return `<details><summary>How the GoWild fare behaves</summary>
      <p class="note">No fare observations yet. The next sweep starts the clock: every itinerary is now stored with
      both its standard fare and its GoWild fare, so the moment a fare flips becomes observable instead of inferred.</p></details>`;
  }

  const stats = [
    `<strong>${m.instances}</strong> itineraries tracked (each a departure on a date)`,
    `<strong>${m.withGoWild}</strong> carried a GoWild fare &middot; ${pct(m.withGoWild, m.instances)} of sightings`,
    `<strong>${m.preFlipObserved}</strong> were watched flipping after a standard-fare-only sighting`,
    m.medianLeadHours === null || m.medianLeadHours === undefined
      ? 'lead time cannot be measured yet'
      : `median flip <strong>${m.medianLeadHours}h</strong> before departure`,
  ];

  const hourRows = m.byHour
    .filter((h) => h.instances > 0)
    .map(
      (h) =>
        `<tr><td>${esc(hourLabel(h.hour))}</td><td>${h.instances}</td><td>${h.gw} &middot; ${pct(h.gw, h.instances)}</td><td>${h.gw && median(h.fares) !== null ? `$${median(h.fares).toFixed(2)}` : '\u2014'}</td></tr>`,
    )
    .join('');

  const idRows = m.identities
    .slice(0, 14)
    .map(
      (i) =>
        `<tr><td>${esc(i.dest)} ${esc(i.id)}</td><td>${i.gwDays} of ${i.days}</td><td>${i.verdict === 'always' ? 'every sighting' : i.verdict === 'never' ? 'never' : 'varies'}</td></tr>`,
    )
    .join('');

  const idNote = m.identityKnown
    ? 'Grouped by flight number, so the question "is it this flight, or whichever flight is under-sold?" is answered directly.'
    : 'The payload carried no flight number, so this groups by departure time instead \u2014 a weaker claim, and labelled as one.';

  const ratio = m.std.fareRatioMedian;
  const flipNote =
    m.preFlipObserved < FARE_MIN
      ? `Only ${m.preFlipObserved} flip${m.preFlipObserved === 1 ? '' : 's'} watched so far: below ${FARE_MIN}, this is an observation, not a pattern.`
      : `${m.preFlipObserved} flips watched, median ${m.medianLeadHours === null ? 'unknown' : `${m.medianLeadHours}h`} ahead of departure.`;

  return `<details><summary>How the GoWild fare behaves &middot; ${m.instances} itineraries tracked</summary>
    <table>${stats.map((s) => `<tr><td>${s}</td></tr>`).join('')}</table>
    ${hourRows ? `<div class="heat"><table><thead><tr><th>departs</th><th>sightings</th><th>GoWild</th><th>lowest</th></tr></thead><tbody>${hourRows}</tbody></table></div>
    <p class="note">Which departure hours ever carry a GoWild fare, and the lowest one seen at that hour.</p>` : ''}
    ${idRows ? `<div class="heat"><table><thead><tr><th>flight</th><th>GoWild</th><th>pattern</th></tr></thead><tbody>${idRows}</tbody></table></div>
    <p class="note">${idNote} A column that reads "every sighting" points at particular flights being designated; a mixed column points at a load-based rule. ${m.identities.length} flight pattern${m.identities.length === 1 ? '' : 's'} have reached ${FARE_MIN}+ sightings.</p>` : `<p class="note">No flight has ${FARE_MIN} or more sightings yet, so whether GoWild follows specific flights or any under-sold flight is still open.</p>`}
    <p class="note">Frontier publishes the structure: a GoWild ticket costs a <strong>$0.01 fare per segment plus taxes, fees and charges</strong>, which its own terms put at "approximately $15.40" per domestic flight${m.gwFare.min !== null ? ` \u2014 the cheapest this board has seen is $${m.gwFare.min.toFixed(2)}` : ''}. The GoWild number is therefore mostly tax, not a discount${ratio !== null ? `, and its ~${Math.round(ratio * 100)}% ratio against the standard fare over ${m.std.ratioSamples} comparisons is a by-product of two different prices rather than a rate Frontier applies` : ''}. ${flipNote}</p>
  </details>`;
}

export function renderPage(view, state, freq, now = Date.now(), opts = {}) {
  const basePath = opts.basePath || '';
  // Reset to this Worker's own origin when the caller does not name one. Carrying
  // the previous value forward meant a single /lga render inside the same isolate
  // relabelled the RDU page, its title and its calendar events as LGA.
  PAGE_ORIGIN = opts.origin || ORIGIN;
  const watchedSet = new Set(
    (Array.isArray(opts.watches) ? opts.watches : []).map((w) => w && w.dest).filter(Boolean),
  );
  const watchCtx = {
    canWatch: Boolean(opts.canWatch),
    watches: Array.isArray(opts.watches) ? opts.watches : [],
    channels: opts.channels || {},
    watched: watchedSet,
    // The route ledger is the only honest source of per-row age: rows carry no
    // timestamp of their own, and inventing one would be the lie this board exists
    // not to tell.
    routeAges: (view.coverage && view.coverage.byRoute) || {},
    ledger: opts.ledger || null,
    origins: Array.isArray(opts.origins) ? opts.origins : [],
  };
  // Only what the sheet needs to draw itself: no observation rows, no KV keys and
  // no secrets. `<` is escaped so a reason string can never close the script tag.
  const watchJson = JSON.stringify({
    watches: watchCtx.watches.map((w) => ({
      dest: w.dest,
      mode: w.mode,
      date: w.date || null,
      channels: Array.isArray(w.channels) ? w.channels : [],
    })),
    channels: watchCtx.channels,
  }).replace(/</g, '\\u003c');
  const err = view.error;
  let banner = '';

  if (err) {
    if (err.kind === 'auth') {
      banner = `<div class="banner bad"><strong>Session expired — cookie needs replacing</strong>
        <code>npx wrangler secret put FRONTIER_COOKIE</code></div>`;
    } else if (err.kind === 'blocked') {
      banner = `<div class="banner bad"><strong>Collector blocked by Frontier bot protection</strong>
        <span>${esc(err.detail || '')} — the board below is the last good sweep.</span></div>`;
    } else if (err.kind === 'partial') {
      banner = `<div class="banner warn"><strong>Partial sweep</strong><span>${esc(err.detail || '')}</span></div>`;
    } else {
      banner = `<div class="banner bad"><strong>Collector error</strong><span>${esc(err.detail || '')}</span></div>`;
    }
  }

  const departedDays = Array.isArray(view.departed) ? view.departed : [];
  if (departedDays.length) {
    const gone = departedDays.reduce((n, d) => n + (Number(d.departedCount ?? d.pastCount) || 0), 0);
    const which = departedDays.map((d) => esc(d.date)).join(', ');
    banner += `<div class="banner warn"><strong>That day has flown</strong>
      <span>${gone} departure${gone === 1 ? '' : 's'} on ${which} already left, so ${gone === 1 ? 'it is' : 'they are'} not offered. Everything below is still ahead.</span></div>`;
  }
  if (!view.dates.length && !departedDays.length) {
    banner += `<div class="banner bad"><strong>No data yet</strong>
      <span>The collector has not written a snapshot. This is not "no flights" — it is a missing run.</span></div>`;
  }
  // Not gated on view.dates.length: a dead collector must not look like a board
  // that finished its day, which is exactly what an empty date list means now.
  if (view.stale) {
    banner += `<div class="banner warn"><strong>Data is stale</strong>
      <span>${esc(ago(view.ageMin))} — collector may have stopped.</span></div>`;
  }
  // A bell that stopped ringing is silent by construction: nothing else on the page
  // would ever mention it. A dead delivery is the one notification failure the board
  // has to say out loud, because the reader is waiting for a push that will not come.
  const ob = opts.outbox && typeof opts.outbox === 'object' ? opts.outbox : null;
  // A retrying delivery is the same silence in a lighter shade: the watch fired, the
  // provider refused, and the board used to say nothing until the fifth failure made
  // the event dead. Saying it while it is still retrying is the whole point of
  // holding it instead of dropping it.
  if (ob && Number(ob.pending) > 0) {
    const n = Number(ob.pending);
    const next = Number(ob.nextAttemptAt) > 0 ? `${hhmm(ob.nextAttemptAt)} ET` : 'soon';
    banner += `<div class="banner warn"><strong>Watch delivery retrying</strong>
      <span>${n} notification${n === 1 ? '' : 's'} has not been delivered yet${ob.pendingReason ? ` \u2014 ${esc(ob.pendingReason)}` : ''}. Next attempt ${next}. The event is held, not lost.</span></div>`;
  }
  if (ob && Number(ob.dead) > 0) {
    banner += `<div class="banner bad"><strong>Watch delivery failing</strong>
      <span>${Number(ob.dead)} notification${Number(ob.dead) === 1 ? '' : 's'} could not be delivered after every retry${ob.lastReason ? ` \u2014 ${esc(ob.lastReason)}` : ''}. The watch is still armed; that event will not be retried.</span></div>`;
  }

  const freqRows = (freq || [])
    .map(
      (f) => `<tr><td>{ORIGIN}&rarr;${esc(f.dest)}</td><td>${esc(f.city)}</td><td>opened on ${f.opened} of ${f.of} ${esc(f.weekday)}${f.of === 1 ? '' : 's'}</td></tr>`
    )
    .join('');

  return fillOrigin(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{ORIGIN} GoWild</title>
${basePath ? `<link rel="manifest" href="${basePath}/manifest.webmanifest">` : ''}
<meta name="theme-color" content="#0a0a09">
<style>
  :root {
    color-scheme: dark;
    --ink:#0a0a09; --ink-2:#111110; --ink-3:#191917;
    --bone:#f4f0e5; --bone-2:#c9c3b6; --dim:#8d877a; --faint:#5d5950;
    --rule:#26241f; --rule-2:#3a362f;
    --acid:#d9f24d; --warn:#f0ad3c; --bad:#ff5c3d;
    --sans:"Helvetica Neue",Helvetica,Arial,"Segoe UI",system-ui,sans-serif;
    --display:"Arial Narrow","Helvetica Neue",Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono","Segoe UI Mono",Menlo,Consolas,monospace;
  }
  * { box-sizing: border-box; }
  body { margin:0 auto; max-width:820px; padding:18px 18px 34px; background:var(--ink);
         color:var(--bone); font:14px/1.45 var(--sans); overflow-x:hidden;
         -webkit-font-smoothing:antialiased; -webkit-text-size-adjust:100%; }
  /* matte stock, not glass: a hairline print screen over the whole sheet */
  body::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none;
                 background:repeating-linear-gradient(0deg,rgba(255,255,255,.015) 0 1px,transparent 1px 3px); }
  body > * { position:relative; z-index:1; }

  /* masthead — record-sleeve lockup over a departure board */
  .mast { display:flex; flex-direction:column; gap:9px; padding:0 0 13px; border-bottom:1px solid var(--rule-2); }
  .mast-top { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .kicker { display:flex; align-items:center; gap:7px; min-width:0; flex:none; white-space:nowrap;
            font-family:var(--mono); font-size:8.5px; letter-spacing:.2em; text-transform:uppercase; color:var(--dim); }
  .kicker .live { flex:none; width:5px; height:5px; background:var(--acid); font-style:normal;
                  box-shadow:0 0 0 2px rgba(217,242,77,.16); }
  .stamp { font-family:var(--mono); font-size:9.5px; letter-spacing:.05em; color:var(--dim);
           min-width:0; text-align:right; }
  .stamp.stale { color:var(--warn); }
  h1 { margin:0; display:flex; align-items:center; flex-wrap:wrap; gap:11px;
       font-family:var(--display); font-weight:700; font-size:clamp(38px,12.5vw,58px);
       line-height:.84; letter-spacing:-.025em; text-transform:uppercase; }
  h1 .o { color:var(--bone); }
  h1 .bar { flex:none; width:2px; height:.6em; background:var(--rule-2); }
  h1 .g { color:var(--acid); letter-spacing:-.035em; }
  .strap { display:flex; flex-wrap:wrap; gap:4px 0;
           font-family:var(--mono); font-size:8.5px; letter-spacing:.15em; text-transform:uppercase; color:var(--bone-2); }
  .strap > span + span { border-left:1px solid var(--rule-2); margin-left:11px; padding-left:11px; }

  /* banners and health */
  .banner { margin:0 0 10px; padding:9px 12px; display:flex; flex-direction:column; gap:3px;
            border:1px solid var(--rule-2); border-left-width:3px; background:var(--ink-2);
            font-size:12px; line-height:1.5; color:var(--bone-2); }
  .banner strong { font-family:var(--mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--bone); }
  .banner.bad { border-color:#5c2a22; border-left-color:var(--bad); background:#160e0c; color:#f0b6ab; }
  .banner.warn { border-color:#5c4520; border-left-color:var(--warn); background:#161207; color:#e8c894; }
  .banner code { font-family:var(--mono); font-size:11px; color:var(--bone); background:#000;
                 border:1px solid var(--rule-2); padding:5px 7px; overflow-x:auto; }
  .meta { margin:10px 0 8px; font-family:var(--mono); font-size:9px; letter-spacing:.04em;
          color:var(--faint); line-height:1.65; }
  .cov { margin:0 0 12px; font-family:var(--mono); font-size:9px; color:var(--dim); }
  .cov strong { color:var(--warn); }

  /* date panels */
  section.date { margin:14px 0 0; padding:0 14px 2px; border:1px solid var(--rule); background:var(--ink-2); }
  .dhead { display:flex; align-items:flex-start; gap:11px; padding:11px 0 9px; border-bottom:1px solid var(--rule); }
  .idx { padding-top:4px; font-family:var(--mono); font-size:9px; letter-spacing:.08em; color:var(--faint); }
  .dtitles { flex:1; min-width:0; }
  h2 { margin:0; display:flex; align-items:center; flex-wrap:wrap; gap:8px;
       font-family:var(--display); font-weight:700; font-size:25px; line-height:1;
       letter-spacing:-.015em; text-transform:uppercase; color:var(--bone); }
  .dsub { display:block; margin-top:6px; font-family:var(--mono); font-size:9px;
          letter-spacing:.15em; text-transform:uppercase; color:var(--dim); }
  .dsub .from { color:var(--acid); }
  .perm { padding-top:2px; font-family:var(--mono); font-size:11px; color:var(--faint); text-decoration:none; }
  .perm:hover { color:var(--acid); }

  /* rows — time rail, itinerary, fare */
  ul.rows { list-style:none; margin:0; padding:0; }
  li.row { display:grid; grid-template-columns:60px minmax(0,1fr) auto; column-gap:12px;
           align-items:start; padding:10px 0; border-top:1px solid var(--rule); }
  li.row:first-child { border-top:0; }
  .dep { padding-top:1px; font-family:var(--mono); font-size:12px; letter-spacing:-.02em;
         color:var(--bone); font-variant-numeric:tabular-nums; }
  .dep time { display:block; }
  .main { min-width:0; }
  .dest { margin:0; display:flex; align-items:baseline; flex-wrap:wrap; gap:7px;
          font-family:var(--display); font-weight:700; font-size:16px; line-height:1.05;
          letter-spacing:.005em; text-transform:uppercase; color:var(--bone); }
  .dest b { font-family:var(--mono); font-size:9px; font-weight:600; letter-spacing:.12em; color:var(--acid); }
  .sub { margin:4px 0 0; display:flex; align-items:center; flex-wrap:wrap; gap:4px 11px;
         font-family:var(--mono); font-size:10px; letter-spacing:.02em; color:var(--dim);
         font-variant-numeric:tabular-nums; }
  .sub .arr, .sub .leave { color:var(--bone-2); }
  .sub .leave.tight { color:var(--warn); }
  .sub .seat.out { color:var(--bad); }
  .sub .seat.unk { color:var(--faint); }
  .badge { display:inline-flex; align-items:center; padding:2px 5px; border:1px solid;
           font-family:var(--mono); font-size:8px; font-weight:600; letter-spacing:.12em;
           text-transform:uppercase; line-height:1.3; white-space:nowrap; }
  .badge.nonstop { color:var(--acid); border-color:rgba(217,242,77,.45); }
  .badge.stops { color:var(--dim); border-color:var(--rule-2); }
  .badge.peak { color:var(--warn); border-color:rgba(240,173,60,.45); }
  .nd { color:var(--warn); font-weight:700; }
  .fare { text-align:right; white-space:nowrap; }
  .fare .amt { display:block; font-family:var(--mono); font-size:18px; font-weight:600; line-height:1.1;
               letter-spacing:-.045em; color:var(--acid); font-variant-numeric:tabular-nums; }
  .fare .unit { display:block; margin-top:3px; font-family:var(--mono); font-size:8px;
                letter-spacing:.13em; text-transform:uppercase; color:var(--faint); }
  /* Four actions now share this strip, so it wraps as a unit and never splits a
     label: "SEARCH" with its arrow on the next line reads like two controls. */
  .acts { display:flex; flex-wrap:wrap; gap:15px; row-gap:8px; margin-top:7px; }
  .act { flex:none; white-space:nowrap; padding:0 0 2px; border:0; border-bottom:1px solid var(--rule-2); background:none;
         font-family:var(--mono); font-size:8px; font-weight:600; letter-spacing:.14em;
         text-transform:uppercase; color:var(--dim); cursor:pointer; }
  .act:hover, .act:focus-visible { color:var(--acid); border-color:var(--acid); outline:none; }
  .act[aria-pressed="true"] { color:var(--acid); border-color:var(--acid); }
  body.pinned-mode li.row:not(.pinned) { opacity:.3; }
  li.row.pinned { box-shadow:inset 2px 0 0 var(--acid); }

  /* empty / failed / peak states — never a blank panel */
  .state { margin:11px 0; padding:2px 0 2px 11px; border-left:2px solid var(--rule-2);
           font-size:12.5px; line-height:1.5; color:var(--bone-2); }
  .state strong { color:var(--bone); }
  .state.bad { border-color:var(--bad); color:#f0b6ab; }
  .state.warn { border-color:var(--warn); color:#e8c894; }
  .state.peakbox { border-color:var(--warn); color:#e8c894; }
  .state.peakbox strong { display:block; margin-bottom:3px; font-family:var(--mono);
                          font-size:9px; letter-spacing:.13em; text-transform:uppercase; color:var(--warn); }

  /* the decision header: the answer above the fold, always */
  .decide { margin:14px 0 0; border:1px solid var(--rule-2); background:var(--ink-2); }
  .dtop { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:9px 12px 0; }
  .dk { font-family:var(--mono); font-size:8px; letter-spacing:.24em; text-transform:uppercase; color:var(--acid); }
  .dage { font-family:var(--mono); font-size:8px; letter-spacing:.1em; color:var(--faint); }
  .drows { margin:6px 0 0; }
  .drows li.row { padding:10px 12px; border-top:1px solid var(--rule); }
  .dnone { margin:0; padding:12px; font-size:12.5px; line-height:1.5; color:var(--bone-2); }
  .drule { margin:0; padding:8px 12px; border-top:1px solid var(--rule); font-family:var(--mono);
           font-size:8.5px; letter-spacing:.04em; line-height:1.6; color:var(--faint); }
  .drule.warn { color:var(--warn); }
  .drule.bad { color:var(--bad); }

  /* a reason is a card, not a debug line */
  .ecard { display:flex; align-items:flex-start; gap:11px; margin:12px 0; padding:12px;
           border:1px solid var(--rule); border-left:3px solid var(--rule-2); background:var(--ink); }
  .ecard .ico { flex:none; width:17px; height:17px; margin-top:1px; display:grid; place-items:center;
                border:1px solid var(--rule-2); font-family:var(--mono); font-size:9px; line-height:1; color:var(--dim); }
  .ecard .cbody { min-width:0; }
  .ecard b { display:block; margin-bottom:4px; font-family:var(--mono); font-size:8.5px;
             letter-spacing:.15em; text-transform:uppercase; color:var(--bone); }
  .ecard p { margin:0; font-size:12.5px; line-height:1.5; color:var(--bone-2); }
  .ecard p strong { color:var(--bone); }
  .ecard em { display:block; margin-top:6px; font-style:normal; font-family:var(--mono);
              font-size:8px; letter-spacing:.08em; line-height:1.6; color:var(--faint); }
  .ecard.bad { border-color:#5c2a22; border-left-color:var(--bad); }
  .ecard.bad .ico { color:var(--bad); border-color:#5c2a22; }
  .ecard.bad p { color:#f0b6ab; }
  .ecard.warn { border-color:#5c4520; border-left-color:var(--warn); }
  .ecard.warn .ico { color:var(--warn); border-color:#5c4520; }
  .ecard.warn p { color:#e8c894; }

  /* freshness on every date header, and a header that stays put while reading */
  .dhead { position:sticky; top:0; z-index:4; background:var(--ink-2); }
  .agechip { flex:none; margin-left:auto; align-self:flex-start; padding:2px 5px; border:1px solid var(--rule-2);
             font-family:var(--mono); font-size:7.5px; letter-spacing:.08em; color:var(--faint); white-space:nowrap; }
  .agechip.warn { color:var(--warn); border-color:rgba(240,173,60,.4); }
  .badge.best { color:var(--acid); border-color:rgba(217,242,77,.5); }

  /* find a departure: a filter, not a second copy of the list */
  .find { margin:12px 0 0; padding:10px 12px; border:1px solid var(--rule-2); background:var(--ink-2); }
  .findrow { display:flex; align-items:center; gap:9px; }
  .findrow label { flex:none; font-family:var(--mono); font-size:7.5px; letter-spacing:.2em;
                   text-transform:uppercase; color:var(--faint); }
  .findrow input { flex:1; min-width:0; padding:8px 10px; border:1px solid var(--rule); border-radius:0;
                   background:var(--ink); color:var(--bone); font:13px var(--sans);
                   -webkit-appearance:none; appearance:none; }
  .findrow input::placeholder { color:var(--faint); }
  .findrow input:focus { outline:none; border-color:var(--acid); }
  .findmeta { margin:7px 0 0; font-family:var(--mono); font-size:8px; letter-spacing:.05em; color:var(--faint); }
  .origins { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; margin-top:9px;
             padding-top:9px; border-top:1px solid var(--rule); }
  .olabel { font-family:var(--mono); font-size:7.5px; letter-spacing:.2em; text-transform:uppercase; color:var(--faint); }
  .origin { font-family:var(--mono); font-size:9px; letter-spacing:.12em; padding:3px 7px;
            border:1px solid var(--rule-2); color:var(--bone); }
  .origin.on { color:var(--acid); border-color:var(--acid); }
  .origin.off { color:var(--dim); }
  .origin em { font-style:normal; font-size:7.5px; letter-spacing:.02em; color:var(--faint); }
  .olater { margin:6px 0 0; font-family:var(--mono); font-size:7.5px; line-height:1.6;
            letter-spacing:.03em; color:var(--faint); }
  .fcount { font-family:var(--mono); font-size:7.5px; letter-spacing:.06em; color:var(--warn); }
  .nomatch { margin:12px 0; }
  [hidden] { display:none !important; }

  /* projected legs: a pattern, inked by how much evidence stands behind it */
  .plan { margin:14px 0 0; border:1px solid var(--rule-2); background:var(--ink-2); }
  .plead { margin:0; padding:8px 12px 0; font-family:var(--mono); font-size:8px;
           letter-spacing:.03em; line-height:1.7; color:var(--faint); }
  .pcards { list-style:none; margin:0; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .pcard { border:1px solid var(--rule); padding:10px; }
  .phead { display:flex; align-items:baseline; justify-content:space-between; gap:8px;
           font-family:var(--mono); font-size:8.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--faint); }
  .phead b { color:var(--bone); }
  .plegs { list-style:none; margin:9px 0 0; padding:0; display:flex; flex-direction:column; gap:8px; }
  .pleg { padding-left:9px; border-left:2px solid var(--rule-2); }
  .pleg.ok { border-left-color:var(--acid); }
  .pleg.mid { border-left-color:var(--bone-2); }
  .pleg.weak { border-left-style:dashed; border-left-color:var(--faint); }
  .ptime { font-family:var(--mono); font-size:10px; letter-spacing:.06em; color:var(--bone-2); }
  .ptime b { letter-spacing:.14em; color:var(--bone); }
  .pleg.weak .ptime, .pleg.weak .ptime b { color:var(--dim); }
  .pmeta { margin-top:3px; font-family:var(--mono); font-size:7.5px;
           letter-spacing:.04em; color:var(--faint); }
  .pconf { letter-spacing:.12em; text-transform:uppercase; }
  .pconf.ok { color:var(--acid); }
  .pconf.mid { color:var(--bone-2); }
  .pconf.weak { color:var(--warn); }
  .pcard .act.arm { margin-top:10px; }

  /* what fired, so a push and its row are the same object to the eye */
  .evlog { margin:12px 0 0; padding:9px 0; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); }
  .evlog summary { font-size:8.5px; }
  .evnote { margin:8px 0 0; font-family:var(--mono); font-size:8px; letter-spacing:.04em;
            line-height:1.6; color:var(--faint); }
  .evlist { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:5px; }
  .ev { display:flex; align-items:baseline; gap:8px; font-family:var(--mono); font-size:9px;
        letter-spacing:.04em; color:var(--faint); }
  .ev b { color:var(--bone); letter-spacing:.1em; }
  .ev .ek { color:var(--bone-2); }
  .ev time { margin-left:auto; }
  .ev .est { min-width:62px; text-align:right; font-size:8px; letter-spacing:.12em; text-transform:uppercase; }
  .ev.sent .est { color:var(--acid); }
  .ev.pending .est { color:var(--warn); }
  .ev.dead .est { color:var(--bad); }
  /* an expired departing event is the system working, not a failure */
  .ev.dropped .est { color:var(--faint); }
  .ev.dead b { color:#f0b6ab; }
  .ev.ev-active { color:var(--bone); }
  .ev.ev-active .est { color:var(--acid); }

  /* a row a push pointed at, arrived rather than sought */
  li.row.is-focus { outline:1px solid var(--acid); outline-offset:2px; background:rgba(217,242,77,.05); }

  /* the route ledger, under the price it qualifies */
  .rcheck { display:block; margin-top:3px; font-family:var(--mono); font-size:7.5px;
            letter-spacing:.06em; color:var(--faint); white-space:nowrap; }
  .rcheck.warn { color:var(--warn); }
  /* Search sits under the price it belongs to: the row's controls stay three, and the
     act that leaves the page is next to the number it is about. */
  .fare .act.book { display:inline-block; margin-top:6px; text-decoration:none; font-size:7.5px; }

  /* pins, said out loud instead of being an invisible localStorage trick */
  .pinbar { display:none; align-items:baseline; gap:9px; margin:10px 0 0; padding:7px 10px;
            border:1px solid var(--acid); background:rgba(217,242,77,.06);
            font-family:var(--mono); font-size:8.5px; letter-spacing:.1em;
            text-transform:uppercase; color:var(--acid); }
  body.pinned-mode .pinbar { display:flex; }
  .pinbar b { color:var(--bone); letter-spacing:.06em; }
  .pinbar .act { margin-left:auto; color:var(--acid); border-color:var(--acid); }

  /* liner notes */
  .sect { margin:26px 0 0; display:flex; align-items:center; gap:10px;
          font-family:var(--mono); font-size:8.5px; letter-spacing:.24em; text-transform:uppercase; color:var(--faint); }
  .sect::after { content:""; flex:1; height:1px; background:var(--rule-2); }
  details { padding:12px 0; border-top:1px solid var(--rule); }
  .notes > details:first-of-type { border-top:0; padding-top:2px; }
  summary { display:flex; justify-content:space-between; align-items:center; gap:12px; cursor:pointer;
            list-style:none; font-family:var(--mono); font-size:9.5px; letter-spacing:.1em;
            text-transform:uppercase; color:var(--bone-2); }
  summary::-webkit-details-marker { display:none; }
  summary::after { content:"+"; font-size:13px; line-height:1; color:var(--acid); }
  details[open] summary { color:var(--bone); }
  details[open] summary::after { content:"−"; }
  details.folded { margin-top:10px; padding-bottom:0; }
  details.folded summary { font-family:var(--sans); font-size:12px; letter-spacing:0;
                           text-transform:none; color:var(--dim); }
  .note { margin:10px 0 0; font-size:11.5px; line-height:1.6; color:var(--dim); }
  .note strong { color:var(--bone-2); }
  table { width:100%; margin-top:10px; border-collapse:collapse;
          font-family:var(--mono); font-size:11px; font-variant-numeric:tabular-nums; }
  th { padding:0 4px 5px; text-align:left; font-size:8.5px; font-weight:600;
       letter-spacing:.1em; text-transform:uppercase; color:var(--faint); }
  td { padding:5px 4px; border-top:1px solid var(--rule); color:var(--bone-2); vertical-align:top; }
  td:first-child { white-space:nowrap; font-weight:600; color:var(--bone); }
  .heat { overflow-x:auto; margin-top:10px; }
  .heat table { min-width:420px; }
  .heat th, .heat td { padding:2px; border:0; text-align:center; }
  .heat th { font-size:9px; color:var(--faint); }
  .heat td:first-child { padding-right:8px; text-align:left; }
  .cell { display:inline-block; width:11px; height:11px; background:var(--ink-3); border:1px solid var(--rule); }
  .cell.on { background:var(--acid); border-color:var(--acid); }
  .hits { color:var(--faint); }
  .wk, .sc { font-size:9.5px; text-align:center; color:var(--faint); }
  .wk.on, .sc.on { color:var(--acid); font-weight:700; }
  .wk.part, .sc.part { color:var(--warn); }
  .wk.off, .wk.none, .sc.off, .sc.none { color:var(--faint); }
  .scflag { margin-left:5px; font-size:8px; letter-spacing:.04em; text-transform:none; }
  .scflag.rot { color:var(--warn); }
  .scflag.sta { color:var(--acid); }

  /* watch: the board's standing questions, and the sheet that arms one */
  .watchbar { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 12px; margin:12px 0 0;
              padding:9px 0; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); }
  .watchbar .wb { font-family:var(--mono); font-size:8px; letter-spacing:.2em; text-transform:uppercase; color:var(--acid); }
  .watchbar.empty .wb-note { flex:1 1 100%; font-size:11.5px; line-height:1.5; color:var(--dim); }
  .watchbar.empty .wb-note b { color:var(--bone-2); }
  .wchips { display:flex; flex-wrap:wrap; gap:6px; }
  .wchip { display:inline-flex; align-items:baseline; gap:7px; padding:3px 6px; border:1px solid var(--rule-2);
           font-family:var(--mono); font-size:9px; color:var(--bone-2); }
  .wchip b { color:var(--bone); letter-spacing:.06em; }
  .wchip em { font-style:normal; color:var(--dim); }
  .wchip i { font-style:normal; font-size:8px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); }
  .wchip .act { font-size:8px; }
  .wb-ch { flex:1 1 100%; font-family:var(--mono); font-size:8px; letter-spacing:.08em; color:var(--faint); }
  .sheet { position:fixed; left:0; right:0; bottom:0; z-index:60; margin:0 auto; max-width:820px;
           padding:14px 16px 18px; background:var(--ink-2); border-top:2px solid var(--acid);
           box-shadow:0 -18px 40px rgba(0,0,0,.65); }
  .sheet-head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; }
  .sheet-title { font-family:var(--display); font-weight:700; font-size:20px; letter-spacing:-.01em;
                 text-transform:uppercase; color:var(--bone); }
  .sheet-note { margin:7px 0 12px; font-size:11.5px; line-height:1.5; color:var(--dim); }
  .sheet-note.dim { margin:10px 0 0; font-family:var(--mono); font-size:8.5px; letter-spacing:.04em; color:var(--faint); }
  .sheet-row { display:flex; flex-wrap:wrap; align-items:center; gap:7px 12px; margin:0 0 9px; }
  .sheet-label { width:64px; font-family:var(--mono); font-size:8px; letter-spacing:.18em;
                 text-transform:uppercase; color:var(--faint); }
  .seg { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { padding:5px 9px; border:1px solid var(--rule-2); background:none; cursor:pointer;
          font-family:var(--mono); font-size:9px; letter-spacing:.06em; color:var(--dim); }
  .chip:hover, .chip:focus-visible { color:var(--bone); border-color:var(--bone-2); outline:none; }
  .chip[aria-pressed="true"] { color:var(--acid); border-color:var(--acid); }
  .chip.off { opacity:.5; cursor:not-allowed; border-style:dashed; }
  .sheet-foot { display:flex; flex-wrap:wrap; align-items:center; gap:14px; margin-top:13px; }
  .act.save { padding:6px 12px; border:1px solid var(--acid); background:var(--acid); color:#0a0a09; font-weight:700; }
  .act.save:hover, .act.save:focus-visible { background:none; color:var(--acid); }

  footer { margin:22px 0 0; padding-top:12px; border-top:1px solid var(--rule-2);
           font-family:var(--mono); font-size:9px; line-height:1.85; letter-spacing:.04em; color:var(--faint); }
  footer strong { color:var(--bone-2); }

  /* phone: the row keeps its three columns and gives back only what it can spare */
  @media (max-width:430px) {
    body { padding:16px 14px 30px; }
    /* the masthead is a signpost, not the answer: it must not push the best-move
       card past the first screen on the phone this is read on */
    h1 { font-size:clamp(34px,10.5vw,44px); }
    .mast { gap:7px; padding-bottom:11px; }
    .strap { font-size:8px; }
    li.row { grid-template-columns:54px minmax(0,1fr) auto; column-gap:10px; }
    .dep { font-size:11.5px; }
    .dest { font-size:15px; }
    .fare .amt { font-size:17px; }
    h2 { font-size:22px; }
    .dsub { letter-spacing:.12em; }
  }
</style></head>
<body>
<header class="mast">
  <div class="mast-top">
    <span class="kicker"><i class="live"></i>Frontier GoWild</span>
    <span class="stamp ${view.stale ? 'stale' : ''}">${esc(ago(view.ageMin))}${Number(view.oldestAgeMin) > Number(view.ageMin) ? ` &middot; ${view.oldestOffered ? 'oldest fare' : 'oldest data'} ${esc(ago(view.oldestAgeMin))}` : ''}</span>
  </div>
  <h1><span class="o">{ORIGIN}</span><span class="bar"></span><span class="g">GoWild</span></h1>
  <div class="strap">
    <span>Est. all-in &le; $${MAX_ALL_IN.toFixed(2)}</span>
    <span>${view.routeCount || 14} routes</span>
    <span>Read-only</span>
  </div>
</header>
${bestDealHtml(view, now, watchCtx)}
${coverageHtml(view)}
${banner}
${watchBar(watchCtx)}
${planHtml(watchCtx.ledger, watchCtx)}
${eventLogHtml(ob)}
${searchHtml(view, watchCtx)}
<div class="pinbar"><span>Pinned</span><b id="pinlist"></b><button type="button" class="act" id="pinclear">clear</button></div>
${view.dates.map((d, i) => dateSection(d, view, now, i, watchCtx)).join('')}
<p class="sect">Liner notes</p>
<div class="notes">
${flipHtml(state)}
${scheduleHtml(state)}
${heatmapHtml(state)}
${timingHtml(state)}
${pricingHtml(state)}
<details>
  <summary>Weekday opening history</summary>
  ${freqRows ? `<table>${freqRows}</table>` : '<p class="note">Not enough observations yet.</p>'}
</details>
</div>
<footer>
  Prices are <strong>estimated all-in</strong>: Frontier returns a single GoWild fare with no separate tax or fee
  breakdown, so the total cannot be independently verified.<br>
  Showing all-in &le; $${MAX_ALL_IN.toFixed(2)} &middot; ${view.routeCount || 14} routes &middot; ${esc(PEAK_LABEL)} on blackout dates.<br>
  ${view.sweep && view.sweep.routes && view.sweep.total && view.sweep.routes < view.sweep.total ? `Half-sweep mode: ${view.sweep.routes} of ${view.sweep.total} routes per run, so every route is re-checked within 30 minutes.<br>` : ''}
  ${view.sweep && view.sweep.quarantined ? `${view.sweep.quarantined} route${view.sweep.quarantined === 1 ? '' : 's'} retired after answering "not sold" &middot; FULL_SWEEP=1 re-checks them.<br>
  ` : ''}Read-only. Never touches booking or payment.
</footer>
<script>
window.__basePath = ${JSON.stringify(basePath)};
window.__wcfg = ${watchJson};
(function () {
  var PINS = 'gowild.pins';
  var CFG = window.__wcfg || { watches: [], channels: {} };
  var CH = ['push', 'email', 'text'];
  function watchOf(dest) {
    var list = CFG.watches || [];
    for (var i = 0; i < list.length; i++) if (list[i].dest === dest) return list[i];
    return null;
  }
  // The token is already in the path; reuse it rather than inventing a second one.
  function api(body) {
    var m = /^\\/s\\/([A-Za-z0-9_-]{8,})$/.exec(window.__basePath || '');
    if (!m) return Promise.resolve(null);
    return fetch('/api/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m[1] },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return null; }); }).catch(function () { return null; });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function closeSheet() {
    var s = document.getElementById('wsheet');
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }
  function openSheet(dest, date) {
    closeSheet();
    var have = watchOf(dest);
    var mode = have ? have.mode : 'date';
    var picked = {};
    for (var i = 0; i < CH.length; i++) {
      var st = (CFG.channels || {})[CH[i]] || {};
      picked[CH[i]] = !!st.ready && (have ? (have.channels || []).indexOf(CH[i]) !== -1 : true);
    }
    var box = el('div', 'sheet');
    box.id = 'wsheet';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Watch ' + dest);
    var head = el('div', 'sheet-head');
    head.appendChild(el('span', 'sheet-title', 'Watch ' + dest));
    var x = el('button', 'act sheet-x', 'close');
    x.type = 'button';
    x.addEventListener('click', closeSheet);
    head.appendChild(x);
    box.appendChild(head);
    box.appendChild(el('p', 'sheet-note', 'Alerts fire when seats open, sell out, get cheaper, or the flight is close to leaving.'));
    var scopes = el('div', 'sheet-row');
    scopes.appendChild(el('span', 'sheet-label', 'scope'));
    var seg = el('div', 'seg');
    var modeBtns = [];
    function paintMode() {
      for (var k = 0; k < modeBtns.length; k++) {
        modeBtns[k].setAttribute('aria-pressed', modeBtns[k].dataset.mode === mode ? 'true' : 'false');
      }
    }
    var options = [{ m: 'date', label: 'This date only' }, { m: 'always', label: 'Every date, until stopped' }];
    for (var j = 0; j < options.length; j++) {
      (function (o) {
        var b = el('button', 'chip', o.label);
        b.type = 'button';
        b.dataset.mode = o.m;
        b.addEventListener('click', function () { mode = o.m; paintMode(); });
        modeBtns.push(b);
        seg.appendChild(b);
      })(options[j]);
    }
    paintMode();
    scopes.appendChild(seg);
    box.appendChild(scopes);
    var sends = el('div', 'sheet-row');
    sends.appendChild(el('span', 'sheet-label', 'send to'));
    var chips = el('div', 'seg');
    for (var c = 0; c < CH.length; c++) {
      (function (ch) {
        var st = (CFG.channels || {})[ch] || {};
        var label = ch === 'push' ? 'phone push' : ch === 'email' ? 'email' : 'text';
        var b = el('button', st.ready ? 'chip' : 'chip off', st.ready ? label : label + ' - off');
        b.type = 'button';
        b.setAttribute('aria-pressed', picked[ch] ? 'true' : 'false');
        if (!st.ready) {
          b.disabled = true;
          b.title = st.reason || 'not set up';
        } else {
          b.addEventListener('click', function () {
            picked[ch] = !picked[ch];
            b.setAttribute('aria-pressed', picked[ch] ? 'true' : 'false');
          });
        }
        chips.appendChild(b);
      })(CH[c]);
    }
    sends.appendChild(chips);
    box.appendChild(sends);
    var why = el('p', 'sheet-note dim');
    var offs = [];
    for (var q = 0; q < CH.length; q++) {
      var s2 = (CFG.channels || {})[CH[q]] || {};
      if (!s2.ready) offs.push((s2.reason || 'not set up'));
    }
    why.textContent = offs.length ? offs.join(' \u00b7 ') : 'Every channel is set up on this Worker.';
    box.appendChild(why);
    var foot = el('div', 'sheet-foot');
    var save = el('button', 'act save', have ? 'Update watch' : 'Start watching');
    save.type = 'button';
    save.addEventListener('click', function () {
      var chans = [];
      for (var k = 0; k < CH.length; k++) if (picked[CH[k]]) chans.push(CH[k]);
      save.disabled = true;
      api({ dest: dest, mode: mode, date: mode === 'date' ? (have && have.date) || date : null, channels: chans }).then(function (r) {
        if (r && r.ok) location.reload();
        else { save.disabled = false; save.textContent = (r && r.message) || 'Not saved - try again'; }
      });
    });
    foot.appendChild(save);
    if (have) {
      var rm = el('button', 'act', 'Stop watching');
      rm.type = 'button';
      rm.addEventListener('click', function () { api({ dest: dest, remove: true }).then(function () { location.reload(); }); });
      foot.appendChild(rm);
    }
    var cancel = el('button', 'act', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeSheet);
    foot.appendChild(cancel);
    box.appendChild(foot);
    document.body.appendChild(box);
  }
  function pins() { try { return JSON.parse(localStorage.getItem(PINS) || '[]'); } catch (e) { return []; } }
  function applyPins() {
    var p = pins();
    document.body.classList.toggle('pinned-mode', p.length > 0);
    var lbl = document.getElementById('pinlist');
    if (lbl) lbl.textContent = p.length ? p.join(' \u00b7 ') : '';
    var rows = document.querySelectorAll('li.row');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], on = p.indexOf(r.dataset.dest) !== -1;
      r.classList.toggle('pinned', on);
      var b = r.querySelector('button.pin');
      if (b) { b.textContent = (on ? 'Unpin ' : 'Pin ') + r.dataset.dest; b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    }
  }
  function icsTime(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? m[1] + m[2] + m[3] + 'T' + m[4] + m[5] + '00' : null;
  }
  function ics(row) {
    var d = row.dataset, start = icsTime(d.dep), end = icsTime(d.arr);
    if (!start || !end) return null;
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    var price = Number(d.allin).toFixed(2);
    var L = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//{ORIGIN} GoWild//EN','CALSCALE:GREGORIAN',
      'BEGIN:VTIMEZONE','TZID:America/New_York',
      'BEGIN:DAYLIGHT','TZOFFSETFROM:-0500','TZOFFSETTO:-0400','TZNAME:EDT',
      'DTSTART:19700308T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT',
      'BEGIN:STANDARD','TZOFFSETFROM:-0400','TZOFFSETTO:-0500','TZNAME:EST',
      'DTSTART:19701101T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD',
      'END:VTIMEZONE','BEGIN:VEVENT',
      'UID:' + d.date + '-' + d.dest + '-' + start + '@rdu-gowild',
      'DTSTAMP:' + stamp,
      'DTSTART;TZID=America/New_York:' + start,
      'DTEND;TZID=America/New_York:' + end,
      'SUMMARY:{ORIGIN} to ' + d.dest + ' (GoWild $' + price + ')',
      'DESCRIPTION:Estimated all-in $' + price + '. Frontier publishes no tax or fee breakdown for GoWild fares.',
      'LOCATION:' + d.dest,'END:VEVENT','END:VCALENDAR'];
    return L.join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10);
  }
  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button.act') : null;
    if (!btn) return;
    if (btn.classList.contains('unwatch')) { api({ dest: btn.dataset.dest, remove: true }).then(function () { location.reload(); }); return; }
    var row = btn.closest('li.row');
    if (!row) return;
    if (btn.classList.contains('bell')) { openSheet(row.dataset.dest, row.dataset.date); return; }
    if (btn.classList.contains('ics')) {
      var body = ics(row);
      if (!body) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
      a.download = 'rdu-' + row.dataset.dest + '-' + row.dataset.date + '.ics';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      return;
    }
    var p = pins(), k = p.indexOf(row.dataset.dest);
    if (k === -1) p.push(row.dataset.dest); else p.splice(k, 1);
    localStorage.setItem(PINS, JSON.stringify(p));
    applyPins();
  });
  // Find a departure. This filters the rows already on the page: no request, no
  // second copy of the list, and no way for a result to disagree with the board. A
  // date left with no match states that instead of going blank, because an empty grid
  // is the one forbidden state here.
  (function () {
    var input = document.getElementById('q');
    if (!input) return;
    var clear = document.getElementById('qclear');
    var count = document.getElementById('qcount');
    // Only the rows the board actually offers. Folded options live inside a closed
    // details block under "N more under the ceiling": counting them here would print
    // 109 departures on a page whose own triage says 38.
    function offered(scope) {
      return [].slice.call(scope.querySelectorAll('li.row[data-dest]')).filter(function (r) {
        return !(r.closest && r.closest('details.folded'));
      });
    }
    // Date sections only: the decision header's hero row is the answer, not a result,
    // so it is never filtered away and never counted as one.
    var sections = [].slice.call(document.querySelectorAll('section.date'));
    var rows = [];
    for (var si = 0; si < sections.length; si++) rows = rows.concat(offered(sections[si]));
    var total = rows.length;
    function label(shown, q) {
      if (!count) return;
      count.textContent = q
        ? shown + ' of ' + total + ' departure' + (total === 1 ? '' : 's') + ' match \u201c' + q + '\u201d'
        : total + ' departure' + (total === 1 ? '' : 's') + ' on this board';
    }
    function run() {
      var q = String(input.value || '').trim().toLowerCase();
      var shown = 0;
      for (var i = 0; i < rows.length; i++) {
        var hay = ((rows[i].getAttribute('data-dest') || '') + ' ' + (rows[i].getAttribute('data-city') || '')).toLowerCase();
        var hit = !q || hay.indexOf(q) >= 0;
        rows[i].hidden = !hit;
        if (hit) shown += 1;
      }
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        var all = offered(sec);
        var vis = all.filter(function (r) { return !r.hidden; }).length;
        var chip = sec.querySelector('.fcount');
        if (!chip) {
          chip = document.createElement('span');
          chip.className = 'fcount';
          var titles = sec.querySelector('.dtitles');
          if (titles) titles.appendChild(chip);
        }
        if (q && all.length) { chip.hidden = false; chip.textContent = vis + ' of ' + all.length; }
        else chip.hidden = true;
        var none = sec.querySelector('.nomatch');
        var wanted = q && all.length && vis === 0;
        if (wanted) {
          if (!none) {
            none = document.createElement('div');
            none.className = 'state ecard nomatch';
            // Under the rows, not under the folded summary: the reader is looking at
            // the list they filtered, not at the appendices beneath it.
            var fold = sec.querySelector('details.folded');
            if (fold && fold.parentNode) fold.parentNode.insertBefore(none, fold);
            else sec.appendChild(none);
            var ico = document.createElement('span');
            ico.className = 'ico';
            ico.setAttribute('aria-hidden', 'true');
            ico.textContent = 'i';
            var body = document.createElement('div');
            body.className = 'cbody';
            none.appendChild(ico);
            none.appendChild(body);
          }
          var cbody = none.querySelector('.cbody');
          cbody.textContent = '';
          var b = document.createElement('b');
          b.textContent = 'No match on this date';
          var p = document.createElement('p');
          p.textContent = 'Nothing on this date matches \u201c' + q + '\u201d. Clear the search to see all ' + all.length + '.';
          cbody.appendChild(b);
          cbody.appendChild(p);
          none.hidden = false;
        } else if (none) {
          none.hidden = true;
        }
      }
      if (clear) clear.hidden = !input.value;
      label(shown, q);
    }
    input.addEventListener('input', run);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; run(); }
    });
    if (clear) {
      clear.addEventListener('click', function () { input.value = ''; run(); input.focus(); });
    }
  })();

  // A push names the event it was about: /?focus=<eventKey>. Land on the flight
  // itself, with the log entry that fired it lit, instead of at the top of a long
  // page. Nothing is fetched -- both the row and the event are already here.
  (function () {
    var want = '';
    try { want = new URLSearchParams(location.search).get('focus') || ''; } catch (e) { want = ''; }
    if (!want) return;
    var ev = null;
    var evs = document.querySelectorAll('.ev');
    for (var i = 0; i < evs.length; i++) {
      if (evs[i].getAttribute('data-ev') === want) { ev = evs[i]; break; }
    }
    if (!ev) return;
    ev.className += ' ev-active';
    // The entry that fired the push has to be visible, not folded inside a summary.
    var box = ev.parentNode;
    while (box && box.nodeName !== 'DETAILS') box = box.parentNode;
    if (box) box.open = true;
    var spec = (ev.getAttribute('data-target') || '').split('|');
    if (spec.length < 2) return;
    var rows = document.querySelectorAll('li.row');
    for (var j = 0; j < rows.length; j++) {
      var dep = rows[j].getAttribute('data-dep') || '';
      if (rows[j].getAttribute('data-date') === spec[0] && dep.indexOf(spec[1]) >= 0) {
        rows[j].className += ' is-focus';
        rows[j].scrollIntoView({ block: 'center' });
        break;
      }
    }
  })();

  // One confirmation to arm a projected leg. It creates the same watch the bell
  // creates -- no second kind of subscription, no separate store -- so the armed leg
  // rides the normal flow: the next sweep confirms it, a failure is visible, and the
  // push points at its row like any other.
  function readyChannels() {
    var out = [];
    var ch = (CFG && CFG.channels) || {};
    for (var k in ch) if (ch[k] && ch[k].ready) out.push(k);
    return out;
  }
  var arms = document.querySelectorAll('button.arm');
  for (var ai = 0; ai < arms.length; ai++) {
    (function (b) {
      if (!readyChannels().length) {
        b.disabled = true;
        b.title = 'no delivery channel is set up on this Worker';
        return;
      }
      b.addEventListener('click', function () {
        b.disabled = true;
        api({ dest: b.getAttribute('data-dest'), mode: 'always', channels: readyChannels() }).then(function (r) {
          if (r && r.ok) location.reload();
          else { b.disabled = false; b.textContent = (r && r.message) || 'Not saved'; }
        });
      });
    })(arms[ai]);
  }

  var pinClear = document.getElementById('pinclear');
  if (pinClear) {
    pinClear.addEventListener('click', function () {
      localStorage.setItem(PINS, '[]');
      applyPins();
    });
  }
  applyPins();
  setInterval(function () { if (!document.hidden && !document.getElementById('wsheet')) location.reload(); }, 60000);
  if (window.__basePath && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(window.__basePath + '/sw.js', { scope: window.__basePath }).catch(function () {});
  }
})();
</script>
</body></html>`);
}
