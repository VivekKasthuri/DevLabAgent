// Claude-free ceiling tests: DevLab's complex ladder must reach frontier
// quality without any Claude dependency (gpt-oss-120b reasoning rung first,
// DEVLAB_CLAUDE=off strips Claude entirely). All defaults are US-origin models.
import { describe, it, expect, beforeAll } from 'vitest';

let buildLadder, CHEAP_FRONTIER_PROVIDERS;

beforeAll(async () => {
  // Set env BEFORE importing (config.js reads env at import time)
  process.env.DEVLAB_CLAUDE = 'off';
  process.env.CLAUDE_API_KEY = 'sk-ant-test-key';
  process.env.OPENROUTER_API_KEY = 'sk-test-openrouter';
  ({ buildLadder } = await import('../src/router.js'));
  ({ CHEAP_FRONTIER_PROVIDERS } = await import('../src/config.js'));
});

describe('claude-free ceiling (US-origin models)', () => {
  it('every frontier preset declares a reasoning model', () => {
    for (const [name, p] of Object.entries(CHEAP_FRONTIER_PROVIDERS)) {
      expect(p.reasoningModel, `${name} missing reasoningModel`).toBeTruthy();
    }
  });

  it('all default models are US-origin (no Chinese-origin weights)', () => {
    for (const p of Object.values(CHEAP_FRONTIER_PROVIDERS)) {
      for (const m of [p.model, p.fastModel, p.reasoningModel]) {
        expect(m.toLowerCase()).not.toMatch(/deepseek|qwen|glm|yi-|kimi|minimax/);
      }
    }
  });

  it('complex ladder tops with the gpt-oss reasoning rung, not Claude', () => {
    const ladder = buildLadder('complex');
    expect(ladder[0].provider).toBe('openrouter');
    expect(ladder[0].model).toBe(CHEAP_FRONTIER_PROVIDERS.openrouter.reasoningModel);
    expect(ladder[0].model).toContain('gpt-oss');
  });

  it('DEVLAB_CLAUDE=off strips Claude from every ladder even with a key set', () => {
    for (const tier of ['trivial', 'standard', 'complex']) {
      const ladder = buildLadder(tier);
      expect(ladder.some((r) => r.provider === 'claude')).toBe(false);
    }
  });

  it('ladders still end with local fallback', () => {
    const ladder = buildLadder('complex');
    expect(ladder[ladder.length - 1].provider).toBe('ollama');
  });
});
