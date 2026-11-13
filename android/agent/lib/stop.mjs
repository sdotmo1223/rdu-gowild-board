// The stop switch.
//
// One command that puts the phone back: overlay setting deleted and verified, apps
// this run launched force-stopped (unless the owner has them on screen), the adb
// connection dropped only if the run created it, and a report of everything still
// running afterwards.
import { readFileSync } from 'node:fs';
import { createDisplayManager } from './display.mjs';
import { idsOf, readActivityDisplays, resumedOn } from './device.mjs';
import { readActiveRecord, clearActiveRecord } from './report.mjs';
import { nowIso, oneLine } from './util.mjs';

export async function runStop({ adb, recordPath = null, record = null, forceStopApps = true, disconnect = null, dryRun = false } = {}) {
  const at = nowIso();
  const active = record || (recordPath ? JSON.parse(readFileSync(recordPath, 'utf8')) : readActiveRecord());
  const actions = [];
  const manager = createDisplayManager({ adb });

  const setting = await manager.overlaySetting();
  const before = await manager.listDisplays();
  let teardown = null;

  if (setting.value === null) {
    actions.push({ action: 'delete-overlay-setting', skipped: true, reason: 'setting-unreadable' });
  } else if (setting.value === 'null') {
    actions.push({ action: 'delete-overlay-setting', skipped: true, reason: 'already-null' });
  } else if (dryRun) {
    actions.push({ action: 'delete-overlay-setting', planned: true, setting: setting.value });
  } else {
    teardown = await manager.close({ reason: 'stop-switch', force: true });
    actions.push({
      action: 'delete-overlay-setting',
      ok: Boolean(teardown.ok),
      settingBefore: setting.value,
      settingAfter: teardown.settingAfter,
      residue: teardown.residue,
    });
  }

  const apps = Array.isArray(active?.apps) ? active.apps : [];
  const activity = await readActivityDisplays(adb);

  for (const pkg of apps) {
    const onDisplayZero = resumedOn(activity.displays, 0).some((entry) => entry.package === pkg);
    if (onDisplayZero) {
      actions.push({
        action: 'force-stop',
        package: pkg,
        skipped: true,
        reason: 'resumed-on-display-0',
        detail: 'the owner has this app on screen; stopping it would be the disruption this tool exists to avoid',
      });
      continue;
    }
    if (!forceStopApps) {
      actions.push({ action: 'force-stop', package: pkg, skipped: true, reason: 'disabled-by-caller' });
      continue;
    }
    if (dryRun) {
      actions.push({ action: 'force-stop', package: pkg, planned: true });
      continue;
    }
    const result = await adb.shell(`am force-stop ${pkg}`);
    actions.push({ action: 'force-stop', package: pkg, ok: result.ok, output: oneLine(result.err || result.text) });
  }

  const stillRunning = [];
  for (const pkg of apps) {
    const pid = await adb.shell(`pidof ${pkg}`);
    if (pid.text.trim()) stillRunning.push({ package: pkg, pid: Number(pid.text.trim().split(/\s+/)[0]) });
  }

  const shouldDisconnect = disconnect === null ? Boolean(active?.connection?.createdByRun) : Boolean(disconnect);
  let disconnected = null;
  if (shouldDisconnect && !dryRun) {
    const result = await adb.disconnect();
    disconnected = { ok: result.ok, serial: result.serial, output: result.text };
    actions.push({ action: 'adb-disconnect', ok: result.ok, serial: result.serial });
  } else {
    actions.push({
      action: 'adb-disconnect',
      skipped: true,
      reason: disconnect === false ? 'disabled-by-caller' : 'the run did not create the connection',
    });
  }

  const tasksOnOtherDisplays = (activity.displays || [])
    .filter((display) => display.id !== 0 && display.activities.length > 0)
    .map((display) => ({ display: display.id, activities: display.activities }));

  const leftoverSetting = (await manager.overlaySetting()).value;
  const leftoverDisplays = idsOf((await manager.listDisplays()).displays);
  const residue = leftoverSetting !== 'null' || leftoverDisplays.some((id) => id !== 0);

  const result = {
    ok: !residue,
    at,
    dryRun,
    runId: active?.runId || null,
    recordSource: recordPath || (active ? 'active-record' : 'none'),
    displaysBefore: idsOf(before.displays),
    actions,
    teardown,
    leftovers: {
      overlaySetting: leftoverSetting,
      displays: leftoverDisplays,
      appsStillRunning: stillRunning,
      tasksOnOtherDisplays,
      adbConnected: !disconnected || !disconnected.ok,
    },
    disconnected,
  };

  // Clear the pointer the caller named, not just the default one, otherwise a run
  // invoked with --record leaves its crash-safety file behind forever.
  if (result.ok && !dryRun) clearActiveRecord(recordPath || undefined);
  return result;
}

export function stopSummary(result) {
  const lines = [];
  lines.push(`stop switch ${result.ok ? 'clean' : 'LEFT RESIDUE'}${result.dryRun ? ' (dry run)' : ''} · run ${result.runId || 'none'}`);
  for (const action of result.actions) {
    const state = action.ok === true ? 'ok' : action.skipped ? `skipped (${action.reason})` : action.planned ? 'planned' : 'FAILED';
    const detail = action.package ? ` ${action.package}` : '';
    lines.push(`  ${action.action}${detail} — ${state}`);
  }
  lines.push(`  overlay setting: ${result.leftovers.overlaySetting}`);
  lines.push(`  displays: [${result.leftovers.displays.join(', ')}]`);
  lines.push(`  apps still running: ${result.leftovers.appsStillRunning.map((entry) => `${entry.package}(${entry.pid})`).join(', ') || 'none'}`);
  lines.push(`  tasks on other displays: ${result.leftovers.tasksOnOtherDisplays.length ? JSON.stringify(result.leftovers.tasksOnOtherDisplays) : 'none'}`);
  return lines.join('\n');
}
