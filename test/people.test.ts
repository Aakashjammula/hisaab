import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expense, json, userClient } from './helpers.ts';

const split = (over: Record<string, unknown> = {}) =>
  expense({ paid: '100', my_share: '20', shares: [{ person: 'Ravi', amount: '80' }], ...over });

describe('split shares with people', () => {
  it('stores an unequal split and creates the person on the fly', async () => {
    const u = await userClient();
    const res = await u.post('/api/expenses', split());
    expect(res.status).toBe(201);
    const e = await json(res);
    expect(e).toMatchObject({ paid: 10000, my_share: 2000 });
    expect(e.shares).toEqual([{ person_id: expect.any(String), person: 'Ravi', amount: 8000 }]);

    const people = (await json(await u.get('/api/people'))).people;
    expect(people).toEqual([{ id: e.shares[0].person_id, name: 'Ravi', count: 1, recent: expect.any(Number) }]);
  });

  it('reuses people case-insensitively and splits between several', async () => {
    const u = await userClient();
    await u.post('/api/expenses', split());
    const e = await json(await u.post('/api/expenses', expense({
      paid: '100', my_share: '10', shares: [{ person: ' ravi ', amount: '20' }, { person: 'Priya', amount: '70' }],
    })));
    expect(e.shares.map((s: any) => [s.person, s.amount])).toEqual([['Priya', 7000], ['Ravi', 2000]]);
    expect((await json(await u.get('/api/people'))).people).toHaveLength(2);
  });

  it('works out my share from the people when it is left out', async () => {
    const u = await userClient();
    const e = await json(await u.post('/api/expenses', expense({ paid: '100', shares: [{ person: 'Ravi', amount: '80' }] })));
    expect(e.my_share).toBe(2000);
  });

  it.each([
    [{ my_share: '30' }, 'add up'],
    [{ shares: [{ person: 'Ravi', amount: '0' }] }, 'more than ₹0'],
    [{ shares: [{ person: 'Ravi', amount: '1.005' }] }, 'at most 2 decimals'],
    [{ shares: [{ person: '  ', amount: '80' }] }, 'Name'],
    [{ my_share: '0', shares: [{ person: 'Ravi', amount: '50' }, { person: 'RAVI', amount: '50' }] }, 'twice'],
    [{ shares: 'Ravi' }, 'list'],
    [{ my_share: undefined, shares: [{ person: 'Ravi', amount: '101' }] }, 'add up'],
  ])('rejects %o', async (over, msg) => {
    const u = await userClient();
    const res = await u.post('/api/expenses', split(over));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain(msg);
  });

  it('an expense without people still allows an unassigned gap (older splits)', async () => {
    const u = await userClient();
    const e = await json(await u.post('/api/expenses', expense({ paid: '100', my_share: '20' })));
    expect(e.shares).toEqual([]);
  });

  it('update replaces the shares; delete removes them', async () => {
    const u = await userClient();
    const e = await json(await u.post('/api/expenses', split()));
    const upd = await json(await u.put(`/api/expenses/${e.id}`, split({ my_share: '50', shares: [{ person: 'Priya', amount: '50' }] })));
    expect(upd.shares.map((s: any) => s.person)).toEqual(['Priya']);
    expect((await json(await u.get('/api/expenses?month=2025-03'))).expenses[0].shares.map((s: any) => s.person)).toEqual(['Priya']);

    await u.del(`/api/expenses/${e.id}`);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_shares WHERE expense_id = ?').bind(e.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

describe('people', () => {
  it('creates, renames, refuses duplicates', async () => {
    const u = await userClient();
    const p = await json(await u.post('/api/people', { name: 'Ravi' }));
    expect(p).toMatchObject({ name: 'Ravi', count: 0 });
    expect((await u.post('/api/people', { name: 'RAVI' })).status).toBe(409);
    expect(await json(await u.patch(`/api/people/${p.id}`, { name: 'Ravi K' }))).toMatchObject({ name: 'Ravi K' });
    await u.post('/api/people', { name: 'Priya' });
    expect((await u.patch(`/api/people/${p.id}`, { name: 'priya' })).status).toBe(409);
    expect((await u.post('/api/people', { name: '' })).status).toBe(400);
  });

  it('deleting a person keeps the expense; their amount becomes unassigned', async () => {
    const u = await userClient();
    const e = await json(await u.post('/api/expenses', split()));
    expect((await u.del(`/api/people/${e.shares[0].person_id}`)).status).toBe(200);
    const after = (await json(await u.get('/api/expenses?month=2025-03'))).expenses[0];
    expect(after).toMatchObject({ id: e.id, paid: 10000, my_share: 2000, shares: [] });
    const s = await json(await u.get('/api/summary?month=2025-03'));
    expect(s.by_person).toEqual([]);
    expect(s.unassigned).toBe(8000);
  });

  it('person drill-down lists only expenses they were part of', async () => {
    const u = await userClient();
    const a = await json(await u.post('/api/expenses', split({ spent_on: '2025-03-02' })));
    await u.post('/api/expenses', split({ shares: [{ person: 'Priya', amount: '80' }] }));
    await u.post('/api/expenses', split({ spent_on: '2025-04-01' }));
    const d = await json(await u.get(`/api/people/${a.shares[0].person_id}/summary?month=2025-03`));
    expect(d.person.name).toBe('Ravi');
    expect(d.expenses.map((x: any) => x.id)).toEqual([a.id]);
  });
});

describe('spent on others summary', () => {
  it('totals per person for the month, plus what no person was named for', async () => {
    const u = await userClient();
    await u.post('/api/expenses', split());                                                       // Ravi 80
    await u.post('/api/expenses', expense({ paid: '300', my_share: '100',
      shares: [{ person: 'Ravi', amount: '100' }, { person: 'Priya', amount: '100' }] }));       // Ravi 100, Priya 100
    await u.post('/api/expenses', expense({ paid: '50', my_share: '10' }));                      // 40 unassigned
    await u.post('/api/expenses', split({ spent_on: '2025-04-01' }));                            // other month

    const s = await json(await u.get('/api/summary?month=2025-03'));
    expect(s.paid_for_others).toBe(8000 + 20000 + 4000);
    expect(s.by_person.map((p: any) => [p.name, p.amount, p.count])).toEqual([['Ravi', 18000, 2], ['Priya', 10000, 1]]);
    expect(s.unassigned).toBe(4000);
  });
});

describe('people isolation', () => {
  it("one user can't see, use or change another user's people", async () => {
    const a = await userClient(), b = await userClient();
    const ea = await json(await a.post('/api/expenses', split({ shares: [{ person: 'Secret Friend', amount: '80' }] })));
    const pid = ea.shares[0].person_id;

    expect((await json(await b.get('/api/people'))).people).toEqual([]);
    expect((await b.patch(`/api/people/${pid}`, { name: 'Hacked' })).status).toBe(404);
    expect((await b.del(`/api/people/${pid}`)).status).toBe(404);
    expect((await b.get(`/api/people/${pid}/summary?month=2025-03`)).status).toBe(404);

    // B naming the same person creates B's own person, not a link to A's
    const eb = await json(await b.post('/api/expenses', split({ shares: [{ person: 'Secret Friend', amount: '80' }] })));
    expect(eb.shares[0].person_id).not.toBe(pid);
  });

  it("a share can't point at another user's person or expense (composite foreign keys)", async () => {
    const a = await userClient(), b = await userClient();
    const ea = await json(await a.post('/api/expenses', split()));
    const eb = await json(await b.post('/api/expenses', split()));
    const bUser = (await env.DB.prepare('SELECT user_id FROM expenses WHERE id = ?').bind(eb.id).first<{ user_id: string }>())!.user_id;
    const ins = (expenseId: string, personId: string) => env.DB.prepare(
      'INSERT INTO expense_shares (expense_id, person_id, user_id, amount) VALUES (?, ?, ?, 100)').bind(expenseId, personId, bUser).run();
    await expect(ins(eb.id, ea.shares[0].person_id)).rejects.toThrow();
    await expect(ins(ea.id, eb.shares[0].person_id)).rejects.toThrow();
  });
});
