import { describe, expect, it } from 'vitest';
import { call, connectClaude, json } from './helpers.ts';

type Claude = Awaited<ReturnType<typeof connectClaude>>;

const tool = (c: Claude, name: string, args: Record<string, unknown> = {}) => c.mcp('tools/call', { name, arguments: args });
const ok = async (c: Claude, name: string, args: Record<string, unknown> = {}) => {
  const r = await tool(c, name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.content[0].text}`);
  return r.structuredContent;
};

const lunch = { paid: 450, spent_on: '2025-03-10', category: 'Food', note: 'Lunch', my_share: 150,
  shares: [{ person: 'Ravi', amount: 150 }, { person: 'Sam', amount: 150 }] };

const ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint: boolean }> = {
  get_context: { readOnlyHint: true, idempotentHint: true },
  list_expenses: { readOnlyHint: true, idempotentHint: true },
  get_summary: { readOnlyHint: true, idempotentHint: true },
  get_category_summary: { readOnlyHint: true, idempotentHint: true },
  get_person_summary: { readOnlyHint: true, idempotentHint: true },
  list_categories: { readOnlyHint: true, idempotentHint: true },
  list_people: { readOnlyHint: true, idempotentHint: true },
  add_expense: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update_expense: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  delete_expense: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  create_category: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update_category: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  delete_category: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  add_person: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  rename_person: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  delete_person: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

describe('MCP write tools', () => {
  it('tools/list has 16 tools with spec annotations', async () => {
    const c = await connectClaude();
    const { tools } = await c.mcp('tools/list');
    expect(tools.map((t: any) => t.name).sort()).toEqual(Object.keys(ANNOTATIONS).sort());
    for (const t of tools) {
      expect(t.annotations, t.name).toEqual({ ...ANNOTATIONS[t.name], openWorldHint: false });
      expect(t.title, t.name).toBeTruthy();
    }
    const desc = (n: string) => tools.find((t: any) => t.name === n).description;
    expect(desc('delete_category')).toContain('Other');
    expect(desc('delete_person')).toContain('unassigned');
  });

  it('add_expense creates category and person on the fly', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', { paid: '120', spent_on: '2025-03-10', category: 'Snacks', shares: [{ person: 'Ravi', amount: '60' }] });
    expect(e).toMatchObject({ paid: '120.00', my_share: '60.00', category: 'Snacks', spent_on: '2025-03-10' });
    expect((await ok(c, 'list_categories')).categories.map((x: any) => x.name)).toContain('Snacks');
    expect((await ok(c, 'list_people')).people.map((x: any) => x.name)).toEqual(['Ravi']);
  });

  it('add_expense accepts numeric amounts', async () => {
    const c = await connectClaude();
    expect(await ok(c, 'add_expense', { paid: 449.5, spent_on: '2025-03-10', category: 'Food' })).toMatchObject({ paid: '449.50', my_share: '449.50' });
  });

  it('add_expense validation error is isError with service message', async () => {
    const c = await connectClaude();
    const r = await tool(c, 'add_expense', { paid: 100, my_share: 200, spent_on: '2025-03-10', category: 'Food' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('cannot be more than');
  });

  it('update_expense changes only the note', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', lunch);
    const u = await ok(c, 'update_expense', { id: e.id, note: 'Team lunch' });
    expect(u).toEqual({ ...e, note: 'Team lunch' });
  });

  it('update_expense null note clears it', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', lunch);
    const u = await ok(c, 'update_expense', { id: e.id, note: null });
    expect(u).toEqual({ ...e, note: null });
  });

  it('update_expense refuses amount change on a split', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', lunch);
    const r = await tool(c, 'update_expense', { id: e.id, paid: 600 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('This expense is split (you ₹150, Ravi ₹150, Sam ₹150). Send the new shares for ₹600.');
    const [stored] = (await ok(c, 'list_expenses', { month: '2025-03' })).expenses;
    expect(stored).toEqual(e);
  });

  it('update_expense amount change with new shares works', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', lunch);
    const u = await ok(c, 'update_expense', { id: e.id, paid: 600, shares: [{ person: 'Ravi', amount: 200 }, { person: 'Sam', amount: 200 }] });
    expect(u).toMatchObject({ paid: '600.00', my_share: '200.00', note: 'Lunch', category: 'Food' });
  });

  it('update_expense refuses amount change when my_share < paid with no people', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', { paid: 100, my_share: 20, spent_on: '2025-03-10', category: 'Food' });
    const r = await tool(c, 'update_expense', { id: e.id, paid: 200 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('This expense is split (you ₹20, unassigned ₹80). Send the new shares for ₹200.');
    expect(await ok(c, 'update_expense', { id: e.id, paid: 200, my_share: 50 })).toMatchObject({ paid: '200.00', my_share: '50.00' });
  });

  it('update_expense on unsplit expense changes amount freely', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', { paid: 100, spent_on: '2025-03-10', category: 'Food' });
    expect(await ok(c, 'update_expense', { id: e.id, paid: 250, category: 'Travel' }))
      .toMatchObject({ paid: '250.00', my_share: '250.00', category: 'Travel' });
  });

  it('update_expense with empty shares removes the split', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', lunch);
    expect(await ok(c, 'update_expense', { id: e.id, shares: [] })).toMatchObject({ paid: '450.00', my_share: '450.00', shares: [] });
  });

  it('delete_expense returns the deleted record', async () => {
    const c = await connectClaude();
    const e = await ok(c, 'add_expense', lunch);
    expect(await ok(c, 'delete_expense', { id: e.id })).toEqual({ ok: true, deleted: e });
    const again = await tool(c, 'delete_expense', { id: e.id });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toBe('Expense not found');
  });

  it('category create, update, delete moves to Other; Other cannot be deleted', async () => {
    const c = await connectClaude();
    const cat = await ok(c, 'create_category', { name: 'Gifts', color: 'pink' });
    expect(cat).toMatchObject({ name: 'Gifts', color: 'pink', locked: false });
    expect(await ok(c, 'update_category', { id: cat.id, name: 'Presents' })).toMatchObject({ id: cat.id, name: 'Presents' });
    await ok(c, 'add_expense', { paid: 10, spent_on: '2025-03-10', category: 'Presents' });
    expect(await ok(c, 'delete_category', { id: cat.id })).toEqual({ ok: true, moved: 1 });
    const [moved] = (await ok(c, 'list_expenses', { month: '2025-03' })).expenses;
    expect(moved.category).toBe('Other');
    const other = (await ok(c, 'list_categories')).categories.find((x: any) => x.name === 'Other');
    const r = await tool(c, 'delete_category', { id: other.id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('cannot be deleted');
  });

  it('people add, rename, delete leaves amounts unassigned', async () => {
    const c = await connectClaude();
    const p = await ok(c, 'add_person', { name: 'Priya' });
    expect(await ok(c, 'rename_person', { id: p.id, name: 'Priya S' })).toEqual({ id: p.id, name: 'Priya S' });
    await ok(c, 'add_expense', { paid: 100, my_share: 40, spent_on: '2025-03-10', category: 'Food', shares: [{ person: 'Priya S', amount: 60 }] });
    expect((await ok(c, 'get_summary', { month: '2025-03' })).unassigned).toBe('0.00');
    expect(await ok(c, 'delete_person', { id: p.id })).toEqual({ ok: true });
    expect((await ok(c, 'get_summary', { month: '2025-03' })).unassigned).toBe('60.00');
  });

  it('user isolation on writes', async () => {
    const a = await connectClaude();
    const b = await connectClaude();
    const e = await ok(a, 'add_expense', lunch);
    const ravi = e.shares[0].person_id;
    for (const [name, args, msg] of [
      ['update_expense', { id: e.id, note: 'hacked' }, 'Expense not found'],
      ['delete_expense', { id: e.id }, 'Expense not found'],
      ['rename_person', { id: ravi, name: 'X' }, 'Person not found'],
      ['delete_person', { id: ravi }, 'Person not found'],
      ['update_category', { id: e.category_id, name: 'X' }, 'Category not found'],
      ['delete_category', { id: e.category_id }, 'Category not found'],
    ] as const) {
      const r = await tool(b, name, args);
      expect(r.isError, name).toBe(true);
      expect(r.content[0].text, name).toBe(msg);
    }
    expect((await ok(a, 'list_expenses', { month: '2025-03' })).expenses).toEqual([e]);
    expect((await json(await call('/api/people', { cookie: a.cookie }))).people.map((p: any) => p.name)).toEqual(['Ravi', 'Sam']);
  });
});
