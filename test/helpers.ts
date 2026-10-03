import { createExecutionContext, env } from 'cloudflare:test';
import worker, { type WorkerEnv } from '../src/adapters/cloudflare/worker.ts';
import { testOutbox } from '../src/adapters/cloudflare/mailer.ts';
import { uuidv7 } from '../src/core/crypto.ts';

export const BASE = 'http://localhost';
export const testEnv = (over: Partial<WorkerEnv> = {}): WorkerEnv =>
  ({ ...(env as unknown as WorkerEnv), MAILER: 'memory', AUTH_MODE: 'open', ...over });

let ipCounter = 0;
/** A different client IP per request keeps per-IP rate limits out of unrelated tests. */
const nextIp = () => { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; };

export interface CallOptions {
  method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>;
  env?: Partial<WorkerEnv>; base?: string; ip?: string;
}

export async function call(path: string, o: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': o.ip ?? nextIp(), ...o.headers };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.cookie) headers.cookie = o.cookie;
  const req = new Request((o.base ?? BASE) + path, {
    method: o.method ?? 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  return worker.fetch(req, testEnv(o.env), createExecutionContext());
}

export const json = async <T = any>(r: Response): Promise<T> => r.json() as Promise<T>;

export function lastCodeFor(email: string): string | null {
  const msg = [...testOutbox].reverse().find(m => m.to === email);
  return msg?.subject.match(/^(\d{8})/)?.[1] ?? null;
}

export const newEmail = () => `u-${uuidv7()}@example.com`;

/** Full login: request a code, read it from the test outbox, verify. Returns the session cookie. */
export async function login(email = newEmail(), o: { env?: Partial<WorkerEnv>; base?: string } = {}) {
  const req = await call('/api/auth/request', { method: 'POST', body: { email }, ...o });
  if (req.status !== 200) throw new Error(`request failed ${req.status} ${await req.text()}`);
  const code = lastCodeFor(email);
  if (!code) throw new Error('no code sent');
  const res = await call('/api/auth/verify', { method: 'POST', body: { email, code }, ...o });
  if (res.status !== 200) throw new Error(`verify failed ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return { email, cookie, res };
}

/** Logged-in API client for one user. */
export async function userClient(email?: string) {
  const { cookie, email: e } = await login(email);
  const u = (path: string, o: CallOptions = {}) => call(path, { cookie, ...o });
  return {
    email: e, cookie,
    get: (p: string) => u(p),
    post: (p: string, body: unknown) => u(p, { method: 'POST', body }),
    put: (p: string, body: unknown) => u(p, { method: 'PUT', body }),
    patch: (p: string, body: unknown) => u(p, { method: 'PATCH', body }),
    del: (p: string) => u(p, { method: 'DELETE' }),
  };
}

export const expense = (over: Record<string, unknown> = {}) =>
  ({ paid: '100', category: 'Food', spent_on: '2025-03-10', ...over });
