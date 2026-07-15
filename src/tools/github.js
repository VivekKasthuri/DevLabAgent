// GitHub PR bot — review PRs with DevLab's rubric + baseline tooling and post
// results directly to GitHub. PAT-based (user provides GITHUB_TOKEN); repo
// auto-detected from git remote. Also generates a GitHub Action for CI gating.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { scoreRubric } from './rubric.js';
import { compareBaseline } from './pr.js';
import { addKnowledge } from './knowledge.js';

const API = 'https://api.github.com';
const UA = 'DevLab-PR-Bot/1.0';

function token() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

async function gh(pathname, { method = 'GET', body } = {}) {
  const t = token();
  if (!t) return { error: 'GITHUB_TOKEN not set. Create a fine-grained PAT at https://github.com/settings/tokens (repo scope: pull requests read/write) and add GITHUB_TOKEN=... to .env' };
  try {
    const resp = await fetch(`${API}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await resp.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!resp.ok) return { error: data?.message || `HTTP ${resp.status}`, status: resp.status, details: (data?.errors || []).slice(0, 3) };
    return { ok: true, data };
  } catch (e) {
    return { error: `GitHub API unreachable: ${e.message}` };
  }
}

// Detect owner/repo from the git remote
export function detectRepo(dir = '.') {
  try {
    const url = execSync('git remote get-url origin', { cwd: path.resolve(dir), encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch { /* not a repo or no remote */ }
  return null;
}

function resolveRepo(args, dir) {
  if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
  const detected = detectRepo(dir);
  if (detected) return detected;
  return null;
}

// ---------- PR operations ----------
export async function listPRs({ path: dir = '.', owner, repo, state = 'open' } = {}) {
  const r = resolveRepo({ owner, repo }, dir);
  if (!r) return { error: 'Could not detect owner/repo — pass them explicitly or run inside a GitHub repo clone' };
  const res = await gh(`/repos/${r.owner}/${r.repo}/pulls?state=${state}&per_page=20`);
  if (res.error) return res;
  return {
    repo: `${r.owner}/${r.repo}`,
    count: res.data.length,
    prs: res.data.map(p => ({
      number: p.number, title: p.title, author: p.user?.login,
      base: p.base?.ref, head: p.head?.ref, draft: p.draft,
      url: p.html_url, updated: p.updated_at,
    })),
  };
}

export async function getPR({ path: dir = '.', owner, repo, number } = {}) {
  const r = resolveRepo({ owner, repo }, dir);
  if (!r) return { error: 'Could not detect owner/repo' };
  if (!number) return { error: 'PR number is required' };
  const [pr, files] = await Promise.all([
    gh(`/repos/${r.owner}/${r.repo}/pulls/${number}`),
    gh(`/repos/${r.owner}/${r.repo}/pulls/${number}/files?per_page=100`),
  ]);
  if (pr.error) return pr;
  const p = pr.data;
  return {
    number: p.number, title: p.title, body: (p.body || '').slice(0, 2000),
    author: p.user?.login, state: p.state, draft: p.draft,
    base: p.base?.ref, head: p.head?.ref,
    additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files,
    mergeable: p.mergeable, url: p.html_url,
    files: (files.data || []).map(f => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
  };
}

export async function commentOnPR({ path: dir = '.', owner, repo, number, body } = {}) {
  const r = resolveRepo({ owner, repo }, dir);
  if (!r) return { error: 'Could not detect owner/repo' };
  if (!number || !body) return { error: 'number and body are required' };
  const res = await gh(`/repos/${r.owner}/${r.repo}/issues/${number}/comments`, { method: 'POST', body: { body } });
  if (res.error) return res;
  return { posted: true, url: res.data.html_url };
}

// ---------- the bot: review a PR with rubric + baseline, post scorecard ----------
function scorecardComment({ score, baseline, prInfo }) {
  const emoji = score.verdict === 'pass' ? '✅' : '❌';
  const lines = [
    `## ${emoji} DevLab PR Review — ${score.verdict.toUpperCase()} (${score.weightedScore}/4, passing ≥ ${score.passingScore})`,
    '',
    '| Criterion | Score | Evidence |',
    '|-----------|-------|----------|',
  ];
  for (const b of score.breakdown) {
    const m = b.match(/^([^:]+): (\d)\/4 \(([^)]+)\) — (.*)$/);
    if (m) lines.push(`| ${m[1]} | ${m[2]}/4 (${m[3]}) | ${m[4].slice(0, 120)} |`);
  }
  if (baseline && !baseline.error) {
    lines.push('', `### Baseline: ${baseline.mergeSafe ? '🟢 no regressions' : '🔴 REGRESSIONS FOUND'}`);
    lines.push('', '| Check | Verdict |', '|-------|---------|');
    for (const v of baseline.verdicts || []) lines.push(`| ${v.check} | ${v.verdict} |`);
  }
  if (score.actionItems?.length) {
    lines.push('', '### Action items', '');
    score.actionItems.forEach(a => lines.push(`- [ ] ${a}`));
  }
  lines.push('', `---`, `_Automated review by [DevLab](https://github.com) · rubric + baseline tooling · ${new Date().toISOString().slice(0, 16)}Z_`);
  return lines.join('\n');
}

