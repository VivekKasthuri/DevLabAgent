// Rubric + Requirements generator — produces rubric.json, requirements.json and
// markdown docs (RUBRIC.md, REQUIREMENTS.md, PR_REVIEW.md) for a framework/project or a PR.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { scanSecurityProject } from './code.js';

// ---------- stack detection ----------
function detectStack(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const stack = { languages: [], frameworks: [], mobile: false, hasTests: false, hasCI: false, hasDocs: false };

  if (has('package.json')) {
    stack.languages.push('javascript');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['react-native']) { stack.frameworks.push('react-native'); stack.mobile = true; }
      else if (deps.react) stack.frameworks.push('react');
      if (deps.express) stack.frameworks.push('express');
      if (deps.next) stack.frameworks.push('nextjs');
      if (deps.typescript) stack.languages.push('typescript');
      if (deps.jest || deps.vitest || deps.mocha) stack.hasTests = true;
    } catch { /* ignore */ }
  }
  if (has('pubspec.yaml')) { stack.languages.push('dart'); stack.frameworks.push('flutter'); stack.mobile = true; }
  if (has('Package.swift') || fs.readdirSync(dir).some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'))) {
    stack.languages.push('swift'); stack.mobile = true;
  }
  if (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts')) {
    stack.languages.push('kotlin'); stack.mobile = true;
  }
  if (has('requirements.txt') || has('pyproject.toml')) stack.languages.push('python');
  if (has('go.mod')) stack.languages.push('go');
  if (has('pom.xml')) stack.languages.push('java');

  const testDirs = ['test', 'tests', '__tests__', 'spec', 'Tests'];
  if (!stack.hasTests) stack.hasTests = testDirs.some(d => fs.existsSync(path.join(dir, d)));
  stack.hasCI = has('.github/workflows') || has('bitrise.yml') || has('Jenkinsfile') || has('.gitlab-ci.yml');
  stack.hasDocs = has('README.md') || has('docs');
  return stack;
}

// ---------- rubric levels ----------
const LEVELS = [
  { level: 'excellent', points: 4, description: 'Exceeds expectations; exemplary, no issues found' },
  { level: 'good', points: 3, description: 'Meets expectations; minor improvements possible' },
  { level: 'fair', points: 2, description: 'Partially meets expectations; notable gaps' },
  { level: 'poor', points: 1, description: 'Does not meet expectations; must be addressed' },
];

function criterion(id, name, weight, description, checks) {
  return { id, name, weight, description, checks, levels: LEVELS };
}

// ---------- project rubric ----------
function buildProjectRubric(stack, title) {
  const criteria = [
    criterion('code-quality', 'Code Quality', 20, 'Readability, naming, structure, idiomatic use of the language/framework', [
      'Consistent naming and formatting', 'No dead/duplicated code', 'Functions small and single-purpose', 'Linting passes clean',
    ]),
    criterion('architecture', 'Architecture & Design', 20, 'Separation of concerns, dependency direction, framework conventions followed', [
      'Clear module boundaries', 'Dependency injection where appropriate', 'No circular dependencies', 'Follows framework conventions',
    ]),
    criterion('testing', 'Testing', 20, 'Coverage, quality, and reliability of automated tests', [
      'Unit tests for core logic', 'Integration tests for critical flows', 'Tests run in CI', 'Edge cases covered',
    ]),
    criterion('security', 'Security', 15, 'No secrets in code, input validation, safe dependency usage', [
      'No hardcoded credentials', 'Inputs validated/sanitized', 'Dependencies free of known CVEs', 'Sensitive data handled correctly',
    ]),
    criterion('documentation', 'Documentation', 10, 'README, API docs, inline comments where needed', [
      'README with setup instructions', 'Public APIs documented', 'Architecture decisions recorded',
    ]),
    criterion('ci-cd', 'CI/CD & Tooling', 10, 'Automated builds, tests, and release processes', [
      'CI pipeline builds and tests every change', 'Reproducible builds', 'Automated release/versioning',
    ]),
    criterion('performance', 'Performance', 5, 'Efficient algorithms, no obvious bottlenecks, resource usage', [
      'No N+1 or unbounded loops on hot paths', 'Async/non-blocking where appropriate', 'Reasonable bundle/binary size',
    ]),
  ];
  if (stack.mobile) {
    criteria.push(criterion('mobile-ux', 'Mobile UX & Platform Compliance', 10,
      'Platform HIG/Material compliance, offline handling, accessibility', [
        'Handles offline/poor network', 'Accessibility labels present', 'Follows platform design guidelines', 'App size and startup time acceptable',
      ]));
  }
  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0);
  return {
    title: title || 'Project Evaluation Rubric',
    type: 'project',
    stack,
    generatedAt: new Date().toISOString(),
    scoring: { scale: '1-4 per criterion, weighted', maxScore: 4, passingScore: 2.8, formula: 'sum(points * weight) / sum(weights)' },
    totalWeight,
    criteria,
  };
}

