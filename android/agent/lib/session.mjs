// One scripted run: probe-gated, policy-gated, display-scoped, deferred teardown.
//
// The run record is the product. It answers, for every action, which tier ran it, and
// it answers the crown invariant from both ends: display 0's own focus/window record
// before the action phase, after every action, and after teardown.
import { mkdirSync } from 'node:fs';
import { createActions } from './actions.mjs';
import { createDisplayManager } from './display.mjs';
import { readFocus, readProps, displayZeroFingerprint, sameDisplayZero } from './device.mjs';
import { readOwnerState } from './guard.mjs';
import { batteryDelta, readBatterySnapshot } from './battery.mjs';
import { decide } from './policy.mjs';
import { writeRunEvidence, writeActiveRecord, clearActiveRecord } from './report.mjs';
import { nowIso, stamp, oneLine, sleep } from './util.mjs';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_ROOT = fileURLToPath(new URL('../../../docs/android-agent/evidence', import.meta.url));

export const PLANS = {
  smoke: [
    { do: 'read', label: 'state-after-launch' },
    { do: 'capture', label: 'launched' },
    { do: 'swipe', x: 0.5, y: 0.82, x2: 0.5, y2: 0.28, ms: 400, label: 'scroll' },
    { do: 'capture', label: 'after-scroll' },
    { do: 'tap', x: 0.5, y: 0.5, label: 'center-tap' },
    { do: 'capture', label: 'after-tap' },
    { do: 'back', label: 'back' },
  ],
  // Used by acceptance test 4: the same run, forced to throw in the middle, so the
  // teardown path is proven against the real device instead of a fake.
  throw: [
    { do: 'capture', label: 'before-throw' },
    { do: 'throw', message: 'forced exception: acceptance test 4' },
    { do: 'capture', label: 'never-reached' },
  ],
};

