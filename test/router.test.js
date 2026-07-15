// Model router tests — offline-safe (classification, ladders, failure detection)
import { describe, it, expect } from 'vitest';
import { classifyTask, buildLadder, looksLikeFailure, roleTier, ROLE_TIERS } from '../src/router.js';

describe('classifyTask', () => {
  it('classifies complex engineering tasks', () => {
    expect(classifyTask('Refactor the auth module to fix the race condition in token refresh')).toBe('complex');
    expect(classifyTask('Debug why the app has a memory leak under concurrent load')).toBe('complex');
    expect(classifyTask('Review this PR for security vulnerabilities and performance trade-offs')).toBe('complex');
  });

  it('classifies trivial lookups', () => {
    expect(classifyTask('list files')).toBe('trivial');
    expect(classifyTask('what is in package.json')).toBe('trivial');
    expect(classifyTask('git status')).toBe('trivial');
  });

  it('defaults to standard for ordinary requests', () => {
    expect(classifyTask('add a loading spinner to the login page please and thanks')).toBe('standard');
  });

  it('escalates after repeated failures regardless of text', () => {
    expect(classifyTask('list files', { priorFailures: 2 })).toBe('complex');
  });

  it('long context nudges toward complex', () => {
    const t = classifyTask('implement the new payments feature module ' + 'x'.repeat(900), { contextChars: 50000 });
    expect(t).toBe('complex');
  });
});

describe('buildLadder', () => {
  it('always ends with a local fallback', () => {
    for (const tier of ['trivial', 'standard', 'complex']) {
      const ladder = buildLadder(tier);
      expect(ladder.length).toBeGreaterThan(0);
      expect(ladder[ladder.length - 1].provider).toBe('ollama');
    }
  });

  it('unknown tier falls back to standard', () => {
    expect(buildLadder('bogus')).toEqual(buildLadder('standard'));
  });
});

describe('looksLikeFailure', () => {
  it('flags empty responses', () => {
    expect(looksLikeFailure(null)).toBe(true);
    expect(looksLikeFailure({ content: '', toolCalls: [] })).toBe(true);
    expect(looksLikeFailure({ content: '   ' })).toBe(true);
  });

  it('flags short refusals', () => {
    expect(looksLikeFailure({ content: "I can't help with that." })).toBe(true);
  });

  it('accepts real answers and tool calls', () => {
    expect(looksLikeFailure({ content: 'Here is the fix: change line 10.' })).toBe(false);
    expect(looksLikeFailure({ content: '', toolCalls: [{ id: '1' }] })).toBe(false);
  });
});

describe('roleTier', () => {
  it('maps coder/reviewer to complex, explorer to trivial', () => {
    expect(roleTier('coder')).toBe('complex');
    expect(roleTier('reviewer')).toBe('complex');
    expect(roleTier('explorer')).toBe('trivial');
    expect(roleTier('unknown-role')).toBe('standard');
  });

  it('covers every defined tier value', () => {
    for (const tier of Object.values(ROLE_TIERS)) {
      expect(['trivial', 'standard', 'complex']).toContain(tier);
    }
  });
});
