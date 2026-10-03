// SQL implementations of the data ports. Every query is scoped by user_id.
import { AppError } from '../../core/errors.ts';
import { addMonths } from '../../core/dates.ts';
import type { Category, CategoryInput, CategoryWithUsage, Expense, Id, Period, User } from '../../core/types.ts';
import type {
  AuthCode, AuthCodeRepo, Bucket, CategoryRepo, CategorySummaryData, ExpenseRepo, NewCategory, NewExpense,
  RateLimiter, Session, SessionRepo, SummaryData, SummaryRepo, UserRepo,
} from '../../ports/index.ts';
import { stmt, type SqlClient } from './client.ts';

// ---------- row mapping ----------

interface UserRow { id: string; email: string; status: 'active' | 'disabled'; created_at: string }
const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, status: r.status, createdAt: r.created_at });

interface CategoryRow { id: string; name: string; icon: string; color: string; locked: number }
const toCategory = (r: CategoryRow): Category => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, locked: !!r.locked });

interface ExpenseRow {
  id: string; paid: number; my_share: number; note: string | null; spent_on: string; created_at: string;
  category_id: string; category_name: string; icon: string; color: string; locked: number;
}
const toExpense = (r: ExpenseRow): Expense => ({
  id: r.id, paid: Number(r.paid), myShare: Number(r.my_share), note: r.note, spentOn: r.spent_on, createdAt: r.created_at,
  category: { id: r.category_id, name: r.category_name, icon: r.icon, color: r.color, locked: !!r.locked },
});

const EXPENSE_SELECT = `
  SELECT e.id, e.paid, e.my_share, e.note, e.spent_on, e.created_at,
         c.id AS category_id, c.name AS category_name, c.icon, c.color, c.locked
  FROM expenses e JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id`;

const insertCategory = (userId: Id, c: NewCategory, ignoreExisting: boolean) => stmt(
  `INSERT INTO categories (id, user_id, name, name_key, icon, color, locked, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)${ignoreExisting ? ' ON CONFLICT (user_id, name_key) DO NOTHING' : ''}`,
  c.id, userId, c.name, c.nameKey, c.icon, c.color, c.locked ? 1 : 0, c.createdAt,
);

const num = (v: unknown): number => Number(v ?? 0); // Postgres returns SUM/COUNT as strings

// ---------- users ----------

export class SqlUserRepo implements UserRepo {
  constructor(private db: SqlClient) {}

  async findByEmail(email: string) {
    const r = await this.db.first<UserRow>('SELECT id, email, status, created_at FROM users WHERE email = ?', [email]);
    return r && toUser(r);
  }

  async findById(id: Id) {
    const r = await this.db.first<UserRow>('SELECT id, email, status, created_at FROM users WHERE id = ?', [id]);
    return r && toUser(r);
  }

  async createWithDefaults(u: { id: Id; email: string; createdAt: string }, categories: NewCategory[]) {
    try {
      await this.db.batch([
        stmt(`INSERT INTO users (id, email, status, created_at) VALUES (?, ?, 'active', ?)`, u.id, u.email, u.createdAt),
        ...categories.map(c => insertCategory(u.id, c, false)),
      ]);
    } catch (err) {
      // Two logins racing to create the same user: the other one won, use it.
      if (!this.db.isUniqueViolation(err)) throw err;
    }
    return (await this.findByEmail(u.email))!;
  }
}

// ---------- expenses ----------

export class SqlExpenseRepo implements ExpenseRepo {
  constructor(private db: SqlClient) {}

  async listInRange(userId: Id, start: string, end: string, categoryId?: Id) {
    const rows = await this.db.all<ExpenseRow>(
      `${EXPENSE_SELECT} WHERE e.user_id = ? AND e.spent_on >= ? AND e.spent_on < ?${categoryId ? ' AND e.category_id = ?' : ''}
       ORDER BY e.spent_on DESC, e.created_at DESC, e.id DESC`,
      categoryId ? [userId, start, end, categoryId] : [userId, start, end],
    );
    return rows.map(toExpense);
  }

  async get(userId: Id, id: Id) {
    const r = await this.db.first<ExpenseRow>(`${EXPENSE_SELECT} WHERE e.user_id = ? AND e.id = ?`, [userId, id]);
    return r && toExpense(r);
  }

  async create(userId: Id, e: NewExpense) {
    await this.db.batch([
      insertCategory(userId, e.category, true),
      stmt(`INSERT INTO expenses (id, user_id, category_id, paid, my_share, note, spent_on, created_at, updated_at)
            SELECT ?, ?, id, ?, ?, ?, ?, ?, ? FROM categories WHERE user_id = ? AND name_key = ?`,
        e.id, userId, e.paid, e.myShare, e.note, e.spentOn, e.now, e.now, userId, e.category.nameKey),
    ]);
    return (await this.get(userId, e.id))!;
  }

