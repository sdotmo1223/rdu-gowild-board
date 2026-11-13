// A delivery outbox, because a watch event is a promise and a dropped promise is a lie.
//
// Measured 2026-11-11: the first real watch event fired, ntfy.sh answered HTTP 522,
// and the event was gone. `announced` had been advanced before delivery was even
// attempted (so a failed `departing` push was never offered again) and `lastEvent`
// was stamped regardless of the result (so any other failed event went silent for
// six hours). The retry added that day only covered a transient error inside a
// single request.
//
// The rules here:
//   - an event is enqueued as data: key, kind, rendered payload, attempt count;
//   - the watch's `announced`/`lastEvent` advance only after a 2xx;
//   - a recoverable failure backs off, up to MAX_ATTEMPTS, then the entry is DEAD;
//   - a dead entry stays as a tombstone (so the same event is not re-queued every
//     tick) and is surfaced on the board, because a bell that silently stopped
//     ringing is worse than no bell;
//   - a `departing` event expires at its departure: a notification about a plane
//     that has left is not a late notification, it is a wrong one.
//
// KV, not a queue: there is one writer (the ingest path) and one profile, so a
// single JSON array per profile is enough, and it costs one read and at most one
// write per sweep.
export const OUTBOX_KEY_PREFIX = 'out:';

// Five attempts, spaced 1, 2, 4 and 8 minutes apart. The sweep runs on ingest, which
// GitHub delivers about hourly, so each attempt lands on a later tick and the entry
// dies within about five hours -- inside the window where "cheaper" and "available"
// are still true, outside the window where retrying is noise.
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 60 * 1000;
export const BACKOFF_MAX_MS = 6 * 3600 * 1000;

// A tombstone has to outlive the six-hour dedupe on `lastEvent`, or a dead event
// would be re-queued the moment the watch's silence expired.
export const TOMBSTONE_TTL_MS = 7 * 24 * 3600 * 1000;

export function outboxKey(profile) {
  return `${OUTBOX_KEY_PREFIX}${String(profile || 'rdu').toLowerCase()}`;
}

// The KV write goes through the Worker, never to GitHub or a provider: this key is
// the same shape src/watch.mjs uses for a watch record.
function recordKey(profile, dest) {
  return `w:${String(profile || 'rdu').toLowerCase()}:${String(dest || '').toUpperCase()}`;
}

// Callers pass either the Worker env or a bare KV binding; the tests use the latter.
function kvFrom(env) {
  if (!env) return null;
  if (env.BOARD && typeof env.BOARD.get === 'function') return env.BOARD;
  if (typeof env.get === 'function' && typeof env.put === 'function') return env;
  return null;
}

export function backoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

