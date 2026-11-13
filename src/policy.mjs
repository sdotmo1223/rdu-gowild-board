// The three notification tiers, run from the Worker's own cron.
//
// BRIEFING once a day at the configured ET time; the weekly link probe; and HEALTH on
// a state transition only. None of them collects anything: the briefing reads the
// snapshot, the probe makes exactly one HEAD-ish GET per week, and health reads the
// outbox and two KV stamps.
//
// Everything is wrapped: a notification provider having a bad day must never stop the
// dispatch gate from running, which is the one thing that recovers a stalled board.
import { buildBoard } from './board.js';
import { ORIGIN, PROFILE, ROUTES, easternDate } from './routes.js';
import { outboxStatus } from './outbox.mjs';
import { canaryStateFor, listSubscriptions, readCanary } from './push.mjs';
import { deliver } from './watch.mjs';
import { briefingDue, readSettings } from './settings.mjs';
import { buildBriefing } from './briefing.mjs';
import { buildHealthNotice, isDegraded } from './health.mjs';
import { bookingUrl, classifyProbe, livenessDue } from './liveness.mjs';

export const BRIEFING_KEY = 'briefing:last';
export const HEALTH_KEY = 'health:last';
export const PROBE_KEY = 'link:probe';
export const POLICY_KEY = 'policy:last';

async function push(env, alert) {
  // The app carries these now, so the only configuration that matters is whether a
  // device has enrolled. `deliver` reports that as a failure with a sentence, which is
  // what the policy log shows instead of a silently skipped tier.
  return deliver(env, alert, ['push'], { tries: 3 });
}

// One GET per week, no session, no credentials. `redirect: manual` so Frontier's own
// challenge bounce can be told apart from a link that has rotted.
async function probeOnce(env, now) {
  const dest = ROUTES[0] && ROUTES[0].code;
  const url = bookingUrl(dest, easternDate(1, now));
  if (!url) return { state: 'broken', status: 0, error: 'no-url' };
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'rdu-gowild-board liveness/1 (+weekly link check)' },
    });
    const location = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    return classifyProbe({ status: res ? res.status : 0, location });
  } catch (err) {
    return classifyProbe({ status: 0, error: String((err && err.message) || err) });
  }
}

export async function runPolicy(env, now = Date.now()) {
  const out = { briefing: null, liveness: null, health: null };
  const kv = env && env.BOARD;
  if (!kv) return out;

  const settings = await readSettings(env).catch(() => null);

  // --- briefing ---------------------------------------------------------------
  try {
    const state = await kv.get('state', 'json');
    if (!state || !settings || !settings.briefing) {
      out.briefing = 'disabled';
    } else {
      const sentOn = await kv.get(BRIEFING_KEY);
      if (!briefingDue(settings, sentOn, now)) {
        out.briefing = 'not-due';
      } else {
        const alert = buildBriefing(state, buildBoard(state, now), settings, now);
        const res = alert ? await push(env, alert) : { sent: [] };
        if (res && res.sent && res.sent.length) {
          await kv.put(BRIEFING_KEY, easternDate(0, now));
          out.briefing = 'sent';
        } else {
          out.briefing = `failed: ${(res.failed || []).map((f) => f.reason).join('; ') || 'not delivered'}`;
        }
      }
    }
  } catch (err) {
    out.briefing = `error: ${(err && err.message) || err}`;
  }

  // --- weekly link probe ------------------------------------------------------
  let probe = null;
  try {
    const stored = await kv.get(PROBE_KEY, 'json');
    if (livenessDue(stored && stored.at, now)) {
      probe = await probeOnce(env, now);
      await kv.put(PROBE_KEY, JSON.stringify({ ...probe, at: now }));
      out.liveness = probe.state;
    } else {
      probe = stored;
      out.liveness = 'not-due';
    }
  } catch (err) {
    out.liveness = `error: ${(err && err.message) || err}`;
  }

  // --- health: transitions only ----------------------------------------------
  try {
    const box = await outboxStatus(env, PROFILE).catch(() => null);
    // Enrollment decides what the canary is allowed to claim. With no device, a stale
    // delivery is not evidence of anything, and a notice cannot be sent anyway.
    const deviceCount = (await listSubscriptions(env).catch(() => [])).length;
    const lastDispatch = Number(await kv.get('dispatch:last')) || 0;
    const state = await kv.get('state', 'json').catch(() => null);
    const lastSuccess = state && state.lastSweep && state.lastSweep.at;
    const signal = {
      pending: box ? box.pending : 0,
      dead: box ? box.dead : 0,
      reason: box ? box.lastReason || box.pendingReason || null : null,
      degraded: isDegraded(lastSuccess, lastDispatch, now),
      link: probe && probe.state ? probe.state : 'ok',
      linkStatus: probe && probe.status,
      // Delivered-and-unacknowledged is invisible everywhere else: the push service
      // said 201, the outbox says sent, and the phone shows nothing.
      canary: canaryStateFor(deviceCount, await readCanary(env, now).catch(() => null)),
    };
    const lastFp = await kv.get(HEALTH_KEY);
    const notice = buildHealthNotice(signal, lastFp, now);
    if (!notice) {
      out.health = 'quiet';
    } else if (!deviceCount) {
      // Recorded, not retried: there is nowhere to send it, and a tier that retries into
      // zero devices every fifteen minutes teaches the reader to ignore it.
      out.health = 'no-device';
    } else {
      // Every notice opens the board, token-free, like every other push.
      notice.clickPath = notice.clickPath || `/${String(ORIGIN).toLowerCase()}`;
      const res = await push(env, notice);
      if (res && res.sent && res.sent.length) {
        await kv.put(HEALTH_KEY, notice.fingerprint);
        out.health = 'sent';
      } else {
        out.health = 'failed';
      }
    }
  } catch (err) {
    out.health = `error: ${(err && err.message) || err}`;
  }

  // A tier that fails silently is the failure mode this board exists to remove. The
  // outcome is stored, so "why did no briefing arrive?" is a GET, not a log hunt.
  try {
    await kv.put(POLICY_KEY, JSON.stringify({ at: now, ...out }));
  } catch {
    // A failed bookkeeping write must not turn a successful run into an error.
  }
  return out;
}