  async update(userId: Id, id: Id, e: Omit<NewExpense, 'id'>) {
    if (!(await this.get(userId, id))) return false; // don't create a category for a missing expense
    const [, res] = await this.db.batch([
      insertCategory(userId, e.category, true),
      stmt(`UPDATE expenses SET paid = ?, my_share = ?, note = ?, spent_on = ?, updated_at = ?,
              category_id = (SELECT id FROM categories WHERE user_id = ? AND name_key = ?)
            WHERE id = ? AND user_id = ?`,
        e.paid, e.myShare, e.note, e.spentOn, e.now, userId, e.category.nameKey, id, userId),
    ]);
    return (res?.changes ?? 0) > 0;
  }

  async delete(userId: Id, id: Id) {
    return (await this.db.run('DELETE FROM expenses WHERE id = ? AND user_id = ?', [id, userId])).changes > 0;
  }
}

// ---------- categories ----------

export class SqlCategoryRepo implements CategoryRepo {
  constructor(private db: SqlClient) {}

  async list(userId: Id, recentSince: string): Promise<CategoryWithUsage[]> {
    const rows = await this.db.all<CategoryRow & { count: number; recent: number }>(
      `SELECT c.id, c.name, c.icon, c.color, c.locked, COUNT(e.id) AS count,
              COALESCE(SUM(CASE WHEN e.spent_on >= ? THEN 1 ELSE 0 END), 0) AS recent
       FROM categories c LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = c.user_id
       WHERE c.user_id = ?
       GROUP BY c.id, c.name, c.icon, c.color, c.locked, c.name_key
       ORDER BY recent DESC, count DESC, c.locked ASC, c.created_at, c.id`,
      [recentSince, userId],
    );
    return rows.map(r => ({ ...toCategory(r), count: num(r.count), recent: num(r.recent) }));
  }

  async get(userId: Id, id: Id) {
    const r = await this.db.first<CategoryRow>('SELECT id, name, icon, color, locked FROM categories WHERE id = ? AND user_id = ?', [id, userId]);
    return r && toCategory(r);
  }

  async usedColors(userId: Id) {
    const rows = await this.db.all<{ color: string; n: number }>('SELECT color, COUNT(*) AS n FROM categories WHERE user_id = ? GROUP BY color', [userId]);
    return Object.fromEntries(rows.map(r => [r.color, num(r.n)]));
  }

  async create(userId: Id, c: NewCategory) {
    try {
      await this.db.batch([insertCategory(userId, c, false)]);
    } catch (err) {
      if (this.db.isUniqueViolation(err)) throw new AppError('conflict', `“${c.name}” already exists`);
      throw err;
    }
    return (await this.get(userId, c.id))!;
  }

  async update(userId: Id, id: Id, patch: CategoryInput & { nameKey?: string }) {
    const sets: string[] = [], params: unknown[] = [];
    if (patch.name != null) { sets.push('name = ?', 'name_key = ?'); params.push(patch.name, patch.nameKey); }
    if (patch.icon != null) { sets.push('icon = ?'); params.push(patch.icon); }
    if (patch.color != null) { sets.push('color = ?'); params.push(patch.color); }
    try {
      const r = await this.db.first<CategoryRow>(
        `UPDATE categories SET ${sets.join(', ')} WHERE id = ? AND user_id = ? RETURNING id, name, icon, color, locked`,
        [...params, id, userId],
      );
      return r && toCategory(r);
    } catch (err) {
      if (this.db.isUniqueViolation(err)) throw new AppError('conflict', 'A category with that name already exists');
      throw err;
    }
  }

  async deleteMovingToOther(userId: Id, id: Id) {
    const [moved] = await this.db.batch([
      stmt(`UPDATE expenses SET category_id = (SELECT id FROM categories WHERE user_id = ? AND locked = 1 ORDER BY created_at LIMIT 1)
            WHERE user_id = ? AND category_id = ?`, userId, userId, id),
      stmt('DELETE FROM categories WHERE id = ? AND user_id = ? AND locked = 0', id, userId),
    ]);
    return moved?.changes ?? 0;
  }
}

// ---------- analytics ----------

const last12 = (lastKey: string) => Array.from({ length: 12 }, (_, i) => addMonths(lastKey, i - 11));

export class SqlSummaryRepo implements SummaryRepo {
  constructor(private db: SqlClient) {}

