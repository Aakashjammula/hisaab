// Money helpers shared by the browser and the Worker.
// All amounts are integer paise. Never multiply floats: "19.99" * 100 = 1998.9999999999998.

export const MAX_PAISE = 100_000_000; // ₹10,00,000 per expense

const RUPEES_RE = /^(\d{1,9})(?:\.(\d{0,2}))?$/;

/** "1,000.5" | "₹1000" | 1000 -> 100050 | 100000. Returns null when not a valid rupee amount. */
export function toPaise(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/^₹\s*/, '').replace(/,/g, '');
  const m = RUPEES_RE.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

/**
 * Keep only what a rupee amount can contain while the user types:
 * digits, one ".", at most 2 decimals, at most 7 whole digits. "1a2.345" -> "12.34"
 */
export function cleanAmountInput(value) {
  const v = String(value).replace(/[^\d.]/g, '');
  const dot = v.indexOf('.');
  const whole = (dot === -1 ? v : v.slice(0, dot)).slice(0, 7) || (dot === -1 ? '' : '0');
  if (dot === -1) return whole;
  return `${whole}.${v.slice(dot + 1).replace(/\./g, '').slice(0, 2)}`;
}

/** Paise -> "12.5" style string for putting back into an input box. */
export function toRupeeString(paise) {
  const r = Math.trunc(paise / 100), p = paise % 100;
  return p ? `${r}.${String(p).padStart(2, '0')}` : String(r);
}

const fmtWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmtExact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

/** 1234550 -> "₹12,345.50", 1234500 -> "₹12,345" */
export function formatINR(paise) {
  return paise % 100 ? fmtExact.format(paise / 100) : fmtWhole.format(paise / 100);
}

/** Compact for calendar cells: 420000 -> "₹4.2k", 45000 -> "₹450", 12000000 -> "₹1.2L" */
export function formatShort(paise) {
  const r = paise / 100;
  if (r >= 100000) return '₹' + trim1(r / 100000) + 'L';
  if (r >= 1000) return '₹' + trim1(r / 1000) + 'k';
  return '₹' + Math.round(r);
}
const trim1 = n => (Math.round(n * 10) / 10).toString();

/** Equal split into `people` parts that always add up to the total; leftover paise go to the first parts (you). */
export function splitEvenly(paidPaise, people) {
  if (!Number.isInteger(people) || people < 1) return [paidPaise];
  const base = Math.floor(paidPaise / people), extra = paidPaise - base * people;
  return Array.from({ length: people }, (_, i) => base + (i < extra ? 1 : 0));
}
