import { createExecutionContext, env } from 'cloudflare:test';
import worker, { type WorkerEnv } from '../src/adapters/cloudflare/worker.ts';
import { testOutbox } from '../src/adapters/cloudflare/mailer.ts';
import { generateToken, uuidv7 } from '../src/core/crypto.ts';

export const BASE = 'http://localhost';
export const testEnv = (over: Partial<WorkerEnv> = {}): WorkerEnv =>
  ({ ...(env as unknown as WorkerEnv), MAILER: 'memory', AUTH_MODE: 'open', ...over });

let ipCounter = 0;
/** A different client IP per request keeps per-IP rate limits out of unrelated tests. */
const nextIp = () => { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; };

export interface CallOptions {
  method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>;
  env?: Partial<WorkerEnv>; base?: string; ip?: string;
  /** Sent as application/x-www-form-urlencoded (OAuth endpoints). */
  form?: Record<string, string>;
}

export async function call(path: string, o: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': o.ip ?? nextIp(), ...o.headers };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.form) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (o.cookie) headers.cookie = o.cookie;
  const req = new Request((o.base ?? BASE) + path, {
    method: o.method ?? 'GET', headers,
    body: o.form ? new URLSearchParams(o.form).toString() : o.body !== undefined ? JSON.stringify(o.body) : undefined,
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

export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/** PKCE S256 pair. */
export async function pkce() {
  const verifier = generateToken();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

/** Claude's side of the connector: register → authorize (signed in) → consent → token. Returns an MCP client. */
export async function connectClaude(email?: string) {
  const { cookie, email: e } = await login(email);
  const reg = await call('/oauth/register', { method: 'POST', body: { redirect_uris: [REDIRECT], client_name: 'Claude' } });
  if (reg.status !== 201) throw new Error(`register failed ${reg.status} ${await reg.text()}`);
  const clientId = (await json(reg)).client_id as string;

  const { verifier, challenge } = await pkce();
  const params = {
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', state: 'xyz',
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp`,
  };
  const page = await call('/oauth/authorize?' + new URLSearchParams(params), { cookie });
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  if (page.status !== 200 || !csrf) throw new Error(`consent page failed ${page.status}`);

  const consent = await call('/oauth/authorize', { method: 'POST', cookie, headers: { origin: BASE }, form: { ...params, csrf, decision: 'allow' } });
  const code = consent.status === 302 ? new URL(consent.headers.get('location')!).searchParams.get('code') : null;
  if (!code) throw new Error(`consent failed ${consent.status} ${consent.headers.get('location')}`);

  const tok = await call('/oauth/token', {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/mcp` },
  });
  if (tok.status !== 200) throw new Error(`token failed ${tok.status} ${await tok.text()}`);
  const { access_token: accessToken, refresh_token: refreshToken } = await json(tok);

  let id = 0;
  const raw = (body: unknown, headers: Record<string, string> = {}) => call('/mcp', {
    method: 'POST', body, headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', ...headers },
  });
  const mcp = async (method: string, params?: unknown): Promise<any> => {
    const j = await json(await raw({ jsonrpc: '2.0', id: ++id, method, ...(params !== undefined ? { params } : {}) }));
    return j.error ?? j.result;
  };
  return { email: e, accessToken: accessToken as string, refreshToken: refreshToken as string, cookie, mcp, raw };
}
