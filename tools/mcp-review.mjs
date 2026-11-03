#!/usr/bin/env node
// tools/mcp-review.mjs — zero-dependency MCP server (stdio transport).
//
// Why this exists: Freebuff's spawn_agents only registers Freebuff's own agents
// (here: researcher-web), so there is no spawnable independent reviewer. Freebuff
// speaks MCP, so this server exposes the two things that were otherwise done by
// hand: a second-opinion code review (dispatched to an OpenCode persona) and the
// repo's own verification gates.
//
// No dependencies, no network of its own, no secrets read or printed. Every result
// carries the raw exit code so a failure can never be rounded up to a pass.
//
// Smoke test by hand:
//   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node tools/mcp-review.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH_DIR = join(ROOT, '.agents', 'dispatch');
const BIN_FILE = join(ROOT, '.agents', 'opencode-bin');
const REVIEW_MODEL = process.env.MCP_REVIEW_MODEL || 'opencode-go/claude-haiku-5-5';
const REVIEW_AGENT = process.env.MCP_REVIEW_AGENT || 'surgeon-reviewer';
const MAX_BUNDLE_BYTES = 380_000;
const MAX_FILES = 14;
const REVIEW_TIMEOUT = 240_000;

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const comspec = process.env.ComSpec || 'cmd.exe';

function reply(msg) {
  process.stdout.write(JSON.stringify(msg) + String.fromCharCode(10));
}
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function run(cmd, args, { timeout = 180_000, cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    cmd,
    code: r.status == null ? -1 : r.status,
    signal: r.signal || null,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

// Windows cannot spawn npm.cmd without a shell, and shell:true with an args array
// triggers DEP0190. cmd.exe /d /s /c is explicit and does not concatenate it blindly.
function runNpm(args, opts = {}) {
  if (isWin) return run(comspec, ['/d', '/s', '/c', npmCmd, ...args], opts);
  return run(npmCmd, args, opts);
}

function isCmdLike(p) {
  return /\\.(cmd|bat)$/i.test(p);
}

// The OpenCode binary is not reliably on the PATH a bare CreateProcess sees (bash
// profile entries, npm shims, bun/opencode install dirs). Try, in order: the env
// var, a recorded absolute path, plain names, then a scan of every PATH directory.
function resolveOpencode() {
  const tried = [];
  const seen = new Set();
  const candidates = [];

  const push = (p) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };

  push(process.env.OPENCODE_CLI);
  if (existsSync(BIN_FILE)) push(readFileSync(BIN_FILE, 'utf8').trim());
  // The Windows desktop build ships the CLI inside its install folder and puts it
  // nowhere on PATH, so look there explicitly rather than depending on a recorded path.
  if (process.env.LOCALAPPDATA) {
    push(join(process.env.LOCALAPPDATA, 'Programs', 'ai.opencode.desktop', 'resources', 'opencode-cli.exe'));
  }
  for (const n of ['opencode-cli.exe', 'opencode-cli', 'opencode-cli.cmd', 'opencode.exe', 'opencode']) push(n);

  const names = /^opencode(-cli)?(\\.exe|\\.cmd|\\.bat)?$/i;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) if (names.test(e)) push(join(dir, e));
  }

  for (const c of candidates) {
    const viaShell = isWin && isCmdLike(c);
    const probe = viaShell
      ? run(comspec, ['/d', '/s', '/c', c, '--version'], { timeout: 8_000 })
      : run(c, ['--version'], { timeout: 8_000 });
    // A GUI build answers "--version" by opening a window and never returning, so the
    // answer must actually look like a version before this counts as a usable CLI.
    if (!probe.error && /\d+\.\d+/.test(probe.stdout + probe.stderr)) return { cmd: c, viaShell };
    tried.push(c + ' (' + (probe.error || 'answered --version with no version: not a CLI') + ')');
  }

  return {
    error:
      'no OpenCode binary could be started — tried ' +
      (tried.join('; ') || 'nothing') +
      '. Set OPENCODE_CLI to the absolute path, or write that path into .agents/opencode-bin.',
  };
}

