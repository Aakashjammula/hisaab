import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1Client } from '../src/adapters/cloudflare/d1.ts';
import { SqlOAuthRepo, SqlRateLimiter, SqlUserRepo } from '../src/adapters/sql/repos.ts';
import { uuidv7 } from '../src/core/crypto.ts';
import { AppError, OAuthError } from '../src/core/errors.ts';
import { AUTH_DEFAULTS, type AppConfig } from '../src/services/config.ts';
import { OAuthService, type AuthorizeRequest } from '../src/services/oauth.ts';
import { login, newEmail } from './helpers.ts';

const ORIGIN = 'http://localhost';
const RESOURCE = `${ORIGIN}/mcp`;
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const DAY = 86_400_000;

const testConfig = (): AppConfig => ({
  appName: 'Hisaab', timeZone: (env as unknown as { TIME_ZONE: string }).TIME_ZONE, contactEmail: null,
  auth: { ...AUTH_DEFAULTS, mode: 'open', allowedEmails: [], secret: 'test-secret-at-least-16-chars' },
});

let current = new Date('2026-10-23T10:00:00.000Z');
const advance = (ms: number) => { current = new Date(current.getTime() + ms); };
let ipN = 0;
const ip = () => `10.9.${(++ipN >> 8) & 255}.${ipN & 255}`;

const service = () => {
  const db = new D1Client(env.DB);
  return new OAuthService({
    oauth: new SqlOAuthRepo(db), users: new SqlUserRepo(db), limiter: new SqlRateLimiter(db),
    clock: { now: () => current }, ids: { next: () => uuidv7(current.getTime()) }, config: testConfig(),
  });
};

async function userId(): Promise<string> {
  const { email } = await login(newEmail());
  return (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>())!.id;
}

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** Expect a promise to reject with an OAuthError carrying `code`. */
async function oauthFails(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(OAuthError);
  expect((err as OAuthError).error).toBe(code);
}

async function registered(s: OAuthService, redirectUris = [CLAUDE_CB]) {
  const res = await s.register({ client_name: 'Claude', redirect_uris: redirectUris }, ip());
  return res.client_id as string;
}

const authorizeQuery = (clientId: string, challenge: string, over: Record<string, string | undefined> = {}) => ({
  response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: challenge,
  code_challenge_method: 'S256', state: 'xyz', resource: RESOURCE, ...over,
});

/** Register, authorize, approve: returns everything needed for the token exchange. */
async function codeFor(s: OAuthService, uid: string, clientId?: string) {
  const cid = clientId ?? await registered(s);
  const { verifier, challenge } = await pkce();
  const req = await s.checkAuthorize(authorizeQuery(cid, challenge), ORIGIN, ip());
  const url = new URL(await s.approve(uid, req, 'test-agent'));
  return { clientId: cid, verifier, code: url.searchParams.get('code')!, state: url.searchParams.get('state'), req };
}

const exchange = (s: OAuthService, c: { clientId: string; verifier: string; code: string }, over: Record<string, string> = {}) =>
  s.token({ grant_type: 'authorization_code', code: c.code, redirect_uri: CLAUDE_CB, client_id: c.clientId, code_verifier: c.verifier, ...over }, ip());

const refresh = (s: OAuthService, clientId: string, refreshToken: string) =>
  s.token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, ip());

/** A connected user: tokens from a completed code exchange. */
async function connected() {
  const s = service();
  const uid = await userId();
  const c = await codeFor(s, uid);
  const tokens = await exchange(s, c);
  return { s, uid, clientId: c.clientId, tokens };
}

beforeEach(() => { current = new Date('2026-10-23T10:00:00.000Z'); });

