import { api } from './api.js';
import { suggestIcon } from './icon-list.js';
import { createIconPicker } from './icon-picker.js';
import { cleanAmountInput, formatINR, splitShare, toPaise, toRupeeString } from './money.js';
import { $, catIcon, confirmDialog, esc, icon, toast, todayISO } from './ui.js';

const SHOWN_CHIPS = 8;

let ctx = null;          // { getCategories, onChanged }
let editing = null;      // expense being edited, or null
let selected = null;     // { name, icon, color, isNew }
let people = 2, customShare = false, showAllChips = false, iconTouched = false;
let picker = null;

const dlg = () => $('#expense-dlg');
const form = () => $('#expense-form');
const field = name => form().elements[name];

export function initExpenseDialog(options) {
  ctx = options;
  const f = form();

  picker = createIconPicker($('#new-cat-picker'), {
    onChange: v => { iconTouched = true; selected = { ...selected, ...v }; renderNewPreview(); },
  });

  // Amount fields accept only digits and one decimal point (max 2 decimals), even from a laptop keyboard or paste.
  for (const input of [f.elements.paid, f.elements.my_share]) {
    input.addEventListener('input', () => {
      const cleaned = cleanAmountInput(input.value);
      if (cleaned !== input.value) {
        const pos = Math.max(0, (input.selectionStart ?? cleaned.length) - (input.value.length - cleaned.length));
        input.value = cleaned;
        input.setSelectionRange?.(pos, pos);
      }
    });
  }
  f.elements.paid.addEventListener('input', recalc);
  f.elements.split.addEventListener('change', () => { customShare = false; recalc(); });
  f.elements.my_share.addEventListener('input', () => { customShare = true; recalc(); });
  f.addEventListener('click', e => {
    const p = e.target.closest('[data-people]');
    if (p) { people = Math.min(50, Math.max(2, people + Number(p.dataset.people))); customShare = false; recalc(); }
    if (e.target.closest('[data-close]')) dlg().close();
  });

  $('#cat-pick').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.more) { showAllChips = !showAllChips; renderChips(); return; }
    if (b.dataset.new) { startNewCategory(); return; }
    const cat = ctx.getCategories().find(c => String(c.id) === b.dataset.id);
    selected = { ...cat, isNew: false };
    $('#new-cat').hidden = true;
    renderChips();
  });

  $('#new-cat-name').addEventListener('input', e => {
    const name = e.target.value;
    selected = { ...selected, name, isNew: true };
    if (!iconTouched) { selected.icon = suggestIcon(name); picker.set(selected.icon, selected.color); }
    renderNewPreview();
  });

  f.addEventListener('submit', onSubmit);
  $('#expense-delete').addEventListener('click', onDelete);
}

/** open({ expense }) to edit, or open({ date }) to add. */
export function openExpenseDialog({ expense = null, date = null } = {}) {
  editing = expense;
  const f = form();
  f.reset();
  $('#expense-error').hidden = true;
  $('#new-cat').hidden = true;
  $('#new-cat-name').value = '';
  showAllChips = false; iconTouched = false; customShare = false; people = 2;

  $('#expense-title').textContent = expense ? 'Edit expense' : 'Add expense';
  $('#expense-delete').hidden = !expense;

  if (expense) {
    f.elements.paid.value = toRupeeString(expense.paid);
    f.elements.spent_on.value = expense.spent_on;
    f.elements.note.value = expense.note ?? '';
    selected = { id: expense.category_id, name: expense.category, icon: expense.icon, color: expense.color, isNew: false };
    if (expense.my_share !== expense.paid) {
      f.elements.split.checked = true;
      const guess = expense.my_share > 0 ? Math.round(expense.paid / expense.my_share) : 0;
      if (guess >= 2 && guess <= 50 && splitShare(expense.paid, guess) === expense.my_share) people = guess;
      else customShare = true;
      f.elements.my_share.value = toRupeeString(expense.my_share);
    }
  } else {
    f.elements.spent_on.value = date ?? todayISO();
    const first = ctx.getCategories()[0];
    selected = first ? { ...first, isNew: false } : null;
  }

  renderChips();
  recalc();
  dlg().showModal();
  if (!expense) f.elements.paid.focus();
}

function startNewCategory() {
  selected = { name: '', icon: 'tag', color: 'teal', isNew: true };
  picker.set('tag', 'teal');
  $('#new-cat').hidden = false;
  renderChips();
  renderNewPreview();
  $('#new-cat-name').focus();
}