// ---------- PR rubric ----------
function getPRChanges(dir, base) {
  try {
    const range = base ? `${base}...HEAD` : 'HEAD~1..HEAD';
    const stat = execSync(`git --no-pager diff --stat ${range}`, { cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const files = execSync(`git --no-pager diff --name-only ${range}`, { cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').filter(Boolean);
    return { stat: stat.trim(), files };
  } catch {
    return { stat: '', files: [] };
  }
}

function buildPRRubric(changes, title) {
  const criteria = [
    criterion('correctness', 'Correctness', 30, 'Change does what it claims; no regressions', [
      'Logic verified against requirements', 'Edge cases handled', 'No breaking changes to public APIs (or documented)',
    ]),
    criterion('tests', 'Test Coverage', 20, 'New/changed code is tested', [
      'Tests added or updated for the change', 'All tests pass', 'Negative cases covered',
    ]),
    criterion('code-quality', 'Code Quality', 20, 'Clean, readable, follows project conventions', [
      'Matches project style and rules', 'No leftover debug code', 'Small, focused diff',
    ]),
    criterion('security', 'Security', 15, 'No new vulnerabilities or leaked secrets', [
      'No secrets in diff', 'Inputs validated', 'No unsafe dependency additions',
    ]),
    criterion('docs', 'Documentation', 10, 'Docs/changelog updated where relevant', [
      'README/API docs updated if behavior changed', 'PR description explains what and why',
    ]),
    criterion('scope', 'Scope Discipline', 5, 'PR contains only what it says', [
      'No unrelated refactors mixed in', 'Reasonable size for review',
    ]),
  ];
  return {
    title: title || 'PR Review Rubric',
    type: 'pr',
    changes,
    generatedAt: new Date().toISOString(),
    scoring: { scale: '1-4 per criterion, weighted', maxScore: 4, passingScore: 3.0, formula: 'sum(points * weight) / sum(weights)' },
    totalWeight: criteria.reduce((s, c) => s + c.weight, 0),
    criteria,
  };
}

// ---------- requirements ----------
function req(id, category, title, description, priority, acceptance) {
  return { id, category, title, description, priority, acceptanceCriteria: acceptance, status: 'proposed' };
}

function buildRequirements(stack, target, changes, customReqs) {
  let n = 0;
  const nextId = (p) => `${p}-${String(++n).padStart(3, '0')}`;
  const reqs = [];

  if (customReqs?.length) {
    for (const c of customReqs) {
      reqs.push(typeof c === 'string'
        ? req(nextId('REQ'), 'functional', c, c, 'must', ['Implemented and verified'])
        : { id: nextId('REQ'), status: 'proposed', priority: 'must', category: 'functional', acceptanceCriteria: [], ...c });
    }
  }

  if (target === 'pr') {
    reqs.push(
      req(nextId('PR'), 'process', 'All CI checks pass', 'Build, tests, and lint pass on the PR branch', 'must', ['CI green on latest commit']),
      req(nextId('PR'), 'process', 'Peer review approval', 'At least one approving review from a maintainer', 'must', ['1+ approval, no unresolved comments']),
      req(nextId('PR'), 'quality', 'Tests cover the change', 'New or updated tests exercise the changed code paths', 'must', ['Coverage does not decrease', 'New logic has unit tests']),
      req(nextId('PR'), 'security', 'No secrets or vulnerabilities introduced', 'Diff is free of credentials and unsafe patterns', 'must', ['Secret scan clean', 'Dependency audit clean']),
      req(nextId('PR'), 'docs', 'Documentation updated', 'User-facing or API changes are documented', 'should', ['README/docs updated if behavior changed']),
    );
  } else {
    reqs.push(
      req(nextId('REQ'), 'functional', 'Core features implemented per specification', 'All specified features work end-to-end', 'must', ['Feature list verified manually or via E2E tests']),
      req(nextId('REQ'), 'non-functional', 'Automated test suite', 'Unit + integration tests with CI execution', 'must', ['Tests run on every commit', 'Critical paths covered']),
      req(nextId('REQ'), 'non-functional', 'Security baseline', 'No hardcoded secrets, validated inputs, patched dependencies', 'must', ['Security scan clean', 'No high/critical CVEs']),
      req(nextId('REQ'), 'non-functional', 'Documentation', 'README with setup, usage, and architecture overview', 'must', ['New contributor can set up from README alone']),
      req(nextId('REQ'), 'non-functional', 'CI/CD pipeline', 'Automated build, test, and release', 'should', ['Pipeline runs on push/PR']),
      req(nextId('REQ'), 'non-functional', 'Error handling & logging', 'Graceful failures with actionable logs', 'should', ['No unhandled crashes', 'Errors logged with context']),
    );
    if (stack?.mobile) {
      reqs.push(
        req(nextId('REQ'), 'non-functional', 'Offline & poor-network handling', 'App degrades gracefully without connectivity', 'should', ['No crash offline', 'User informed of connectivity state']),
        req(nextId('REQ'), 'non-functional', 'Accessibility', 'Screen-reader labels, contrast, dynamic type', 'should', ['Accessibility audit passes on key screens']),
      );
    }
  }
  return {
    title: target === 'pr' ? 'PR Merge Requirements' : 'Project Requirements',
    type: target,
    generatedAt: new Date().toISOString(),
    ...(changes?.files?.length ? { changedFiles: changes.files } : {}),
    requirements: reqs,
  };
}

// ---------- markdown renderers ----------
function rubricToMarkdown(rubric) {
  const lines = [`# ${rubric.title}`, '', `_Generated: ${rubric.generatedAt}_`, '',
    `**Scoring:** ${rubric.scoring.scale} — passing ≥ ${rubric.scoring.passingScore}/${rubric.scoring.maxScore}`, '',
    '| # | Criterion | Weight | Description |', '|---|-----------|--------|-------------|'];
  rubric.criteria.forEach((c, i) => lines.push(`| ${i + 1} | ${c.name} | ${c.weight}% | ${c.description} |`));
  lines.push('', '## Criteria Detail', '');
  for (const c of rubric.criteria) {
    lines.push(`### ${c.name} (${c.weight}%)`, '', c.description, '', '**Checks:**');
    c.checks.forEach(ch => lines.push(`- [ ] ${ch}`));
    lines.push('', '| Level | Points | Meaning |', '|-------|--------|---------|');
    c.levels.forEach(l => lines.push(`| ${l.level} | ${l.points} | ${l.description} |`));
    lines.push('');
  }
  return lines.join('\n');
}

function requirementsToMarkdown(reqDoc) {
  const lines = [`# ${reqDoc.title}`, '', `_Generated: ${reqDoc.generatedAt}_`, ''];
  const byCat = {};
  for (const r of reqDoc.requirements) (byCat[r.category] ||= []).push(r);
  for (const [cat, items] of Object.entries(byCat)) {
    lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)}`, '');
    for (const r of items) {
      lines.push(`### ${r.id}: ${r.title} \`${r.priority}\``, '', r.description, '', '**Acceptance criteria:**');
      r.acceptanceCriteria.forEach(a => lines.push(`- [ ] ${a}`));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function prReviewMarkdown(rubric, reqDoc) {
  const lines = ['# PR Review Checklist', '', '## Summary', '', '<!-- What does this PR do and why? -->', ''];
  if (rubric.changes?.stat) lines.push('## Changes', '', '```', rubric.changes.stat, '```', '');
  lines.push('## Merge Requirements', '');
  reqDoc.requirements.forEach(r => lines.push(`- [ ] **${r.id}** ${r.title} (${r.priority})`));
  lines.push('', '## Review Rubric', '', '| Criterion | Weight | Score (1-4) | Notes |', '|-----------|--------|-------------|-------|');
  rubric.criteria.forEach(c => lines.push(`| ${c.name} | ${c.weight}% | | |`));
  lines.push('', `**Passing score:** ≥ ${rubric.scoring.passingScore} weighted average`, '');
  return lines.join('\n');
}

// ---------- main entry ----------
export function generateRubric(options = {}) {
  const {
    path: dir = '.',
    target = 'project',          // 'project' | 'framework' | 'pr'
    title,
    base,                        // git base ref for PR diff (e.g. 'main')
    requirements: customReqs,    // optional custom requirement titles/objects
    outputDir,                   // where to write files (default <dir>/.devlab/rubrics)
    write = true,
  } = options;

  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };

  const isPR = target === 'pr';
  const stack = detectStack(root);
  const changes = isPR ? getPRChanges(root, base) : null;

  const rubric = isPR ? buildPRRubric(changes, title) : buildProjectRubric(stack, title);
  const reqDoc = buildRequirements(stack, isPR ? 'pr' : 'project', changes, customReqs);

  // Type-suffixed filenames so PR and project rubrics coexist in the same dir
  const suffix = isPR ? 'pr' : 'project';
  const files = {
    [`rubric.${suffix}.json`]: JSON.stringify(rubric, null, 2),
    [`requirements.${suffix}.json`]: JSON.stringify(reqDoc, null, 2),
    [`RUBRIC.${suffix}.md`]: rubricToMarkdown(rubric),
    [`REQUIREMENTS.${suffix}.md`]: requirementsToMarkdown(reqDoc),
  };
  if (isPR) files['PR_REVIEW.md'] = prReviewMarkdown(rubric, reqDoc);

  const written = [];
  if (write) {
    const outDir = path.resolve(outputDir || path.join(root, '.devlab', 'rubrics'));
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const fp = path.join(outDir, name);
      fs.writeFileSync(fp, content);
      written.push(fp);
    }
  }

  return {
    target: isPR ? 'pr' : 'project',
    stack: isPR ? undefined : stack,
    changedFiles: changes?.files?.length || undefined,
    criteria: rubric.criteria.map(c => `${c.name} (${c.weight}%)`),
    requirements: reqDoc.requirements.map(r => `${r.id}: ${r.title} [${r.priority}]`),
    written,
    ...(write ? {} : { files }),
  };
}

// ═══════════════════ SCORING ═══════════════════

const SRC_EXT = /\.(js|jsx|ts|tsx|py|go|rb|java|kt|kts|swift|dart|cs|php|m|mm)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', 'Pods', 'DerivedData', '.gradle', 'vendor', '__pycache__', '.devlab']);

function collectMetrics(root) {
  const m = { srcFiles: 0, testFiles: 0, totalLines: 0, longFiles: 0, todos: 0, debugLogs: 0, dirs: new Set() };
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) { m.dirs.add(e.name); walk(path.join(dir, e.name), depth + 1); }
      } else if (SRC_EXT.test(e.name)) {
        const fp = path.join(dir, e.name);
        const isTest = /\b(test|spec|Tests?)\b/i.test(fp.slice(root.length));
        if (isTest) m.testFiles++; else m.srcFiles++;
        if (m.srcFiles + m.testFiles > 400) return;
        try {
          const text = fs.readFileSync(fp, 'utf8');
          const lines = text.split('\n').length;
          m.totalLines += lines;
          if (lines > 500) m.longFiles++;
          m.todos += (text.match(/\b(TODO|FIXME|HACK)\b/g) || []).length;
          m.debugLogs += (text.match(/console\.log\(|print\(|println\(|NSLog\(/g) || []).length;
        } catch { /* binary or unreadable */ }
      }
    }
  };
  walk(root);
  return m;
}

function level(points) { return points >= 4 ? 'excellent' : points >= 3 ? 'good' : points >= 2 ? 'fair' : 'poor'; }

async function scoreProjectCriteria(root, rubric) {
  const stack = rubric.stack || detectStack(root);
  const m = collectMetrics(root);
  let sec = null;
  try { sec = await scanSecurityProject(root); } catch { /* optional */ }

  const has = (f) => fs.existsSync(path.join(root, f));
  const lintCfg = ['.eslintrc', '.eslintrc.json', '.eslintrc.js', 'eslint.config.js', '.swiftlint.yml', 'detekt.yml', 'analysis_options.yaml', '.flake8', 'ruff.toml']
    .some(has);
  const readmeLen = has('README.md') ? fs.statSync(path.join(root, 'README.md')).size : 0;
  const testRatio = m.srcFiles ? m.testFiles / m.srcFiles : 0;

  const scores = {};
  for (const c of rubric.criteria) {
    let points, evidence = [];
    switch (c.id) {
      case 'code-quality': {
        points = 3;
        if (lintCfg) { points++; evidence.push('lint config present'); } else evidence.push('no lint config found');
        if (m.longFiles > 3) { points--; evidence.push(`${m.longFiles} files >500 lines`); }
        if (m.todos > 20) { points--; evidence.push(`${m.todos} TODO/FIXME markers`); }
        else evidence.push(`${m.todos} TODO/FIXME markers`);
        if (m.debugLogs > 50) { points--; evidence.push(`${m.debugLogs} debug log calls`); }
        break;
      }
      case 'architecture': {
        points = m.dirs.size >= 3 ? 3 : 2;
        evidence.push(`${m.dirs.size} top-level modules, ${m.srcFiles} source files`);
        if (m.srcFiles > 30 && m.dirs.size < 3) { points = 2; evidence.push('large codebase with flat structure'); }
        if (m.longFiles === 0 && m.dirs.size >= 4) { points = 4; evidence.push('well-partitioned, no oversized files'); }
        break;
      }
      case 'testing': {
        if (m.testFiles === 0) { points = 1; evidence.push('no test files found'); }
        else if (testRatio < 0.15) { points = 2; evidence.push(`${m.testFiles} test files (${Math.round(testRatio * 100)}% of source)`); }
        else if (testRatio < 0.4) { points = 3; evidence.push(`${m.testFiles} test files (${Math.round(testRatio * 100)}% ratio)`); }
        else { points = 4; evidence.push(`strong test presence (${Math.round(testRatio * 100)}% ratio)`); }
        break;
      }
      case 'security': {
        if (!sec) { points = 2; evidence.push('security scan unavailable'); }
        else if (sec.criticals > 0) { points = 1; evidence.push(`${sec.criticals} CRITICAL findings`); }
        else if (sec.highs > 0) { points = 2; evidence.push(`${sec.highs} HIGH findings`); }
        else if (sec.totalFindings > 0) { points = 3; evidence.push(`${sec.totalFindings} low/medium findings`); }
        else { points = 4; evidence.push(`clean scan (${sec.filesScanned} files)`); }
        break;
      }
      case 'documentation': {
        if (!readmeLen) { points = 1; evidence.push('no README.md'); }
        else if (readmeLen < 500) { points = 2; evidence.push('README is minimal (<500 bytes)'); }
        else { points = 3; evidence.push(`README ${(readmeLen / 1024).toFixed(1)}KB`); }
        if (has('docs') && points < 4) { points++; evidence.push('docs/ directory present'); }
        break;
      }
      case 'ci-cd': {
        if (stack.hasCI) { points = 3; evidence.push('CI config found'); }
        else { points = 1; evidence.push('no CI configuration'); }
        if (stack.hasCI && has('.github/workflows')) { points = 4; evidence.push('GitHub Actions workflows'); }
        break;
      }
      case 'performance': {
        points = 3; evidence.push('no automated perf signal; manual review advised');
        break;
      }
      case 'mobile-ux': {
        points = 2; evidence.push('requires manual/device verification (offline, a11y, HIG)');
        break;
      }
      default: { points = 2; evidence.push('no automated check; manual review'); }
    }
    points = Math.max(1, Math.min(4, points));
    scores[c.id] = { name: c.name, weight: c.weight, points, level: level(points), evidence };
  }
  return scores;
}

function scorePRCriteria(root, rubric, base) {
  const changes = rubric.changes?.files?.length ? rubric.changes : getPRChanges(root, base);
  const files = changes.files || [];
  const testFiles = files.filter(f => /\b(test|spec|__tests__|Tests?)\b/i.test(f));
  const docFiles = files.filter(f => /\.(md|rst|txt)$/i.test(f) || /^docs\//.test(f));
  let diffText = '';
  try {
    const range = base ? `${base}...HEAD` : 'HEAD~1..HEAD';
    diffText = execSync(`git --no-pager diff ${range}`, { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { /* not a repo or no commits */ }
  const added = diffText.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const secretHits = added.filter(l => /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i.test(l)).length;
  const debugAdds = added.filter(l => /console\.log\(|print\(|debugger\b/.test(l)).length;

  const scores = {};
  for (const c of rubric.criteria) {
    let points = 2, evidence = [];
    switch (c.id) {
      case 'correctness':
        points = 3; evidence.push('automated correctness limited — run build/tests to confirm; review logic manually');
        break;
      case 'tests':
        if (!files.length) { points = 2; evidence.push('no diff available'); }
        else if (testFiles.length) { points = 4; evidence.push(`${testFiles.length} test files changed`); }
        else { points = 1; evidence.push('no test files in diff'); }
        break;
      case 'code-quality':
        points = 3;
        if (debugAdds) { points = 2; evidence.push(`${debugAdds} debug statements added`); } else evidence.push('no debug statements added');
        break;
      case 'security':
        if (secretHits) { points = 1; evidence.push(`${secretHits} potential secrets in added lines`); }
        else { points = 4; evidence.push('no secrets detected in diff'); }
        break;
      case 'docs':
        if (docFiles.length) { points = 4; evidence.push(`${docFiles.length} doc files updated`); }
        else { points = 2; evidence.push('no doc changes (fine if behavior unchanged)'); }
        break;
      case 'scope':
        if (files.length === 0) { points = 2; evidence.push('no diff'); }
        else if (files.length <= 15) { points = 4; evidence.push(`${files.length} files changed — reviewable size`); }
        else if (files.length <= 40) { points = 3; evidence.push(`${files.length} files changed`); }
        else { points = 2; evidence.push(`${files.length} files — consider splitting`); }
        break;
      default:
        evidence.push('manual review');
    }
    scores[c.id] = { name: c.name, weight: c.weight, points, level: level(points), evidence };
  }
  return scores;
}

function scorecardMarkdown(card) {
  const lines = [`# Scorecard: ${card.rubricTitle}`, '', `_Scored: ${card.scoredAt}_`, '',
    `## Result: **${card.weightedScore} / 4** — ${card.verdict.toUpperCase()} (passing ≥ ${card.passingScore})`, '',
    '| Criterion | Weight | Points | Level | Evidence |', '|-----------|--------|--------|-------|----------|'];
  for (const s of Object.values(card.scores)) {
    lines.push(`| ${s.name} | ${s.weight}% | ${s.points}/4 | ${s.level} | ${s.evidence.join('; ')} |`);
  }
  if (card.actionItems.length) {
    lines.push('', '## Action Items (lowest scores first)', '');
    card.actionItems.forEach(a => lines.push(`- [ ] ${a}`));
  }
  lines.push('', '> Scores marked "manual review" are heuristic defaults — verify by hand.', '');
  return lines.join('\n');
}

export async function scoreRubric(options = {}) {
  const { path: dir = '.', rubricFile, target, base, write = true, outputDir, prNumber } = options;
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };

  // Load an existing rubric: prefer type-suffixed file, fall back to legacy rubric.json
  let rubric;
  const rubricsDir = path.join(root, '.devlab', 'rubrics');
  const typedPath = path.join(rubricsDir, `rubric.${target === 'pr' ? 'pr' : 'project'}.json`);
  const legacyPath = path.join(rubricsDir, 'rubric.json');
  const rp = rubricFile ? path.resolve(root, rubricFile) : (fs.existsSync(typedPath) ? typedPath : legacyPath);
  if (fs.existsSync(rp)) {
    try { rubric = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch { return { error: `Invalid rubric JSON: ${rp}` }; }
  }
  const effectiveTarget = target || rubric?.type || 'project';
  if (!rubric || (target && rubric.type !== (target === 'pr' ? 'pr' : 'project'))) {
    rubric = effectiveTarget === 'pr'
      ? buildPRRubric(getPRChanges(root, base))
      : buildProjectRubric(detectStack(root));
  }

  const scores = rubric.type === 'pr'
    ? scorePRCriteria(root, rubric, base)
    : await scoreProjectCriteria(root, rubric);

  const totalWeight = Object.values(scores).reduce((s, c) => s + c.weight, 0);
  const weighted = Object.values(scores).reduce((s, c) => s + c.points * c.weight, 0) / (totalWeight || 1);
  const passingScore = rubric.scoring?.passingScore ?? 2.8;
  const weightedScore = Math.round(weighted * 100) / 100;

  const actionItems = Object.values(scores)
    .filter(s => s.points <= 2)
    .sort((a, b) => a.points - b.points || b.weight - a.weight)
    .map(s => `${s.name} (${s.points}/4): ${s.evidence.join('; ')}`);

  const card = {
    rubricTitle: rubric.title,
    type: rubric.type,
    prNumber: prNumber || undefined,
    scoredAt: new Date().toISOString(),
    weightedScore,
    passingScore,
    verdict: weightedScore >= passingScore ? 'pass' : 'fail',
    scores,
    actionItems,
  };

  const written = [];
  if (write) {
    const outDir = path.resolve(outputDir || path.join(root, '.devlab', 'rubrics'));
    fs.mkdirSync(outDir, { recursive: true });
    // Per-PR scorecards get their own files (scorecard.pr-42.json); otherwise typed
    const tag = rubric.type === 'pr' ? (prNumber ? `pr-${prNumber}` : 'pr') : 'project';
    const jsonFile = path.join(outDir, `scorecard.${tag}.json`);
    const mdFile = path.join(outDir, `SCORECARD.${tag}.md`);
    fs.writeFileSync(jsonFile, JSON.stringify(card, null, 2));
    fs.writeFileSync(mdFile, scorecardMarkdown(card));
    written.push(jsonFile, mdFile);
    // Append-only history: one line per scoring run, never overwritten
    const historyLine = JSON.stringify({
      scoredAt: card.scoredAt, type: card.type, prNumber: card.prNumber,
      weightedScore, passingScore, verdict: card.verdict,
    });
    fs.appendFileSync(path.join(outDir, 'history.jsonl'), historyLine + '\n');
    written.push(path.join(outDir, 'history.jsonl'));
  }

  return {
    verdict: card.verdict,
    weightedScore,
    passingScore,
    breakdown: Object.values(scores).map(s => `${s.name}: ${s.points}/4 (${s.level}) — ${s.evidence.join('; ')}`),
    actionItems,
    written,
  };
}
