// Second replay attempt with a full Chrome navigation-header profile.
// Isolates whether DataDome blocks on headers (fixable) or on TLS fingerprint (fatal).
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
console.log(`cookie: ${cookie ? `${cookie.length} chars` : 'MISSING'}`);
if (!cookie) process.exit(9);

const url = 'https://booking.flyfrontier.com/Flight/InternalSelect?o1=RDU&d1=MCO&dd1=Nov%2003,%202026&ADT=1&mon=true&promo=';

const res = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    'Cookie': cookie,
  },
});
const body = await res.text();
console.log(`status=${res.status} finalUrl=${res.url} bytes=${body.length}`);
console.log(`hasJourneysToken=${body.includes('"journeys"')}`);
console.log(`blocked=${/Flight\/Redirect/.test(res.url)}`);
const title = (body.match(/<title>([^<]*)<\/title>/) || [])[1];
console.log(`title=${title}`);
process.exit(body.includes('"journeys"') ? 0 : 2);
