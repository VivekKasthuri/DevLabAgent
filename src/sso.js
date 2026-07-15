// src/sso.js — native OIDC SSO for the DevLab server. Zero dependencies:
// standard authorization-code flow with PKCE, HMAC-signed session cookies,
// and IdP-agnostic discovery (Okta, Azure AD, Google, Keycloak, Authentik...).
//
// Enable with:
//   DEVLAB_OIDC_ISSUER=https://login.example.com/realms/dev   (discovery base)
//   DEVLAB_OIDC_CLIENT_ID=devlab
//   DEVLAB_OIDC_CLIENT_SECRET=...           (optional — PKCE covers public clients)
//   DEVLAB_OIDC_ALLOWED_DOMAIN=example.com  (optional — restrict email domain)
//   DEVLAB_SESSION_SECRET=...               (optional — random per boot if unset)
//
// Works fully on-prem/air-gapped: the only network calls are to YOUR IdP.
import crypto from 'node:crypto';

const SESSION_COOKIE = 'devlab_session';
const STATE_COOKIE = 'devlab_oidc_state';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h workday

export function ssoEnabled() {
  return Boolean(process.env.DEVLAB_OIDC_ISSUER && process.env.DEVLAB_OIDC_CLIENT_ID);
}

const secret = () => process.env.DEVLAB_SESSION_SECRET || bootSecret;
const bootSecret = crypto.randomBytes(32).toString('hex');

// ── Signed-cookie helpers (HMAC-SHA256, tamper-proof, no server-side store) ───
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySession(token) {
  try {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    const session = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!session.exp || Date.now() > session.exp) return null;
    return session;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionFromRequest(req) {
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

// ── OIDC discovery (cached) ───────────────────────────────────────────────────
let discovered = null;
async function discover() {
  if (discovered) return discovered;
  const issuer = process.env.DEVLAB_OIDC_ISSUER.replace(/\/$/, '');
  const resp = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!resp.ok) throw new Error(`OIDC discovery failed: ${resp.status} from ${issuer}`);
  const doc = await resp.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('OIDC discovery document missing endpoints');
  }
  discovered = doc;
  return doc;
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// ── Express route installer ───────────────────────────────────────────────────
/**
 * Install /auth/login, /auth/callback, /auth/logout, /auth/me and a gate
 * middleware on `app`. Returns { gate } — gate(req) → session|null so the
 * WebSocket upgrade path can share the same check.
 */
export function installSSO(app) {
  // Step 1: redirect to the IdP with PKCE
  app.get('/auth/login', async (req, res) => {
    try {
      const doc = await discover();
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const state = crypto.randomBytes(16).toString('base64url');
      const stateCookie = sign({ verifier, state, exp: Date.now() + 10 * 60 * 1000 });
      res.setHeader('Set-Cookie',
        `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
      const url = new URL(doc.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', process.env.DEVLAB_OIDC_CLIENT_ID);
      url.searchParams.set('redirect_uri', `${baseUrl(req)}/auth/callback`);
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      res.redirect(url.toString());
    } catch (e) {
      res.status(502).send(`SSO error: ${e.message}`);
    }
  });

  // Step 2: exchange the code, validate, set the session cookie
  app.get('/auth/callback', async (req, res) => {
    try {
      const doc = await discover();
      const st = verifySession(parseCookies(req)[STATE_COOKIE]);
      if (!st || st.state !== req.query.state) return res.status(400).send('SSO error: state mismatch (retry /auth/login)');

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(req.query.code || ''),
        redirect_uri: `${baseUrl(req)}/auth/callback`,
        client_id: process.env.DEVLAB_OIDC_CLIENT_ID,
        code_verifier: st.verifier,
      });
      if (process.env.DEVLAB_OIDC_CLIENT_SECRET) body.set('client_secret', process.env.DEVLAB_OIDC_CLIENT_SECRET);

      const tokenResp = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!tokenResp.ok) return res.status(502).send(`SSO error: token exchange failed (${tokenResp.status})`);
      const tokens = await tokenResp.json();

      // Decode the ID token payload. Integrity: we received it over TLS
      // directly from the token endpoint we discovered, so per OIDC spec the
      // signature check is optional for the code flow — but validate claims.
      const claims = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString());
      if (claims.aud !== process.env.DEVLAB_OIDC_CLIENT_ID &&
          !(Array.isArray(claims.aud) && claims.aud.includes(process.env.DEVLAB_OIDC_CLIENT_ID))) {
        return res.status(403).send('SSO error: audience mismatch');
      }
      const email = claims.email || claims.preferred_username || claims.sub;
      const domain = process.env.DEVLAB_OIDC_ALLOWED_DOMAIN;
      if (domain && !String(email).endsWith(`@${domain}`)) {
        return res.status(403).send(`SSO error: ${email} is not in the allowed domain ${domain}`);
      }

      const session = sign({ email, name: claims.name || email, sub: claims.sub, exp: Date.now() + SESSION_TTL_MS });
      res.setHeader('Set-Cookie', [
        `${SESSION_COOKIE}=${encodeURIComponent(session)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
        `${STATE_COOKIE}=; Path=/; Max-Age=0`,
      ]);
      res.redirect('/');
    } catch (e) {
      res.status(502).send(`SSO error: ${e.message}`);
    }
  });

  app.get('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    res.redirect('/');
  });

  app.get('/auth/me', (req, res) => {
    const s = sessionFromRequest(req);
    if (!s) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, email: s.email, name: s.name });
  });

  return { gate: sessionFromRequest };
}
