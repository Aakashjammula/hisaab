import { describe, expect, it } from 'vitest';
import { call, connectClaude, json, userClient } from './helpers.ts';

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('connected apps', () => {
  it('lists the Claude connection', async () => {
    const c = await connectClaude();
    const res = await call('/api/connections', { cookie: c.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { connections } = await json(res);
    expect(connections).toEqual([{ id: expect.any(String), name: 'Claude', created_at: expect.any(String), last_used_at: expect.any(String) }]);
  });

  it('disconnect kills MCP access', async () => {
    const c = await connectClaude();
    expect((await c.raw(ping)).status).toBe(200);
    const [conn] = (await json(await call('/api/connections', { cookie: c.cookie }))).connections;
    const del = await call(`/api/connections/${conn.id}`, { method: 'DELETE', cookie: c.cookie });
    expect(await json(del)).toEqual({ ok: true });
    expect((await c.raw(ping)).status).toBe(401);
    expect((await json(await call('/api/connections', { cookie: c.cookie }))).connections).toEqual([]);
  });

  it('log out everywhere disconnects Claude', async () => {
    const c = await connectClaude();
    await call('/api/auth/logout-everywhere', { method: 'POST', cookie: c.cookie, body: {} });
    expect((await c.raw(ping)).status).toBe(401);
  });

  it("cannot see or delete another user's connection", async () => {
    const a = await connectClaude();
    const b = await userClient();
    const [conn] = (await json(await call('/api/connections', { cookie: a.cookie }))).connections;
    expect((await json(await b.get('/api/connections'))).connections).toEqual([]);
    expect((await b.del(`/api/connections/${conn.id}`)).status).toBe(404);
    expect((await a.raw(ping)).status).toBe(200);
  });

  it('needs a web session', async () => {
    expect((await call('/api/connections')).status).toBe(401);
  });
});
