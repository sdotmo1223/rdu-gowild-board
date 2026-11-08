import { validTopic } from './alerts.mjs';
import { buildBoard, MAX_ROW_AGE_MIN } from './board.js';
import { easternStamp } from './routes.js';

// Watches: "tell me about PHL" as a standing question, not a one-off read.
//
// A watch is a record in KV, not a browser setting: a phone that has never opened
// the page must still get the push, and the collector's sweep is the only event
// that can answer the question. Everything here is pure except the three functions
// that touch KV or the network, so the rules -- when an event fires, when it stays
// silent -- are testable without a Worker or a phone.

export const WATCH_MODES = ['date', 'always'];
export const CHANNELS = ['push', 'email', 'text'];

// "Landing in three hours" is the point where a seat is still worth hearing about
// and an airport run is still possible. Beyond that it is a notification about a
// plane you cannot catch.
export const DEPARTING_SOON_MIN = 180;

// The same event on the same departure does not repeat inside six hours: a fare
// flapping either side of $50 would otherwise buzz on every sweep.
export const WATCH_REPEAT_MS = 6 * 3600 * 1000;

export const WATCH_KEY_PREFIX = 'w:';

const DEST_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function watchKey(profile, dest) {
  return `${WATCH_KEY_PREFIX}${String(profile || 'rdu').toLowerCase()}:${String(dest || '').toUpperCase()}`;
}

// A malformed request is refused with a reason a human can act on. It is never
// coerced into a watch: "watch WIL" that silently becomes "watch nothing" is the
// same failure as an empty grid.
export function normalizeWatch(input, now = Date.now(), known = null) {
  const src = input && typeof input === 'object' ? input : {};
  const dest = String(src.dest == null ? '' : src.dest).trim().toUpperCase();
  if (!DEST_RE.test(dest)) {
    return { ok: false, reason: 'dest must be a three-letter airport code', field: 'dest' };
  }
  if (Array.isArray(known) && known.length && !known.includes(dest)) {
    return { ok: false, reason: `${dest} is not served from this profile`, field: 'dest' };
  }
  const mode = WATCH_MODES.includes(src.mode) ? src.mode : 'date';
  let date = null;
  if (mode === 'date') {
    date = String(src.date == null ? '' : src.date).trim();
    if (!DATE_RE.test(date)) {
      return { ok: false, reason: 'a date watch needs a YYYY-MM-DD date', field: 'date' };
    }
  }
  const asked = Array.isArray(src.channels) ? src.channels : [];
  const channels = CHANNELS.filter((c) => asked.includes(c));
  if (!channels.length) {
    return { ok: false, reason: 'pick at least one delivery channel', field: 'channels' };
  }
  return {
    ok: true,
    watch: {
      dest,
      mode,
      date,
      channels,
      createdAt: Number(src.createdAt) || now,
      updatedAt: now,
      last: null,
      announced: [],
      lastEvent: null,
    },
  };
}

// Which channels can actually deliver, and why the others cannot. The reason is a
// missing variable name, never its value, and it is shown in the page: a channel
// that is switched off has to say so rather than accept a watch it will not send.
export function channelStatus(env) {
  const e = env || {};
  const pushReady = validTopic(e.NTFY_TOPIC);
  const emailReady = Boolean(e.RESEND_API_KEY && e.ALERT_EMAIL);
  const textReady = Boolean(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM && e.ALERT_PHONE);
  return {
    push: pushReady
      ? { ready: true }
      : { ready: false, reason: 'NTFY_TOPIC is not set on the Worker' },
    email: emailReady
      ? { ready: true }
      : {
          ready: false,
          reason: !e.RESEND_API_KEY
            ? 'RESEND_API_KEY is not set on the Worker'
            : 'ALERT_EMAIL is not set on the Worker',
        },
    text: textReady ? { ready: true } : { ready: false, reason: textReason(e) },
  };
}

function textReason(e) {
  if (!e.TWILIO_ACCOUNT_SID) return 'TWILIO_ACCOUNT_SID is not set on the Worker';
  if (!e.TWILIO_AUTH_TOKEN) return 'TWILIO_AUTH_TOKEN is not set on the Worker';
  if (!e.TWILIO_FROM) return 'TWILIO_FROM is not set on the Worker';
  return 'ALERT_PHONE is not set on the Worker';
}

// --- Observation -------------------------------------------------------------
// What a watch can see right now: the rows it is about, and whether those rows are
// recent enough to be evidence. A route last answered four hours ago is a memory;
// comparing memories produces "sold out" notifications for seats nobody checked.

