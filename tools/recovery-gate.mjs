// The recovery-slot gate.
//
// GitHub drops scheduled deliveries. Measured 2026-11-07: 9 runs in 24 hours on a
// */15 cron, with gaps of 233, 362 and 434 minutes, so the page was hours old three
// times in one day. A second cron entry fills a dropped slot only if it costs
// nothing when the primary is delivering: a sweep on top of a healthy board would
// double the requests Frontier sees, and that burst budget is not negotiable.
//
// The fail-safe direction matters. An unreadable age sweeps, because a missed tick
// leaves the page hours stale -- the exact failure this exists to remove -- while one
// extra 14-request burst does not.
export const PRIMARY_CRON = '*/15 * * * *';
export const RECOVERY_SKIP_BELOW_MIN = 40;

// The board's own /api/board payload, defensively: the field may be absent on an
// older Worker build, and a missing number must never read as "fresh".
export function snapshotAgeMin(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = Number(payload.ageMinutes);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const at = Number(payload.updatedAt);
  if (!Number.isFinite(at) || at <= 0) return null;
  const age = (now - at) / 60000;
  return age >= 0 ? age : null;
}

export function recoveryDecision({ schedule, ageMin, skipBelowMin = RECOVERY_SKIP_BELOW_MIN }) {
  if (!schedule || schedule === PRIMARY_CRON) {
    return { skip: false, reason: 'primary slot: every delivery sweeps' };
  }
  if (!Number.isFinite(ageMin)) {
    return { skip: false, reason: 'recovery slot, age unknown: sweeping rather than missing a tick' };
  }
  const mins = Math.round(ageMin);
  if (ageMin < skipBelowMin) {
    return { skip: true, reason: `recovery slot, snapshot ${mins} min old (< ${skipBelowMin}): the primary cron is delivering` };
  }
  return { skip: false, reason: `recovery slot, snapshot ${mins} min old (>= ${skipBelowMin}): filling a dropped slot` };
}

const isCli = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/recovery-gate.mjs');

if (isCli) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'age') {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      const age = snapshotAgeMin(payload);
      console.log(Number.isFinite(age) ? Math.round(age) : 'unknown');
    });
  } else if (mode === 'decide') {
    const [schedule, rawAge] = rest;
    const age = rawAge === undefined || rawAge === 'unknown' || rawAge === '' ? null : Number(rawAge);
    const d = recoveryDecision({ schedule, ageMin: age });
    console.log(`skip=${d.skip}`);
    console.log(d.reason);
  } else {
    console.log('usage: recovery-gate.mjs age | decide <cron> <ageMin|unknown>');
    process.exit(1);
  }
}
