// OAuth 2.1 authorization server for the MCP connector (Claude is the client). Public clients only:
// dynamic client registration (RFC 7591), PKCE S256 (RFC 7636), resource indicators (RFC 8707),
// rotating refresh tokens with reuse detection, revocation (RFC 7009). Codes and tokens are random
// 256-bit values stored only as SHA-256 hashes.
import { AppError, OAuthError, notFound } from '../core/errors.ts';
import { generateToken, hmac, sha256, timingSafeEqual } from '../core/crypto.ts';
import type { Id, User } from '../core/types.ts';
import type { Clock, IdGenerator, OAuthClient, OAuthConnection, OAuthRepo, RateLimiter, UserRepo } from '../ports/index.ts';
import { OAUTH_DEFAULTS, type AppConfig } from './config.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const MAX_REDIRECT_URIS = 5;
const MAX_PARAM = 2000;
/** RFC 7636 §4.1 code_verifier; an S256 challenge is base64url(sha256) = exactly 43 characters. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface OAuthDeps { oauth: OAuthRepo; users: UserRepo; limiter: RateLimiter; clock: Clock; ids: IdGenerator; config: AppConfig }
export interface AuthorizeRequest { client: OAuthClient; redirectUri: string; state: string | null; codeChallenge: string; resource: string }
export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string }

const badRequest = (description: string) => new OAuthError('invalid_request', description);
const badGrant = () => new OAuthError('invalid_grant', 'The grant is invalid, expired or already used.');

/** A required string parameter, bounded in length. */
function param(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v || v.length > MAX_PARAM) throw badRequest(`Missing or invalid ${name}.`);
  return v;
}

/** https on a Claude host (default port), or http on a loopback host (any port, RFC 8252). No fragment or userinfo. */
function allowedRedirect(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > MAX_PARAM || raw.includes('#')) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:' && u.port === '' && (OAUTH_DEFAULTS.redirectHosts as readonly string[]).includes(u.hostname)) return u;
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return u;
  return null;
}

