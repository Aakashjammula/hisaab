// Dates are plain 'YYYY-MM-DD' strings; "today" is computed in the owner's time zone.
import { HttpError } from './http.js';

export function todayIn(timeZone = 'Asia/Kolkata', now = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

/** Shift a 'YYYY-MM' key by n months. */
export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/**
 * Period from query params: ?month=YYYY-MM or ?year=YYYY (default: current month).
 * Returns { type, key, start, end (exclusive), units, elapsed, prev, today }
 *   units   = days in the month, or days in the year
 *   elapsed = how many of those units have passed (for pace / same-point comparisons)
 */
export function parsePeriod(params, timeZone) {
  const today = todayIn(timeZone);
  const year = params.get('year'), month = params.get('month');

  if (year) {
    if (!/^\d{4}$/.test(year) || +year < 2000 || +year > 2100) throw new HttpError(400, 'Invalid year');
    const y = +year, units = daysInMonth(y, 2) === 29 ? 366 : 365;
    const ty = +today.slice(0, 4);
    const dayOfYear = Math.round((Date.parse(today) - Date.UTC(ty, 0, 1)) / 86400000) + 1;
    const elapsed = y < ty ? units : y > ty ? 0 : dayOfYear;
    return { type: 'year', key: year, start: `${y}-01-01`, end: `${y + 1}-01-01`, units, elapsed, prev: String(y - 1), today };
  }

  const key = month ?? today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || +key.slice(0, 4) < 2000 || +key.slice(0, 4) > 2100) {
    throw new HttpError(400, 'Invalid month');
  }
  const [y, m] = key.split('-').map(Number);
  const units = daysInMonth(y, m);
  const cur = today.slice(0, 7);
  const elapsed = key < cur ? units : key > cur ? 0 : +today.slice(8, 10);
  return { type: 'month', key, start: `${key}-01`, end: `${addMonths(key, 1)}-01`, units, elapsed, prev: addMonths(key, -1), today };
}
