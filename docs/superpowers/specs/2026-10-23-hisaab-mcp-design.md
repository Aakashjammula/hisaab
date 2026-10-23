# Hisaab MCP connector: design

Date: 2026-10-23 · Status: draft, awaiting approval

## Intent

The goal is to let Claude use Hisaab the way the owner does. Anything a human can do in the app, Claude should be able to do through MCP, from all three places the owner uses Claude:

- the Claude phone app,
- claude.ai on the web,
- Claude Code on the laptop.

The typical use is "log 450 for lunch with Ravi, split 3 ways", or "how much did I spend on food in September?", without opening the app.

Hisaab stays what it is: a tracker for the owner's **own spending**. GPay handles getting money back, so there are no balances and no settle-up.

## Goals

1. Add a remote MCP endpoint, `https://hisaab.aakashjammula.com/mcp`, served by the existing Worker.
2. Add one OAuth login that works in all three clients. The owner adds Hisaab once as a custom connector in claude.ai, and it then appears on the phone too. In Claude Code they run `claude mcp add --transport http hisaab https://hisaab.aakashjammula.com/mcp`.
3. Expose MCP tools that cover everything the app's API does today: expenses, categories, people, and summaries.
4. Make the tools call the **same `services/` layer** the web app uses, so validation and rules can't drift apart.
5. Let Claude create categories and people freely, exactly as the app already does when an expense names a new one.
6. Add a "Connected apps" section on the Account card. It lists each Claude connection with a Disconnect button, and "Log out everywhere" disconnects these too.

## Non-goals

- No features the app doesn't already have. In particular: no balances, no settle-up, no reminders.
- No bulk operations, such as "delete all of March" or "re-categorise everything".
- No sign-in, logout, or account tools for Claude. Proving who you are stays a human step.
- No MCP resources, prompts, or UI widgets. Tools only.
- No submission to Anthropic's public connector directory. This is a private connector for the owner.
- No change to how the web app looks or behaves, beyond the sign-in redirect and the Account card section described below.

## Anti-goals: a failure even if it "works"

- Any weakening of the web app's sign-in, such as looser rate limits, longer code lifetimes, or skipping the allow-list.
- Claude being able to see or change another user's data. Every tool is scoped to the token's user, as every route is today.
- Platform-specific code leaking into `core/`, `services/` or `http/`. The README's promise to stay portable to AWS still holds: OAuth storage goes behind ports with SQL adapters, not Cloudflare KV or Durable Objects.
- Tokens stored in plain form. As with sessions, only hashes are stored.
- A web session cookie working as an MCP credential, or an MCP token working as a web session.

## Current state (what the builder starts from)

- Cloudflare Worker + D1, TypeScript, Hono, hexagonal layout (`src/core`, `src/ports`, `src/services`, `src/http`, `src/adapters/{sql,cloudflare}`).
- `src/http/app.ts`: `createApp(deps)` uses `basePath('/api')`. A middleware blocks cross-origin non-GET requests (a CSRF check). Session cookie name: `__Host-hisaab_session`.
- `src/adapters/cloudflare/worker.ts`: sends only paths starting with `/api/` to the app. Everything else is served from static assets with an SPA fallback. In `wrangler.jsonc`, `assets.run_worker_first` is `["/api/*"]`.
- Sign-in: 8-digit email codes, AUTH_MODE `closed`, sessions with 30 days idle and 90 days max, and a "Log out everywhere" option (`AuthService.logoutEverywhere`).
- Expense input (`core/validate.ts`) takes amounts as **rupee strings** with at most 2 decimals. Categories and people are given **by name** and created if missing. Shares must add up to the amount paid. The date is `YYYY-MM-DD`.
- Updating an expense (`ExpenseService.update`) is a **full replace**, not a partial update.
- Deleting a category moves its expenses to the locked "Other" category. Deleting a person removes their shares, so those amounts become "unassigned".
- Periods are `month=YYYY-MM` or `year=YYYY`, and "today" is worked out in `TIME_ZONE` (Asia/Kolkata).
- Tests: vitest running inside the Workers runtime against a real local D1 (`test/`).
- Migrations run in order: `0001`–`0003`. The next one is `0004`.
- **Cloudflare Access is no longer in front of the site.** Checked on 2026-10-23: `GET /api/me` returns the app's own JSON 401, not an Access redirect. Anthropic's servers and Claude Code can reach `/mcp` and `/oauth/*` directly, so no Access bypass rules are needed. The comments in `wrangler.jsonc` and `public/sw.js` that still mention Access are out of date; clean them up as part of this work. Also note that `/.well-known/*` currently gets the SPA's HTML, which is why the routing change below matters.

