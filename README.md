# Hisaab

Hisaab (हिसाब, "keeping count") is a personal spending tracker. Log every payment, record only **your share** of split bills, and see where the money goes.

- **Backend**: TypeScript + [Hono](https://hono.dev), hexagonal (ports & adapters) so it can move from Cloudflare to AWS without rewriting the core
- **Data**: Cloudflare D1 (SQLite) today, written in portable SQL. Every row belongs to a user, and money is integer paise
- **Sign-in**: passwordless email codes from your own domain, with sessions that follow OWASP guidance
- **UI**: plain HTML + vanilla JS + [Oat](https://oat.ink) + [Charts.css](https://chartscss.org) + Lucide icons, all self-hosted. It's an installable PWA

## Architecture

```
src/
  core/        Business rules with no platform code: money, dates, validation, auth crypto (Web Crypto)
  ports/       Interfaces the core needs: repos, Mailer, RateLimiter, Clock, IdGenerator
  services/    Use cases: AuthService, OAuthService, ExpenseService, CategoryService, PersonService, SummaryService
  http/        Hono app, platform-neutral: web API (app.ts), OAuth server + consent page (oauth.ts),
               MCP endpoint (mcp.ts) and its tools (mcp-tools.ts)
  adapters/
    sql/         Repos written once against a small SqlClient interface (SQLite + Postgres compatible)
    cloudflare/  D1 SqlClient, Email Routing mailer, Workers entry point
public/        Static frontend (no build step)
migrations/    D1 schema
```

**Moving to AWS later** means adding `adapters/aws/`: a Postgres `SqlClient` (rewrite `?` to `$n`, wrap `batch()` in a transaction, map error 23505 to `isUniqueViolation`), an SES `Mailer`, and a Lambda entry using `hono/aws-lambda`. Then port `migrations/` to Postgres types (`uuid`, `timestamptz`, `bigint`). `core/`, `services/` and `http/` stay as they are.

## Use with Claude (MCP)

Claude can do everything you can do in the app: log and edit expenses, split bills, manage categories and people, and read summaries. Hisaab runs its own OAuth login for this, so you connect with the same email code.

- **Claude Code:** `claude mcp add --transport http hisaab https://hisaab.aakashjammula.com/mcp`, then sign in when the browser opens.
- **claude.ai (and the Claude phone app):** Settings → Connectors → Add custom connector, with the URL `https://hisaab.aakashjammula.com/mcp`. Once added on claude.ai it also shows up in the phone app.

Reading runs freely. Adding, editing and deleting are marked so Claude asks you first. Deletes are one item at a time, and changing the amount of a split bill makes Claude ask you how to split the new amount. See and disconnect connected apps on the Categories page, under **Account**.

## Sign-in and security

- **Codes:** 6-digit codes from a CSPRNG. Only an HMAC (keyed with `AUTH_SECRET`) is stored. They expire in 10 minutes, are single use, and 5 wrong tries cancel them.
- **Rate limits:** 1 code per minute and 5 per hour per email, 20 code requests per hour per IP, 30 verifications per 10 minutes per IP.
- **No account enumeration:** the response is the same whether or not an email may sign in.
- **Sessions:** a 256-bit token in an HttpOnly, Secure, SameSite=Lax `__Host-` cookie. Only its SHA-256 is stored. Sessions expire after 30 days idle and 90 days at most, and logging out deletes them on the server. There's also a "Log out everywhere" option.
- **Claude (OAuth 2.1):**
  - PKCE S256 only. Dynamic client registration, with redirect URIs limited to Claude's exact callback URLs on claude.ai and claude.com (in `OAUTH_DEFAULTS`), plus localhost for Claude Code.
  - Codes, access tokens and refresh tokens are stored only as SHA-256 hashes. Codes last 60 seconds and are single use. Access tokens last 1 hour.
  - Refresh tokens rotate on every use. Reusing an old one more than 60 seconds after rotation revokes the whole connection.
  - A connection follows the session limits: 30 days idle, 90 days at most. **Disconnect** on the Account card and **Log out everywhere** both cut Claude off.
  - `/mcp` checks the `Origin` header and allows 120 tool calls per minute per user. Web cookies don't work on `/mcp`, and Claude's tokens don't work on `/api`.
- **Data isolation:** every query is scoped to the signed-in user, and a composite foreign key stops an expense from pointing at another user's category.
- **Who can sign in** (`AUTH_MODE`):
  - `closed`: only `ALLOWED_EMAILS`
  - `invite`: `ALLOWED_EMAILS` can join, and existing users stay
  - `open`: anyone

## Local development

```sh
npm install
npm run db:migrate:local
npm run dev        # http://localhost:8787. The sign-in code is printed in this terminal.
npm test           # Vitest inside the Workers runtime, against a real local D1
npx tsc -p .       # type check
```

`.dev.vars` (git-ignored) holds `AUTH_SECRET`, `ALLOWED_EMAILS` and `MAILER=console`.

## Deploying to Cloudflare

1. `npx wrangler login`
2. `npx wrangler d1 create hisaab`, then put the id in `wrangler.jsonc`, and run `npm run db:migrate:remote`.
3. **Email Routing** on your domain: enable it, and add the address you'll sign in with as a **verified destination address**. Sending to verified addresses is free; sending to arbitrary addresses (public sign-up) needs Workers Paid or another provider. Set `MAIL_FROM` in `wrangler.jsonc`.
4. Secrets:
   ```sh
   openssl rand -base64 32 | npx wrangler secret put AUTH_SECRET
   npx wrangler secret put ALLOWED_EMAILS     # e.g. you@gmail.com
   ```
5. Set your domain in `wrangler.jsonc` → `routes`, then run `npm run deploy`.
6. Optional extra layer: a free Cloudflare WAF rate-limiting rule on `/api/auth/*` and `/oauth/*`.

**Updating:** always run `npm run db:migrate:remote` **before** `npm run deploy` when there is a new file in `migrations/`.

`workers_dev` and `preview_urls` are off, so the app is only served on your domain.