  async summary(userId: Id, p: Period): Promise<SummaryData> {
    const bucket = p.type === 'month' ? 'spent_on' : 'substr(spent_on, 1, 7)';
    const prev = p.type === 'month' ? { start: `${p.prev}-01`, end: p.start } : { start: `${p.prev}-01-01`, end: p.start };
    // Baseline for "vs usual": month view = previous 6 months; year view = previous year.
    const base = p.type === 'month' ? { start: `${addMonths(p.key, -6)}-01`, end: p.start } : prev;
    const keys = last12(p.type === 'month' ? p.key : `${p.key}-12`);
    const trendRange = [`${keys[0]}-01`, `${addMonths(keys[11]!, 1)}-01`];
    const R = 'user_id = ? AND spent_on >= ? AND spent_on < ?';
    const cur = [userId, p.start, p.end];

    const res = await this.db.batch([
      stmt(`SELECT COALESCE(SUM(my_share), 0) AS my_spend, COALESCE(SUM(paid - my_share), 0) AS others, COUNT(*) AS count
            FROM expenses WHERE ${R}`, ...cur),
      stmt(`SELECT ${bucket} AS k, SUM(my_share) AS amount, COUNT(*) AS count FROM expenses WHERE ${R} GROUP BY ${bucket} ORDER BY k`, ...cur),
      stmt(`SELECT ${bucket} AS k, SUM(my_share) AS amount FROM expenses WHERE ${R} GROUP BY ${bucket} ORDER BY k`, userId, prev.start, prev.end),
      stmt(`SELECT c.id, c.name, c.icon, c.color, c.locked, SUM(e.my_share) AS amount, COUNT(*) AS count
            FROM expenses e JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
            WHERE e.user_id = ? AND e.spent_on >= ? AND e.spent_on < ?
            GROUP BY c.id, c.name, c.icon, c.color, c.locked, c.name_key ORDER BY amount DESC, c.name_key`, ...cur),
      stmt(`SELECT category_id AS id, SUM(my_share) AS amount FROM expenses WHERE ${R} GROUP BY category_id`, userId, base.start, base.end),
      stmt(`SELECT COUNT(DISTINCT substr(spent_on, 1, 7)) AS months, COALESCE(SUM(my_share), 0) AS amount FROM expenses WHERE ${R}`,
        userId, base.start, base.end),
      stmt(`SELECT substr(spent_on, 1, 7) AS k, SUM(my_share) AS amount FROM expenses WHERE ${R} GROUP BY substr(spent_on, 1, 7)`,
        userId, ...trendRange),
      stmt(`${EXPENSE_SELECT} WHERE e.user_id = ? AND e.spent_on >= ? AND e.spent_on < ?
            ORDER BY e.my_share DESC, e.spent_on DESC LIMIT 5`, ...cur),
      stmt(`SELECT COUNT(*) AS count, COALESCE(SUM(paid), 0) AS paid, COALESCE(SUM(my_share), 0) AS my_share
            FROM expenses WHERE ${R} AND paid > my_share`, ...cur),
    ]);
    const rows = <T>(i: number) => (res[i]?.rows ?? []) as T[];
    type B = { k: string; amount: number; count?: number };
    const toBuckets = (r: B[]): Bucket[] => r.map(b => ({ k: b.k, amount: num(b.amount), ...(b.count != null ? { count: num(b.count) } : {}) }));

    const t = rows<{ my_spend: number; others: number; count: number }>(0)[0]!;
    const bm = rows<{ months: number; amount: number }>(5)[0]!;
    const trendMap = Object.fromEntries(rows<B>(6).map(r => [r.k, num(r.amount)]));
    const sp = rows<{ count: number; paid: number; my_share: number }>(8)[0]!;

    return {
      totals: { mySpend: num(t.my_spend), others: num(t.others), count: num(t.count) },
      buckets: toBuckets(rows<B>(1)),
      prevBuckets: toBuckets(rows<B>(2)),
      byCategory: rows<CategoryRow & { amount: number; count: number }>(3)
        .map(r => ({ ...toCategory(r), amount: num(r.amount), count: num(r.count) })),
      baseline: {
        months: num(bm.months), amount: num(bm.amount),
        byCategory: Object.fromEntries(rows<{ id: string; amount: number }>(4).map(r => [r.id, num(r.amount)])),
      },
      trend: keys.map(k => ({ k, amount: trendMap[k] ?? 0 })),
      top: rows<ExpenseRow>(7).map(toExpense),
      splits: { count: num(sp.count), paid: num(sp.paid), myShare: num(sp.my_share) },
    };
  }

