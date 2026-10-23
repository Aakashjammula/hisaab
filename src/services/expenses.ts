import { suggestIcon, COLORS } from '../../public/js/icon-list.js';
import { daysBefore, parsePeriod, todayIn } from '../core/dates.ts';
import { formatINR, toPaise, toRupeeString } from '../../public/js/money.js';
import { AppError, invalid, notFound } from '../core/errors.ts';
import { isId, nameKey, parseCategoryInput, parseExpenseInput } from '../core/validate.ts';
import type { Category, CategoryWithUsage, Expense, ExpenseInput, Id, Period } from '../core/types.ts';
import type { CategoryRepo, Clock, ExpenseFilter, ExpenseRepo, IdGenerator, NewCategory } from '../ports/index.ts';
import type { AppConfig } from './config.ts';

export interface PeriodQuery { month?: string | null; year?: string | null }

interface Deps { expenses: ExpenseRepo; categories: CategoryRepo; ids: IdGenerator; clock: Clock; config: AppConfig }

const requireId = (raw: string, what: string): Id => (isId(raw) ? raw : notFound(what));

export interface ExpenseSearch { categoryId?: string | null; personId?: string | null; text?: string | null; minAmount?: unknown; maxAmount?: unknown }

/** Optional rupee bound -> paise; null when absent. */
function amountBound(raw: unknown, what: string): number | null {
  if (raw == null || raw === '') return null;
  return toPaise(raw) ?? invalid(`${what} must be a number with at most 2 decimals`);
}

export class CategoryService {
  constructor(private d: Deps) {}

  today(): string { return todayIn(this.d.config.timeZone, this.d.clock.now()); }

  /** Most recently / frequently used first (drives the picker order). */
  list(userId: Id): Promise<CategoryWithUsage[]> {
    return this.d.categories.list(userId, daysBefore(this.today(), 90));
  }

  /** Least-used palette colour, so new categories look distinct. */
  async pickColor(userId: Id): Promise<string> {
    const used = await this.d.categories.usedColors(userId);
    const names = COLORS.map(c => c[0] as string);
    return names.sort((a, b) => (used[a] ?? 0) - (used[b] ?? 0))[0]!;
  }

  async newCategory(userId: Id, name: string, icon: string | null, color: string | null): Promise<NewCategory> {
    return {
      id: this.d.ids.next(), name, nameKey: nameKey(name),
      icon: icon ?? suggestIcon(name), color: color ?? await this.pickColor(userId),
      locked: false, createdAt: this.d.clock.now().toISOString(),
    };
  }

  async create(userId: Id, body: Record<string, unknown>): Promise<Category> {
    const input = parseCategoryInput(body, { requireName: true });
    return this.d.categories.create(userId, await this.newCategory(userId, input.name!, input.icon ?? null, input.color ?? null));
  }

  async update(userId: Id, rawId: string, body: Record<string, unknown>): Promise<Category> {
    const id = requireId(rawId, 'Category');
    const input = parseCategoryInput(body, { requireName: false });
    const updated = await this.d.categories.update(userId, id, { ...input, ...(input.name ? { nameKey: nameKey(input.name) } : {}) });
    return updated ?? notFound('Category');
  }

  async delete(userId: Id, rawId: string): Promise<number> {
    const id = requireId(rawId, 'Category');
    const cat = await this.d.categories.get(userId, id) ?? notFound('Category');
    if (cat.locked) throw new AppError('validation', `“${cat.name}” cannot be deleted`);
    return this.d.categories.deleteMovingToOther(userId, id);
  }
}

export class ExpenseService {
  constructor(private d: Deps, private categories: CategoryService) {}

  period(q: PeriodQuery): Period {
    return parsePeriod(q, this.categories.today());
  }

  list(userId: Id, q: PeriodQuery, categoryId?: string | null): Promise<Expense[]> {
    const p = this.period(q);
    return this.d.expenses.listInRange(userId, p.start, p.end, categoryId ? { categoryId: requireId(categoryId, 'Category') } : {});
  }