function wallMinutes(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s == null ? '' : s));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 60000;
}

export function observe(view, state, watch, now = Date.now()) {
  const dest = watch.dest;
  const rows = [];
  const dates = (view && Array.isArray(view.dates) ? view.dates : []);
  for (const d of dates) {
    if (watch.mode === 'date' && d.date !== watch.date) continue;
    for (const r of Array.isArray(d.rows) ? d.rows : []) {
      if (r && r.dest === dest) rows.push(r);
    }
  }
  rows.sort((a, b) => String(a.dep).localeCompare(String(b.dep)));
  const cov = state && state.coverage && state.coverage[dest];
  const okAt = Number(cov && cov.lastOkAt);
  const ageMin = Number.isFinite(okAt) && okAt > 0 ? Math.round((now - okAt) / 60000) : null;
  // No ledger means no evidence either: a snapshot written before coverage existed
  // must not be read as "this route just came back empty".
  const stale = ageMin === null || ageMin > MAX_ROW_AGE_MIN;
  const cheapest = rows.length
    ? Math.min(...rows.map((r) => Number(r.allin)).filter((n) => Number.isFinite(n)))
    : null;
  const sig = stale
    ? 'stale'
    : rows.map((r) => `${r.date}|${String(r.dep)}|${Number(r.allin).toFixed(2)}|${r.seats == null ? 'x' : r.seats}`).join(',');
  return { rows: rows.map(slim), sig, cheapest, stale, ageMin, at: now };
}

function slim(r) {
  return { date: r.date, dep: r.dep, allin: Number(r.allin), seats: r.seats == null ? null : r.seats };
}

// --- Transitions -------------------------------------------------------------
// Four things a person actually wants to hear about: it opened, it went, it got
// cheap, it leaves soon. A fare rising is not one of them -- the ceiling already
// says whether a seat is worth booking, and "it got more expensive" is not news.

function event(kind, watch, obs, row) {
  const r = row || obs.rows[0] || null;
  const at = r ? `${r.date}|${String(r.dep).slice(11, 16)}` : '';
  return {
    kind,
    dest: watch.dest,
    mode: watch.mode,
    date: r ? r.date : watch.date,
    dep: r ? r.dep : null,
    allin: r ? r.allin : obs.cheapest,
    count: obs.rows.length,
    cheapest: obs.cheapest,
    minutes: null,
    key: `${kind}|${watch.dest}|${at}|${r ? Number(r.allin).toFixed(2) : ''}`,
  };
}

export function planWatch(prev, next, watch, now = Date.now()) {
  const plan = { events: [], announced: Array.isArray(watch && watch.announced) ? watch.announced.slice() : [] };
  if (!next) return plan;
  // Two stale observations cannot be compared: "it disappeared" may only mean the
  // sweep stopped asking. Departure timing still stands, because it is about the
  // clock, not about Frontier.
  if (prev && !prev.stale && !next.stale && prev.sig !== next.sig) {
    const before = prev.rows.length;
    const after = next.rows.length;
    const nowMin = wallMinutes(easternStamp(now));
    if (!before && after) {
      plan.events.push(event('available', watch, next));
    } else if (before && !after) {
      // A row disappears for two very different reasons: the seats went, or the
      // plane did. The board drops departures that have left, so "it vanished" on
      // its own would report every watched flight as sold out at push-back.
      const gone = prev.rows.every((r) => {
        const dep = wallMinutes(r.dep);
        return dep != null && nowMin != null && dep <= nowMin;
      });
      plan.events.push(gone ? event('departed', watch, prev, prev.rows[prev.rows.length - 1]) : event('soldout', watch, next));
    } else if (prev.cheapest != null && next.cheapest != null && next.cheapest < prev.cheapest - 0.99) {
      plan.events.push(event('cheaper', watch, next));
    }
  }
  const nowMin = wallMinutes(easternStamp(now));
  if (nowMin == null) return plan;
  for (const r of next.rows) {
    const dep = wallMinutes(r.dep);
    if (dep == null) continue;
    const key = `${r.date}|${String(r.dep).slice(11, 16)}`;
    if (dep < nowMin || dep > nowMin + DEPARTING_SOON_MIN) continue;
    if (plan.announced.includes(key)) continue;
    const ev = event('departing', watch, next, r);
    ev.minutes = Math.round(dep - nowMin);
    plan.events.push(ev);
    plan.announced.push(key);
  }
  plan.announced = plan.announced.slice(-60);
  return plan;
}