/** Exact match, except a loopback URI may use a different port than the registered one. */
function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const req = allowedRedirect(requested);
  if (!req || req.protocol !== 'http:') return false;
  const portless = (u: URL) => { const c = new URL(u.href); c.port = ''; return c.href; };
  return registered.some(r => {
    const reg = allowedRedirect(r);
    return !!reg && reg.protocol === 'http:' && portless(reg) === portless(req);
  });
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class OAuthService {
  constructor(private d: OAuthDeps) {}

  private get cfg() { return this.d.config.auth; }

  private async limit(key: string, max: number, windowSeconds: number) {
    const wait = await this.d.limiter.hit(key, max, windowSeconds, this.d.clock.now());
    if (wait > 0) throw new AppError('rate_limited', `Too many attempts. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`, wait);
  }

  private hardStop(conn: OAuthConnection): number {
    return Date.parse(conn.createdAt) + this.cfg.sessionMaxDays * DAY;
  }

  /** RFC 7591. Returns the registration response body. Always a public client (token_endpoint_auth_method "none"). */
  async register(body: Record<string, unknown>, ip: string): Promise<Record<string, unknown>> {
    await this.limit(`oauth-register-ip:${ip}`, 10, 3600);
    if (!body || typeof body !== 'object') throw badRequest('The registration body must be a JSON object.');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
    }
    if (!uris.every(u => allowedRedirect(u))) {
      throw new OAuthError('invalid_redirect_uri', 'Only https://claude.ai, https://claude.com and http loopback redirect URIs are allowed.');
    }
    const rawName = body.client_name;
    if (rawName !== undefined && typeof rawName !== 'string') throw badRequest('client_name must be a string.');
    const name = rawName?.trim().slice(0, 100) || 'Claude';

    const now = this.d.clock.now();
    const client: OAuthClient = { id: this.d.ids.next(), name, redirectUris: uris as string[], createdAt: now.toISOString() };
    await this.d.oauth.createClient(client);
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  /** Validates authorize query params; `origin` is this server's origin (resource must be `${origin}/mcp` or `${origin}`). */
  async checkAuthorize(q: Record<string, string | undefined>, origin: string, ip: string): Promise<AuthorizeRequest> {
    await this.limit(`oauth-authorize-ip:${ip}`, 30, 600);
    // Client and redirect_uri first: until both are known good, errors must not be redirected.
    const clientId = param(q.client_id, 'client_id');
    const client = clientId.length <= 100 ? await this.d.oauth.getClient(clientId) : null;
    if (!client) throw new OAuthError('invalid_client', 'Unknown client. Remove the connector and add it again.');
    const redirectUri = param(q.redirect_uri, 'redirect_uri');
    if (!redirectMatches(client.redirectUris, redirectUri)) throw badRequest('redirect_uri is not registered for this client.');

    if (q.response_type !== 'code') throw badRequest('response_type must be "code".');
    if (q.code_challenge_method !== 'S256') throw badRequest('PKCE with code_challenge_method "S256" is required.');
    if (!q.code_challenge || !CHALLENGE_RE.test(q.code_challenge)) throw badRequest('Missing or invalid code_challenge.');
    const resource = q.resource ?? `${origin}/mcp`;
    if (resource !== `${origin}/mcp` && resource !== origin) throw new OAuthError('invalid_target', 'Unknown resource.');
    if (q.state !== undefined && q.state.length > MAX_PARAM) throw badRequest('state is too long.');

    return { client, redirectUri, state: q.state ?? null, codeChallenge: q.code_challenge, resource };
  }

  /** Issues a code; returns the full redirect URL with code (+ state). */
  async approve(userId: Id, req: AuthorizeRequest, userAgent: string | null): Promise<string> {
    const now = this.d.clock.now();
    const code = generateToken();
    await this.d.oauth.createCode({
      codeHash: await sha256(code), clientId: req.client.id, userId, redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge, resource: req.resource, userAgent: userAgent?.slice(0, 200) ?? null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + OAUTH_DEFAULTS.codeSeconds * 1000).toISOString(),
    });
    return this.redirect(req, { code });
  }

  /** Redirect URL with error=access_denied (+ state). */
  deny(req: AuthorizeRequest): string {
    return this.redirect(req, { error: 'access_denied' });
  }

  private redirect(req: AuthorizeRequest, params: Record<string, string>): string {
    const url = new URL(req.redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (req.state !== null) url.searchParams.set('state', req.state);
    return url.href;
  }

  /** grant_type authorization_code (code, redirect_uri, client_id, code_verifier) or refresh_token (refresh_token, client_id). */
  async token(form: Record<string, string>, ip: string): Promise<TokenResponse> {
    await this.limit(`oauth-token-ip:${ip}`, 60, 600);
    const grantType = param(form.grant_type, 'grant_type');
    if (grantType === 'authorization_code') return this.codeGrant(form);
    if (grantType === 'refresh_token') return this.refreshGrant(form);
    throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }

  private async activeUser(userId: Id): Promise<User | null> {
    const user = await this.d.users.findById(userId);
    return user?.status === 'active' ? user : null;
  }

  private async codeGrant(form: Record<string, string>): Promise<TokenResponse> {
    const code = param(form.code, 'code');
    const redirectUri = param(form.redirect_uri, 'redirect_uri');
    const clientId = param(form.client_id, 'client_id');
    const verifier = param(form.code_verifier, 'code_verifier');
    if (!VERIFIER_RE.test(verifier)) throw badRequest('Invalid code_verifier.');

    const now = this.d.clock.now(), nowIso = now.toISOString();
    // Consumed before any other check: a failed attempt burns the code.
    const rec = await this.d.oauth.consumeCode(await sha256(code), nowIso);
    if (!rec || rec.clientId !== clientId || rec.redirectUri !== redirectUri) throw badGrant();
    if (!timingSafeEqual(await s256(verifier), rec.codeChallenge)) throw badGrant();
    if (form.resource !== undefined && form.resource !== rec.resource) throw new OAuthError('invalid_target', 'Unknown resource.');
    if (!(await this.activeUser(rec.userId))) throw badGrant();

    // Every approval gets its own connection.
    const expiresAt = new Date(now.getTime() + this.cfg.sessionIdleDays * DAY).toISOString();
    const connectionId = this.d.ids.next();
    await this.d.oauth.createConnection({
      id: connectionId, userId: rec.userId, clientId: rec.clientId,
      createdAt: nowIso, lastUsedAt: nowIso, expiresAt, userAgent: rec.userAgent,
    });
    return this.issue(connectionId, now, expiresAt);
  }

  private async refreshGrant(form: Record<string, string>): Promise<TokenResponse> {
    const refreshToken = param(form.refresh_token, 'refresh_token');
    const clientId = param(form.client_id, 'client_id');
    const now = this.d.clock.now(), nowIso = now.toISOString();

    const hash = await sha256(refreshToken);
    const tok = await this.d.oauth.getToken(hash);
    if (!tok || tok.kind !== 'refresh') throw badGrant();
    const conn = await this.d.oauth.getConnection(tok.connectionId);
    if (!conn || conn.clientId !== clientId) throw badGrant();

    if (tok.rotatedAt) {
      // Two Claude apps refreshing at once is normal; a rotated token showing up later means it leaked.
      if (now.getTime() - Date.parse(tok.rotatedAt) > OAUTH_DEFAULTS.reuseGraceSeconds * 1000) {
        await this.d.oauth.deleteConnection(conn.userId, conn.id);
      }
      throw badGrant();
    }

    const hardStop = this.hardStop(conn);
    if (now.getTime() >= Date.parse(tok.expiresAt) || now.getTime() >= Date.parse(conn.expiresAt) || now.getTime() >= hardStop) {
      await this.d.oauth.deleteConnection(conn.userId, conn.id);
      throw badGrant();
    }
    if (!(await this.activeUser(conn.userId))) throw badGrant();
    // Lost a race with a concurrent refresh of the same token: within the grace window, so no revocation.
    if (!(await this.d.oauth.markRotated(hash, nowIso))) throw badGrant();

    const expiresAt = new Date(Math.min(now.getTime() + this.cfg.sessionIdleDays * DAY, hardStop)).toISOString();
    await this.d.oauth.touchConnection(conn.id, nowIso, expiresAt);
    return this.issue(conn.id, now, expiresAt);
  }

  /** New access token (1 h) and refresh token (lives as long as the connection). */
  private async issue(connectionId: Id, now: Date, refreshExpiresAt: string): Promise<TokenResponse> {
    const access = generateToken(), refresh = generateToken();
    await this.d.oauth.addToken({
      tokenHash: await sha256(access), connectionId, kind: 'access', rotatedAt: null,
      expiresAt: new Date(now.getTime() + OAUTH_DEFAULTS.accessTokenSeconds * 1000).toISOString(),
    });
    await this.d.oauth.addToken({ tokenHash: await sha256(refresh), connectionId, kind: 'refresh', rotatedAt: null, expiresAt: refreshExpiresAt });
    return { access_token: access, token_type: 'Bearer', expires_in: OAUTH_DEFAULTS.accessTokenSeconds, refresh_token: refresh };
  }

  /** RFC 7009: silently succeeds for unknown tokens; revoking a refresh token deletes its connection. */
  async revoke(token: string): Promise<void> {
    if (!token || token.length > 100) return;
    const hash = await sha256(token);
    const tok = await this.d.oauth.getToken(hash);
    if (!tok) return;
    if (tok.kind === 'access') return this.d.oauth.deleteToken(hash);
    const conn = await this.d.oauth.getConnection(tok.connectionId);
    if (conn) await this.d.oauth.deleteConnection(conn.userId, conn.id);
  }

  /** Bearer → user + connection, or null (missing/unknown/expired/disabled user). */
  async authenticateBearer(token: string | undefined): Promise<{ user: User; connectionId: Id } | null> {
    if (!token || token.length > 100) return null;
    const tok = await this.d.oauth.getToken(await sha256(token));
    if (!tok || tok.kind !== 'access') return null;
    const now = this.d.clock.now(), nowIso = now.toISOString();
    if (now.getTime() >= Date.parse(tok.expiresAt)) return null;

    const conn = await this.d.oauth.getConnection(tok.connectionId);
    if (!conn || now.getTime() >= Date.parse(conn.expiresAt) || now.getTime() >= this.hardStop(conn)) return null;
    const user = await this.activeUser(conn.userId);
    if (!user) return null;

    if (now.getTime() - Date.parse(conn.lastUsedAt) > HOUR) await this.d.oauth.touchConnection(conn.id, nowIso, conn.expiresAt);
    if (Math.random() < 0.02) await this.d.oauth.deleteExpired(nowIso); // lazy cleanup, no cron needed
    return { user, connectionId: conn.id };
  }

  /** Live connections, newest first. */
  async listConnections(userId: Id): Promise<OAuthConnection[]> {
    const now = this.d.clock.now().getTime();
    return (await this.d.oauth.listConnections(userId)).filter(c => Date.parse(c.expiresAt) > now);
  }

  async disconnect(userId: Id, id: string): Promise<void> {
    if (typeof id !== 'string' || id.length > 100 || !(await this.d.oauth.deleteConnection(userId, id))) notFound('Connection');
  }

  async disconnectAll(userId: Id): Promise<void> {
    await this.d.oauth.deleteAllConnections(userId);
  }

  /** CSRF value for the consent form, bound to the browser session. */
  async consentToken(sessionToken: string): Promise<string> {
    return hmac(this.cfg.secret, 'consent:' + await sha256(sessionToken));
  }
}