const slug = (value) => String(value || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run';

const STEP_FIELDS = ['path', 'width', 'height', 'bytes', 'sha', 'reason', 'detail', 'x', 'y', 'from', 'to', 'component', 'output', 'label', 'characters', 'code', 'sfId', 'argv', 'topFocusedDisplayId', 'wakefulness', 'focus', 'resumed'];

export async function runSession({
  adb,
  app,
  policy,
  approvals = [],
  outDir = null,
  plan = 'smoke',
  isolation = null,
  runId = null,
  activePath = null,
} = {}) {
  const startedAt = nowIso();
  const startedAtMs = Date.now();
  const id = runId || `${stamp()}-${slug(app)}`;
  const dir = outDir || `${EVIDENCE_ROOT}/${id}`;
  mkdirSync(dir, { recursive: true });

  const tier = isolation ? 'isolated' : 'virtual';
  const device = await readProps(adb);
  const owner = await readOwnerState(adb);
  const decision = decide(policy, { app, tier, approvals });

  const report = {
    schema: 1,
    runId: id,
    startedAt,
    finishedAt: null,
    dir,
    device,
    serial: adb.serial,
    app,
    tier,
    isolation: isolation ? { kind: isolation.kind, serial: isolation.backend?.serial || null, user: isolation.backend?.user || null } : null,
    plan,
    policy: { decision, source: policy?.source || 'unknown' },
    ownerAtStart: owner,
    open: null,
    steps: [],
    tierCounts: {},
    crown: {},
    battery: null,
    teardown: null,
    disruption: { owner, displayZeroTouched: [], churnMoments: [], forbiddenTouches: [] },
    limits: [
      'the virtual display is invisibility, not isolation: same user, same app data, same accounts',
      'display-0 focus is sampled before and after each action, not continuously',
    ],
    ok: false,
    failed: false,
    refused: false,
    reason: null,
  };

  const steps = report.steps;
  const violations = [];
  let actions = null;
  let opened = null;
  let failure = null;
  let manager = null;
  let zeroAfterStep = null;
  const launchedApps = [];
  const controls = [];

  const batteryBefore = await readBatterySnapshot(adb);

  async function record(action, label, run) {
    const began = Date.now();
    const before = displayZeroFingerprint((await readFocus(adb)).focus);
    let result = null;
    let thrown = null;
    try {
      result = await run();
    } catch (error) {
      thrown = error;
      result = {
        ok: false,
        tier: error.name === 'CaptureFailure' ? 'virtual' : tier,
        action,
        reason: error.name || 'threw',
        detail: error.message,
        at: nowIso(),
      };
    }
    const after = displayZeroFingerprint((await readFocus(adb)).focus);
    const step = {
      index: steps.length + 1,
      action,
      label: label || result.label || null,
      tier: result.tier || tier,
      ok: result.ok === true && !thrown,
      display: result.display ?? null,
      threw: Boolean(thrown),
      at: result.at || nowIso(),
      ms: result.ms ?? Date.now() - began,
      focusBefore: before,
      focusAfter: after,
      displayZeroUnchanged: sameDisplayZero(before, after),
    };
    for (const field of STEP_FIELDS) {
      if (result[field] !== undefined) step[field] = result[field];
    }
    steps.push(step);
    if (!step.displayZeroUnchanged) {
      violations.push({ action, label: step.label, before, after, at: step.at });
    }
    if (thrown) throw thrown;
    return step;
  }

  function pixels(step) {
    const w = opened?.width || 720;
    const h = opened?.height || 1280;
    return [Math.round((step.x ?? 0.5) * w), Math.round((step.y ?? 0.5) * h), Math.round((step.x2 ?? 0.5) * w), Math.round((step.y2 ?? 0.5) * h)];
  }

  async function runStep(step) {
    switch (step.do) {
      case 'capture':
        return record('capture', step.label, () => actions.capture(step.label));
      case 'capture-zero':
        return record('capture', step.label || 'display-zero', () => actions.captureDisplayZero(step.label || 'display-zero'));
      case 'read':
        return record('read-state', step.label, () => actions.readState());
      case 'tap': {
        const [x, y] = pixels(step);
        return record('tap', step.label, () => actions.tap(x, y, { label: step.label }));
      }
      case 'swipe': {
        const [x1, y1, x2, y2] = pixels(step);
        return record('swipe', step.label, () => actions.swipe(x1, y1, x2, y2, step.ms || 300, { label: step.label }));
      }
      case 'text':
        return record('text', step.label, () => actions.text(step.value, { label: step.label }));
      case 'back':
        return record('back', step.label, () => actions.back({ label: step.label }));
      case 'key':
        return record('key', step.label, () => actions.key(step.code, { label: step.label }));
      case 'throw':
        throw new Error(step.message || 'forced failure');
      default:
        throw new Error(`unknown step: ${step.do}`);
    }
  }

  try {
    if (!decision.allow) {
      report.refused = true;
      report.reason = decision.reason;
      report.limits.push(`policy refused ${app}: ${decision.reason}. Approve it explicitly or use the isolation tier.`);
      report.finishedAt = nowIso();
      const written = writeRunEvidence({ dir, report });
      return { ...report, evidence: written };
    }

    const scripted = PLANS[plan];
    if (!scripted) {
      report.refused = true;
      report.reason = `unknown-plan:${plan}`;
      report.finishedAt = nowIso();
      const written = writeRunEvidence({ dir, report });
      return { ...report, evidence: written };
    }

    if (isolation && isolation.kind === 'emulator') {
      // No display is created on the phone at all, so there is nothing to tear down
      // there and the crown invariant is not applicable — not "passed".
      report.crown = { applies: false, note: 'a separate emulator device was driven; no display was created on the phone' };
      actions = isolation.backend.actions({ display: null, outDir: dir });
      opened = { id: null, width: null, height: null, sfId: null };
      await record('launch', `launch ${app}`, () => actions.launch(app));
      for (const step of scripted) await runStep(step);
    } else {
      manager = createDisplayManager({ adb });
      const openResult = await manager.open();
      report.open = openResult;
      if (!openResult.ok) {
        report.refused = Boolean(openResult.refused);
        report.reason = openResult.reason;
        report.detail = openResult.detail || null;
        report.limits.push(`no overlay display: ${openResult.reason}${openResult.detail ? ` — ${openResult.detail}` : ''}`);
        // Still prove the device was left clean.
        report.teardown = openResult.revert || (await manager.close({ reason: 'open-refused', force: true }));
        report.finishedAt = nowIso();
        const written = writeRunEvidence({ dir, report });
        return { ...report, evidence: written };
      }

      opened = openResult;
      writeActiveRecord(
        {
          runId: id,
          dir,
          startedAt,
          display: { id: opened.id, sfId: opened.sfId, name: opened.name, spec: opened.spec },
          apps: [],
          connection: adb.connection,
        },
        activePath || undefined,
      );

      report.disruption.churnMoments.push({
        moment: 'overlay-create',
        at: opened.openedAt,
        display: opened.id,
        topFocusedBefore: opened.focus.topFocusedBefore,
        topFocusedAfter: opened.focus.topFocusedAfter,
      });
      if (opened.focus.topFocusedBefore !== opened.focus.topFocusedAfter) {
        report.limits.push(
          `the system moved input focus to the overlay (mTopFocusedDisplayId ${opened.focus.topFocusedBefore} -> ${opened.focus.topFocusedAfter}). Touch on display 0 is not affected; a hardware keyboard would type into the overlay while it exists.`,
        );
      }

      actions = isolation
        ? isolation.backend.actions({ display: opened, outDir: dir })
        : createActions({ adb, tier: 'virtual', display: opened, outDir: dir });

      // Display-0 evidence either side of the action phase. Read-only, observe tier.
      await runStep({ do: 'capture-zero', label: 'display-zero-before' });
      report.disruption.displayZeroTouched.push({
        action: 'capture display 0 (before)',
        tier: 'observe',
        why: 'read-only screencap of the default display; changes nothing on screen',
      });

      const launchStep = await record('launch', `launch ${app}`, () => actions.launch(app));
      if (launchStep.ok) {
        launchedApps.push(app);
        writeActiveRecord(
          {
            runId: id,
            dir,
            startedAt,
            display: { id: opened.id, sfId: opened.sfId, name: opened.name, spec: opened.spec },
            apps: [app],
            connection: adb.connection,
          },
          activePath || undefined,
        );
      }

      // Control samples: two focus reads with NO action between them, at the same
      // cadence as the per-action pairs. This is what separates "our action moved
      // display 0" from "the owner opened another app while we worked" — and our
      // argv never targets display 0, so the first is not possible by construction.
      for (let index = 0; index < 2; index += 1) {
        const first = displayZeroFingerprint((await readFocus(adb)).focus);
        await sleep(350);
        const second = displayZeroFingerprint((await readFocus(adb)).focus);
        controls.push({ index, first, second, changed: !sameDisplayZero(first, second) });
      }
      report.controls = controls;

      for (const step of scripted) await runStep(step);

      zeroAfterStep = await runStep({ do: 'capture-zero', label: 'display-zero-after' });
      report.disruption.displayZeroTouched.push({
        action: 'capture display 0 (after)',
        tier: 'observe',
        why: 'read-only screencap of the default display; proves the app under test is not on it',
      });
    }
  } catch (error) {
    failure = {
      name: error.name || 'Error',
      message: error.message || String(error),
      detail: error.detail || null,
    };
    report.failed = true;
    report.reason = report.reason || `run-threw: ${failure.message}`;
  } finally {
    if (manager) {
      try {
        report.teardown = await manager.close({ reason: failure ? 'run-threw' : 'complete' });
      } catch (error) {
        report.teardown = { ok: false, residue: true, reason: 'teardown-threw', detail: oneLine(error && error.message) };
      }
      if (report.teardown?.ok) {
        if (launchedApps.length) {
          // The display is gone; the app process is not. Teardown is not app cleanup,
          // so the pointer stays until the stop switch has stopped what we started.
          writeActiveRecord(
            {
              runId: id,
              dir,
              startedAt,
              display: null,
              apps: launchedApps,
              connection: adb.connection,
              teardown: { ok: true, at: report.teardown.at },
            },
            activePath || undefined,
          );
        } else {
          clearActiveRecord(activePath || undefined);
        }
      }
      report.disruption.churnMoments.push({
        moment: 'overlay-teardown',
        at: report.teardown?.at || nowIso(),
        topFocusedAfter: report.teardown?.topFocusedAfter ?? null,
        residue: Boolean(report.teardown?.residue),
      });
      if (report.teardown?.residue) {
        report.limits.push(`teardown left residue: ${JSON.stringify(report.teardown.residues)}. Run the stop switch.`);
      }
    }
    if (isolation) {
      try {
        report.isolationStop = await isolation.backend.stop();
      } catch (error) {
        report.isolationStop = { ok: false, detail: oneLine(error && error.message) };
      }
    }
  }

  const batteryAfter = await readBatterySnapshot(adb);
  report.battery = batteryDelta(batteryBefore, batteryAfter, Math.max(0, Date.now() - startedAtMs));

  report.tierCounts = steps.reduce((acc, step) => {
    acc[step.tier] = (acc[step.tier] || 0) + 1;
    return acc;
  }, {});

  if (report.crown.applies !== false) {
    const fallback = displayZeroFingerprint((await readFocus(adb)).focus);
    const focusAfterTeardown = report.teardown?.focusAfter || fallback;
    const before = report.open?.focus?.before || fallback;
    const controlChanged = controls.some((control) => control.changed);
    const runLevelChanged = !sameDisplayZero(before, focusAfterTeardown);
    const ownerChurn = controlChanged || runLevelChanged;
    const inputSteps = steps.filter((step) => typeof step.argv === 'string' && /^input /.test(step.argv));
    const structural = {
      // Input and launch argv must never name display 0 on the virtual tier.
      displayZeroInputCalls:
        inputSteps.filter((step) => /^input -d 0 /.test(step.argv)).length +
        (tier === 'virtual' ? inputSteps.filter((step) => !/ -d \d+ /.test(step.argv)).length : 0),
      displayZeroLaunch: steps.filter((step) => step.action === 'launch' && !/--display \d+/.test(step.argv || '')).length,
      appResumedOnDisplayZero: steps.some((step) => (step.resumed?.displayZero || []).some((entry) => entry.package === app)),
    };
    const unexplained = ownerChurn ? 0 : violations.length;
    report.crown = {
      ...report.crown,
      applies: true,
      before,
      afterActions: zeroAfterStep?.focusAfter || (steps.length ? steps[steps.length - 1].focusAfter : before),
      afterTeardown: focusAfterTeardown,
      // Strict equality of every sample: informational, and false whenever the owner
      // touches their own phone during the run.
      displayZeroStable: violations.length === 0,
      perActionViolations: violations.length,
      violations,
      controls,
      structural,
      attribution: {
        rule: 'a display-0 change during an action is attributed to the owner when the control samples or the run-level comparison changed too; no action argv can target display 0 on the virtual tier',
        controlChanged,
        runLevelChanged,
        ownerChurnObserved: ownerChurn,
        concurrentOwnerChanges: ownerChurn ? violations.length : 0,
        unexplained,
      },
      attributableViolations: unexplained,
      attributableStable:
        unexplained === 0 &&
        structural.displayZeroInputCalls === 0 &&
        structural.displayZeroLaunch === 0 &&
        structural.appResumedOnDisplayZero === false,
      topFocusedBefore: report.open?.focus?.topFocusedBefore ?? null,
      topFocusedDuring: report.open?.focus?.topFocusedAfter ?? null,
      topFocusedAfter: report.teardown?.topFocusedAfter ?? null,
    };
  }
  report.disruption.forbiddenTouches = violations;

  report.finishedAt = nowIso();
  report.failure = failure;
  const teardownOk = manager ? Boolean(report.teardown?.ok) : true;
  const crownOk = report.crown.applies === false ? true : Boolean(report.crown.attributableStable);
  report.ok = !report.refused && !failure && teardownOk && crownOk;

  const written = writeRunEvidence({ dir, report });
  return { ...report, evidence: written };
}
