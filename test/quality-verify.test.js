import { describe, it, expect } from 'vitest';
import { shouldCrossVerify, crossVerify, crossVerifyEnabled } from '../src/quality.js';

const CODE = 'function add(a, b) { return a + b; }\n'.repeat(10);

describe('cross-model verification', () => {
  it('is enabled by default and respects DEVLAB_CROSS_VERIFY=off', () => {
    expect(crossVerifyEnabled()).toBe(true);
    process.env.DEVLAB_CROSS_VERIFY = 'off';
    expect(crossVerifyEnabled()).toBe(false);
    delete process.env.DEVLAB_CROSS_VERIFY;
  });

  it('only triggers for local complex code answers', () => {
    expect(shouldCrossVerify({ provider: 'ollama', tier: 'complex', content: CODE })).toBe(true);
    expect(shouldCrossVerify({ provider: 'claude', tier: 'complex', content: CODE })).toBe(false);
    expect(shouldCrossVerify({ provider: 'ollama', tier: 'standard', content: CODE })).toBe(false);
    expect(shouldCrossVerify({ provider: 'ollama', tier: 'complex', content: 'short' })).toBe(false);
    expect(shouldCrossVerify({ provider: 'ollama', tier: 'complex', content: CODE, toolCalls: [{}] })).toBe(false);
  });

  it('passes when the verifier says PASS', async () => {
    const res = await crossVerify({ task: 't', content: CODE, verifyFn: async () => ({ content: 'PASS' }) });
    expect(res.passed).toBe(true);
  });

  it('fails with defects when the verifier says FAIL', async () => {
    const res = await crossVerify({ task: 't', content: CODE, verifyFn: async () => ({ content: 'FAIL: off-by-one in loop' }) });
    expect(res.passed).toBe(false);
    expect(res.defects).toContain('off-by-one');
  });

  it('accepts the answer when the verifier is unavailable', async () => {
    const res = await crossVerify({ task: 't', content: CODE, verifyFn: async () => { throw new Error('down'); } });
    expect(res.passed).toBe(true);
  });
});
