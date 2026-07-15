// Privacy mode tests — "your code never touches the cloud" must be enforceable
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getPrivacyMode, setPrivacyMode, isLocalProvider, assertProviderAllowed, PrivacyError,
} from '../src/privacy.js';

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-privacy-'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => { delete process.env.DEVLAB_PRIVACY; });

describe('getPrivacyMode / setPrivacyMode', () => {
  it('defaults to open', () => {
    expect(getPrivacyMode(tmp)).toBe('open');
  });

  it('persists local-only to .devlab/privacy.json and reads it back', () => {
    const res = setPrivacyMode('local-only', tmp);
    expect(res.mode).toBe('local-only');
    expect(fs.existsSync(res.file)).toBe(true);
    expect(getPrivacyMode(tmp)).toBe('local-only');
  });

  it('can be switched back to open', () => {
    setPrivacyMode('open', tmp);
    expect(getPrivacyMode(tmp)).toBe('open');
  });

  it('env var DEVLAB_PRIVACY overrides everything', () => {
    setPrivacyMode('open', tmp);
    process.env.DEVLAB_PRIVACY = 'local-only';
    expect(getPrivacyMode(tmp)).toBe('local-only');
  });
});

describe('isLocalProvider', () => {
  it('localhost openai-compatible endpoints are local', () => {
    expect(isLocalProvider('openai-compatible', 'http://localhost:11434')).toBe(true);
    expect(isLocalProvider('openai-compatible', 'http://127.0.0.1:8000/v1')).toBe(true);
  });

  it('cloud providers and remote endpoints are not local', () => {
    expect(isLocalProvider('claude')).toBe(false);
    expect(isLocalProvider('groq')).toBe(false);
    expect(isLocalProvider('openai-compatible', 'https://api.together.xyz/v1')).toBe(false);
  });
});

describe('assertProviderAllowed', () => {
  it('allows everything in open mode', () => {
    setPrivacyMode('open', tmp);
    expect(() => assertProviderAllowed('claude', { cwd: tmp })).not.toThrow();
    expect(() => assertProviderAllowed('groq', { cwd: tmp })).not.toThrow();
  });

  it('hard-blocks cloud providers in local-only mode', () => {
    setPrivacyMode('local-only', tmp);
    expect(() => assertProviderAllowed('claude', { cwd: tmp })).toThrow(PrivacyError);
    expect(() => assertProviderAllowed('groq', { cwd: tmp })).toThrow(/local-only/);
    expect(() => assertProviderAllowed('openai-compatible', { cwd: tmp, baseUrl: 'https://api.deepseek.com' })).toThrow(PrivacyError);
    setPrivacyMode('open', tmp);
  });

  it('always allows localhost inference in local-only mode', () => {
    setPrivacyMode('local-only', tmp);
    expect(() => assertProviderAllowed('openai-compatible', { cwd: tmp, baseUrl: 'http://localhost:11434' })).not.toThrow();
    setPrivacyMode('open', tmp);
  });
});

describe('router integration', () => {
  it('buildLadder returns only ollama in local-only mode', async () => {
    process.env.DEVLAB_PRIVACY = 'local-only';
    const { buildLadder } = await import('../src/router.js');
    for (const tier of ['trivial', 'standard', 'complex']) {
      const ladder = buildLadder(tier);
      expect(ladder).toEqual([{ provider: 'ollama' }]);
    }
  });
});

describe('llm chat choke point', () => {
  it('chat() throws PrivacyError before any network call when pinned to a cloud provider', async () => {
    process.env.DEVLAB_PRIVACY = 'local-only';
    const { chat } = await import('../src/llm.js');
    await expect(chat({ messages: [{ role: 'user', content: 'hi' }], provider: 'claude' }))
      .rejects.toThrow(/local-only/);
    await expect(chat({ messages: [{ role: 'user', content: 'hi' }], provider: 'groq' }))
      .rejects.toThrow(/local-only/);
  });
});
