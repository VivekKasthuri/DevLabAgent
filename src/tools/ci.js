// src/tools/ci.js — pre-PR CI gate orchestration
import { scanDependencies, scanSecurityProject, analyzeProject } from './code.js';
import { runTests, renderTestReport } from './tester.js';
import { analyzeDI, renderDIReport } from './di-analyzer.js';
import { printTool } from '../ui.js';
import chalk from 'chalk';

function summarizeNpmAudit(audit) {
  const meta = audit?.metadata?.vulnerabilities;
  if (!meta) return { total: 0, criticals: 0, highs: 0, mediums: 0, lows: 0 };
  return {
    total: Object.values(meta).reduce((sum, n) => sum + (Number(n) || 0), 0),
    criticals: Number(meta.critical || 0),
    highs: Number(meta.high || 0),
    mediums: Number(meta.moderate || 0),
    lows: Number(meta.low || 0),
  };
}

function summarizePipeAudit(audit) {
  const vulns = Array.isArray(audit?.vulnerabilities) ? audit.vulnerabilities : [];
  return {
    total: vulns.length,
    criticals: vulns.filter(v => /critical/i.test(v.severity || '')).length,
    highs: vulns.filter(v => /high/i.test(v.severity || '')).length,
    mediums: vulns.filter(v => /medium/i.test(v.severity || '')).length,
    lows: vulns.filter(v => /low/i.test(v.severity || '')).length,
  };
}

function gradeRank(grade) {
  return { A: 0, B: 1, C: 2, D: 3, F: 4 }[grade] ?? 9;
}

function renderSection(title, body) {
  return `\n${chalk.bold.cyan(title)}\n${body}\n`;
}

export async function runCI(projectPath = '.', opts = {}) {
  const abs = projectPath;
  const { coverage = true, maxFiles = 15 } = opts;

  printTool(`CI gate: ${abs}`);
  const project = await analyzeProject(abs);

  const report = {
    projectPath: abs,
    project,
    tests: null,
    security: null,
    dependencies: null,
    di: null,
    summary: { passed: true, reasons: [] },
  };

  report.tests = await runTests(abs, { coverage, bail: true, verbose: false });
  if ((report.tests.results || []).some(r => !r.success) || report.tests.error) {
    report.summary.passed = false;
    report.summary.reasons.push('Tests failed');
  }

  report.security = await scanSecurityProject(abs);
  if ((report.security.criticals || 0) > 0 || (report.security.highs || 0) > 0) {
    report.summary.passed = false;
    report.summary.reasons.push('Security findings at high/critical severity');
  }

  report.dependencies = await scanDependencies(abs);
  const npmSummary = summarizeNpmAudit(report.dependencies?.npm);
  const pipSummary = summarizePipeAudit(report.dependencies?.pip);
  const depHighs = (npmSummary.highs + npmSummary.criticals + pipSummary.highs + pipSummary.criticals);
  if (depHighs > 0) {
    report.summary.passed = false;
    report.summary.reasons.push('Dependency vulnerabilities detected');
  }

  report.di = await analyzeDI(abs, { llm: false, maxFiles });
  if (gradeRank(report.di.grade) > gradeRank('C')) {
    report.summary.passed = false;
    report.summary.reasons.push('DI architecture grade below C');
  }

  return report;
}

export function renderCIReport(report) {
  const lines = [];
  const pass = report.summary?.passed;

  lines.push(chalk.bold.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
  lines.push(chalk.bold.cyan('║                         CI Gate                              ║'));
  lines.push(chalk.bold.cyan('╚══════════════════════════════════════════════════════════════╝\n'));

  lines.push(`Project: ${chalk.white(report.projectPath)}`);
  lines.push(`Status : ${pass ? chalk.green('PASS') : chalk.red('FAIL')}`);
  if (!pass && report.summary?.reasons?.length) {
    lines.push(`Reasons: ${report.summary.reasons.join(', ')}`);
  }

  if (report.tests) {
    lines.push(renderSection('Tests', renderTestReport(report.tests)));
  }

  if (report.security) {
    lines.push(chalk.bold.cyan('Security'));
    lines.push(`  Files scanned: ${report.security.filesScanned}`);
    lines.push(`  Findings     : ${report.security.totalFindings}`);
    lines.push(`  Critical     : ${report.security.criticals}`);
    lines.push(`  High         : ${report.security.highs}\n`);
  }

  if (report.dependencies) {
    const npmSummary = summarizeNpmAudit(report.dependencies?.npm);
    const pipSummary = summarizePipeAudit(report.dependencies?.pip);
    lines.push(chalk.bold.cyan('Dependencies'));
    lines.push(`  npm critical/high : ${npmSummary.criticals}/${npmSummary.highs}`);
    lines.push(`  pip critical/high : ${pipSummary.criticals}/${pipSummary.highs}\n`);
  }

  if (report.di) {
    lines.push(renderSection('DI Analysis', renderDIReport(report.di)));
  }

  return lines.join('\n');
}

export function generateCIMarkdown(report) {
  const lines = [
    '# CI Report',
    '',
    `**Project:** \`${report.projectPath}\``,
    `**Status:** ${report.summary?.passed ? 'PASS' : 'FAIL'}`,
    '',
  ];

  if (report.summary?.reasons?.length) {
    lines.push('## Reasons', '', ...report.summary.reasons.map(r => `- ${r}`), '');
  }

  return lines.join('\n');
}
