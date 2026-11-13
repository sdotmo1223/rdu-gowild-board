// Battery cost per run.
//
// Measured on the S23 (2026-11-13): the phone sits on AC at 100%, so the charge
// counter never falls and a naive micro-amp delta reads 0 and looks like "an
// off-screen display is free". It is not free, so this module reports two numbers
// and says which one is trustworthy:
//
//   * chargeCounterUAh delta — exact, but only meaningful while discharging;
//   * batterystats "Computed drain" delta — a device-wide cumulative estimate, so
//     the delta across a run is that run's share even while charging.
import { readBattery, readBatterystats } from './device.mjs';
import { nowIso, round } from './util.mjs';

export async function readBatterySnapshot(adb) {
  const [battery, stats] = await Promise.all([readBattery(adb), readBatterystats(adb)]);
  return {
    at: nowIso(),
    level: battery.battery.level,
    chargeCounterUAh: battery.battery.chargeCounterUAh,
    temperatureC: battery.battery.temperatureC,
    powered: battery.battery.powered,
    computedDrainMah: stats.stats.computedDrainMah,
    capacityMah: stats.stats.capacityMah,
  };
}

export function batteryDelta(before, after, elapsedMs) {
  const charging = Boolean(after?.powered?.ac || after?.powered?.usb || after?.powered?.wireless);
  const chargeDeltaUAh =
    before?.chargeCounterUAh != null && after?.chargeCounterUAh != null
      ? after.chargeCounterUAh - before.chargeCounterUAh
      : null;
  const drainDeltaMah =
    before?.computedDrainMah != null && after?.computedDrainMah != null
      ? round(after.computedDrainMah - before.computedDrainMah, 2)
      : null;
  const levelDelta = before?.level != null && after?.level != null ? after.level - before.level : null;
  const counterReliable = !charging && chargeDeltaUAh !== null && chargeDeltaUAh <= 0;

  let measure = null;
  let source = 'none';
  if (counterReliable) {
    measure = round(chargeDeltaUAh / 1000, 2);
    source = 'charge-counter';
  } else if (drainDeltaMah !== null) {
    measure = drainDeltaMah;
    source = 'batterystats-estimate';
  }

  const notes = [];
  const elapsedS = round(elapsedMs / 1000, 1);
  // The batterystats estimate is an integer number of mAh, so a short run rounds to
  // zero. That is a resolution limit, not "free": say so rather than printing 0 and
  // letting it read as a measurement of no cost.
  // Measured on the S23: a 27 s run reported a delta of -1 mAh, because the estimate
  // is recomputed in whole mAh and can wobble either way. Anything at or below zero
  // over a short run is the floor of the instrument, not free rendering.
  const resolutionLimited = source === 'batterystats-estimate' && measure <= 0 && elapsedS < 180;
  if (charging) notes.push('device was charging, so the charge counter cannot fall; the batterystats estimate is reported instead');
  if (chargeDeltaUAh === null) notes.push('charge counter unavailable');
  if (drainDeltaMah === null) notes.push('batterystats drain estimate unavailable');
  if (resolutionLimited) {
    notes.push(`a delta of ${measure} mAh over ${elapsedS}s is at or below the counter's 1 mAh resolution: this run's cost is under the measurable floor, not zero`);
  }
  if (measure === null) notes.push('no battery cost could be measured for this run');

  return {
    elapsedMs,
    elapsedS: round(elapsedMs / 1000, 1),
    charging,
    chargeDeltaUAh,
    chargeDeltaMah: chargeDeltaUAh === null ? null : round(chargeDeltaUAh / 1000, 2),
    drainDeltaMah,
    levelDelta,
    measureMah: measure,
    source,
    resolutionLimited,
    reliable: counterReliable || drainDeltaMah !== null,
    notes,
  };
}
