import { MAX_ALL_IN, PEAK_LABEL, MAX_STOPS, MAX_DURATION_MIN, ORIGIN } from './routes.js';
import { bookabilityHeatmap } from './heatmap.mjs';
import { releaseTiming, MIN_SAMPLES } from './timing.mjs';
import { weeklyPattern } from './schedule.mjs';
import { fareMechanics, median, MIN_SAMPLES as FARE_MIN } from './pricing.mjs';

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
  const d = new Date(`${iso}T12:00:00Z`);
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

function rowHtml(r) {
  const nextDay = dayOf(r.arr) && dayOf(r.dep) && dayOf(r.arr) !== dayOf(r.dep);
  const arrive = `${fmtTime(r.arr)}${nextDay ? ' <span class="nd">+1</span>' : ''}`;
  const data =
    `data-date="${esc(r.date)}" data-dest="${esc(r.dest)}" data-city="${esc(r.city)}" ` +
    `data-dep="${esc(r.dep)}" data-arr="${esc(r.arr)}" data-allin="${esc(r.allin)}" ` +
    `data-stops="${esc(r.stops)}"`;
  return `<li class="row" ${data}>
      <div class="line1">
        <span class="dest">${esc(r.city)} <b>${esc(r.dest)}</b></span>
        <span class="price">$${r.allin.toFixed(2)}</span>
      </div>
      <div class="line2">
        <span class="leg">${fmtTime(r.dep)} &rarr; ${arrive}</span>
        ${r.nonstop ? '<span class="badge nonstop">NONSTOP</span>' : `<span class="badge stops">${esc(r.stops)}</span>`}
      </div>
      <div class="line3">
        <span>${esc(fmtDuration(r.dur))}</span>
        ${r.leaveBy ? `<span class="${r.tight ? 'tight' : ''}">leave by ${fmtTime(r.leaveBy)}${r.tight ? ' &middot; leave now' : ''}</span>` : ''}
        <span>${r.seats === 0 ? 'sold out' : r.seats ? `${r.seats} seat${r.seats === 1 ? '' : 's'} left` : 'seats unknown'}</span>
      </div>
      <div class="acts">
        <button type="button" class="act pin" aria-pressed="false">Pin ${esc(r.dest)}</button>
        <button type="button" class="act ics">Calendar</button>
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
  above: (d) => `${d.goWild} GoWild departure${d.goWild === 1 ? '' : 's'}, all above $${MAX_ALL_IN.toFixed(2)}.`,
  nogowild: (d) => `${d.total} departure${d.total === 1 ? '' : 's'}, but Frontier released no GoWild seats.`,
};

function dateSection(d, view, now) {
  const label = d.blackout || d.peak ? `<span class="badge peak">${esc(PEAK_LABEL)}</span>` : '';
  const freshN = d.freshRoutes == null ? d.routesScanned : d.freshRoutes;
  const carriedNote = d.carriedRoutes
    ? ` &middot; ${d.carriedRoutes} carried${d.carriedAt ? ` from ${esc(hhmm(d.carriedAt))} ET` : ''}`
    : '';
  let body;

  if (d.status === 'ok') {
    // Only departures that can still be booked are listed. If some of this date's
    // options have already flown, that is stated rather than left as a silent gap.
    const live = d.rows;
    body = `<ul class="rows">${live.map(rowHtml).join('')}</ul>`;
    const gone = Number(d.pastCount) || 0;
    if (gone) {
      body += `<div class="state">${gone} more under $${MAX_ALL_IN.toFixed(2)} on this date already departed and cannot be booked.</div>`;
    }
    if (d.folded && d.folded.length) {
      const cap = `${MAX_STOPS} stop${MAX_STOPS === 1 ? '' : 's'} / ${Math.round(MAX_DURATION_MIN / 60)}h`;
      body += `<details class="folded"><summary>${d.folded.length} more under $${MAX_ALL_IN.toFixed(2)} — beyond ${cap}</summary><ul class="rows">${d.folded.map(rowHtml).join('')}</ul></details>`;
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
    body = `<div class="state peakbox"><strong>${esc(PEAK_LABEL)}</strong><span>GoWild is not bookable at the normal fare on this date${d.lowest ? ` — lowest GoWild fare seen $${d.lowest.toFixed(2)}` : ''}.</span></div>`;
  } else if (d.status === 'blocked') {
    body = `<div class="state bad">${esc(STATE_COPY.blocked)}</div>`;
  } else if (d.status === 'error') {
    body = `<div class="state bad">${esc(STATE_COPY.error)}</div>`;
  } else if (d.status === 'folded') {
    const cap = `${MAX_STOPS} stop${MAX_STOPS === 1 ? '' : 's'} / ${Math.round(MAX_DURATION_MIN / 60)}h`;
    body = `<div class="state warn">${d.folded.length} GoWild option${d.folded.length === 1 ? '' : 's'} under $${MAX_ALL_IN.toFixed(2)}, all beyond ${cap}.</div><details class="folded" open><summary>Show them anyway</summary><ul class="rows">${d.folded.map(rowHtml).join('')}</ul></details>`;
  } else if (d.status === 'above') {
    // "Nothing under $50" is only useful if it says how far off it was. The
    // cheapest GoWild fare is already measured, so the gap is stated rather than
    // leaving the reader to guess whether it was $51 or $300.
    const gap = typeof d.lowest === 'number' ? d.lowest - MAX_ALL_IN : null;
    const detail =
      gap === null
        ? ''
        : ` Cheapest was <strong>$${d.lowest.toFixed(2)}</strong>, $${gap.toFixed(2)} over the ceiling.`;
    body = `<div class="state warn">${esc(STATE_COPY.above(d))}${detail}</div>`;
  } else if (d.status === 'noflights') {
    body = `<div class="state">${esc(STATE_COPY.noflights)}</div>`;
  } else if (d.status === 'nogowild' && view && view.zero && Number(view.zero.count) >= 3 && view.zero.since) {
    const hrs = Math.max(1, Math.round((now - view.zero.since) / 3600000));
    body = `<div class="state warn">${d.total} departure${d.total === 1 ? '' : 's'}, but Frontier released no GoWild seats. <strong>No GoWild from ${esc(PAGE_ORIGIN)} in ${view.zero.count} sweeps over ${hrs}h</strong> &mdash; that reads as a station-level decision, not a quiet day.</div>`;
  } else {
    body = `<div class="state warn">${esc(STATE_COPY.nogowild(d))}</div>`;
  }

  return `<section class="date" id="d-${esc(d.date)}">
    <h2>${esc(shortDay(d.date))} ${label}<a class="perm" href="#d-${esc(d.date)}" aria-label="Link to ${esc(d.date)}">#</a></h2>
    ${body}
    <p class="meta">${
      d.carriedReason === 'day-over' && !freshN
        ? `${d.routesScanned} routes carried${d.carriedAt ? ` from ${esc(hhmm(d.carriedAt))} ET` : ''} &middot; departures for this date have finished`
        : `${freshN}/${d.routesScanned} routes re-checked${d.failedRoutes ? ` &middot; ${d.failedRoutes} failed` : ''}${d.blockedRoutes ? ` &middot; ${d.blockedRoutes} blocked` : ''}${carriedNote}`
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
      const label = r.confident
        ? `seats open around ${esc(hourLabel(r.medianHour))} local${lead}`
        : `seen ${esc(hourLabel(r.medianHour))} local &middot; ${r.samples} observation${r.samples === 1 ? '' : 's'}${lead}, not yet a pattern`;
      return `<tr><td>${esc(r.dest)}</td><td>${label}</td></tr>`;
    })
    .join('');
  return `<details><summary>When seats appear</summary><table>${body}</table>
    <p class="note">A route needs ${MIN_SAMPLES}+ observations before this claims a time of day.</p></details>`;
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
<meta name="theme-color" content="#0d0f13">
<style>
  :root { color-scheme: dark; --bg:#0d0f13; --card:#161a21; --line:#242a34; --txt:#e8ecf2; --dim:#8b95a5; --go:#3fb950; --bad:#f85149; --warn:#d29922; }
  * { box-sizing: border-box; }
  body { margin:0; padding:12px; background:var(--bg); color:var(--txt);
         font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:760px; margin-inline:auto; overflow-x:hidden; }
  header { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; margin:4px 0 12px; }
  h1 { font-size:17px; margin:0; letter-spacing:.3px; }
  h1 span { color:var(--go); }
  .stamp { font-size:12px; color:var(--dim); margin-left:auto; }
  .stamp.stale { color:var(--warn); font-weight:600; }
  .banner { border-radius:10px; padding:10px 12px; margin:0 0 10px; font-size:13px; display:flex; flex-direction:column; gap:4px; }
  .banner.bad { background:#2b1517; border:1px solid #5c2226; color:#ffb3ae; }
  .banner.warn { background:#2a2213; border:1px solid #5c4a1d; color:#f0d48a; }
  .banner code { background:#000; padding:4px 6px; border-radius:6px; font-size:12px; overflow-x:auto; }
  section.date { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; margin:0 0 12px; }
  h2 { font-size:14px; margin:0 0 10px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; color:var(--dim); font-weight:600; }
  ul.rows { list-style:none; margin:0; padding:0; }
  li.row { border-top:1px solid var(--line); padding:9px 0; }
  li.row:first-child { border-top:0; padding-top:0; }
  .line1, .line2, .line3 { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
  .dest { font-weight:600; font-size:15px; }
  .dest b { color:var(--dim); font-weight:600; font-size:12px; }
  .price { font-weight:700; color:var(--go); font-size:16px; }
  .leg { font-variant-numeric:tabular-nums; color:#c4ccd8; font-size:13px; }
  .line3 { color:var(--dim); font-size:12px; }
  .line3 .tight { color:var(--warn); font-weight:600; }
  .perm { color:#4a5260; text-decoration:none; font-size:11px; margin-left:4px; }
  .badge { font-size:10px; font-weight:700; letter-spacing:.4px; padding:2px 6px; border-radius:5px; text-transform:uppercase; }
  .badge.nonstop { background:#12331c; color:#5fd67a; border:1px solid #235c33; }
  .badge.stops { background:#1b2029; color:#93a0b2; border:1px solid #2b3441; }
  .badge.peak { background:#3a2a10; color:#f3c675; border:1px solid #6b4d16; text-transform:none; font-size:11px; }
  .nd { color:var(--warn); font-weight:700; font-size:11px; }
  .state { padding:10px; border-radius:8px; background:#1b2029; color:#b9c3d1; font-size:13px; display:flex; flex-direction:column; gap:3px; }
  .state.bad { background:#2b1517; color:#ffb3ae; }
  .state.warn { background:#2a2213; color:#f0d48a; }
  .state.peakbox { background:#2a2213; color:#f3c675; border:1px solid #5c4a1d; }
  .note { margin:8px 0 0; font-size:12px; color:var(--dim); }
  .meta { margin:8px 0 0; font-size:11px; color:#5f6875; }
  .acts { display:flex; gap:6px; margin-top:7px; }
  .act { font:inherit; font-size:11px; padding:4px 8px; border-radius:6px; cursor:pointer;
         background:#1b2029; color:#93a0b2; border:1px solid #2b3441; }
  .act:active { background:#242c38; }
  .act[aria-pressed="true"] { background:#12331c; color:#5fd67a; border-color:#235c33; }
  body.pinned-mode li.row:not(.pinned) { opacity:.32; }
  li.row.pinned { box-shadow:inset 3px 0 0 var(--go); }
  .heat { overflow-x:auto; margin-top:10px; }
  .heat table { min-width:420px; }
  .heat th, .heat td { padding:2px; border:0; }
  .heat th { font-size:10px; color:#5f6875; font-weight:600; }
  .heat td { text-align:center; }
  .cell { display:inline-block; width:12px; height:12px; border-radius:3px; background:#20262f; }
  .cell.on { background:#2ea043; }
  .hits { font-size:10px; color:#5f6875; }
  .wk { font-size:10px; padding:2px 3px; text-align:center; color:#5f6875; }
  .wk.on { color:#5fd67a; font-weight:700; }
  .wk.part { color:#f0d48a; font-weight:600; }
  .wk.off, .wk.none { color:#4a5260; }
  .sc { font-size:10px; padding:2px 3px; text-align:center; color:#5f6875; }
  .sc.on { color:#5fd67a; font-weight:700; }
  .sc.part { color:#f0d48a; font-weight:600; }
  .sc.off, .sc.none { color:#4a5260; }
  .scflag { font-size:9px; font-weight:600; letter-spacing:0; margin-left:4px; }
  .scflag.rot { color:#f0d48a; }
  .scflag.sta { color:#5fd67a; }
  details { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
  summary { cursor:pointer; font-size:13px; color:#c4ccd8; }
  table { width:100%; border-collapse:collapse; margin-top:10px; font-size:12px; }
  td { padding:5px 4px; border-top:1px solid var(--line); color:#b9c3d1; }
  td:first-child { white-space:nowrap; font-weight:600; }
  footer { margin:14px 0 8px; font-size:11px; color:#5f6875; line-height:1.6; }
</style></head>
<body>
<header>
  <h1>{ORIGIN} <span>GoWild</span></h1>
  <span class="stamp ${view.stale ? 'stale' : ''}">${esc(ago(view.ageMin))}</span>
</header>
${banner}
${view.dates.map((d) => dateSection(d, view, now)).join('')}
${flipHtml(state)}
${scheduleHtml(state)}
${heatmapHtml(state)}
${timingHtml(state)}
${pricingHtml(state)}
<details>
  <summary>Weekday opening history</summary>
  ${freqRows ? `<table>${freqRows}</table>` : '<p class="note">Not enough observations yet.</p>'}
</details>
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
(function () {
  var PINS = 'gowild.pins';
  function pins() { try { return JSON.parse(localStorage.getItem(PINS) || '[]'); } catch (e) { return []; } }
  function applyPins() {
    var p = pins();
    document.body.classList.toggle('pinned-mode', p.length > 0);
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
    var row = btn.closest('li.row');
    if (!row) return;
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
  applyPins();
  setInterval(function () { if (!document.hidden) location.reload(); }, 60000);
  if (window.__basePath && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(window.__basePath + '/sw.js', { scope: window.__basePath }).catch(function () {});
  }
})();
</script>
</body></html>`);
}
