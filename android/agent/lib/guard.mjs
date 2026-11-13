// The disruption guard.
//
// Rule: any operation that would touch display 0 first asks whether the owner is
// using the phone. Screen off or lockscreen counts as idle; anything else is
// "owner active" and the answer is a REFUSAL VALUE, never a throw and never an
// interruption. A refused guard is a successful guard.
import { parsePower, parseKeyguard } from './device.mjs';
import { nowIso, oneLine } from './util.mjs';

export async function readOwnerState(adb, { checkCall = true } = {}) {
  const power = await adb.shell('dumpsys power');
  const win = await adb.shell('dumpsys window');
  const parsedPower = parsePower(power.text);
  const keyguard = parseKeyguard(win.text);

  const wakefulness = parsedPower.wakefulness || 'unknown';
  const screenOff = wakefulness === 'Asleep' || wakefulness === 'Dozing';
  const locked = Boolean(keyguard.showing || keyguard.focusOnKeyguard);

  let inCall = null;
  if (checkCall && !screenOff && !locked && win.ok) {
    const telecom = await adb.shell('dumpsys telecom', { timeout: 15000 });
    if (telecom.ok) {
      if (/(?:mIsInCall|isInCall)\s*[:=]\s*true/i.test(telecom.text)) inCall = true;
      else if (/(?:mIsInCall|isInCall)/i.test(telecom.text)) inCall = false;
    }
  }

  const idle = screenOff || locked;
  const signals = [`wakefulness=${wakefulness}`];
  if (locked) signals.push(keyguard.focusOnKeyguard ? 'keyguard-focused' : 'keyguard-showing');
  if (inCall === true) signals.push('call-in-progress');

  return {
    at: nowIso(),
    wakefulness,
    screenOff,
    locked,
    inCall,
    verdict: idle ? 'idle' : 'active',
    signals,
    detail: oneLine(power.err || ''),
  };
}

export function guardDisplayZero(owner, { action = 'input', detail = null } = {}) {
  const base = { action, target: 'display-0', tier: 'observe', at: nowIso(), owner };
  if (owner && owner.verdict === 'idle') {
    return {
      ...base,
      ok: true,
      allowed: true,
      refused: false,
      reason: 'owner-idle',
      detail: owner.screenOff ? 'screen is off' : 'keyguard is showing',
    };
  }
  const reason = owner && owner.inCall ? 'owner-in-call' : 'owner-active';
  return {
    ...base,
    ok: false,
    allowed: false,
    refused: true,
    reason,
    detail: detail ||
      `owner is using the phone (${owner ? owner.wakefulness : 'unknown state'}); display 0 is left alone. Try again when the screen is off or locked.`,
  };
}

// Convenience for a caller that wants "run this only if the owner is idle".
// Still returns a value rather than throwing, so a refusal can be reported as a
// normal result alongside the successful actions.
export async function withIdleOwner(adb, run, { action = 'display-0 action', checkCall = true } = {}) {
  const owner = await readOwnerState(adb, { checkCall });
  const guard = guardDisplayZero(owner, { action });
  if (!guard.allowed) return { ok: false, refused: true, guard, owner, value: null };
  const value = await run(owner);
  return { ok: true, refused: false, guard, owner, value };
}
