// Build test/fixtures/route.json from a real captured flight in .sweep/.
//
// .sweep/ holds PARSED flights, not raw HTML, so there is no payload to trim. This
// rebuilds a parser-shaped payload around a flight that was actually observed, so
// the dry-run harness exercises the real extractJourneys/normalizeFlight path on
// real numbers instead of on invented ones. Output is a few hundred bytes and
// committable; .sweep/ itself is gitignored so CI could never read it.
//
// The fixture's departure dates are re-based onto the sweep's own today at load
// time (see openFixturePage in collector/collect.mjs), so a committed fixture does
// not age out of the 48-hour window by tomorrow.
//
// Run: node tools/make-fixture.mjs [capture.json]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseRoute } from '../collector/parse.mjs';

const OUT = 'test/fixtures/route.json';

if (!existsSync('.sweep')) {
  console.error('no .sweep/ directory: run a sweep first (node collector/collect.mjs)');
  process.exit(1);
}

const files = process.argv[2]
  ? [process.argv[2]]
  : readdirSync('.sweep')
      .filter((f) => f.endsWith('.json'))
      .map((f) => join('.sweep', f))
      .sort();

let built = null;
for (const file of files) {
  let cap;
  try {
    cap = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const f = (cap.flights || []).find((x) => x && x.enabled && Number(x.gw) > 0 && x.dep);
  if (!f) continue;
  const journey = {
    flights: [
      {
        legs: [{ departureDate: f.dep, arrivalDate: f.arr || f.dep, flightNumber: 'F9 1234' }],
        goWildFare: Number(f.gw),
        isGoWildFareEnabled: true,
        standardFare: Number(f.std) || 0,
        goWildFareSeatsRemaining: '3 Seats Left!',
        stopsText: f.stops || 'Nonstop',
        stopCount: f.nonstop ? 0 : 1,
        duration: f.dur || null,
      },
    ],
  };
  const payload = JSON.stringify({
    status: 200,
    url: 'https://booking.flyfrontier.com/Flight/InternalSelect',
    text: JSON.stringify({ journeys: [journey] }),
  });
  const probe = parseRoute(JSON.parse(payload), '2026-11-03', 'ATL', 'Atlanta');
  if (!probe.ok || !probe.flights.length) continue;
  built = { file, payload, row: probe.flights[0] };
  break;
}

if (!built) {
  console.error('no capture in .sweep/ yielded a GoWild flight; run a sweep first');
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, built.payload);
console.log(
  `fixture: ${OUT} from ${built.file} (${built.payload.length} bytes, dep ${built.row.dep}, all-in $${built.row.allin})`,
);
