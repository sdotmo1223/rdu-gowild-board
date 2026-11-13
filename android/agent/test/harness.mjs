// A tiny suite runner, in the style of this repository's other test files: every
// check prints, the summary is one line, and the process exits non-zero on a failure.
//
// `loadLib` exists so the observed-red driver can point a suite at a deliberately
// mutated copy of lib/ and prove that the suite fails when the behaviour it claims to
// protect is removed.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const DEFAULT_LIB = fileURLToPath(new URL('../lib/', import.meta.url));

export async function loadLib(name) {
  const dir = process.env.AGENT_LIB_DIR || DEFAULT_LIB;
  return import(pathToFileURL(join(dir, name)).href);
}

const show = (value) => {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text && text.length > 220 ? `${text.slice(0, 217)}...` : text;
  } catch {
    return String(value);
  }
};

export function suite(title) {
  const rows = [];

  const t = {
    async ok(label, fn) {
      try {
        const value = await fn();
        if (value === false) throw new Error('assertion returned false');
        rows.push({ label, ok: true });
        return value;
      } catch (error) {
        rows.push({ label, ok: false, error: error && error.message ? error.message : String(error) });
        return undefined;
      }
    },
    eq(label, actual, expected) {
      return t.ok(label, () => {
        const same = show(actual) === show(expected);
        if (!same) throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
        return true;
      });
    },
    async throws(label, fn, includes = null) {
      try {
        await fn();
      } catch (error) {
        const message = `${error.name || 'Error'}: ${error.message || error}`;
        if (includes && !message.includes(includes)) {
          rows.push({ label, ok: false, error: `threw, but the message did not include ${show(includes)}: ${message}` });
          return undefined;
        }
        rows.push({ label, ok: true });
        return error;
      }
      rows.push({ label, ok: false, error: 'expected a throw, but the call returned normally' });
      return undefined;
    },
  };

  function finish() {
    const failed = rows.filter((row) => !row.ok);
    for (const row of rows) {
      console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.ok ? '' : `\n       ${row.error}`}`);
    }
    console.log(`\n${title}: ${rows.length - failed.length}/${rows.length} checks passed`);
    if (failed.length) {
      process.exitCode = 1;
      console.log(`${title}: ${failed.length} FAILED`);
    }
  }

  t.finish = finish;
  t.rows = rows;
  return t;
}
