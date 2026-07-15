// Inline (tab-complete) code completion engine — Cursor-style FIM completions.
// Powers the VS Code extension (vscode-extension/) via POST /api/complete on
// the UI server, and is usable standalone. Uses the fast model tier + the
// semantic index for cross-file context.
import { chat } from './llm.js';

const MAX_PREFIX = 3000;   // chars of code before cursor sent to the model
const MAX_SUFFIX = 1200;   // chars after cursor
const MAX_CONTEXT = 1500;  // chars of semantic-index context

// ── Prompt construction ──────────────────────────────────────────────────────
export function buildCompletionPrompt({ prefix = '', suffix = '', language = '', filename = '', context = '' }) {
  const p = prefix.slice(-MAX_PREFIX);
  const s = suffix.slice(0, MAX_SUFFIX);
  const ctx = context.slice(0, MAX_CONTEXT);

  const system = [
    'You are an inline code completion engine. Output ONLY the code that should be inserted at the cursor position <CURSOR>.',
    'Rules:',
    '- Output raw code only. No markdown fences, no explanations, no comments about what you did.',
    '- Complete the current statement/block naturally. Stop at a logical boundary (end of statement, block, or function).',
    '- Never repeat code that already appears before or after the cursor.',
    '- If nothing sensible can be inserted, output nothing.',
    '- Match the exact indentation style and conventions of the surrounding code.',
  ].join('\n');

  const user = [
    filename ? `File: ${filename}` : '',
    language ? `Language: ${language}` : '',
    ctx ? `Relevant code from elsewhere in the project:\n${ctx}\n` : '',
    'Complete the code at <CURSOR>:',
    '```',
    `${p}<CURSOR>${s}`,
    '```',
  ].filter(Boolean).join('\n');

  return { system, user };
}

// ── Output post-processing ───────────────────────────────────────────────────
export function cleanCompletion(raw, { prefix = '', suffix = '' } = {}) {
  if (!raw) return '';
  let text = raw;

  // Strip markdown fences if the model added them anyway
  const fence = text.match(/^```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  if (fence) text = fence[1];
  text = text.replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');

  // Remove <CURSOR> echoes
  text = text.replace(/<CURSOR>/g, '');

  // Drop repetition: if the model re-emitted the current line, cut it
  const lastLine = prefix.split('\n').pop() || '';
  if (lastLine.trim() && text.startsWith(lastLine)) text = text.slice(lastLine.length);

  // Trim overlap with suffix: if completion ends with the start of the suffix, cut it
  const sufHead = suffix.slice(0, 100).trimStart();
  if (sufHead) {
    for (let n = Math.min(sufHead.length, text.length); n >= 4; n--) {
      if (text.endsWith(sufHead.slice(0, n))) { text = text.slice(0, -n); break; }
    }
  }

  // Cap at 30 lines — inline completions should be short
  const lines = text.split('\n');
  if (lines.length > 30) text = lines.slice(0, 30).join('\n');

  return text.replace(/\s+$/, (m) => (m.includes('\n') ? '' : m)); // keep trailing space, drop trailing newlines
}

// ── Semantic-index context lookup (best-effort, never blocks completion) ─────
async function fetchContext(projectPath, queryText) {
  try {
    const { searchIndex } = await import('./tools/semindex.js');
    const res = await Promise.race([
      searchIndex({ path: projectPath, query: queryText, maxResults: 2, buildIfMissing: false }),
      new Promise((r) => setTimeout(() => r(null), 800)),
    ]);
    if (!res?.results?.length) return '';
    return res.results
      .map((h) => `// ${h.file}:${h.lines || ''}\n${(h.preview || '').slice(0, 600)}`)
      .join('\n\n');
  } catch { return ''; }
}

// ── Main entry ───────────────────────────────────────────────────────────────
export async function getInlineCompletion({
  prefix = '', suffix = '', language = '', filename = '',
  projectPath = '.', provider, model, useIndex = true,
} = {}) {
  if (!prefix.trim()) return { completion: '' };

  // Use the current line + last identifiers as the semantic query
  let context = '';
  if (useIndex) {
    const lastLines = prefix.split('\n').slice(-5).join(' ');
    const query = lastLines.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(-10).join(' ');
    if (query) context = await fetchContext(projectPath, query);
  }

  const { system, user } = buildCompletionPrompt({ prefix, suffix, language, filename, context });

  const started = Date.now();
  const resp = await chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    provider,
    model,
    fastModel: true, // low-latency tier — tab-complete must be fast
  });

  const completion = cleanCompletion(resp.content, { prefix, suffix });
  return {
    completion,
    model: resp.model,
    provider: resp.effectiveProvider,
    latencyMs: Date.now() - started,
    usedContext: Boolean(context),
  };
}
