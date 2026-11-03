import { readFileSync, writeFileSync } from 'node:fs';
const snip = (n) => readFileSync(`.snips/${n}.txt`, 'utf8');

function edit(file, pairs) {
  let s = readFileSync(file, 'utf8');
  for (const [label, oldS, newS] of pairs) {
    if (s.includes(newS.slice(0, 60))) { console.log(`  skip ${file} :: ${label} (already applied)`); continue; }
    if (!s.includes(oldS)) throw new Error(`anchor missing in ${file} :: ${label}`);
    s = s.replace(oldS, newS);
    console.log(`  ok   ${file} :: ${label}`);
  }
  writeFileSync(file, s);
}

edit('package.json', [[
  'test gate',
  '"test": "node test/acceptance.mjs",',
  '"test": "node test/acceptance.mjs && node test/profiles.mjs",',
]]);

edit('collector/collect.mjs', [
  ['import', "import { buildAlert, sendAlert } from '../src/alerts.mjs';", "import { buildAlert, buildZeroAlert, sendAlert } from '../src/alerts.mjs';"],
  ['const', "const KV_KEY = 'state';", "const KV_KEY = 'state';\n// A city pair retired after this many \"not sold\" answers.\nconst QUARANTINE_AFTER = 3;"],
  ['pool', "  const shard = process.env.FULL_SWEEP === '1' ? null : routeShard(startedAt);\n  const shardList = shardRoutes(ROUTES, shard);", snip('pool')],
  ['log', `  console.log(
    \`sweep plan: \${plannedRoutes.length}/\${ROUTES.length} routes x \${dates.length} date(s) = \${
      dates.length * plannedRoutes.length
    } requests (shard \${shard === null ? 'full' : shard}, budget \${budget}\${
      skipToday ? '; today skipped, departures finished' : ''
    })\`,
  );`, snip('log')],
  ['hits', '  const sweeps = [];\n  const total = dates.length * plannedRoutes.length;', '  const sweeps = [];\n  const notServedHits = [];\n  const servedHits = [];\n  const total = dates.length * plannedRoutes.length;'],
  ['track', "      sweeps.push({ date, dest: route.code, ...parsed });\n      console.log(", "      sweeps.push({ date, dest: route.code, ...parsed });\n      if (parsed.notServed) notServedHits.push(route.code);\n      else if (parsed.ok && watch[route.code]) servedHits.push(route.code);\n      console.log("],
  ['watch', '  state.version = 1;', snip('watch') + '  state.version = 1;'],
  ['zero', "    const boardRows = allFlights.filter((f) => f.goWild && f.allin !== null && f.allin <= 50);\n", snip('zero') + "    const boardRows = allFlights.filter((f) => f.goWild && f.allin !== null && f.allin <= 50);\n"],
  ['lastSweep', '      skippedToday: skipToday,\n    };', '      skippedToday: skipToday,\n      quarantined: quarantined.length,\n    };'],
  ['alert', '    const alert = buildAlert(state, fresh, now);', '    const alert = buildAlert(state, fresh, now) || buildZeroAlert(state, now);'],
]);

edit('src/alerts.mjs', [[
  'zero alert',
  'function money(n) {',
  snip('alerts').trimStart() + '\nfunction money(n) {',
]]);

let a = readFileSync('src/alerts.mjs', 'utf8');
if (!a.includes("from './routes.js'")) {
  a = "import { ORIGIN } from './routes.js';\n\n" + a;
  writeFileSync('src/alerts.mjs', a);
  console.log('
