// Token/cost optimization tests — offline-safe
import { describe, it, expect } from 'vitest';
import { selectTools, compressHistory, dedupeToolResults, estimateTokens } from '../src/context.js';

const mkTool = (name) => ({ type: 'function', function: { name, description: 'x'.repeat(200), parameters: {} } });
const ALL = [
  'read_file', 'write_file', 'apply_fix', 'list_files', 'search_files', 'run_command',
  'git_status', 'git_diff', 'git_commit', 'git_push', 'build_project', 'delegate_task',
  'docker', 'docker_sandbox', 'generate_dockerfile', 'pr_baseline', 'github_pr',
  'generate_rubric', 'score_rubric', 'knowledge_base', 'jira', 'confluence',
  'generate_diagram', 'voice_input', 'mobile_run', 'security_scan', 'run_tests',
  'semantic_search', 'build_code_index', 'check_endpoint_conflicts', 'check_race_conditions',
  'remember', 'recall', 'web_fetch', 'ci_status', 'scaffold_endpoint', 'fix_file', 'mcp_connect',
].map(mkTool);

describe('selectTools', () => {
  it('always keeps core tools', () => {
    const sel = selectTools('add a docker container for the api', ALL);
    const names = sel.map(t => t.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('run_command');
    expect(names).toContain('docker');
  });

  it('prunes irrelevant groups for a focused task', () => {
    const sel = selectTools('containerize the app with docker and docker compose please', ALL);
    const names = sel.map(t => t.function.name);
    expect(names).toContain('docker_sandbox');
    expect(names).not.toContain('jira');
    expect(names).not.toContain('voice_input');
    expect(sel.length).toBeLessThan(ALL.length);
  });

  it('returns all tools for vague requests', () => {
    expect(selectTools('help me', ALL)).toHaveLength(ALL.length);
    expect(selectTools('', ALL)).toHaveLength(ALL.length);
  });

  it('returns all tools when disabled', () => {
    expect(selectTools('docker stuff', ALL, { disable: true })).toHaveLength(ALL.length);
  });

  it('falls back to all tools when too few match', () => {
    const tiny = ALL.slice(0, 5);
    expect(selectTools('docker', tiny)).toHaveLength(tiny.length);
  });
});

describe('compressHistory', () => {
  it('squashes old tool results but keeps recent ones intact', () => {
    const big = 'A'.repeat(3000);
    const msgs = [
      { role: 'user', content: 'task' },
      { role: 'tool', content: big },
      { role: 'assistant', content: 'ok' },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: `recent ${i}` })),
    ];
    const out = compressHistory(msgs, { keepRecent: 6 });
    expect(out[1].content.length).toBeLessThan(400);
    expect(out[1].content).toContain('compressed');
    expect(out[out.length - 1].content).toBe('recent 5');
    expect(out._tokensSaved).toBeGreaterThan(500);
  });

  it('leaves short histories untouched', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    expect(compressHistory(msgs)).toEqual(msgs);
  });
});

describe('dedupeToolResults', () => {
  it('replaces identical repeated tool results', () => {
    const big = 'B'.repeat(1000);
    const msgs = [
      { role: 'tool', content: big },
      { role: 'assistant', content: 'x' },
      { role: 'tool', content: big },
    ];
    const out = dedupeToolResults(msgs);
    expect(out[0].content).toBe(big);
    expect(out[2].content).toContain('identical');
  });

  it('ignores small results', () => {
    const msgs = [{ role: 'tool', content: 'small' }, { role: 'tool', content: 'small' }];
    const out = dedupeToolResults(msgs);
    expect(out[1].content).toBe('small');
  });
});

describe('estimateTokens', () => {
  it('estimates message + tool tokens', () => {
    const est = estimateTokens([{ role: 'user', content: 'x'.repeat(400) }], ALL);
    expect(est.messages).toBe(100);
    expect(est.tools).toBeGreaterThan(1000);
    expect(est.total).toBe(est.messages + est.tools);
  });
});
