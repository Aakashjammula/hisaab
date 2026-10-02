// All analytics numbers come from SQL integer sums (paise), in one D1 batch so they're consistent.
import { json, parseId, HttpError } from '../http.js';
import { addMonths, parsePeriod } from '../dates.js';
import { EXPENSE_SELECT } from './expenses.js';

/** Bounds of the comparison period (previous month / previous year). */
function prevBounds(p) {
  return p.type === 'month'
    ? { start: `${p.prev}-01`, end: p.start }
    : { start: `${p.prev}-01-01`, end: p.start };
}

/** 12 consecutive month keys ending at `lastKey`. */
const last12 = lastKey => Array.from({ length: 12 }, (_, i) => addMonths(lastKey, i - 11));

/** GET /api/summary?month=YYYY-MM | ?year=YYYY */
export async function summary(env, url) {
  const p = parsePeriod(url.searchParams, env.TIME_ZONE);
  const prev = prevBounds(p);
  const bucket = p.type === 'month' ? 'spent_on' : 'substr(spent_on, 1, 7)';
  const range = 'spent_on >= ? AND spent_on < ?';
  const cur = [p.start, p.end], prv = [prev.start, prev.end];

  // Baseline for "vs usual": month view = previous 6 months; year view = previous year.
  const base = p.type === 'month'
    ? { start: `${addMonths(p.key, -6)}-01`, end: p.start }
    : prev;
  const trendKeys = last12(p.type === 'month' ? p.key : `${p.key}-12`);
  const trendStart = `${trendKeys[0]}-01`, trendEnd = `${addMonths(trendKeys[11], 1)}-01`;

  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const [totals, buckets, prevBuckets, byCat, baseCat, baseMonths, trend, top, splits] = await env.DB.batch([
    q(`SELECT COALESCE(SUM(my_share),0) AS my_spend, COALESCE(SUM(paid - my_share),0) AS others, COUNT(*) AS count
       FROM expenses WHERE ${range}`, ...cur),
    q(`SELECT ${bucket} AS k, SUM(my_share) AS amount, COUNT(*) AS count FROM expenses WHERE ${range} GROUP BY k ORDER BY k`, ...cur),
    q(`SELECT ${bucket} AS k, SUM(my_share) AS amount FROM expenses WHERE ${range} GROUP BY k ORDER BY k`, ...prv),
    q(`SELECT c.id, c.name, c.icon, c.color, SUM(e.my_share) AS amount, COUNT(*) AS count
       FROM expenses e JOIN categories c ON c.id = e.category_id
       WHERE e.spent_on >= ? AND e.spent_on < ? GROUP BY c.id ORDER BY amount DESC, c.name`, ...cur),
    q(`SELECT category_id AS id, SUM(my_share) AS amount FROM expenses WHERE ${range} GROUP BY category_id`, base.start, base.end),
    q(`SELECT COUNT(DISTINCT substr(spent_on, 1, 7)) AS months, COALESCE(SUM(my_share),0) AS amount
       FROM expenses WHERE ${range}`, base.start, base.end),
    q(`SELECT substr(spent_on, 1, 7) AS k, SUM(my_share) AS amount FROM expenses WHERE ${range} GROUP BY k`, trendStart, trendEnd),
    q(`${EXPENSE_SELECT} WHERE e.spent_on >= ? AND e.spent_on < ? ORDER BY e.my_share DESC, e.spent_on DESC LIMIT 5`, ...cur),
    q(`SELECT COUNT(*) AS count, COALESCE(SUM(paid),0) AS paid, COALESCE(SUM(my_share),0) AS my_share
       FROM expenses WHERE ${range} AND paid > my_share`, ...cur),
  ]);

  const t = totals.results[0];
  const prevRows = prevBuckets.results;
  const prevTotal = prevRows.reduce((s, r) => s + r.amount, 0);

  // Previous period up to the same point (same day of month / same month of year).
  const samePointKey = p.type === 'month'
    ? `${p.prev}-${String(Math.max(p.elapsed, 0)).padStart(2, '0')}`
    : `${p.prev}-${String(Math.ceil(p.elapsed / p.units * 12)).padStart(2, '0')}`;
  const prevSamePoint = prevRows.filter(r => r.k <= samePointKey).reduce((s, r) => s + r.amount, 0);

  // Baseline: average per month (month view) over the months that actually have data, or last year's total.
  const bm = baseMonths.results[0];
  const divisor = p.type === 'month' ? bm.months : 1;
  const baseByCat = Object.fromEntries(baseCat.results.map(r => [r.id, r.amount]));
  const baseline = divisor ? { months: bm.months, avg_total: Math.round(bm.amount / divisor) } : null;

  const trendMap = Object.fromEntries(trend.results.map(r => [r.k, r.amount]));

  return json({
    period: { type: p.type, key: p.key, start: p.start, end: p.end, units: p.units, elapsed: p.elapsed, today: p.today, prev: p.prev },
    my_spend: t.my_spend,
    paid_for_others: t.others,
    count: t.count,
    prev: { total: prevTotal, same_point: prevSamePoint, has_data: prevRows.length > 0 },
    baseline,
    buckets: buckets.results,
    prev_buckets: prevRows,
    by_category: byCat.results.map(c => ({
      ...c,
      baseline_avg: divisor && baseByCat[c.id] != null ? Math.round(baseByCat[c.id] / divisor) : null,
    })),
    trend: trendKeys.map(k => ({ k, amount: trendMap[k] ?? 0 })),
    top: top.results,
    splits: splits.results[0],
  });
}

/** GET /api/categories/:id/summary?month=… — drill-down: that category's expenses + 12-month history. */
export async function categorySummary(env, url, rawId) {
  const id = parseId(rawId);
  const p = parsePeriod(url.searchParams, env.TIME_ZONE);
  const keys = last12(p.type === 'month' ? p.key : `${p.key}-12`);
  const [cat, list, hist] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, icon, color, locked FROM categories WHERE id = ?').bind(id),
    env.DB.prepare(`${EXPENSE_SELECT} WHERE e.category_id = ? AND e.spent_on >= ? AND e.spent_on < ? ORDER BY e.spent_on DESC, e.id DESC`)
      .bind(id, p.start, p.end),
    env.DB.prepare(`SELECT substr(spent_on, 1, 7) AS k, SUM(my_share) AS amount FROM expenses
                    WHERE category_id = ? AND spent_on >= ? AND spent_on < ? GROUP BY k`)
      .bind(id, `${keys[0]}-01`, `${addMonths(keys[11], 1)}-01`),
  ]);
  if (!cat.results.length) throw new HttpError(404, 'Category not found');
  const m = Object.fromEntries(hist.results.map(r => [r.k, r.amount]));
  return json({
    category: { ...cat.results[0], locked: !!cat.results[0].locked },
    period: { type: p.type, key: p.key },
    expenses: list.results,
    trend: keys.map(k => ({ k, amount: m[k] ?? 0 })),
  });
}