describe('registration', () => {
  it('register rejects non-claude https hosts', async () => {
    const s = service();
    await oauthFails(s.register({ redirect_uris: ['https://evil.example/cb'] }, ip()), 'invalid_redirect_uri');
    await oauthFails(s.register({ redirect_uris: ['http://claude.ai/cb'] }, ip()), 'invalid_redirect_uri');
    await oauthFails(s.register({ redirect_uris: ['https://claude.ai.evil.example/cb'] }, ip()), 'invalid_redirect_uri');
    await oauthFails(s.register({ redirect_uris: [] }, ip()), 'invalid_redirect_uri');
    await oauthFails(s.register({ redirect_uris: Array(6).fill(CLAUDE_CB) }, ip()), 'invalid_redirect_uri');
  });

  it('register rejects claude hosts on any path but the callback', async () => {
    const s = service();
    for (const uri of ['https://claude.ai/other', 'https://claude.ai/', 'https://claude.com/cb', 'https://claude.ai/api/mcp/auth_callback?x=1']) {
      await oauthFails(s.register({ redirect_uris: [uri] }, ip()), 'invalid_redirect_uri');
    }
  });

  it('register accepts claude.ai and loopback', async () => {
    const s = service();
    const uris = [CLAUDE_CB, 'https://claude.com/api/mcp/auth_callback', 'http://localhost:33418/callback', 'http://127.0.0.1:5000/cb'];
    const res = await s.register({ client_name: 'x'.repeat(150), redirect_uris: uris }, ip());
    expect(res.client_id).toEqual(expect.any(String));
    expect(res.redirect_uris).toEqual(uris);
    expect(res.token_endpoint_auth_method).toBe('none');
    expect(res.client_name).toBe('x'.repeat(100));
    expect((await s.register({ redirect_uris: [CLAUDE_CB] }, ip())).client_name).toBe('Claude');
  });

  it('register is rate limited per ip', async () => {
    const s = service(), addr = ip();
    for (let i = 0; i < 10; i++) await s.register({ redirect_uris: [CLAUDE_CB] }, addr);
    const err = await s.register({ redirect_uris: [CLAUDE_CB] }, addr).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('rate_limited');
  });
});

describe('authorize', () => {
  it('authorize rejects plain or missing PKCE', async () => {
    const s = service();
    const cid = await registered(s);
    const { challenge } = await pkce();
    await oauthFails(s.checkAuthorize(authorizeQuery(cid, challenge, { code_challenge_method: 'plain' }), ORIGIN, ip()), 'invalid_request');
    await oauthFails(s.checkAuthorize(authorizeQuery(cid, challenge, { code_challenge_method: undefined }), ORIGIN, ip()), 'invalid_request');
    await oauthFails(s.checkAuthorize(authorizeQuery(cid, '', {}), ORIGIN, ip()), 'invalid_request');
  });

  it('authorize rejects unregistered redirect_uri', async () => {
    const s = service();
    const cid = await registered(s);
    const { challenge } = await pkce();
    await oauthFails(s.checkAuthorize(authorizeQuery(cid, challenge, { redirect_uri: 'https://claude.ai/other' }), ORIGIN, ip()), 'invalid_request');
    await oauthFails(s.checkAuthorize(authorizeQuery(uuidv7(), challenge), ORIGIN, ip()), 'invalid_client');
  });

  it('authorize checks the resource', async () => {
    const s = service();
    const cid = await registered(s);
    const { challenge } = await pkce();
    expect((await s.checkAuthorize(authorizeQuery(cid, challenge, { resource: ORIGIN }), ORIGIN, ip())).resource).toBe(ORIGIN);
    await oauthFails(s.checkAuthorize(authorizeQuery(cid, challenge, { resource: 'https://other.example/mcp' }), ORIGIN, ip()), 'invalid_target');
  });

  it('loopback redirect may change port', async () => {
    const s = service();
    const cid = await registered(s, ['http://localhost:33418/callback']);
    const { challenge } = await pkce();
    const req = await s.checkAuthorize(authorizeQuery(cid, challenge, { redirect_uri: 'http://localhost:51234/callback' }), ORIGIN, ip());
    expect(req.redirectUri).toBe('http://localhost:51234/callback');
    await oauthFails(s.checkAuthorize(authorizeQuery(cid, challenge, { redirect_uri: 'http://localhost:51234/other' }), ORIGIN, ip()), 'invalid_request');
    await oauthFails(s.checkAuthorize(authorizeQuery(cid, challenge, { redirect_uri: 'http://127.0.0.1:51234/callback' }), ORIGIN, ip()), 'invalid_request');
  });

  it('approve and deny redirect with state', async () => {
    const s = service();
    const c = await codeFor(s, await userId());
    expect(c.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.state).toBe('xyz');
    const denied = new URL(s.deny(c.req as AuthorizeRequest));
    expect(denied.origin + denied.pathname).toBe(CLAUDE_CB);
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('state')).toBe('xyz');
    const row = await env.DB.prepare('SELECT code_hash FROM oauth_codes WHERE code_hash = ?').bind(c.code).first();
    expect(row).toBeNull(); // only the hash is stored
  });
});

