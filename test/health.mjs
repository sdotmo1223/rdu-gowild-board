// Liveness and capability: the board must be able to say that nothing is writing to
// it, and a shared read link must not be able to replace what it reads.
import assert from 'node:assert/strict';
import {
  buildHeartbeatAlert,
  shouldSendStaleAlert,
  STALE_ALERT_AFTER_MIN,
  HEARTBEAT_REPEAT_MS,
} from '../src/alerts.mjs';
import { validTopic } from '../src/alerts.mjs';
import { ingestAuthorized } from '../src/index.js';
import { STALE_AFTER_MIN } from '../src/board.js';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const HOUR = 3600000;
const now = Date.now();

// The threshold itself. 180 is not a taste: it is three measured median gaps.
ok(STALE_AFTER_MIN === 180, 'stale means three missed hourly ticks');
ok(STALE_AFTER_MIN > 81, 'above the worst gap measured on 2026-11-04, or a healthy board goes amber');

// Collector heartbeat
ok(buildHeartbeatAlert({ updatedAt: now - 10 * 60000 }, now) === null, 'a fresh snapshot is silent');
const hb = buildHeartbeatAlert({ updatedAt: now - 5 * HOUR }, now);
ok(Boolean(hb) && hb.kind === 'heartbeat', 'silence past the limit alerts');
ok(/collector silent/.test(String(hb && hb.title)), 'the push says what happened, not just that something did');
ok(/5h/.test(String(hb && hb.title)), 'the age is in the title');
ok(buildHeartbeatAlert({ updatedAt: now - 5 * HOUR, lastHeartbeatAt: now - HOUR }, now) === null, 'deduped inside six hours');
ok(
  Boolean(buildHeartbeatAlert({ updatedAt: now - 5 * HOUR, lastHeartbeatAt: now - HEARTBEAT_REPEAT_MS - 1 }, now)),
  're-fires after six hours',
);
ok(buildHeartbeatAlert(null, now) === null, 'no snapshot is not an alert');
ok(buildHeartbeatAlert({}, now) === null, 'an empty record is not an alert');
ok(buildHeartbeatAlert({ updatedAt: 'yesterday' }, now) === null, 'an unparseable clock is not an alert');

// Worker decision: the only thing alive when the cron is dead.
ok(shouldSendStaleAlert(200, 0, now) === true, 'four hours of silence from the Worker alerts');
ok(shouldSendStaleAlert(10, 0, now) === false, 'a healthy board is silent');
ok(shouldSendStaleAlert(200, now - HOUR, now) === false, 'deduped inside six hours');
ok(shouldSendStaleAlert(200, now - HEARTBEAT_REPEAT_MS - 1, now) === true, 're-fires after six hours');
ok(shouldSendStaleAlert(null, 0, now) === false, 'no age, no claim');
ok(shouldSendStaleAlert(Number.NaN, 0, now) === false, 'NaN is not an age');
ok(STALE_ALERT_AFTER_MIN === STALE_AFTER_MIN, 'alert and banner share a threshold, or one of them lies');

// The topic bootstrap: a value that is not a topic is ignored, never posted.
ok(validTopic('gowild-rdu-abc123') === true, 'a plain topic is accepted');
ok(validTopic('has space') === false, 'a topic with a space is refused');
ok(validTopic('') === false, 'an empty topic is refused');
ok(validTopic('x'.repeat(65)) === false, 'an over-long topic is refused');
ok(validTopic(null) === false && validTopic(undefined) === false, 'absence is not a topic');

// Read and write are different capabilities.
const post = (token) =>
  new Request('https://b.test/api/ingest', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
const split = { BOARD_TOKEN: 'read-token-aaaaaaaa', BOARD_WRITE_TOKEN: 'write-token-bbbb' };
ok(ingestAuthorized(post('write-token-bbbb'), split) === true, 'the write token writes');
ok(ingestAuthorized(post('read-token-aaaaaaaa'), split) === false, 'a shared read link cannot replace the snapshot');
ok(ingestAuthorized(post(''), split) === false, 'no token cannot write');
ok(ingestAuthorized(post('read-token-aaaaaaaa'), { BOARD_TOKEN: 'read-token-aaaaaaaa' }) === true, 'before the split the old token still writes, so the deploy cannot break the cron');
ok(ingestAuthorized(post('wrong'), { BOARD_TOKEN: 'read-token-aaaaaaaa' }) === false, 'the fallback still checks the value');
ok(ingestAuthorized(post('read-token-aaaaaaaa'), {}) === false, 'no configuration cannot write');

console.log(`health: ${checks} checks passed`);
