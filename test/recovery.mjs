// The recovery cron entry must cost nothing when the primary is delivering.
//
// Measured 2026-11-07: GitHub delivered 9 scheduled runs in 24 hours on a */15 cron,
// with gaps of 233, 362 and 434 minutes, so the board sat hours old three times in a
// day. A second entry fills those holes, but only if it declines to sweep a board
// that is already fresh -- otherwise a healthy hour costs two bursts at Frontier.
//
// The direction of every failure below is deliberate: an unreadable age sweeps.
import assert from 'node:assert/strict';
import {
  PRIMARY_CRON, RECOVERY_SKIP_BELOW_MIN, recoveryDecision, snapshotAgeMin,
} from '../tools/recovery-gate.mjs';

const RECOVERY = '5,20,35,50 * * * *';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};

// 1. The primary slot always sweeps.
ok(recoveryDecision({ schedule: PRIMARY_CRON, ageMin: 500 }).skip === false, 'the primary slot must sweep');
ok(recoveryDecision({ schedule: null, ageMin: 500 }).skip === false, 'an untagged schedule must sweep');

// 2-4. A recovery slot declines only while the board is genuinely fresh.
ok(recoveryDecision({ schedule: RECOVERY, ageMin: 10 }).skip === true, 'a 10-minute-old board must not be swept twice');
ok(recoveryDecision({ schedule: RECOVERY, ageMin: RECOVERY_SKIP_BELOW_MIN - 1 }).skip === true, 'just under the threshold must skip');
ok(recoveryDecision({ schedule: RECOVERY, ageMin: RECOVERY_SKIP_BELOW_MIN }).skip === false, 'at the threshold the recovery slot must sweep');

// 5-6. A stale board, and an age nobody can read, both sweep.
ok(recoveryDecision({ schedule: RECOVERY, ageMin: 120 }).skip === false, 'a 2-hour-old board must be swept');
ok(recoveryDecision({ schedule: RECOVERY, ageMin: null }).skip === false, 'an unreadable age must sweep, never skip');

// 7-8. The age comes from the payload the Worker already serves.
ok(snapshotAgeMin({ ageMinutes: 116 }) === 116, 'ageMinutes must survive');
ok(Math.round(snapshotAgeMin({ updatedAt: Date.now() - 120 * 60000 })) === 120, 'updatedAt must be usable when ageMinutes is absent');

// 9-10. Absent or malformed payloads are unknown, never zero.
ok(snapshotAgeMin({}) === null, 'a payload with no age must be unknown');
ok(snapshotAgeMin(null) === null, 'a missing payload must be unknown');

console.log(`recovery: ${checks} checks passed`);