export function shouldNotify(watch, ev, now = Date.now()) {
  const last = watch && watch.lastEvent;
  if (!last || typeof last !== 'object') return true;
  if (last.kind !== ev.kind || last.key !== ev.key) return true;
  return now - Number(last.at || 0) >= WATCH_REPEAT_MS;
}

// --- Copy --------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : String(iso || '');
}

function clockLabel(dep) {
  const m = /(\d{2}):(\d{2})/.exec(String(dep || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function inMinutes(min) {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  return `${h}h ${Math.round(min % 60)}m`;
}

export function describeEvent(ev, origin = 'RDU') {
  const where = `${ev.dest} ${dayLabel(ev.date)}`;
  const when = clockLabel(ev.dep);
  const price = Number.isFinite(Number(ev.allin)) ? money(ev.allin) : '';
  const tail = 'Estimated all-in: Frontier publishes no separate tax or fee for GoWild.';
  if (ev.kind === 'available') {
    return {
      title: `GoWild open: ${where}`,
      body: `${when ? `${when} · ` : ''}${price} est. all-in${ev.count > 1 ? ` (${ev.count} options)` : ''}.\n${origin} board: seats just appeared under the ceiling.\n${tail}`,
      priority: 'high',
    };
  }
  if (ev.kind === 'soldout') {
    return {
      title: `GoWild gone: ${where}`,
      body:
        `No GoWild option under the ceiling for ${where} any more.\n` +
        'Either the seats sold out or the fare moved above $50. The board shows only what is bookable.\n' +
        tail,
      priority: 'default',
    };
  }
  if (ev.kind === 'cheaper') {
    return {
      title: `GoWild cheaper: ${where}`,
      body: `${when ? `${when} · ` : ''}now ${price} est. all-in, the cheapest on this watch.\n${tail}`,
      priority: 'default',
    };
  }
  if (ev.kind === 'departed') {
    return {
      title: `GoWild left: ${where}`,
      body:
        `${when ? `${when} has departed. ` : 'That departure has gone. '}` +
        'The board only lists departures that can still be booked, so it is gone from the list.\n' +
        tail,
      priority: 'low',
    };
  }
  const mins = Number.isFinite(ev.minutes) ? ev.minutes : null;
  return {
    title: `GoWild soon: ${where}`,
    body:
      `${when ? `${when} departs` : 'Departs'}${mins == null ? ' soon' : ` in about ${inMinutes(mins)}`} · ${price} est. all-in.\n` +
      'Booked seats are invisible to this board: this says the departure is close, not that a seat remains.\n' +
      tail,
    priority: 'high',
  };
}

// --- Delivery ----------------------------------------------------------------
// One request builder per channel, exported so the payload shape is asserted in a
// test instead of discovered in production. None of them puts a secret in a URL.

export function pushRequest(env, alert) {
  const topic = env && env.NTFY_TOPIC;
  if (!validTopic(topic)) return null;
  return {
    channel: 'push',
    url: `https://ntfy.sh/${encodeURIComponent(topic)}`,
    init: {
      method: 'POST',
      headers: {
        Title: ascii(alert.title),
        Priority: alert.priority || 'default',
        Tags: 'airplane',
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: alert.body,
    },
  };
}

export function emailRequest(env, alert) {
  const key = env && env.RESEND_API_KEY;
  const to = env && env.ALERT_EMAIL;
  if (!key || !to) return null;
  return {
    channel: 'email',
    url: 'https://api.resend.com/emails',
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.ALERT_FROM || 'GoWild Board <onboarding@resend.dev>',
        to: [to],
        subject: ascii(alert.title),
        text: alert.body,
      }),
    },
  };
}

export function textRequest(env, alert) {
  const sid = env && env.TWILIO_ACCOUNT_SID;
  const token = env && env.TWILIO_AUTH_TOKEN;
  const from = env && env.TWILIO_FROM;
  const to = env && env.ALERT_PHONE;
  if (!sid || !token || !from || !to) return null;
  const form = new URLSearchParams({ To: to, From: from, Body: alert.body.slice(0, 480) });
  return {
    channel: 'text',
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  };
}

// Headers carry ASCII only. A title with an em dash is not worth a 400 from a push
// service, and the body already reads properly.
function ascii(s) {
  return String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '-');
}

export function buildRequests(env, alert, channels) {
  const out = [];
  const status = channelStatus(env);
  for (const c of CHANNELS) {
    if (!channels.includes(c)) continue;
    if (!status[c].ready) continue;
    const req = c === 'push' ? pushRequest(env, alert) : c === 'email' ? emailRequest(env, alert) : textRequest(env, alert);
    if (req) out.push(req);
  }
  return out;
}

