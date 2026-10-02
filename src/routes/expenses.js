import { HttpError, json, parseId, readJson } from '../http.js';
import { parsePeriod } from '../dates.js';
import { parseExpense } from '../validate.js';
import { pickColor } from './categories.js';
import { suggestIcon } from '../../public/js/icon-list.js';

export const EXPENSE_SELECT = `
  SELECT e.id, e.paid, e.my_share, e.note, e.spent_on, e.created_at,
         c.id AS category_id, c.name AS category, c.icon, c.color
  FROM expenses e JOIN categories c ON c.id = e.category_id`;

/** GET /api/expenses?month=YYYY-MM (or ?year=YYYY) */
export async function listExpenses(env, url) {
  const p = parsePeriod(url.searchParams, env.TIME_ZONE);
  const catId = url.searchParams.get('category_id');
  const where = ['e.spent_on >= ?', 'e.spent_on < ?'], args = [p.start, p.end];
  if (catId) { where.push('e.category_id = ?'); args.push(parseId(catId)); }
  const { results } = await env.DB
    .prepare(`${EXPENSE_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.spent_on DESC, e.id DESC`)
    .bind(...args).all();
  return json({ period: p.key, expenses: results });
}

/** Statement that creates the category if it doesn't exist yet (case-insensitive). */
async function ensureCategoryStmt(env, e) {
  const icon = e.category_icon ?? suggestIcon(e.category);
  const color = e.category_color ?? await pickColor(env);
  return env.DB.prepare(`INSERT INTO categories (name, icon, color) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING`)
    .bind(e.category, icon, color);
}

async function fetchOne(env, id) {
  const row = await env.DB.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Expense not found');
  return row;
}

/** POST /api/expenses */
export async function createExpense(env, request) {
  const e = parseExpense(await readJson(request));
  // One D1 batch = one transaction: never a half-saved expense or a stray category.
  const [, inserted] = await env.DB.batch([
    await ensureCategoryStmt(env, e),
    env.DB.prepare(`INSERT INTO expenses (paid, my_share, category_id, note, spent_on)
                    SELECT ?, ?, id, ?, ? FROM categories WHERE name = ? RETURNING id`)
      .bind(e.paid, e.my_share, e.note, e.spent_on, e.category),
  ]);
  return json(await fetchOne(env, inserted.results[0].id), 201);
}

/** PUT /api/expenses/:id */
export async function updateExpense(env, request, rawId) {
  const id = parseId(rawId);
  const e = parseExpense(await readJson(request));
  const [, updated] = await env.DB.batch([
    await ensureCategoryStmt(env, e),
    env.DB.prepare(`UPDATE expenses SET paid = ?, my_share = ?, note = ?, spent_on = ?,
                      category_id = (SELECT id FROM categories WHERE name = ?)
                    WHERE id = ?`)
      .bind(e.paid, e.my_share, e.note, e.spent_on, e.category, id),
  ]);
  if (!updated.meta.changes) throw new HttpError(404, 'Expense not found');
  return json(await fetchOne(env, id));
}

/** DELETE /api/expenses/:id */
export async function deleteExpense(env, rawId) {
  const id = parseId(rawId);
  const r = await env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Expense not found');
  return json({ ok: true });
}