function runOpencode(args, opts = {}) {
  const found = resolveOpencode();
  if (found.error) return { cmd: '(none)', code: -1, signal: null, stdout: '', stderr: '', error: found.error };
  return found.viaShell
    ? run(comspec, ['/d', '/s', '/c', found.cmd, ...args], opts)
    : run(found.cmd, args, opts);
}

function changedFiles() {
  const out = new Set();
  const status = run('git', ['status', '--porcelain']);
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.slice(3).trim().replace(/^"|"$/g, '');
    out.add(p.includes(' -> ') ? p.split(' -> ')[1] : p);
  }
  const last = run('git', ['diff', '--name-only', 'HEAD~1', 'HEAD']);
  for (const line of last.stdout.split(/\r?\n/)) if (line.trim()) out.add(line.trim());
  return [...out].filter((p) => /\.(m?js|json|md|toml|jsonc|yml|yaml)$/.test(p));
}

function buildBundle(files) {
  let bytes = 0;
  const parts = [];
  const used = [];
  for (const rel of files.slice(0, MAX_FILES)) {
    const abs = resolve(ROOT, rel);
    if (!abs.startsWith(ROOT) || !existsSync(abs) || statSync(abs).isDirectory()) continue;
    const body = readFileSync(abs, 'utf8');
    if (bytes + body.length > MAX_BUNDLE_BYTES) {
      parts.push('===== ' + rel + ' (omitted: bundle size cap) =====');
      continue;
    }
    bytes += body.length;
    used.push(rel);
    parts.push('===== ' + rel + ' =====');
    parts.push(body);
  }
  return { text: parts.join(String.fromCharCode(10) + String.fromCharCode(10)), files: used, bytes };
}

const PERSONA_RULES = [
  'You are the independent reviewer for this repository. You did not write this code and you owe it no loyalty.',
  'Report only defects you can point at in the text below, naming the file and function. For each: severity (HIGH blocks shipping), what breaks, and the smallest correct fix.',
  'If a concern is not provable from the supplied code, say "needs the file X" instead of guessing.',
  'Do not restate what the code does. Do not praise. Finish with one line: SHIP / SHIP WITH FIXES / DO NOT SHIP.',
].join(' ');

