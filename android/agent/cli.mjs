#!/usr/bin/env node
// One entry point. Four verbs, and the first one gates the others.
//
//   probe   Phase 0. Read-only apart from creating and reverting an overlay display.
//   status  read-only; never changes the device.
//   run     probe, policy, overlay, script, teardown — in that order.
//   stop    put the phone back and report what is still running.
//
// Exit codes: 0 ok · 1 failed · 2 refused (a normal result, with a reason) · 3 no device.
import { createAdb, defaultAdbPath } from './lib/adb.mjs';
import { capabilityProbe, probeSummary } from './lib/probe.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { runSession, PLANS, EVIDENCE_ROOT } from './lib/session.mjs';
import { runStop, stopSummary } from './lib/stop.mjs';
import { readOwnerState } from './lib/guard.mjs';
import { readDisplays, idsOf } from './lib/device.mjs';
import { createIsolationBackend } from './lib/isolation.mjs';
import { readActiveRecord } from './lib/report.mjs';

function parseArgs(argv) {
  const flags = {};
  const approvals = [];
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        if (key === 'approve') approvals.push(next);
        else flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional[0] || 'help', flags, approvals };
}

async function connectAdb(flags) {
  const adb = createAdb({
    adbPath: flags.adb || defaultAdbPath(),
    serial: flags.serial || process.env.ANDROID_SERIAL || null,
  });
  const resolved = await adb.resolveSerial();
  return { adb, resolved };
}

