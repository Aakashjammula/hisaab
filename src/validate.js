import { MAX_PAISE, toPaise } from '../public/js/money.js';
import { COLOR_NAMES, ICON_NAMES } from '../public/js/icon-list.js';
import { isValidDate } from './dates.js';
import { HttpError } from './http.js';

const bad = msg => { throw new HttpError(400, msg); };

/** Trim, collapse inner whitespace. */
export function cleanName(raw) {
  if (typeof raw !== 'string') bad('Category is required');
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) bad('Category is required');
  if (name.length > 40) bad('Category name is too long (max 40)');
  return name;
}

export function checkIcon(icon) {
  if (icon == null) return null;
  if (!ICON_NAMES.has(icon)) bad('Unknown icon');
  return icon;
}

export function checkColor(color) {
  if (color == null) return null;
  if (!COLOR_NAMES.has(color)) bad('Unknown colour');
  return color;
}

/** Body of POST/PUT /api/expenses. Amounts arrive as rupee strings ("1000.50"). */
export function parseExpense(body) {
  const paid = toPaise(body.paid);
  if (paid == null) bad('Amount must be a number with at most 2 decimals');
  if (paid <= 0) bad('Amount must be more than ₹0');
  if (paid > MAX_PAISE) bad('Amount is over the ₹10,00,000 limit');

  let my_share = paid;
  if (body.my_share != null && body.my_share !== '') {
    my_share = toPaise(body.my_share);
    if (my_share == null) bad('Your share must be a number with at most 2 decimals');
    if (my_share > paid) bad('Your share cannot be more than the amount paid');
  }

  if (!isValidDate(body.spent_on)) bad('Date must be a valid YYYY-MM-DD');

  let note = null;
  if (body.note != null) {
    if (typeof body.note !== 'string') bad('Note must be text');
    note = body.note.trim() || null;
    if (note && note.length > 200) bad('Note is too long (max 200)');
  }

  return {
    paid, my_share, note, spent_on: body.spent_on,
    category: cleanName(body.category),
    category_icon: checkIcon(body.category_icon),
    category_color: checkColor(body.category_color),
  };
}
