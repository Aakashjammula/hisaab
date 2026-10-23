// MCP tools: everything a person can do in the app, for Claude. Each tool calls the same services as the
// web API, so validation and rules can't drift. Money goes in as rupees and comes out as "450.00" strings.
import { toRupeeFixed } from '../../public/js/money.js';
import { COLOR_NAMES, ICON_NAMES } from '../../public/js/icon-list.js';
import type { Expense, User } from '../core/types.ts';
import type { PeriodQuery } from '../services/expenses.ts';
import type { AppDeps } from './app.ts';
import { categoryJson, expenseJson, personJson } from './json.ts';

type Args = Record<string, unknown>;

export interface ToolDef {
  name: string; title: string; description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint: boolean; openWorldHint: false };
  run(user: User, args: Args): Promise<unknown>;
}

export const serverInstructions = (timeZone: string) => [
  "Hisaab tracks the signed-in person's own spending.",
  'Amounts are Indian rupees (INR): send them as numbers or strings with at most 2 decimals; results show them as "450.00".',
  `Dates are YYYY-MM-DD in the ${timeZone} timezone. Call get_context for today's date instead of guessing what "today" or "yesterday" is.`,
  '"My share" is what the person personally spent; the rest of a split bill is what they paid for others.',
  'Before editing or deleting anything, find the exact item with list_expenses, list_categories or list_people and act on its id.',
  "Categories and people named in add_expense are created automatically if they don't exist yet.",
].join('\n');

// ---------- output shaping (paise -> rupee strings) ----------

const rupees = (paise: number | null) => (paise == null ? null : toRupeeFixed(paise));

export function toolExpense(e: Expense) {
  const j = expenseJson(e);
  return { ...j, paid: rupees(j.paid), my_share: rupees(j.my_share), shares: j.shares.map(s => ({ ...s, amount: rupees(s.amount) })) };
}

const bucketRupees = <T extends { amount: number }>(b: T) => ({ ...b, amount: rupees(b.amount) });

// ---------- input helpers ----------

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const period = (a: Args): PeriodQuery => ({ month: str(a.month), year: str(a.year) });
const id = (a: Args): string => str(a.id) ?? '';

const PERIOD_PROPS = {
  month: { type: 'string', description: 'Month as YYYY-MM. Defaults to the current month.' },
  year: { type: 'string', description: 'A whole year as YYYY, instead of a month.' },
};
const ID_PROP = (what: string) => ({ id: { type: 'string', description: `The ${what}'s id` } });
const AMOUNT = { type: ['number', 'string'], description: 'Rupees, at most 2 decimals' };
const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

export function buildTools(d: AppDeps): ToolDef[] {
  return [
    {
      name: 'get_context', title: 'Who and when',
      description: "The signed-in email, today's date in their timezone, the timezone and the currency. Call this before working out relative dates.",
      inputSchema: schema({}), annotations: READ,
      run: async user => ({ email: user.email, today: d.categories.today(), time_zone: d.timeZone, currency: 'INR' }),
    },
    {
      name: 'list_expenses', title: 'List expenses',
      description: 'Expenses in a month (default: this month) or a year, newest first. Optional filters: category_id, person_id, '
        + 'text (matches note, category or person names, any case), min_amount and max_amount (on the amount paid).',
      inputSchema: schema({
        ...PERIOD_PROPS,
        category_id: { type: 'string' }, person_id: { type: 'string' },
        text: { type: 'string' }, min_amount: AMOUNT, max_amount: AMOUNT,
      }),
      annotations: READ,
      run: async (user, a) => {
        const q = period(a);
        const p = d.expenses.period(q);
        const list = await d.expenses.search(user.id, q, {
          categoryId: str(a.category_id), personId: str(a.person_id), text: str(a.text), minAmount: a.min_amount, maxAmount: a.max_amount,
        });
        return { period: { type: p.type, key: p.key }, expenses: list.map(toolExpense) };
      },
    },
    {
      name: 'get_summary', title: 'Spending summary',
      description: 'Totals for a month or year: my spend, paid for others, by category, by person, daily/monthly buckets, '
        + 'comparison with the previous period and the usual baseline, and the biggest expenses.',
      inputSchema: schema(PERIOD_PROPS), annotations: READ,
      run: async (user, a) => {
        const s = await d.summary.summary(user.id, period(a));
        return {
          ...s,
          my_spend: rupees(s.my_spend), paid_for_others: rupees(s.paid_for_others),
          prev: { ...s.prev, total: rupees(s.prev.total), same_point: rupees(s.prev.same_point) },
          baseline: s.baseline && { ...s.baseline, avg_total: rupees(s.baseline.avg_total) },
          buckets: s.buckets.map(bucketRupees), prev_buckets: s.prev_buckets.map(bucketRupees), trend: s.trend.map(bucketRupees),
          by_category: s.by_category.map(c => ({ ...c, amount: rupees(c.amount), baseline_avg: rupees(c.baseline_avg) })),
          by_person: s.by_person.map(bucketRupees),
          top: s.top.map(toolExpense),
          splits: { ...s.splits, paid: rupees(s.splits.paid), my_share: rupees(s.splits.my_share) },
          unassigned: rupees(s.unassigned),
        };
      },
    },
    {
      name: 'get_category_summary', title: 'Category summary',
      description: "One category's expenses in a month or year, and its monthly trend.",
      inputSchema: schema({ ...ID_PROP('category'), ...PERIOD_PROPS }, ['id']), annotations: READ,
      run: async (user, a) => {
        const s = await d.summary.categorySummary(user.id, id(a), period(a));
        return { ...s, category: categoryJson(s.category), expenses: s.expenses.map(toolExpense), trend: s.trend.map(bucketRupees) };
      },
    },
    {
      name: 'get_person_summary', title: 'Person summary',
      description: 'The expenses split with one person in a month or year.',
      inputSchema: schema({ ...ID_PROP('person'), ...PERIOD_PROPS }, ['id']), annotations: READ,
      run: async (user, a) => {
        const s = await d.people.summary(user.id, id(a), period(a));
        return { ...s, person: personJson(s.person), expenses: s.expenses.map(toolExpense) };
      },
    },
    {
      name: 'list_categories', title: 'List categories',
      description: 'All categories, most used first, plus the icon and colour names a category can use. "Other" cannot be deleted.',
      inputSchema: schema({}), annotations: READ,
      run: async user => ({
        categories: (await d.categories.list(user.id)).map(categoryJson), icons: [...ICON_NAMES], colors: [...COLOR_NAMES],
      }),
    },
    {
      name: 'list_people', title: 'List people',
      description: 'Everyone the person splits bills with, most used first.',
      inputSchema: schema({}), annotations: READ,
      run: async user => ({ people: (await d.people.list(user.id)).map(personJson) }),
    },
  ];
}
