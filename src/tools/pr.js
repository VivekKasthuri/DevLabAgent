// PR documentation + baseline tooling — generates PROMPT_STATEMENT.md (the task
// statement behind a PR) and captures a tooling baseline (lint/test/build results)
// so reviewers can distinguish pre-existing failures from ones a PR introduced.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function git(args, cwd) {
  try {
    return execSync(`git --no-pager ${args}`, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function run(cmd, cwd, timeout = 300000) {
  const started = Date.now();
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { command: cmd, ok: true, durationMs: Date.now() - started, output: out.trim().slice(-1500) };
  } catch (e) {
    return {
      command: cmd, ok: false, durationMs: Date.now() - started,
      output: ((e.stdout || '') + '\n' + (e.stderr || '')).trim().slice(-2500),
    };
  }
}

// ---------- baseline tooling detection ----------
export function detectTooling(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const checks = [];

  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* ignore */ }
    const scripts = pkg.scripts || {};
    if (scripts.lint) checks.push({ id: 'lint', command: 'npm run lint --silent' });
    if (scripts.typecheck) checks.push({ id: 'typecheck', command: 'npm run typecheck --silent' });
    else if (has('tsconfig.json')) checks.push({ id: 'typecheck', command: 'npx tsc --noEmit' });
    if (scripts.test) checks.push({ id: 'test', command: 'npm test --silent' });
    if (scripts.build) checks.push({ id: 'build', command: 'npm run build --silent' });
  }
  if (has('pubspec.yaml')) {
    checks.push({ id: 'lint', command: 'flutter analyze' }, { id: 'test', command: 'flutter test' });
  }
  if (has('Package.swift')) {
    checks.push({ id: 'build', command: 'swift build' }, { id: 'test', command: 'swift test' });
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    const gw = has('gradlew') ? './gradlew' : 'gradle';
    checks.push({ id: 'build', command: `${gw} assemble -q` }, { id: 'test', command: `${gw} test -q` });
  }
  if (has('requirements.txt') || has('pyproject.toml')) {
    if (has('pyproject.toml') && fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8').includes('ruff')) {
      checks.push({ id: 'lint', command: 'ruff check .' });
    }
    checks.push({ id: 'test', command: 'python -m pytest -q' });
  }
  if (has('go.mod')) {
    checks.push({ id: 'lint', command: 'go vet ./...' }, { id: 'build', command: 'go build ./...' }, { id: 'test', command: 'go test ./...' });
  }
  if (has('pom.xml')) {
    checks.push({ id: 'build', command: 'mvn -q compile' }, { id: 'test', command: 'mvn -q test' });
  }

  // dedupe by id, first wins
  const seen = new Set();
  return checks.filter(c => !seen.has(c.id) && seen.add(c.id));
}

