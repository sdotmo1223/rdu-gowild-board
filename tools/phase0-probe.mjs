// Phase 0 gate instrument — ONE request to Frontier, sequential, no retries.
// Reads the session cookie from .dev.vars (development) or the FRONTIER_COOKIE
// environment variable (deploy). Never prints, logs, or echoes the value.
// Purpose: prove the cookie returns GoWild fares AND reveal the real field set,
// so we know whether an all-in price is available upstream or must be estimated.

import { readFileSync, existsSync } from 'node:fs';

// The cookie may be supplied either in the environment or in a local `.dev.vars`
// file. Reading the file means the user types the secret once into a gitignored
// file and never pastes it into a chat message or a shell history.
function loadLocalSecret(name) {
  if (process.env[name] && process.env[name].trim()) return process.env[name].trim();
  if (!existsSync('.dev.vars')) return null;
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || m[1] !== name) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v.trim() || null;
  }
  return null;
}

const ORIGIN = process.env.P0_ORIGIN || 'RDU';
const DEST = process.env.P0_DEST || 'MCO';
const DAYS = Number(process.env.P0_DAYS || 0); // 0 = today, 1 = tomorrow

function fmtDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]}%20${String(d.getDate()).padStart(2, '0')},%20${d.getFullYear()}`;
}

// Extract the first balanced JSON object that looks like the flight state blob.
function extractJsonBlob(html) {
  const keyIdx = html.indexOf('journeys');
  if (keyIdx === -1) return null;
  let start = -1;
  for (let i = keyIdx; i >= 0; i--) {
    if (html[i] === '{') { start = i; break; }
  }
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const COOKIE = loadLocalSecret('FRONTIER_COOKIE');
const hasCookie = Boolean(COOKIE);
console.log(`[phase0] cookie configured: ${hasCookie ? 'YES (value withheld)' : 'NO'}`);
console.log(`[phase0] cookie length: ${hasCookie ? COOKIE.length : 0} chars`);

const url = `https://booking.flyfrontier.com/Flight/InternalSelect?o1=${ORIGIN}&d1=${DEST}&dd1=${fmtDate(new Date(Date.now() + DAYS * 86400000))}&ADT=1&mon=true&promo=`;
console.log(`[phase0] GET ${url}`);

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};
if (hasCookie) headers['Cookie'] = COOKIE;

let res;
try {
  res = await fetch(url, { headers, redirect: 'manual' });
} catch (err) {
  console.log(`[phase0] RESULT: NETWORK_ERROR — ${err.message}`);
  process.exit(4);
}
console.log(`[phase0] status=${res.status} location=${res.headers.get('location') || '-'}`);
const body = await res.text();
console.log(`[phase0] bytes=${body.length}`);

const blob = extractJsonBlob(body);
if (!blob) {
  console.log('[phase0] RESULT: NO_PAYLOAD — page did not contain a journeys structure.');
  console.log('[phase0] first 300 chars:', body.slice(0, 300).replace(/\s+/g, ' '));
  process.exit(2);
}

const journeys = blob.journeys || [];
console.log(`[phase0] journeys=${journeys.length}`);
const flights = (journeys[0] && journeys[0].flights) || [];
console.log(`[phase0] flights in journey[0]=${flights.length}`);

if (flights.length) {
  console.log('[phase0] --- flight field set ---');
  console.log(Object.keys(flights[0]).sort().join(', '));
  const gw = flights.filter((f) => f.isGoWildFareEnabled);
  console.log(`[phase0] isGoWildFareEnabled=true count=${gw.length}`);
  if (gw.length) {
    console.log('[phase0] --- sample GoWild flight (all keys) ---');
    console.log(JSON.stringify(gw[0], null, 1).slice(0, 3000));
  }
  // hunt for anything that looks like tax/fee/total money fields anywhere
  const money = new Set();
  const walk = (o, path) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (/tax|fee|total|amount|price|fare|cost/i.test(k) && (typeof v === 'number' || typeof v === 'string')) {
        money.add(`${path}${k} = ${JSON.stringify(v)}`);
      }
      if (v && typeof v === 'object') walk(v, `${path}${k}.`);
    }
  };
  walk(blob, '');
  console.log('[phase0] --- money-ish fields in payload ---');
  console.log([...money].sort().slice(0, 60).join('\n') || '(none found)');
  console.log(`[phase0] RESULT: ${hasCookie ? 'COOKIE_PRESENT' : 'ANON'} GoWild fares=${gw.length}`);
  process.exit(gw.length > 0 ? 0 : 1);
}
console.log('[phase0] RESULT: NO_FLIGHTS — no flights in payload for this route/date.');
process.exit(3);