function independentReview({ question, files, model, agent }) {
  const chosen = Array.isArray(files) && files.length ? files : changedFiles();
  if (!chosen.length) return textResult('No files to review: pass `files`, or make a change first.', true);

  const bundle = buildBundle(chosen);
  if (!bundle.files.length) return textResult('None of the requested paths are readable files in this repo.', true);

  mkdirSync(DISPATCH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const promptPath = join(DISPATCH_DIR, 'mcp-review-' + stamp + '.txt');
  const NL = String.fromCharCode(10);
  const doc = [
    PERSONA_RULES,
    '',
    "REVIEWER'S TASK: " + (question || 'Review the supplied files for defects that would ship a wrong or silent result.'),
    '',
    'FILES UNDER REVIEW (' + bundle.files.join(', ') + '):',
    bundle.text,
    '',
  ].join(NL);
  writeFileSync(promptPath, doc, 'utf8');
  writeFileSync(
    join(DISPATCH_DIR, 'mcp-review-last.txt'),
    ['question: ' + (question || '(default)'), 'files: ' + bundle.files.join(', '), 'model: ' + (model || REVIEW_MODEL), 'agent: ' + (agent || REVIEW_AGENT), ''].join(NL),
  );

  const r = runOpencode(
    [
      'run',
      '--agent',
      agent || REVIEW_AGENT,
      '--model',
      model || REVIEW_MODEL,
      '--auto',
      '--file',
      promptPath,
      'The attached file is your complete task. Reply with your findings only.',
    ],
    { timeout: REVIEW_TIMEOUT },
  );

  if (r.error) return textResult('Reviewer could not run: ' + r.error, true);

  const out = r.stdout.trim();
  const err = r.stderr.trim();
  const header =
    'reviewed ' +
    bundle.files.length +
    ' file(s), ' +
    bundle.bytes +
    ' bytes via ' +
    (agent || REVIEW_AGENT) +
    ' / ' +
    (model || REVIEW_MODEL) +
    ' — exit ' +
    r.code +
    (r.signal ? ' signal ' + r.signal : '');

  if (!out) {
    return textResult(header + NL + 'No findings text returned.' + (err ? NL + 'stderr: ' + err.slice(0, 4000) : ''), true);
  }
  return textResult(header + NL + NL + out.slice(0, 40_000), r.code !== 0);
}

const NL = String.fromCharCode(10);

function failureLines(s) {
  return s
    .split(/\r?\n/)
    .filter((l) => /\b(FAIL|FAILED|Error|AssertionError|not ok)\b/.test(l))
    .slice(0, 15)
    .join(NL);
}

function runGates({ only } = {}) {
  const sections = [];
  const targets = changedFiles().filter((f) => /\.m?js$/.test(f) && existsSync(resolve(ROOT, f)));

  sections.push('## node --check (' + targets.length + ' changed js file(s))');
  const checkFails = [];
  for (const f of targets) {
    const r = run(process.execPath, ['--check', resolve(ROOT, f)], { timeout: 30_000 });
    if (r.code !== 0) checkFails.push(f + ': ' + (r.stderr || r.stdout).trim().split(/\r?\n/)[0]);
  }
  sections.push(checkFails.length ? checkFails.join(NL) : 'all parse');

  const suites = [];
  if (only !== 'stress') suites.push(['npm test', ['test']]);
  if (only !== 'test') suites.push(['npm run stress', ['run', 'stress']]);

  let failed = checkFails.length > 0;
  for (const [label, args] of suites) {
    const r = runNpm(args, { timeout: 200_000 });
    const passed = r.code === 0;
    if (!passed) failed = true;
    const hires = passed ? '' : NL + (failureLines(r.stdout) || failureLines(r.stderr));
    const tail = r.stdout.split(/\r?\n/).filter(Boolean).slice(-4).join(NL);
    sections.push('## ' + label + ' -> exit ' + r.code + (passed ? ' (pass)' : ' (FAIL)') + hires + NL + tail);
  }

  sections.push(NL + 'VERDICT: ' + (failed ? 'FAILED — at least one gate exited non-zero' : 'all gates exited 0'));
  return textResult(sections.join(NL + NL), failed);
}

const TOOLS = [
  {
    name: 'independent_review',
    description:
      'Second-opinion code review by an agent that did not write the code (OpenCode persona). Use after a non-trivial change, before claiming a fix is correct. Returns only findings it can point at in the source, plus a SHIP / SHIP WITH FIXES / DO NOT SHIP verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to review for, e.g. "does a failed sweep ever overwrite a good snapshot?"' },
        files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths. Default: changed files plus the last commit.' },
        agent: { type: 'string', description: 'OpenCode persona (default ' + REVIEW_AGENT + ').' },
        model: { type: 'string', description: 'Provider model (default ' + REVIEW_MODEL + ').' },
      },
      required: ['question'],
    },
  },
  {
    name: 'run_gates',
    description:
      "Run this repo's real verification: node --check on changed files, then npm test and npm run stress. Returns each exit code and the failing lines. Use before saying anything passed.",
    inputSchema: {
      type: 'object',
      properties: {
        only: { type: 'string', enum: ['test', 'stress'], description: 'Run just one suite.' },
      },
    },
  },
];

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const { id, method, params } = msg;
  if (method === undefined) return;
  if (id === undefined) return;

  try {
    if (method === 'initialize') {
      return reply({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'rdu-gowild-review', version: '1.0.1' },
          instructions:
            'Independent code review and real verification gates for this repo. Run run_gates before claiming a change passes; ask independent_review for a second opinion on anything non-trivial.',
        },
      });
    }
    if (method === 'ping') return reply({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (name === 'independent_review') return reply({ jsonrpc: '2.0', id, result: independentReview(args) });
      if (name === 'run_gates') return reply({ jsonrpc: '2.0', id, result: runGates(args) });
      return reply({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
    }
    return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    return reply({ jsonrpc: '2.0', id, error: { code: -32603, message: String((e && e.message) || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.trim()) handle(line);
});
rl.on('close', () => process.exit(0));