## Design

### URLs and routing

| Path | Purpose |
|---|---|
| `/mcp` | MCP Streamable HTTP endpoint (POST; GET returns 405) |
| `/.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) | RFC 9728 resource metadata, pointing at this server as the authorization server |
| `/.well-known/oauth-authorization-server` | RFC 8414 authorization server metadata |
| `/oauth/register` | Dynamic client registration (RFC 7591) |
| `/oauth/authorize` | Authorization endpoint. Shows the consent page |
| `/oauth/token` | Token endpoint: `authorization_code` with PKCE S256, and `refresh_token` |
| `/oauth/revoke` | Token revocation (RFC 7009) |
| `/api/connections` (GET), `/api/connections/:id` (DELETE) | Cookie-session API used by the Account card |

- Add `/mcp`, `/oauth/*` and `/.well-known/*` to `run_worker_first`, and make `worker.ts` send them to the app instead of to assets.
- The OAuth and MCP routes live in the platform-neutral `http/` layer, for example `http/oauth.ts` and `http/mcp.ts` mounted next to the `/api` app. They are **not** subject to the `/api` cookie-auth middleware.
- The OAuth endpoints don't go through the `/api` CSRF origin check either. The consent form POST gets its own CSRF protection: a same-origin check plus a per-request token tied to the session.
- Unauthenticated `/mcp` requests return `401` with `WWW-Authenticate: Bearer resource_metadata="https://hisaab.aakashjammula.com/.well-known/oauth-protected-resource"`.

### OAuth flow

1. Claude discovers the metadata and registers itself through dynamic client registration.
   - **Builder must check** the current MCP authorization spec and Anthropic's custom-connector docs at build time. Recent sources say Client ID Metadata Documents are the newer preferred mechanism, and that claude.ai is stricter than Claude Code.
   - Implement what claude.ai actually needs. Support both mechanisms if that's cheap.
2. Claude opens `/oauth/authorize` in the owner's browser. The server validates `client_id`, `redirect_uri`, `code_challenge` (S256 only), `state`, and `resource`.
3. **If there's no valid web session**, the server redirects to the app's sign-in, `/?next=<url-encoded authorize URL>`.
   - The existing email-code sign-in runs unchanged, with the same rate limits, daily caps, lock, and allow-list.
   - After a successful verify, `public/js/login.js` sends the browser to `next`, but only if `next` is a same-origin path starting with `/oauth/authorize`. Otherwise it is ignored.
4. **Consent page** (server-rendered HTML, styled like the app with Oat and the existing CSS). It shows:
   - the signed-in email,
   - the client's name and redirect host,
   - "Allow Claude to read and change your Hisaab data", with **Allow** and **Deny** buttons.
5. **Allow** issues a single-use authorization code, valid for 60 seconds and stored as a hash, then redirects to `redirect_uri` with `code` and `state`. **Deny** redirects with `error=access_denied`.
6. At `/oauth/token`, Claude exchanges the code with its PKCE verifier and receives an access token and a refresh token.

**Redirect URI policy (my call):** registration only accepts redirect URIs on `claude.ai` or `claude.com` over https, or loopback `http://localhost:<port>` and `http://127.0.0.1:<port>` for Claude Code. Since this is a private app, the narrow allow-list adds defence at no cost. Keep the list in config so it can be widened if a Claude client uses another host.

**Tokens (my call):**

| Token | Format | Lifetime |
|---|---|---|
| Access token | Random 256-bit, opaque | 1 hour |
| Refresh token | Random 256-bit, opaque, rotated on every use | Same idle and absolute limits as web sessions: 30 days idle, 90 days max |

- Only SHA-256 hashes are stored.
- If a refresh token that was already rotated away is presented again, the whole connection is revoked (reuse detection).

A **connection** (grant) is one client authorised by one user. It holds the client name, created_at, last_used_at, and the user agent at consent. Disconnecting it deletes all of its tokens.

`logoutEverywhere(userId)` also deletes all of that user's connections. Disabling a user (`status = 'disabled'`) makes their MCP tokens fail too.

### Storage (migration `0004_oauth.sql`)

There are four new STRICT tables, written in the same portable style as `0002`: text UUID v7 ids, ISO-8601 UTC timestamps, and hashes instead of secrets.

| Table | Contents |
|---|---|
| `oauth_clients` | id, name, redirect_uris as JSON text, created_at |
| `oauth_codes` | code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_at, consumed_at |
| `oauth_connections` | id, user_id, client_id, created_at, last_used_at, expires_at, user_agent |
| `oauth_tokens` | token_hash, connection_id, kind (`access` / `refresh`), expires_at, rotated_at |

- Foreign keys cascade from users and connections.
- Add indexes on user_id and expires_at.
- Expired rows get cleaned up opportunistically, the way `sessions.deleteExpired` is used today.

New ports go in `ports/index.ts`, such as `OAuthClientRepo`, `OAuthCodeRepo`, and `OAuthConnectionRepo` (which also covers tokens). Their SQL adapters go in `adapters/sql/repos.ts`, and a new `services/oauth.ts` holds the rules.

### MCP server

- **Transport:** Streamable HTTP, **stateless**. There are no MCP sessions, every POST carries the bearer token, and responses are plain JSON with no SSE. It must handle `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`.
- **Library:** the builder decides. Prefer the official `@modelcontextprotocol/sdk`, using its web-standard Streamable HTTP transport, if it runs on Workers without heavy Node compat. A small hand-written JSON-RPC handler is acceptable too, since the surface is small.
- **Protocol version:** target the newest version Claude's clients support at build time.
- **Server instructions** (sent on `initialize`) tell Claude that:
  - amounts are in Indian rupees,
  - dates are in Asia/Kolkata, and Claude should call `get_context` for today's date rather than guess,
  - "my share" means what the owner personally spent,
  - before editing or deleting, find the exact item with `list_expenses` and act on its `id`,
  - categories and people named in `add_expense` are created automatically if they don't exist.
- **Errors:** an `AppError` from a service becomes a tool result with `isError: true` and the plain-language message, such as "Your share and everyone else's must add up to the amount paid", so Claude can correct itself and retry. Unexpected errors return a generic message and are logged.
- **Rate limit:** each user gets 120 tool calls per minute through the existing `RateLimiter`. `/oauth/register`, `/oauth/token` and `/oauth/authorize` also get per-IP limits. Extend the existing Cloudflare WAF rule to cover `/oauth/*`.

### Tools

Every tool has a `title` and the MCP annotations shown below. "Destructive" (`destructiveHint: true`) means Claude's apps will normally ask the owner before running it.

- **Inputs:** amounts are rupee numbers or strings with up to 2 decimals, the same as `validate.ts`. Dates are `YYYY-MM-DD`. A period is either `month` (`YYYY-MM`) or `year` (`YYYY`); if neither is given, it defaults to the current month.
- **Outputs:**
  - Every tool returns `structuredContent`, plus the same data as JSON text.
  - Amounts are given in rupees, as decimal strings such as `"450.00"`, not paise. (My call: this removes any chance of Claude misreading paise as rupees.)
  - Each expense uses the same fields as `expenseJson`.
  - Every write returns the full saved record.

| Tool | What it does | readOnly | destructive | idempotent |
|---|---|---|---|---|
| `get_context` | Signed-in email, today's date, timezone, currency | ✓ | | ✓ |
| `list_expenses` | Expenses in a period. Optional filters: `category_id`, `person_id`, `text` (case-insensitive match on note/category/person names), `min_amount`, `max_amount` | ✓ | | ✓ |
| `get_summary` | Same data as `GET /api/summary` | ✓ | | ✓ |
| `get_category_summary` | Same as `GET /api/categories/:id/summary` | ✓ | | ✓ |
| `get_person_summary` | Same as `GET /api/people/:id/summary` | ✓ | | ✓ |
| `list_categories` | Categories with usage counts, plus the allowed icon and colour names | ✓ | | ✓ |
| `list_people` | People with usage counts | ✓ | | ✓ |
| `add_expense` | `paid`, `spent_on`, `category` (name), optional `note`, `my_share`, `shares: [{person, amount}]`, `category_icon`, `category_color` | | ✗ | ✗ |
| `update_expense` | `id` plus **only the fields to change**. The tool reads the current expense, merges the change, then calls the existing full-replace `ExpenseService.update`. Sending `shares: []` removes the split. (My call: partial edits are much safer for an AI than having to resend every field.) **Owner's decision, "ask, don't guess":** if `paid` changes on an expense that has shares, or whose `my_share` is less than `paid`, and the call doesn't also send `shares` and/or `my_share`, the tool refuses. It returns `isError` with the current split, e.g. "This expense is split (you ₹150, Ravi ₹150, Sam ₹150). Send the new shares for ₹600". Claude then asks the owner how to split. The tool description says this. It never rescales, and it never pushes the difference onto my_share. | | ✓ | ✓ |
| `delete_expense` | One expense by `id` | | ✓ | ✓ |
| `create_category` | `name`, optional `icon`, `color` | | ✗ | ✗ |
| `update_category` | `id`, optional `name`, `icon`, `color` | | ✓ | ✓ |
| `delete_category` | One category by `id`. Its description must say the expenses move to "Other", and that "Other" can't be deleted | | ✓ | ✓ |
| `add_person` | `name` | | ✗ | ✗ |
| `rename_person` | `id`, `name` | | ✓ | ✓ |
| `delete_person` | One person by `id`. Its description must say their shares become unassigned | | ✓ | ✓ |

- All tools set `openWorldHint: false`.
- A `list_expenses` filter that isn't supported by the repo today (`person_id` is already in `ExpenseFilter`; `text` and the amount range aren't) may be applied in the service after `listInRange`, since one user's month or year of data is small.

### Account card: Connected apps

The Account card on the web app gets a "Connected apps" list. Each row shows:

- the client name,
- when it was connected,
- when it was last used,
- a **Disconnect** button, which calls `DELETE /api/connections/:id`.

If there are no connections, the list shows a short line: "No apps connected. Add Hisaab to Claude with `https://hisaab.aakashjammula.com/mcp`".

## Testing

Use the existing vitest setup in the Workers pool, against local D1:

- **Discovery:** `/mcp` with no token returns 401 with the right `WWW-Authenticate`. Both metadata documents are correct.
- **Full OAuth flow:** register, authorize (signed out, which redirects to sign-in; then signed in), consent Allow and Deny, token exchange with PKCE (wrong verifier fails), refresh rotation, reuse detection, revoke.
- **Rejections:** bad `redirect_uri`, non-S256 challenge, reused or expired code.
- **Revocation paths:** Disconnect, Log out everywhere, and a disabled user each make the tokens fail.
- **No cross-use:** a web cookie doesn't work on `/mcp`, and a bearer token doesn't work on `/api/*`.
- **Tool list:** `tools/list` returns every tool with the annotations in the table.
- **Each tool:** at least one success case, plus one validation error that comes back as `isError: true` with the service's message.
- **`update_expense` merging:** changing only the note keeps the amount, category, and shares.
- **User isolation:** user B's token can't read, edit, or delete user A's expense, category, or person.
- **`next` redirect in `login.js`:** only `/oauth/authorize` paths on the same origin are followed.

Manual acceptance, done by the owner:

1. Inspect the endpoint with the MCP Inspector.
2. Add it in Claude Code and log an expense.
3. Add it as a custom connector in claude.ai, then log an expense from the phone app.
4. Confirm the expense appears in the web app.
5. Disconnect from the Account card and confirm Claude loses access.

## Rollout

1. Run `npm run db:migrate:remote` **before** `npm run deploy` (`0004` must exist first).
2. Update the WAF rule to include `/oauth/*`.
3. Add `/oauth`, `/mcp`, and the Connected apps section to the README's architecture and security sections.

## Left to the builder

- The MCP library choice, and the exact protocol version.
- File names inside `http/`, `services/` and `adapters/sql/`, and how the OAuth and MCP Hono apps mount next to `/api`.
- Consent page markup and copy, within the app's existing style.
- Whether to also support Client ID Metadata Documents, if claude.ai doesn't require them.
- The exact per-IP limits on the OAuth endpoints. Keep them in line with the existing auth limits.

## Calls made by the designer (not discussed with the owner)

- A self-built OAuth server on D1 behind ports, rather than Cloudflare's `workers-oauth-provider`. The library needs KV, which would break AWS portability.
- The redirect URI allow-list (Claude hosts and loopback only).
- Token lifetimes and refresh rotation with reuse detection.
- Partial-update semantics for `update_expense`.
- Rupee decimal strings in tool outputs.
- Edits and renames marked destructive, so Claude asks before them as well as before deletes.
- A `get_context` tool for today's date.
