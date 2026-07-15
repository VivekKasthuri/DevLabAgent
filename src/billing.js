// src/billing.js — subscription plans + usage metering for DevLab.
// Makes DevLab sellable like Cursor/Copilot: plans with quotas, per-request
// usage metering (tokens, sessions, premium-model calls), local ledger,
// quota enforcement hooks, and usage reports. Storage is a JSON ledger in
// ~/.codeagent/billing.json (no external service required; a payment
// provider like Stripe can be layered on top via the license key field).
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

const BILLING_DIR = path.join(homedir(), '.codeagent');
function billingFile() {
  return process.env.DEVLAB_BILLING_FILE || path.join(BILLING_DIR, 'billing.json');
}

// ── Plans ────────────────────────────────────────────────────────────────────
// premiumRequests = calls routed to premium models (Claude Sonnet/Opus tier).
// fastRequests    = Groq/local calls (cheap or free to serve).
export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    period: 'month',
    quotas: { premiumRequests: 50, fastRequests: 2000, subagentRuns: 20, tokensPerMonth: 2_000_000 },
    features: ['All 80 tools', 'Ollama unlimited', 'Community support'],
  },
  starter: {
    name: 'Starter',
    price: 8, // undercuts Copilot's $10 floor
    period: 'month',
    quotas: { premiumRequests: 400, fastRequests: 15_000, subagentRuns: 100, tokensPerMonth: 15_000_000 },
    features: ['Everything in Free', 'Cheap-frontier routing (gpt-oss / Llama)', 'IDE API (OpenAI-compatible)', 'Email support'],
  },
  pro: {
    name: 'Pro',
    price: 15,
    period: 'month',
    quotas: { premiumRequests: 1500, fastRequests: 50_000, subagentRuns: 500, tokensPerMonth: 50_000_000 },
    features: ['Everything in Free', 'Priority routing', 'PR bot + CI gate', 'Email support'],
  },
  team: {
    name: 'Team',
    price: 25,
    period: 'month (per seat)',
    quotas: { premiumRequests: 4000, fastRequests: 200_000, subagentRuns: 2000, tokensPerMonth: 150_000_000 },
    features: ['Everything in Pro', 'Shared knowledge base', 'Shared rubrics', 'Usage dashboard', 'SSO-ready license keys'],
  },
  unlimited: {
    name: 'Unlimited',
    price: 60,
    period: 'month',
    quotas: { premiumRequests: Infinity, fastRequests: Infinity, subagentRuns: Infinity, tokensPerMonth: Infinity },
    features: ['No quotas', 'All models', 'Priority support'],
  },
};

// Overage pricing (usage-based billing beyond plan quotas, Pro and up)
export const OVERAGE = {
  premiumRequest: 0.04,          // $ per premium request beyond quota (GHCP-style)
  tokensPerMillion: 0.50,        // $ per extra 1M tokens
};

// ── Ledger ───────────────────────────────────────────────────────────────────
function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function defaultLedger() {
  return {
    plan: 'free',
    licenseKey: null,
    period: currentPeriod(),
    usage: emptyUsage(),
    history: {},              // period → usage snapshot
  };
}

function emptyUsage() {
  return {
    premiumRequests: 0, fastRequests: 0, subagentRuns: 0,
    tokensIn: 0, tokensOut: 0,
    byProvider: {}, byDay: {},
    sessions: 0, estimatedProviderCost: 0,
  };
}

export function loadLedger() {
  try {
    const l = JSON.parse(fs.readFileSync(billingFile(), 'utf8'));
    // Month rollover: archive and reset
    if (l.period !== currentPeriod()) {
      l.history[l.period] = l.usage;
      l.period = currentPeriod();
      l.usage = emptyUsage();
      saveLedger(l);
    }
    return l;
  } catch {
    return defaultLedger();
  }
}

export function saveLedger(ledger) {
  try {
    fs.mkdirSync(path.dirname(billingFile()), { recursive: true });
    fs.writeFileSync(billingFile(), JSON.stringify(ledger, null, 2));
    return true;
  } catch { return false; }
}

// ── Metering (called from the LLM layer after every request) ────────────────
// Provider marginal cost estimates per 1M tokens (for the ledger's own books)
const PROVIDER_COST = {
  claude: { in: 3.0, out: 15.0 },     // Sonnet
  groq: { in: 0, out: 0 },            // free tier
  'openai-compatible': { in: 0, out: 0 }, // local
};

export function isPremium(provider) {
  return provider === 'claude';
}

export function meter({ provider = 'groq', tokensIn = 0, tokensOut = 0, subagent = false, session = false } = {}) {
  const ledger = loadLedger();
  const u = ledger.usage;

  if (session) u.sessions++;
  if (subagent) u.subagentRuns++;
  if (isPremium(provider)) u.premiumRequests++;
  else u.fastRequests++;

  u.tokensIn += tokensIn;
  u.tokensOut += tokensOut;
  u.byProvider[provider] = u.byProvider[provider] || { requests: 0, tokens: 0 };
  u.byProvider[provider].requests++;
  u.byProvider[provider].tokens += tokensIn + tokensOut;

  const day = new Date().toISOString().slice(0, 10);
  u.byDay[day] = (u.byDay[day] || 0) + tokensIn + tokensOut;

  const rate = PROVIDER_COST[provider] || { in: 0, out: 0 };
  u.estimatedProviderCost += (tokensIn / 1e6) * rate.in + (tokensOut / 1e6) * rate.out;

  saveLedger(ledger);
  return checkQuota(ledger);
}

