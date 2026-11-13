// Policy numbers for the notification tiers, in one place, validated on the way in.
//
// The board's whole argument is that a number on screen is the number the system
// used. A settings object is where that could quietly stop being true, so an
// invalid value is replaced by the default rather than coerced: `24:00` is not a
// time, and pretending it means midnight would make the briefing fire at a moment
// nobody configured.
import { easternDate, easternStamp } from './routes.js';

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  briefing: true,
  briefingTime: '06:00',
  health: true,
  windowDays: 2,
});

// Collection is 24-48h plus a weekly lead probe. Seven is the ceiling the tasking
// allows, and the clamp lives here so no caller can ask for more.
export const WINDOW_MIN = 1;
export const WINDOW_MAX = 7;

function parseClock(value) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value == null ? '' : value).trim());
  return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : null;
}

function parseBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeSettings(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const windowRaw = typeof src.windowDays === 'number' ? src.windowDays : Number(src.windowDays);
  const windowDays = Number.isFinite(windowRaw)
    ? Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, Math.round(windowRaw)))
    : DEFAULT_SETTINGS.windowDays;
  return {
    briefing: parseBool(src.briefing, DEFAULT_SETTINGS.briefing),
    briefingTime: parseClock(src.briefingTime) || DEFAULT_SETTINGS.briefingTime,
    health: parseBool(src.health, DEFAULT_SETTINGS.health),
    windowDays,
  };
}

function kvFrom(env) {
  if (!env) return null;
  if (env.BOARD && typeof env.BOARD.get === 'function') return env.BOARD;
  if (typeof env.get === 'function' && typeof env.put === 'function') return env;
  return null;
}

export async function readSettings(env) {
  const kv = kvFrom(env);
  if (!kv) return { ...DEFAULT_SETTINGS };
  try {
    const stored = await kv.get(SETTINGS_KEY, 'json');
    return normalizeSettings(stored || {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// A partial update merges onto what is stored, never onto the defaults: a PATCH
// that mentions only the briefing time must not silently undeclare anything else.
export async function writeSettings(env, patch) {
  const kv = kvFrom(env);
  const current = await readSettings(env);
  const merged = normalizeSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
  if (kv) await kv.put(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

// Once per local day, at or after the configured wall clock. `sentOn` is the ET
// date string of the last briefing, so a worker that restarts does not re-send.
export function briefingDue(settings, sentOn, now = Date.now()) {
  const s = normalizeSettings(settings || {});
  if (!s.briefing) return false;
  const today = easternDate(0, now);
  // The record is the ET date, not a timestamp: "sent today" survives the Worker
  // being redeployed between the 06:00 push and the 06:15 cron tick.
  if (String(sentOn || '') === today) return false;
  const clock = easternStamp(now).slice(11, 16);
  return clock >= s.briefingTime;
}
