// PR Knowledge Base — persistent, per-repo KNOWLEDGE.md that accumulates learnings
// from every PR (patterns, gotchas, decisions, file-area map). Injected into the
// agent's context so agentic code writing gets smarter about a codebase over time.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const KB_DIR = '.devlab/kb';
const KB_FILE = 'KNOWLEDGE.md';
const MAX_INJECT_CHARS = 8000;   // cap what gets injected into agent context
const CATEGORIES = ['pattern', 'gotcha', 'decision', 'convention', 'area'];

function kbPath(dir) { return path.join(path.resolve(dir), KB_DIR, KB_FILE); }

function git(args, cwd) {
  try {
    return execSync(`git --no-pager ${args}`, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function ensureKb(dir) {
  const fp = kbPath(dir);
  if (!fs.existsSync(fp)) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `# Project Knowledge Base

> Accumulated learnings from PRs and agent sessions. Auto-injected into DevLab's
> context when writing code in this repo. Categories: pattern, gotcha, decision,
> convention, area.

## Patterns
<!-- Reusable approaches that work well in this codebase -->

## Gotchas
<!-- Non-obvious traps: things that look right but break -->

## Decisions
<!-- Why things are the way they are (so agents don't "fix" them) -->

## Conventions
<!-- Naming, structure, style specific to this repo -->

## Area Map
<!-- Which directories/files own which functionality -->
`);
  }
  return fp;
}

const SECTION_FOR = { pattern: 'Patterns', gotcha: 'Gotchas', decision: 'Decisions', convention: 'Conventions', area: 'Area Map' };

// ---------- add an entry ----------
export function addKnowledge({ path: dir = '.', category = 'pattern', text, pr, files } = {}) {
  if (!text) return { error: 'text is required' };
  if (!CATEGORIES.includes(category)) return { error: `category must be one of: ${CATEGORIES.join(', ')}` };
  const fp = ensureKb(dir);
  let content = fs.readFileSync(fp, 'utf8');

  // dedupe: skip if a very similar line already exists
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (content.toLowerCase().replace(/\s+/g, ' ').includes(normalized.slice(0, 120))) {
    return { added: false, reason: 'duplicate — similar entry already exists' };
  }

  const date = new Date().toISOString().slice(0, 10);
  const meta = [date, pr ? `PR: ${pr}` : null, files?.length ? `files: ${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''}` : null]
    .filter(Boolean).join(' · ');
  const entry = `- ${text} _(${meta})_`;

  const heading = `## ${SECTION_FOR[category]}`;
  const idx = content.indexOf(heading);
  if (idx === -1) {
    content += `\n${heading}\n${entry}\n`;
  } else {
    // insert after the heading's comment line (or right after heading)
    const afterHeading = content.indexOf('\n', idx) + 1;
    const commentEnd = content.indexOf('-->', afterHeading);
    const nextSection = content.indexOf('\n## ', afterHeading);
    let insertAt = afterHeading;
    if (commentEnd !== -1 && (nextSection === -1 || commentEnd < nextSection)) {
      insertAt = content.indexOf('\n', commentEnd) + 1;
    }
    content = content.slice(0, insertAt) + entry + '\n' + content.slice(insertAt);
  }
  fs.writeFileSync(fp, content);
  return { added: true, category, file: fp };
}

// ---------- harvest knowledge candidates from a PR diff ----------
export function harvestFromPR({ path: dir = '.', base, pr } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };

  const range = base ? `${base}...HEAD` : 'HEAD~1..HEAD';
  let files = git(`diff --name-only ${range}`, root).split('\n').filter(Boolean);
  let commits, diff;
  if (files.length) {
    commits = git(`log --format="%s" ${range}`, root).split('\n').filter(Boolean);
    diff = git(`diff ${range}`, root);
  } else {
    // fallback: first/only commit — use HEAD itself
    files = git('show --name-only --format=""', root).split('\n').filter(Boolean);
    if (!files.length) return { error: 'No diff found — commit changes or pass base ref' };
    commits = [git('log -1 --format="%s"', root)].filter(Boolean);
    diff = git('show --format=""', root);
  }
  const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

  const candidates = [];

  // 1. Area map: which top dirs were touched
  const byArea = {};
  for (const f of files) (byArea[f.includes('/') ? f.split('/')[0] : '(root)'] ||= []).push(f);
  const commitSummary = commits[0] || 'changes';
  for (const [area, fl] of Object.entries(byArea)) {
    if (fl.length >= 2) {
      candidates.push({ category: 'area', text: `\`${area}/\` — involved in "${commitSummary}" (${fl.length} files)`, confidence: 'medium' });
    }
  }

  // 2. Gotchas: revert/fix/workaround commits are learning gold
  for (const c of commits) {
    if (/\b(revert|workaround|hack|hotfix)\b/i.test(c)) {
      candidates.push({ category: 'gotcha', text: `Commit "${c}" suggests a trap here — document the root cause`, confidence: 'high' });
    } else if (/^fix\b|:\s*fix/i.test(c)) {
      candidates.push({ category: 'gotcha', text: `Fixed: "${c}" — if the underlying cause is non-obvious, record it`, confidence: 'medium' });
    }
  }

  // 3. Patterns: new comments in added code often explain reasoning
  const explainers = added
    .map(l => l.replace(/^\+\s*/, ''))
    .filter(l => /^(\/\/|#|\*)\s*(NOTE|IMPORTANT|WHY|CAREFUL|WARNING|N\.B\.)/i.test(l))
    .slice(0, 5);
  for (const e of explainers) {
    candidates.push({ category: 'gotcha', text: e.replace(/^(\/\/|#|\*)\s*/, ''), confidence: 'high' });
  }

  // 4. Conventions: new dependencies added
  const depAdds = added.filter(l => /^\+\s*"(?!version|name|description)[a-z@][^"]*":\s*"[~^]?\d/.test(l)).slice(0, 5);
  for (const d of depAdds) {
    const m = d.match(/"([^"]+)":/);
    if (m) candidates.push({ category: 'decision', text: `Dependency \`${m[1]}\` was added — note why it was chosen`, confidence: 'low' });
  }

  return {
    filesChanged: files.length,
    commits,
    candidates,
    note: 'Review candidates, then call knowledge_base action=add for the ones worth keeping (edit text to capture the real lesson). High-confidence items are usually worth saving.',
  };
}

// ---------- load for injection into agent context ----------
export function loadKnowledge(dir = '.') {
  const fp = kbPath(dir);
  if (!fs.existsSync(fp)) return { found: false, content: '' };
  let text = fs.readFileSync(fp, 'utf8');
  // strip HTML comments (placeholders) to save tokens
  text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
  // drop empty sections
  text = text.replace(/## [^\n]+\n+(?=## |$)/g, '');
  if (text.length > MAX_INJECT_CHARS) {
    text = text.slice(0, MAX_INJECT_CHARS) + '\n…(knowledge base truncated)';
  }
  const entries = (text.match(/^- /gm) || []).length;
  if (!entries) return { found: false, content: '' };
  return { found: true, entries, chars: text.length, content: `\n\n## PROJECT KNOWLEDGE BASE (learnings from past PRs — respect these)\n${text}` };
}

// ---------- show / search ----------
export function showKnowledge({ path: dir = '.', query } = {}) {
  const fp = kbPath(dir);
  if (!fs.existsSync(fp)) return { found: false, hint: 'No knowledge base yet — use action=harvest after a PR, or action=add to record a lesson.' };
  const text = fs.readFileSync(fp, 'utf8');
  if (!query) {
    const entries = (text.match(/^- /gm) || []).length;
    return { found: true, file: fp, entries, content: text.slice(0, 12000) };
  }
  const q = query.toLowerCase();
  const matches = text.split('\n').filter(l => l.startsWith('- ') && l.toLowerCase().includes(q));
  return { found: matches.length > 0, query, matches };
}
