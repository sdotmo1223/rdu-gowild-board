// TASK A: /api/settings is the only place a policy number lives.
//
// Everything here is about refusing to guess. A bad time is replaced by the default
// rather than coerced into midnight; a window is clamped to what collection can
// actually afford; and a partial update never erases a field the caller did not
// mention, because a PATCH that silently resets the briefing time would be
// indistinguishable from the briefing never having been configured.
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  briefingDue,
  normalizeSettings,
  readSettings,
  writeSettings,
  SETTINGS_KEY,
} from '../src/settings.mjs';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

function kv() {
  const m = new Map();
  return {
    _m: m,
    async get(k, t) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return t === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, String(v));
    },
  };
}

// 2026-11-13, 05:30 / 06:00 / 07:15 ET.
// ET is UTC-5 in November, so an ET hour is the UTC hour plus five.
const at = (hh, mm) => Date.UTC(2026, 10, 13, hh + 5, mm, 0);
const T_0530 = at(5, 30);
const T_0600 = at(6, 0);
const T_0715 = at(7, 15);

// --- 1. defaults --------------------------------------------------------------
{
  eq(DEFAULT_SETTINGS.briefing, true, 'the briefing is on by default');
  eq(DEFAULT_SETTINGS.briefingTime, '06:00', 'six in the morning, America/New_York');
  eq(DEFAULT_SETTINGS.windowDays, 2, 'the collection window defaults to two days');
  eq(DEFAULT_SETTINGS.health, true, 'health notices are on by default');
}

// --- 2. normalisation refuses to guess ----------------------------------------
{
  const s = normalizeSettings({ briefing: false, briefingTime: '7:5', windowDays: 99 });
  eq(s.briefing, false, 'a boolean survives');
  eq(s.briefingTime, '06:00', 'a malformed time falls back to the default, not to midnight');
  eq(s.windowDays, 7, 'a window beyond the ceiling is clamped, not rejected');

  eq(normalizeSettings({ windowDays: 0 }).windowDays, 1, 'zero clamps up to one day');
  eq(normalizeSettings({ windowDays: '3' }).windowDays, 3, 'a numeric string is accepted');
  eq(normalizeSettings({ windowDays: 'abc' }).windowDays, 2, 'garbage falls back to the default');
  eq(normalizeSettings({ briefingTime: '23:59' }).briefingTime, '23:59', 'a valid late time is kept');
  eq(normalizeSettings({ briefingTime: '24:00' }).briefingTime, '06:00', '24:00 is not a time');
  eq(normalizeSettings({ briefing: 'yes' }).briefing, true, 'a non-boolean does not turn the tier off');
  eq(normalizeSettings(null).briefingTime, '06:00', 'null yields the defaults');
}

// --- 3. persistence -----------------------------------------------------------
{
  const store = kv();
  const fresh = await readSettings(store);
  eq(fresh.briefingTime, '06:00', 'an empty namespace reads as the defaults');

  const saved = await writeSettings(store, { briefingTime: '07:15' });
  eq(saved.briefingTime, '07:15', 'the write returns what was stored');
  const back = await readSettings(store);
  eq(back.briefingTime, '07:15', 'and it survives a re-read');
  eq(back.windowDays, 2, 'a partial update keeps the other defaults');
  ok(store._m.has(SETTINGS_KEY), 'the key is the one the Worker will read');

  await writeSettings(store, { briefing: false });
  const after = await readSettings(store);
  eq(after.briefing, false, 'a second partial update applies');
  eq(after.briefingTime, '07:15', 'and does not reset the time it did not mention');
}

// --- 4. briefing gating: once per local day, at or after the configured time ---
{
  const s = { briefing: true, briefingTime: '06:00' };
  eq(briefingDue(s, null, T_0530), false, 'before the configured time it does not fire');
  eq(briefingDue(s, null, T_0600), true, 'at the configured time it fires');
  eq(briefingDue(s, null, T_0715), true, 'and stays due later in the morning');
  eq(briefingDue(s, '2026-11-13', T_0715), false, 'once sent today it never fires again');
  eq(briefingDue(s, '2026-11-12', T_0715), true, 'yesterday does not suppress today');
  eq(briefingDue({ briefing: false, briefingTime: '06:00' }, null, T_0715), false, 'a disabled tier is never due');
  eq(briefingDue({ briefing: true, briefingTime: '23:50' }, null, T_0715), false, 'a late time waits for itself');
}

// --- 5. hostile input ---------------------------------------------------------
{
  for (const bad of [null, undefined, 42, 'x', []]) {
    const s = normalizeSettings(bad);
    ok(s && typeof s === 'object', 'normalize never throws');
    eq(s.windowDays, 2, 'and always returns a usable window');
  }
  const store = { get: async () => 'not json' };
  const s = await readSettings(store);
  eq(s.briefingTime, '06:00', 'an unreadable stored value degrades to defaults');
}

console.log(`settings: ${checks} checks passed`);
