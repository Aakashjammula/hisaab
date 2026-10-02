import { HttpError, json, parseId, readJson } from '../http.js';
import { checkColor, checkIcon, cleanName } from '../validate.js';
import { COLORS, suggestIcon } from '../../public/js/icon-list.js';

/** Least-used palette colour, so new categories look distinct. */
export async function pickColor(env) {
  const { results } = await env.DB.prepare('SELECT color, COUNT(*) AS n FROM categories GROUP BY color').all();
  const used = Object.fromEntries(results.map(r => [r.color, r.n]));
  return COLORS.map(c => c[0]).sort((a, b) => (used[a] ?? 0) - (used[b] ?? 0))[0];
}

const isUniqueError = err => /UNIQUE constraint failed/i.test(String(err?.message ?? err));

/** GET /api/categories — most recently/frequently used first (for the picker). */
export async function listCategories(env) {
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.name, c.icon, c.color, c.locked,
           COUNT(e.id) AS count,
           SUM(CASE WHEN e.spent_on >= date('now', '-90 days') THEN 1 ELSE 0 END) AS recent
    FROM categories c LEFT JOIN expenses e ON e.category_id = c.id
    GROUP BY c.id
    ORDER BY recent DESC, count DESC, c.locked ASC, c.name COLLATE NOCASE`).all();
  return json({ categories: results.map(r => ({ ...r, locked: !!r.locked, recent: r.recent ?? 0 })) });
}

/** POST /api/categories {name, icon?, color?} */
export async function createCategory(env, request) {
  const body = await readJson(request);
  const name = cleanName(body.name);
  const icon = checkIcon(body.icon) ?? suggestIcon(name);
  const color = checkColor(body.color) ?? await pickColor(env);
  try {
    const row = await env.DB.prepare('INSERT INTO categories (name, icon, color) VALUES (?, ?, ?) RETURNING id, name, icon, color, locked')
      .bind(name, icon, color).first();
    return json({ ...row, locked: false, count: 0 }, 201);
  } catch (err) {
    if (isUniqueError(err)) throw new HttpError(409, `“${name}” already exists`);
    throw err;
  }
}

/** PATCH /api/categories/:id {name?, icon?, color?} */
export async function updateCategory(env, request, rawId) {
  const id = parseId(rawId);
  const body = await readJson(request);
  const sets = [], args = [];
  if (body.name != null) { sets.push('name = ?'); args.push(cleanName(body.name)); }
  if (body.icon != null) { sets.push('icon = ?'); args.push(checkIcon(body.icon)); }
  if (body.color != null) { sets.push('color = ?'); args.push(checkColor(body.color)); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  try {
    const row = await env.DB.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ? RETURNING id, name, icon, color, locked`)
      .bind(...args, id).first();
    if (!row) throw new HttpError(404, 'Category not found');
    return json({ ...row, locked: !!row.locked });
  } catch (err) {
    if (isUniqueError(err)) throw new HttpError(409, 'A category with that name already exists');
    throw err;
  }
}

/** DELETE /api/categories/:id — its expenses move to the locked "Other" category. */
export async function deleteCategory(env, rawId) {
  const id = parseId(rawId);
  const cat = await env.DB.prepare('SELECT locked FROM categories WHERE id = ?').bind(id).first();
  if (!cat) throw new HttpError(404, 'Category not found');
  if (cat.locked) throw new HttpError(400, '“Other” cannot be deleted');
  const [moved] = await env.DB.batch([
    env.DB.prepare('UPDATE expenses SET category_id = (SELECT id FROM categories WHERE locked = 1 ORDER BY id LIMIT 1) WHERE category_id = ?').bind(id),
    env.DB.prepare('DELETE FROM categories WHERE id = ? AND locked = 0').bind(id),
  ]);
  return json({ ok: true, moved: moved.meta.changes });
}
