// JSON shapes of the API contract the frontend uses (money in paise). The MCP tools reuse them with rupees.
import type { Category, Expense, Person } from '../core/types.ts';

export const categoryJson = (c: Category & { count?: number; recent?: number }) => ({
  id: c.id, name: c.name, icon: c.icon, color: c.color, locked: c.locked,
  ...(c.count != null ? { count: c.count, recent: c.recent } : {}),
});

export const personJson = (p: Person & { count?: number; recent?: number }) => ({
  id: p.id, name: p.name, ...(p.count != null ? { count: p.count, recent: p.recent } : {}),
});

export const expenseJson = (e: Expense) => ({
  id: e.id, paid: e.paid, my_share: e.myShare, note: e.note, spent_on: e.spentOn, created_at: e.createdAt,
  category_id: e.category.id, category: e.category.name, icon: e.category.icon, color: e.category.color,
  shares: e.shares.map(s => ({ person_id: s.person.id, person: s.person.name, amount: s.amount })),
});
