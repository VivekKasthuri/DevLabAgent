// Quality (self-refine) tests — offline-safe, chatFn injected
import { describe, it, expect, afterEach } from 'vitest';
import { shouldRefine, refine, critiquePasses, qualityEnabled, maxRefineRounds } from '../src/quality.js';

afterEach(() => {
  delete process.env.DEVLAB_QUALITY;
  delete process.env.DEVLAB_QUALITY_ROUNDS;
});

const CODE_ANSWER = 'Here is the fix:\n```js\nfunction add(a, b) { return a + b; }\n```\n' + 'x'.repeat(200);

describe('shouldRefine', () => {
  it('refines local code answers on standard/complex tiers', () => {
    expect(shouldRefine({ provider: 'ollama', tier: 'standard', content: CODE_ANSWER })).toBe(true);
    expect(shouldRefine({ provider: 'openai-compatible', tier: 'complex', content: CODE_ANSWER })).toBe(true);
  });

  it('never refines cloud providers (costs real money)', () => {
    expect(shouldRefine({ provider: 'claude', tier: 'complex', content: CODE_ANSWER })).toBe(false);
    expect(shouldRefine({ provider: 'groq', tier: 'standard', content: CODE_ANSWER })).toBe(false);
  });

  it('skips trivial tier, tool-call turns, short and non-code answers', () => {
    expect(shouldRefine({ provider: 'ollama', tier: 'trivial', content: CODE_ANSWER })).toBe(false);
    expect(shouldRefine({ provider: 'ollama', tier: 'standard', content: CODE_ANSWER, toolCalls: [{}] })).toBe(false);
    expect(shouldRefine({ provider: 'ollama', tier: 'standard', content: 'short' })).toBe(false);
    expect(shouldRefine({ provider: 'ollama', tier: 'standard', content: 'no code here. '.repeat(30) })).toBe(false);
  });

  it('DEVLAB_QUALITY=off disables refinement', () => {
    process.env.DEVLAB_QUALITY = 'off';
    expect(qualityEnabled()).toBe(false);
    expect(shouldRefine({ provider: 'ollama', tier: 'standard', content: CODE_ANSWER })).toBe(false);
  });

  it('DEVLAB_QUALITY_ROUNDS is capped at 3', () => {
    process.env.DEVLAB_QUALITY_ROUNDS = '9';
    expect(maxRefineRounds()).toBe(3);
  });
});

describe('critiquePasses', () => {
  it('passes on LGTM and no-defects replies', () => {
    expect(critiquePasses('LGTM')).toBe(true);
    expect(critiquePasses('No material defects found.')).toBe(true);
    expect(critiquePasses('')).toBe(true);
  });
  it('fails when defects are listed', () => {
    expect(critiquePasses('- off-by-one in loop\n- missing null check')).toBe(false);
  });
});

describe('refine', () => {
  it('revises the draft when critique finds defects', async () => {
    const calls = [];
    const chatFn = async ({ messages }) => {
      calls.push(messages[0].content.slice(0, 20));
      if (calls.length === 1) return { content: '- add() breaks on strings' };
      return { content: CODE_ANSWER.replace('a + b', 'Number(a) + Number(b)') };
    };
    const res = await refine({ task: 'write add()', content: CODE_ANSWER, chatFn, rounds: 1 });
    expect(res.improved).toBe(true);
    expect(res.rounds).toBe(1);
    expect(res.content).toContain('Number(a) + Number(b)');
    expect(res.critiques).toHaveLength(1);
  });

  it('exits early on LGTM without revising', async () => {
    let n = 0;
    const res = await refine({ task: 't', content: CODE_ANSWER, chatFn: async () => { n++; return { content: 'LGTM' }; }, rounds: 3 });
    expect(res.improved).toBe(false);
    expect(res.content).toBe(CODE_ANSWER);
    expect(n).toBe(1); // one critique call, no revise
  });

  it('keeps the draft when the revision collapses (regression guard)', async () => {
    let n = 0;
    const chatFn = async () => (++n === 1 ? { content: '- bug' } : { content: 'oops' });
    const res = await refine({ task: 't', content: CODE_ANSWER, chatFn, rounds: 2 });
    expect(res.improved).toBe(false);
    expect(res.content).toBe(CODE_ANSWER);
  });

  it('never throws when chatFn fails — returns original draft', async () => {
    const res = await refine({ task: 't', content: CODE_ANSWER, chatFn: async () => { throw new Error('down'); }, rounds: 2 });
    expect(res.improved).toBe(false);
    expect(res.content).toBe(CODE_ANSWER);
  });
});

describe('best-of-N sampling', () => {
  it('is off by default and only for complex local work', async () => {
    const { shouldSample, bestOfN } = await import('../src/quality.js');
    expect(bestOfN()).toBe(1);
    expect(shouldSample({ provider: 'ollama', tier: 'complex' })).toBe(false);
    process.env.DEVLAB_BEST_OF = '3';
    expect(shouldSample({ provider: 'ollama', tier: 'complex' })).toBe(true);
    expect(shouldSample({ provider: 'ollama', tier: 'standard' })).toBe(false);
    expect(shouldSample({ provider: 'claude', tier: 'complex' })).toBe(false);
    delete process.env.DEVLAB_BEST_OF;
  });

  it('generates N candidates and picks the judged winner', async () => {
    const { sampleBest } = await import('../src/quality.js');
    let call = 0;
    const chatFn = async () => {
      call++;
      if (call === 1) return { content: 'candidate one — buggy', model: 'm' };
      if (call === 2) return { content: 'candidate two — correct', model: 'm' };
      return { content: 'The best is 2', model: 'm' }; // judge
    };
    const res = await sampleBest({ messages: [{ role: 'user', content: 'task' }], chatFn, n: 2 });
    expect(res.content).toBe('candidate two — correct');
    expect(res.sampledFrom).toBe(2);
  });

  it('returns immediately when a candidate makes tool calls', async () => {
    const { sampleBest } = await import('../src/quality.js');
    let call = 0;
    const chatFn = async () => { call++; return { content: '', toolCalls: [{ id: 't1' }] }; };
    const res = await sampleBest({ messages: [{ role: 'user', content: 'task' }], chatFn, n: 3 });
    expect(res.toolCalls).toHaveLength(1);
    expect(call).toBe(1);
  });

  it('falls back to first candidate when judging fails', async () => {
    const { sampleBest } = await import('../src/quality.js');
    let call = 0;
    const chatFn = async () => {
      call++;
      if (call <= 2) return { content: `candidate ${call} — code here` };
      throw new Error('judge down');
    };
    const res = await sampleBest({ messages: [{ role: 'user', content: 'task' }], chatFn, n: 2 });
    expect(res.content).toContain('candidate 1');
  });
});

describe('cheap-frontier provider presets', () => {
  it('config exposes openrouter/together presets (US-origin defaults)', async () => {
    const { CHEAP_FRONTIER_PROVIDERS } = await import('../src/config.js');
    for (const name of ['openrouter', 'together']) {
      expect(CHEAP_FRONTIER_PROVIDERS[name]).toBeDefined();
      expect(CHEAP_FRONTIER_PROVIDERS[name].baseUrl).toMatch(/^https:/);
      expect(CHEAP_FRONTIER_PROVIDERS[name].model).toBeTruthy();
    }
  });
});