// ── Quota enforcement ────────────────────────────────────────────────────────
export function checkQuota(ledger = loadLedger()) {
  const plan = PLANS[ledger.plan] || PLANS.free;
  const q = plan.quotas;
  const u = ledger.usage;
  const totalTokens = u.tokensIn + u.tokensOut;

  const over = [];
  if (u.premiumRequests > q.premiumRequests) over.push({ metric: 'premiumRequests', used: u.premiumRequests, quota: q.premiumRequests });
  if (u.fastRequests > q.fastRequests) over.push({ metric: 'fastRequests', used: u.fastRequests, quota: q.fastRequests });
  if (u.subagentRuns > q.subagentRuns) over.push({ metric: 'subagentRuns', used: u.subagentRuns, quota: q.subagentRuns });
  if (totalTokens > q.tokensPerMonth) over.push({ metric: 'tokensPerMonth', used: totalTokens, quota: q.tokensPerMonth });

  // Free plan: hard block on premium overage. Paid plans: usage-based overage billing.
  const overageBillable = ledger.plan !== 'free';
  const premiumOver = Math.max(0, u.premiumRequests - (Number.isFinite(q.premiumRequests) ? q.premiumRequests : u.premiumRequests));
  const tokenOver = Math.max(0, totalTokens - (Number.isFinite(q.tokensPerMonth) ? q.tokensPerMonth : totalTokens));
  const overageCharge = overageBillable
    ? Math.round((premiumOver * OVERAGE.premiumRequest + (tokenOver / 1e6) * OVERAGE.tokensPerMillion) * 100) / 100
    : 0;

  return {
    plan: ledger.plan,
    withinQuota: over.length === 0,
    exceeded: over,
    blocked: ledger.plan === 'free' && over.some(o => o.metric === 'premiumRequests'),
    overageCharge,
    ...(over.length && ledger.plan === 'free' ? { upgradeHint: 'Quota exceeded on Free — premium requests will route to free/local models. Upgrade: devlab billing upgrade pro' } : {}),
  };
}

// Should this request be allowed on a premium model right now?
export function allowPremium() {
  const ledger = loadLedger();
  const plan = PLANS[ledger.plan] || PLANS.free;
  if (!Number.isFinite(plan.quotas.premiumRequests)) return { allowed: true };
  const used = ledger.usage.premiumRequests;
  if (used < plan.quotas.premiumRequests) return { allowed: true, remaining: plan.quotas.premiumRequests - used };
  if (ledger.plan === 'free') return { allowed: false, reason: 'Free plan premium quota exhausted — routing to free/local models. Upgrade for more.' };
  return { allowed: true, overage: true, note: `Beyond quota — overage $${OVERAGE.premiumRequest}/request applies` };
}

// ── Plan management ──────────────────────────────────────────────────────────
export function setPlan(planId, licenseKey = null) {
  if (!PLANS[planId]) return { error: `Unknown plan: ${planId}. Available: ${Object.keys(PLANS).join(', ')}` };
  // Paid plans require a license key (issued at purchase — Stripe/Paddle webhook writes it)
  if (planId !== 'free' && !licenseKey) return { error: `Plan '${planId}' requires a license key. Purchase at devlab.dev/pricing, then: devlab billing activate <key>` };
  const ledger = loadLedger();
  ledger.plan = planId;
  ledger.licenseKey = licenseKey;
  saveLedger(ledger);
  return { plan: planId, activated: true, quotas: PLANS[planId].quotas };
}

// ── Usage report ─────────────────────────────────────────────────────────────
function fmtQuota(used, quota) {
  if (!Number.isFinite(quota)) return `${used.toLocaleString()} / unlimited`;
  const pct = quota ? Math.round((used / quota) * 100) : 0;
  return `${used.toLocaleString()} / ${quota.toLocaleString()} (${pct}%)`;
}

export function usageReport() {
  const ledger = loadLedger();
  const plan = PLANS[ledger.plan] || PLANS.free;
  const u = ledger.usage;
  const quota = checkQuota(ledger);
  const totalTokens = u.tokensIn + u.tokensOut;

  return {
    plan: `${plan.name} ($${plan.price}/${plan.period})`,
    period: ledger.period,
    usage: {
      premiumRequests: fmtQuota(u.premiumRequests, plan.quotas.premiumRequests),
      fastRequests: fmtQuota(u.fastRequests, plan.quotas.fastRequests),
      subagentRuns: fmtQuota(u.subagentRuns, plan.quotas.subagentRuns),
      tokens: fmtQuota(totalTokens, plan.quotas.tokensPerMonth),
      sessions: u.sessions,
    },
    byProvider: u.byProvider,
    last7Days: Object.entries(u.byDay).sort().slice(-7).map(([d, t]) => `${d}: ${t.toLocaleString()} tokens`),
    estimatedProviderCost: `$${u.estimatedProviderCost.toFixed(2)}`,
    ...(quota.overageCharge > 0 ? { overageCharge: `$${quota.overageCharge}` } : {}),
    withinQuota: quota.withinQuota,
    ...(quota.upgradeHint ? { upgradeHint: quota.upgradeHint } : {}),
  };
}

export function listPlans() {
  return Object.entries(PLANS).map(([id, p]) => ({
    id, name: p.name, price: `$${p.price}/${p.period}`,
    quotas: Object.fromEntries(Object.entries(p.quotas).map(([k, v]) => [k, Number.isFinite(v) ? v.toLocaleString() : 'unlimited'])),
    features: p.features,
  }));
}
