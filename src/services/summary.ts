// Analytics: SQL returns integer sums; this turns them into the response the UI renders.
import { notFound } from '../core/errors.ts';
import { isId } from '../core/validate.ts';
import type { Id } from '../core/types.ts';
import type { SummaryRepo } from '../ports/index.ts';
import type { ExpenseService, PeriodQuery } from './expenses.ts';

export class SummaryService {
  constructor(private repo: SummaryRepo, private expenses: ExpenseService) {}

  async summary(userId: Id, q: PeriodQuery) {
    const p = this.expenses.period(q);
    const d = await this.repo.summary(userId, p);

    const prevTotal = d.prevBuckets.reduce((s, b) => s + b.amount, 0);
    // Previous period up to the same point (same day of month / same month of year).
    const samePointKey = p.type === 'month'
      ? `${p.prev}-${String(Math.max(p.elapsed, 0)).padStart(2, '0')}`
      : `${p.prev}-${String(Math.ceil(p.elapsed / p.units * 12)).padStart(2, '0')}`;
    const prevSamePoint = d.prevBuckets.filter(b => b.k <= samePointKey).reduce((s, b) => s + b.amount, 0);

    // Baseline: average per month over months that actually have data (month view), or last year's total.
    const divisor = p.type === 'month' ? d.baseline.months : 1;
    const baseline = divisor ? { months: d.baseline.months, avg_total: Math.round(d.baseline.amount / divisor) } : null;

    return {
      period: { type: p.type, key: p.key, start: p.start, end: p.end, units: p.units, elapsed: p.elapsed, today: p.today, prev: p.prev },
      my_spend: d.totals.mySpend,
      paid_for_others: d.totals.others,
      count: d.totals.count,
      prev: { total: prevTotal, same_point: prevSamePoint, has_data: d.prevBuckets.length > 0 },
      baseline,
      buckets: d.buckets,
      prev_buckets: d.prevBuckets,
      by_category: d.byCategory.map(c => ({
        id: c.id, name: c.name, icon: c.icon, color: c.color, amount: c.amount, count: c.count,
        baseline_avg: divisor && d.baseline.byCategory[c.id] != null ? Math.round(d.baseline.byCategory[c.id]! / divisor) : null,
      })),
      trend: d.trend,
      top: d.top,
      splits: { count: d.splits.count, paid: d.splits.paid, my_share: d.splits.myShare },
    };
  }

  async categorySummary(userId: Id, rawId: string, q: PeriodQuery) {
    if (!isId(rawId)) notFound('Category');
    const p = this.expenses.period(q);
    const d = await this.repo.categorySummary(userId, rawId, p) ?? notFound('Category');
    return { category: d.category, period: { type: p.type, key: p.key }, expenses: d.expenses, trend: d.trend };
  }
}
