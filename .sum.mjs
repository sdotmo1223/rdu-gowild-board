import { readFileSync } from 'node:fs';
const s = readFileSync('.kv.raw', 'utf8');
const a = s.indexOf('{'), b = s.lastIndexOf('}');
if (a < 0 || b < a) { console.error('no json in kv output'); process.exit(1); }
const o = JSON.parse(s.slice(a, b + 1));
const sweeps = o.sweeps || [];
const byDate = {};
for (const w of sweeps) {
  const d = (byDate[w.date] = byDate[w.date] || { routes: 0, ok: 0, carried: 0, flights: 0, gw: 0 });
  d.routes++;
  if (w.ok) d.ok++;
  if (w.carried) d.carried++;
  const fl = w.flights || [];
  d.flights += fl.length;
  d.gw += fl.filter((f) => f.goWild).length;
}
console.log('generatedAt :', new Date(o.generatedAt).toISOString());
console.log('routeCount  :', o.routeCount, '| lastError:', o.lastError ? o.lastError.kind : 'none');
for (const k of Object.keys(byDate).sort()) console.log('  ' + k, JSON.stringify(byDate[k]));
const dests = [...new Set(sweeps.map((w) => w.dest))].sort();
console.log('routes asked:', dests.join(' ') || '(none)', `(${dests.length})`);
console.log('fares       :', Object.keys(o.fares || {}).length, 'instances');
