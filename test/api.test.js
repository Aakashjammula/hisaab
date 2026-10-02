import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker.js';

const BASE = 'http://localhost';
const api = (path, { method = 'GET', body, headers = {} } = {}) =>
  SELF.fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const post = (body) => api('/api/expenses', { method: 'POST', body });
const expense = (over = {}) => ({ paid: '100', category: 'Food', spent_on: '2025-03-10', ...over });

describe('auth', () => {
  const realEnv = { ...env, DEV_BYPASS_AUTH: 'false' };
  it('rejects requests without an Access token', async () => {
    const res = await worker.fetch(new Request(`${BASE}/api/expenses`), realEnv);
    expect(res.status).toBe(401);
  });
  it('rejects a forged token', async () => {
    const res = await worker.fetch(new Request(`${BASE}/api/expenses`, { headers: { 'cf-access-jwt-assertion': 'a.b.c' } }), realEnv);
    expect(res.status).toBe(401);
  });
  it('does not honour the dev bypass on a real hostname', async () => {
    const res = await worker.fetch(new Request('https://spend.example.com/api/expenses'), { ...env, DEV_BYPASS_AUTH: 'true' });
    expect(res.status).toBe(401);
  });
  it('fails closed when Access is not configured', async () => {
    const res = await worker.fetch(new Request('https://spend.example.com/api/expenses'), { ...env, TEAM_DOMAIN: '' });
    expect(res.status).toBe(500);
  });
  it('blocks cross-origin writes and non-JSON bodies', async () => {
    expect((await api('/api/expenses', { method: 'POST', body: expense(), headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const form = await SELF.fetch(`${BASE}/api/expenses`, { method: 'POST', body: 'paid=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
  });
});

describe('expenses', () => {
  it('stores a split expense in paise with only my share as spending', async () => {
    const res = await post(expense({ paid: '1000', my_share: '200', note: 'Dinner' }));
    expect(res.status).toBe(201);
    const e = await res.json();
    expect(e).toMatchObject({ paid: 100000, my_share: 20000, category: 'Food', icon: 'utensils', note: 'Dinner', spent_on: '2025-03-10' });
  });

  it('defaults my_share to the full amount and allows ₹0 share', async () => {
    expect((await (await post(expense({ paid: '19.99' }))).json()).my_share).toBe(1999);
    expect((await (await post(expense({ paid: '350', my_share: '0' }))).json()).my_share).toBe(0);
  });

  it.each([
    [{ paid: '1.005' }, 'at most 2 decimals'],
    [{ paid: 'abc' }, 'at most 2 decimals'],
    [{ paid: '0' }, 'more than'],
    [{ paid: '1000001' }, 'limit'],
    [{ my_share: '101' }, 'cannot be more'],
    [{ spent_on: '2026-02-30' }, 'valid'],
    [{ category: '   ' }, 'required'],
    [{ category_icon: '<svg onload=alert(1)>' }, 'Unknown icon'],
    [{ category_color: '#ff0000' }, 'Unknown colour'],
  ])('rejects %o', async (over, msg) => {
    const res = await post(expense(over));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(msg);
  });

  it('creates a new category on the fly, case-insensitively, with a suggested icon', async () => {
    const a = await (await post(expense({ category: 'gym' }))).json();
    const b = await (await post(expense({ category: 'GYM' }))).json();
    expect(a.category_id).toBe(b.category_id);
    expect(a.icon).toBe('dumbbell');
    const c = await (await post(expense({ category: 'Pets', category_icon: 'dog', category_color: 'violet' }))).json();
    expect(c).toMatchObject({ category: 'Pets', icon: 'dog', color: 'violet' });
  });

  it('lists by month, updates and deletes', async () => {
    const { id } = await (await post(expense({ spent_on: '2025-04-02' }))).json();
    await post(expense({ spent_on: '2025-05-01' }));
    const list = await (await api('/api/expenses?month=2025-04')).json();
    expect(list.expenses.map(e => e.id)).toEqual([id]);

    const upd = await api(`/api/expenses/${id}`, { method: 'PUT', body: expense({ paid: '250', my_share: '50', category: 'Travel', spent_on: '2025-04-03' }) });
    expect(await upd.json()).toMatchObject({ paid: 25000, my_share: 5000, category: 'Travel', spent_on: '2025-04-03' });

    expect((await api(`/api/expenses/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/expenses/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api('/api/expenses/abc', { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects a bad month', async () => {
    expect((await api('/api/expenses?month=2025-13')).status).toBe(400);
  });
});

describe('categories', () => {
  it('deleting a category moves its expenses to Other; Other cannot be deleted', async () => {
    const e = await (await post(expense({ category: 'Coffee' }))).json();
    const res = await (await api(`/api/categories/${e.category_id}`, { method: 'DELETE' })).json();
    expect(res.moved).toBe(1);
    const list = await (await api('/api/expenses?month=2025-03')).json();
    expect(list.expenses.find(x => x.id === e.id).category).toBe('Other');

    const { categories } = await (await api('/api/categories')).json();
    const other = categories.find(c => c.name === 'Other');
    expect(other.locked).toBe(true);
    expect((await api(`/api/categories/${other.id}`, { method: 'DELETE' })).status).toBe(400);
  });

  it('renames, changes icon, and refuses duplicates', async () => {
    const created = await (await api('/api/categories', { method: 'POST', body: { name: 'Fod' } })).json();
    const ren = await api(`/api/categories/${created.id}`, { method: 'PATCH', body: { name: 'Snacks', icon: 'cookie', color: 'amber' } });
    expect(await ren.json()).toMatchObject({ name: 'Snacks', icon: 'cookie', color: 'amber' });
    expect((await api(`/api/categories/${created.id}`, { method: 'PATCH', body: { name: 'food' } })).status).toBe(409);
    expect((await api('/api/categories', { method: 'POST', body: { name: 'FOOD' } })).status).toBe(409);
    expect((await api(`/api/categories/${created.id}`, { method: 'PATCH', body: { icon: 'not-an-icon' } })).status).toBe(400);
  });
});

describe('summary', () => {
  it('computes month totals, categories, splits and comparisons in exact paise', async () => {
    // baseline months
    await post(expense({ paid: '300', category: 'Food', spent_on: '2024-12-05' }));
    await post(expense({ paid: '500', category: 'Food', spent_on: '2025-01-05' }));
    // previous month: one early, one late
    await post(expense({ paid: '100', category: 'Food', spent_on: '2025-01-03' }));
    await post(expense({ paid: '700', category: 'Bills', spent_on: '2025-01-28' }));
    // this month (Feb 2025, fully elapsed)
    await post(expense({ paid: '1000', my_share: '200', category: 'Food', spent_on: '2025-02-01' }));
    await post(expense({ paid: '0.10', category: 'Food', spent_on: '2025-02-01' }));
    await post(expense({ paid: '0.20', category: 'Bills', spent_on: '2025-02-28' }));

    const s = await (await api('/api/summary?month=2025-02')).json();
    expect(s.period).toMatchObject({ type: 'month', key: '2025-02', units: 28, elapsed: 28 });
    expect(s.my_spend).toBe(20000 + 10 + 20);           // 0.1 + 0.2 is exactly 30 paise here
    expect(s.paid_for_others).toBe(80000);
    expect(s.count).toBe(3);
    expect(s.prev).toMatchObject({ total: 50000 + 10000 + 70000, same_point: 130000, has_data: true });
    expect(s.by_category[0]).toMatchObject({ name: 'Food', amount: 20010, count: 2 });
    expect(s.splits).toMatchObject({ count: 1, paid: 100000, my_share: 20000 });
    expect(s.buckets).toEqual([{ k: '2025-02-01', amount: 20010, count: 2 }, { k: '2025-02-28', amount: 20, count: 1 }]);
    expect(s.trend).toHaveLength(12);
    expect(s.trend.at(-1)).toEqual({ k: '2025-02', amount: 20030 });
    expect(s.baseline.months).toBeGreaterThanOrEqual(2);
    expect(s.top[0].my_share).toBe(20000);
  });

  it('year view buckets by month', async () => {
    await post(expense({ paid: '100', spent_on: '2023-03-01' }));
    await post(expense({ paid: '200', spent_on: '2023-03-20' }));
    const s = await (await api('/api/summary?year=2023')).json();
    expect(s.period.type).toBe('year');
    expect(s.buckets).toEqual([{ k: '2023-03', amount: 30000, count: 2 }]);
  });

  it('category drill-down returns expenses and 12-month history', async () => {
    const e = await (await post(expense({ paid: '42', category: 'Health', spent_on: '2025-06-15' }))).json();
    const d = await (await api(`/api/categories/${e.category_id}/summary?month=2025-06`)).json();
    expect(d.category.name).toBe('Health');
    expect(d.expenses.map(x => x.id)).toContain(e.id);
    expect(d.trend.at(-1)).toEqual({ k: '2025-06', amount: 4200 });
  });
});

describe('database guards (STRICT tables)', () => {
  it('rejects fractional paise and text even if the API were bypassed', async () => {
    const cat = await env.DB.prepare(`SELECT id FROM categories WHERE name = 'Food'`).first();
    await expect(env.DB.prepare('INSERT INTO expenses (paid, my_share, category_id, spent_on) VALUES (?, ?, ?, ?)')
      .bind(100.5, 100, cat.id, '2025-01-01').run()).rejects.toThrow();
    await expect(env.DB.prepare('INSERT INTO expenses (paid, my_share, category_id, spent_on) VALUES (?, ?, ?, ?)')
      .bind('abc', 0, cat.id, '2025-01-01').run()).rejects.toThrow();
  });
});
