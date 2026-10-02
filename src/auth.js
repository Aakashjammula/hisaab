// Second layer behind Cloudflare Access: verify the signed Access JWT on every API call,
// so the API stays closed even if Access were misconfigured or bypassed.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError } from './http.js';

let jwks = null, jwksFor = null;

export async function requireUser(request, env) {
  const url = new URL(request.url);

  // Local development only: needs the flag from .dev.vars AND a localhost request.
  if (env.DEV_BYPASS_AUTH === 'true' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return { email: 'dev@localhost' };
  }

  const { TEAM_DOMAIN, POLICY_AUD, ALLOWED_EMAIL } = env;
  if (!TEAM_DOMAIN || !POLICY_AUD || !ALLOWED_EMAIL || TEAM_DOMAIN.includes('REPLACE')) {
    logSetupHint(request);
    throw new HttpError(500, 'Auth is not configured'); // fail closed
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new HttpError(401, 'Not signed in');

  if (jwksFor !== TEAM_DOMAIN) {
    jwks = createRemoteJWKSet(new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`));
    jwksFor = TEAM_DOMAIN;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer: TEAM_DOMAIN, audience: POLICY_AUD }));
  } catch {
    throw new HttpError(401, 'Invalid session');
  }

  const allowed = ALLOWED_EMAIL.toLowerCase().split(',').map(s => s.trim());
  if (!payload.email || !allowed.includes(String(payload.email).toLowerCase())) {
    throw new HttpError(403, 'Forbidden');
  }
  return { email: payload.email };
}

/**
 * Setup helper: before TEAM_DOMAIN/POLICY_AUD are configured, log the (non-secret) issuer and
 * audience from the Access token so they can be copied into wrangler.jsonc. Never logs the token.
 */
function logSetupHint(request) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return;
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { iss, aud } = JSON.parse(atob(b64));
    console.log(JSON.stringify({ setup_hint: true, TEAM_DOMAIN: iss, POLICY_AUD: Array.isArray(aud) ? aud[0] : aud }));
  } catch {}
}

/** Writes must come from our own page: JSON content type is enforced in readJson, plus same-origin here. */
export function requireSameOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Cross-origin request blocked');
}