export async function reviewPR({ path: dir = '.', owner, repo, number, base, post = true, runBaseline = true } = {}) {
  const root = path.resolve(dir);
  const r = resolveRepo({ owner, repo }, dir);

  // PR metadata (optional — works without token for local-only review)
  let prInfo = null;
  if (r && number && token()) {
    prInfo = await getPR({ path: dir, owner: r.owner, repo: r.repo, number });
    if (!prInfo.error && !base) base = prInfo.base;
  }

  // 1. Rubric score against the PR diff (scorecard saved per-PR: scorecard.pr-<n>.json)
  const score = await scoreRubric({ path: root, target: 'pr', base, prNumber: number });
  if (score.error) return score;

  // 2. Baseline comparison (needs a prior capture on the base branch)
  let baseline = null;
  if (runBaseline) {
    baseline = compareBaseline({ path: root });
    if (baseline.error) baseline = { error: baseline.error, note: 'Run pr_baseline action=capture on the base branch first for regression detection' };
  }

  const comment = scorecardComment({ score, baseline, prInfo });

  // Close the feedback loop: failed rubric criteria become KB gotchas so the
  // agent avoids repeating them in future runs on this repo (deduped by KB).
  let kbEntries = 0;
  try {
    for (const item of score.actionItems || []) {
      const res = addKnowledge({
        path: root,
        category: 'gotcha',
        text: `Rubric flagged — ${item}`,
        pr: number ? `#${number}` : undefined,
      });
      if (res.added) kbEntries++;
    }
    if (baseline && !baseline.error && baseline.mergeSafe === false) {
      const res = addKnowledge({
        path: root,
        category: 'gotcha',
        text: `Baseline regression detected: ${(baseline.verdicts || []).filter(v => /fail|regress/i.test(v.verdict)).map(v => v.check).join(', ') || 'see baseline comparison'}`,
        pr: number ? `#${number}` : undefined,
      });
      if (res.added) kbEntries++;
    }
  } catch { /* KB write must never fail a review */ }

  // 3. Post to GitHub
  let posted = null;
  if (post && r && number) {
    posted = await commentOnPR({ path: dir, owner: r.owner, repo: r.repo, number, body: comment });
  }

  return {
    verdict: score.verdict,
    weightedScore: score.weightedScore,
    mergeSafe: baseline && !baseline.error ? baseline.mergeSafe : undefined,
    pr: prInfo && !prInfo.error ? { number: prInfo.number, title: prInfo.title, url: prInfo.url } : undefined,
    posted: posted?.posted ? posted.url : (post ? posted?.error || 'not posted (no repo/number/token)' : 'skipped'),
    kbEntries: kbEntries || undefined,
    comment: posted?.posted ? undefined : comment,
  };
}

// ---------- GitHub Action generator: rubric + baseline as a CI merge gate ----------
export function generateAction({ path: dir = '.', write = true } = {}) {
  const root = path.resolve(dir);
  const yml = `name: DevLab PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  devlab-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install DevLab
        run: npm install -g devlab || npm ci

      - name: Capture baseline on base branch
        run: |
          git checkout \${{ github.event.pull_request.base.sha }}
          npm ci --ignore-scripts || true
          node -e "import('devlab/src/tools/pr.js').then(m => console.log(JSON.stringify(m.captureBaseline({ path: '.', label: 'baseline' }))))" || true
          git checkout \${{ github.event.pull_request.head.sha }}

      - name: Review PR (rubric + baseline)
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          node -e "
          import('devlab/src/tools/github.js').then(async m => {
            const r = await m.reviewPR({ path: '.', number: \${{ github.event.pull_request.number }}, base: 'origin/\${{ github.event.pull_request.base.ref }}' });
            console.log(JSON.stringify(r, null, 2));
            if (r.verdict === 'fail' || r.mergeSafe === false) process.exit(1);
          })"
`;

  const written = [];
  if (write) {
    const wfDir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const fp = path.join(wfDir, 'devlab-review.yml');
    if (fs.existsSync(fp)) return { error: 'devlab-review.yml already exists — delete it first or use write:false to preview', preview: yml };
    fs.writeFileSync(fp, yml);
    written.push(fp);
  }
  return {
    written,
    ...(write ? {} : { yml }),
    note: 'The action captures a baseline on the base branch, scores the PR against the rubric, posts a scorecard comment, and FAILS the check on rubric fail or regression — making DevLab a merge gate.',
  };
}
