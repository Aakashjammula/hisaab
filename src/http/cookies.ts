// Session cookie helpers shared by the /api routes and the OAuth consent page.
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';

export function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

/** __Host- prefix = Secure, Path=/, no Domain: the cookie can't be set or overridden by subdomains. */
export function cookieName(c: Context): string {
  return isHttps(c) ? '__Host-hisaab_session' : 'hisaab_session';
}

export function setSessionCookie(c: Context, token: string, expiresAt: string): void {
  setCookie(c, cookieName(c), token, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', expires: new Date(expiresAt) });
}