  async categorySummary(userId: Id, categoryId: Id, p: Period): Promise<CategorySummaryData | null> {
    const keys = last12(p.type === 'month' ? p.key : `${p.key}-12`);
    const [cat, list, hist] = await this.db.batch([
      stmt('SELECT id, name, icon, color, locked FROM categories WHERE id = ? AND user_id = ?', categoryId, userId),
      stmt(`${EXPENSE_SELECT} WHERE e.user_id = ? AND e.category_id = ? AND e.spent_on >= ? AND e.spent_on < ?
            ORDER BY e.spent_on DESC, e.created_at DESC`, userId, categoryId, p.start, p.end),
      stmt(`SELECT substr(spent_on, 1, 7) AS k, SUM(my_share) AS amount FROM expenses
            WHERE user_id = ? AND category_id = ? AND spent_on >= ? AND spent_on < ? GROUP BY substr(spent_on, 1, 7)`,
        userId, categoryId, `${keys[0]}-01`, `${addMonths(keys[11]!, 1)}-01`),
    ]);
    const c = (cat?.rows[0] as CategoryRow | undefined);
    if (!c) return null;
    const m = Object.fromEntries((hist?.rows as { k: string; amount: number }[]).map(r => [r.k, num(r.amount)]));
    return {
      category: toCategory(c),
      expenses: (list?.rows as ExpenseRow[]).map(toExpense),
      trend: keys.map(k => ({ k, amount: m[k] ?? 0 })),
    };
  }
}

// ---------- auth ----------

export class SqlSessionRepo implements SessionRepo {
  constructor(private db: SqlClient) {}

  async create(s: Session & { userAgent: string | null }) {
    await this.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [s.tokenHash, s.userId, s.createdAt, s.lastSeenAt, s.expiresAt, s.userAgent],
    );
  }

  async get(tokenHash: string) {
    const r = await this.db.first<{ token_hash: string; user_id: string; created_at: string; last_seen_at: string; expires_at: string }>(
      'SELECT token_hash, user_id, created_at, last_seen_at, expires_at FROM sessions WHERE token_hash = ?', [tokenHash]);
    return r && { tokenHash: r.token_hash, userId: r.user_id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at };
  }

  async touch(tokenHash: string, lastSeenAt: string, expiresAt: string) {
    await this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', [lastSeenAt, expiresAt, tokenHash]);
  }

  async delete(tokenHash: string) { await this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]); }
  async deleteAllForUser(userId: Id) { await this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]); }
  async deleteExpired(now: string) { await this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [now]); }
}

export class SqlAuthCodeRepo implements AuthCodeRepo {
  constructor(private db: SqlClient) {}

  async replace(c: AuthCode & { createdAt: string }) {
    const dayAgo = new Date(Date.parse(c.createdAt) - 86_400_000).toISOString();
    await this.db.batch([
      stmt('DELETE FROM auth_codes WHERE created_at < ?', dayAgo),                                   // housekeeping
      stmt('UPDATE auth_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL', c.createdAt, c.email), // only the newest code works
      stmt('INSERT INTO auth_codes (id, email, code_hash, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, 0)',
        c.id, c.email, c.codeHash, c.createdAt, c.expiresAt),
    ]);
  }

  async latestActive(email: string, now: string) {
    const r = await this.db.first<{ id: string; email: string; code_hash: string; expires_at: string; attempts: number }>(
      `SELECT id, email, code_hash, expires_at, attempts FROM auth_codes
       WHERE email = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`, [email, now]);
    return r && { id: r.id, email: r.email, codeHash: r.code_hash, expiresAt: r.expires_at, attempts: num(r.attempts) };
  }

  async incrementAttempts(id: Id) { await this.db.run('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?', [id]); }

  async consume(id: Id, now: string) {
    return (await this.db.run('UPDATE auth_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [now, id])).changes === 1;
  }
}

/** Fixed-window counter in the database (swap for Redis/DynamoDB at scale). */
export class SqlRateLimiter implements RateLimiter {
  constructor(private db: SqlClient) {}

  async hit(key: string, limit: number, windowSeconds: number, now: Date) {
    const windowMs = windowSeconds * 1000;
    const start = Math.floor(now.getTime() / windowMs) * windowMs;
    const r = await this.db.first<{ count: number }>(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
      [key, new Date(start).toISOString()],
    );
    if (Math.random() < 0.02) {
      await this.db.run('DELETE FROM rate_limits WHERE window_start < ?', [new Date(now.getTime() - 86_400_000).toISOString()]);
    }
    return num(r?.count) > limit ? Math.ceil((start + windowMs - now.getTime()) / 1000) : 0;
  }

  async count(key: string, windowSeconds: number, now: Date) {
    const windowMs = windowSeconds * 1000;
    const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString();
    const r = await this.db.first<{ count: number }>('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?', [key, start]);
    return num(r?.count);
  }
}