function renderNewPreview() {
  $('#new-cat-preview').outerHTML = catIcon({ icon: selected.icon, color: selected.color }).replace('class="cat-ico ', 'id="new-cat-preview" class="cat-ico ');
}

function renderChips() {
  const cats = ctx.getCategories();
  const list = showAllChips ? cats : cats.slice(0, SHOWN_CHIPS);
  // keep the selected category visible even when it isn't in the top chips
  if (selected && !selected.isNew && !list.some(c => c.id === selected.id)) {
    const hit = cats.find(c => c.id === selected.id);
    if (hit) list.push(hit);
  }
  $('#cat-pick').innerHTML =
    list.map(c => `<button type="button" class="outline small" data-id="${c.id}" style="--c:var(--cat-${esc(c.color)})"
        aria-pressed="${!!selected && !selected.isNew && selected.id === c.id}">${icon(c.icon)}${esc(c.name)}</button>`).join('')
    + (cats.length > SHOWN_CHIPS ? `<button type="button" class="ghost small" data-more="1">${showAllChips ? 'Fewer' : `All ${cats.length}`}</button>` : '')
    + `<button type="button" class="ghost small" data-new="1" aria-pressed="${!!selected?.isNew}">${icon('plus')}New</button>`;
}

function recalc() {
  const f = form();
  const paid = toPaise(f.elements.paid.value);
  f.elements.paid.setAttribute('aria-invalid', f.elements.paid.value !== '' && paid == null);
  const split = f.elements.split.checked;
  $('.split-body', f).hidden = !split;
  $('#people').textContent = people;

  if (split && !customShare && paid != null) f.elements.my_share.value = toRupeeString(splitShare(paid, people));
  const share = split ? toPaise(f.elements.my_share.value) : paid;
  const others = paid != null && share != null ? paid - share : null;
  $('#others-amt').textContent = others == null ? '—' : others < 0 ? 'More than paid' : formatINR(others);
  $('#others-amt').classList.toggle('up', others != null && others < 0);
}

function showError(msg) {
  const el = $('#expense-error');
  el.textContent = msg;
  el.hidden = false;
}

async function onSubmit(e) {
  e.preventDefault();
  const f = form();
  const paid = toPaise(f.elements.paid.value);
  const share = f.elements.split.checked ? toPaise(f.elements.my_share.value) : paid;

  if (paid == null || paid <= 0) return showError('Enter the amount you paid, e.g. 1000 or 249.50');
  if (share == null) return showError('Enter your share, e.g. 200');
  if (share > paid) return showError('Your share cannot be more than the amount paid');
  if (!selected || !selected.name?.trim()) return showError('Pick a category or create a new one');
  const date = f.elements.spent_on.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '2000-01-01' || date > '2100-12-31') return showError('Pick a valid date');

  const body = {
    paid: toRupeeString(paid),
    my_share: toRupeeString(share),
    category: selected.name.trim(),
    note: f.elements.note.value.trim() || null,
    spent_on: f.elements.spent_on.value,
  };
  if (selected.isNew) {
    const existing = ctx.getCategories().find(c => c.name.toLowerCase() === body.category.replace(/\s+/g, ' ').toLowerCase());
    if (existing) {
      // Don't silently drop the chosen icon: switch to the existing category and let the user confirm.
      selected = { ...existing, isNew: false };
      $('#new-cat').hidden = true;
      renderChips();
      return showError(`“${existing.name}” already exists, so it's selected now. Press Save again to use it.`);
    }
    body.category_icon = selected.icon; body.category_color = selected.color;
  }

  const btn = $('#expense-save');
  btn.disabled = true;
  try {
    if (editing) await api.updateExpense(editing.id, body);
    else await api.createExpense(body);
    dlg().close();
    toast(editing ? 'Expense updated' : `Saved ${formatINR(share)} to ${body.category}`);
    ctx.onChanged(body.spent_on);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function onDelete() {
  if (!editing) return;
  const target = editing;
  dlg().close();
  if (!(await confirmDialog('Delete expense?', `${formatINR(target.my_share)} · ${target.note || target.category}. This can't be undone.`))) {
    dlg().showModal();
    return;
  }
  await deleteExpense(target);
}

export async function deleteExpense(expense) {
  try {
    await api.deleteExpense(expense.id);
    toast('Expense deleted');
    ctx.onChanged(expense.spent_on);
  } catch (err) {
    toast(err.message, 'danger');
  }
}
