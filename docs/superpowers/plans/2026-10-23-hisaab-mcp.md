# Hisaab MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude (phone app, claude.ai, Claude Code) do everything the owner can do in Hisaab, through a remote MCP endpoint at `/mcp` protected by Hisaab's own OAuth login.

**Architecture:**
- **OAuth 2.1 authorization server**, built with dynamic client registration and S256 PKCE. Its storage goes behind a new `OAuthRepo` port with a SQL adapter on D1, and its rules live in `services/oauth.ts`.
- **MCP endpoint:** a stateless JSON-RPC handler in `http/mcp.ts`. It exposes 16 tools from `http/mcp-tools.ts`, and the tools call the existing services.
- **Platform-neutral:** everything sits in `core/`, `ports/`, `services/` and `http/` and stays platform-neutral. Only `worker.ts` and `wrangler.jsonc` change for Cloudflare routing.

**Tech Stack:** TypeScript, Hono 4, Cloudflare Workers + D1, vitest with `@cloudflare/vitest-pool-workers`, plain JS frontend. No new npm dependencies: the MCP JSON-RPC handler is hand-written (planner's call; the surface is 5 methods).

**Spec:** `docs/superpowers/specs/2026-10-23-hisaab-mcp-design.md`

## Global Constraints

- **Git:** commit locally after each task. **Never `git push`**: the owner reviews and pushes.
- **Secrets:** never read, cat, grep or edit `.env` or `.dev.vars`.
- **Portability:**
  - No Cloudflare-specific code in `core/`, `services/` or `http/`.
  - No KV and no Durable Objects.
  - SQL stays portable, following the rules in `src/adapters/sql/client.ts`: `?` placeholders, no SQLite date functions, STRICT tables, text UUID v7 ids, ISO-8601 UTC text timestamps.
- **Tokens and codes:** stored only as SHA-256 hex (`sha256()` from `core/crypto.ts`), and generated with `generateToken()`.
- **Lifetimes:**
  - Access token: 1 hour (`expires_in: 3600`).
  - Authorization code: 60 seconds, single use.
  - Connection (and its refresh token): 30 days idle and 90 days absolute, read from `config.auth.sessionIdleDays` and `config.auth.sessionMaxDays`.
- **PKCE:** `S256` only.
- **Allowed redirect URIs:**
  - `https://claude.ai/...` and `https://claude.com/...`, with the host list held in config as `OAUTH_DEFAULTS.redirectHosts = ['claude.ai', 'claude.com']`;
  - `http://localhost:<any port>/...` and `http://127.0.0.1:<any port>/...`.
- **Tool money:**
  - Inputs are rupees, as a number or a string, with at most 2 decimals. Parse them with `toPaise` from `public/js/money.js`.
  - Outputs are rupee decimal strings with exactly 2 decimals, for example `"450.00"`. Add `toRupeeFixed(paise)` to `public/js/money.js`.
- **Every tool:** sets `openWorldHint: false` and has a `title`.
- **Edit copy:** the "ask, don't guess" error text begins with `This expense is split (` and contains `Send the new shares for`.
- **Rate limits** (planner's call), each with its own `RateLimiter` key:

  | Key | Limit |
  |---|---|
  | `mcp-user:<userId>` | 120 per 60 s |
  | `oauth-register-ip:<ip>` | 10 per 3600 s |
  | `oauth-token-ip:<ip>` | 60 per 600 s |
  | `oauth-authorize-ip:<ip>` | 30 per 600 s |

- **Responses:** every OAuth, MCP and connections response carries `Cache-Control: no-store`.

## Review Focus

1. **Two Claude clients refresh with the same refresh token at nearly the same moment.** For example, claude.ai on the phone and on the web. One of them should succeed, and the other should get `invalid_grant` *without* the whole connection being revoked. Reuse within a 60-second grace window after rotation does not count as theft. Test: Task 2, `refresh reuse within grace does not revoke`.
2. **Claude sends amounts as JSON numbers** (`450`, `449.5`), not strings. These are accepted exactly like `"450"`. Test: Task 5, `add_expense accepts numeric amounts`.
3. **"Today" near midnight IST.** At 2026-10-22T19:00:00Z, `get_context` must say `today: "2026-10-23"`. Test: Task 4, `get_context uses Asia/Kolkata`.
4. **A browser holding an expired session cookie opens `/oauth/authorize`.** It must be sent to sign-in, not shown the consent page or an error. Test: Task 3, `authorize with expired cookie redirects to sign-in`.
5. **Claude clears a note by sending `note: null` to `update_expense`.** The note becomes empty, and the amount, category and shares are unchanged. Test: Task 5, `update_expense null note clears it`.

---

## File map

| File | Responsibility |
|---|---|
| `migrations/0004_oauth.sql` (new) | `oauth_clients`, `oauth_codes`, `oauth_connections`, `oauth_tokens` |
| `src/core/errors.ts` (modify) | add `OAuthError` |
| `src/ports/index.ts` (modify) | `OAuthClient`, `OAuthCode`, `OAuthConnection`, `OAuthToken`, `OAuthRepo` |
| `src/adapters/sql/repos.ts` (modify) | `SqlOAuthRepo` |
| `src/services/config.ts` (modify) | `OAUTH_DEFAULTS` |
| `src/services/oauth.ts` (new) | `OAuthService`: registration, authorize checks, codes, tokens, bearer auth, connections |
| `src/services/expenses.ts` (modify) | `ExpenseService.search`, `ExpenseService.patch` |
| `src/http/cookies.ts` (new) | `cookieName`, `isHttps` moved out of `app.ts` (shared by `app.ts` and `oauth.ts`) |
| `src/http/oauth.ts` (new) | `/.well-known/*`, `/oauth/*` routes and the consent page HTML |
| `src/http/mcp.ts` (new) | `/mcp` JSON-RPC handler |
| `src/http/mcp-tools.ts` (new) | the 16 tool definitions, plus rupee output shaping |
| `src/http/app.ts` (modify) | becomes the root app: mounts `/api` (existing), the OAuth routes and `/mcp`; adds `/api/connections` |
| `src/adapters/cloudflare/worker.ts` (modify) | route `/mcp`, `/oauth/*`, `/.well-known/*` to the app; wire `OAuthService` and the limiter |
| `wrangler.jsonc` (modify) | `run_worker_first` gets the new paths; remove stale Access comments |
| `public/js/next.js` (new) | `safeNext(search)`, the post-login redirect guard |
| `public/js/login.js`, `public/js/connections.js` (new), `public/js/api.js`, `public/js/app.js`, `public/index.html`, `public/sw.js` | redirect after sign-in; Connected apps UI; SW shell list + version bump; remove stale Access comment |
| `test/helpers.ts` (modify) | `connectClaude()` helper (full OAuth flow → MCP caller) |
| `test/oauth-repo.test.ts`, `test/oauth-service.test.ts`, `test/oauth-http.test.ts`, `test/next.test.js`, `test/mcp.test.ts`, `test/mcp-write.test.ts`, `test/connections.test.ts` (new) | tests |
| `README.md` (modify) | architecture, security and setup sections |

---

### Task 1: OAuth storage (migration, port, SQL repo)

**Files:**
- Create: `migrations/0004_oauth.sql`
- Modify: `src/core/errors.ts`, `src/ports/index.ts`, `src/adapters/sql/repos.ts`
- Test: `test/oauth-repo.test.ts`

**Interfaces:**
- Produces, in `ports/index.ts`:

```ts
export interface OAuthClient { id: Id; name: string; redirectUris: string[]; createdAt: string }
export interface OAuthCode {
  codeHash: string; clientId: Id; userId: Id; redirectUri: string;
  codeChallenge: string; resource: string; userAgent: string | null; expiresAt: string;
}
export interface OAuthConnection {
  id: Id; userId: Id; clientId: Id; clientName: string;
  createdAt: string; lastUsedAt: string; expiresAt: string; userAgent: string | null;
}
export interface OAuthToken { tokenHash: string; connectionId: Id; kind: 'access' | 'refresh'; expiresAt: string; rotatedAt: string | null }

export interface OAuthRepo {
  createClient(c: OAuthClient): Promise<void>;
  getClient(id: Id): Promise<OAuthClient | null>;
  createCode(c: OAuthCode & { createdAt: string }): Promise<void>;
  /** Atomically marks the code consumed; returns it only if it was unconsumed and unexpired at `now`. */
  consumeCode(codeHash: string, now: string): Promise<OAuthCode | null>;
  createConnection(c: Omit<OAuthConnection, 'clientName'>): Promise<void>;
  getConnection(id: Id): Promise<OAuthConnection | null>;        // joins client name
  touchConnection(id: Id, lastUsedAt: string, expiresAt: string): Promise<void>;
  listConnections(userId: Id): Promise<OAuthConnection[]>;       // newest first
  /** Deletes the connection and (cascade) its tokens. Scoped by user; false when not found. */
  deleteConnection(userId: Id, id: Id): Promise<boolean>;
  deleteAllConnections(userId: Id): Promise<void>;
  addToken(t: OAuthToken): Promise<void>;
  getToken(tokenHash: string): Promise<OAuthToken | null>;
  /** Sets rotated_at only if it is still null; false if another request already rotated it. */
  markRotated(tokenHash: string, now: string): Promise<boolean>;
  deleteToken(tokenHash: string): Promise<void>;
  deleteExpired(now: string): Promise<void>;                      // codes, tokens, connections past expires_at
}
```

- Produces, in `core/errors.ts`: `export class OAuthError extends Error { constructor(readonly error: string, description: string, readonly status = 400) }`. The `error` field holds an RFC 6749 code: `invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_redirect_uri`, `access_denied`, `invalid_token`.
- Produces `SqlOAuthRepo` (constructor `(db: SqlClient)`).

- [ ] **Step 1: Write the failing tests** in `test/oauth-repo.test.ts`. Build the repo directly: `new SqlOAuthRepo(new D1Client(env.DB))`. Create a user through `login()` from helpers and read their id with `SELECT id FROM users WHERE email = ?`. The tests:
  - `client round-trips redirect_uris`: `getClient` returns `redirectUris` deep-equal to what was stored.
  - `code is single use and expires`:
    - the first `consumeCode` returns the code;
    - the second returns `null`;
    - a code with `expiresAt` in the past returns `null`.
  - `markRotated only once`: first call `true`, second `false`.
  - `deleteConnection cascades tokens and is user-scoped`:
    - called with another user's id, it returns `false`;
    - with the owner's id it returns `true`, after which `getToken` is `null`.
  - `deleting the user cascades connections`: `DELETE FROM users WHERE id = ?` leaves `listConnections` empty.

- [ ] **Step 2: Run** `npx vitest run test/oauth-repo.test.ts`. Expected: FAIL, because `SqlOAuthRepo` is not exported.

- [ ] **Step 3: Write `migrations/0004_oauth.sql`.** Follow `0002`'s style and header comment (portability notes), use STRICT tables, and include:
  - `oauth_clients(id PK, name, redirect_uris TEXT /* JSON array */, created_at)`
  - `oauth_codes(code_hash PK, client_id → oauth_clients ON DELETE CASCADE, user_id → users ON DELETE CASCADE, redirect_uri, code_challenge, resource, user_agent, created_at, expires_at, consumed_at)`
  - `oauth_connections(id PK, user_id → users CASCADE, client_id → oauth_clients CASCADE, created_at, last_used_at, expires_at, user_agent)`, plus indexes on `(user_id)` and `(expires_at)`
  - `oauth_tokens(token_hash PK, connection_id → oauth_connections CASCADE, kind CHECK IN ('access','refresh'), expires_at, rotated_at)`, plus indexes on `(connection_id)` and `(expires_at)`

  D1 enforces foreign keys, so `ON DELETE CASCADE` works.

- [ ] **Step 4: Add `OAuthError`, the port types and `SqlOAuthRepo`** in the style of `SqlSessionRepo`.
  - Implement `consumeCode` as `UPDATE … SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING …`.
  - Implement `markRotated` as `UPDATE … WHERE token_hash = ? AND rotated_at IS NULL`, returning `changes === 1`.

- [ ] **Step 5: Run** `npx vitest run test/oauth-repo.test.ts && npx tsc -p .`. Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add migrations/0004_oauth.sql src/core/errors.ts src/ports/index.ts src/adapters/sql/repos.ts test/oauth-repo.test.ts
git commit -m "OAuth storage: clients, codes, connections, tokens (hashed)"
```

---

### Task 2: OAuthService

**Files:**
- Create: `src/services/oauth.ts`
- Modify: `src/services/config.ts`
- Test: `test/oauth-service.test.ts`

**Interfaces:**
- Consumes: `OAuthRepo`, `UserRepo`, `RateLimiter`, `Clock`, `IdGenerator`, `AppConfig` (Task 1 and existing code).
- Produces, in `config.ts`: `export const OAUTH_DEFAULTS = { redirectHosts: ['claude.ai', 'claude.com'], accessTokenSeconds: 3600, codeSeconds: 60, reuseGraceSeconds: 60 } as const;`
- Produces, in `services/oauth.ts`:

```ts
export interface OAuthDeps { oauth: OAuthRepo; users: UserRepo; limiter: RateLimiter; clock: Clock; ids: IdGenerator; config: AppConfig }
export interface AuthorizeRequest { client: OAuthClient; redirectUri: string; state: string | null; codeChallenge: string; resource: string }
export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string }

export class OAuthService {
  constructor(d: OAuthDeps)
  /** RFC 7591. Returns the registration response body. Always a public client (token_endpoint_auth_method "none"). */
  register(body: Record<string, unknown>, ip: string): Promise<Record<string, unknown>>
  /** Validates authorize query params; `origin` is this server's origin (resource must be `${origin}/mcp` or `${origin}`). */
  checkAuthorize(q: Record<string, string | undefined>, origin: string, ip: string): Promise<AuthorizeRequest>
  /** Issues a code; returns the full redirect URL with code (+ state). */
  approve(userId: Id, req: AuthorizeRequest, userAgent: string | null): Promise<string>
  /** Redirect URL with error=access_denied (+ state). */
  deny(req: AuthorizeRequest): string
  /** grant_type authorization_code (code, redirect_uri, client_id, code_verifier) or refresh_token (refresh_token, client_id). */
  token(form: Record<string, string>, ip: string): Promise<TokenResponse>
  /** RFC 7009: silently succeeds for unknown tokens; revoking a refresh token deletes its connection. */
  revoke(token: string): Promise<void>
  /** Bearer → user + connection, or null (missing/unknown/expired/disabled user). */
  authenticateBearer(token: string | undefined): Promise<{ user: User; connectionId: Id } | null>
  listConnections(userId: Id): Promise<OAuthConnection[]>
  disconnect(userId: Id, id: string): Promise<void>      // notFound('Connection') when missing
  disconnectAll(userId: Id): Promise<void>
}
```

Planner's calls on the rules:

| Area | Rule |
|---|---|
| Registration | `redirect_uris` must be 1–5 entries. `client_name` defaults to `"Claude"` and is cut to 100 characters. |
| Registration errors | `OAuthError('invalid_redirect_uri')`; other registration errors use `invalid_request`. |
| Redirect URI matching | Exact string match against the registered list. For loopback hosts, the port may differ (RFC 8252). |
| Each approval | Creates a **new connection**. The connection's `expiresAt` = now + idle days. |
| Token exchange | Creates an access token (1 h) and a refresh token whose `expiresAt` equals the connection's. |
| On refresh | Mark the old token rotated, issue a new access + refresh pair, and touch the connection: idle extended, capped at `createdAt + max days`. |
| Rotated refresh token reused **within** the grace window | `invalid_grant` only. |
| Rotated refresh token reused **after** the grace window | Delete the connection, then `invalid_grant`. |
| `authenticateBearer` | Touches `last_used_at` at most once an hour. About 2% of calls also run `deleteExpired`. |

- [ ] **Step 1: Write the failing tests** in `test/oauth-service.test.ts`.
  - **Setup:** build the service with the SQL repos over `new D1Client(env.DB)`, a mutable fake clock `{ now: () => current }`, and `config` from a small `testConfig()` defined in the test (mode `open`, the timezone from env). Get a user id via `login()`, then do the PKCE math with `crypto.subtle` (`base64url(sha256(verifier))`).
  - **Tests:**
    - `register rejects non-claude https hosts`: `https://evil.example/cb` → `invalid_redirect_uri`.
    - `register accepts claude.ai and loopback`
    - `authorize rejects plain or missing PKCE`: `code_challenge_method=plain` → `invalid_request`.
    - `authorize rejects unregistered redirect_uri`
    - `loopback redirect may change port`
    - `code exchange needs the right verifier`
      - a wrong verifier → `invalid_grant`;
      - the right one → `TokenResponse` with `expires_in: 3600`;
      - the same code a second time → `invalid_grant`.
    - `code expires after 60 s`: advance the clock 61 s → `invalid_grant`.
    - `refresh rotates`: the new refresh token works, and the old access token stays valid until it expires.
    - `refresh reuse within grace does not revoke`: reusing the old refresh token 10 s after rotation gives `invalid_grant`, and the new refresh token still works.
    - `refresh reuse after grace revokes the connection`: at 61 s, `invalid_grant`, after which the new refresh token fails and `listConnections` is empty.
    - `access token expires after 1 h`: `authenticateBearer` returns `null` at +3601 s.
    - `connection idle 30 d / max 90 d`
      - no refresh for 31 days → refresh fails;
      - refreshing every 20 days still fails at day 91.
    - `disabled user cannot use tokens`: `UPDATE users SET status='disabled'` → `authenticateBearer` returns `null`.
    - `revoke refresh token deletes the connection`
    - `disconnect is scoped to the user`: another user's id → not_found.

- [ ] **Step 2: Run** `npx vitest run test/oauth-service.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `OAUTH_DEFAULTS` and `OAuthService`** to the interface and rules above. Use `this.d.limiter.hit` with the Global Constraints keys for `register`, `checkAuthorize` and `token`, and throw `AppError('rate_limited', …)` exactly the way `AuthService.limit` does.

- [ ] **Step 4: Run** `npx vitest run test/oauth-service.test.ts && npx tsc -p .`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/oauth.ts src/services/config.ts test/oauth-service.test.ts
git commit -m "OAuthService: DCR, PKCE codes, rotating refresh tokens with reuse detection"
```

---

### Task 3: OAuth HTTP routes, consent page, routing, sign-in redirect

**Files:**
- Create: `src/http/cookies.ts`, `src/http/oauth.ts`, `public/js/next.js`
- Modify: `src/http/app.ts`, `src/adapters/cloudflare/worker.ts`, `wrangler.jsonc`, `public/js/login.js`, `public/sw.js`, `test/helpers.ts`
- Test: `test/oauth-http.test.ts`, `test/next.test.js`

**Interfaces:**
- Consumes: `OAuthService` (Task 2), `AuthService.authenticate`.
- Produces:
  - `AppDeps` gains `oauth: OAuthService` and `limiter: RateLimiter`.
  - `createApp(d)` now returns the **root** Hono app. It mounts the existing `/api` routes unchanged, the routes from `oauthRoutes(d)`, and `/mcp`. In this task `/mcp` is only a stub that answers POSTs with 401 + `WWW-Authenticate`.
  - `export function oauthRoutes(d: AppDeps): Hono` in `http/oauth.ts`.
  - `export function cookieName(c: Context): string` and `export function isHttps(c: Context): boolean` in `http/cookies.ts`.
  - `export function safeNext(search: string, origin: string): string | null` in `public/js/next.js`. It returns the path+query only for a same-origin `next` whose pathname is exactly `/oauth/authorize`; anything else gives `null`.
  - In `test/helpers.ts`:
    - `export async function connectClaude(email?: string): Promise<{ email: string; accessToken: string; refreshToken: string; cookie: string; mcp: (method: string, params?: unknown) => Promise<any>; raw: (body: unknown, headers?: Record<string,string>) => Promise<Response> }>`. It runs register → authorize (with the cookie) → consent POST → token. Its `mcp` POSTs a JSON-RPC request with an incrementing id to `/mcp` and returns the parsed `result` (or the `error` object).
    - `export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'`

Routes in `http/oauth.ts`. Each one sets `Cache-Control: no-store`, and none of them is behind the `/api` CSRF origin middleware.

| Route | Behaviour |
|---|---|
| `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | `{ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Hisaab' }` |
| `GET /.well-known/oauth-authorization-server` | `{ issuer: origin, authorization_endpoint, token_endpoint, registration_endpoint, revocation_endpoint, response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }` |
| `POST /oauth/register` | JSON in, `201` JSON out; `OAuthError` → `400 { error, error_description }` |
| `GET /oauth/authorize` | See below |
| `POST /oauth/authorize` | The consent form submission. See below |
| `POST /oauth/token` | Form-encoded body. `OAuthError` → `{ error, error_description }` with its status |
| `POST /oauth/revoke` | Form-encoded `token`; always `200` |

`origin` = `new URL(c.req.url).origin`.

**`GET /oauth/authorize`:**
1. Run `checkAuthorize`. On an error, render a plain HTML error page with status 400, and **don't redirect**.
2. If `authenticate(cookie)` returns `null`, respond `302` to `/?next=` + `encodeURIComponent(path+query)`.
3. Otherwise, render the consent page. It shows:
   - the email, the client name and the redirect host;
   - the text "Allow Claude to read and change your Hisaab data";
   - **Allow** and **Deny** buttons in a form that POSTs to `/oauth/authorize`, with every authorize param as a hidden input plus `csrf` = `hmac(config.auth.secret, 'consent:' + sha256(sessionToken))`.

The page is styled with `/vendor/oat.min.css` and `/css/app.css`. It sets its own CSP header: `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self' <redirect origin>; frame-ancestors 'none'; base-uri 'none'`. Escape every interpolated value.

**`POST /oauth/authorize`:**
1. Require an `Origin` equal to `origin` (403 otherwise), a valid session (otherwise the same redirect to sign-in), and a valid `csrf` (403 otherwise).
2. Re-run `checkAuthorize`.
3. `decision=allow` → `302` to `approve(...)`; anything else → `302` to `deny(...)`.

- [ ] **Step 1: Write failing tests.**
  - **`test/next.test.js`:**
    - `safeNext('?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx', 'https://h')` returns `'/oauth/authorize?client_id=x'`;
    - `null` for `https://evil.com/oauth/authorize`, `//evil.com/oauth/authorize`, `/api/me`, `/oauth/authorizeX`, `javascript:alert(1)`, and for no `next` at all.
  - **`test/oauth-http.test.ts`:**
    - `metadata documents`: both `.well-known` responses deep-equal the shapes above with origin `http://localhost`.
    - `mcp without token is 401 with resource_metadata`: `WWW-Authenticate` contains `resource_metadata="http://localhost/.well-known/oauth-protected-resource"`.
    - `authorize signed out redirects to sign-in`: `302` with `location` starting `/?next=%2Foauth%2Fauthorize`.
    - `authorize with expired cookie redirects to sign-in`: delete the session row, keep the cookie → same `302`.
    - `consent page shows email and client`: `200` HTML containing the email, the `CSP form-action` with `https://claude.ai`, and `name="csrf"`.
    - `consent POST without csrf is 403`, and `consent POST from another Origin is 403`.
    - `deny redirects with access_denied and state`
    - `full flow via connectClaude`: tokens are returned.
    - `token endpoint errors are RFC 6749 JSON`: a bad code → `400 { error: 'invalid_grant' }`.
    - `web cookie is not accepted on /mcp`, and `bearer token is not accepted on /api/me` (401).

- [ ] **Step 2: Run** `npx vitest run test/next.test.js test/oauth-http.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Cookies:** move `cookieName` and `isHttps` into `http/cookies.ts`.
  - **Root app:** restructure `createApp` into a root app that mounts the `/api` sub-app. Existing tests must keep passing unchanged.
  - **`http/oauth.ts`:** add the routes and the `/mcp` 401 stub.
  - **`worker.ts`:**
    - send pathnames starting with `/api/`, `/oauth/` and `/.well-known/`, and exactly `/mcp`, to the app;
    - construct `OAuthService` with `new SqlOAuthRepo(db)` and the shared `SqlRateLimiter`;
    - pass `oauth` and `limiter` into `createApp`.
  - **`wrangler.jsonc`:** set `run_worker_first` to `["/api/*", "/mcp", "/oauth/*", "/.well-known/*"]`. Rewrite the two stale Access comments to describe the current setup (own email-code sign-in; `workers_dev` / preview URLs off so the app is served only on the custom domain).
  - **`login.js`:** after a successful `verifyCode`, `const next = safeNext(location.search, location.origin); if (next) { location.assign(next); return; }`, before `onSignedIn(me)`.
  - **`sw.js`:** add `'/js/next.js'` to `SHELL`, bump `VERSION` to `hisaab-v10`, and change the comment "so an expired Access session redirects to login" to "so a signed-out page always comes from the server".

- [ ] **Step 4: Run** `npm test && npx tsc -p .`. Expected: all tests PASS, old and new.

- [ ] **Step 5: Commit**

```bash
git add -A src/http src/adapters/cloudflare/worker.ts wrangler.jsonc public/js/next.js public/js/login.js public/sw.js test/helpers.ts test/next.test.js test/oauth-http.test.ts
git commit -m "OAuth endpoints, consent page, and sign-in redirect back to Claude"
```

---

### Task 4: MCP endpoint and read-only tools

**Files:**
- Create: `src/http/mcp.ts`, `src/http/mcp-tools.ts`
- Modify: `src/http/app.ts` (replace the `/mcp` stub), `src/services/expenses.ts`, `public/js/money.js`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `connectClaude()` (Task 3); `OAuthService.authenticateBearer`; the services.
- Produces:

```ts
// mcp-tools.ts
export interface ToolDef {
  name: string; title: string; description: string;
  inputSchema: Record<string, unknown>;                 // JSON Schema, type: 'object', additionalProperties: false
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint: boolean; openWorldHint: false };
  run(user: User, args: Record<string, unknown>): Promise<unknown>;
}
export function buildTools(d: AppDeps): ToolDef[];
export const SERVER_INSTRUCTIONS: string;
export function toolExpense(e: Expense): Record<string, unknown>;   // expenseJson fields, money via toRupeeFixed

// mcp.ts
export function mcpRoutes(d: AppDeps): Hono;

// expenses.ts
export interface ExpenseSearch { categoryId?: string | null; personId?: string | null; text?: string | null; minAmount?: unknown; maxAmount?: unknown }
ExpenseService.search(userId: Id, q: PeriodQuery, s: ExpenseSearch): Promise<Expense[]>

// money.js
export function toRupeeFixed(paise: number): string   // 45000 -> "450.00", 1 -> "0.01"
```

**JSON-RPC behaviour** (`POST /mcp`, one JSON object per request):
1. **Origin check:** if an `Origin` header is present and is not this origin, `https://claude.ai` or `https://claude.com`, respond 403 (MCP DNS-rebinding guard).
2. **Bearer auth:** `Authorization: Bearer …` → `authenticateBearer`. If that fails, respond 401 with `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
3. **Rate limit:** `limiter.hit('mcp-user:'+id, 120, 60)`. Over the limit → HTTP 429.
4. **Body:**
   - A non-object body, or an array (batching) → `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,…}}`.
   - A message with no `id` (a notification) → `202` with an empty body.
5. **Methods:**

| Method | Result |
|---|---|
| `initialize` | `{ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'hisaab', title: 'Hisaab', version: '1.0.0' }, instructions: SERVER_INSTRUCTIONS }`. `protocolVersion` = the client's requested version if it is in `['2025-11-25','2025-06-18','2025-03-26']`, else `'2025-11-25'`. |
| `ping` | `{}` |
| `tools/list` | `{ tools: [{ name, title, description, inputSchema, annotations }] }` |
| `tools/call` | Unknown tool → `-32602`. Otherwise `{ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }`. An `AppError` → `{ content: [{ type: 'text', text: err.message }], isError: true }`. Any other error → logged via `d.log`, then `isError` with the text `Something went wrong, try again`. |
| anything else | `-32601` |

`GET` and `DELETE` on `/mcp` → `405`.

**`SERVER_INSTRUCTIONS`** carry the five points from the spec's "Server instructions" bullet, in plain sentences.

**Read tools (this task):**
- `get_context` → `{ email, today, time_zone, currency: 'INR' }`
- `list_expenses`. Arguments: `month?`, `year?`, `category_id?`, `person_id?`, `text?`, `min_amount?`, `max_amount?`. Returns `{ period: {type, key}, expenses: toolExpense[] }`. `text` is a case-insensitive substring match on the note, the category name or any share's person name; the amount filters apply to `paid`.
- `get_summary`: the `SummaryService.summary` output, with every paise field converted to rupees. Those fields are `my_spend`, `paid_for_others`, `prev.total`, `prev.same_point`, `baseline.avg_total`, `buckets[].amount`, `prev_buckets[].amount`, `by_category[].amount`, `by_category[].baseline_avg`, `trend[].amount`, `splits.paid`, `splits.my_share`, `by_person[].amount` and `unassigned`; `top` is mapped with `toolExpense`.
- `get_category_summary`, `get_person_summary`: arguments `{ id, month?, year? }`; money converted the same way.
- `list_categories` → `{ categories, icons: [...ICON_NAMES], colors: [...COLOR_NAMES] }`
- `list_people` → `{ people }`

All of these are `readOnlyHint: true, idempotentHint: true`.

- [ ] **Step 1: Write the failing tests** in `test/mcp.test.ts`, using `connectClaude()`.
  - `initialize negotiates version and returns instructions`: requested `'2025-06-18'` → same version back; `'1999-01-01'` → `'2025-11-25'`; `instructions` contains `Asia/Kolkata`.
  - `notification returns 202`
  - `batch array is rejected`: error code `-32600`.
  - `tools/list has all read tools with annotations`: the 7 read tools are present, each with `readOnlyHint: true`, `openWorldHint: false` and a `title`.
  - `get_context uses Asia/Kolkata`: unit-test `buildTools` with a deps object whose `categories.today()` comes from a clock fixed at `2026-10-22T19:00:00Z` → `today: '2026-10-23'`.
  - `list_expenses filters`: seed 3 expenses through the `/api` cookie client; `text: 'ravi'` matches by person, `min_amount: 200` filters, and amounts look like `"450.00"`.
  - `get_summary returns rupee strings`: `my_spend` matches `/^\d+\.\d{2}$/`.
  - `unknown tool is -32602`
  - `rate limit`: 121 calls inside one minute → the last one is HTTP 429. Keep the test fast by calling `ping`.
  - `foreign Origin is 403`, and `GET /mcp is 405`.
  - `user isolation on reads`: user B's `get_category_summary` with user A's category id → `isError: true` with `Category not found`.

- [ ] **Step 2: Run** `npx vitest run test/mcp.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `toRupeeFixed`, `ExpenseService.search` (call `listInRange` with `{categoryId, personId}`, then filter in memory), `mcp-tools.ts` (read tools), and `mcp.ts`, and mount `mcpRoutes` in `createApp`.

