import { api } from './api.js';
import { suggestIcon } from './icon-list.js';
import { createIconPicker } from './icon-picker.js';
import { $, catIcon, confirmDialog, esc, icon, toast } from './ui.js';

let ctx = null, editing = null, picker = null, iconTouched = false;

export function initCategories(options) {
  ctx = options; // { getCategories, onChanged }
  picker = createIconPicker($('#category-picker'), {
    onChange: () => { iconTouched = true; renderPreview(); },
  });
  const form = $('#category-form');
  form.elements.name.addEventListener('input', () => {
    if (!editing && !iconTouched) picker.set(suggestIcon(form.elements.name.value));
    renderPreview();
  });
  form.addEventListener('click', e => { if (e.target.closest('[data-close]')) $('#category-dlg').close(); });
  form.addEventListener('submit', onSubmit);
}

export function renderCategories() {
  const cats = [...ctx.getCategories()].sort((a, b) => a.locked - b.locked || a.name.localeCompare(b.name));
  $('#cat-list').innerHTML = cats.map(c => `
    <div class="cat-item">
      ${catIcon(c)}<b>${esc(c.name)}</b>
      <button class="ghost small" data-action="edit-category" data-id="${c.id}" title="Edit name, icon, colour" aria-label="Edit ${esc(c.name)}">${icon('pencil')}</button>
      ${c.locked ? '' : `<button class="ghost small danger-text" data-action="delete-category" data-id="${c.id}" title="Delete" aria-label="Delete ${esc(c.name)}">${icon('trash-2')}</button>`}
    </div>`).join('');
}

export function openCategoryDialog(cat = null) {
  editing = cat;
  iconTouched = !!cat;
  const form = $('#category-form');
  form.reset();
  $('#category-error').hidden = true;
  $('#category-title').textContent = cat ? 'Edit category' : 'New category';
  form.elements.name.value = cat?.name ?? '';
  picker.set(cat?.icon ?? 'tag', cat?.color ?? 'teal');
  renderPreview();
  $('#category-dlg').showModal();
}

function renderPreview() {
  const v = picker.value();
  $('#category-preview').outerHTML = catIcon(v, 'large').replace('class="cat-ico ', 'id="category-preview" class="cat-ico ');
}

async function onSubmit(e) {
  e.preventDefault();
  const name = $('#category-form').elements.name.value.trim();
  const err = $('#category-error');
  if (!name) { err.textContent = 'Give the category a name'; err.hidden = false; return; }
  const body = { name, ...picker.value() };
  try {
    if (editing) await api.updateCategory(editing.id, body);
    else await api.createCategory(body);
    $('#category-dlg').close();
    toast(editing ? 'Category updated' : `Added ${name}`);
    ctx.onChanged();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  }
}

export async function deleteCategory(cat) {
  const msg = cat.count
    ? `${cat.count} expense${cat.count === 1 ? '' : 's'} will move to “Other”.`
    : 'No expenses use it.';
  if (!(await confirmDialog(`Delete ${cat.name}?`, msg))) return;
  try {
    await api.deleteCategory(cat.id);
    toast(`Deleted ${cat.name}`);
    ctx.onChanged();
  } catch (ex) {
    toast(ex.message, 'danger');
  }
}
