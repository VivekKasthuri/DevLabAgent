// Inline completion engine tests — offline-safe (prompt building + cleanup only)
import { describe, it, expect } from 'vitest';
import { buildCompletionPrompt, cleanCompletion } from '../src/inline.js';

describe('buildCompletionPrompt', () => {
  it('embeds prefix and suffix around <CURSOR>', () => {
    const { system, user } = buildCompletionPrompt({
      prefix: 'function add(a, b) {\n  return ',
      suffix: '\n}',
      language: 'javascript',
      filename: 'src/math.js',
    });
    expect(system).toContain('inline code completion');
    expect(user).toContain('function add(a, b) {\n  return <CURSOR>\n}');
    expect(user).toContain('Language: javascript');
    expect(user).toContain('File: src/math.js');
  });

  it('truncates oversized prefix/suffix/context', () => {
    const { user } = buildCompletionPrompt({
      prefix: 'x'.repeat(10000),
      suffix: 'y'.repeat(5000),
      context: 'z'.repeat(5000),
    });
    expect(user.length).toBeLessThan(7000);
  });

  it('omits context section when empty', () => {
    const { user } = buildCompletionPrompt({ prefix: 'const a = ' });
    expect(user).not.toContain('Relevant code');
  });
});

describe('cleanCompletion', () => {
  it('strips markdown fences', () => {
    expect(cleanCompletion('```js\na + b;\n```')).toBe('a + b;');
    expect(cleanCompletion('```\nfoo()\n```')).toBe('foo()');
  });

  it('removes <CURSOR> echoes', () => {
    expect(cleanCompletion('a + b;<CURSOR>')).toBe('a + b;');
  });

  it('removes repeated current line from start', () => {
    const out = cleanCompletion('  return a + b;', { prefix: 'function add(a, b) {\n  return' });
    expect(out).toBe(' a + b;');
  });

  it('trims overlap with the suffix', () => {
    const out = cleanCompletion('a + b;\n}\nmodule.exports', { prefix: 'return ', suffix: '\n}\nmodule.exports = add;' });
    expect(out).toBe('a + b;');
  });

  it('caps output at 30 lines', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    expect(cleanCompletion(long).split('\n').length).toBe(30);
  });

  it('returns empty string for empty input', () => {
    expect(cleanCompletion('')).toBe('');
    expect(cleanCompletion(null)).toBe('');
  });
});
