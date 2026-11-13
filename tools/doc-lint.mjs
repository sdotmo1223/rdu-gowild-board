// Documentation drifts faster than the code, and the drift is always a lie in the
// reader's direction.
//
// Measured 2026-11-11: README told the reader to run the `board-collect` workflow,
// which had been deleted; AGENTS said the health suite was 34 checks when it was 48;
// the env table described the budget offset as clock-derived after the code moved to a
// stored cursor. Every one of those was fixed by hand and regrew within a day.
//
// This checks the two claims that are machine-checkable without parsing prose:
//   1. every repository path written in backticks exists;
//   2. every workflow file named in backticks exists under .github/workflows.
// It deliberately does NOT check numbers or prose: a lint that fails on "48" becoming
// "49" would be turned off within a week.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Paths that are named in docs but are not tracked files (generated, ignored, or
// external), so the linter does not cry wolf and get disabled.
const ALLOWED_MISSING = new Set([
  '.dev.vars',
  '.board-token',
  'state.json',
  'node_modules',
  '.wrangler',
  '.dry',
  '.sweep',
  'nul',
]);

const DOC_FILES = ['README.md', 'AGENTS.md'];

// A backticked token is treated as a path claim only when it looks like one: a known
// repository directory prefix, a top-level file we ship, or a workflow filename.
const PATH_RE = /`([^`\n]+)`/g;
const PATH_PREFIXES = ['src/', 'collector/', 'test/', 'tools/', '.github/', 'docs/'];
const TOP_LEVEL = new Set([
  'package.json',
  'package-lock.json',
  'wrangler.toml',
  'eslint.config.mjs',
  'README.md',
  'AGENTS.md',
  'MONITOR.md',
  'HANDOFF.md',
  'TASKS.md',
  'PLAN.md',
  'BRIEF.md',
  'REPORT.md',
  'COLLECTION.md',
  'FAILURES.md',
]);
const WORKFLOW_RE = /^([a-z0-9][a-z0-9-]*)\.ya?ml$/;

function claimsIn(text) {
  const claims = [];
  const src = String(text || '');
  for (const m of src.matchAll(PATH_RE)) {
    const raw = m[1].trim();
    // Skip anything with a space, an angle bracket, a URL or a placeholder: those are
    // commands and examples, not path claims.
    if (!raw || /[\s<>{}()*|"]/.test(raw)) continue;
    if (/^https?:\/\//.test(raw)) continue;
    const token = raw.replace(/^\.\//, '').replace(/[.,;:]+$/, '');
    const isPrefixed = PATH_PREFIXES.some((p) => token.startsWith(p));
    const isTop = TOP_LEVEL.has(token);
    const isWorkflow = WORKFLOW_RE.test(token);
    // A workflow can also be named without its filename: the README told the reader
    // "Actions -> board-collect -> Run workflow" about a workflow that had been
    // deleted, and that string has no .yml on it. A bare kebab-case token is treated
    // as a workflow name only when the sentence is about Actions/workflows, so prose
    // like `no-store` is not accused of being a missing file.
    const context = src.slice(Math.max(0, m.index - 70), m.index + raw.length + 70);
    const bareWorkflow =
      /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(token) && /workflow|actions/i.test(context);
    if (!isPrefixed && !isTop && !isWorkflow && !bareWorkflow) continue;
    claims.push(token);
  }
  return claims;
}

// Pure enough to test: exists() and workflows are injected.
export function lintDocs(docs, { exists = existsSync, workflows = [] } = {}) {
  const problems = [];
  const flowSet = new Set(workflows);
  for (const [name, text] of Object.entries(docs || {})) {
    const seen = new Set();
    for (const token of claimsIn(text)) {
      if (seen.has(token)) continue;
      seen.add(token);
      const base = token.split('#')[0];
      if (ALLOWED_MISSING.has(base)) continue;
      if (WORKFLOW_RE.test(base) || /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(base)) {
        // Matches a filename, a filename stem, or a workflow's own `name:` field.
        if (!flowSet.has(base)) {
          problems.push({ doc: name, claim: base, why: 'no such workflow under .github/workflows' });
        }
        continue;
      }
      if (!exists(base)) {
        problems.push({ doc: name, claim: base, why: 'no such path in the repository' });
      }
    }
  }
  return problems;
}

export function runFromDisk(root = process.cwd()) {
  const docs = {};
  for (const name of DOC_FILES) {
    const p = join(root, name);
    if (existsSync(p)) docs[name] = readFileSync(p, 'utf8');
  }
  const wfDir = join(root, '.github', 'workflows');
  let workflows = [];
  try {
    const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
    workflows = files.slice();
    for (const f of files) {
      workflows.push(f.replace(/\.ya?ml$/, ''));
      try {
        // The display name is what Actions shows, and what a doc usually names.
        const name = /^name:\s*(.+)$/m.exec(readFileSync(join(wfDir, f), 'utf8'));
        if (name) workflows.push(name[1].trim().replace(/^["']|["']$/g, ''));
      } catch {
        // A workflow that cannot be read contributes only its filename.
      }
    }
  } catch {
    workflows = [];
  }
  return lintDocs(docs, {
    exists: (rel) => existsSync(join(root, rel)),
    workflows,
  });
}

// CLI: `node tools/doc-lint.mjs [root]`. A dangling reference fails the gate.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('doc-lint.mjs')) {
  const root = process.argv[2] || process.cwd();
  const problems = runFromDisk(root);
  if (problems.length) {
    console.error(`doc-lint: ${problems.length} dangling reference(s)`);
    for (const p of problems) console.error(`  ${p.doc}: \`${p.claim}\` — ${p.why}`);
    process.exit(1);
  }
  console.log('doc-lint: every path and workflow named in README/AGENTS exists');
}
