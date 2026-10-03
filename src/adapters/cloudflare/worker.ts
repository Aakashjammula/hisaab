// Cloudflare Workers entry point: wires Cloudflare adapters into the platform-neutral app.
// An AWS Lambda entry would do the same with a Postgres SqlClient and an SES Mailer.
import { uuidv7, normalizeEmail } from '../../core/crypto.ts';
import { createApp } from '../../http/app.ts';
import { AuthService } from '../../services/auth.ts';
import { AUTH_DEFAULTS, type AppConfig, type AuthMode } from '../../services/config.ts';
import { CategoryService, ExpenseService } from '../../services/expenses.ts';
import { PersonService } from '../../services/people.ts';
import { SummaryService } from '../../services/summary.ts';
import type { Mailer } from '../../ports/index.ts';
import {
  SqlAuthCodeRepo, SqlCategoryRepo, SqlExpenseRepo, SqlPersonRepo, SqlRateLimiter, SqlSessionRepo, SqlSummaryRepo, SqlUserRepo,
} from '../sql/repos.ts';
import { D1Client } from './d1.ts';
import { CloudflareMailer, ConsoleMailer, MemoryMailer } from './mailer.ts';

export interface WorkerEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  EMAIL: SendEmail;
  APP_NAME: string;
  TIME_ZONE: string;
  MAIL_FROM: string;
  AUTH_MODE: string;
  CONTACT_EMAIL?: string;
  AUTH_SECRET?: string;
  ALLOWED_EMAILS?: string;
  /** "console" (local dev) or "memory" (tests); unset = real email */
  MAILER?: string;
}

function config(env: WorkerEnv): AppConfig {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 16) throw new Error('AUTH_SECRET is not configured'); // fail closed
  const mode = (['closed', 'invite', 'open'].includes(env.AUTH_MODE) ? env.AUTH_MODE : 'closed') as AuthMode;
  return {
    appName: env.APP_NAME || 'Hisaab',
    timeZone: env.TIME_ZONE || 'Asia/Kolkata',
    contactEmail: env.CONTACT_EMAIL?.trim() || null,
    auth: {
      ...AUTH_DEFAULTS, mode, secret: env.AUTH_SECRET,
      allowedEmails: (env.ALLOWED_EMAILS ?? '').split(',').map(normalizeEmail).filter(Boolean),
    },
  };
}

function mailer(env: WorkerEnv, cfg: AppConfig): Mailer {
  if (env.MAILER === 'console') return new ConsoleMailer();
  if (env.MAILER === 'memory') return new MemoryMailer();
  return new CloudflareMailer(env.EMAIL, env.MAIL_FROM, cfg.appName);
}

export function buildApp(env: WorkerEnv) {
  const cfg = config(env);
  const db = new D1Client(env.DB);
  const clock = { now: () => new Date() };
  const ids = { next: () => uuidv7() };

  const categoryRepo = new SqlCategoryRepo(db);
  const shared = { expenses: new SqlExpenseRepo(db), categories: categoryRepo, ids, clock, config: cfg };
  const categories = new CategoryService(shared);
  const expenses = new ExpenseService(shared, categories);
  const people = new PersonService({ ...shared, people: new SqlPersonRepo(db) }, expenses);

  return createApp({
    auth: new AuthService({
      users: new SqlUserRepo(db), sessions: new SqlSessionRepo(db), codes: new SqlAuthCodeRepo(db),
      limiter: new SqlRateLimiter(db), mailer: mailer(env, cfg), clock, ids, config: cfg,
    }),
    expenses,
    categories,
    people,
    summary: new SummaryService(new SqlSummaryRepo(db), expenses),
    clientIp: req => req.headers.get('cf-connecting-ip') ?? 'unknown',
    log: (msg, err) => console.error(msg, err),
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await buildApp(env).fetch(request, env, ctx);
    } catch (err) {
      console.error('Startup error', err);
      return Response.json({ error: 'Service is not configured' }, { status: 500, headers: { 'cache-control': 'no-store' } });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
