// src/quality.js — self-refine loop that closes the local-model quality gap.
// Weak/local models improve dramatically when forced to critique their own
// draft and revise it (Self-Refine). Cloud frontier models rarely need this,
// and extra cloud passes cost real money — so refinement is applied where
// inference is FREE: local providers (Ollama/vLLM). Draft → critique →
// revise, with an early exit when the critique finds nothing material.
//
// Env: DEVLAB_QUALITY=off disables; DEVLAB_QUALITY_ROUNDS caps rounds (default 1).

const CODE_HINTS = /```|function |class |def |import |const |public |private |fn |=>|#include/;

export function qualityEnabled() {
  return String(process.env.DEVLAB_QUALITY || 'on').toLowerCase() !== 'off';
}

export function maxRefineRounds() {
  const n = parseInt(process.env.DEVLAB_QUALITY_ROUNDS || '1', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 3) : 1;
}

/**
 * Should this response get a refinement pass?
 * - only when enabled
 * - only for local providers (free inference — extra passes cost nothing)
 * - only for final answers containing code (tool-call turns are iterative already)
 * - never for trivial tier (waste of tokens on "list files" answers)
 */
export function shouldRefine({ provider, tier, content, toolCalls } = {}) {
  if (!qualityEnabled() || maxRefineRounds() === 0) return false;
  if (provider !== 'ollama' && provider !== 'openai-compatible' && provider !== 'local') return false;
  if (tier === 'trivial') return false;
  if (toolCalls && toolCalls.length > 0) return false; // mid-loop turn, verified by tools
  const text = String(content || '');
  if (text.length < 200) return false;
  return CODE_HINTS.test(text);
}

const CRITIQUE_SYSTEM = `You are a strict senior code reviewer. Review the draft answer below for the given task.
List ONLY material defects: bugs, wrong logic, missed requirements, broken syntax, security issues, missing error handling the task requires.
Ignore style and formatting. Be terse — one line per defect.
If there are no material defects, reply with exactly: LGTM`;

const REVISE_SYSTEM = `You are revising your own draft answer. Fix every defect listed in the critique.
Keep everything that was already correct. Return the complete corrected answer — not a diff, not commentary about the changes.`;

/** Does a critique say the draft is fine? */
export function critiquePasses(critique) {
  const t = String(critique || '').trim();
  if (!t) return true;
  if (/^lgtm\b/i.test(t)) return true;
  if (/no (material )?(defects|issues|problems)/i.test(t) && t.length < 120) return true;
  return false;
}

/**
 * Best-of-N sampling: generate N candidate answers (free on local models),
 * then have the same model pick the best one. Raises effective quality on
 * complex tasks — a weak model's best-of-3 approaches a stronger model's
 * single shot. Only worth it for complex tier on free/local inference.
 * Env: DEVLAB_BEST_OF (default 1 = off; max 5).
 */
export function bestOfN() {
  const n = parseInt(process.env.DEVLAB_BEST_OF || '1', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 5) : 1;
}

export function shouldSample({ provider, tier } = {}) {
  if (!qualityEnabled() || bestOfN() <= 1) return false;
  if (provider !== 'ollama' && provider !== 'openai-compatible' && provider !== 'local') return false;
  return tier === 'complex';
}

const JUDGE_SYSTEM = `You are judging candidate answers to the same task. Pick the single best one: correct logic, complete, compilable, handles edge cases.
Reply with ONLY the number of the best candidate (e.g. "2"). No explanation.`;

/**
 * Generate N candidates and self-select the best.
 * @param {object} opts
 * @param {Array}  opts.messages  full chat context
 * @param {Function} opts.chatFn  async ({ messages }) => ({ content, toolCalls, ... })
 * @param {number} [opts.n]
 * @returns first response object, with .content swapped for the winning candidate
 */
export async function sampleBest({ messages, chatFn, n = bestOfN() } = {}) {
  const candidates = [];
  let first = null;
  for (let i = 0; i < n; i++) {
    try {
      const resp = await chatFn({ messages });
      if (!first) first = resp;
      // Tool-call responses can't be judged as text — return immediately
      if (resp.toolCalls && resp.toolCalls.length > 0) return resp;
      if (resp.content) candidates.push(resp.content);
    } catch {
      if (first) break; // keep what we have
    }
  }
  if (!first) throw new Error('best-of-N sampling: all candidates failed');
  if (candidates.length <= 1) return first;

  try {
    const list = candidates.map((c, i) => `--- CANDIDATE ${i + 1} ---\n${c.slice(0, 8000)}`).join('\n\n');
    const judged = await chatFn({
      tools: [], // judging is text-only
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: `TASK:\n${String(messages?.at(-1)?.content || '').slice(0, 3000)}\n\n${list}` },
      ],
    });
    const pick = parseInt(String(judged?.content || '').match(/\d+/)?.[0] || '1', 10);
    const winner = candidates[pick - 1] || candidates[0];
    return { ...first, content: winner, sampledFrom: candidates.length };
  } catch {
    return first; // judging failed → first candidate
  }
}

/**
 * Self-refine loop: critique the draft with the same (free, local) model,
 * revise if defects were found. `chatFn` is injected so this stays
 * provider-agnostic and offline-testable.
 *
 * @param {object} opts
 * @param {string} opts.task      original user task
 * @param {string} opts.content   draft answer
 * @param {Function} opts.chatFn  async ({ messages }) => ({ content })
 * @param {number} [opts.rounds]  max critique/revise rounds
 * @returns {{ content, rounds, critiques, improved }}
 */
export async function refine({ task, content, chatFn, rounds = maxRefineRounds() } = {}) {
  let current = String(content || '');
  const critiques = [];
  let done = 0;

  for (let i = 0; i < rounds; i++) {
    let critique;
    try {
      const c = await chatFn({
        messages: [
          { role: 'system', content: CRITIQUE_SYSTEM },
          { role: 'user', content: `TASK:\n${String(task || '').slice(0, 4000)}\n\nDRAFT ANSWER:\n${current.slice(0, 16000)}` },
        ],
      });
      critique = (c?.content || '').trim();
    } catch {
      break; // critique failed → keep current draft, never degrade
    }

    if (critiquePasses(critique)) break;
    critiques.push(critique);

    try {
      const r = await chatFn({
        messages: [
          { role: 'system', content: REVISE_SYSTEM },
          { role: 'user', content: `TASK:\n${String(task || '').slice(0, 4000)}\n\nYOUR DRAFT:\n${current.slice(0, 16000)}\n\nCRITIQUE (fix all of these):\n${critique.slice(0, 4000)}` },
        ],
      });
      const revised = (r?.content || '').trim();
      // Guard: a revision that lost most of the answer is a regression — keep draft
      if (revised.length >= current.length * 0.5) {
        current = revised;
        done++;
      } else {
        break;
      }
    } catch {
      break; // revision failed → keep last good draft
    }
  }

  return { content: current, rounds: done, critiques, improved: done > 0 };
}

// ── Cross-model verification ──────────────────────────────────────────────────
// Closes the raw-model-quality gap: when a LOCAL model produced a complex-tier
// answer, a stronger (cloud) model verifies it for a few cents. If the verifier
// finds critical defects, the router re-runs the task on the stronger model.
// This gives "frontier-checked" answers while still doing 90%+ of inference
// free/locally. Skipped entirely in local-only privacy mode.
// Env: DEVLAB_CROSS_VERIFY=off disables (default: on when a stronger rung exists).

export function crossVerifyEnabled() {
  return String(process.env.DEVLAB_CROSS_VERIFY || 'on').toLowerCase() !== 'off';
}

export function shouldCrossVerify({ provider, tier, content, toolCalls } = {}) {
  if (!qualityEnabled() || !crossVerifyEnabled()) return false;
  if (tier !== 'complex') return false; // only worth cloud cents on hard tasks
  if (provider !== 'ollama' && provider !== 'openai-compatible' && provider !== 'local') return false;
  if (toolCalls && toolCalls.length > 0) return false;
  const text = String(content || '');
  return text.length >= 200 && CODE_HINTS.test(text);
}

const VERIFY_SYSTEM = `You are verifying an answer produced by another model. Check it against the task for CRITICAL defects only:
wrong logic, bugs, security vulnerabilities, code that will not run, missed core requirements.
If the answer is acceptable, reply exactly: PASS
Otherwise reply: FAIL: <one line per critical defect>`;

/**
 * Verify a local answer with a stronger model. Returns { verdict, passed, defects }.
 * `verifyFn` should route to the stronger provider — injected for testability.
 */
export async function crossVerify({ task, content, verifyFn } = {}) {
  try {
    const v = await verifyFn({
      tools: [],
      messages: [
        { role: 'system', content: VERIFY_SYSTEM },
        { role: 'user', content: `TASK:\n${String(task || '').slice(0, 4000)}\n\nANSWER TO VERIFY:\n${String(content || '').slice(0, 16000)}` },
      ],
    });
    const verdict = String(v?.content || '').trim();
    const passed = /^pass\b/i.test(verdict) || verdict === '';
    return { verdict, passed, defects: passed ? '' : verdict.replace(/^fail:?\s*/i, '') };
  } catch {
    return { verdict: '', passed: true, defects: '' }; // verifier unavailable → accept
  }
}
