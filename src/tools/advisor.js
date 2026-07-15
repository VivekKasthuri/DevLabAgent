// advisor.js — project health aggregation + prioritized development recommendations
// Runs every relevant analyzer, merges findings, scores them, and produces an
// actionable roadmap: what to fix NOW, what to improve NEXT, what to build LATER.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { analyzeProject, scanSecurityProject, scanDependencies } from './code.js';
import { detectMobilePlatform, detectMobileIssues } from './mobile.js';
import { checkDICorrectness, detectArchitecture } from './di-analyzer.js';
import { detectBuildSystems, buildProject } from './builder.js';

async function safe(label, fn) {
  try {
    return { label, ok: true, data: await fn() };
  } catch (e) {
    return { label, ok: false, error: e.message };
  }
}

const SEVERITY_WEIGHT = { critical: 100, high: 40, medium: 10, low: 2 };

function rec(priority, category, title, detail, effort, tool) {
  return { priority, category, title, detail, effort, fixWith: tool };
}

/**
 * recommendDevelopment(projectPath, opts)
 *  Runs: project analysis, build verification, security scan, dependency audit,
 *  DI correctness, architecture detection, mobile issue scan (if mobile),
 *  test/CI/docs presence checks — then returns a prioritized roadmap.
 *
 *  opts.build   — actually run the build (default true; slowest step)
 *  opts.quick   — skip build + dependency audit for a fast pass
 */
