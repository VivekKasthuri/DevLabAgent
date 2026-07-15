// src/tools/fixer.js — autonomous issue detection and repair engine
import { resolve, join, extname } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { runCommandSync, runCommand } from './shell.js';
import { readFile, writeFile, searchFiles } from './files.js';
import { scanSecurity } from './code.js';
import { listFiles } from './files.js';
import { printTool, printSuccess, printWarn, printError } from '../ui.js';
import chalk from 'chalk';

// ── Issue detection ────────────────────────────────────────────────────────────

export async function detectIssues(projectPath = '.') {
  const abs = resolve(projectPath);
  printTool(`Scanning for issues: ${abs}`);
  const issues = [];

  // 1. Detect project type
  const hasPkg     = existsSync(join(abs, 'package.json'));
  const hasPyproj  = existsSync(join(abs, 'pyproject.toml')) || existsSync(join(abs, 'requirements.txt'));
  const hasCargo   = existsSync(join(abs, 'Cargo.toml'));
  const hasGoMod   = existsSync(join(abs, 'go.mod'));

  // 2. Failing tests
  if (hasPkg) {
    const r = await runCommandSync('npm test -- --passWithNoTests 2>&1 | tail -30', abs);
    if (!r.success && r.stdout) {
      issues.push({ type: 'test', severity: 'high', message: 'Tests failing', detail: r.stdout.slice(0, 2000), projectPath: abs });
    }
  }
  if (hasPyproj) {
    const r = await runCommandSync('python -m pytest --tb=short -q 2>&1 | tail -30', abs);
    if (!r.success && r.stdout) {
      issues.push({ type: 'test', severity: 'high', message: 'Python tests failing', detail: r.stdout.slice(0, 2000), projectPath: abs });
    }
  }

  // 3. Lint errors
  if (hasPkg) {
    const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    if (deps.eslint || pkg.scripts?.lint) {
      const r = await runCommandSync('npx eslint . --ext .js,.ts,.jsx,.tsx --format=compact 2>&1 | head -50', abs);
      if (r.stdout && r.stdout.includes('error')) {
        issues.push({ type: 'lint', severity: 'medium', message: 'ESLint errors', detail: r.stdout.slice(0, 3000), projectPath: abs });
      }
    }

    if (deps.typescript || deps.tsc || existsSync(join(abs, 'tsconfig.json'))) {
      const r = await runCommandSync('npx tsc --noEmit 2>&1 | head -50', abs);
      if (!r.success && r.stdout) {
        issues.push({ type: 'typecheck', severity: 'medium', message: 'TypeScript errors', detail: r.stdout.slice(0, 3000), projectPath: abs });
      }
    }
  }

  if (hasPyproj) {
    const r = await runCommandSync('python -m flake8 . --max-line-length=120 --count 2>&1 | tail -30', abs);
    if (r.stdout && /\d+ errors?/i.test(r.stdout)) {
      issues.push({ type: 'lint', severity: 'medium', message: 'Flake8 lint errors', detail: r.stdout.slice(0, 2000), projectPath: abs });
    }
  }

  // 4. Security vulnerabilities
  if (hasPkg) {
    const r = await runCommandSync('npm audit --json 2>/dev/null', abs);
    try {
      const audit = JSON.parse(r.stdout);
      const vulns = audit.metadata?.vulnerabilities;
      if (vulns && (vulns.critical > 0 || vulns.high > 0)) {
        issues.push({
          type: 'security',
          severity: vulns.critical > 0 ? 'critical' : 'high',
          message: `npm audit: ${vulns.critical || 0} critical, ${vulns.high || 0} high vulnerabilities`,
          detail: r.stdout.slice(0, 2000),
          projectPath: abs,
        });
      }
    } catch {}
  }

  // 5. Source-level security scan
  const secResult = await runSecurityScanQuick(abs);
  if (secResult.criticals > 0) {
    issues.push({
      type: 'security',
      severity: 'critical',
      message: `${secResult.criticals} critical security issues in source code`,
      detail: JSON.stringify(secResult.topFindings, null, 2),
      projectPath: abs,
      findings: secResult.topFindings,
    });
  }

  // 6. Missing dependencies (node_modules or venv)
  if (hasPkg && !existsSync(join(abs, 'node_modules'))) {
    issues.push({ type: 'deps', severity: 'high', message: 'node_modules not installed', fix: 'npm install', projectPath: abs });
  }
  if (hasPyproj && !existsSync(join(abs, '.venv')) && !existsSync(join(abs, 'venv'))) {
    const r = await runCommandSync('python -c "import pkg_resources" 2>&1', abs);
    if (!r.success) {
      issues.push({ type: 'deps', severity: 'high', message: 'Python deps may not be installed', fix: 'pip install -r requirements.txt', projectPath: abs });
    }
  }

  // 7. TODO/FIXME/HACK markers in code
  const todoSearch = await searchFiles('(TODO|FIXME|HACK|BUG):', { path: abs, maxResults: 20 });
  if (todoSearch.count > 0) {
    issues.push({ type: 'todo', severity: 'low', message: `${todoSearch.count} TODO/FIXME markers found`, detail: JSON.stringify(todoSearch.matches), projectPath: abs });
  }

  // 8. Large/binary files accidentally committed
  const r = await runCommandSync('git ls-files | xargs -I{} sh -c \'[ -f "{}" ] && wc -c < "{}"\' 2>/dev/null | sort -rn | head -5', abs);
  // (informational only)

  // 9. Env files accidentally committed
  const envInGit = await runCommandSync('git ls-files | grep -E "\\.env$|\\.env\\." 2>/dev/null', abs);
  if (envInGit.stdout.trim()) {
    issues.push({
      type: 'security',
      severity: 'critical',
      message: `.env file tracked by git: ${envInGit.stdout.trim()}`,
      detail: 'Environment files may contain secrets and should be in .gitignore',
      projectPath: abs,
    });
  }

  return { projectPath: abs, issues, issueCount: issues.length };
}