function printRun(report) {
  const outcome = report.ok ? 'ok' : report.refused ? 'refused' : 'FAILED';
  console.log(`run ${report.runId} · ${outcome}${report.reason ? ` · ${report.reason}` : ''}`);
  if (report.open && report.open.id != null) {
    console.log(`overlay   display ${report.open.id} · screencap id ${report.open.sfId || 'none'} (${report.open.sfIdSource}) · ${report.open.width}x${report.open.height}`);
  }
  console.log(`app       ${report.app} · tier ${report.tier}`);
  console.log(`tiers     ${Object.entries(report.tierCounts).map(([tier, count]) => `${tier}=${count}`).join(' ') || 'none'}`);
  for (const step of report.steps) {
    const mark = step.ok ? 'ok  ' : 'FAIL';
    const file = step.path ? ` -> ${String(step.path).split(/[\\/]/).pop()} (${step.width}x${step.height}, ${step.bytes} B)` : '';
    console.log(`  ${String(step.index).padStart(2)} ${mark} [${step.tier}] ${step.action}${step.label ? ` (${step.label})` : ''}${file}${step.reason ? ` · ${step.reason}` : ''}`);
  }
  if (report.crown && report.crown.applies !== false) {
    console.log(
      `crown     display 0 ${report.crown.displayZeroStable ? 'identical' : 'CHANGED'} · top focused ${report.crown.topFocusedBefore} -> ${report.crown.topFocusedDuring ?? '-'} -> ${report.crown.topFocusedAfter}`,
    );
  }
  if (report.battery) {
    console.log(`battery   ${report.battery.measureMah ?? 'unavailable'} mAh (${report.battery.source})${report.battery.charging ? ' · charging' : ''} over ${report.battery.elapsedS}s`);
  }
  if (report.teardown) {
    console.log(`teardown  setting=${report.teardown.settingAfter} displays=[${(report.teardown.displaysAfter || []).join(', ')}] residue=${report.teardown.residue}`);
  }
  if (report.evidence) console.log(`evidence  ${report.evidence.dir}`);
  for (const limit of report.limits || []) console.log(`limit     ${limit}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags, approvals } = parseArgs(argv);

  if (command === 'help' || flags.help) {
    console.log(`quiet workspace — Android agent harness

  node android/agent/cli.mjs probe  [--json] [--no-refresh] [--serial S]
  node android/agent/cli.mjs status [--json]
  node android/agent/cli.mjs run    --app com.example [--plan ${Object.keys(PLANS).join('|')}] [--approve PKG] [--out DIR] [--skip-probe]
  node android/agent/cli.mjs run    --app com.example --isolated [--backend emulator|workprofile] [--avd NAME]
  node android/agent/cli.mjs stop   [--dry-run] [--keep-apps] [--no-disconnect]

Nothing acts before \`probe\` speaks: \`run\` re-runs it unless --skip-probe is given, and
refuses when the verdict is NO. Evidence lands in ${EVIDENCE_ROOT}`);
    return 0;
  }

  const { adb, resolved } = await connectAdb(flags);
  if (!resolved.ok) {
    console.error(`no usable device: ${resolved.reason}`);
    if (resolved.candidates) console.error(`candidates: ${JSON.stringify(resolved.candidates)}`);
    console.error('Start wireless debugging on the phone and re-run, or pass --serial.');
    return 3;
  }

  if (command === 'probe') {
    const probe = await capabilityProbe({ adb, refresh: !flags['no-refresh'], cachePath: flags.cache || undefined });
    if (flags.json) console.log(JSON.stringify(probe, null, 2));
    else console.log(probeSummary(probe));
    return probe.verdict === 'no' ? 1 : 0;
  }

  if (command === 'status') {
    const owner = await readOwnerState(adb);
    const displays = await readDisplays(adb);
    const setting = await adb.shell('settings get global overlay_display_devices');
    const active = readActiveRecord();
    const status = {
      serial: adb.serial,
      owner: { verdict: owner.verdict, wakefulness: owner.wakefulness, signals: owner.signals },
      displays: displays.displays,
      overlaySetting: setting.text.replace(/\r/g, '').trim() || 'null',
      activeRun: active ? { runId: active.runId, dir: active.dir, display: active.display, apps: active.apps } : null,
    };
    if (flags.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`serial    ${status.serial}`);
      console.log(`owner     ${status.owner.verdict} (${status.owner.signals.join(', ')})`);
      console.log(`displays  [${idsOf(status.displays).join(', ')}]`);
      for (const display of status.displays) console.log(`  ${display.id}: ${display.name} ${display.width}x${display.height} ${display.type}`);
      console.log(`overlay   ${status.overlaySetting}`);
      console.log(`active    ${active ? `${active.runId} (${active.dir})` : 'none'}`);
    }
    return 0;
  }

  if (command === 'run') {
    const app = flags.app;
    if (!app) {
      console.error('run needs --app <package>');
      return 1;
    }
    if (!flags['skip-probe']) {
      const probe = await capabilityProbe({ adb, refresh: true });
      console.log(probeSummary(probe));
      if (probe.verdict === 'no') {
        console.error('\nprobe verdict is NO: nothing will act on this device. Fix the limit above first.');
        return 2;
      }
    }

    let isolation = null;
    if (flags.isolated) {
      const backend = createIsolationBackend({
        kind: flags.backend || 'emulator',
        baseAdb: adb,
        avd: flags.avd || undefined,
      });
      const started = await backend.start();
      if (!started.ok) {
        const kind = flags.backend || 'emulator';
        console.error(`isolation backend "${kind}" is not usable: ${started.reason}${started.detail ? ` — ${started.detail}` : ''}`);
        console.error('Nothing ran. The virtual tier is still available without --isolated.');
        return 2;
      }
      isolation = { kind: started.backend, backend };
    }

    const policy = loadPolicy(flags.policy || undefined);
    const report = await runSession({
      adb,
      app,
      policy,
      approvals,
      outDir: flags.out || null,
      plan: flags.plan || 'smoke',
      isolation,
    });
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else printRun(report);
    return report.ok ? 0 : report.refused ? 2 : 1;
  }

  if (command === 'stop') {
    const result = await runStop({
      adb,
      recordPath: flags.record || null,
      forceStopApps: !flags['keep-apps'],
      disconnect: flags['no-disconnect'] ? false : null,
      dryRun: Boolean(flags['dry-run']),
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(stopSummary(result));
    return result.ok ? 0 : 1;
  }

  console.error(`unknown command: ${command}`);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`${error.name || 'Error'}: ${error.message || error}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
    process.exitCode = 1;
  });
