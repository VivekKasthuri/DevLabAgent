// Knowledge base tests — add, dedupe, harvest, injection loading
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { addKnowledge, harvestFromPR, loadKnowledge, showKnowledge } from '../src/tools/knowledge.js';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  execSync('git init -q && git config user.email t@t.co && git config user.name T', { cwd: tmp });
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'db.js'), '// NOTE: init() must run before connect()\n');
  execSync('git add -A && git commit -qm "fix: race condition in db startup"', { cwd: tmp });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('addKnowledge', () => {
  it('adds an entry', () => {
    const r = addKnowledge({ path: tmp, category: 'gotcha', text: 'init() must run before connect()', pr: '#1' });
    expect(r.added).toBe(true);
    expect(fs.readFileSync(path.join(tmp, '.devlab/kb/KNOWLEDGE.md'), 'utf8')).toContain('init() must run before connect()');
  });

  it('rejects duplicates', () => {
    const r = addKnowledge({ path: tmp, category: 'gotcha', text: 'init() must run before connect()' });
    expect(r.added).toBe(false);
  });

  it('rejects invalid category', () => {
    expect(addKnowledge({ path: tmp, category: 'bogus', text: 'x' }).error).toBeTruthy();
  });
});

describe('harvestFromPR', () => {
  it('finds candidates from fix commits and NOTE comments', () => {
    const r = harvestFromPR({ path: tmp });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.some(c => c.category === 'gotcha')).toBe(true);
  });
});

describe('loadKnowledge', () => {
  it('loads content for agent injection', () => {
    const r = loadKnowledge(tmp);
    expect(r.found).toBe(true);
    expect(r.content).toContain('PROJECT KNOWLEDGE BASE');
  });

  it('returns not-found for empty projects', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-empty-'));
    expect(loadKnowledge(empty).found).toBe(false);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('showKnowledge', () => {
  it('searches entries', () => {
    const r = showKnowledge({ path: tmp, query: 'connect' });
    expect(r.found).toBe(true);
    expect(r.matches.length).toBeGreaterThan(0);
  });
});
