import { api } from './api.js';
import { suggestIcon } from './icon-list.js';
import { createIconPicker } from './icon-picker.js';
import { cleanAmountInput, formatINR, splitEvenly, toPaise, toRupeeString } from './money.js';
import { $, $$, catIcon, confirmDialog, esc, icon, personIcon, toast, todayISO } from './ui.js';

const SHOWN_CHIPS = 8;
const SHOWN_PEOPLE = 6;

let ctx = null;          // { getCategories, getPeople, onChanged }
let editing = null;      // expense being edited, or null
let selected = null;     // { name, icon, color, isNew }
let showAllChips = false, iconTouched = false;
let picker = null;

// Split state. Whoever was typed into last is fixed; the other side takes the remainder:
//  - equalMode: everyone (me included) gets an equal part, redone when the amount or people change
//  - myTouched: I typed my share, so with one other person they get the rest
let participants = [];   // [{ name, amount }]  amount = text in the box
let equalMode = true, myTouched = false, showAllPeople = false;

const keyOf = name => name.trim().replace(/\s+/g, ' ').toLowerCase();

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
  // Capture phase, so the cleaning runs before the handlers below read the value.
  f.addEventListener('input', e => {
    const input = e.target;
    if (!input.matches('[name="paid"], [name="my_share"], [data-share]')) return;
    const cleaned = cleanAmountInput(input.value);
    if (cleaned !== input.value) {
      const pos = Math.max(0, (input.selectionStart ?? cleaned.length) - (input.value.length - cleaned.length));
      input.value = cleaned;
      input.setSelectionRange?.(pos, pos);
    }
  }, true);
  f.elements.paid.addEventListener('input', recalc);
  f.elements.split.addEventListener('change', () => { if (f.elements.split.checked) renderSplit(); recalc(); });
  f.elements.my_share.addEventListener('input', () => {
    myTouched = true; equalMode = false;
    const paid = toPaise(f.elements.paid.value), mine = toPaise(f.elements.my_share.value);
    if (participants.length === 1 && paid != null && mine != null && mine <= paid) {
      participants[0].amount = toRupeeString(paid - mine);
      $('[data-share]', f).value = participants[0].amount;
    }
    recalc();
  });
  $('#share-rows').addEventListener('input', e => {
    const i = e.target.dataset.share;
    if (i == null) return;
    participants[i].amount = e.target.value;
    equalMode = false; myTouched = false; // my share takes up the rest again
    recalc();
  });
  $('#new-person-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addPerson(e.target.value); }
  });
  f.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { dlg().close(); return; }
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.personId) {
      addPerson(ctx.getPeople().find(p => p.id === t.dataset.personId)?.name ?? '');
    } else if (t.dataset.morePeople) {
      showAllPeople = !showAllPeople; renderSplit();
    } else if (t.dataset.newPerson != null) {
      $('#new-person').hidden = false; $('#new-person-name').focus();
    } else if (t.dataset.addPerson != null) {
      addPerson($('#new-person-name').value);
    } else if (t.dataset.removeShare != null) {
      participants.splice(Number(t.dataset.removeShare), 1);
      if (!participants.length) { equalMode = true; myTouched = false; }
      renderSplit(); recalc();
    } else if (t.dataset.splitEqual != null) {
      equalMode = true; myTouched = false; recalc();
    }
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
  showAllChips = false; iconTouched = false; showAllPeople = false;
  participants = []; equalMode = true; myTouched = false;
  $('#new-person').hidden = true;
  $('#new-person-name').value = '';

  $('#expense-title').textContent = expense ? 'Edit expense' : 'Add expense';
  $('#expense-delete').hidden = !expense;

  if (expense) {
    f.elements.paid.value = toRupeeString(expense.paid);
    f.elements.spent_on.value = expense.spent_on;
    f.elements.note.value = expense.note ?? '';
    selected = { id: expense.category_id, name: expense.category, icon: expense.icon, color: expense.color, isNew: false };
    if (expense.my_share !== expense.paid || expense.shares.length) {
      f.elements.split.checked = true;
      participants = expense.shares.map(s => ({ name: s.person, amount: toRupeeString(s.amount) }));
      equalMode = false;
      myTouched = !participants.length; // older split without people: keep the share as saved
      f.elements.my_share.value = toRupeeString(expense.my_share);
    }
  } else {
    f.elements.spent_on.value = date ?? todayISO();
    const first = ctx.getCategories()[0];
    selected = first ? { ...first, isNew: false } : null;
  }

  renderChips();
  renderSplit();
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

/** Adds someone to the split by name (an existing person's spelling wins). */
function addPerson(raw) {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return;
  if (name.length > 40) return showError('Name is too long (max 40)');
  const known = ctx.getPeople().find(p => keyOf(p.name) === keyOf(name));
  const finalName = known?.name ?? name;
  $('#expense-error').hidden = true;
  if (!participants.some(p => keyOf(p.name) === keyOf(finalName))) {
    const paid = toPaise(form().elements.paid.value), mine = toPaise(form().elements.my_share.value);
    // I already typed my share: a lone other person gets the rest
    const rest = myTouched && !participants.length && paid != null && mine != null && mine < paid ? toRupeeString(paid - mine) : '';
    participants.push({ name: finalName, amount: rest });
    if (!myTouched) equalMode = equalMode || participants.length === 1;
  }
  $('#new-person-name').value = '';
  $('#new-person').hidden = true;
  renderSplit();
  recalc();
  $$('[data-share]', form()).at(-1)?.focus();
}

