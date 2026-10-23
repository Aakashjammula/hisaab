import { describe, expect, it } from 'vitest';
import { buildTools } from '../src/http/mcp-tools.ts';
import { CategoryService } from '../src/services/expenses.ts';
import type { AppDeps } from '../src/http/app.ts';
import type { User } from '../src/core/types.ts';
import { call, connectClaude, expense, json } from './helpers.ts';

const READ_TOOLS = [
  'get_context', 'list_expenses', 'get_summary', 'get_category_summary', 'get_person_summary', 'list_categories', 'list_people',
];

const tool = async (c: Awaited<ReturnType<typeof connectClaude>>, name: string, args: Record<string, unknown> = {}) =>
  c.mcp('tools/call', { name, arguments: args });

/** Seeds via the web API with the same user's session cookie. */
const seed = (c: Awaited<ReturnType<typeof connectClaude>>, body: Record<string, unknown>) =>
  call('/api/expenses', { method: 'POST', cookie: c.cookie, body });

describe('MCP protocol', () => {
  it('initialize negotiates version and returns instructions', async () => {
    const c = await connectClaude();
    const r = await c.mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(r.protocolVersion).toBe('2025-06-18');
    expect(r.serverInfo).toEqual({ name: 'hisaab', title: 'Hisaab', version: '1.0.0' });
    expect(r.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.instructions).toContain('Asia/Kolkata');
    const old = await c.mcp('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(old.protocolVersion).toBe('2025-11-25');
  });

  it('notification returns 202', async () => {
    const c = await connectClaude();
    const res = await c.raw({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('batch array is rejected', async () => {
    const c = await connectClaude();
    const res = await c.raw([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect((await json(res)).error.code).toBe(-32600);
  });

  it('ping, unknown method and no-store', async () => {
    const c = await connectClaude();
    expect(await c.mcp('ping')).toEqual({});
    expect((await c.mcp('nope')).code).toBe(-32601);
    const res = await c.raw({ jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('invalid token is 401 with invalid_token and resource_metadata', async () => {
    const res = await call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    const h = res.headers.get('www-authenticate')!;
    expect(h).toContain('error="invalid_token"');
    expect(h).toContain('resource_metadata="http://localhost/.well-known/oauth-protected-resource"');
  });

  it('tools/list has all read tools with annotations', async () => {
    const c = await connectClaude();
    const { tools } = await c.mcp('tools/list');
    for (const name of READ_TOOLS) {
      const t = tools.find((x: any) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t.title).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    }
  });

  it('unknown tool is -32602', async () => {
    const c = await connectClaude();
    expect((await tool(c, 'nope')).code).toBe(-32602);
  });

  it('rate limit', async () => {
    const c = await connectClaude();
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await c.raw({ jsonrpc: '2.0', id: i, method: 'ping' })).status;
    expect(last).toBe(429);
  });

  it('foreign Origin is 403, claude.ai Origin is allowed', async () => {
    const c = await connectClaude();
    expect((await c.raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://claude.ai' })).status).toBe(200);
  });

  it('GET /mcp is 405', async () => {
    expect((await call('/mcp')).status).toBe(405);
  });
});

describe('MCP read tools', () => {
  it('get_context uses Asia/Kolkata', async () => {
    const categories = new CategoryService({ clock: { now: () => new Date('2026-10-22T19:00:00Z') }, config: { timeZone: 'Asia/Kolkata' } } as any);
    const tools = buildTools({ categories, timeZone: 'Asia/Kolkata' } as unknown as AppDeps);
    const user = { id: 'u', email: 'me@example.com', status: 'active', createdAt: '' } as User;
    const out = await tools.find(t => t.name === 'get_context')!.run(user, {});
    expect(out).toEqual({ email: 'me@example.com', today: '2026-10-23', time_zone: 'Asia/Kolkata', currency: 'INR' });
  });

  it('list_expenses filters', async () => {
    const c = await connectClaude();
    await seed(c, expense({ paid: '450', note: 'Lunch', shares: [{ person: 'Ravi', amount: '150' }] }));
    await seed(c, expense({ paid: '100', category: 'Travel', note: 'Auto' }));
    await seed(c, expense({ paid: '250', category: 'Groceries' }));
    const month = '2025-03';

    const all = (await tool(c, 'list_expenses', { month })).structuredContent;
    expect(all.period).toEqual({ type: 'month', key: month });
    expect(all.expenses).toHaveLength(3);

    const ravi = (await tool(c, 'list_expenses', { month, text: 'RAVI' })).structuredContent.expenses;
    expect(ravi.map((e: any) => e.paid)).toEqual(['450.00']);
    expect(ravi[0].my_share).toBe('300.00');
    expect(ravi[0].shares[0]).toMatchObject({ person: 'Ravi', amount: '150.00' });

    const big = (await tool(c, 'list_expenses', { month, min_amount: 200 })).structuredContent.expenses;
    expect(big.map((e: any) => e.paid).sort()).toEqual(['250.00', '450.00']);
    const small = (await tool(c, 'list_expenses', { month, max_amount: '100' })).structuredContent.expenses;
    expect(small.map((e: any) => e.note)).toEqual(['Auto']);

    const personId = ravi[0].shares[0].person_id;
    expect((await tool(c, 'list_expenses', { month, person_id: personId })).structuredContent.expenses).toHaveLength(1);
  });

  it('tool results carry the same data as text', async () => {
    const c = await connectClaude();
    const r = await tool(c, 'list_people');
    expect(r.content[0].type).toBe('text');
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
  });

  it('get_summary returns rupee strings', async () => {
    const c = await connectClaude();
    await seed(c, expense({ paid: '450.5' }));
    const s = (await tool(c, 'get_summary', { month: '2025-03' })).structuredContent;
    expect(s.my_spend).toBe('450.50');
    expect(s.paid_for_others).toMatch(/^\d+\.\d{2}$/);
    expect(s.by_category[0].amount).toBe('450.50');
    expect(s.top[0].paid).toBe('450.50');
    expect(s.unassigned).toBe('0.00');
  });

  it('category and person summaries', async () => {
    const c = await connectClaude();
    const e = await json(await seed(c, expense({ paid: '300', shares: [{ person: 'Sam', amount: '100' }] })));
    const cat = (await tool(c, 'get_category_summary', { id: e.category_id, month: '2025-03' })).structuredContent;
    expect(cat.category.name).toBe('Food');
    expect(cat.expenses[0].paid).toBe('300.00');
    const per = (await tool(c, 'get_person_summary', { id: e.shares[0].person_id, month: '2025-03' })).structuredContent;
    expect(per.person.name).toBe('Sam');
    expect(per.expenses).toHaveLength(1);
  });

  it('list_categories includes icons and colours', async () => {
    const c = await connectClaude();
    const r = (await tool(c, 'list_categories')).structuredContent;
    expect(r.categories.map((x: any) => x.name)).toContain('Other');
    expect(r.icons).toContain('utensils');
    expect(r.colors).toContain('orange');
  });

  it('user isolation on reads', async () => {
    const a = await connectClaude();
    const b = await connectClaude();
    const e = await json(await seed(a, expense()));
    const r = await tool(b, 'get_category_summary', { id: e.category_id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Category not found');
    expect((await tool(b, 'list_expenses', { month: '2025-03' })).structuredContent.expenses).toEqual([]);
  });
});
