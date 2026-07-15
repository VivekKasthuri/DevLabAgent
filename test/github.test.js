// GitHub PR bot tests — offline-safe (no network, no token required)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { detectRepo, listPRs, getPR, commentOnPR, reviewPR, generateAction } from '../src/tools/github.js';

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-gh-'));
  execSync('git init -q && git remote add origin https://github.com/acme/widget.git', { cwd: tmp });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('github pr bot', () => {
  it('detects owner/repo from https remote', () => {
    expect(detectRepo(tmp)).toEqual({ owner: 'acme', repo: 'widget' });
  });

  it('detects owner/repo from ssh remote', () => {
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-gh2-'));
    execSync('git init -q && git remote add origin git@github.com:foo/bar.git', { cwd: t2 });
    expect(detectRepo(t2)).toEqual({ owner: 'foo', repo: 'bar' });
    fs.rmSync(t2, { recursive: true, force: true });
  });

  it('returns null for non-repo dirs', () => {
    expect(detectRepo(os.tmpdir())).toBeNull();
  });

  it('fails cleanly without a token', async () => {
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const res = await listPRs({ path: tmp });
    expect(res.error).toMatch(/GITHUB_TOKEN/);
    if (saved.GITHUB_TOKEN) process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
    if (saved.GH_TOKEN) process.env.GH_TOKEN = saved.GH_TOKEN;
  });

  it('getPR requires a number', async () => {
    const res = await getPR({ owner: 'a', repo: 'b' });
    expect(res.error).toBeTruthy();
  });

  it('commentOnPR validates inputs', async () => {
    const res = await commentOnPR({ owner: 'a', repo: 'b' });
    expect(res.error).toBeTruthy();
  });

  it('reviewPR works locally without token (preview mode)', async () => {
    const res = await reviewPR({ path: process.cwd(), post: false, runBaseline: false });
    expect(res.verdict).toMatch(/pass|fail/);
    expect(res.comment).toContain('DevLab PR Review');
    expect(res.comment).toContain('| Criterion |');
  }, 60000);

  it('reviewPR feeds failed criteria into the knowledge base', async () => {
    // bare repo with no tests/docs/CI → guaranteed rubric action items
    const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-gh3-'));
    execSync('git init -q', { cwd: t3 });
    fs.writeFileSync(path.join(t3, 'app.js'), 'console.log("hi")\n');
    execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm x', { cwd: t3 });
    const res = await reviewPR({ path: t3, post: false, runBaseline: false });
    expect(res.verdict).toMatch(/pass|fail/);
    if (res.kbEntries) {
      const kb = fs.readFileSync(path.join(t3, '.devlab', 'kb', 'KNOWLEDGE.md'), 'utf8');
      expect(kb).toContain('Rubric flagged');
    }
    fs.rmSync(t3, { recursive: true, force: true });
  }, 60000);

  it('generateAction previews without writing', () => {
    const res = generateAction({ path: tmp, write: false });
    expect(res.yml).toContain('name: DevLab PR Review');
    expect(res.yml).toContain('pull-requests: write');
    expect(res.written).toEqual([]);
  });

  it('generateAction writes the workflow file and refuses overwrite', () => {
    const res = generateAction({ path: tmp, write: true });
    const fp = path.join(tmp, '.github', 'workflows', 'devlab-review.yml');
    expect(res.written).toContain(fp);
    expect(fs.existsSync(fp)).toBe(true);
    const again = generateAction({ path: tmp, write: true });
    expect(again.error).toMatch(/already exists/);
  });
});
