// Dashboard data collector tests — offline-safe
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { collectQuality, collectKnowledge, collectDashboard } from '../src/dashboard.js';

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-dash-'));
  const rubrics = path.join(tmp, '.devlab', 'rubrics');
  fs.mkdirSync(rubrics, { recursive: true });
  fs.writeFileSync(path.join(rubrics, 'history.jsonl'), [
    JSON.stringify({ scoredAt: '2026-07-01T00:00:00Z', type: 'pr', prNumber: 1, weightedScore: 2.5, passingScore: 3, verdict: 'fail' }),
    JSON.stringify({ scoredAt: '2026-07-02T00:00:00Z', type: 'pr', prNumber: 2, weightedScore: 2.7, passingScore: 3, verdict: 'fail' }),
    JSON.stringify({ scoredAt: '2026-07-03T00:00:00Z', type: 'pr', prNumber: 3, weightedScore: 3.1, passingScore: 3, verdict: 'pass' }),
    JSON.stringify({ scoredAt: '2026-07-04T00:00:00Z', type: 'pr', prNumber: 4, weightedScore: 3.4, passingScore: 3, verdict: 'pass' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(rubrics, 'scorecard.pr-4.json'), JSON.stringify({
    type: 'pr', prNumber: 4, weightedScore: 3.4, passingScore: 3, verdict: 'pass',
    scoredAt: '2026-07-04T00:00:00Z',
    scores: { tests: { name: 'Test Coverage', points: 2, weight: 20 }, quality: { name: 'Code Quality', points: 4, weight: 20 } },
  }));

  const kb = path.join(tmp, '.devlab', 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'KNOWLEDGE.md'), `# Project Knowledge Base

## Patterns
- Use the repo pattern for data access _(2026-07-01)_

## Gotchas
- Rubric flagged — Test Coverage (2/4): no tests _(2026-07-02 · PR: #2)_
- Tests need DEVLAB_BILLING_FILE set _(2026-07-03)_

## Decisions

## Conventions

## Area Map
`);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('collectQuality', () => {
  it('parses history and computes an improving trend', () => {
    const q = collectQuality(tmp);
    expect(q.history.length).toBe(4);
    expect(q.trend).toBeGreaterThan(0);
  });

  it('lists scorecards with failing criteria', () => {
    const q = collectQuality(tmp);
    expect(q.scorecards.length).toBe(1);
    expect(q.scorecards[0].prNumber).toBe(4);
    expect(q.scorecards[0].failingCriteria).toContain('Test Coverage');
  });

  it('returns empty shape when no rubrics dir', () => {
    const q = collectQuality(os.tmpdir());
    expect(q.history).toEqual([]);
    expect(q.trend).toBeNull();
  });
});

describe('collectKnowledge', () => {
  it('counts entries by category', () => {
    const kb = collectKnowledge(tmp);
    expect(kb.total).toBe(3);
    expect(kb.byCategory.gotcha).toBe(2);
    expect(kb.byCategory.pattern).toBe(1);
    expect(kb.recent.some(e => e.text.includes('Rubric flagged'))).toBe(true);
  });

  it('handles missing KB file', () => {
    expect(collectKnowledge(os.tmpdir()).total).toBe(0);
  });
});

describe('collectDashboard', () => {
  it('aggregates all sections without throwing', async () => {
    const d = await collectDashboard(tmp);
    expect(d.quality.history.length).toBe(4);
    expect(d.knowledge.total).toBe(3);
    expect(d.billing).toBeTruthy();
    expect(d.generatedAt).toBeTruthy();
  });
});
