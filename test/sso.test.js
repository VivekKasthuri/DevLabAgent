import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// Fresh import per suite so env changes apply
const load = () => import('../src/sso.js');

const SECRET = 'test-secret';

function makeSession(payload, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

beforeEach(() => {
  process.env.DEVLAB_SESSION_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.DEVLAB_SESSION_SECRET;
  delete process.env.DEVLAB_OIDC_ISSUER;
  delete process.env.DEVLAB_OIDC_CLIENT_ID;
});

describe('native OIDC SSO', () => {
  it('is disabled unless issuer and client id are set', async () => {
    const { ssoEnabled } = await load();
    expect(ssoEnabled()).toBe(false);
    process.env.DEVLAB_OIDC_ISSUER = 'https://idp.example.com';
    process.env.DEVLAB_OIDC_CLIENT_ID = 'devlab';
    expect(ssoEnabled()).toBe(true);
  });

  it('accepts a valid signed session', async () => {
    const { verifySession } = await load();
    const token = makeSession({ email: 'dev@corp.com', exp: Date.now() + 60000 });
    expect(verifySession(token)?.email).toBe('dev@corp.com');
  });

  it('rejects tampered and expired sessions', async () => {
    const { verifySession } = await load();
    const good = makeSession({ email: 'dev@corp.com', exp: Date.now() + 60000 });
    const [body] = good.split('.');
    expect(verifySession(`${body}.forged-mac-value`)).toBe(null);
    const expired = makeSession({ email: 'dev@corp.com', exp: Date.now() - 1000 });
    expect(verifySession(expired)).toBe(null);
    const wrongKey = makeSession({ email: 'dev@corp.com', exp: Date.now() + 60000 }, 'other-secret');
    expect(verifySession(wrongKey)).toBe(null);
    expect(verifySession('garbage')).toBe(null);
    expect(verifySession('')).toBe(null);
  });

  it('reads the session from a request cookie', async () => {
    const { sessionFromRequest } = await load();
    const token = makeSession({ email: 'dev@corp.com', exp: Date.now() + 60000 });
    const req = { headers: { cookie: `foo=bar; devlab_session=${encodeURIComponent(token)}` } };
    expect(sessionFromRequest(req)?.email).toBe('dev@corp.com');
    expect(sessionFromRequest({ headers: {} })).toBe(null);
  });
});
