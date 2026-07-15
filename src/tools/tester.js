// src/tools/tester.js — Universal test runner + coverage + gap detection
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { resolve, join, extname, relative, basename } from 'path';
import { execSync, spawn } from 'child_process';
import { printTool, printWarn } from '../ui.js';
import chalk from 'chalk';

// ── Helpers ───────────────────────────────────────────────────────────────────

function cmd(command, { cwd = '.', timeout = 120000 } = {}) {
  try {
    const out = execSync(command, { cwd, timeout, stdio: 'pipe' });
    return { stdout: out.toString(), success: true };
  } catch (e) {
    return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', success: false, code: e.status };
  }
}

function fileExists(...paths) {
  return paths.some(p => existsSync(p));
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function walkDir(dir, exts, maxDepth = 6, depth = 0) {
  if (depth > maxDepth || !existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'build', '.dart_tool', '.gradle', 'Pods', 'DerivedData'].includes(entry)) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) results.push(...walkDir(full, exts, maxDepth, depth + 1));
      else if (exts.includes(extname(entry).toLowerCase())) results.push(full);
    } catch {}
  }
  return results;
}

// ── Framework detection ───────────────────────────────────────────────────────

export function detectTestFramework(projectPath = '.') {
  const abs = resolve(projectPath);
  const pkg = readJson(join(abs, 'package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const scripts = pkg?.scripts || {};

  const frameworks = [];

  // Node / JS / TS
  if (deps?.jest || deps?.['@jest/core']) frameworks.push({ name: 'jest', lang: 'js', cmd: 'npx jest' });
  if (deps?.vitest) frameworks.push({ name: 'vitest', lang: 'js', cmd: 'npx vitest run' });
  if (deps?.mocha) frameworks.push({ name: 'mocha', lang: 'js', cmd: 'npx mocha' });
  if (deps?.jasmine) frameworks.push({ name: 'jasmine', lang: 'js', cmd: 'npx jasmine' });
  if (deps?.['@playwright/test']) frameworks.push({ name: 'playwright', lang: 'js', cmd: 'npx playwright test' });
  if (deps?.cypress) frameworks.push({ name: 'cypress', lang: 'js', cmd: 'npx cypress run' });

  // Python
  if (fileExists(join(abs, 'pytest.ini'), join(abs, 'setup.cfg'), join(abs, 'pyproject.toml'))) {
    frameworks.push({ name: 'pytest', lang: 'python', cmd: 'python -m pytest -v' });
  } else if (walkDir(abs, ['.py']).some(f => basename(f).startsWith('test_'))) {
    frameworks.push({ name: 'pytest', lang: 'python', cmd: 'python -m pytest -v' });
  }

  // Go
  if (fileExists(join(abs, 'go.mod'))) frameworks.push({ name: 'go test', lang: 'go', cmd: 'go test ./... -v' });

  // Swift / Xcode
  if (fileExists(join(abs, 'Package.swift'))) frameworks.push({ name: 'swift test', lang: 'swift', cmd: 'swift test' });

  // Kotlin / Android
  if (fileExists(join(abs, 'gradlew'))) frameworks.push({ name: 'gradle test', lang: 'kotlin', cmd: './gradlew test' });

  // Flutter
  if (fileExists(join(abs, 'pubspec.yaml'))) frameworks.push({ name: 'flutter test', lang: 'dart', cmd: 'flutter test' });

  // Ruby
  if (fileExists(join(abs, 'Gemfile'))) frameworks.push({ name: 'rspec', lang: 'ruby', cmd: 'bundle exec rspec' });

  // Fallback: npm test script
  if (frameworks.length === 0 && scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
    frameworks.push({ name: 'npm test', lang: 'js', cmd: 'npm test' });
  }

  return frameworks;
}

// ── Coverage analysis ─────────────────────────────────────────────────────────

function parseCoverageOutput(stdout) {
  // Jest/Vitest coverage table
  const match = stdout.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
  if (match) {
    return {
      statements: parseFloat(match[1]),
      branches: parseFloat(match[2]),
      functions: parseFloat(match[3]),
      lines: parseFloat(match[4]),
    };
  }
  // Go coverage: coverage: 82.5% of statements
  const goMatch = stdout.match(/coverage:\s*([\d.]+)%/);
  if (goMatch) return { statements: parseFloat(goMatch[1]) };
  // Python pytest-cov: TOTAL  ... 85%
  const pyMatch = stdout.match(/TOTAL\s+\d+\s+\d+\s+(\d+)%/);
  if (pyMatch) return { statements: parseFloat(pyMatch[1]) };
  return null;
}

// ── Test file gap finder ──────────────────────────────────────────────────────

const TEST_FILE_PATTERNS = {
  js:     { src: ['.js', '.ts', '.jsx', '.tsx'], testMarkers: ['test', 'spec'], testDirs: ['__tests__', 'test', 'tests', 'spec'] },
  python: { src: ['.py'], testMarkers: ['test_', '_test'], testDirs: ['tests', 'test'] },
  go:     { src: ['.go'], testMarkers: ['_test'], testDirs: [] },
  swift:  { src: ['.swift'], testMarkers: ['Test', 'Spec'], testDirs: ['Tests', 'XCTests'] },
  kotlin: { src: ['.kt'], testMarkers: ['Test', 'Spec'], testDirs: ['test'] },
  dart:   { src: ['.dart'], testMarkers: ['_test'], testDirs: ['test'] },
};

export function findTestGaps(projectPath = '.') {
  const abs = resolve(projectPath);
  const pkg = readJson(join(abs, 'package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };

  // Detect language
  let lang = 'js';
  if (existsSync(join(abs, 'pubspec.yaml'))) lang = 'dart';
  else if (existsSync(join(abs, 'Package.swift'))) lang = 'swift';
  else if (existsSync(join(abs, 'gradlew'))) lang = 'kotlin';
  else if (existsSync(join(abs, 'go.mod'))) lang = 'go';
  else if (walkDir(abs, ['.py']).length > walkDir(abs, ['.js', '.ts']).length) lang = 'python';

  const patterns = TEST_FILE_PATTERNS[lang] || TEST_FILE_PATTERNS.js;
  const allSrcFiles = walkDir(abs, patterns.src).filter(f => {
    const rel = relative(abs, f);
    return !patterns.testMarkers.some(m => basename(f, extname(f)).toLowerCase().includes(m.toLowerCase())) &&
           !patterns.testDirs.some(d => rel.includes(`/${d}/`) || rel.startsWith(`${d}/`));
  });

  const allTestFiles = walkDir(abs, patterns.src).filter(f => {
    const name = basename(f, extname(f)).toLowerCase();
    const rel = relative(abs, f);
    return patterns.testMarkers.some(m => name.includes(m.toLowerCase())) ||
           patterns.testDirs.some(d => rel.includes(`/${d}/`) || rel.startsWith(`${d}/`));
  });

  const testedBasenames = new Set(allTestFiles.map(f => {
    const name = basename(f, extname(f)).toLowerCase();
    return patterns.testMarkers.reduce((n, m) => n.replace(m.toLowerCase(), ''), name).replace(/[._-]/g, '');
  }));

  const untestedFiles = allSrcFiles.filter(f => {
    const name = basename(f, extname(f)).toLowerCase().replace(/[._-]/g, '');
    return !testedBasenames.has(name);
  });

  return {
    srcFiles: allSrcFiles.length,
    testFiles: allTestFiles.length,
    untestedFiles: untestedFiles.map(f => relative(abs, f)),
    coverageRatio: allSrcFiles.length > 0
      ? Math.round((allTestFiles.length / allSrcFiles.length) * 100)
      : 0,
    lang,
  };
}

// ── Parse test results ────────────────────────────────────────────────────────

function parseTestResults(stdout, stderr, framework) {
  const combined = (stdout + '\n' + stderr).toLowerCase();
  const result = { passed: 0, failed: 0, skipped: 0, total: 0, duration: null, failures: [] };

  // Jest / Vitest
  const jestSummary = stdout.match(/Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed(?:,\s*(\d+) total)?/i);
  if (jestSummary) {
    result.failed  = parseInt(jestSummary[1] || 0);
    result.skipped = parseInt(jestSummary[2] || 0);
    result.passed  = parseInt(jestSummary[3] || 0);
    result.total   = parseInt(jestSummary[4] || result.passed + result.failed + result.skipped);
  }

  // Go: ok  package 0.123s / FAIL
  const goPass = (stdout.match(/^ok\s+/gm) || []).length;
  const goFail = (stdout.match(/^FAIL\s+/gm) || []).length;
  if (goPass + goFail > 0) {
    result.passed = goPass; result.failed = goFail; result.total = goPass + goFail;
  }

  // Pytest: N passed, N failed, N error
  const pyMatch = stdout.match(/(\d+) passed(?:.*?(\d+) failed)?/i);
  if (pyMatch) {
    result.passed = parseInt(pyMatch[1] || 0);
    result.failed = parseInt(pyMatch[2] || 0);
    result.total  = result.passed + result.failed;
  }

  // Duration
  const durMatch = stdout.match(/Time:\s*([\d.]+)\s*s/) || stdout.match(/in\s+([\d.]+)s/) || stdout.match(/([\d.]+)\s*seconds/i);
  if (durMatch) result.duration = parseFloat(durMatch[1]);

  // Failure excerpts
  const failLines = stdout.split('\n').filter(l =>
    /● |FAIL|Error:|AssertionError|panic:|FAILED/i.test(l) && l.trim().length > 0
  ).slice(0, 10);
  result.failures = failLines;

  // Fallback pass/fail detection
  if (result.total === 0) {
    result.success = !combined.includes('fail') && !combined.includes('error');
  } else {
    result.success = result.failed === 0;
  }

  return result;
}

// ── Main test runner ──────────────────────────────────────────────────────────

export async function runTests(projectPath = '.', opts = {}) {
  const {
    coverage  = false,
    watch     = false,
    filter    = null,
    framework = null,
    verbose   = false,
    bail      = false,
  } = opts;

  const abs = resolve(projectPath);
  const detected = framework
    ? [{ name: framework, lang: 'js', cmd: framework }]
    : detectTestFramework(abs);

  if (detected.length === 0) {
    return { error: 'No test framework detected. See suggestions below.', suggestions: generateTestSuggestions(abs) };
  }

  const results = [];

  for (const fw of detected) {
    printTool(`Running ${fw.name} tests in ${relative(process.cwd(), abs) || '.'}`);

    let runCmd = fw.cmd;

    // Append flags
    if (coverage && fw.lang === 'js' && (fw.name === 'jest' || fw.name === 'vitest')) {
      runCmd += ' --coverage';
    }
    if (coverage && fw.lang === 'python') {
      runCmd = `python -m pytest -v --cov=. --cov-report=term-missing`;
    }
    if (coverage && fw.lang === 'go') {
      runCmd += ' -cover';
    }
    if (filter && fw.lang === 'js') {
      runCmd += ` --testNamePattern="${filter}"`;
    }
    if (filter && fw.lang === 'python') {
      runCmd += ` -k "${filter}"`;
    }
    if (bail && fw.lang === 'js') {
      runCmd += ' --bail';
    }
    if (verbose && fw.lang === 'js') {
      runCmd += ' --verbose';
    }
    if (watch) {
      runCmd += fw.lang === 'js' ? ' --watch' : '';
    }
    runCmd += ' 2>&1';

    const { stdout, stderr, success, code } = cmd(runCmd, { cwd: abs, timeout: 300000 });
    const parsed = parseTestResults(stdout, stderr, fw.name);
    const coverage_data = coverage ? parseCoverageOutput(stdout) : null;

    results.push({
      framework: fw.name,
      lang: fw.lang,
      success: success || parsed.success,
      ...parsed,
      coverage: coverage_data,
      rawOutput: stdout,
      exitCode: code,
    });
  }

  // Find gaps
  const gaps = findTestGaps(abs);

  return { projectPath: abs, frameworks: detected.map(f => f.name), results, gaps };
}

// ── Suggestions when no framework found ──────────────────────────────────────

function generateTestSuggestions(abs) {
  const pkg = readJson(join(abs, 'package.json'));
  const hasPy = walkDir(abs, ['.py']).length > 0;
  const hasGo = existsSync(join(abs, 'go.mod'));
  const hasSwift = existsSync(join(abs, 'Package.swift'));
  const hasFlutter = existsSync(join(abs, 'pubspec.yaml'));

  if (pkg) return [
    'npm install --save-dev jest',
    'Add to package.json: "scripts": { "test": "jest" }',
    'Create a file named *.test.js or *.spec.js next to your source files',
  ];
  if (hasPy) return ['pip install pytest pytest-cov', 'Create test_*.py files', 'Run: python -m pytest -v'];
  if (hasGo) return ['Go has built-in testing', 'Create *_test.go files', 'Run: go test ./...'];
  if (hasSwift) return ['Use XCTest (built in)', 'Add Tests/ folder with XCTestCase subclasses'];
  if (hasFlutter) return ['flutter_test is included in Flutter SDK', 'Create test/ directory with *_test.dart files'];
  return ['No recognized project type. Add a test framework for your language.'];
}

// ── Render report ─────────────────────────────────────────────────────────────

export function renderTestReport(result) {
  if (result.error) {
    const lines = [
      chalk.red(`\n✗ ${result.error}\n`),
      chalk.bold('Suggestions:'),
      ...(result.suggestions || []).map(s => `  ${chalk.cyan('→')} ${s}`),
    ];
    return lines.join('\n');
  }

  const lines = [];

  lines.push(chalk.bold.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
  lines.push(chalk.bold.cyan('║                     Test Run Report                          ║'));
  lines.push(chalk.bold.cyan('╚══════════════════════════════════════════════════════════════╝\n'));

  for (const r of result.results) {
    const status = r.success ? chalk.green('✓ PASSED') : chalk.red('✗ FAILED');
    lines.push(`  ${chalk.bold(r.framework.toUpperCase())}  ${status}`);

    if (r.total > 0) {
      const p = chalk.green(`${r.passed} passed`);
      const f = r.failed > 0 ? chalk.red(`  ${r.failed} failed`) : '';
      const s = r.skipped > 0 ? chalk.yellow(`  ${r.skipped} skipped`) : '';
      const t = chalk.gray(`  / ${r.total} total`);
      const d = r.duration ? chalk.gray(`  (${r.duration}s)`) : '';
      lines.push(`    ${p}${f}${s}${t}${d}`);
    }

    if (r.coverage) {
      const cv = r.coverage;
      const grade = (n) => n >= 80 ? chalk.green(`${n}%`) : n >= 60 ? chalk.yellow(`${n}%`) : chalk.red(`${n}%`);
      lines.push(`\n  Coverage:`);
      if (cv.statements !== undefined) lines.push(`    Statements : ${grade(cv.statements)}`);
      if (cv.branches   !== undefined) lines.push(`    Branches   : ${grade(cv.branches)}`);
      if (cv.functions  !== undefined) lines.push(`    Functions  : ${grade(cv.functions)}`);
      if (cv.lines      !== undefined) lines.push(`    Lines      : ${grade(cv.lines)}`);
    }

    if (!r.success && r.failures.length > 0) {
      lines.push(chalk.red('\n  Failures:'));
      r.failures.forEach(l => lines.push(chalk.red(`    ${l.trim()}`)));
    }

    lines.push('');
  }

  // Gap analysis
  const { gaps } = result;
  if (gaps) {
    const coverRatio = gaps.coverageRatio;
    const coverColor = coverRatio >= 80 ? chalk.green : coverRatio >= 50 ? chalk.yellow : chalk.red;
    lines.push(chalk.bold('  Test File Coverage:'));
    lines.push(`    Source files : ${gaps.srcFiles}`);
    lines.push(`    Test files   : ${gaps.testFiles}`);
    lines.push(`    Ratio        : ${coverColor(`${coverRatio}%`)}`);

    if (gaps.untestedFiles.length > 0) {
      lines.push(chalk.yellow(`\n  Files without tests (${Math.min(gaps.untestedFiles.length, 15)} shown):`));
      gaps.untestedFiles.slice(0, 15).forEach(f => lines.push(chalk.gray(`    • ${f}`)));
      if (gaps.untestedFiles.length > 15) {
        lines.push(chalk.gray(`    … and ${gaps.untestedFiles.length - 15} more`));
      }
    } else {
      lines.push(chalk.green('\n  ✓ All source files have corresponding test files'));
    }
  }

  return lines.join('\n');
}

// ── Markdown report ───────────────────────────────────────────────────────────

export function generateTestMarkdown(result) {
  const lines = [
    '# Test Report',
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Project:** \`${result.projectPath}\``,
    `**Frameworks:** ${(result.frameworks || []).join(', ')}`,
    '',
    '## Results',
    '',
  ];

  for (const r of result.results) {
    lines.push(`### ${r.framework} — ${r.success ? '✅ PASSED' : '❌ FAILED'}`);
    if (r.total > 0) {
      lines.push(`| Passed | Failed | Skipped | Total | Duration |`);
      lines.push(`|---|---|---|---|---|`);
      lines.push(`| ${r.passed} | ${r.failed} | ${r.skipped} | ${r.total} | ${r.duration ?? '-'}s |`);
    }
    if (r.coverage) {
      const cv = r.coverage;
      lines.push('', '**Coverage:**', '');
      lines.push(`| Metric | Value |`, `|---|---|`);
      if (cv.statements !== undefined) lines.push(`| Statements | ${cv.statements}% |`);
      if (cv.branches   !== undefined) lines.push(`| Branches   | ${cv.branches}% |`);
      if (cv.functions  !== undefined) lines.push(`| Functions  | ${cv.functions}% |`);
      if (cv.lines      !== undefined) lines.push(`| Lines      | ${cv.lines}% |`);
    }
    if (!r.success && r.failures.length > 0) {
      lines.push('', '**Failures:**', '```', ...r.failures, '```');
    }
    lines.push('');
  }

  if (result.gaps?.untestedFiles?.length > 0) {
    lines.push('## Untested Files', '');
    result.gaps.untestedFiles.forEach(f => lines.push(`- \`${f}\``));
  }

  return lines.join('\n');
}
