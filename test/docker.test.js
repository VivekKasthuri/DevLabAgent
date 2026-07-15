// Docker tool tests — offline-safe (never require a running daemon)
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { dockerStatus, generateDockerfile, listContainers, sandboxRun } from '../src/tools/docker.js';

describe('dockerStatus', () => {
  it('returns a structured status without throwing', () => {
    const s = dockerStatus();
    expect(typeof s.installed).toBe('boolean');
    if (!s.installed) expect(s.hint).toBeTruthy();
  });
});

describe('graceful degradation without daemon', () => {
  it('listContainers never throws', () => {
    const r = listContainers();
    expect(r).toBeTruthy();
  });

  it('sandboxRun requires a command', () => {
    const r = sandboxRun({});
    expect(r.error || r.installed === false || r.running === false).toBeTruthy();
  });
});

describe('generateDockerfile', () => {
  it('detects node and produces multi-stage non-root Dockerfile', () => {
    const r = generateDockerfile({ path: process.cwd(), write: false });
    expect(r.detected).toContain('node');
    expect(r.dockerfile).toContain('FROM node:');
    expect(r.dockerfile).toContain('USER node');
    expect(r.dockerignore).toContain('node_modules');
  });

  it('detects go projects', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-go-'));
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module example.com/app\n');
    const r = generateDockerfile({ path: tmp, write: false });
    expect(r.detected).toBe('go');
    expect(r.dockerfile).toContain('golang:');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing Dockerfile', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-ex-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(tmp, 'Dockerfile'), 'FROM scratch');
    const r = generateDockerfile({ path: tmp });
    expect(r.error).toContain('already exists');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