describe('token', () => {
  it('code exchange needs the right verifier', async () => {
    const s = service();
    const uid = await userId();
    const bad = await codeFor(s, uid);
    await oauthFails(exchange(s, { ...bad, verifier: (await pkce()).verifier }), 'invalid_grant');
    await oauthFails(exchange(s, bad), 'invalid_grant'); // a failed attempt burns the code

    const c = await codeFor(s, uid);
    const t = await exchange(s, c);
    expect(t).toEqual({ access_token: expect.any(String), token_type: 'Bearer', expires_in: 3600, refresh_token: expect.any(String) });
    expect((await s.authenticateBearer(t.access_token))?.user.id).toBe(uid);
    await oauthFails(exchange(s, c), 'invalid_grant');
  });

  it('code exchange checks client and redirect_uri', async () => {
    const s = service();
    const uid = await userId();
    const c1 = await codeFor(s, uid);
    await oauthFails(exchange(s, c1, { redirect_uri: 'https://claude.ai/other' }), 'invalid_grant');
    const c2 = await codeFor(s, uid);
    await oauthFails(exchange(s, c2, { client_id: await registered(s) }), 'invalid_grant');
    await oauthFails(s.token({ grant_type: 'password' }, ip()), 'unsupported_grant_type');
    await oauthFails(s.token({ grant_type: 'authorization_code' }, ip()), 'invalid_request');
  });

  it('code expires after 60 s', async () => {
    const s = service();
    const c = await codeFor(s, await userId());
    advance(61_000);
    await oauthFails(exchange(s, c), 'invalid_grant');
  });

  it('refresh rotates', async () => {
    const { s, uid, clientId, tokens } = await connected();
    advance(5 * 60_000);
    const next = await refresh(s, clientId, tokens.refresh_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await s.authenticateBearer(next.access_token))?.user.id).toBe(uid);
    expect((await s.authenticateBearer(tokens.access_token))?.user.id).toBe(uid); // old access token lives until it expires
    advance(60_000);
    const third = await refresh(s, clientId, next.refresh_token);
    expect((await s.authenticateBearer(third.access_token))?.user.id).toBe(uid);
  });

  it('refresh reuse within grace does not revoke', async () => {
    const { s, uid, clientId, tokens } = await connected();
    const next = await refresh(s, clientId, tokens.refresh_token);
    advance(10_000);
    await oauthFails(refresh(s, clientId, tokens.refresh_token), 'invalid_grant');
    expect(await s.listConnections(uid)).toHaveLength(1);
    const after = await refresh(s, clientId, next.refresh_token);
    expect((await s.authenticateBearer(after.access_token))?.user.id).toBe(uid);
  });

  it('refresh reuse after grace revokes the connection', async () => {
    const { s, uid, clientId, tokens } = await connected();
    const next = await refresh(s, clientId, tokens.refresh_token);
    advance(61_000);
    await oauthFails(refresh(s, clientId, tokens.refresh_token), 'invalid_grant');
    await oauthFails(refresh(s, clientId, next.refresh_token), 'invalid_grant');
    expect(await s.authenticateBearer(next.access_token)).toBeNull();
    expect(await s.listConnections(uid)).toEqual([]);
  });

  it('refresh needs the same client', async () => {
    const { s, uid, clientId, tokens } = await connected();
    const other = await registered(s);
    await oauthFails(refresh(s, other, tokens.refresh_token), 'invalid_grant');
    await oauthFails(refresh(s, clientId, tokens.access_token), 'invalid_grant');
    expect((await refresh(s, clientId, tokens.refresh_token)).token_type).toBe('Bearer');
    expect(await s.listConnections(uid)).toHaveLength(1);
  });

  it('access token expires after 1 h', async () => {
    const { s, uid, tokens } = await connected();
    advance(3599_000);
    expect((await s.authenticateBearer(tokens.access_token))?.user.id).toBe(uid);
    advance(2_000);
    expect(await s.authenticateBearer(tokens.access_token)).toBeNull();
  });

  it('connection idle 30 d / max 90 d', async () => {
    const idle = await connected();
    advance(31 * DAY);
    await oauthFails(refresh(idle.s, idle.clientId, idle.tokens.refresh_token), 'invalid_grant');

    current = new Date('2026-10-23T10:00:00.000Z');
    const busy = await connected();
    let rt = busy.tokens.refresh_token;
    for (let day = 20; day <= 80; day += 20) {
      advance(20 * DAY);
      rt = (await refresh(busy.s, busy.clientId, rt)).refresh_token;
    }
    advance(11 * DAY); // day 91
    await oauthFails(refresh(busy.s, busy.clientId, rt), 'invalid_grant');
  });

  it('token endpoint is rate limited per ip', async () => {
    const s = service(), addr = ip();
    for (let i = 0; i < 60; i++) await s.token({ grant_type: 'password' }, addr).catch(() => null);
    const err = await s.token({ grant_type: 'password' }, addr).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('rate_limited');
  });
});

