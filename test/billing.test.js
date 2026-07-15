// Billing / plans / metering tests — offline-safe, isolated ledger file
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-bill-'));
process.env.DEVLAB_BILLING_FILE = path.join(tmp, 'billing.json');

const { PLANS, meter, checkQuota, allowPremium, setPlan, usageReport, listPlans, loadLedger, saveLedger } =
  await import('../src/billing.js');

function resetLedger(plan = 'free') {
  fs.rmSync(process.env.DEVLAB_BILLING_FILE, { force: true });
  if (plan !== 'free') {
    const l = loadLedger();
    l.plan = plan;
    l.licenseKey = 'TEST-KEY';
    saveLedger(l);
  }
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('plans', () => {
  it('defines free/starter/pro/team/unlimited with quotas', () => {
    expect(Object.keys(PLANS)).toEqual(['free', 'starter', 'pro', 'team', 'unlimited']);
    expect(PLANS.free.price).toBe(0);
    expect(PLANS.unlimited.quotas.premiumRequests).toBe(Infinity);
  });

  it('listPlans renders unlimited quotas as text', () => {
    const plans = listPlans();
    expect(plans.find(p => p.id === 'unlimited').quotas.premiumRequests).toBe('unlimited');
  });
});

describe('metering', () => {
  beforeEach(() => resetLedger());

  it('counts premium vs fast requests and tokens', () => {
    meter({ provider: 'claude', tokensIn: 1000, tokensOut: 500 });
    meter({ provider: 'groq', tokensIn: 200, tokensOut: 100 });
    const l = loadLedger();
    expect(l.usage.premiumRequests).toBe(1);
    expect(l.usage.fastRequests).toBe(1);
    expect(l.usage.tokensIn).toBe(1200);
    expect(l.usage.byProvider.claude.requests).toBe(1);
  });

  it('estimates provider cost for claude tokens', () => {
    meter({ provider: 'claude', tokensIn: 1_000_000, tokensOut: 1_000_000 });
    const l = loadLedger();
    expect(l.usage.estimatedProviderCost).toBeCloseTo(18.0, 1); // 3 + 15
  });
});

describe('quota enforcement', () => {
  beforeEach(() => resetLedger());

  it('free plan blocks premium after quota exhausted', () => {
    const l = loadLedger();
    l.usage.premiumRequests = PLANS.free.quotas.premiumRequests + 1;
    saveLedger(l);
    const q = checkQuota();
    expect(q.withinQuota).toBe(false);
    expect(q.blocked).toBe(true);
    expect(allowPremium().allowed).toBe(false);
  });

  it('pro plan allows overage with billing', () => {
    resetLedger('pro');
    const l = loadLedger();
    l.usage.premiumRequests = PLANS.pro.quotas.premiumRequests + 10;
    saveLedger(l);
    const q = checkQuota();
    expect(q.blocked).toBe(false);
    expect(q.overageCharge).toBeCloseTo(0.4, 2); // 10 * $0.04
    expect(allowPremium().allowed).toBe(true);
    expect(allowPremium().overage).toBe(true);
  });

  it('unlimited plan never blocks', () => {
    resetLedger('unlimited');
    expect(allowPremium().allowed).toBe(true);
  });
});

describe('plan management', () => {
  beforeEach(() => resetLedger());

  it('rejects unknown plans and paid plans without a key', () => {
    expect(setPlan('gold').error).toContain('Unknown plan');
    expect(setPlan('pro').error).toContain('license key');
  });

  it('activates a paid plan with a key', () => {
    const res = setPlan('pro', 'KEY-123');
    expect(res.activated).toBe(true);
    expect(loadLedger().plan).toBe('pro');
  });
});

describe('usageReport', () => {
  it('renders quotas with percentages', () => {
    resetLedger();
    meter({ provider: 'groq', tokensIn: 100, tokensOut: 50 });
    const r = usageReport();
    expect(r.plan).toContain('Free');
    expect(r.usage.fastRequests).toContain('/');
    expect(r.withinQuota).toBe(true);
  });
});
