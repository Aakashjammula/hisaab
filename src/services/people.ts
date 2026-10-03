// People you split bills with. Only names: they are labels on your own expenses, not accounts.
import { daysBefore, todayIn } from '../core/dates.ts';
import { notFound } from '../core/errors.ts';
import { isId, nameKey, parsePersonInput } from '../core/validate.ts';
import type { Id, Person, PersonWithUsage } from '../core/types.ts';
import type { Clock, ExpenseRepo, IdGenerator, PersonRepo } from '../ports/index.ts';
import type { AppConfig } from './config.ts';
import type { ExpenseService, PeriodQuery } from './expenses.ts';

interface Deps { people: PersonRepo; expenses: ExpenseRepo; ids: IdGenerator; clock: Clock; config: AppConfig }

const requireId = (raw: string): Id => (isId(raw) ? raw : notFound('Person'));

export class PersonService {
  constructor(private d: Deps, private expenseService: ExpenseService) {}

  /** Most recently / frequently split with first (drives the picker order). */
  list(userId: Id): Promise<PersonWithUsage[]> {
    return this.d.people.list(userId, daysBefore(todayIn(this.d.config.timeZone, this.d.clock.now()), 90));
  }

  create(userId: Id, body: Record<string, unknown>): Promise<Person> {
    const { name } = parsePersonInput(body);
    return this.d.people.create(userId, { id: this.d.ids.next(), name, nameKey: nameKey(name), createdAt: this.d.clock.now().toISOString() });
  }

  async rename(userId: Id, rawId: string, body: Record<string, unknown>): Promise<Person> {
    const id = requireId(rawId);
    const { name } = parsePersonInput(body);
    return await this.d.people.rename(userId, id, name, nameKey(name)) ?? notFound('Person');
  }

  async delete(userId: Id, rawId: string): Promise<void> {
    if (!(await this.d.people.delete(userId, requireId(rawId)))) notFound('Person');
  }

  /** The expenses this person was part of in a month or year. */
  async summary(userId: Id, rawId: string, q: PeriodQuery) {
    const id = requireId(rawId);
    const p = this.expenseService.period(q);
    const person = await this.d.people.get(userId, id) ?? notFound('Person');
    const expenses = await this.d.expenses.listInRange(userId, p.start, p.end, { personId: id });
    return { person, period: { type: p.type, key: p.key }, expenses };
  }
}
