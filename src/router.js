// src/router.js — smart model routing: right model for the task, automatic
// escalation and provider failover. This is how DevLab closes the "model gap"
// vs Claude Code / Cursor: instead of one hardcoded model, every request is
// classified and routed — cheap+fast models for simple work, the strongest
// available model (Claude Sonnet/Opus) for hard reasoning, with automatic
// fallback when a provider errors or rate-limits.
import { chat } from './llm.js';
import { allowPremium } from './billing.js';
import {
  GROQ_API_KEY,
  CLAUDE_API_KEY,
  MODEL_PROVIDER,
  CHEAP_FRONTIER_PROVIDERS,
  CLAUDE_DISABLED,
} from './config.js';
import { getPrivacyMode } from './privacy.js';
import { shouldRefine, refine, shouldSample, sampleBest, shouldCrossVerify, crossVerify } from './quality.js';
import { pickOllamaModel, getInstalledModels } from './ollama-router.js';

// ── Task complexity classification (zero-cost heuristics) ────────────────────
const COMPLEX_SIGNALS = [
  /refactor/i, /architect/i, /design\b/i, /migrat/i, /debug/i, /race condition/i,
  /security/i, /vulnerab/i, /performance/i, /optimi[sz]e/i, /concurren/i,
  /rewrite/i, /from scratch/i, /implement.{0,40}(feature|system|module|api)/i,
  /why (is|does|isn)/i, /root cause/i, /memory leak/i, /deadlock/i,
  /review (this|the|my)/i, /trade-?offs?/i, /algorithm/i,
];

const TRIVIAL_SIGNALS = [
  /^(what|where|which|who|when) /i, /^(list|show|print|display|cat|read) /i,
  /^(rename|typo|format)/i, /^git (status|log|diff)/i, /file exists/i,
  /^(hi|hello|hey|thanks)/i, /^(yes|no|ok|okay)\b/i,
];

