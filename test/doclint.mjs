// RANK 8: a documentation lint that fails CI on a dead reference.
//
// The failure it exists for is concrete: README told the reader to run the
// `board-collect` workflow after that workflow had been deleted, and AGENTS carried
// two stale numbers. A lint that only checked filenames would have missed the first
// one, because the dead reference has no `.yml` on it -- so the bare-name case is
// asserted first, against a fixture that is deliberately wrong.
import assert from 'node:assert/strict';
import { lintDocs, ownerVerifyProblems, runFromDisk } from '../tools/doc-lint.mjs';

let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  assert.ok(cond, msg);
};
const eq = (a, b, msg) => {
  checks += 1;
  assert.equal(a, b, msg);
};

const streamWorkflows = ['sweep.yml', 'deploy.yml', 'sweep', 'deploy', 'gowild-sweep', 'gowild-deploy'];

// --- the deliberate dangling fixture -----------------------------------------
// This is the exact README sentence that was wrong, and a workflow list that does not
// contain it. The lint MUST fail here; if this assertion ever passes silently the
// gate is decorative.
{
  const docs = {
    'README.md': 'Run once by hand (Actions \u2192 `board-collect` \u2192 Run workflow) and open the page.',
  };
  const problems = lintDocs(docs, { exists: () => true, workflows: streamWorkflows });
  eq(problems.length, 1, 'a deleted workflow named in backticks is a failure');
  eq(problems[0].claim, 'board-collect', 'and the failure names it');
  ok(/workflow/i.test(problems[0].why), 'with a reason that says what kind of claim it was');
}

// --- a live workflow name passes ---------------------------------------------
eq(lintDocs({ 'README.md': 'Run `sweep.yml` from Actions.' }, { exists: () => true, workflows: streamWorkflows }).length, 0, 'a real workflow file passes');
eq(lintDocs({ 'README.md': 'Actions \u2192 `gowild-sweep` \u2192 Run workflow.' }, { exists: () => true, workflows: streamWorkflows }).length, 0, "a workflow's display name passes");

// --- dead paths ---------------------------------------------------------------
{
  const problems = lintDocs(
    { 'AGENTS.md': 'See `src/gone.mjs`, `test/watch.mjs`, `/api/board`, and `no-store`.' },
    { exists: (p) => p === 'test/watch.mjs', workflows: streamWorkflows },
  );
  eq(problems.length, 1, 'only the missing path is reported');
  eq(problems[0].claim, 'src/gone.mjs', 'and it is the right one');
}

// --- things that are not path claims ------------------------------------------
{
  const docs = {
    'README.md': [
      'A header like `Cache-Control: no-store` is not a file.',
      'The URL `https://example.com/src/x.mjs` is not a file.',
      'A placeholder `src/<file>.mjs` is not a claim.',
      'A key `w:<profile>:<DEST>` is not a path.',
      'Generated output `state.json` and local secrets `.dev.vars` are allowed to be absent.',
    ].join('\n'),
  };
  eq(lintDocs(docs, { exists: () => false, workflows: [] }).length, 0, 'prose, URLs, placeholders and generated files are not accusations');
}

// --- the real documents -------------------------------------------------------
// This is the assertion that would have caught the drift, and it runs in CI.
{
  const problems = runFromDisk(process.cwd());
  if (problems.length) {
    for (const p of problems) console.error(`  ${p.doc}: \`${p.claim}\` — ${p.why}`);
  }
  eq(problems.length, 0, 'README.md and AGENTS.md reference nothing that is missing');
}

// --- stress: fuzz documents with real and fake claims --------------------------
// The lint must be deterministic and must never throw on odd markup, because a gate
// that crashes is a gate people delete.
{
  const real = ['src/board.js', 'test/watch.mjs', 'tools/smoke.mjs', 'wrangler.toml', 'sweep.yml'];
  const fake = ['src/ghost.mjs', 'test/none.mjs', 'tools/nope.mjs', 'board-collect', 'old-workflow'];
  const exists = (p) => real.includes(p);
  for (let seed = 0; seed < 200; seed += 1) {
    const parts = [];
    const n = (seed % 5) + 1;
    for (let i = 0; i < n; i += 1) {
      const pickFrom = (seed + i) % 2 ? fake : real;
      parts.push(`See \`${pickFrom[(seed + i * 3) % pickFrom.length]}\` in the docs.`);
    }
    if (seed % 4 === 0) parts.push('Unclosed `backtick and a URL https://x.test/a.');
    const problems = lintDocs({ 'README.md': parts.join('\n') }, { exists, workflows: streamWorkflows });
    for (const p of problems) {
      ok(!real.includes(p.claim), `fuzz ${seed}: a real reference is never reported`);
    }
    ok(Array.isArray(problems), `fuzz ${seed}: returns a list`);
  }
}

// --- U-E: the owner-verify list is a contract --------------------------------
{
  const doc = (items) => `# HANDOFF\n\n**Owner-verifies, together.**\n\n${items.join('\n\n')}\n\nUntil it is done, nothing claims success.\n`;
  const open = (n) => `${n}. **Check ${n}.** Something only the owner can see. *(Open.)*`;
  const items = [open(1), open(2), open(3), open(4)];

  eq(ownerVerifyProblems(doc(items)).length, 0, 'four open items are a valid contract');
  eq(
    ownerVerifyProblems(doc([open(1), open(2), open(3)])).length,
    1,
    'a list that has quietly shrunk below four is a problem',
  );
  const silent = doc([open(1), open(2), '3. **Check 3.** No status at all.', open(4)]);
  ok(
    ownerVerifyProblems(silent).some((p) => /states no Open\/Closed status/.test(p.why)),
    'an item that states no status fails the gate',
  );
  const shortcut = doc([open(1), open(2), '3. **Check 3.** Agent saw it work. *(Closed \u2014 agent-side.)*', open(4)]);
  ok(
    ownerVerifyProblems(shortcut).some((p) => /closed without naming owner-side evidence/.test(p.why)),
    'closing on agent-side evidence fails, because only the owner can close one',
  );
  const proper = doc([open(1), open(2), '3. **Check 3.** The ring landed. *(Closed \u2014 owner: screenshot, 12:14 ET.)*', open(4)]);
  eq(ownerVerifyProblems(proper).length, 0, 'a closed item that names the owner is accepted');
  eq(ownerVerifyProblems('# nothing here').length, 0, 'a document without the list is not accused');
}

console.log(`doclint: ${checks} checks passed`);
console.log(`doclint: ${checks} checks passed`);
