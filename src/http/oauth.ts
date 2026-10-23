// OAuth 2.1 authorization server endpoints for the MCP connector, plus the consent page.
// Not behind the /api CSRF middleware: register/token/revoke are called server-to-server by Claude,
// and the consent form does its own Origin + session-bound CSRF checks.
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { timingSafeEqual } from '../core/crypto.ts';
import { AppError, OAuthError } from '../core/errors.ts';
import type { AppDeps } from './app.ts';
import { cookieName, setSessionCookie } from './cookies.ts';

/** The parameters carried from the authorize request through sign-in and the consent form. */
const AUTHORIZE_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'resource'] as const;

const originOf = (c: Context) => new URL(c.req.url).origin;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function pickAuthorize(get: (name: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of AUTHORIZE_PARAMS) {
    const v = get(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** application/x-www-form-urlencoded body; a repeated parameter is an error (RFC 6749 §3.1). */
async function formBody(c: Context): Promise<Record<string, string>> {
  if (!(c.req.header('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) {
    throw new OAuthError('invalid_request', 'Expected an application/x-www-form-urlencoded body.');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(new TextDecoder().decode(await c.req.arrayBuffer()))) {
    if (k in out) throw new OAuthError('invalid_request', `Parameter ${k} was sent more than once.`);
    out[k] = v;
  }
  return out;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Hisaab</title>
<link rel="stylesheet" href="/vendor/oat.min.css">
<link rel="stylesheet" href="/css/app.css">
</head>
<body class="signed-out">
<main>
<article class="card login-card">
<header class="login-brand">Hisaab</header>
${body}
</article>
</main>
</body>
</html>`;
}

const csp = (formAction: string) =>
  `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;

function errorPage(c: Context, status: 400 | 403 | 429, message: string) {
  c.header('Content-Security-Policy', csp("'none'"));
  return c.html(page('Cannot connect', `<h3>Cannot connect</h3>\n<p class="muted">${escapeHtml(message)}</p>`), status);
}

/** checkAuthorize and form errors on the consent flow: an HTML page, never a redirect. */
function authorizeError(c: Context, err: unknown) {
  if (err instanceof OAuthError) return errorPage(c, 400, err.message);
  if (err instanceof AppError && err.code === 'rate_limited') {
    if (err.retryAfterSeconds) c.header('Retry-After', String(err.retryAfterSeconds));
    return errorPage(c, 429, err.message);
  }
  throw err;
}

/** Not signed in (or the session expired): sign in first, then come back to this authorize request. */
const toSignIn = (c: Context, pathAndQuery: string) => c.redirect('/?next=' + encodeURIComponent(pathAndQuery), 302);

export function oauthRoutes(d: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof OAuthError) return c.json({ error: err.error, error_description: err.message }, err.status as 400);
    if (err instanceof AppError) {
      if (err.retryAfterSeconds) c.header('Retry-After', String(err.retryAfterSeconds));
      return c.json({ error: err.code, error_description: err.message }, err.status as 400);
    }
    d.log?.('Unhandled OAuth error', err);
    return c.json({ error: 'server_error', error_description: 'Something went wrong, try again' }, 500);
  });

  const noStore = async (c: Context, next: () => Promise<void>) => {
    await next();
    c.header('Cache-Control', 'no-store');
  };
  app.use('/oauth/*', noStore);
  app.use('/.well-known/*', noStore);

  // ---------- metadata (RFC 9728, RFC 8414) ----------

  const protectedResource = (c: Context) => {
    const origin = originOf(c);
    return c.json({ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Hisaab' });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  app.get('/.well-known/oauth-authorization-server', c => {
    const origin = originOf(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  // ---------- client registration, token, revocation ----------

  app.post('/oauth/register', async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new OAuthError('invalid_request', 'The registration body must be JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_request', 'The registration body must be a JSON object.');
    return c.json(await d.oauth.register(body as Record<string, unknown>, d.clientIp(c.req.raw)), 201);
  });

  app.post('/oauth/token', async c => c.json(await d.oauth.token(await formBody(c), d.clientIp(c.req.raw))));

  // RFC 7009 §2.2: 200 whether or not the token was valid.
  app.post('/oauth/revoke', async c => {
    let token = '';
    try { token = (await formBody(c)).token ?? ''; } catch {}
    await d.oauth.revoke(token);
    return c.body(null, 200);
  });

  // ---------- authorize + consent ----------

  app.get('/oauth/authorize', async c => {
    const origin = originOf(c);
    const params = pickAuthorize(k => c.req.query(k));
    let req;
    try { req = await d.oauth.checkAuthorize(params, origin, d.clientIp(c.req.raw)); } catch (err) { return authorizeError(c, err); }

    const token = getCookie(c, cookieName(c));
    const s = await d.auth.authenticate(token);
    if (!s || !token) {
      const url = new URL(c.req.url);
      return toSignIn(c, url.pathname + url.search);
    }
    if (s.renewed) setSessionCookie(c, token, s.expiresAt);

    const csrf = await d.oauth.consentToken(token);
    const redirect = new URL(req.redirectUri);
    const hidden = Object.entries({ ...params, csrf })
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('\n');

    c.header('Content-Security-Policy', csp(`'self' ${redirect.origin}`));
    return c.html(page('Connect Claude', `<h3>Connect ${escapeHtml(req.client.name)}</h3>
<p>Allow Claude to read and change your Hisaab data</p>
<p class="muted">Signed in as <b>${escapeHtml(s.user.email)}</b>. After you choose, you go back to <b>${escapeHtml(redirect.host)}</b>.</p>
<form method="post" action="/oauth/authorize">
${hidden}
<button type="submit" name="decision" value="allow" class="large">Allow</button>
<button type="submit" name="decision" value="deny" class="outline large">Deny</button>
</form>`));
  });

  app.post('/oauth/authorize', async c => {
    const origin = originOf(c);
    if (c.req.header('origin') !== origin) return errorPage(c, 403, 'This request did not come from the Hisaab consent page.');

    let form;
    try { form = await formBody(c); } catch (err) { return authorizeError(c, err); }
    const params = pickAuthorize(k => form[k]);

    const token = getCookie(c, cookieName(c));
    const s = await d.auth.authenticate(token);
    if (!s || !token) return toSignIn(c, '/oauth/authorize?' + new URLSearchParams(params));
    if (!timingSafeEqual(form.csrf ?? '', await d.oauth.consentToken(token))) {
      return errorPage(c, 403, 'This consent form has expired. Go back to Claude and try connecting again.');
    }

    let req;
    try { req = await d.oauth.checkAuthorize(params, origin, d.clientIp(c.req.raw)); } catch (err) { return authorizeError(c, err); }
    const target = form.decision === 'allow'
      ? await d.oauth.approve(s.user.id, req, c.req.header('user-agent') ?? null)
      : d.oauth.deny(req);
    return c.redirect(target, 302);
  });

  return app;
}