  /** list() plus filters for Claude: person, text in note/category/people, and a range on the amount paid. */
  async search(userId: Id, q: PeriodQuery, s: ExpenseSearch): Promise<Expense[]> {
    const p = this.period(q);
    const filter: ExpenseFilter = {};
    if (s.categoryId) filter.categoryId = requireId(s.categoryId, 'Category');
    if (s.personId) filter.personId = requireId(s.personId, 'Person');
    const min = amountBound(s.minAmount, 'min_amount'), max = amountBound(s.maxAmount, 'max_amount');
    const text = s.text?.trim().toLowerCase();
    const list = await this.d.expenses.listInRange(userId, p.start, p.end, filter);
    return list.filter(e =>
      (min == null || e.paid >= min) && (max == null || e.paid <= max) &&
      (!text || [e.note ?? '', e.category.name, ...e.shares.map(x => x.person.name)].some(v => v.toLowerCase().includes(text))));
  }

  private async toNew(userId: Id, input: ExpenseInput) {
    const now = this.d.clock.now().toISOString();
    return {
      paid: input.paid, myShare: input.myShare, note: input.note, spentOn: input.spentOn, now,
      category: await this.categories.newCategory(userId, input.category, input.categoryIcon, input.categoryColor),
      shares: input.shares.map(s => ({
        person: { id: this.d.ids.next(), name: s.person, nameKey: nameKey(s.person), createdAt: now },
        amount: s.amount,
      })),
    };
  }

  async create(userId: Id, body: Record<string, unknown>): Promise<Expense> {
    const input = parseExpenseInput(body);
    return this.d.expenses.create(userId, { id: this.d.ids.next(), ...await this.toNew(userId, input) });
  }

  async update(userId: Id, rawId: string, body: Record<string, unknown>): Promise<Expense> {
    const id = requireId(rawId, 'Expense');
    const input = parseExpenseInput(body);
    if (!(await this.d.expenses.update(userId, id, await this.toNew(userId, input)))) notFound('Expense');
    return (await this.d.expenses.get(userId, id))!;
  }

  /**
   * Partial edit for Claude: only the fields in `patch` change. A new amount on a split expense must come
   * with the new split (shares and/or my_share): we ask rather than guess how to divide someone's money.
   */
  async patch(userId: Id, rawId: string, patch: Record<string, unknown>): Promise<Expense> {
    const current = await this.get(userId, rawId);
    const has = (k: string) => k in patch;

    const newPaid = has('paid') ? toPaise(patch.paid) : null;
    const isSplit = current.shares.length > 0 || current.myShare < current.paid;
    if (newPaid != null && newPaid !== current.paid && isSplit && !has('shares') && !has('my_share')) {
      const others = current.shares.reduce((sum, s) => sum + s.amount, 0);
      const unassigned = current.paid - current.myShare - others;
      const parts = [`you ${formatINR(current.myShare)}`, ...current.shares.map(s => `${s.person.name} ${formatINR(s.amount)}`)];
      if (unassigned > 0) parts.push(`unassigned ${formatINR(unassigned)}`);
      invalid(`This expense is split (${parts.join(', ')}). Send the new shares for ${formatINR(newPaid)}.`);
    }

    const body: Record<string, unknown> = {
      paid: has('paid') ? patch.paid : toRupeeString(current.paid),
      spent_on: has('spent_on') ? patch.spent_on : current.spentOn,
      note: has('note') ? patch.note : current.note,
      category: has('category') ? patch.category : current.category.name,
      category_icon: patch.category_icon,
      category_color: patch.category_color,
      shares: has('shares') ? patch.shares : current.shares.map(s => ({ person: s.person.name, amount: toRupeeString(s.amount) })),
    };
    // Left out, the validator works my share out: what's left after the shares, or all of it when not split.
    if (has('my_share')) body.my_share = patch.my_share;
    else if (isSplit && !has('shares')) body.my_share = toRupeeString(current.myShare);
    return this.update(userId, current.id, body);
  }

  async get(userId: Id, rawId: string): Promise<Expense> {
    return await this.d.expenses.get(userId, requireId(rawId, 'Expense')) ?? notFound('Expense');
  }

  async delete(userId: Id, rawId: string): Promise<void> {
    const id = requireId(rawId, 'Expense');
    if (!(await this.d.expenses.delete(userId, id))) notFound('Expense');
  }
}
