// Phase 0b — three sequential, spaced requests, no cookie, default redirect follow.
// Answers: (1) can a plain HTTP client get the payload? (2) what does a blackout
// date return? (3) what does a non-operating route return? Never prints secrets.

const TESTS = [
  { label: 'today MCO', dest: 'MCO', date: 'Nov%2003,%202026' },
  { label: 'blackout Nov24 MCO', dest: 'MCO', date: 'Nov%2024,%202026' },
  { label: 'CUN on a Wednesday', dest: 'CUN', date: 'Nov%2004,%202026' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractJourneys(text) {
  const label = text.indexOf('"journeys"');
  if (label === -1) return null;
  const start = text.indexOf('[', label);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

for (const test of TESTS) {
  const url = `https://booking.flyfrontier.com/Flight/InternalSelect?o1=RDU&d1=${test.dest}&dd1=${test.date}&ADT=1&mon=true&promo=`;
  console.log(`\n=== ${test.label} ===`);
  console.log(`GET ${url}`);
  let res, body;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml' },
    });
    body = await res.text();
  } catch (e) {
    console.log(`NETWORK_ERROR ${e.message}`);
    await sleep(3000);
    continue;
  }
  console.log(`status=${res.status} finalUrl=${res.url} bytes=${body.length}`);
  console.log(`hasJourneysToken=${body.includes('"journeys"')} hasGoWildField=${body.includes('isGoWildFareEnabled')}`);
  console.log(`datadomeBlock=${/datadome|captcha-delivery|blocked/i.test(body.slice(0, 4000))}`);

  const journeys = extractJourneys(body);
  if (journeys === null) { console.log('RESULT: NO journeys key at all'); }
  else if (journeys === undefined) { console.log('RESULT: journeys key present but unparseable'); }
  else {
    const flights = [];
    for (const j of journeys) for (const f of (j.flights || [])) flights.push(f);
    const gw = flights.filter((f) => f.isGoWildFareEnabled && typeof f.goWildFare === 'number' && f.goWildFare > 0);
    console.log(`RESULT: journeys=${journeys.length} flights=${flights.length} goWildPositive=${gw.length}`);
    for (const f of gw.slice(0, 6)) {
      const legs = f.legs || [];
      console.log(`  dep=${legs[0] && legs[0].departureDate} arr=${legs[legs.length - 1] && legs[legs.length - 1].arrivalDate} stops=${f.stopsText} dur=${f.duration} gw=$${f.goWildFare} std=$${f.standardFare} seats=${f.goWildFareSeatsRemaining}`);
    }
    const msgs = new Set();
    for (const f of flights) {
      for (const k of ['dateMessage', 'message']) {
        if (f[k]) msgs.add(`${k}: ${JSON.stringify(f[k]).slice(0, 200)}`);
      }
      if (Array.isArray(f.otherMessages)) for (const m of f.otherMessages) msgs.add(`other: ${JSON.stringify(m).slice(0, 200)}`);
    }
    console.log('  messages:', msgs.size ? [...msgs].join(' | ') : '(none)');
    if (legs0(gw[0])) console.log('  leg keys:', Object.keys(gw[0].legs[0]).sort().join(','));
  }
  await sleep(3500);
}

function legs0(f) { return f && f.legs && f.legs[0]; }
