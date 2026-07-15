// Memory tests — remember/recall round-trip
import { describe, it, expect } from 'vitest';
import { remember, recall } from '../src/memory.js';

describe('memory', () => {
  it('remembers and recalls a fact', () => {
    const key = 'test-fact-' + Date.now();
    remember(key, 'vitest memory round-trip value', ['test'], '/tmp/memtest');
    const found = recall('vitest memory round-trip');
    expect(found.some(m => m.key === key)).toBe(true);
  });

  it('recall returns an array even with no matches', () => {
    const r = recall('zzz-no-such-thing-' + Math.random());
    expect(Array.isArray(r)).toBe(true);
  });
});
