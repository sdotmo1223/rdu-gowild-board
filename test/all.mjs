// Run every suite in one process and print each summary.
//
// `npm test` used to chain with `&&`, so a passing run showed only the profiles
// tail and a failing run buried the acceptance reason. Two suites, two summaries,
// one exit code.
import { spawnSync } from 'node:child_process';

const suites = [
  ['acceptance', 'test/acceptance.mjs'],
  ['profiles', 'test/profiles.mjs'],
  ['merge', 'test/merge.mjs'],
  ['rotation', 'test/rotation.mjs'],
  ['carry', 'test/carry.mjs'],
  ['resilience', 'test/resilience.mjs'],
  ['health', 'test/health.mjs'],
  ['sink', 'test/sink.mjs'],
  ['recovery', 'test/recovery.mjs'],
  ['watch', 'test/watch.mjs'],
  ['attempt', 'test/attempt.mjs'],
  ['outbox', 'test/outbox.mjs'],
  ['dispatch', 'test/dispatch.mjs'],
  ['zero', 'test/zero.mjs'],
  ['freshness', 'test/freshness.mjs'],
  ['updates', 'test/updates.mjs'],
  ['channel', 'test/channel.mjs'],
  ['shapes', 'test/shapes.mjs'],
  ['doclint', 'test/doclint.mjs'],
  ['ledger', 'test/ledger.mjs'],
  ['settings', 'test/settings.mjs'],
  ['liveness', 'test/liveness.mjs'],
  ['briefing', 'test/briefing.mjs'],
  ['push', 'test/push.mjs'],
  // Offline only: the android harness runs against a simulated transport and a
  // verbatim device capture. The real-device suite (test/live.mjs) needs hardware and
  // is deliberately not part of the gate.
  ['android-agent', 'android/agent/test/run-all.mjs'],
];

let failed = 0;
for (const [name, file] of suites) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${name} (exit ${r.status}${r.signal ? `, signal ${r.signal}` : ''})`);
  }
}

if (failed) {
  console.error(`\n${failed} suite(s) failed`);
  process.exit(1);
}
console.log('\nall suites passed');
