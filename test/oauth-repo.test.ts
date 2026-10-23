import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { D1Client } from '../src/adapters/cloudflare/d1.ts';
import { SqlOAuthRepo } from '../src/adapters/sql/repos.ts';
import { uuidv7 } from '../src/core/crypto.ts';
import { login, newEmail } from './helpers.ts';

const repo = () => new SqlOAuthRepo(new D1Client(env.DB));
const NOW = '2026-10-23T10:00:00.000Z';
const LATER = '2026-10-23T10:01:00.000Z';
const PAST = '2026-10-23T09:00:00.000Z';

async function userId(): Promise<string> {
  const { email } = await login(newEmail());
  return (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>())!.id;
}

async function setup() {
  const r = repo();
  const uid = await userId();
  const clientId = uuidv7();
  await r.createClient({ id: clientId, name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], createdAt: NOW });
  const connId = uuidv7();
  await r.createConnection({ id: connId, userId: uid, clientId, createdAt: NOW, lastUsedAt: NOW, expiresAt: LATER, userAgent: null });
  return { r, uid, clientId, connId };
}

const code = (clientId: string, userId: string, codeHash: string, expiresAt: string) => ({
  codeHash, clientId, userId, redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'chal',
  resource: 'http://localhost/mcp', userAgent: 'ua', expiresAt, createdAt: NOW,
});

describe('oauth repo', () => {
  it('client round-trips redirect_uris', async () => {
    const r = repo();
    const uris = ['https://claude.ai/cb', 'http://localhost:1234/cb'];
    const id = uuidv7();
    await r.createClient({ id, name: 'Claude', redirectUris: uris, createdAt: NOW });
    expect((await r.getClient(id))?.redirectUris).toEqual(uris);
    expect(await r.getClient(uuidv7())).toBeNull();
  });

  it('code is single use and expires', async () => {
    const { r, uid, clientId } = await setup();
    await r.createCode(code(clientId, uid, 'h1', LATER));
    expect((await r.consumeCode('h1', NOW))?.codeChallenge).toBe('chal');
    expect(await r.consumeCode('h1', NOW)).toBeNull();
    await r.createCode(code(clientId, uid, 'h2', PAST));
    expect(await r.consumeCode('h2', NOW)).toBeNull();
  });

  it('markRotated only once', async () => {
    const { r, connId } = await setup();
    await r.addToken({ tokenHash: 't1', connectionId: connId, kind: 'refresh', expiresAt: LATER, rotatedAt: null });
    expect(await r.markRotated('t1', NOW)).toBe(true);
    expect(await r.markRotated('t1', NOW)).toBe(false);
    expect((await r.getToken('t1'))?.rotatedAt).toBe(NOW);
  });

  it('deleteConnection cascades tokens and is user-scoped', async () => {
    const { r, uid, connId } = await setup();
    await r.addToken({ tokenHash: 't2', connectionId: connId, kind: 'access', expiresAt: LATER, rotatedAt: null });
    expect(await r.deleteConnection(await userId(), connId)).toBe(false);
    expect(await r.getToken('t2')).not.toBeNull();
    expect(await r.deleteConnection(uid, connId)).toBe(true);
    expect(await r.getToken('t2')).toBeNull();
  });

  it('deleting the user cascades connections', async () => {
    const { r, uid, connId } = await setup();
    expect((await r.getConnection(connId))?.clientName).toBe('Claude');
    expect(await r.listConnections(uid)).toHaveLength(1);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
    expect(await r.listConnections(uid)).toEqual([]);
  });
});
