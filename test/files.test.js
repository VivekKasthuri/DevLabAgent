// File tools tests — protected-path enforcement and basic IO
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readFile, writeFile, listFiles, deleteFile } from '../src/tools/files.js';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-'));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('writeFile + readFile', () => {
  it('round-trips content', async () => {
    const f = path.join(tmp, 'hello.txt');
    await writeFile(f, 'hello world');
    const r = await readFile(f);
    expect(r.content || r).toContain('hello world');
  });

  it('refuses to read protected .env files', async () => {
    const f = path.join(tmp, '.env');
    fs.writeFileSync(f, 'SECRET=1');
    const r = await readFile(f);
    expect(JSON.stringify(r)).toMatch(/protect|denied|blocked/i);
  });

  it('refuses to write protected paths', async () => {
    const r = await writeFile(path.join(tmp, '.env'), 'SECRET=2');
    expect(JSON.stringify(r)).toMatch(/protect|denied|blocked/i);
  });
});

describe('listFiles', () => {
  it('lists files with a pattern', async () => {
    const r = await listFiles(tmp, '**/*.txt');
    expect((r.files || []).some(f => f.path.includes('hello'))).toBe(true);
  });
});

describe('deleteFile', () => {
  it('deletes normal files', async () => {
    const f = path.join(tmp, 'trash.txt');
    fs.writeFileSync(f, 'x');
    await deleteFile(f);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('refuses to delete protected files', async () => {
    const r = await deleteFile(path.join(tmp, '.env'));
    expect(JSON.stringify(r)).toMatch(/protect|denied|blocked/i);
  });
});