describe('bearer and connections', () => {
  it('stores only token hashes', async () => {
    const { tokens } = await connected();
    const rows = await env.DB.prepare('SELECT token_hash FROM oauth_tokens WHERE token_hash IN (?, ?)')
      .bind(tokens.access_token, tokens.refresh_token).all();
    expect(rows.results).toEqual([]);
  });

  it('rejects missing, unknown and refresh tokens as bearer', async () => {
    const { s, tokens } = await connected();
    expect(await s.authenticateBearer(undefined)).toBeNull();
    expect(await s.authenticateBearer('nope')).toBeNull();
    expect(await s.authenticateBearer(tokens.refresh_token)).toBeNull();
  });

  it('disabled user cannot use tokens', async () => {
    const { s, uid, clientId, tokens } = await connected();
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).bind(uid).run();
    expect(await s.authenticateBearer(tokens.access_token)).toBeNull();
    await oauthFails(refresh(s, clientId, tokens.refresh_token), 'invalid_grant');
  });

  it('revoke refresh token deletes the connection', async () => {
    const { s, uid, clientId, tokens } = await connected();
    await s.revoke('unknown-token');
    await s.revoke(tokens.refresh_token);
    expect(await s.listConnections(uid)).toEqual([]);
    expect(await s.authenticateBearer(tokens.access_token)).toBeNull();
    await oauthFails(refresh(s, clientId, tokens.refresh_token), 'invalid_grant');
  });

  it('revoke access token keeps the connection', async () => {
    const { s, uid, tokens } = await connected();
    await s.revoke(tokens.access_token);
    expect(await s.authenticateBearer(tokens.access_token)).toBeNull();
    expect(await s.listConnections(uid)).toHaveLength(1);
  });

  it('bearer touches last_used_at at most once an hour', async () => {
    const { s, uid, tokens } = await connected();
    const t0 = current.toISOString();
    advance(30 * 60_000);
    await s.authenticateBearer(tokens.access_token);
    expect((await s.listConnections(uid))[0]!.lastUsedAt).toBe(t0);
    const before = (await s.listConnections(uid))[0]!;
    const longAgo = new Date(current.getTime() - 61 * 60_000).toISOString();
    await env.DB.prepare('UPDATE oauth_connections SET last_used_at = ? WHERE id = ?').bind(longAgo, before.id).run();
    await s.authenticateBearer(tokens.access_token);
    const after = (await s.listConnections(uid))[0]!;
    expect(after.lastUsedAt).toBe(current.toISOString());
    expect(after.expiresAt).toBe(before.expiresAt); // only refresh extends the connection
  });

  it('each approval is a new connection; disconnectAll clears them', async () => {
    const s = service();
    const uid = await userId();
    const c1 = await codeFor(s, uid);
    await exchange(s, c1);
    await exchange(s, await codeFor(s, uid, c1.clientId));
    const list = await s.listConnections(uid);
    expect(list).toHaveLength(2);
    expect(list[0]!.clientName).toBe('Claude');
    expect(list[0]!.userAgent).toBe('test-agent');
    await s.disconnectAll(uid);
    expect(await s.listConnections(uid)).toEqual([]);
  });

  it('disconnect is scoped to the user', async () => {
    const { s, uid, tokens } = await connected();
    const [conn] = await s.listConnections(uid);
    const err = await s.disconnect(await userId(), conn!.id).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('not_found');
    expect(await s.authenticateBearer(tokens.access_token)).not.toBeNull();
    await s.disconnect(uid, conn!.id);
    expect(await s.authenticateBearer(tokens.access_token)).toBeNull();
    expect(((await s.disconnect(uid, conn!.id).catch((e: unknown) => e)) as AppError).code).toBe('not_found');
  });

  it('consentToken is stable per session token', async () => {
    const s = service();
    const a = await s.consentToken('session-a');
    expect(await s.consentToken('session-a')).toBe(a);
    expect(await s.consentToken('session-b')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
