import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expense, json, userClient } from './helpers.ts';

describe('expenses', () => {
  it('stores a split expense in paise with only my share as spending', async () => {
    const u = await userClient();
    const res = await u.post('/api/expenses', expense({ paid: '1000', my_share: '200', note: 'Dinner' }));
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ paid: 100000, my_share: 20000, category: 'Food', icon: 'utensils', note: 'Dinner', spent_on: '2025-03-10' });
  });

  it('defaults my_share to the full amount and allows ₹0 share', async () => {
    const u = await userClient();
    expect((await json(await u.post('/api/expenses', expense({ paid: '19.99' })))).my_share).toBe(1999);
    expect((await json(await u.post('/api/expenses', expense({ paid: '350', my_share: '0' })))).my_share).toBe(0);
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
    const u = await userClient();
    const res = await u.post('/api/expenses', expense(over));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain(msg);
  });

  it('creates a category on the fly, case-insensitively, with a suggested icon', async () => {
    const u = await userClient();
    const a = await json(await u.post('/api/expenses', expense({ category: 'gym' })));
    const b = await json(await u.post('/api/expenses', expense({ category: '  GYM ' })));
    expect(a.category_id).toBe(b.category_id);
    expect(a.icon).toBe('dumbbell');
    const c = await json(await u.post('/api/expenses', expense({ category: 'Pets', category_icon: 'dog', category_color: 'violet' })));
    expect(c).toMatchObject({ category: 'Pets', icon: 'dog', color: 'violet' });
  });

  it('lists by month, updates and deletes', async () => {
    const u = await userClient();
    const { id } = await json(await u.post('/api/expenses', expense({ spent_on: '2025-04-02' })));
    await u.post('/api/expenses', expense({ spent_on: '2025-05-01' }));
    expect((await json(await u.get('/api/expenses?month=2025-04'))).expenses.map((e: any) => e.id)).toEqual([id]);

    const upd = await u.put(`/api/expenses/${id}`, expense({ paid: '250', my_share: '50', category: 'Travel', spent_on: '2025-04-03' }));
    expect(await json(upd)).toMatchObject({ paid: 25000, my_share: 5000, category: 'Travel', spent_on: '2025-04-03' });

    expect((await u.del(`/api/expenses/${id}`)).status).toBe(200);
    expect((await u.del(`/api/expenses/${id}`)).status).toBe(404);
    expect((await u.del('/api/expenses/not-a-uuid')).status).toBe(404);
  });

  it('rejects a bad month', async () => {
    const u = await userClient();
    expect((await u.get('/api/expenses?month=2025-13')).status).toBe(400);
  });
});

describe('categories', () => {
  it('deleting a category moves its expenses to Other; Other cannot be deleted', async () => {
    const u = await userClient();
    const e = await json(await u.post('/api/expenses', expense({ category: 'Coffee' })));
    expect((await json(await u.del(`/api/categories/${e.category_id}`))).moved).toBe(1);
    const list = await json(await u.get('/api/expenses?month=2025-03'));
    expect(list.expenses.find((x: any) => x.id === e.id).category).toBe('Other');

    const other = (await json(await u.get('/api/categories'))).categories.find((c: any) => c.name === 'Other');
    expect(other.locked).toBe(true);
    expect((await u.del(`/api/categories/${other.id}`)).status).toBe(400);
  });

  it('renames, changes icon, and refuses duplicates', async () => {
    const u = await userClient();
    const created = await json(await u.post('/api/categories', { name: 'Fod' }));
    const ren = await u.patch(`/api/categories/${created.id}`, { name: 'Snacks', icon: 'cookie', color: 'amber' });
    expect(await json(ren)).toMatchObject({ name: 'Snacks', icon: 'cookie', color: 'amber' });
    expect((await u.patch(`/api/categories/${created.id}`, { name: 'food' })).status).toBe(409);
    expect((await u.post('/api/categories', { name: 'FOOD' })).status).toBe(409);
    expect((await u.patch(`/api/categories/${created.id}`, { icon: 'not-an-icon' })).status).toBe(400);
  });
});

