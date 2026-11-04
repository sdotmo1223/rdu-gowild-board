// The carried-row stamp. A row carried forward must report when it was really
// fetched, not when it was carried. Found 2026-11-04: fresh sweep records carried
// no timestamp, so the FIRST carry stamped itself with the current tick and the
// page reported data one tick fresher than it was.
import assert from 'node:assert/strict';
import { mergeSweeps } from '../collector/parse.mjs';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};

const T0 = 1793822046218;
const HOUR = 3600000;
const DATE = '2026-11-05';
const fresh = (dest, at) => ({
  date: DATE,
  dest,
  ok: true,
  blocked: false,
  flights: [{ date: DATE, dest, allin: 25.21, goWild: true }],
  reason: 'ok',
  at,
});

// 1. First carry: the stamp is the fetch time, not now.
let r = mergeSweeps([fresh('ATL', T0)], [fresh('MCO', T0 + HOUR)], [DATE], {
  now: T0 + HOUR,
  plannedDests: ['MCO'],
});
let atl = r.sweeps.find((s) => s.dest === 'ATL');
ok(Boolean(atl && atl.carried === true), 'ATL should be carried');
ok(atl.carriedAt === T0, `first carry stamped ${atl.carriedAt - T0}ms late`);
ok(atl.carriedReason === 'rotated', `reason was ${atl.carriedReason}`);

// 2. A second carry keeps the original fetch time, not the newest tick.
r = mergeSweeps(r.sweeps, [fresh('MCO', T0 + 2 * HOUR)], [DATE], {
  now: T0 + 2 * HOUR,
  plannedDests: ['MCO'],
});
atl = r.sweeps.find((s) => s.dest === 'ATL');
ok(atl.carriedAt === T0, 'a re-carried row must keep its original fetch time');

// 3. A row from an older snapshot has no stamp: fall back to now, never NaN.
r = mergeSweeps([{ date: DATE, dest: 'CLE', ok: true, blocked: false, flights: [], reason: 'ok' }], [fresh('MCO', T0)], [DATE], {
  now: T0,
  plannedDests: ['MCO'],
});
ok(r.sweeps.find((s) => s.dest === 'CLE').carriedAt === T0, 'a stampless row must fall back to now');

// 4. A refused burst carries the row too, and must keep its fetch time.
r = mergeSweeps([fresh('DEN', T0)], [{ date: DATE, dest: 'MCO', ok: true, blocked: false, flights: [], reason: 'ok', at: T0 + HOUR }], [DATE], {
  now: T0 + HOUR,
  plannedDests: ['MCO', 'ATL'],
});
ok(r.sweeps.find((s) => s.dest === 'DEN').carriedAt === T0, 'carry across a refusal lost the fetch time');

// 5. The stamp never regresses: carried twice more, still the original.
for (let i = 3; i <= 5; i += 1) {
  r = mergeSweeps(r.sweeps, [fresh('MCO', T0 + i * HOUR)], [DATE], { now: T0 + i * HOUR, plannedDests: ['MCO'] });
}
ok(r.sweeps.find((s) => s.dest === 'DEN').carriedAt === T0, 'stamp drifted after repeated carries');

console.log(`carry: ${checks} checks passed`);
