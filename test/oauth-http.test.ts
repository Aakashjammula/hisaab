import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/core/crypto.ts';
import { BASE, REDIRECT, call, connectClaude, json, login, pkce } from './helpers.ts';

async function register() {
  const r = await call('/oauth/register', { method: 'POST', body: { redirect_uris: [REDIRECT], client_name: 'Claude' } });
  expect(r.status).toBe(201);
  return (await json(r)).client_id as string;
}

async function authorizeParams(over: Record<string, string> = {}) {
  const { challenge } = await pkce();
  return {
    client_id: await register(), redirect_uri: REDIRECT, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st<"&>', ...over,
  };
}

const authorizeUrl = (p: Record<string, string>) => '/oauth/authorize?' + new URLSearchParams(p);
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

describe('oauth http', () => {
  it('metadata documents', async () => {
    const pr = await call('/.well-known/oauth-protected-resource');
    expect(pr.status).toBe(200);
    expect(pr.headers.get('cache-control')).toBe('no-store');
    const prBody = {
      resource: `${BASE}/mcp`, authorization_servers: [BASE], bearer_methods_supported: ['header'], resource_name: 'Hisaab',
    };
    expect(await json(pr)).toEqual(prBody);
    expect(await json(await call('/.well-known/oauth-protected-resource/mcp'))).toEqual(prBody);

    const as = await call('/.well-known/oauth-authorization-server');
    expect(as.headers.get('cache-control')).toBe('no-store');
    expect(await json(as)).toEqual({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('mcp without token is 401 with resource_metadata', async () => {
    const r = await call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  });

  it('register errors are RFC 7591 JSON', async () => {
    const r = await call('/oauth/register', { method: 'POST', body: { redirect_uris: ['https://evil.com/cb'] } });
    expect(r.status).toBe(400);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await json(r)).error).toBe('invalid_redirect_uri');
  });

  it('authorize with a bad client renders an error page and does not redirect', async () => {
    const r = await call(authorizeUrl({ ...(await authorizeParams()), client_id: 'nope' }));
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('authorize signed out redirects to sign-in', async () => {
    const r = await call(authorizeUrl(await authorizeParams()));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/\?next=%2Foauth%2Fauthorize/);
  });

  it('authorize with expired cookie redirects to sign-in', async () => {
    const { cookie } = await login();
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(cookie.split('=')[1]!)).run();
    const r = await call(authorizeUrl(await authorizeParams()), { cookie });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/\?next=%2Foauth%2Fauthorize/);
  });

  it('consent page shows email and client', async () => {
    const { cookie, email } = await login();
    const r = await call(authorizeUrl(await authorizeParams()), { cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("form-action 'self' https://claude.ai");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await r.text();
    expect(html).toContain(email);
    expect(html).toContain('Claude');
    expect(html).toContain('claude.ai');
    expect(html).toContain('Allow Claude to read and change your Hisaab data');
    expect(html).toContain('name="csrf"');
    expect(html).toContain('value="st&lt;&quot;&amp;&gt;"');
    expect(html).not.toContain('st<"&>');
  });

  it('consent POST without csrf is 403', async () => {
    const { cookie } = await login();
    const r = await call('/oauth/authorize', {
      method: 'POST', cookie, headers: { origin: BASE }, form: { ...(await authorizeParams()), decision: 'allow' },
    });
    expect(r.status).toBe(403);
    expect(r.headers.get('location')).toBeNull();
  });

  it('consent POST with another session\'s csrf is 403', async () => {
    const a = await login(), b = await login();
    const p = await authorizeParams();
    const csrf = csrfOf(await (await call(authorizeUrl(p), { cookie: a.cookie })).text())!;
    const r = await call('/oauth/authorize', { method: 'POST', cookie: b.cookie, headers: { origin: BASE }, form: { ...p, csrf, decision: 'allow' } });
    expect(r.status).toBe(403);
  });

  it('consent POST from another Origin is 403', async () => {
    const { cookie } = await login();
    const p = await authorizeParams();
    const csrf = csrfOf(await (await call(authorizeUrl(p), { cookie })).text())!;
    for (const origin of ['https://evil.com', undefined]) {
      const r = await call('/oauth/authorize', {
        method: 'POST', cookie, headers: origin ? { origin } : {}, form: { ...p, csrf, decision: 'allow' },
      });
      expect(r.status).toBe(403);
    }
  });

  it('consent POST signed out redirects to sign-in', async () => {
    const p = await authorizeParams();
    const r = await call('/oauth/authorize', { method: 'POST', headers: { origin: BASE }, form: { ...p, csrf: 'x', decision: 'allow' } });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/\?next=%2Foauth%2Fauthorize%3F/);
  });

  it('deny redirects with access_denied and state', async () => {
    const { cookie } = await login();
    const p = await authorizeParams();
    const csrf = csrfOf(await (await call(authorizeUrl(p), { cookie })).text())!;
    const r = await call('/oauth/authorize', { method: 'POST', cookie, headers: { origin: BASE }, form: { ...p, csrf, decision: 'deny' } });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st<"&>');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('full flow via connectClaude', async () => {
    const c = await connectClaude();
    expect(c.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.accessToken).not.toBe(c.refreshToken);
  });

  it('token endpoint errors are RFC 6749 JSON', async () => {
    const { verifier } = await pkce();
    const r = await call('/oauth/token', {
      method: 'POST',
      form: { grant_type: 'authorization_code', code: 'bogus', redirect_uri: REDIRECT, client_id: await register(), code_verifier: verifier },
    });
    expect(r.status).toBe(400);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await json(r)).toMatchObject({ error: 'invalid_grant' });
  });

  it('revoke always answers 200', async () => {
    const c = await connectClaude();
    const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE token_hash = ?')
      .bind(await sha256(c.accessToken)).first<{ n: number }>())!.n;
    expect(await count()).toBe(1);
    const r = await call('/oauth/revoke', { method: 'POST', form: { token: c.refreshToken } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await count()).toBe(0);
    expect((await call('/oauth/revoke', { method: 'POST', form: { token: 'unknown' } })).status).toBe(200);
  });

  it('web cookie is not accepted on /mcp', async () => {
    const { cookie } = await login();
    const r = await call('/mcp', { method: 'POST', cookie, body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(r.status).toBe(401);
  });

  it('bearer token is not accepted on /api/me', async () => {
    const c = await connectClaude();
    const r = await call('/api/me', { headers: { authorization: `Bearer ${c.accessToken}` } });
    expect(r.status).toBe(401);
  });
});
