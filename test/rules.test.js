// Rules discovery + trimming tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadProjectRules, initProjectRules } from '../src/rules.js';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('loadProjectRules', () => {
  it('returns empty for a bare project', () => {
    const r = loadProjectRules(tmp);
    expect(r.found.length).toBe(0);
    expect(r.content).toBe('');
  });

  it('discovers CLAUDE.md', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Rules\nUse tabs.');
    const r = loadProjectRules(tmp);
    expect(r.found.some(f => f.source.toLowerCase().includes('claude'))).toBe(true);
    expect(r.content).toContain('Use tabs.');
  });

  it('discovers .cursorrules alongside CLAUDE.md', () => {
    fs.writeFileSync(path.join(tmp, '.cursorrules'), 'Prefer const.');
    const r = loadProjectRules(tmp);
    expect(r.found.length).toBeGreaterThanOrEqual(2);
    expect(r.content).toContain('Prefer const.');
  });
});

describe('initProjectRules', () => {
  it('creates DEVLAB.md with custom content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-init-'));
    const r = initProjectRules(dir, { content: '# My rules\nAlways test.' });
    expect(r.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'DEVLAB.md'), 'utf8')).toContain('Always test.');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
