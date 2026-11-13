// Run evidence: the crash-safety pointer and the human-readable summary.
//
// The pointer lives under android/agent/.runs/ (gitignored) because it changes every
// run. The evidence itself lands in docs/android-agent/evidence/<runId>/ and is meant
// to be kept: an acceptance test that leaves nothing behind is a claim, not evidence.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACTIVE_PATH = fileURLToPath(new URL('../.runs/active.json', import.meta.url));

export function writeActiveRecord(record, path = ACTIVE_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readActiveRecord(path = ACTIVE_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function clearActiveRecord(path = ACTIVE_PATH) {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

const yes = (value) => (value ? 'yes' : 'NO');

export function renderRunMarkdown(report) {
  const lines = [];
  const t = report;
  lines.push(`# Run ${t.runId}`);
  lines.push('');
  lines.push(`${t.startedAt} → ${t.finishedAt} · ${t.device?.model || 'unknown device'} · Android ${t.device?.release || '?'} (API ${t.device?.sdk || '?'})`);
  lines.push('');
  lines.push(`**Outcome:** ${t.ok ? 'ok' : 'FAILED'}${t.refused ? ' (refused)' : ''}${t.reason ? ` — ${t.reason}` : ''}`);
  lines.push('');
  lines.push('## The crown invariant');
  lines.push('');
  lines.push(`- display 0 before: \`${t.crown?.before?.currentFocus || 'null'}\` / \`${t.crown?.before?.focusedApp || 'null'}\``);
  lines.push(`- display 0 after the action phase: \`${t.crown?.afterActions?.currentFocus || 'null'}\` / \`${t.crown?.afterActions?.focusedApp || 'null'}\``);
  lines.push(`- display 0 after teardown: \`${t.crown?.afterTeardown?.currentFocus || 'null'}\` / \`${t.crown?.afterTeardown?.focusedApp || 'null'}\``);
  lines.push(`- display 0 window identical in every sample: **${yes(t.crown?.displayZeroStable)}**`);
  lines.push(`- attributable to this run: **${yes(t.crown?.attributableStable)}** (${t.crown?.attributableViolations ?? '?'} unexplained, ${t.crown?.attribution?.concurrentOwnerChanges ?? 0} concurrent with owner activity)`);
  lines.push(`- control samples changed: ${yes(t.crown?.attribution?.controlChanged)} · run-level comparison changed: ${yes(t.crown?.attribution?.runLevelChanged)}`);
  lines.push(`- structural checks: ${t.crown?.structural?.displayZeroInputCalls ?? '?'} display-0 input calls, ${t.crown?.structural?.displayZeroLaunch ?? '?'} launches without --display, app resumed on display 0: ${yes(t.crown?.structural?.appResumedOnDisplayZero)}`);
  lines.push(`- system focus pointer: ${t.crown?.topFocusedBefore} → ${t.crown?.topFocusedDuring ?? '-'} → ${t.crown?.topFocusedAfter}`);
  lines.push(`- focus changes during actions: ${t.crown?.violations?.length ? t.crown.violations.map((v) => v.action).join(', ') : 'none'}`);
  lines.push('');
  lines.push('## Every action, and the tier that ran it');
  lines.push('');
  lines.push('| # | action | tier | ok | display | detail |');
  lines.push('|---|---|---|---|---|---|');
  for (const step of t.steps || []) {
    const detail = step.path ? `\`${step.path.split(/[\\/]/).pop()}\` ${step.width}x${step.height} ${step.bytes} B` : step.detail || step.label || '';
    lines.push(`| ${step.index} | ${step.action}${step.label ? ` (${step.label})` : ''} | ${step.tier} | ${step.ok ? 'yes' : 'NO'} | ${step.display ?? '-'} | ${detail} |`);
  }
  lines.push('');
  if (t.tierCounts) {
    lines.push(`Tier counts: ${Object.entries(t.tierCounts).map(([tier, count]) => `**${tier}** ${count}`).join(' · ')}`);
    lines.push('');
  }
  lines.push('## Battery');
  lines.push('');
  const b = t.battery || {};
  lines.push(`- ${b.elapsedS ?? '?'} s of run`);
  lines.push(`- measure: ${b.measureMah ?? 'unavailable'} mAh (${b.source || 'none'})`);
  lines.push(`- charge counter delta: ${b.chargeDeltaUAh ?? 'n/a'} µAh · charging: ${yes(b.charging)} · level delta: ${b.levelDelta ?? 'n/a'}%`);
  lines.push(`- batterystats drain delta: ${b.drainDeltaMah ?? 'n/a'} mAh`);
  for (const note of b.notes || []) lines.push(`- note: ${note}`);
  lines.push('');
  lines.push('## Disruption report');
  lines.push('');
  lines.push(`- owner at start: ${t.disruption?.owner?.verdict || '?'} (${(t.disruption?.owner?.signals || []).join(', ') || 'no signals'})`);
  lines.push(`- display-0 touches: ${(t.disruption?.displayZeroTouched || []).length}`);
  for (const touch of t.disruption?.displayZeroTouched || []) {
    lines.push(`  - ${touch.action} — ${touch.why}`);
  }
  lines.push(`- churn moments (allowed): ${(t.disruption?.churnMoments || []).map((m) => m.moment).join(', ') || 'none'}`);
  lines.push(`- forbidden touches: ${(t.disruption?.forbiddenTouches || []).length}`);
  lines.push('');
  lines.push('## Teardown');
  lines.push('');
  const td = t.teardown || {};
  lines.push(`- overlay setting after: \`${td.settingAfter ?? '?'}\``);
  lines.push(`- displays after: [${(td.displaysAfter || []).join(', ')}] (expected [${(td.expectedDisplays || [0]).join(', ')}])`);
  lines.push(`- residue: ${yes(td.residue)} · attempt(s): ${td.attempts ?? '?'}`);
  lines.push('');
  if (t.limits?.length) {
    lines.push('## Limits stated by this run');
    lines.push('');
    for (const limit of t.limits) lines.push(`- ${limit}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function writeRunEvidence({ dir, report }) {
  mkdirSync(dir, { recursive: true });
  const jsonPath = `${dir}/run.json`;
  const mdPath = `${dir}/SUMMARY.md`;
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderRunMarkdown(report));
  return { dir, jsonPath, mdPath };
}
