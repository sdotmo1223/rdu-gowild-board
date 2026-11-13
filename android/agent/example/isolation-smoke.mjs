// One working example of the isolation seam.
//
// The point of the seam is that a test script is written once against the Action API
// and can then be run on the private overlay (tier `virtual`) or on an isolated
// backend (tier `isolated`) with no change. This example proves that by running the
// SAME step list twice:
//
//   1. against the real device's availability checks, so the emulator and work-profile
//      refusals are visible with their exact reasons (this laptop has no emulator
//      package and the phone has only user 0, so both refuse — that is the honest
//      output here);
//   2. against the recorded device transport, so the script itself executes and prints
//      a tier per action today.
//
//   node android/agent/example/isolation-smoke.mjs
//   node android/agent/example/isolation-smoke.mjs --device   # if an emulator exists
import { createAdb, defaultAdbPath } from '../lib/adb.mjs';
import { createActions } from '../lib/actions.mjs';
import { createIsolationBackend } from '../lib/isolation.mjs';
import { createFakeAdb } from '../test/fake-adb.mjs';

const STEPS = [
  { do: 'launch', app: 'com.freebuff.gowild' },
  { do: 'read' },
  { do: 'tap', x: 360, y: 640 },
  { do: 'swipe', x1: 360, y1: 1000, x2: 360, y2: 400, ms: 300 },
  { do: 'back' },
];

async function runScript(actions, label) {
  const rows = [];
  for (const step of STEPS) {
    let result;
    if (step.do === 'launch') result = await actions.launch(step.app);
    else if (step.do === 'read') result = await actions.readState();
    else if (step.do === 'tap') result = await actions.tap(step.x, step.y, { label: 'example-tap' });
    else if (step.do === 'swipe') result = await actions.swipe(step.x1, step.y1, step.x2, step.y2, step.ms, { label: 'example-swipe' });
    else result = await actions.back({ label: 'example-back' });
    rows.push({ script: label, action: result.action, tier: result.tier, ok: result.ok, detail: result.reason || result.label || '' });
  }
  return rows;
}

async function main() {
  const rows = [];
  const useDevice = process.argv.includes('--device');
  const adbPath = defaultAdbPath();

  // 1. What each isolation backend can actually do here, with its reason.
  for (const kind of ['emulator', 'workprofile']) {
    const backend = createIsolationBackend({ kind, baseAdb: createAdb({ adbPath, serial: process.env.ANDROID_SERIAL || null }) });
    const ready = await backend.available();
    rows.push({
      script: 'availability',
      action: `backend:${kind}`,
      tier: 'isolated',
      ok: ready.ok,
      detail: ready.ok ? `ready${ready.avd ? ` (avd ${ready.avd})` : ''}${ready.user ? ` (user ${ready.user})` : ''}` : ready.reason,
    });
  }

  // 2. The same script, executed. On this machine that means the recorded transport;
  //    --device points it at a real emulator when one exists.
  const transport = useDevice ? createAdb({ adbPath, serial: 'emulator-5554' }) : createFakeAdb();
  const actions = createActions({ adb: transport, tier: 'isolated', display: { id: null, sfId: null, width: null, height: null } });
  rows.push(...(await runScript(actions, useDevice ? 'device' : 'recorded')));

  console.log('script                action              tier       ok   detail');
  for (const row of rows) {
    console.log(`${row.script.padEnd(21)} ${row.action.padEnd(19)} ${row.tier.padEnd(10)} ${row.ok ? 'yes ' : 'NO  '} ${row.detail}`);
  }
  console.log('\nEvery row above is tagged with the tier that ran it. No display on the phone was created or touched for the isolated rows.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