export async function recommendDevelopment(projectPath = '.', opts = {}) {
  const { quick = false, build = !quick } = opts;

  const project = await analyzeProject(projectPath).catch(() => null);
  const platform = detectMobilePlatform(projectPath);
  const isMobile = platform && platform.platform && platform.platform !== 'unknown';

  const checks = await Promise.all([
    safe('security', () => scanSecurityProject(projectPath)),
    safe('di', () => checkDICorrectness(projectPath, 'auto')),
    safe('architecture', () => detectArchitecture(projectPath)),
    quick ? { label: 'dependencies', ok: true, data: null } : safe('dependencies', () => scanDependencies(projectPath)),
    isMobile ? safe('mobile', () => detectMobileIssues(projectPath)) : { label: 'mobile', ok: true, data: null },
  ]);
  const byLabel = Object.fromEntries(checks.map(c => [c.label, c]));

  let buildResult = null;
  if (build) {
    const systems = detectBuildSystems(projectPath);
    if (systems.length) buildResult = await buildProject(projectPath, { system: 'auto' }).catch(e => ({ ok: false, error: e.message }));
  }

  const recommendations = [];
  let score = 100;

  // 1. Build health — the foundation of "accurate fixes"
  if (buildResult && buildResult.ok === false) {
    score -= 30;
    recommendations.push(rec('NOW', 'build', 'Fix build errors first',
      `Project does not compile (${(buildResult.errors || []).length || 'unknown'} errors). Nothing else is trustworthy until the build is green.`,
      'varies', 'build_project → fix_file → build_project'));
  }

  // 2. Security
  const sec = byLabel.security?.data;
  const secFindings = sec?.findings || sec?.issues || [];
  const secCrit = secFindings.filter(f => /critical|high/i.test(f.severity || ''));
  if (secCrit.length) {
    score -= Math.min(25, secCrit.length * 5);
    recommendations.push(rec('NOW', 'security', `Fix ${secCrit.length} high/critical security finding(s)`,
      secCrit.slice(0, 3).map(f => `${f.file || ''}: ${f.message || f.rule || f.type}`).join('; '),
      'small', 'scan_security → apply_fix'));
  }

  // 3. Dependency vulnerabilities
  const deps = byLabel.dependencies?.data;
  const vulnCount = deps?.vulnerabilities?.total ?? deps?.total ?? 0;
  if (vulnCount > 0) {
    score -= Math.min(15, vulnCount * 2);
    recommendations.push(rec('NOW', 'dependencies', `Patch ${vulnCount} vulnerable dependenc${vulnCount === 1 ? 'y' : 'ies'}`,
      'Run the package manager audit fix, then rebuild and re-test.',
      'small', 'run_command("npm audit fix") → build_project'));
  }

  // 4. DI / architecture correctness
  const di = byLabel.di?.data;
  if (di?.verdict === 'FAIL') {
    score -= 15;
    recommendations.push(rec('NEXT', 'architecture', 'Fix dependency injection violations',
      `DI check verdict: FAIL (${di.criticals ?? '?'} critical, ${di.highs ?? '?'} high). Hard-wired dependencies make code untestable.`,
      'medium', 'check_di → apply_fix'));
  } else if (di?.verdict === 'WARN') {
    score -= 5;
    recommendations.push(rec('NEXT', 'architecture', 'Clean up DI warnings',
      'Some components bypass injection; address before they spread.', 'small', 'check_di'));
  }

  const arch = byLabel.architecture?.data;
  if (arch && /unknown|none/i.test(arch.pattern || '')) {
    recommendations.push(rec('LATER', 'architecture', 'Adopt an explicit architecture pattern',
      'No recognizable pattern (MVVM/Clean/etc). Pick one before the codebase grows.', 'large', 'detect_architecture'));
  }

  // 5. Mobile-specific
  const mobile = byLabel.mobile?.data;
  const mobileIssues = mobile?.issues || [];
  if (mobileIssues.length) {
    const top = mobileIssues.slice(0, 3).map(i => i.title || i.message || i.type).join('; ');
    score -= Math.min(10, mobileIssues.length);
    recommendations.push(rec('NEXT', 'mobile', `Resolve ${mobileIssues.length} mobile issue(s) [${platform.platform}]`,
      top, 'medium', 'detect_mobile_issues → run_mobile_lint'));
  }

  // 6. Testing hygiene
  const hasTests = ['test', 'tests', '__tests__', 'spec', 'Tests'].some(d => existsSync(join(projectPath, d)))
    || existsSync(join(projectPath, 'src', '__tests__'))
    || (project?.files || []).some?.(f => /\.(test|spec)\./.test(f));
  if (!hasTests) {
    score -= 10;
    recommendations.push(rec('NEXT', 'testing', 'Add a test suite',
      'No test directory found. Start with tests for the most-changed files.', 'medium', 'generate_tests'));
  }

  // 7. CI presence
  const hasCI = ['.github/workflows', 'bitrise.yml', 'Jenkinsfile', '.gitlab-ci.yml', 'azure-pipelines.yml']
    .some(p => existsSync(join(projectPath, p)));
  if (!hasCI) {
    score -= 5;
    recommendations.push(rec('LATER', 'ci', 'Add a CI pipeline',
      'No CI config found. Use run_ci locally now; add a hosted pipeline config for the team.', 'small', 'run_ci'));
  }

  // 8. Documentation
  if (!existsSync(join(projectPath, 'README.md'))) {
    score -= 3;
    recommendations.push(rec('LATER', 'docs', 'Add a README',
      'No README.md — document setup, build, and architecture.', 'small', 'write_file'));
  }

  // 9. Recommended development (growth, not just fixes)
  if (isMobile && !existsSync(join(projectPath, 'fastlane')) && platform.platform !== 'react-native') {
    recommendations.push(rec('LATER', 'release', 'Automate releases',
      'No release automation detected. Add fastlane (or equivalent) for signed builds and store uploads.', 'medium', 'run_command'));
  }
  if (project?.language === 'javascript' && !existsSync(join(projectPath, 'tsconfig.json'))) {
    recommendations.push(rec('LATER', 'quality', 'Consider TypeScript migration',
      'Plain JS project — gradual TS adoption catches whole classes of bugs at compile time.', 'large', 'build_project'));
  }

  score = Math.max(0, Math.round(score));
  const order = { NOW: 0, NEXT: 1, LATER: 2 };
  recommendations.sort((a, b) => order[a.priority] - order[b.priority]);

  return {
    projectPath,
    platform: isMobile ? platform.platform : (project?.language || 'unknown'),
    healthScore: score,
    grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
    buildStatus: buildResult ? (buildResult.ok ? 'PASS' : 'FAIL') : 'skipped',
    counts: {
      now: recommendations.filter(r => r.priority === 'NOW').length,
      next: recommendations.filter(r => r.priority === 'NEXT').length,
      later: recommendations.filter(r => r.priority === 'LATER').length,
    },
    recommendations,
    checkErrors: checks.filter(c => !c.ok).map(c => ({ check: c.label, error: c.error })),
  };
}
