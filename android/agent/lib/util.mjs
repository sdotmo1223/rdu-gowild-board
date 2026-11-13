// Small shared helpers. Nothing here talks to a phone.
import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const nowIso = () => new Date().toISOString();

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const shortHash = (buf) => sha256(buf).slice(0, 12);

export function round(n, digits = 1) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function oneLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

export function stamp() {
  // A run directory name that sorts chronologically and never contains a colon,
  // which Windows refuses in a path.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Poll a function until it answers true or the deadline passes. Returns the last
// answer either way, so the caller can report what it actually saw instead of a
// generic timeout.
export async function waitFor(fn, predicate, { timeoutMs = 6000, pollMs = 400 } = {}) {
  const started = Date.now();
  let last = null;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    last = await fn();
    if (predicate(last)) return { ok: true, value: last, attempts, waitedMs: Date.now() - started };
    if (Date.now() - started >= timeoutMs) return { ok: false, value: last, attempts, waitedMs: Date.now() - started };
    await sleep(pollMs);
  }
}
