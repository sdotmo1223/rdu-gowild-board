// Every offline suite, one process each, one summary and one exit code.
//
// These suites never touch a phone: they run against the simulated transport and the
// verbatim capture in test/fixtures/. The real-device acceptance run is
// test/live.mjs, which is deliberately not in this list because it needs hardware.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suites = [
  '01-probe.mjs',
  '02-display.mjs',
  '03-guard.mjs',
  '04-capture.mjs',
  '05-actions.mjs',
  '06-teardown.mjs',
  '07-stop.mjs',
  '08-tiers-isolation.mjs',
];

let failed = 0;
for (const file of suites) {
  console.log(`\n=== ${file} ===`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { stdio: 'inherit' });
  if (run.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${file} (exit ${run.status})`);
  }
}

if (failed) {
  console.error(`\n${failed} android-agent suite(s) failed`);
  process.exit(1);
}
console.log('\nandroid-agent: all suites passed');
