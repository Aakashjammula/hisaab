// Small DOM + date helpers. Every user-provided string goes through esc() before innerHTML.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** <svg> from the sprite. Names come from our own fixed lists only. */
export const icon = (name, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="/icons.svg#${esc(name)}"/></svg>`;

/** Coloured category icon tile. */
export const catIcon = (cat, size = '') =>
  `<span class="cat-ico ${size}" style="--c:var(--cat-${esc(cat.color)})">${icon(cat.icon)}</span>`;

export function toast(message, variant = 'success') {
  if (window.ot?.toast) window.ot.toast(message, '', { variant });
}

/** Promise<boolean> confirmation using the shared confirm dialog. */
export function confirmDialog(title, text, okLabel = 'Delete') {
  const dlg = $('#confirm-dlg');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// ---- dates (local time; the owner is in one time zone) ----
const pad = n => String(n).padStart(2, '0');
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const monthOf = iso => iso.slice(0, 7);
export const daysInMonth = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); };
export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
/** 0 = Monday … 6 = Sunday */
export const weekdayMon0 = iso => { const [y, m, d] = iso.split('-').map(Number); return (new Date(y, m - 1, d).getDay() + 6) % 7; };
export const monthLabel = key => new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
export const shortMonth = key => new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
export const dayLabel = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }); };
export const shortDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };
export const isoDate = (key, day) => `${key}-${pad(day)}`;
