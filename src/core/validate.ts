// Input validation for expenses, categories and people. Amounts arrive as rupee strings ("1000.50").
import { MAX_PAISE, toPaise } from '../../public/js/money.js';
import { COLOR_NAMES, ICON_NAMES } from '../../public/js/icon-list.js';
import { isValidDate } from './dates.ts';
import { invalid } from './errors.ts';
import type { CategoryInput, ExpenseInput } from './types.ts';

const MAX_SHARES = 50;

/** Trim, collapse inner whitespace, limit length. */
export function cleanName(raw: unknown, what = 'Category'): string {
  if (typeof raw !== 'string') return invalid(`${what} is required`);
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) invalid(`${what} is required`);
  if (name.length > 40) invalid(`${what} is too long (max 40)`);
  return name;
}

/** Case-insensitive identity of a category or person name ("Food" == " food "). */
export const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

export function checkIcon(icon: unknown): string | null {
  if (icon == null) return null;
  if (typeof icon !== 'string' || !ICON_NAMES.has(icon)) invalid('Unknown icon');
  return icon as string;
}

export function checkColor(color: unknown): string | null {
  if (color == null) return null;
  if (typeof color !== 'string' || !COLOR_NAMES.has(color)) invalid('Unknown colour');
  return color as string;
}

export function parseExpenseInput(body: Record<string, unknown>): ExpenseInput {
  const paid = toPaise(body.paid);
  if (paid == null) return invalid('Amount must be a number with at most 2 decimals');
  if (paid <= 0) invalid('Amount must be more than ₹0');
  if (paid > MAX_PAISE) invalid('Amount is over the ₹10,00,000 limit');

  const shares = parseShares(body.shares);
  const others = shares.reduce((sum, s) => sum + s.amount, 0);

  let myShare = shares.length ? paid - others : paid;
  if (body.my_share != null && body.my_share !== '') {
    const share = toPaise(body.my_share);
    if (share == null) return invalid('Your share must be a number with at most 2 decimals');
    if (share > paid) invalid('Your share cannot be more than the amount paid');
    myShare = share;
  }
  if (shares.length && (myShare < 0 || myShare + others !== paid)) invalid('Your share and everyone else’s must add up to the amount paid');

  if (!isValidDate(body.spent_on)) invalid('Date must be a valid YYYY-MM-DD');

  let note: string | null = null;
  if (body.note != null) {
    if (typeof body.note !== 'string') invalid('Note must be text');
    note = (body.note as string).trim() || null;
    if (note && note.length > 200) invalid('Note is too long (max 200)');
  }

  return {
    paid, myShare, note, spentOn: body.spent_on as string,
    category: cleanName(body.category),
    categoryIcon: checkIcon(body.category_icon),
    categoryColor: checkColor(body.category_color),
    shares,
  };
}

/** [{ person: "Ravi", amount: "80" }] -> [{ person: "Ravi", amount: 8000 }]. Missing = no people. */
function parseShares(raw: unknown): ExpenseInput['shares'] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return invalid('Shares must be a list');
  if (raw.length > MAX_SHARES) invalid(`At most ${MAX_SHARES} people per expense`);
  const seen = new Set<string>();
  return raw.map(item => {
    const s = (item ?? {}) as Record<string, unknown>;
    const person = cleanName(s.person, 'Name');
    const key = nameKey(person);
    if (seen.has(key)) invalid(`${person} is in the split twice`);
    seen.add(key);
    const amount = toPaise(s.amount);
    if (amount == null) return invalid(`${person}’s share must be a number with at most 2 decimals`);
    if (amount <= 0) invalid(`${person}’s share must be more than ₹0`);
    return { person, amount };
  });
}

export function parsePersonInput(body: Record<string, unknown>): { name: string } {
  return { name: cleanName(body.name, 'Name') };
}

export function parseCategoryInput(body: Record<string, unknown>, { requireName }: { requireName: boolean }): CategoryInput {
  const out: CategoryInput = {};
  if (body.name != null || requireName) out.name = cleanName(body.name);
  const icon = checkIcon(body.icon); if (icon) out.icon = icon;
  const color = checkColor(body.color); if (color) out.color = color;
  if (!requireName && !Object.keys(out).length) invalid('Nothing to update');
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isId = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
