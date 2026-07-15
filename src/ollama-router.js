// src/ollama-router.js
// ─────────────────────────────────────────────────────────────────────────────
// Smart local model router for DevLab.
// When running fully on Ollama (Oracle Cloud / private server), DevLab has
// multiple models available. This module picks the RIGHT model for each task
// so clients see a single "devlab-coder" identity while getting optimal quality.
//
// Default routing strategy:
//   codellama:13b  → code writing, bug fixes, Swift/Kotlin/Flutter/RN/JS tasks
//   mistral:7b     → code review, explanations, security analysis
//   llama3.2:3b    → fast chat, simple questions, git commands, trivial tasks
//
// Override via env:
//   DEVLAB_CODE_MODEL=codellama:13b
//   DEVLAB_REVIEW_MODEL=mistral:7b
//   DEVLAB_FAST_MODEL=llama3.2:3b
// ─────────────────────────────────────────────────────────────────────────────

import { OPENAI_COMPAT_MODEL } from './config.js';

// ── Model assignments (override via env) ─────────────────────────────────────
export const CODE_MODEL   = process.env.DEVLAB_CODE_MODEL   || process.env.OLLAMA_CODE_MODEL   || OPENAI_COMPAT_MODEL || 'codellama:13b';
export const REVIEW_MODEL = process.env.DEVLAB_REVIEW_MODEL || process.env.OLLAMA_REVIEW_MODEL || 'mistral:7b';
export const FAST_MODEL   = process.env.DEVLAB_FAST_MODEL   || process.env.OLLAMA_FAST_MODEL   || 'llama3.2:3b';

// ── Task type classification signals ─────────────────────────────────────────

// Code generation / fixing — route to CODE_MODEL
const CODE_SIGNALS = [
  /\b(fix|write|create|implement|add|build|generate|scaffold|refactor|rewrite|migrate)\b/i,
  /\b(function|class|method|component|view|controller|service|repository|model)\b/i,
  /\b(swift|kotlin|flutter|dart|react native|swiftui|jetpack compose|coroutine)\b/i,
  /\b(bug|error|crash|exception|nil|null|undefined|not compiling|doesn.t work)\b/i,
  /\b(test|unit test|write test|add test|spec)\b/i,
  /\b(api|endpoint|route|handler|middleware|schema)\b/i,
  /```[\s\S]{10}/,    // contains a code block
  /\.(swift|kt|dart|tsx?|jsx?|py|go|rs|java|cpp)\b/i,
];

// Review / explain / analyse — route to REVIEW_MODEL
const REVIEW_SIGNALS = [
  /\b(review|analyse|analyze|audit|explain|describe|understand|what does|why does)\b/i,
  /\b(security|vulnerabilit|injection|xss|csrf|race condition|memory leak|performance)\b/i,
  /\b(best practice|anti.?pattern|code smell|lint|quality|coverage|trade.?off)\b/i,
  /\b(documentation|comment|readme|changelog|pr description)\b/i,
  /\b(compare|difference|pros and cons|versus|vs\b)\b/i,
  /\b(dependency inject|DI\b|IoC|inversion of control|architecture|layer|coupling|cohesion)\b/i,
  /\b(analyze.*(DI|dependency|architecture|layer)|DI.*(analyze|check|review|audit))\b/i,
];

// Fast / trivial — route to FAST_MODEL
const FAST_SIGNALS = [
  /^(hi|hello|hey|thanks|ok|yes|no|sure)\b/i,
  /^(what|where|who|when|which) (is|are|was|were) /i,
  /^(list|show|print|cat|read|display) /i,
  /^(git |npm |yarn |pod |gradle )/i,
  /\b(rename|typo|spelling|format)\b/i,
  /^.{1,50}$/, // very short input (<50 chars)
];

/**
 * Classify the task type from the user message.
 * Returns 'code' | 'review' | 'fast'
 */
export function classifyOllamaTask(text = '') {
  const t = String(text).trim();

  // Fast signals win for very short/trivial messages
  let fastScore = 0;
  for (const re of FAST_SIGNALS) if (re.test(t)) fastScore++;
  if (fastScore >= 2) return 'fast';

  let reviewScore = 0;
  let codeScore   = 0;
  for (const re of REVIEW_SIGNALS) if (re.test(t)) reviewScore++;
  for (const re of CODE_SIGNALS)   if (re.test(t)) codeScore++;

  if (reviewScore > codeScore) return 'review';
  if (codeScore   > 0)         return 'code';
  if (reviewScore > 0)         return 'review';
  if (fastScore   > 0)         return 'fast';

  return 'code'; // default: assume code task
}

/**
 * Pick the best Ollama model for this task.
 * Falls back to CODE_MODEL if the preferred model is not installed.
 *
 * @param {string} taskText - The user's message
 * @param {string[]} [installedModels] - Names of models available on the server
 * @returns {{ model: string, taskType: string, reason: string }}
 */
export function pickOllamaModel(taskText = '', installedModels = []) {
  const taskType = classifyOllamaTask(taskText);

  const preferred = {
    code:   CODE_MODEL,
    review: REVIEW_MODEL,
    fast:   FAST_MODEL,
  }[taskType];

  const reasons = {
    code:   'code generation / fix task',
    review: 'code review / explanation task',
    fast:   'fast / trivial task',
  };

  // If we know what's installed, fall back gracefully
  if (installedModels.length > 0) {
    if (installedModels.includes(preferred)) {
      return { model: preferred, taskType, reason: reasons[taskType] };
    }
    // Fallback order: preferred → CODE_MODEL → first available
    const fallbacks = [preferred, CODE_MODEL, installedModels[0]];
    const available = fallbacks.find(m => installedModels.includes(m));
    return {
      model:    available || CODE_MODEL,
      taskType,
      reason:   `${reasons[taskType]} (preferred ${preferred} not installed, using ${available || CODE_MODEL})`,
    };
  }

  // No install info — trust the preferred pick
  return { model: preferred, taskType, reason: reasons[taskType] };
}

/**
 * Fetch installed model names from Ollama.
 * Returns [] if Ollama is unreachable.
 * @param {string} [baseUrl]
 */
export async function getInstalledModels(baseUrl) {
  const { OPENAI_COMPAT_BASE_URL } = await import('./config.js');
  const base = (baseUrl || OPENAI_COMPAT_BASE_URL).replace(/\/v1\/?$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Returns the routing table as a human-readable string.
 * Used by `devlab models` and the web UI.
 */
export function describeRouting() {
  return [
    { task: 'Code fix / write / implement', model: CODE_MODEL,   examples: 'fix my Swift crash, write Kotlin API' },
    { task: 'Code review / explain / audit / DI', model: REVIEW_MODEL, examples: 'review this PR, analyze DI architecture, explain the bug' },
    { task: 'Fast chat / trivial / git',     model: FAST_MODEL,   examples: 'git status, list files, hello' },
  ];
}