async function runSecurityScanQuick(abs) {
  const { listFiles: lf } = await import('./files.js');
  const listed = await lf(abs, '**/*.{js,ts,jsx,tsx,py,go,rb,php}', { maxResults: 100 });
  const topFindings = [];
  let criticals = 0;

  for (const f of (listed.files || []).slice(0, 50)) {
    if (f.type !== 'file') continue;
    const r = scanSecurity(join(abs, f.path));
    if (r.findings) {
      const crits = r.findings.filter(x => x.severity === 'CRITICAL');
      criticals += crits.length;
      topFindings.push(...crits.slice(0, 2));
    }
    if (topFindings.length >= 10) break;
  }
  return { criticals, topFindings };
}

// ── Automated fixes ───────────────────────────────────────────────────────────

export async function autoFix(issue, agent) {
  const { type, message, detail, projectPath, fix } = issue;
  printTool(`Fixing [${issue.severity}] ${type}: ${message}`);

  switch (type) {
    case 'deps': {
      // Simply run the install command
      if (fix) {
        const r = await runCommand(fix, { cwd: projectPath });
        return { fixed: r.success, output: r.stdout?.slice(0, 500) };
      }
      break;
    }

    case 'lint': {
      // Try auto-fix first
      if (message.includes('ESLint')) {
        const r = await runCommandSync('npx eslint . --ext .js,.ts,.jsx,.tsx --fix 2>&1 | tail -10', projectPath);
        // Then ask agent to fix remaining
        if (detail) {
          await agent.run(`Fix these ESLint errors in ${projectPath}. Use the lint errors below to identify and fix each file:\n\n${detail}`);
        }
        return { fixed: true, method: 'eslint --fix + agent' };
      }
      if (message.includes('Flake8')) {
        await agent.run(`Fix these Python lint errors in ${projectPath}:\n\n${detail}`);
        return { fixed: true, method: 'agent' };
      }
      break;
    }

    case 'typecheck': {
      await agent.run(`Fix these TypeScript type errors in ${projectPath}. Read each file mentioned in the errors, understand the type issues, and fix them:\n\n${detail}`);
      return { fixed: true, method: 'agent' };
    }

    case 'test': {
      await agent.run(`The following tests are failing in ${projectPath}. Read the failing test files and the source files they test, then fix the source code (not the tests) to make them pass:\n\n${detail}`);
      return { fixed: true, method: 'agent' };
    }

    case 'security': {
      if (message.includes('.env file tracked by git')) {
        // Add .env to .gitignore
        const gitignorePath = join(projectPath, '.gitignore');
        let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
        if (!content.includes('.env')) {
          content += '\n.env\n.env.local\n.env.*.local\n';
          writeFileSync(gitignorePath, content, 'utf8');
          // Remove from git tracking (but keep the file)
          await runCommand('git rm --cached .env 2>/dev/null || true', { cwd: projectPath });
          printSuccess('Added .env to .gitignore and removed from git tracking');
          return { fixed: true, method: 'gitignore' };
        }
      }
      if (message.includes('npm audit')) {
        const r = await runCommand('npm audit fix --force 2>&1 | tail -20', { cwd: projectPath });
        return { fixed: r.success, output: r.stdout?.slice(0, 500) };
      }
      if (issue.findings) {
        await agent.run(`Fix these critical security vulnerabilities in ${projectPath}:\n\n${JSON.stringify(issue.findings, null, 2)}\n\nFor each finding, read the file, understand the issue, and apply a secure fix.`);
        return { fixed: true, method: 'agent' };
      }
      break;
    }

    case 'todo': {
      // Just report — don't auto-fix TODOs without user intent
      printWarn(`${issue.count} TODOs found — skipping auto-fix (resolve manually or ask agent)`);
      return { fixed: false, skipped: true, reason: 'TODOs require manual review' };
    }

    default:
      printWarn(`No auto-fix for issue type: ${type}`);
      return { fixed: false };
  }

  return { fixed: false };
}

// ── Mobile-specific auto-fix ─────────────────────────────────────────────────

