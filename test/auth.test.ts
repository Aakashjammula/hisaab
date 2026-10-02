import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { testOutbox } from '../src/adapters/cloudflare/mailer.ts';
import { call, json, lastCodeFor, login, newEmail } from './helpers.ts';

const request = (email: string, o = {}) => call('/api/auth/request', { method: 'POST', body: { email }, ...o });
const verify = (email: string, code: string, o = {}) => call('/api/auth/verify', { method: 'POST', body: { email, code }, ...o });
const sentTo = (email: string) => testOutbox.filter(m => m.to === email).length;
/** Skip the 1-code-per-minute wait for an email (tests can't wait a minute). */
const resetEmailLimits = (email: string) =>
  env.DB.prepare('DELETE FROM rate_limits WHERE key IN (?, ?)').bind(`code-email-min:${email}`, `code-email-hour:${email}`).run();

describe('requesting a code', () => {
  it('rejects an invalid email', async () => {
    expect((await request('not-an-email')).status).toBe(400);
  });

  it('emails a 6-digit code that is not stored in plain text', async () => {
    const email = newEmail();
    expect((await request(email)).status).toBe(200);
    const code = lastCodeFor(email);
    expect(code).toMatch(/^\d{6}$/);
    const row = await env.DB.prepare('SELECT code_hash FROM auth_codes WHERE email = ?').bind(email).first<{ code_hash: string }>();
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.code_hash).not.toContain(code);
  });

  it('closed mode: same answer for everyone, but only allowed emails get a code', async () => {
    const stranger = newEmail();
    const a = await request(stranger, { env: { AUTH_MODE: 'closed' } });
    const b = await request('me@example.com', { env: { AUTH_MODE: 'closed' } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json()); // no account enumeration
    expect(sentTo(stranger)).toBe(0);
    expect(sentTo('me@example.com')).toBe(1);
  });

  it('allows one code per minute per email', async () => {
    const email = newEmail();
    expect((await request(email)).status).toBe(200);
    const again = await request(email);
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('limits requests per IP', async () => {
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await request(newEmail(), { ip: '203.0.113.7' })).status);
    expect(statuses.slice(0, 20).every(s => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('verifying a code', () => {
  it('signs in, creates the account with default categories, sets a safe cookie', async () => {
    const { res, cookie } = await login();
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    const cats = await json(await call('/api/categories', { cookie }));
    expect(cats.categories.map((c: any) => c.name).sort()).toEqual(
      ['Bills', 'Entertainment', 'Food', 'Groceries', 'Health', 'Other', 'Shopping', 'Travel']);
  });

  it('uses a __Host- Secure cookie over HTTPS', async () => {
    const { res } = await login(newEmail(), { base: 'https://hisaab.example' });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^__Host-hisaab_session=/);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it('a code works once', async () => {
    const email = newEmail();
    await request(email);
    const code = lastCodeFor(email)!;
    expect((await verify(email, code)).status).toBe(200);
    expect((await verify(email, code)).status).toBe(401);
  });

  it('5 wrong guesses kill the code, even for the right one afterwards', async () => {
    const email = newEmail();
    await request(email);
    const code = lastCodeFor(email)!;
    const wrong = code === '000000' ? '111111' : '000000';
    const first = await json(await verify(email, wrong));
    expect(first.error).toContain('4 tries left');
    for (let i = 0; i < 4; i++) await verify(email, wrong);
    expect((await verify(email, code)).status).toBe(401);
  });

  it('expired codes fail', async () => {
    const email = newEmail();
    await request(email);
    await env.DB.prepare(`UPDATE auth_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE email = ?`).bind(email).run();
    expect((await verify(email, lastCodeFor(email)!)).status).toBe(401);
  });

  it('a newer code replaces the older one', async () => {
    const email = newEmail();
    await request(email);
    const first = lastCodeFor(email)!;
    await resetEmailLimits(email);
    await request(email);
    const second = lastCodeFor(email)!;
    if (first !== second) expect((await verify(email, first)).status).toBe(401);
    expect((await verify(email, second)).status).toBe(200);
  });

  it('rejects malformed input with the same generic error', async () => {
    const a = await json(await verify('nobody@example.com', '12'));
    const b = await json(await verify('nobody@example.com', '123456'));
    expect(a.error).toBe(b.error);
  });
});

describe('sessions', () => {
  it('protects every data endpoint', async () => {
    for (const p of ['/api/me', '/api/expenses', '/api/categories', '/api/summary']) {
      expect((await call(p)).status).toBe(401);
      expect((await call(p, { cookie: 'hisaab_session=forged-token' })).status).toBe(401);
    }
  });

  it('/api/me returns the signed-in email', async () => {
    const { cookie, email } = await login();
    expect(await json(await call('/api/me', { cookie }))).toEqual({ email });
  });

  it('only a hash of the session token is stored', async () => {
    const { cookie } = await login();
    const token = cookie.split('=')[1]!;
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').bind(token).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it('logout ends the session on the server', async () => {
    const { cookie } = await login();
    expect((await call('/api/auth/logout', { method: 'POST', cookie })).status).toBe(200);
    expect((await call('/api/me', { cookie })).status).toBe(401);
  });

  it('log out everywhere ends all sessions of that user only', async () => {
    const email = newEmail();
    const a = await login(email);
    await resetEmailLimits(email);
    const b = await login(email);
    const other = await login();
    expect((await call('/api/auth/logout-everywhere', { method: 'POST', cookie: a.cookie })).status).toBe(200);
    expect((await call('/api/me', { cookie: b.cookie })).status).toBe(401);
    expect((await call('/api/me', { cookie: other.cookie })).status).toBe(200);
  });

  it('expired and disabled sessions stop working', async () => {
    const s1 = await login();
    await env.DB.prepare(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    expect((await call('/api/me', { cookie: s1.cookie })).status).toBe(401);

    const s2 = await login();
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE email = ?`).bind(s2.email).run();
    expect((await call('/api/me', { cookie: s2.cookie })).status).toBe(401);
  });

  it('enforces the 90-day absolute limit even if used daily', async () => {
    const { cookie } = await login();
    await env.DB.prepare(`UPDATE sessions SET created_at = '2000-01-01T00:00:00.000Z'`).run();
    expect((await call('/api/me', { cookie })).status).toBe(401);
  });

  it('blocks cross-origin writes and non-JSON bodies', async () => {
    const { cookie } = await login();
    const evil = await call('/api/expenses', { method: 'POST', cookie, body: { paid: '1' }, headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const form = await call('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(400);
  });

  it('fails closed without AUTH_SECRET', async () => {
    const r = await call('/api/me', { env: { AUTH_SECRET: '' } });
    expect(r.status).toBe(500);
    expect((await json(r)).error).toBe('Service is not configured');
  });
});
