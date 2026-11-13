// Which apps an agent is allowed to drive.
//
// Not a security boundary — the phone has no mechanism to enforce it — but a stated
// default so that "an agent opened my banking app and tapped around" cannot happen
// through a typo. Anything not listed needs an explicit approval asserted by the
// caller, and anything sensitive needs one even if it is listed somewhere.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../config/apps.json', import.meta.url));

export const BUILT_IN_POLICY = {
  version: 1,
  safe: ['com.freebuff.gowild', 'com.android.deskclock'],
  sensitive: [
    'com.android.vending',
    'com.google.android.apps.walletnfcrel',
    'com.samsung.android.spay',
    'com.android.dialer',
    'com.samsung.android.dialer',
    'com.android.mms',
    'com.google.android.apps.messaging',
    'com.samsung.android.messaging',
    'com.chase.sig.android',
    'com.paypal.android.p2pmobile',
  ],
  note: 'safe = read-only-ish demo targets; sensitive = payments, telephony, money, messaging. Neither list is a security boundary.',
};

function matches(list, pkg) {
  return (list || []).some((entry) => {
    if (entry === pkg) return true;
    if (entry.endsWith('*')) return pkg.startsWith(entry.slice(0, -1));
    return false;
  });
}

export function loadPolicy(path = DEFAULT_POLICY_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      ...BUILT_IN_POLICY,
      ...parsed,
      safe: Array.isArray(parsed.safe) ? parsed.safe : BUILT_IN_POLICY.safe,
      sensitive: Array.isArray(parsed.sensitive) ? parsed.sensitive : BUILT_IN_POLICY.sensitive,
      source: path,
    };
  } catch (error) {
    return { ...BUILT_IN_POLICY, source: 'built-in', loadError: String(error.message) };
  }
}

export function decide(policy, { app, tier = 'virtual', approvals = [] } = {}) {
  const pkg = String(app || '').trim();
  if (!pkg) return { allow: false, needsApproval: true, reason: 'no-app', package: null };

  // Isolation tier is the escape hatch: the app gets its own device or its own user
  // data, so driving it there does not put the owner's phone or accounts at risk.
  if (tier === 'isolated') {
    return { allow: true, needsApproval: false, reason: 'isolation-tier', package: pkg };
  }
  if (matches(policy?.sensitive, pkg)) {
    return approvals.includes(pkg)
      ? { allow: true, needsApproval: true, approved: true, reason: 'sensitive-approved', package: pkg }
      : { allow: false, needsApproval: true, reason: 'sensitive-needs-approval', package: pkg };
  }
  if (matches(policy?.safe, pkg)) {
    return { allow: true, needsApproval: false, reason: 'allowlisted', package: pkg };
  }
  return approvals.includes(pkg)
    ? { allow: true, needsApproval: true, approved: true, reason: 'explicit-approval', package: pkg }
    : { allow: false, needsApproval: true, reason: 'not-allowlisted', package: pkg };
}

export function policySummary(policy) {
  return {
    source: policy?.source || 'unknown',
    safe: policy?.safe || [],
    sensitive: policy?.sensitive || [],
    note: policy?.note || '',
  };
}
