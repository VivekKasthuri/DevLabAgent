// Semantic index tests — build, incremental update, search relevance
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildIndex, searchIndex, indexStatus } from '../src/tools/semindex.js';

let tmp;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'semidx-test-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'auth.js'), `
// Token refresh logic for authentication
export async function refreshAccessToken(refreshToken) {
  const response = await fetch('/oauth/token', { method: 'POST', body: refreshToken });
  return response.json();
}
export function isTokenExpired(token) {
  return token.expiresAt < Date.now();
}
`);
  fs.writeFileSync(path.join(tmp, 'src', 'retry.js'), `
// Network retry with exponential backoff
export async function retryWithBackoff(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}
`);
  fs.writeFileSync(path.join(tmp, 'src', 'logger.js'), `
// Application logging utilities
export function logError(message, error) {
  console.error('[ERROR]', message, error.stack);
}
`);
  await buildIndex({ path: tmp });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('buildIndex', () => {
  it('indexes source files into chunks', async () => {
    const r = await buildIndex({ path: tmp, force: true });
    expect(r.files).toBe(3);
    expect(r.chunks).toBeGreaterThan(0);
    expect(r.mode).toBeTruthy();
  });

  it('reuses unchanged files incrementally', async () => {
    const r = await buildIndex({ path: tmp });
    expect(r.reused).toBe(3);
    expect(r.indexed).toBe(0);
  });

  it('re-indexes only changed files', async () => {
    fs.appendFileSync(path.join(tmp, 'src', 'logger.js'), '\nexport const LEVEL = "info";\n');
    const r = await buildIndex({ path: tmp });
    expect(r.indexed).toBe(1);
    expect(r.reused).toBe(2);
  });
});

describe('searchIndex', () => {
  it('finds token refresh code by concept', async () => {
    const r = await searchIndex({ path: tmp, query: 'refresh authentication token' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].file).toContain('auth');
  });

  it('finds retry logic via camelCase-aware matching', async () => {
    const r = await searchIndex({ path: tmp, query: 'exponential backoff retry attempts' });
    expect(r.results[0].file).toContain('retry');
  });

  it('returns file, line range, and preview', async () => {
    const r = await searchIndex({ path: tmp, query: 'log error message' });
    const top = r.results[0];
    expect(top.file).toBeTruthy();
    expect(top.lines).toMatch(/^\d+-\d+$/);
    expect(top.preview.length).toBeGreaterThan(10);
  });

  it('requires a query', async () => {
    const r = await searchIndex({ path: tmp });
    expect(r.error).toBeTruthy();
  });
});

describe('indexStatus', () => {
  it('reports index metadata', () => {
    const s = indexStatus(tmp);
    expect(s.exists).toBe(true);
    expect(s.files).toBe(3);
    expect(s.chunks).toBeGreaterThan(0);
  });

  it('reports missing index', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'semidx-empty-'));
    expect(indexStatus(empty).exists).toBe(false);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
