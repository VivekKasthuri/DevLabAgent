// PR baseline + prompt statement tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { detectTooling, captureBaseline, compareBaseline, generatePromptStatement } from '../src/tools/pr.js';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-test-'));
  execSync('git init -q && git config user.email t@t.co && git config user.name T', { cwd: tmp });
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
    name: 'fix', scripts: { test: 'node test.js', lint: 'node -e "process.exit(0)"' },
  }));
  fs.writeFileSync(path.join(tmp, 'test.js'), 'if (1+1!==2) process.exit(1)');
  execSync('git add -A && git commit -qm "feat: initial"', { cwd: tmp });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('detectTooling', () => {
  it('detects npm scripts', () => {
    const checks = detectTooling(tmp);
    const ids = checks.map(c => c.id);
    expect(ids).toContain('test');
    expect(ids).toContain('lint');
  });
});

describe('captureBaseline + compareBaseline', () => {
  it('captures a passing baseline', () => {
    const cap = captureBaseline({ path: tmp, label: 'baseline' });
    expect(cap.error).toBeUndefined();
    expect(cap.results.every(r => r.ok)).toBe(true);
  });

  it('detects a regression', () => {
    fs.writeFileSync(path.join(tmp, 'test.js'), 'process.exit(1)');
    execSync('git add -A && git commit -qm "fix: broke it"', { cwd: tmp });
    const cmp = compareBaseline({ path: tmp });
    expect(cmp.mergeSafe).toBe(false);
    expect(cmp.verdicts.find(v => v.check === 'test').verdict).toBe('REGRESSION');
    expect(cmp.verdicts.find(v => v.check === 'lint').verdict).toBe('still-passing');
  });
});

describe('generatePromptStatement', () => {
  it('generates PROMPT_STATEMENT.md from git history', () => {
    const r = generatePromptStatement({ path: tmp, problem: 'Testing', write: false });
    expect(r.markdown).toContain('# Prompt Statement');
    expect(r.markdown).toContain('Testing');
    expect(r.filesChanged).toBeGreaterThan(0);
  });
});