/** People chips (everyone not already in the split) and one row per person in it. */
function renderSplit() {
  const inSplit = new Set(participants.map(p => keyOf(p.name)));
  const people = ctx.getPeople().filter(p => !inSplit.has(keyOf(p.name)));
  const list = showAllPeople ? people : people.slice(0, SHOWN_PEOPLE);
  $('#person-pick').innerHTML =
    list.map(p => `<button type="button" class="outline small" data-person-id="${p.id}">${icon('plus')}${esc(p.name)}</button>`).join('')
    + (people.length > SHOWN_PEOPLE ? `<button type="button" class="ghost small" data-more-people="1">${showAllPeople ? 'Fewer' : `All ${people.length}`}</button>` : '')
    + `<button type="button" class="ghost small" data-new-person>${icon('user-plus')}New</button>`;

  $('#share-rows').innerHTML = participants.map((p, i) => `
    <div class="share-row">
      ${personIcon(p.name, 'sm')}
      <span class="name">${esc(p.name)}</span>
      <span class="share-in">₹<input data-share="${i}" inputmode="decimal" autocomplete="off" value="${esc(p.amount)}" aria-label="${esc(p.name)}'s share"></span>
      <button type="button" class="ghost small" data-remove-share="${i}" aria-label="Remove ${esc(p.name)}">${icon('x')}</button>
    </div>`).join('');
  $('[data-split-equal]', form()).disabled = !participants.length;
}

function recalc() {
  const f = form();
  const paid = toPaise(f.elements.paid.value);
  f.elements.paid.setAttribute('aria-invalid', f.elements.paid.value !== '' && paid == null);
  const split = f.elements.split.checked;
  $('.split-body', f).hidden = !split;
  if (!split) return;

  if (equalMode && paid != null && participants.length) {
    const [mine, ...theirs] = splitEvenly(paid, participants.length + 1);
    participants.forEach((p, i) => { p.amount = toRupeeString(theirs[i]); });
    $$('[data-share]', f).forEach((input, i) => { input.value = participants[i].amount; });
    f.elements.my_share.value = toRupeeString(mine);
  }

  const amounts = participants.map(p => toPaise(p.amount));
  const others = amounts.every(a => a != null) ? amounts.reduce((s, a) => s + a, 0) : null;
  if (participants.length && !myTouched && !equalMode && paid != null && others != null) {
    f.elements.my_share.value = paid - others >= 0 ? toRupeeString(paid - others) : '';
  }
  if (!participants.length && !myTouched && paid != null) f.elements.my_share.value = toRupeeString(paid);

  const mine = toPaise(f.elements.my_share.value);
  const label = $('#others-label'), out = $('#others-amt');
  let left = null;
  if (participants.length) {
    left = paid != null && mine != null && others != null ? paid - mine - others : null;
    const off = left != null && left !== 0;
    label.textContent = off ? (left > 0 ? 'LEFT TO ASSIGN' : 'OVER BY') : 'FOR OTHERS';
    out.textContent = left == null ? '—' : formatINR(off ? Math.abs(left) : others);
    out.classList.toggle('up', off);
  } else {
    const rest = paid != null && mine != null ? paid - mine : null;
    label.textContent = 'FOR OTHERS';
    out.textContent = rest == null ? '—' : rest < 0 ? 'More than paid' : formatINR(rest);
    out.classList.toggle('up', rest != null && rest < 0);
  }
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
  const split = f.elements.split.checked;
  const share = split ? toPaise(f.elements.my_share.value) : paid;
  const shares = split ? participants : [];

  if (paid == null || paid <= 0) return showError('Enter the amount you paid, e.g. 1000 or 249.50');
  if (share == null) return showError('Enter your share, e.g. 200');
  if (share > paid) return showError('Your share cannot be more than the amount paid');
  for (const p of shares) {
    const a = toPaise(p.amount);
    if (a == null || a <= 0) return showError(`Enter ${p.name}'s share, or remove them`);
  }
  if (shares.length) {
    const left = paid - share - shares.reduce((s, p) => s + toPaise(p.amount), 0);
    if (left > 0) return showError(`${formatINR(left)} is not assigned to anyone yet`);
    if (left < 0) return showError(`The shares add up to ${formatINR(-left)} more than the amount paid`);
  }
  if (!selected || !selected.name?.trim()) return showError('Pick a category or create a new one');
  const date = f.elements.spent_on.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '2000-01-01' || date > '2100-12-31') return showError('Pick a valid date');

  const body = {
    paid: toRupeeString(paid),
    my_share: toRupeeString(share),
    category: selected.name.trim(),
    note: f.elements.note.value.trim() || null,
    spent_on: f.elements.spent_on.value,
    shares: shares.map(p => ({ person: p.name, amount: p.amount })),
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
    const saved = editing ? await api.updateExpense(editing.id, body) : await api.createExpense(body);
    dlg().close();
    toast(editing ? 'Expense updated' : `Saved ${formatINR(share)} to ${body.category}`);
    ctx.onChanged(body.spent_on, saved?.id);
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
