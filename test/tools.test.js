// Tools registry + misc tool smoke tests (no LLM, no network)
import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, executeTool } from '../src/tools/index.js';
import { listRoles } from '../src/subagent.js';
import { generateDockerfile, dockerStatus } from '../src/tools/docker.js';
import { generateDiagram } from '../src/tools/diagram.js';

describe('tool registry', () => {
  it('has 70+ tools with valid schemas', () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThanOrEqual(70);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe('function');
      expect(t.function.name).toBeTruthy();
      expect(t.function.description).toBeTruthy();
      expect(t.function.parameters.type).toBe('object');
    }
  });

  it('has no duplicate tool names', () => {
    const names = TOOL_DEFINITIONS.map(t => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('returns error for unknown tools', async () => {
    const r = await executeTool('nonexistent_tool_xyz', {});
    expect(JSON.stringify(r)).toMatch(/unknown|error/i);
  });
});

describe('subagent roles', () => {
  it('defines 5 roles', () => {
    const roles = listRoles();
    expect(roles.map(r => r.role)).toEqual(['explorer', 'coder', 'tester', 'reviewer', 'general']);
  });

  it('role tool lists reference real tools', () => {
    const names = new Set(TOOL_DEFINITIONS.map(t => t.function.name));
    // sanity: core tools used by roles exist
    for (const t of ['read_file', 'write_file', 'run_command', 'score_rubric', 'pr_baseline', 'scan_security']) {
      expect(names.has(t)).toBe(true);
    }
  });
});

describe('docker (offline-safe)', () => {
  it('dockerStatus never throws', () => {
    const s = dockerStatus();
    expect(typeof s.installed).toBe('boolean');
  });

  it('generates a Dockerfile for a node project without Docker', () => {
    const r = generateDockerfile({ path: process.cwd(), write: false });
    expect(r.detected).toContain('node');
    expect(r.dockerfile).toContain('FROM node:');
    expect(r.dockerfile).toContain('USER node'); // non-root
  });
});

describe('diagram generation', () => {
  it('creates a plantuml flowchart from steps', () => {
    const r = generateDiagram({ type: 'flowchart', steps: ['A -> B: start', 'B -> C: done'] });
    expect(r.source || r.content || JSON.stringify(r)).toContain('B');
    expect(r.error).toBeUndefined();
  });
});
