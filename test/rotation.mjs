// Tick-driven rotation. The guarantee is coverage, not a timetable: every route in
// a profile must be really asked within two consecutive ticks, whatever the wall
// clock says. Added 2026-11-04, after clock parity under an hourly cron left seven
// routes carried for 388 minutes while the other seven were 28 minutes old.
import assert from 'node:assert/strict';
import { PROFILES, nextShard, routeShard, shardRoutes } from '../src/routes.js';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};

const ROUTES = PROFILES.rdu.routes;
const ALL = ROUTES.map((r) => r.code).sort();
const HOUR = 3600000;
const t0 = 1793822046218; // a real sweep timestamp: 2026-11-04 14:54 ET

// 1. The defect, recorded so it can never be mistaken for correct behaviour.
ok(routeShard(t0) === routeShard(t0 + HOUR), 'clock parity repeats every hour (this is the defect)');

// 2. Alternation follows the previous tick, not the clock.
let last;
const shards = [];
for (let i = 0; i < 12; i += 1) {
  const s = nextShard(last, t0 + i * HOUR);
  shards.push(s);
  last = s;
}
for (let i = 0; i < shards.length - 1; i += 1) {
  ok(shards[i] !== shards[i + 1], `tick ${i} and tick ${i + 1} asked the same half`);
}

// 3. Coverage: any two consecutive ticks ask all 14 routes, exactly once each.
for (let i = 0; i < shards.length - 1; i += 1) {
  const a = shardRoutes(ROUTES, shards[i]).map((r) => r.code);
  const b = shardRoutes(ROUTES, shards[i + 1]).map((r) => r.code);
  ok(a.length + b.length === ALL.length, `two ticks covered ${a.length + b.length} of ${ALL.length}`);
  ok(JSON.stringify([...a, ...b].sort()) === JSON.stringify(ALL), `two ticks did not cover every route (pair ${i})`);
}

// 4. First run has no stored shard. The clock is only a guess, and a malformed
//    stored value must not stop the rotation.
ok([0, 1].includes(nextShard(undefined, t0)), 'first-run shard is not a valid half');
ok([0, 1].includes(nextShard(null, t0)), 'null lastShard is not a valid half');
ok(nextShard('1', t0) === 0 && nextShard('0', t0) === 1, 'a string shard did not alternate');
ok(nextShard(7, t0) === routeShard(t0), 'an invalid stored shard must fall back to the clock');

// 5. Budgeted coverage. 8 requests over two dates is 4 routes per tick (LGA asks
//    5, PHL 8 of 11): every route must still be asked within four ticks, which is
//    the promise a small profile makes instead of a full sweep.
let cursor = 0;
last = undefined;
const asked = new Map();
for (let i = 0; i < 8; i += 1) {
  const s = nextShard(last, t0 + i * HOUR);
  const list = shardRoutes(ROUTES, s);
  const planned = Array.from({ length: 4 }, (_, k) => list[(cursor + k) % list.length]);
  for (const r of planned) if (!asked.has(r.code)) asked.set(r.code, i);
  cursor = (cursor + planned.length) % list.length;
  last = s;
}
ok(asked.has !== undefined, 'sanity');
for (const code of ALL) ok(asked.has(code), `${code} was never asked under a 4-route budget`);

console.log(`rotation: ${checks} checks passed (shards ${shards.join('')}, budgeted ${asked.size}/${ALL.length})`);
