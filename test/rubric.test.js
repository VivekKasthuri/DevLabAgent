// Rubric generation + scoring tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateRubric, scoreRubric } from '../src/tools/rubric.js';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-test-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 't', scripts: { test: 'echo ok' }, devDependencies: { jest: '1.0.0' } }));
  fs.writeFileSync(path.join(tmp, 'README.md'), '# Test project\n' + 'x'.repeat(600));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'index.js'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(tmp, 'test'));
  fs.writeFileSync(path.join(tmp, 'test', 'index.test.js'), 'test("a", () => {});\n');
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('generateRubric', () => {
  it('generates project rubric with all files', () => {
    const r = generateRubric({ path: tmp, target: 'project' });
    expect(r.criteria.length).toBeGreaterThanOrEqual(7);
    expect(r.written.some(f => /rubric\.(pr|project)\.json$/.test(f))).toBe(true);
    expect(r.written.some(f => /REQUIREMENTS\.(pr|project)\.md$/.test(f))).toBe(true);
  });

  it('adds PR_REVIEW.md for pr target', () => {
    const r = generateRubric({ path: tmp, target: 'pr', write: false });
    expect(Object.keys(r.files)).toContain('PR_REVIEW.md');
  });

  it('includes custom requirements', () => {
    const r = generateRubric({ path: tmp, write: false, requirements: ['Support dark mode'] });
    expect(r.requirements.some(x => x.includes('dark mode'))).toBe(true);
  });

  it('errors on missing path', () => {
    expect(generateRubric({ path: '/nonexistent/xyz' }).error).toBeTruthy();
  });
});

describe('scoreRubric', () => {
  it('scores a project and writes scorecard', async () => {
    const s = await scoreRubric({ path: tmp });
    expect(['pass', 'fail']).toContain(s.verdict);
    expect(s.weightedScore).toBeGreaterThan(0);
    expect(s.weightedScore).toBeLessThanOrEqual(4);
    expect(s.breakdown.length).toBeGreaterThan(0);
  });

  it('detects test presence in scoring', async () => {
    const s = await scoreRubric({ path: tmp, write: false });
    const testing = s.breakdown.find(b => b.startsWith('Testing'));
    expect(testing).not.toContain('no test files found');
  });
});
