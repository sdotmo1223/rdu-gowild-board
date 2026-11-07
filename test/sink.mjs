// The loopback sink is the only path by which a browser-driven sweep reaches the
// board, so its contract is tested instead of trusted: a row that cannot be filed
// must be refused AND must not become a capture file, a real row must be stored,
// and /done must leave the receipt the driver waits for.
//
// Found 2026-11-07: the row cases had been checked by hand while /done had no
// check at all, so a "fix" that deleted the route would have looked correct. The
// /done checks below exist so that patch fails.
//
// The port is chosen here and handed to the sink through SINK_PORT. Grading a
// guessed port is how a live sweep's sink gets graded by mistake, so unless
// SINK_PORT is set this asks the OS for a free one, and refuses to run at all if
// the port it was given is already occupied.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, '.dry', `sink-${process.pid}`);
const SWEEP = join(SCRATCH, '.sweep');

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};

// Bind, read the port the OS actually gave (0 means "pick one"), then release it.
const claim = (port) => new Promise((res, rej) => {
  const probe = createServer();
  probe.once('error', rej);
  probe.listen(port, '127.0.0.1', () => {
    const chosen = probe.address().port;
    probe.close(() => res(chosen));
  });
});

const raw = process.env.SINK_PORT;
const wanted = raw === undefined || raw === '' ? 0 : Number(raw);
if (raw !== undefined && raw !== '' && (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535)) {
  assert.fail(`SINK_PORT=${raw} is not a port`);
}

let PORT;
try {
  PORT = await claim(wanted);
} catch (e) {
  assert.fail(`port ${wanted} is already in use (${e.code}); refusing to grade whatever is listening there`);
}

const BASE = `http://127.0.0.1:${PORT}`;

const captures = () => (existsSync(SWEEP)
  ? readdirSync(SWEEP).filter((f) => f.endsWith('.json')).sort()
  : []);
const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', body });

mkdirSync(SCRATCH, { recursive: true });
copyFileSync(join(ROOT, 'tools', 'sink.mjs'), join(SCRATCH, 'sink.mjs'));

const child = spawn(process.execPath, ['sink.mjs'], {
  cwd: SCRATCH,
  env: { ...process.env, SINK_PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
// Windows keeps a directory locked while a process still has it as its cwd, so the
// scratch copy is only removable once the sink has actually exited.
const exited = new Promise((r) => child.once('exit', r));
let exitCode = null;
exited.then((code) => { exitCode = code; });

const ready = async () => {
  for (let i = 0; i < 100; i += 1) {
    if (exitCode !== null) return false;
    try {
      await fetch(BASE);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return false;
};

try {
  ok(await ready(), `sink did not answer on 127.0.0.1:${PORT}${stderr ? `: ${stderr.trim()}` : ''}`);
  ok(captures().length === 0, `a fresh sink already held ${JSON.stringify(captures())}`);

  // 1-8. A row that cannot be filed is refused, and nothing is written first.
  for (const [label, body] of [
    ['an empty object', '{}'],
    ['an array', '[]'],
    ['a row with no dest', '{"iso":"2026-11-07"}'],
    ['junk', 'not json'],
  ]) {
    const r = await post('/row', body);
    ok(r.status === 400, `${label} should be refused with 400, got ${r.status}`);
    ok(captures().length === 0, `${label} wrote ${JSON.stringify(captures())}`);
  }

  // 9-11. A real row is stored under its own date and destination.
  const row = JSON.stringify({ iso: '2026-11-07', dest: 'ATL', status: 'ok', flights: [{ enabled: true, gw: 20 }], blocked: false });
  const good = await post('/row', row);
  ok(good.status === 200, `a valid row should be accepted, got ${good.status}`);
  ok(captures().join() === '2026-11-07-ATL.json', `captures were ${JSON.stringify(captures())}`);
  ok(JSON.parse(readFileSync(join(SWEEP, '2026-11-07-ATL.json'), 'utf8')).dest === 'ATL', 'the stored capture lost its contents');

  // 12-15. /done is the driver's completion receipt: 200, the marker on disk, and
  // no capture of its own. A sink without the route fails here.
  const done = await post('/done', 'sweep-complete');
  ok(done.status === 200, `/done should answer 200, got ${done.status}`);
  ok(existsSync(join(SWEEP, '_done')), '/done wrote no .sweep/_done marker');
  ok(readFileSync(join(SWEEP, '_done'), 'utf8') === 'sweep-complete', '/done lost the posted body');
  ok(captures().join() === '2026-11-07-ATL.json', '/done must not create a capture of its own');

  // 16-17. A mistyped path is not a success and not a capture.
  const stray = await post('/rown', '{}');
  ok(stray.status === 404, `an unknown route should answer 404, got ${stray.status}`);
  ok(captures().join() === '2026-11-07-ATL.json', `an unknown route wrote ${JSON.stringify(captures())}`);

  // 18-19. The preflight the page sends before every row.
  const pre = await fetch(`${BASE}/row`, { method: 'OPTIONS' });
  ok(pre.status === 204, `a preflight should answer 204, got ${pre.status}`);
  ok(captures().join() === '2026-11-07-ATL.json', `a preflight wrote ${JSON.stringify(captures())}`);
} finally {
  child.kill();
  await exited;
  rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(`sink: ${checks} checks passed (port ${PORT})`);