// ---------- baseline capture ----------
export function captureBaseline({ path: dir = '.', checks: only, run: execute = true, label = 'baseline', timeout = 300000 } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };

  let tooling = detectTooling(root);
  if (only?.length) tooling = tooling.filter(c => only.includes(c.id));
  if (!tooling.length) return { error: 'No tooling detected (no lint/test/build scripts found)', detected: [] };

  const commit = git('rev-parse --short HEAD', root) || 'unknown';
  const branch = git('rev-parse --abbrev-ref HEAD', root) || 'unknown';

  const results = [];
  if (execute) {
    for (const c of tooling) results.push({ id: c.id, ...run(c.command, root, timeout) });
  }

  const baseline = {
    label,
    capturedAt: new Date().toISOString(),
    commit, branch,
    detected: tooling,
    results: execute ? results.map(r => ({ id: r.id, command: r.command, ok: r.ok, durationMs: r.durationMs, tail: r.ok ? undefined : r.output })) : undefined,
    summary: execute ? results.map(r => `${r.id}: ${r.ok ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`) : ['detection only — not executed'],
  };

  const outDir = path.join(root, '.devlab', 'pr');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${label}.json`);
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2));

  return { ...baseline, written: [file] };
}

// ---------- baseline comparison ----------
export function compareBaseline({ path: dir = '.', before = 'baseline', after = 'current' } = {}) {
  const root = path.resolve(dir);
  const load = (label) => {
    const fp = path.join(root, '.devlab', 'pr', `${label}.json`);
    return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null;
  };
  const b = load(before);
  if (!b) return { error: `No '${before}.json' found — run capture with label '${before}' on the base branch first` };
  let a = load(after);
  if (!a) a = captureBaseline({ path: root, label: after });
  if (a.error) return a;

  const bMap = Object.fromEntries((b.results || []).map(r => [r.id, r.ok]));
  const aMap = Object.fromEntries((a.results || []).map(r => [r.id, r.ok]));
  const verdicts = [];
  for (const id of new Set([...Object.keys(bMap), ...Object.keys(aMap)])) {
    const wasOk = bMap[id], isOk = aMap[id];
    let verdict;
    if (wasOk === undefined) verdict = 'new-check';
    else if (isOk === undefined) verdict = 'check-removed';
    else if (wasOk && !isOk) verdict = 'REGRESSION';
    else if (!wasOk && isOk) verdict = 'fixed';
    else if (!wasOk && !isOk) verdict = 'pre-existing-failure';
    else verdict = 'still-passing';
    verdicts.push({ check: id, before: wasOk, after: isOk, verdict });
  }
  const regressions = verdicts.filter(v => v.verdict === 'REGRESSION');
  return {
    baseCommit: b.commit, headCommit: a.commit,
    verdicts,
    regressions: regressions.length,
    mergeSafe: regressions.length === 0,
    note: regressions.length ? 'PR introduces failures that did not exist on base — fix before merge' : 'No regressions vs baseline; pre-existing failures (if any) are not this PR\'s fault',
  };
}

// ---------- PROMPT_STATEMENT.md ----------
export function generatePromptStatement({ path: dir = '.', base, title, problem, write = true } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };

  const branch = git('rev-parse --abbrev-ref HEAD', root) || 'unknown';
  const range = base ? `${base}...HEAD` : 'HEAD~1..HEAD';
  const commits = git(`log --format="- %s" ${range}`, root);
  const stat = git(`diff --stat ${range}`, root);
  const files = git(`diff --name-only ${range}`, root).split('\n').filter(Boolean);
  const inferredTitle = title || (commits.split('\n')[0] || '').replace(/^- /, '') || `Changes on ${branch}`;

  const grouped = {};
  for (const f of files) {
    const top = f.includes('/') ? f.split('/')[0] : '(root)';
    (grouped[top] ||= []).push(f);
  }

  const md = `# Prompt Statement

## Title
${inferredTitle}

## Problem Statement
${problem || '<!-- What problem does this change solve? Why is it needed? Fill this in. -->'}

## Task / Prompt
<!-- The original request or task that drove this change (e.g. the ticket text, user story, or prompt given to the agent). -->

## Scope
Branch: \`${branch}\`${base ? ` vs \`${base}\`` : ''}

### Commits
${commits || '- (no commits found in range)'}

### Areas touched
${Object.entries(grouped).map(([k, v]) => `- **${k}** (${v.length} file${v.length > 1 ? 's' : ''})`).join('\n') || '- (no diff found)'}

<details><summary>Full diff stat</summary>

\`\`\`
${stat || '(none)'}
\`\`\`
</details>

## Acceptance Criteria
- [ ] Problem statement above is addressed end-to-end
- [ ] Baseline tooling shows no regressions (see \`.devlab/pr/\` baseline comparison)
- [ ] Rubric score ≥ passing (run \`score_rubric\` target=pr)
- [ ] No secrets or debug code in diff

## Out of Scope
<!-- Explicitly list what this PR does NOT attempt to fix. -->

---
_Generated by DevLab ${new Date().toISOString()}_
`;

  const written = [];
  if (write) {
    const outDir = path.join(root, '.devlab', 'pr');
    fs.mkdirSync(outDir, { recursive: true });
    const fp = path.join(outDir, 'PROMPT_STATEMENT.md');
    fs.writeFileSync(fp, md);
    written.push(fp);
  }
  return { title: inferredTitle, branch, filesChanged: files.length, written, ...(write ? {} : { markdown: md }) };
}
