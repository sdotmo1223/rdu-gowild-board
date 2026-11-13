// Is the Frontier search link still the link we think it is?
//
// This is a read-only, once-a-week status ping. It is not a booking request and it
// never carries a session: it asks Frontier's public search page whether the URL
// shape still resolves where we think it does, so the "Open on Frontier" button
// cannot rot into a dead end without the owner hearing about it.
//
// The classifier is the whole design. Frontier's own bot protection answers a cold
// /Flight/Select with a redirect to /Flight/Redirect -- measured while building this
// board -- so "non-200 means broken" would fire every week on a healthy site. Only a
// real disappearance or a redirect off Frontier's own host is news.
import { frontierDateParam } from './routes.js';

export const LIVENESS_REPEAT_DAYS = 7;
export const FRONTIER_HOST = 'flyfrontier.com';

export function bookingUrl(dest, dateISO, origin = 'RDU') {
  const code = String(dest == null ? '' : dest).trim().toUpperCase();
  const from = String(origin == null ? '' : origin).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || !/^[A-Z]{3}$/.test(from)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return null;
  return (
    'https://booking.flyfrontier.com/Flight/Select' +
    `?o1=${from}&d1=${code}&dd1=${frontierDateParam(dateISO)}&ADT=1&mon=true`
  );
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function classifyProbe(result) {
  const r = result && typeof result === 'object' ? result : {};
  const status = Number(r.status) || 0;
  if (r.error) return { state: 'broken', status, reason: String(r.error) };
  if (status >= 200 && status < 300) return { state: 'alive', status };
  if (status === 403 || status === 429) return { state: 'challenged', status };
  if (status >= 300 && status < 400) {
    const host = hostOf(r.location);
    if (!host) return { state: 'challenged', status };
    // Their own challenge bounce is named for what it is, but it is not news: the
    // browser still lands on Frontier. Any other redirect that stays on Frontier is
    // simply alive.
    if (/\/Flight\/Redirect/i.test(String(r.location || ''))) return { state: 'challenged', status, location: String(r.location) };
    if (host === FRONTIER_HOST || host.endsWith(`.${FRONTIER_HOST}`)) return { state: 'alive', status };
    return { state: 'drifted', status, location: String(r.location) };
  }
  // Everything else -- 404, 410, 5xx, no status at all -- is a door that no longer
  // opens. Only 403/429 and Frontier's own redirect are the bot challenge.
  return { state: 'broken', status, reason: `unexpected HTTP ${status || 0}` };
}

export function buildLivenessNotice(result) {
  const r = result && typeof result === 'object' ? result : {};
  const state = r.state;
  if (state !== 'broken' && state !== 'drifted') return null;
  const status = Number(r.status) || 0;
  const detail =
    state === 'drifted'
      ? `the link now redirects to ${String(r.location || 'another host')}, which is not Frontier (pattern drift)`
      : `the link answered ${status ? `HTTP ${status}` : r.reason || 'nothing at all'}`;
  return {
    kind: 'link-dead',
    tier: 'health',
    title: 'GoWild: Frontier search link may be broken',
    message:
      `The weekly check of the stored Frontier search link found ${detail}.\n` +
      'The board still shows fares; the "Open on Frontier" button is what may not work.\n' +
      'Nothing else was requested: this is one status ping per week, no session, no booking.',
    priority: state === 'broken' ? 'high' : 'default',
  };
}

export function livenessDue(lastAt, now = Date.now()) {
  const last = Number(lastAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last >= LIVENESS_REPEAT_DAYS * 86400000;
}