// Delivery never throws into its caller: a watch exists so that the board's write
// path cannot be taken down by a notification provider.
export async function deliver(env, alert, channels) {
  const sent = [];
  const failed = [];
  let reqs = [];
  try {
    reqs = buildRequests(env, alert, Array.isArray(channels) ? channels : []);
  } catch (err) {
    failed.push({ channel: 'build', reason: String((err && err.message) || err).slice(0, 120) });
  }
  for (const req of reqs) {
    try {
      const res = await fetch(req.url, req.init);
      if (res && res.ok) sent.push(req.channel);
      else failed.push({ channel: req.channel, reason: `HTTP ${res ? res.status : '000'}` });
    } catch (err) {
      failed.push({ channel: req.channel, reason: String((err && err.message) || err).slice(0, 120) });
    }
  }
  return { sent, failed };
}

// --- Storage -----------------------------------------------------------------
// One key per destination: two browsers changing two watches at the same moment
// cannot overwrite each other's record the way a single JSON array would.

export async function listWatches(env, profile) {
  if (!env || !env.BOARD || typeof env.BOARD.list !== 'function') return [];
  const prefix = `${WATCH_KEY_PREFIX}${String(profile || 'rdu').toLowerCase()}:`;
  try {
    const listed = await env.BOARD.list({ prefix });
    const names = (listed && Array.isArray(listed.keys) ? listed.keys : [])
      .map((k) => (k && k.name) || '')
      .filter(Boolean);
    const out = [];
    for (const name of names) {
      const rec = await env.BOARD.get(name, 'json');
      if (rec && typeof rec === 'object' && DEST_RE.test(String(rec.dest || ''))) out.push(rec);
    }
    return out;
  } catch (err) {
    console.error('watch list failed', err && err.message);
    return [];
  }
}

export async function saveWatch(env, profile, record) {
  if (!env || !env.BOARD) return null;
  await env.BOARD.put(watchKey(profile, record.dest), JSON.stringify(record));
  return record;
}

export async function removeWatch(env, profile, dest) {
  if (!env || !env.BOARD) return null;
  await env.BOARD.delete(watchKey(profile, dest));
  return dest;
}

// --- Evaluation --------------------------------------------------------------
// Called when a snapshot lands. The previous snapshot is not required -- the watch
// record carries its own last observation -- so this works the same whether the
// collector wrote through /api/ingest or straight to KV and the page noticed later.

export async function evaluateWatches(env, profile, prevState, nextState, now = Date.now()) {
  try {
    const watches = await listWatches(env, profile);
    if (!watches.length) return { watched: 0, sent: 0 };
    const nextView = buildBoard(nextState, now);
    const prevView = prevState ? buildBoard(prevState, now) : null;
    let sent = 0;
    for (const w of watches) {
      const obs = observe(nextView, nextState, w, now);
      const before =
        w.last && typeof w.last === 'object'
          ? w.last
          : prevView
            ? observe(prevView, prevState, w, now)
            : null;
      const plan = planWatch(before, obs, w, now);
      let lastEvent = w.lastEvent || null;
      for (const ev of plan.events) {
        if (!shouldNotify({ lastEvent }, ev, now)) continue;
        const msg = describeEvent(ev, String(profile || 'rdu').toUpperCase());
        const res = await deliver(env, msg, w.channels);
        if (res.sent.length) sent += 1;
        lastEvent = { kind: ev.kind, key: ev.key, at: now, sent: res.sent, failed: res.failed };
        console.log(`watch ${w.dest} ${ev.kind}: sent ${res.sent.join(',') || 'none'}${res.failed.length ? ` failed ${res.failed.map((f) => f.channel).join(',')}` : ''}`);
      }
      const changed =
        !w.last ||
        w.last.sig !== obs.sig ||
        plan.announced.length !== (Array.isArray(w.announced) ? w.announced.length : 0) ||
        lastEvent !== (w.lastEvent || null);
      if (changed) {
        await saveWatch(env, profile, {
          ...w,
          last: { sig: obs.sig, rows: obs.rows, cheapest: obs.cheapest, stale: obs.stale, at: now },
          announced: plan.announced,
          lastEvent,
          updatedAt: now,
        });
      }
    }
    return { watched: watches.length, sent };
  } catch (err) {
    // A notification failure must never cost the snapshot it was reporting on.
    console.error('watch evaluation failed', err && err.message);
    return null;
  }
}