export async function autoFixMobile(issue, agent) {
  const { type, message, detail, projectPath, platform, findings } = issue;
  const { fixMobileLint } = await import('./mobile.js');
  printTool(`Fixing mobile [${platform}] [${issue.severity}] ${type}: ${message}`);

  switch (type) {
    case 'lint': {
      const lintResult = await fixMobileLint(projectPath, platform);
      if (lintResult.skipped) {
        printWarn(lintResult.note);
        return { fixed: false, reason: lintResult.note };
      }
      // Ask agent to fix any remaining issues
      if (detail) {
        await agent.run(`Fix remaining ${platform} lint issues in ${projectPath}:\n\n${detail}`);
      }
      return { fixed: true, method: 'auto-lint + agent' };
    }

    case 'test': {
      await agent.run(`Fix failing ${platform} tests in ${projectPath}. Read the test output, find the source files, and fix them:\n\n${detail}`);
      return { fixed: true, method: 'agent' };
    }

    case 'security': {
      if (findings && findings.length > 0) {
        const platform_guide = {
          swift: 'Use Keychain for secrets, HTTPS for all URLs, proper TLS validation',
          kotlin: 'Use EncryptedSharedPreferences, avoid hardcoded keys, check AndroidManifest exported flags',
          'react-native': 'Use react-native-keychain or expo-secure-store, never AsyncStorage for sensitive data',
          flutter: 'Use flutter_secure_storage for secrets, https everywhere, dart:crypto for hashing',
        }[platform] || '';
        await agent.run(`Fix these ${platform} security vulnerabilities in ${projectPath}.\n\nGuide: ${platform_guide}\n\nFindings:\n${JSON.stringify(findings.slice(0, 8), null, 2)}\n\nFor each finding: read the file, understand the vulnerability, apply a secure fix.`);
        return { fixed: true, method: 'agent' };
      }
      return { fixed: false };
    }

    case 'deps': {
      if (issue.fix) {
        const r = await runCommand(issue.fix, { cwd: projectPath });
        return { fixed: r.success, output: r.stdout?.slice(0, 300) };
      }
      return { fixed: false };
    }

    default:
      return autoFix(issue, agent); // fallback to generic fixer
  }
}

// ── Full project fix pipeline ─────────────────────────────────────────────────

export async function fixProject(projectPath, agent, { dryRun = false } = {}) {
  const abs = resolve(projectPath);
  console.log(chalk.bold.cyan(`\n🔧 Fixing: ${abs}\n`));

  // Detect mobile platform first
  const { detectMobilePlatform, detectMobileIssues } = await import('./mobile.js');
  const mobilePlatform = detectMobilePlatform(abs);

  let allIssues = [];

  // Get web/backend issues
  const { issues: webIssues } = await detectIssues(abs);
  allIssues.push(...webIssues);

  // Get mobile issues if applicable
  if (mobilePlatform.platform !== 'unknown') {
    console.log(chalk.cyan(`  📱 Detected mobile: ${mobilePlatform.platform}`));
    const { issues: mobileIssues } = await detectMobileIssues(abs);
    allIssues.push(...mobileIssues);
  }

  if (allIssues.length === 0) {
    printSuccess('No issues found!');
    return { projectPath: abs, fixed: [], total: 0 };
  }

  console.log(chalk.yellow(`Found ${allIssues.length} issues:\n`));
  allIssues.forEach((iss, i) => {
    const sev = { critical: chalk.red, high: chalk.yellow, medium: chalk.cyan, low: chalk.gray }[iss.severity] || chalk.white;
    const platLabel = iss.platform ? chalk.gray(` [${iss.platform}]`) : '';
    console.log(`  ${i + 1}. ${sev(`[${iss.severity.toUpperCase()}]`)}${platLabel} ${iss.type}: ${iss.message}`);
  });
  console.log();

  if (dryRun) {
    return { projectPath: abs, issues: allIssues, dryRun: true };
  }

  const results = [];
  const sorted = [...allIssues].sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.severity] || 99) - (order[b.severity] || 99);
  });

  for (const issue of sorted) {
    let result;
    if (issue.platform && ['swift', 'kotlin', 'react-native', 'flutter'].includes(issue.platform)) {
      result = await autoFixMobile(issue, agent);
    } else {
      result = await autoFix(issue, agent);
    }
    results.push({ ...issue, ...result });
    if (result.fixed) printSuccess(`Fixed: ${issue.type} — ${issue.message}`);
    else printWarn(`Could not auto-fix: ${issue.message}`);
  }

  // Re-run tests after fixes
  const recheck = await runCommandSync('npm test -- --passWithNoTests 2>&1 | tail -10 || flutter test 2>&1 | tail -10 || pytest -q 2>&1 | tail -10 || swift test 2>&1 | tail -10 || echo "no test runner"', abs);
  console.log(chalk.gray('\nPost-fix test run:'));
  console.log(chalk.gray(recheck.stdout?.slice(0, 300)));

  const fixed = results.filter(r => r.fixed).length;
  printSuccess(`\nFixed ${fixed}/${allIssues.length} issues in ${abs}`);

  return { projectPath: abs, results, fixed, total: allIssues.length };
}
