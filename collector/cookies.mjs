// Frontier session cookie handling.
//
// The value is a secret: it is read from the environment or from the gitignored
// .dev.vars, injected into the browser context, and never printed, logged, or
// written anywhere. Only the pair COUNT is ever reported.
import { readFileSync } from 'node:fs';

export function cookiePairs(str) {
  if (!str) return [];
  return String(str)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      if (i < 1) return null;
      return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1) };
    })
    .filter((p) => p && p.name && p.value !== undefined);
}

export function readCookieString({ env = process.env, devVarsPath = '.dev.vars' } = {}) {
  if (env && env.FRONTIER_COOKIE && env.FRONTIER_COOKIE.trim()) return env.FRONTIER_COOKIE.trim();
  try {
    const raw = readFileSync(devVarsPath, 'utf8');
    const m = raw.match(/^[ \t]*FRONTIER_COOKIE[ \t]*=[ \t]*(.*)$/m);
    if (!m) return null;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v || null;
  } catch {
    return null;
  }
}

// Applied to .flyfrontier.com so both the booking subdomain and www receive them.
export async function applyCookies(context, str) {
  const pairs = cookiePairs(str);
  if (!pairs.length) return 0;
  await context.addCookies(
    pairs.map((p) => ({
      name: p.name,
      value: p.value,
      domain: '.flyfrontier.com',
      path: '/',
      httpOnly: true,
      secure: true,
    })),
  );
  return pairs.length;
}
