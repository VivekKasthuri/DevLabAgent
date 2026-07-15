// Advisor (recommend_development) tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { recommendDevelopment } from '../src/tools/advisor.js';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-test-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 't', scripts: { test: 'echo ok' } }));
  fs.writeFileSync(path.join(tmp, 'README.md'), '# Project\n' + 'info '.repeat(200));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'index.js'), 'export const ok = true;\n');
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('recommendDevelopment', () => {
  it('produces a score and grade in quick mode', async () => {
    const r = await recommendDevelopment(tmp, { quick: true });
    const score = r.healthScore ?? r.score;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(r.grade).toMatch(/^[A-F]$/);
  }, 60000);

  it('errors gracefully on a missing path', async () => {
    const r = await recommendDevelopment('/nonexistent/xyz', { quick: true }).catch(e => ({ error: e.message }));
    expect(r.error || r.grade).toBeTruthy();
  });
});