- [ ] **Step 4: Run** `npm test && npx tsc -p .`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/mcp.ts src/http/mcp-tools.ts src/http/app.ts src/services/expenses.ts public/js/money.js test/mcp.test.ts
git commit -m "MCP endpoint with read-only tools"
```

---

### Task 5: Write tools and partial expense edits

**Files:**
- Modify: `src/http/mcp-tools.ts`, `src/services/expenses.ts`
- Test: `test/mcp-write.test.ts`

**Interfaces:**
- Consumes: `buildTools`, `ToolDef`, `toolExpense` (Task 4).
- Produces: `ExpenseService.patch(userId: Id, rawId: string, patch: Record<string, unknown>): Promise<Expense>`.

**Tools added** (inputs follow `validate.ts` names; every write returns the full saved record via `toolExpense`, `categoryJson` or `personJson`):

| Tool | Arguments | Annotations |
|---|---|---|
| `add_expense` | `paid`, `spent_on`, `category`, `note?`, `my_share?`, `shares?: [{person, amount}]`, `category_icon?`, `category_color?` | `readOnlyHint:false, destructiveHint:false, idempotentHint:false` |
| `update_expense` | `id` + any of the `add_expense` fields | `destructiveHint:true, idempotentHint:true` |
| `delete_expense` | `id` → `{ ok: true, deleted: <toolExpense of the expense before deletion> }` | `destructiveHint:true, idempotentHint:true` |
| `create_category` | `name`, `icon?`, `color?` | `destructiveHint:false, idempotentHint:false` |
| `update_category` | `id`, `name?`, `icon?`, `color?` | `destructiveHint:true, idempotentHint:true` |
| `delete_category` | `id` → `{ ok: true, moved }`. Description: *Deletes one category. Its expenses move to "Other". "Other" cannot be deleted.* | `destructiveHint:true, idempotentHint:true` |
| `add_person` | `name` | `destructiveHint:false, idempotentHint:false` |
| `rename_person` | `id`, `name` | `destructiveHint:true, idempotentHint:true` |
| `delete_person` | `id` → `{ ok: true }`. Description: *Deletes one person. Their shares on past expenses become unassigned.* | `destructiveHint:true, idempotentHint:true` |

The `add_expense` description says new categories and people named here are created automatically. The `update_expense` description explains partial edits and the split rule below.

**`ExpenseService.patch` merge rules:**
1. Load the current expense with `get`, or `notFound('Expense')`.
2. **Ask, don't guess:** throw `AppError('validation', …)` when all of these hold:
   - `'paid' in patch`;
   - `toPaise(patch.paid)` is valid and differs from `current.paid`;
   - `current.shares.length > 0` or `current.myShare < current.paid`;
   - neither `'shares'` nor `'my_share'` is in `patch`.

   The message is `This expense is split (you ₹150, Ravi ₹150, Sam ₹150). Send the new shares for ₹600.` Build it with `formatINR`. The list contains "you" plus each share in order, then `unassigned ₹X` when the shares and my share don't add up to the amount paid.
3. Build a full body from `current`, overriding with each key present in `patch`. A key set to `null` clears `note`.
   - `shares` defaults to the current shares as `{person: name, amount: toRupeeString}`.
   - `category` defaults to the current category name.
   - `my_share`:
     - when `my_share` is in `patch`, use it;
     - else, when `shares` is in `patch`, leave it out (the validator works it out);
     - else, use the current `toRupeeString(myShare)`.
4. Call `this.update(userId, id, body)`.

- [ ] **Step 1: Write the failing tests** in `test/mcp-write.test.ts`, using `connectClaude()`.
  - `tools/list has 16 tools with spec annotations`: check the full name→annotation table above.
  - `add_expense creates category and person on the fly`: category `Snacks` and person `Ravi` then appear in `list_categories` / `list_people`.
  - `add_expense accepts numeric amounts`: `paid: 449.5` → `paid: "449.50"`.
  - `add_expense validation error is isError with service message`: `my_share` greater than `paid` → `isError`, text contains `cannot be more than`.
  - `update_expense changes only the note`: the amount, category and shares are unchanged.
  - `update_expense null note clears it`
  - `update_expense refuses amount change on a split`: ₹450 split you/Ravi/Sam at 150 each, `{id, paid: 600}` → `isError`, the text contains `This expense is split (` and `Send the new shares for ₹600`, and the stored expense is unchanged.
  - `update_expense amount change with new shares works`: `{id, paid: 600, shares: [{person:'Ravi',amount:200},{person:'Sam',amount:200}]}` → `my_share: "200.00"`.
  - `update_expense refuses amount change when my_share < paid with no people`
  - `update_expense on unsplit expense changes amount freely`: `my_share` follows `paid`.
  - `delete_expense returns the deleted record`, and a second call gives `isError` `Expense not found`.
  - `delete_category moves to Other; Other cannot be deleted`
  - `delete_person leaves amounts unassigned`: `get_summary.unassigned` goes up.
  - `user isolation on writes`: user B's `update_expense` / `delete_expense` / `rename_person` on user A's ids → `isError` not found, and A's data is unchanged.

- [ ] **Step 2: Run** `npx vitest run test/mcp-write.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `ExpenseService.patch` and the 9 write tools.

- [ ] **Step 4: Run** `npm test && npx tsc -p .`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/mcp-tools.ts src/services/expenses.ts test/mcp-write.test.ts
git commit -m "MCP write tools; partial expense edits that ask before re-splitting"
```

---

### Task 6: Connected apps (API, Account card, log out everywhere)

**Files:**
- Create: `public/js/connections.js`
- Modify: `src/http/app.ts`, `public/js/api.js`, `public/js/app.js`, `public/index.html`, `public/sw.js`
- Test: `test/connections.test.ts`

**Interfaces:**
- Consumes: `OAuthService.listConnections / disconnect / disconnectAll`.
- Produces:
  - `GET /api/connections` → `{ connections: [{ id, name, created_at, last_used_at }] }`;
  - `DELETE /api/connections/:id` → `{ ok: true }`, or 404;
  - `api.connections()` and `api.disconnect(id)` in `api.js`;
  - `export async function renderConnections()` in `connections.js`.

- [ ] **Step 1: Write failing tests** in `test/connections.test.ts`.
  - `lists the Claude connection`: after `connectClaude()`, `GET /api/connections` with its cookie has one entry, named `Claude`.
  - `disconnect kills MCP access`: `DELETE` → the next `raw({jsonrpc:'2.0',id:1,method:'ping'})` has status 401.
  - `log out everywhere disconnects Claude`
  - `cannot see or delete another user's connection`: 404, and the list doesn't include it.

- [ ] **Step 2: Run** `npx vitest run test/connections.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Routes:** add the two `/api` routes, and make the `/auth/logout-everywhere` handler also call `d.oauth.disconnectAll(userId)`.
  - **`index.html`:** add `<div class="connections" data-connections></div>` inside the Account card, under the "Signed in as" line, with a small "Connected apps" label.
  - **`connections.js`:**
    - render one row per connection: name, "Connected <date>", "Last used <date>", and a `ghost small` **Disconnect** button with `data-action="disconnect-app"` and `data-id`;
    - with no connections, show the line `No apps connected. Add Hisaab to Claude with https://hisaab.aakashjammula.com/mcp`, using `location.origin + '/mcp'` so local dev shows the right URL.
  - **`app.js`:**
    - call `renderConnections()` when the categories view renders;
    - handle `disconnect-app` with the same confirm pattern the app uses for other deletes, then re-render.
  - **`sw.js`:** add `/js/connections.js` to `SHELL` (`VERSION` is already bumped in Task 3; bump it again to `hisaab-v11` only if Task 3 has already been deployed).

- [ ] **Step 4: Run** `npm test && npx tsc -p .`. Expected: PASS. Then run `npm run db:migrate:local && npm run dev`, and check the Account card shows the empty state at http://localhost:8787 (sign-in code printed in the terminal).

- [ ] **Step 5: Commit**

```bash
git add src/http/app.ts public/js/connections.js public/js/api.js public/js/app.js public/index.html public/sw.js test/connections.test.ts
git commit -m "Connected apps on the Account card; log out everywhere disconnects Claude"
```

---

### Task 7: Docs and acceptance checklist

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `README.md`.**
  - **Architecture tree:** add `http/oauth.ts`, `http/mcp.ts` and `http/mcp-tools.ts`.
  - **New "Use with Claude (MCP)" section:**
    - the URL;
    - the claude.ai steps: Settings → Connectors → Add custom connector;
    - the Claude Code command: `claude mcp add --transport http hisaab https://hisaab.aakashjammula.com/mcp`;
    - what Claude can do;
    - that edits and deletes ask first.
  - **Security section, OAuth bullets:**
    - PKCE S256;
    - redirect allow-list;
    - hashed tokens;
    - 1 h access tokens;
    - rotating refresh tokens with reuse detection;
    - 30/90-day connection limits;
    - Disconnect and log out everywhere.
  - **Deploy section:**
    - run `npm run db:migrate:remote` before `npm run deploy`;
    - extend the WAF rate-limit rule to `/oauth/*`.

- [ ] **Step 2: Run** `npm test && npx tsc -p .`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: using Hisaab from Claude over MCP"
```

- [ ] **Step 4: Hand over to the owner** (they run these; do not push or deploy yourself):
  1. `git push`, `npm run db:migrate:remote`, `npm run deploy`.
  2. Cloudflare dashboard: add `/oauth/*` to the "Login flood protection" WAF rule.
  3. `claude mcp add --transport http hisaab https://hisaab.aakashjammula.com/mcp`, sign in, then ask Claude Code to log a test expense.
  4. claude.ai → add a custom connector with the same URL, then log an expense from the phone app.
  5. Check the expense appears in the web app; then Disconnect on the Account card and check Claude loses access.

  If claude.ai fails at step 4 with a registration error, check Anthropic's current custom-connector docs to see whether Client ID Metadata Documents are now required. Adding them is a follow-up, not part of this plan.