// Same classification the immediate retry uses, applied to a reason string rather
// than a status: a permanent 4xx must not be retried into a loop, and a network
// error (no status at all) is exactly what a retry is for.
export function retryableReason(reason) {
  const m = /HTTP\s+(\d{3})/i.exec(String(reason == null ? '' : reason));
  if (!m) return true;
  const status = Number(m[1]);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export async function readOutbox(env, profile) {
  const kv = kvFrom(env);
  if (!kv || typeof kv.get !== 'function') return [];
  try {
    const stored = await kv.get(outboxKey(profile), 'json');
    return Array.isArray(stored)
      ? stored.filter((e) => e && typeof e === 'object' && typeof e.key === 'string' && e.state)
      : [];
  } catch {
    return [];
  }
}

// The payload is rendered once, at plan time, and stored. Re-rendering on a retry
// hours later would describe a board that has since changed.
export function entryFor(ev, watch, alert, now) {
  const minutes = Number(ev && ev.minutes);
  const expAt =
    ev && ev.kind === 'departing' && Number.isFinite(minutes)
      ? now + Math.max(0, minutes) * 60000
      : now + TOMBSTONE_TTL_MS;
  return {
    key: String(ev.key),
    kind: ev.kind,
    dest: ev.dest,
    // The key planWatch records in `announced` (date|HH:MM), carried here so the
    // watch can be advanced from the outbox after a 2xx, not before.
    announce: ev.announce || null,
    payload: { title: alert.title, body: alert.body, priority: alert.priority || 'default' },
    channels: Array.isArray(watch && watch.channels) ? watch.channels.slice() : [],
    attempts: 0,
    nextAt: now,
    state: 'pending',
    expAt,
    lastReason: null,
    createdAt: now,
  };
}

// New events only. An identical key already present -- pending, dead or dropped --
// is skipped: that is what makes "advance announced only on a 2xx" safe to combine
// with re-planning the same departure on every tick.
export async function enqueueEntries(env, profile, entries, now = Date.now()) {
  const kv = kvFrom(env);
  const list = await readOutbox(env, profile);
  if (!kv || !Array.isArray(entries) || !entries.length) return 0;
  const seen = new Set(list.map((e) => e.key));
  let added = 0;
  for (const e of entries) {
    if (!e || seen.has(e.key)) continue;
    list.push(e);
    seen.add(e.key);
    added += 1;
  }
  const pruned = list.filter(
    (e) => !(e.state !== 'pending' && now - Number(e.deadAt || e.createdAt || 0) > TOMBSTONE_TTL_MS),
  );
  if (added || pruned.length !== list.length) {
    await kv.put(outboxKey(profile), JSON.stringify(pruned));
  }
  return added;
}

async function defaultDeliver(env, alert, channels, opts) {
  // Loaded lazily so this module has no import cycle with the watch rules, and so a
  // test can inject a delivery function without one.
  const mod = await import('./watch.mjs');
  return mod.deliver(env, alert, channels, opts);
}

// After a 2xx, and only after it: the two facts that make an event "already
// reported" are written here.
async function markDelivered(env, profile, entry, res, now) {
  const kv = kvFrom(env);
  if (!kv) return;
  const key = recordKey(profile, entry.dest);
  let rec = null;
  try {
    rec = await kv.get(key, 'json');
  } catch {
    rec = null;
  }
  if (!rec || typeof rec !== 'object') return;
  if (entry.announce) {
    const rest = (Array.isArray(rec.announced) ? rec.announced : []).filter((k) => k !== entry.announce);
    rec.announced = [...rest, entry.announce].slice(-60);
  }
  rec.lastEvent = { kind: entry.kind, key: entry.key, at: now, sent: res.sent, failed: [] };
  rec.updatedAt = now;
  await kv.put(key, JSON.stringify(rec));
}

export async function sweepOutbox(env, profile, now = Date.now(), opts = {}) {
  const deliverFn = opts.deliverFn || defaultDeliver;
  const kv = kvFrom(env);
  const out = { attempted: 0, delivered: 0, failed: 0, dead: 0, dropped: 0 };
  const list = await readOutbox(env, profile);
  if (!kv || !list.length) return out;
  const keep = [];
  let changed = false;

  for (const e of list) {
    if (e.state !== 'pending') {
      keep.push(e);
      continue;
    }
    // The departure is gone. Dropping is the honest outcome: the reader cannot catch
    // this plane, and a retry would spend a provider request to say something false.
    if (Number(e.expAt) > 0 && now >= Number(e.expAt)) {
      e.state = 'dropped';
      e.deadAt = now;
      e.lastReason = 'expired: the departure window passed before delivery';
      out.dropped += 1;
      changed = true;
      keep.push(e);
      continue;
    }
    if (Number(e.nextAt) > now) {
      keep.push(e);
      continue;
    }
    // Nothing can deliver this event (the channel was removed, or its variables
    // went away). Retrying five times would only turn a configuration fact into an
    // outage report.
    if (!Array.isArray(e.channels) || !e.channels.length) {
      e.state = 'dropped';
      e.deadAt = now;
      e.lastReason = 'dropped: no delivery channel on this watch';
      out.dropped += 1;
      changed = true;
      keep.push(e);
      continue;
    }

    out.attempted += 1;
    let res;
    try {
      // One try per sweep: THIS is the retry, and stacking the request-level retry
      // on top of it would make one bad provider day cost five requests per event.
      res = await deliverFn(env, e.payload, e.channels, { tries: 1 });
    } catch (err) {
      res = {
        sent: [],
        failed: [{ channel: 'deliver', reason: String((err && err.message) || err).slice(0, 120) }],
      };
    }

    if (res && Array.isArray(res.sent) && res.sent.length) {
      out.delivered += 1;
      changed = true;
      await markDelivered(env, profile, e, res, now);
      continue;
    }

    const failed = (res && Array.isArray(res.failed) && res.failed) || [];
    if (!failed.length) {
      // buildRequests found no usable channel: a configuration fact, not an outage.
      e.state = 'dropped';
      e.deadAt = now;
      e.lastReason = 'dropped: no channel could be built';
      out.dropped += 1;
      changed = true;
      keep.push(e);
      continue;
    }

    e.attempts = Number(e.attempts || 0) + 1;
    e.lastReason = failed.map((f) => `${f.channel}: ${f.reason}`).join('; ');
    const permanent = failed.every((f) => !retryableReason(f.reason));
    if (e.attempts >= MAX_ATTEMPTS || permanent) {
      e.state = 'dead';
      e.deadAt = now;
      out.dead += 1;
    } else {
      e.nextAt = now + backoffMs(e.attempts);
    }
    out.failed += 1;
    changed = true;
    keep.push(e);
  }

  if (changed) await kv.put(outboxKey(profile), JSON.stringify(keep));
  return out;
}

// What the board may say out loud: counts and the provider's own words. Never the
// topic, never a payload the reader already failed to receive.
export async function outboxStatus(env, profile, now = Date.now()) {
  const list = await readOutbox(env, profile);
  const pending = list.filter((e) => e.state === 'pending');
  const dead = list.filter((e) => e.state === 'dead');
  const dropped = list.filter((e) => e.state === 'dropped');
  const ended = [...dead, ...dropped].sort((a, b) => Number(b.deadAt || 0) - Number(a.deadAt || 0))[0] || null;
  return {
    pending: pending.length,
    dead: dead.length,
    dropped: dropped.length,
    // Dead only: a dropped `departing` event is the system working correctly, and a
    // banner about it would train the reader to ignore the banner that matters.
    lastReason: dead.length ? ended && ended.lastReason : null,
    lastDeadAt: dead.length ? Number(ended && ended.deadAt) || null : null,
    nextAttemptAt: pending.length ? Math.min(...pending.map((e) => Number(e.nextAt) || 0)) : null,
    now: Number(now) || 0,
  };
}
