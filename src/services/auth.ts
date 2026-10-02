// Passwordless email-code login and server-side sessions, following OWASP guidance:
// random single-use codes stored as HMACs, short expiry, attempt limits, rate limits,
// 256-bit session tokens stored as hashes, idle + absolute timeouts, server-side logout.
import { AppError } from '../core/errors.ts';
import { generateCode, generateToken, hmac, isEmail, normalizeEmail, sha256, timingSafeEqual } from '../core/crypto.ts';
import { nameKey } from '../core/validate.ts';
import type { User } from '../core/types.ts';
import type { AuthCodeRepo, Clock, IdGenerator, Mailer, RateLimiter, SessionRepo, UserRepo } from '../ports/index.ts';
import { DEFAULT_CATEGORIES, type AppConfig } from './config.ts';

const DAY = 86_400_000;
const GENERIC_VERIFY_ERROR = 'That code is wrong or has expired. Request a new one.';

export interface AuthDeps {
  users: UserRepo; sessions: SessionRepo; codes: AuthCodeRepo; limiter: RateLimiter;
  mailer: Mailer; clock: Clock; ids: IdGenerator; config: AppConfig;
}

export class AuthService {
  constructor(private d: AuthDeps) {}

  private get cfg() { return this.d.config.auth; }

  private async limit(key: string, max: number, windowSeconds: number) {
    const wait = await this.d.limiter.hit(key, max, windowSeconds, this.d.clock.now());
    if (wait > 0) throw new AppError('rate_limited', `Too many attempts. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`, wait);
  }

  /** Can this email sign in (or sign up) under the current mode? */
  private async eligible(email: string): Promise<{ ok: boolean; user: User | null }> {
    const user = await this.d.users.findByEmail(email);
    const listed = this.cfg.allowedEmails.includes(email);
    const ok = this.cfg.mode === 'open' || listed || (this.cfg.mode === 'invite' && !!user);
    return { ok: ok && user?.status !== 'disabled', user };
  }

  /**
   * Step 1: email a code. Always resolves the same way for eligible and ineligible emails,
   * so the login form can't be used to discover who has an account.
   */
  async requestCode(rawEmail: unknown, ip: string): Promise<void> {
    if (!isEmail(rawEmail)) throw new AppError('validation', 'Enter a valid email address');
    const email = normalizeEmail(rawEmail);

    await this.limit(`code-ip:${ip}`, 20, 3600);
    await this.limit(`code-email-min:${email}`, 1, 60);
    await this.limit(`code-email-hour:${email}`, 5, 3600);

    if (!(await this.eligible(email)).ok) return;

    const now = this.d.clock.now();
    const code = generateCode();
    await this.d.codes.replace({
      id: this.d.ids.next(), email,
      codeHash: await hmac(this.cfg.secret, `${email}:${code}`),
      attempts: 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.cfg.codeTtlMinutes * 60_000).toISOString(),
    });

    const app = this.d.config.appName;
    await this.d.mailer.send({
      to: email,
      subject: `${code} is your ${app} sign-in code`,
      text: `Your ${app} sign-in code is ${code}\n\nIt expires in ${this.cfg.codeTtlMinutes} minutes and can be used once.\nIf you didn't try to sign in, you can ignore this email.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px">
  <p style="margin:0 0 12px;color:#555">Your ${app} sign-in code</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>
  <p style="margin:0;color:#555;font-size:14px">It expires in ${this.cfg.codeTtlMinutes} minutes and can be used once.<br>If you didn't try to sign in, you can ignore this email.</p>
</div>`,
    });
  }

  /** Step 2: check the code; on success create the account if needed and open a new session. */
  async verify(rawEmail: unknown, rawCode: unknown, ip: string, userAgent: string | null) {
    await this.limit(`verify-ip:${ip}`, 30, 600);
    if (!isEmail(rawEmail) || typeof rawCode !== 'string' || !/^\d{6}$/.test(rawCode.trim())) {
      throw new AppError('unauthorized', GENERIC_VERIFY_ERROR);
    }
    const email = normalizeEmail(rawEmail), code = rawCode.trim();
    const now = this.d.clock.now(), nowIso = now.toISOString();

    const rec = await this.d.codes.latestActive(email, nowIso);
    if (!rec || rec.attempts >= this.cfg.maxCodeAttempts) throw new AppError('unauthorized', GENERIC_VERIFY_ERROR);

    const hash = await hmac(this.cfg.secret, `${email}:${code}`);
    if (!timingSafeEqual(hash, rec.codeHash)) {
      await this.d.codes.incrementAttempts(rec.id);
      const left = this.cfg.maxCodeAttempts - rec.attempts - 1;
      throw new AppError('unauthorized', left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : GENERIC_VERIFY_ERROR);
    }
    if (!(await this.d.codes.consume(rec.id, nowIso))) throw new AppError('unauthorized', GENERIC_VERIFY_ERROR);

    const { ok, user: existing } = await this.eligible(email);
    if (!ok) throw new AppError('forbidden', 'This account cannot sign in.');
    const user = existing ?? await this.d.users.createWithDefaults(
      { id: this.d.ids.next(), email, createdAt: nowIso },
      DEFAULT_CATEGORIES.map(c => ({
        id: this.d.ids.next(), name: c.name, nameKey: nameKey(c.name), icon: c.icon, color: c.color,
        locked: 'locked' in c && c.locked, createdAt: nowIso,
      })),
    );

    // Always a brand-new token after login (no session fixation).
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + this.cfg.sessionIdleDays * DAY).toISOString();
    await this.d.sessions.create({
      tokenHash: await sha256(token), userId: user.id,
      createdAt: nowIso, lastSeenAt: nowIso, expiresAt,
      userAgent: userAgent?.slice(0, 200) ?? null,
    });
    return { token, user, expiresAt };
  }

  /** Resolve a session cookie to a user. Extends the idle timeout at most once a day. */
  async authenticate(token: string | undefined): Promise<{ user: User; expiresAt: string; renewed: boolean } | null> {
    if (!token || token.length > 100) return null;
    const tokenHash = await sha256(token);
    const s = await this.d.sessions.get(tokenHash);
    if (!s) return null;

    const now = this.d.clock.now();
    const hardStop = Date.parse(s.createdAt) + this.cfg.sessionMaxDays * DAY;
    if (now.getTime() >= Date.parse(s.expiresAt) || now.getTime() >= hardStop) {
      await this.d.sessions.delete(tokenHash);
      return null;
    }

    const user = await this.d.users.findById(s.userId);
    if (!user || user.status !== 'active') return null;

    if (now.getTime() - Date.parse(s.lastSeenAt) > DAY) {
      const expiresAt = new Date(Math.min(now.getTime() + this.cfg.sessionIdleDays * DAY, hardStop)).toISOString();
      await this.d.sessions.touch(tokenHash, now.toISOString(), expiresAt);
      return { user, expiresAt, renewed: true };
    }
    return { user, expiresAt: s.expiresAt, renewed: false };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.d.sessions.delete(await sha256(token));
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.d.sessions.deleteAllForUser(userId);
  }
}
