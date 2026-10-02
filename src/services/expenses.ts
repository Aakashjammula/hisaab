import { suggestIcon, COLORS } from '../../public/js/icon-list.js';
import { daysBefore, parsePeriod, todayIn } from '../core/dates.ts';
import { AppError, notFound } from '../core/errors.ts';
import { isId, nameKey, parseCategoryInput, parseExpenseInput } from '../core/validate.ts';
import type { Category, CategoryWithUsage, Expense, ExpenseInput, Id, Period } from '../core/types.ts';
import type { CategoryRepo, Clock, ExpenseRepo, IdGenerator, NewCategory } from '../ports/index.ts';
import type { AppConfig } from './config.ts';

export interface PeriodQuery { month?: string | null; year?: string | null }

interface Deps { expenses: ExpenseRepo; categories: CategoryRepo; ids: IdGenerator; clock: Clock; config: AppConfig }

const requireId = (raw: string, what: string): Id => (isId(raw) ? raw : notFound(what));

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
    return this.d.expenses.listInRange(userId, p.start, p.end, categoryId ? requireId(categoryId, 'Category') : undefined);
  }

  private async toNew(userId: Id, input: ExpenseInput) {
    return {
      paid: input.paid, myShare: input.myShare, note: input.note, spentOn: input.spentOn,
      now: this.d.clock.now().toISOString(),
      category: await this.categories.newCategory(userId, input.category, input.categoryIcon, input.categoryColor),
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

  async delete(userId: Id, rawId: string): Promise<void> {
    const id = requireId(rawId, 'Expense');
    if (!(await this.d.expenses.delete(userId, id))) notFound('Expense');
  }
}