export function classifyTask(text = '', { toolResults = 0, priorFailures = 0, contextChars = 0 } = {}) {
  if (priorFailures >= 2) return 'complex'; // struggling → escalate
  const t = String(text);
  let score = 0;

  for (const re of COMPLEX_SIGNALS) if (re.test(t)) score += 2;
  for (const re of TRIVIAL_SIGNALS) if (re.test(t)) score -= 2;

  if (t.length > 800) score += 1;            // long, detailed request
  if (t.length < 60) score -= 1;             // short question
  if (contextChars > 30000) score += 1;      // deep into a long session
  if (toolResults > 8) score += 1;           // many steps already taken
  if (/```/.test(t)) score += 1;             // contains code to reason about
  if ((t.match(/\band\b|\bthen\b|,/gi) || []).length > 6) score += 1; // multi-part

  if (score >= 2) return 'complex';
  if (score <= -2) return 'trivial';
  return 'standard';
}

// ── Provider availability + tier table ───────────────────────────────────────
function hasClaude() { return Boolean(CLAUDE_API_KEY) && !CLAUDE_DISABLED; }
function hasGroq() { return Boolean(GROQ_API_KEY && GROQ_API_KEY !== 'gsk_your_key_here'); }
// First cheap-frontier preset with a key configured (openrouter → together):
// near-Claude quality at ~1/10th cost — slots in above Groq for complex work.
function cheapFrontier() {
  for (const [name, p] of Object.entries(CHEAP_FRONTIER_PROVIDERS)) {
    if (p.apiKey) return name;
  }
  return null;
}

// Tiers: each entry is { provider, model?, fastModel? } tried in order.
// Strongest-available wins for complex; cheapest-capable wins for trivial.
export function buildLadder(tier = 'standard') {
  // Local-only privacy mode: the ladder is Ollama and nothing else. Cloud
  // rungs are removed here so routing never even attempts a cloud call
  // (llm.js also hard-blocks them as a second line of defense).
  // taskText is passed in so we can pick the RIGHT local model for the task.
  if (getPrivacyMode() === 'local-only') {
    return [{ provider: 'ollama' }]; // model resolved dynamically in routeChat
  }
  const claude = hasClaude();
  const groq = hasGroq();
  const frontier = cheapFrontier();
  const ladders = {
    trivial: [
      groq && { provider: 'groq', fastModel: true },
      frontier && { provider: frontier, fastModel: true },
      claude && { provider: 'claude', fastModel: true }, // haiku
      { provider: 'ollama' },
    ],
    standard: [
      groq && { provider: 'groq' },
      frontier && { provider: frontier },
      claude && { provider: 'claude' }, // sonnet
      { provider: 'ollama' },
    ],
    complex: [
      // gpt-oss-120b reasoning rung first: frontier-class ceiling with zero
      // Claude dependency (MIT-licensed, self-hostable). Claude is an optional
      // fallback, never a requirement.
      frontier && { provider: frontier, model: CHEAP_FRONTIER_PROVIDERS[frontier].reasoningModel },
      claude && { provider: 'claude' }, // sonnet — optional fallback
      frontier && { provider: frontier }, // Llama 3.3 70B — chat frontier
      groq && { provider: 'groq' },
      { provider: 'ollama' },
    ],
  };
  return (ladders[tier] || ladders.standard).filter(Boolean);
}

// ── Failure detection: was this response actually useful? ────────────────────
export function looksLikeFailure(resp) {
  if (!resp) return true;
  const content = (resp.content || '').trim();
  const hasTools = resp.toolCalls && resp.toolCalls.length > 0;
  if (!content && !hasTools) return true; // empty response
  if (!hasTools && /^(i can'?t|i'?m unable|i am unable|as an ai)/i.test(content) && content.length < 200) return true;
  return false;
}

// ── Routing stats (visible via getRoutingStats) ──────────────────────────────
const stats = { routed: 0, escalations: 0, failovers: 0, refinements: 0, verifications: 0, verifyEscalations: 0, byTier: { trivial: 0, standard: 0, complex: 0 }, byProvider: {} };
export function getRoutingStats() { return { ...stats, byTier: { ...stats.byTier }, byProvider: { ...stats.byProvider } }; }

// ── Main entry: drop-in replacement for chat() with routing ──────────────────
/**
 * Routes a chat request to the best available model.
 * - If the caller pinned provider/model explicitly, routing is bypassed.
 * - Otherwise: classify → pick ladder → try each rung, failing over on errors.
 * - `escalate: true` forces the complex ladder (used after repeated agent failures).
 */
export async function routeChat({ messages, tools = [], stream = false, provider, model, taskText, escalate = false, fastModel } = {}) {
  // Explicit pin → respect the user's choice, no routing
  if (provider || model) {
    return chat({ messages, tools, stream, provider, model, fastModel });
  }

  const lastUser = taskText
    || [...(messages || [])].reverse().find(m => m.role === 'user')?.content
    || '';
  const contextChars = (messages || []).reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const tier = escalate ? 'complex' : classifyTask(lastUser, { contextChars });

  // ── Smart Ollama model routing (local-only / private server mode) ────────────
  // When running fully on Ollama, pick the best local model for this task
  // before building the ladder. This is transparent to the caller — they still
  // see "devlab-coder" as the model identity.
  let resolvedOllamaModel;
  if (getPrivacyMode() === 'local-only' || MODEL_PROVIDER === 'ollama' || MODEL_PROVIDER === 'openai-compatible') {
    const installed = await getInstalledModels().catch(() => []);
    const pick = pickOllamaModel(lastUser, installed);
    resolvedOllamaModel = pick.model;
  }

  const ladder = buildLadder(tier).map(rung => {
    // Inject the smart local model into ollama rungs
    if (resolvedOllamaModel && (rung.provider === 'ollama' || rung.provider === 'openai-compatible')) {
      return { ...rung, model: resolvedOllamaModel };
    }
    return rung;
  }).filter(rung => {
    // Quota gate: skip premium rungs when the plan's premium quota is hard-blocked
    if (rung.provider === 'claude') {
      try { return allowPremium().allowed !== false; } catch { return true; }
    }
    return true;
  });
  stats.routed++;
  stats.byTier[tier]++;
  if (escalate) stats.escalations++;

  let lastErr;
  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    try {
      const rungChat = (o = {}) => chat({ messages, tools, stream, provider: rung.provider, model: rung.model, fastModel: rung.fastModel, ...o });
      // Best-of-N: on complex tasks with free local inference, sample N
      // candidates and self-select the best (DEVLAB_BEST_OF > 1).
      const resp = shouldSample({ provider: rung.provider, tier })
        ? await sampleBest({ messages, chatFn: (o) => rungChat(o) })
        : await rungChat();
      if (looksLikeFailure(resp) && i < ladder.length - 1) {
        stats.failovers++;
        continue; // weak/empty answer → try next rung
      }
      stats.byProvider[rung.provider] = (stats.byProvider[rung.provider] || 0) + 1;

      // Quality booster: local inference is free, so weak-model final answers
      // get a self-refine pass (critique → revise with the same model).
      let out = resp;
      if (shouldRefine({ provider: rung.provider, tier, content: resp.content, toolCalls: resp.toolCalls })) {
        try {
          const refined = await refine({
            task: lastUser,
            content: resp.content,
            chatFn: (o) => chat({ ...o, provider: rung.provider, model: rung.model, fastModel: rung.fastModel }),
          });
          if (refined.improved) {
            stats.refinements++;
            out = { ...resp, content: refined.content, refined: refined.rounds };
          }
        } catch { /* refinement is best-effort — never degrade the answer */ }
      }

      // Cross-model verification: a LOCAL answer to a complex task gets checked
      // by the strongest cloud rung (never active in local-only privacy mode —
      // buildLadder strips cloud rungs there). If the verifier finds critical
      // defects, re-run the task on that stronger rung. Frontier-checked
      // quality at ~10% of frontier cost.
      if (shouldCrossVerify({ provider: rung.provider, tier, content: out.content, toolCalls: out.toolCalls })) {
        const stronger = ladder.find((r) => r.provider !== 'ollama' && r.provider !== 'openai-compatible' && r.provider !== rung.provider);
        if (stronger) {
          stats.verifications++;
          const check = await crossVerify({
            task: lastUser,
            content: out.content,
            verifyFn: (o) => chat({ messages: o.messages, tools: [], provider: stronger.provider, model: stronger.model, fastModel: true }),
          });
          if (!check.passed) {
            try {
              const better = await chat({ messages, tools, stream, provider: stronger.provider, model: stronger.model });
              if (!looksLikeFailure(better)) {
                stats.verifyEscalations++;
                stats.byProvider[stronger.provider] = (stats.byProvider[stronger.provider] || 0) + 1;
                return { ...better, routedTier: tier, routedProvider: stronger.provider, verifiedBy: stronger.provider, verifierDefects: check.defects };
              }
            } catch { /* stronger rung failed — keep the local answer */ }
          }
        }
      }
      return { ...out, routedTier: tier, routedProvider: rung.provider };
    } catch (err) {
      lastErr = err;
      if (i < ladder.length - 1) {
        stats.failovers++;
        continue; // provider down / rate-limited / proxy-blocked → next rung
      }
    }
  }
  throw lastErr || new Error('All providers in the routing ladder failed');
}

// ── Subagent role → tier mapping ─────────────────────────────────────────────
// explorer/tester do mechanical work (fast models fine); coder/reviewer need
// the strongest reasoning available.
export const ROLE_TIERS = {
  explorer: 'trivial',
  tester: 'standard',
  coder: 'complex',
  reviewer: 'complex',
  general: 'standard',
};

export function roleTier(role) {
  return ROLE_TIERS[role] || 'standard';
}