describe('isolation between users', () => {
  it("one user can never see or change another user's data", async () => {
    const a = await userClient(), b = await userClient();
    const ea = await json(await a.post('/api/expenses', expense({ paid: '500', category: 'Secret', spent_on: '2025-07-01' })));

    // B sees none of A's expenses, categories or totals
    expect((await json(await b.get('/api/expenses?month=2025-07'))).expenses).toEqual([]);
    expect((await json(await b.get('/api/categories'))).categories.some((c: any) => c.name === 'Secret')).toBe(false);
    expect((await json(await b.get('/api/summary?month=2025-07'))).my_spend).toBe(0);

    // B can't touch A's rows even with the right ids
    expect((await b.put(`/api/expenses/${ea.id}`, expense({ paid: '1' }))).status).toBe(404);
    expect((await b.del(`/api/expenses/${ea.id}`)).status).toBe(404);
    expect((await b.patch(`/api/categories/${ea.category_id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await b.del(`/api/categories/${ea.category_id}`)).status).toBe(404);
    expect((await b.get(`/api/categories/${ea.category_id}/summary?month=2025-07`)).status).toBe(404);

    // A's data is intact
    expect((await json(await a.get('/api/expenses?month=2025-07'))).expenses[0]).toMatchObject({ id: ea.id, paid: 50000, category: 'Secret' });
  });

  it('the same category name can exist for different users', async () => {
    const a = await userClient(), b = await userClient();
    expect((await a.post('/api/categories', { name: 'Gym' })).status).toBe(201);
    expect((await b.post('/api/categories', { name: 'Gym' })).status).toBe(201);
  });
});

describe('summary', () => {
  it('computes month totals, categories, splits and comparisons in exact paise', async () => {
    const u = await userClient();
    const add = (o: Record<string, unknown>) => u.post('/api/expenses', expense(o));
    await add({ paid: '300', category: 'Food', spent_on: '2024-12-05' });
    await add({ paid: '500', category: 'Food', spent_on: '2025-01-05' });
    await add({ paid: '100', category: 'Food', spent_on: '2025-01-03' });
    await add({ paid: '700', category: 'Bills', spent_on: '2025-01-28' });
    await add({ paid: '1000', my_share: '200', category: 'Food', spent_on: '2025-02-01' });
    await add({ paid: '0.10', category: 'Food', spent_on: '2025-02-01' });
    await add({ paid: '0.20', category: 'Bills', spent_on: '2025-02-28' });

    const s = await json(await u.get('/api/summary?month=2025-02'));
    expect(s.period).toMatchObject({ type: 'month', key: '2025-02', units: 28, elapsed: 28 });
    expect(s.my_spend).toBe(20000 + 10 + 20);
    expect(s.paid_for_others).toBe(80000);
    expect(s.count).toBe(3);
    expect(s.prev).toMatchObject({ total: 130000, same_point: 130000, has_data: true });
    expect(s.by_category[0]).toMatchObject({ name: 'Food', amount: 20010, count: 2 });
    expect(s.splits).toEqual({ count: 1, paid: 100000, my_share: 20000 });
    expect(s.buckets).toEqual([{ k: '2025-02-01', amount: 20010, count: 2 }, { k: '2025-02-28', amount: 20, count: 1 }]);
    expect(s.trend).toHaveLength(12);
    expect(s.trend.at(-1)).toEqual({ k: '2025-02', amount: 20030 });
    expect(s.baseline).toEqual({ months: 2, avg_total: Math.round(160000 / 2) });
    expect(s.top[0]).toMatchObject({ my_share: 20000, category: 'Food' });
  });

  it('year view buckets by month', async () => {
    const u = await userClient();
    await u.post('/api/expenses', expense({ paid: '100', spent_on: '2023-03-01' }));
    await u.post('/api/expenses', expense({ paid: '200', spent_on: '2023-03-20' }));
    const s = await json(await u.get('/api/summary?year=2023'));
    expect(s.period.type).toBe('year');
    expect(s.buckets).toEqual([{ k: '2023-03', amount: 30000, count: 2 }]);
  });

  it('category drill-down returns expenses and 12-month history', async () => {
    const u = await userClient();
    const e = await json(await u.post('/api/expenses', expense({ paid: '42', category: 'Health', spent_on: '2025-06-15' })));
    const d = await json(await u.get(`/api/categories/${e.category_id}/summary?month=2025-06`));
    expect(d.category.name).toBe('Health');
    expect(d.expenses.map((x: any) => x.id)).toContain(e.id);
    expect(d.trend.at(-1)).toEqual({ k: '2025-06', amount: 4200 });
  });
});

describe('database guards', () => {
  it('STRICT tables reject fractional paise and text even if the API were bypassed', async () => {
    const u = await userClient();
    const e = await json(await u.post('/api/expenses', expense()));
    const userId = (await env.DB.prepare('SELECT user_id FROM expenses WHERE id = ?').bind(e.id).first<{ user_id: string }>())!.user_id;
    const ins = (paid: unknown) => env.DB.prepare(
      `INSERT INTO expenses (id, user_id, category_id, paid, my_share, spent_on, created_at, updated_at) VALUES (?, ?, ?, ?, 0, '2025-01-01', 'x', 'x')`)
      .bind(crypto.randomUUID(), userId, e.category_id, paid).run();
    await expect(ins(100.5)).rejects.toThrow();
    await expect(ins('abc')).rejects.toThrow();
  });

  it("an expense can't point at another user's category (composite foreign key)", async () => {
    const a = await userClient(), b = await userClient();
    const ea = await json(await a.post('/api/expenses', expense()));
    const eb = await json(await b.post('/api/expenses', expense()));
    const bUser = (await env.DB.prepare('SELECT user_id FROM expenses WHERE id = ?').bind(eb.id).first<{ user_id: string }>())!.user_id;
    await expect(env.DB.prepare(
      `INSERT INTO expenses (id, user_id, category_id, paid, my_share, spent_on, created_at, updated_at) VALUES (?, ?, ?, 100, 100, '2025-01-01', 'x', 'x')`)
      .bind(crypto.randomUUID(), bUser, ea.category_id).run()).rejects.toThrow();
  });
});
