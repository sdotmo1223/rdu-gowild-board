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
