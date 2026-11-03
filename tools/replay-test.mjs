// Replay test: does the captured cookie, sent by a plain HTTP client with
// browser-like headers, unlock the payload? One request. Never prints the value.
import { readFileSync, existsSync } from 'node:fs';

function loadSecret(name) {
  if (process.env[name]) return process.env[name].trim();
  if (!existsSync('.dev.vars')) return null;
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim() || null;
  }
  return null;
}

const cookie = loadSecret('FRONTIER_COOKIE');
console.log(`cookie: ${cookie ? `present (${cookie.length} chars, ${cookie.split(';').length} pairs)` : 'MISSING'}`);
if (!cookie) process.exit(9);
console.log(`has datadome cookie: ${/datadome=/i.test(cookie)}`);

const dest = process.env.R_DEST || 'MCO';
const date = process.env.R_DATE || 'Nov%2003,%202026';
const url = `https://booking.flyfrontier.com/Flight/InternalSelect?o1=RDU&d1=${dest}&dd1=${date}&ADT=1&mon=true&promo=`;
console.log(`GET ${url}`);

const res = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://booking.flyfrontier.com/',
    'Cookie': cookie,
  },
});
const body = await res.text();
console.log(`status=${res.status} finalUrl=${res.url} bytes=${body.length}`);
console.log(`hasJourneysToken=${body.includes('"journeys"')}`);
const blocked = /Flight\/Redirect/.test(res.url) || /captcha-delivery|datadome/i.test(body.slice(0, 6000));
console.log(`blocked=${blocked}`);

if (body.includes('"journeys"')) {
  const label = body.indexOf('"journeys"');
  const start = body.indexOf('[', label);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  const journeys = JSON.parse(body.slice(start, end + 1));
  const flights = [];
  for (const j of journeys) for (const f of (j.flights || [])) flights.push(f);
  const gw = flights.filter((f) => f.isGoWildFareEnabled && f.goWildFare > 0);
  console.log(`journeys=${journeys.length} flights=${flights.length} goWildPositive=${gw.length}`);
  for (const f of gw.slice(0, 5)) {
    const legs = f.legs || [];
    console.log(`  dep=${legs[0] && legs[0].departureDate} arr=${legs[legs.length - 1] && legs[legs.length - 1].arrivalDate} ${f.stopsText} ${f.duration} gw=$${f.goWildFare} seats=${f.goWildFareSeatsRemaining}`);
  }
  process.exit(gw.length > 0 ? 0 : 1);
}
process.exit(2);
