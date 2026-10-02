// Dates are plain 'YYYY-MM-DD' strings; "today" is computed in the owner's time zone.
import { invalid } from './errors.ts';
import type { Period } from './types.ts';

export function todayIn(timeZone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}

/** m is 1-12 */
export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Shift a 'YYYY-MM' key by n months. */
export function addMonths(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' n days before the given date. */
export function daysBefore(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** Period from query params: month=YYYY-MM or year=YYYY (default: current month). */
export function parsePeriod(params: { month?: string | null; year?: string | null }, today: string): Period {
  if (params.year) {
    const year = params.year;
    if (!/^\d{4}$/.test(year) || +year < 2000 || +year > 2100) invalid('Invalid year');
    const y = +year, units = daysInMonth(y, 2) === 29 ? 366 : 365;
    const ty = +today.slice(0, 4);
    const dayOfYear = Math.round((Date.parse(today) - Date.UTC(ty, 0, 1)) / 86_400_000) + 1;
    const elapsed = y < ty ? units : y > ty ? 0 : dayOfYear;
    return { type: 'year', key: year, start: `${y}-01-01`, end: `${y + 1}-01-01`, units, elapsed, prev: String(y - 1), today };
  }

  const key = params.month ?? today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || +key.slice(0, 4) < 2000 || +key.slice(0, 4) > 2100) invalid('Invalid month');
  const [y, m] = key.split('-').map(Number) as [number, number];
  const units = daysInMonth(y, m);
  const cur = today.slice(0, 7);
  const elapsed = key < cur ? units : key > cur ? 0 : +today.slice(8, 10);
  return { type: 'month', key, start: `${key}-01`, end: `${addMonths(key, 1)}-01`, units, elapsed, prev: addMonths(key, -1), today };
}
