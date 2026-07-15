// src/context.js — token/cost optimization: dynamic tool pruning + history
// compression. The two biggest token sinks in an agent loop are (1) sending
// all 80 tool schemas (~10K tokens) with EVERY request, and (2) old tool
// results riding along full-size forever. This module fixes both.

// ── 1. Dynamic tool pruning ──────────────────────────────────────────────────
// Core tools are always available; the rest are included only when the task
// text (or recent conversation) suggests they're relevant. Cuts ~10K → ~2-4K
// tokens per call for typical tasks.

const CORE_TOOLS = new Set([
  'read_file', 'write_file', 'apply_fix', 'list_files', 'search_files',
  'run_command', 'git_status', 'git_diff', 'build_project', 'delegate_task',
]);

// keyword → tool-name groups
const TOOL_GROUPS = [
  { match: /\bgit\b|commit|branch|merge|push|pull|stash|log\b/i, tools: /^git_/ },
  { match: /docker|container|image|compose|sandbox/i, tools: /docker|sandbox/ },
  { match: /\bpr\b|pull request|review|baseline|github|merge gate/i, tools: /^(pr_|github_|review)/ },
  { match: /rubric|score|grade|requirement|criteria/i, tools: /rubric/ },
  { match: /knowledge|learn|gotcha|convention|harvest/i, tools: /knowledge/ },
  { match: /jira|confluence|ticket|issue|sprint|atlassian/i, tools: /jira|confluence/ },
  { match: /diagram|chart|architecture|visuali|flowchart|mermaid/i, tools: /diagram/ },
  { match: /voice|speak|audio|transcri/i, tools: /voice|speak|transcribe/ },
  { match: /mobile|ios|android|swift|kotlin|flutter|react native|simulator|emulator|xcode/i, tools: /mobile|simulator|ios|android|flutter|xcode|device/ },
  { match: /security|vulnerab|secret|scan|cve|audit/i, tools: /security|scan|audit/ },
  { match: /test|spec|coverage|vitest|jest|junit/i, tools: /test/ },
  { match: /semantic|search.*concept|find.*code|where is|locate/i, tools: /semantic|index/ },
  { match: /endpoint|route|race|conflict|concurren/i, tools: /conflict|race|endpoint/ },
  { match: /memory|remember|recall|forget/i, tools: /memor|remember|recall/ },
  { match: /web|fetch|url|http|download|scrape/i, tools: /web|fetch|url/ },
  { match: /ci\b|pipeline|workflow|action|jenkins/i, tools: /^ci|pipeline|workflow/ },
  { match: /scaffold|boilerplate|new (service|endpoint|project)|create.*app/i, tools: /scaffold|create_project/ },
  { match: /fix|error|bug|debug|issue|crash|fail/i, tools: /fix|advisor|analy[sz]e|diagnos/ },
  { match: /mcp\b|model context protocol/i, tools: /mcp/ },
  { match: /dependen|inject|spring|bean/i, tools: /^di_|depend/ },
];

/**
 * Select the subset of tool definitions relevant to a task.
 * Falls back to ALL tools when the task is vague or explicitly broad.
 */
export function selectTools(taskText = '', allTools = [], { minTools = 12, disable = false } = {}) {
  if (disable || !taskText || allTools.length <= minTools) return allTools;
  const text = String(taskText);

  // Broad/ambiguous asks → don't prune (agent may need anything)
  if (/everything|all tools|full|whatever|help me|not sure/i.test(text) && text.length < 100) return allTools;

  const wanted = new Set(CORE_TOOLS);
  for (const g of TOOL_GROUPS) {
    if (g.match.test(text)) {
      for (const t of allTools) if (g.tools.test(t.function.name)) wanted.add(t.function.name);
    }
  }

  const selected = allTools.filter(t => wanted.has(t.function.name));
  // Too few matched → task didn't map cleanly; be safe and send everything
  if (selected.length < Math.min(minTools, allTools.length)) return allTools;
  return selected;
}

// ── 2. History compression ───────────────────────────────────────────────────
// Tool results older than the last `keepRecent` assistant turns get squashed
// to a short digest — the agent already acted on them; full payloads are dead
// weight. Typical saving: 50-80% of history tokens in long sessions.

const DIGEST_LEN = 200;

export function compressHistory(messages = [], { keepRecent = 6 } = {}) {
  if (messages.length <= keepRecent) return messages;

  const cutoff = messages.length - keepRecent;
  let saved = 0;
  const out = messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > DIGEST_LEN + 60) {
      saved += m.content.length - DIGEST_LEN;
      return { ...m, content: `${m.content.slice(0, DIGEST_LEN)}…[compressed: ${m.content.length} chars — re-run the tool if you need this again]` };
    }
    return m;
  });
  out._tokensSaved = Math.round(saved / 4);
  return out;
}

// ── 3. Duplicate tool-result deduplication ───────────────────────────────────
// The agent sometimes re-reads the same file; identical old results become a
// one-line pointer instead of a second full copy.
export function dedupeToolResults(messages = []) {
  const seen = new Map(); // content hash → first index
  return messages.map((m, i) => {
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length < 400) return m;
    const key = m.content;
    if (seen.has(key)) {
      return { ...m, content: `[identical to an earlier tool result — content unchanged]` };
    }
    seen.set(key, i);
    return m;
  });
}

// ── Stats ────────────────────────────────────────────────────────────────────
export function estimateTokens(messages = [], tools = []) {
  const msgChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
  const toolChars = JSON.stringify(tools).length;
  return { messages: Math.round(msgChars / 4), tools: Math.round(toolChars / 4), total: Math.round((msgChars + toolChars) / 4) };
}
