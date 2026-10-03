import { api } from './api.js';
import { $, confirmDialog, esc, icon, personIcon, toast } from './ui.js';

let ctx = null, editing = null;

export function initPeople(options) {
  ctx = options; // { getPeople, onChanged }
  const form = $('#person-form');
  form.addEventListener('click', e => { if (e.target.closest('[data-close]')) $('#person-dlg').close(); });
  form.addEventListener('submit', onSubmit);
}

export function renderPeople() {
  const people = [...ctx.getPeople()].sort((a, b) => a.name.localeCompare(b.name));
  $('#person-list').innerHTML = people.length ? people.map(p => `
    <div class="cat-item">
      ${personIcon(p.name)}<b>${esc(p.name)}</b>
      <small class="muted">${p.count} bill${p.count === 1 ? '' : 's'}</small>
      <button class="ghost small" data-action="edit-person" data-id="${p.id}" title="Rename" aria-label="Rename ${esc(p.name)}">${icon('pencil')}</button>
      <button class="ghost small danger-text" data-action="delete-person" data-id="${p.id}" title="Delete" aria-label="Delete ${esc(p.name)}">${icon('trash-2')}</button>
    </div>`).join('')
    : `<div class="empty">${icon('users')}No people yet
         <button class="outline small" data-action="new-person">${icon('user-plus')} Add someone</button></div>`;
}

export function openPersonDialog(person = null) {
  editing = person;
  const form = $('#person-form');
  form.reset();
  $('#person-error').hidden = true;
  $('#person-title').textContent = person ? 'Rename person' : 'New person';
  form.elements.name.value = person?.name ?? '';
  $('#person-dlg').showModal();
  form.elements.name.focus();
}

async function onSubmit(e) {
  e.preventDefault();
  const name = $('#person-form').elements.name.value.trim();
  const err = $('#person-error');
  if (!name) { err.textContent = 'Enter a name'; err.hidden = false; return; }
  try {
    if (editing) await api.updatePerson(editing.id, { name });
    else await api.createPerson({ name });
    $('#person-dlg').close();
    toast(editing ? 'Renamed' : `Added ${name}`);
    ctx.onChanged();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  }
}

export async function deletePerson(person) {
  const msg = person.count
    ? `Their part of ${person.count} bill${person.count === 1 ? '' : 's'} stays in your totals as “not assigned”.`
    : 'They are not in any bills.';
  if (!(await confirmDialog(`Delete ${person.name}?`, msg))) return;
  try {
    await api.deletePerson(person.id);
    toast(`Deleted ${person.name}`);
    ctx.onChanged();
  } catch (ex) {
    toast(ex.message, 'danger');
  }
}
