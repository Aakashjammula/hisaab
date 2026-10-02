// Input validation for expenses and categories. Amounts arrive as rupee strings ("1000.50").
import { MAX_PAISE, toPaise } from '../../public/js/money.js';
import { COLOR_NAMES, ICON_NAMES } from '../../public/js/icon-list.js';
import { isValidDate } from './dates.ts';
import { invalid } from './errors.ts';
import type { CategoryInput, ExpenseInput } from './types.ts';

/** Trim, collapse inner whitespace, limit length. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return invalid('Category is required');
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) invalid('Category is required');
  if (name.length > 40) invalid('Category name is too long (max 40)');
  return name;
}

/** Case-insensitive identity of a category name ("Food" == " food "). */
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

  let myShare = paid;
  if (body.my_share != null && body.my_share !== '') {
    const share = toPaise(body.my_share);
    if (share == null) return invalid('Your share must be a number with at most 2 decimals');
    if (share > paid) invalid('Your share cannot be more than the amount paid');
    myShare = share;
  }

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
  };
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
