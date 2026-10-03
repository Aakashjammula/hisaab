// HTTP API on Hono. Platform-neutral: Cloudflare and (later) AWS entry points both call createApp().
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { AppError } from '../core/errors.ts';
import type { Category, Expense, Person, User } from '../core/types.ts';
import type { AuthService } from '../services/auth.ts';
import type { CategoryService, ExpenseService } from '../services/expenses.ts';
import type { PersonService } from '../services/people.ts';
import type { SummaryService } from '../services/summary.ts';

export interface AppDeps {
  auth: AuthService;
  expenses: ExpenseService;
  categories: CategoryService;
  people: PersonService;
  summary: SummaryService;
  /** How this platform reports the caller's IP (e.g. CF-Connecting-IP, API Gateway sourceIp). */
  clientIp(req: Request): string;
  log?(message: string, err?: unknown): void;
}

type Env = { Variables: { user: User } };

// ---------- JSON shapes (the API contract the frontend uses) ----------

const categoryJson = (c: Category & { count?: number; recent?: number }) => ({
  id: c.id, name: c.name, icon: c.icon, color: c.color, locked: c.locked,
  ...(c.count != null ? { count: c.count, recent: c.recent } : {}),
});

const personJson = (p: Person & { count?: number; recent?: number }) => ({
  id: p.id, name: p.name, ...(p.count != null ? { count: p.count, recent: p.recent } : {}),
});

const expenseJson = (e: Expense) => ({
  id: e.id, paid: e.paid, my_share: e.myShare, note: e.note, spent_on: e.spentOn, created_at: e.createdAt,
  category_id: e.category.id, category: e.category.name, icon: e.category.icon, color: e.category.color,
  shares: e.shares.map(s => ({ person_id: s.person.id, person: s.person.name, amount: s.amount })),
});

// ---------- helpers ----------

const isHttps = (c: Context) => new URL(c.req.url).protocol === 'https:';
/** __Host- prefix = Secure, Path=/, no Domain: the cookie can't be set or overridden by subdomains. */
const cookieName = (c: Context) => (isHttps(c) ? '__Host-hisaab_session' : 'hisaab_session');

async function body(c: Context): Promise<Record<string, unknown>> {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) throw new AppError('validation', 'Expected JSON');
  try {
    const b = await c.req.json();
    if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {}
  throw new AppError('validation', 'Invalid JSON body');
}

const periodQuery = (c: Context) => ({ month: c.req.query('month') ?? null, year: c.req.query('year') ?? null });

export function createApp(d: AppDeps) {
  const app = new Hono<Env>().basePath('/api');

  app.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.retryAfterSeconds) c.header('Retry-After', String(err.retryAfterSeconds));
      return c.json({ error: err.message }, err.status as 400);
    }
    d.log?.('Unhandled API error', err);
    return c.json({ error: 'Something went wrong, try again' }, 500);
  });
  app.notFound(c => c.json({ error: 'Not found' }, 404));

  // Responses are per-user: never cache. Writes must come from our own pages (CSRF).
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && origin && origin !== new URL(c.req.url).origin) {
      throw new AppError('forbidden', 'Cross-origin request blocked');
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // ---------- auth (public) ----------

  app.post('/auth/request', async c => {
    const b = await body(c);
    await d.auth.requestCode(b.email, d.clientIp(c.req.raw));
    return c.json({ ok: true, message: 'If this email can sign in, a code is on its way.' });
  });

  app.post('/auth/verify', async c => {
    const b = await body(c);
    const s = await d.auth.verify(b.email, b.code, d.clientIp(c.req.raw), c.req.header('user-agent') ?? null);
    setCookie(c, cookieName(c), s.token, {
      httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', expires: new Date(s.expiresAt),
    });
    return c.json({ email: s.user.email });
  });

  app.post('/auth/logout', async c => {
    await d.auth.logout(getCookie(c, cookieName(c)));
    deleteCookie(c, cookieName(c), { path: '/', secure: isHttps(c) });
    return c.json({ ok: true });
  });

  // ---------- everything below needs a session ----------

  app.use('*', async (c, next) => {
    const s = await d.auth.authenticate(getCookie(c, cookieName(c)));
    if (!s) throw new AppError('unauthorized', 'Please sign in');
    if (s.renewed) {
      setCookie(c, cookieName(c), getCookie(c, cookieName(c))!, {
        httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', expires: new Date(s.expiresAt),
      });
    }
    c.set('user', s.user);
    await next();
  });

  app.get('/me', c => c.json({ email: c.get('user').email }));

  app.post('/auth/logout-everywhere', async c => {
    await d.auth.logoutEverywhere(c.get('user').id);
    deleteCookie(c, cookieName(c), { path: '/', secure: isHttps(c) });
    return c.json({ ok: true });
  });

  app.get('/expenses', async c => {
    const list = await d.expenses.list(c.get('user').id, periodQuery(c), c.req.query('category_id'));
    return c.json({ expenses: list.map(expenseJson) });
  });
  app.post('/expenses', async c => c.json(expenseJson(await d.expenses.create(c.get('user').id, await body(c))), 201));
  app.put('/expenses/:id', async c => c.json(expenseJson(await d.expenses.update(c.get('user').id, c.req.param('id'), await body(c)))));
  app.delete('/expenses/:id', async c => {
    await d.expenses.delete(c.get('user').id, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/categories', async c => c.json({ categories: (await d.categories.list(c.get('user').id)).map(categoryJson) }));
  app.post('/categories', async c => c.json({ ...categoryJson(await d.categories.create(c.get('user').id, await body(c))), count: 0 }, 201));
  app.patch('/categories/:id', async c => c.json(categoryJson(await d.categories.update(c.get('user').id, c.req.param('id'), await body(c)))));
  app.delete('/categories/:id', async c => c.json({ ok: true, moved: await d.categories.delete(c.get('user').id, c.req.param('id')) }));
  app.get('/categories/:id/summary', async c => {
    const s = await d.summary.categorySummary(c.get('user').id, c.req.param('id'), periodQuery(c));
    return c.json({ ...s, category: categoryJson(s.category), expenses: s.expenses.map(expenseJson) });
  });

  app.get('/people', async c => c.json({ people: (await d.people.list(c.get('user').id)).map(personJson) }));
  app.post('/people', async c => c.json({ ...personJson(await d.people.create(c.get('user').id, await body(c))), count: 0, recent: 0 }, 201));
  app.patch('/people/:id', async c => c.json(personJson(await d.people.rename(c.get('user').id, c.req.param('id'), await body(c)))));
  app.delete('/people/:id', async c => {
    await d.people.delete(c.get('user').id, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/people/:id/summary', async c => {
    const s = await d.people.summary(c.get('user').id, c.req.param('id'), periodQuery(c));
    return c.json({ ...s, person: personJson(s.person), expenses: s.expenses.map(expenseJson) });
  });

  app.get('/summary', async c => {
    const s = await d.summary.summary(c.get('user').id, periodQuery(c));
    return c.json({ ...s, top: s.top.map(expenseJson) });
  });

  return app;
}
