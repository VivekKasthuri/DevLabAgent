// Dashboard data collector — aggregates billing, quality, KB, agent activity
// and guard stats into one JSON payload for the web dashboard (/api/dashboard).
import fs from 'fs';
import path from 'path';

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

// ---------- rubric quality (from .devlab/rubrics/) ----------
export function collectQuality(projectPath = '.') {
  const root = path.resolve(projectPath);
  const dir = path.join(root, '.devlab', 'rubrics');
  const out = { history: [], scorecards: [], trend: null };
  if (!fs.existsSync(dir)) return out;

  const historyFile = path.join(dir, 'history.jsonl');
  if (fs.existsSync(historyFile)) {
    out.history = fs.readFileSync(historyFile, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => safe(() => JSON.parse(l)))
      .filter(Boolean)
      .slice(-100);
  }

  for (const f of safe(() => fs.readdirSync(dir), [])) {
    if (/^scorecard\..*\.json$/.test(f)) {
      const card = safe(() => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      if (card) {
        out.scorecards.push({
          file: f, type: card.type, prNumber: card.prNumber,
          weightedScore: card.weightedScore, passingScore: card.passingScore,
          verdict: card.verdict, scoredAt: card.scoredAt,
          failingCriteria: Object.values(card.scores || {}).filter(s => s.points <= 2).map(s => s.name),
        });
      }
    }
  }
  out.scorecards.sort((a, b) => (b.scoredAt || '').localeCompare(a.scoredAt || ''));

  // trend: compare avg of first vs last half of history
  const scores = out.history.map(h => h.weightedScore).filter(n => typeof n === 'number');
  if (scores.length >= 4) {
    const mid = Math.floor(scores.length / 2);
    const avg = (a) => a.reduce((s, n) => s + n, 0) / a.length;
    out.trend = Math.round((avg(scores.slice(mid)) - avg(scores.slice(0, mid))) * 100) / 100;
  }
  return out;
}

// ---------- knowledge base (from .devlab/kb/KNOWLEDGE.md) ----------
export function collectKnowledge(projectPath = '.') {
  const fp = path.join(path.resolve(projectPath), '.devlab', 'kb', 'KNOWLEDGE.md');
  const out = { total: 0, byCategory: {}, recent: [] };
  if (!fs.existsSync(fp)) return out;
  const content = fs.readFileSync(fp, 'utf8');
  const sections = { Patterns: 'pattern', Gotchas: 'gotcha', Decisions: 'decision', Conventions: 'convention', 'Area Map': 'area' };
  for (const [heading, key] of Object.entries(sections)) {
    const idx = content.indexOf(`## ${heading}`);
    if (idx === -1) continue;
    const next = content.indexOf('\n## ', idx + 1);
    const body = content.slice(idx, next === -1 ? undefined : next);
    const entries = body.split('\n').filter(l => l.startsWith('- '));
    out.byCategory[key] = entries.length;
    out.total += entries.length;
    for (const e of entries.slice(0, 3)) out.recent.push({ category: key, text: e.replace(/^- /, '').slice(0, 200) });
  }
  out.recent = out.recent.slice(0, 10);
  return out;
}

// ---------- full payload ----------
export async function collectDashboard(projectPath = '.') {
  const [billing, memory, router, privacy] = await Promise.all([
    import('./billing.js').then(m => safe(() => ({ usage: m.usageReport(), plans: m.listPlans() }))),
    import('./memory.js').then(m => safe(() => ({ stats: m.getMemoryStats(), sessions: m.getRecentSessions(8) }))),
    import('./router.js').then(m => safe(() => m.getRoutingStats())),
    import('./privacy.js').then(m => safe(() => ({ mode: m.getPrivacyMode(path.resolve(projectPath)) }))),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    project: path.resolve(projectPath),
    billing: billing || null,
    quality: collectQuality(projectPath),
    knowledge: collectKnowledge(projectPath),
    activity: memory || null,
    routing: router || null,
    privacy: privacy || null,
  };
}
