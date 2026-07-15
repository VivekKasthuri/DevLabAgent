// src/privacy.js — enforceable "your code never touches the cloud" mode.
// When privacy mode is `local-only`, every cloud provider (Groq, Claude, any
// non-localhost OpenAI-compatible endpoint) is HARD-BLOCKED at the single
// choke point all requests flow through (llm.js chat()). This is not a
// preference — it is a guarantee: no prompt, file, or diff can leave the
// machine while the mode is active.
//
// Precedence (highest wins):
//   1. DEVLAB_PRIVACY env var        — process-wide override
//   2. .devlab/privacy.json in repo  — per-repo, committed, team-enforced
//   3. default: 'open'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { OPENAI_COMPAT_BASE_URL } from './config.js';

export const MODES = ['open', 'local-only'];

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:\d+)?(\/|$)/i;

// Small TTL cache so chat() can call this on every request cheaply.
const cache = new Map(); // cwd -> { mode, at }
const CACHE_TTL_MS = 3000;

function privacyFile(cwd) {
  return join(cwd, '.devlab', 'privacy.json');
}

/** Returns 'local-only' or 'open'. */
export function getPrivacyMode(cwd = process.cwd()) {
  const env = String(process.env.DEVLAB_PRIVACY || '').trim().toLowerCase();
  if (env === 'local-only' || env === 'local' || env === 'strict') return 'local-only';
  if (env === 'open') return 'open';

  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.mode;

  let mode = 'open';
  try {
    const file = privacyFile(cwd);
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (String(parsed.mode).toLowerCase() === 'local-only') mode = 'local-only';
    }
  } catch { /* unreadable file → open */ }

  cache.set(cwd, { mode, at: Date.now() });
  return mode;
}

/** Persist privacy mode for a repo (writes .devlab/privacy.json). */
export function setPrivacyMode(mode, cwd = process.cwd()) {
  const normalized = String(mode || '').trim().toLowerCase() === 'local-only' ? 'local-only' : 'open';
  const dir = join(cwd, '.devlab');
  mkdirSync(dir, { recursive: true });
  writeFileSync(privacyFile(cwd), JSON.stringify({
    mode: normalized,
    note: normalized === 'local-only'
      ? 'Cloud LLM providers are hard-blocked for this repo. All inference runs locally (Ollama/vLLM).'
      : 'Cloud providers allowed. Set mode to "local-only" to guarantee code never leaves this machine.',
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  cache.delete(cwd);
  return { mode: normalized, file: privacyFile(cwd) };
}

/** Is this effective provider guaranteed local? */
export function isLocalProvider(effectiveProvider, baseUrl = OPENAI_COMPAT_BASE_URL) {
  if (effectiveProvider === 'openai-compatible') {
    return LOCALHOST_RE.test(String(baseUrl || ''));
  }
  return false; // groq, claude, copilot, anything else → cloud
}

export class PrivacyError extends Error {
  constructor(provider) {
    super(
      `Privacy mode is local-only: refusing to send code to cloud provider "${provider}". ` +
      `All inference must run locally (Ollama/vLLM on localhost). ` +
      `To allow cloud models, run set_privacy mode=open or delete .devlab/privacy.json.`
    );
    this.name = 'PrivacyError';
    this.code = 'PRIVACY_LOCAL_ONLY';
  }
}

/**
 * Throws PrivacyError if local-only mode is active and the provider is cloud.
 * Called from llm.js chat() — the single choke point for every LLM request.
 */
export function assertProviderAllowed(effectiveProvider, { cwd = process.cwd(), baseUrl } = {}) {
  if (getPrivacyMode(cwd) !== 'local-only') return;
  if (!isLocalProvider(effectiveProvider, baseUrl)) {
    throw new PrivacyError(effectiveProvider);
  }
}
