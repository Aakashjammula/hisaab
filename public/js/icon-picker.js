import { COLORS, searchIcons } from './icon-list.js';
import { $, esc, icon } from './ui.js';

/**
 * Icon + colour picker used by "New category" (in the expense dialog) and the category editor.
 * Returns { value: () => ({icon, color}), set(icon, color) }.
 */
export function createIconPicker(container, { icon: initialIcon = 'tag', color: initialColor = 'slate', onChange = () => {} } = {}) {
  let cur = { icon: initialIcon, color: initialColor };
  let query = '';

  container.innerHTML = `
    <div class="picker">
      <div class="swatches" role="group" aria-label="Colour">
        ${COLORS.map(([name]) => `<button type="button" data-color="${name}" style="--c:var(--cat-${name})" aria-label="${name}" title="${name}"></button>`).join('')}
      </div>
      <input type="search" placeholder="Search icons (e.g. pet, fuel, rent)" aria-label="Search icons" autocomplete="off">
      <div class="icon-groups"></div>
    </div>`;
  const groupsEl = $('.icon-groups', container);
  const search = $('input[type=search]', container);

  function renderIcons() {
    const byGroup = new Map();
    for (const i of searchIcons(query)) {
      if (!byGroup.has(i.group)) byGroup.set(i.group, []);
      byGroup.get(i.group).push(i);
    }
    groupsEl.innerHTML = byGroup.size
      ? [...byGroup].map(([group, items]) => `
          <div><h6>${esc(group)}</h6><div class="icon-grid">
            ${items.map(i => `<button type="button" data-icon="${i.name}" title="${i.name}" aria-label="${i.name}" aria-pressed="${i.name === cur.icon}" style="--c:var(--cat-${cur.color})">${icon(i.name)}</button>`).join('')}
          </div></div>`).join('')
      : `<p class="muted">No icons match “${esc(query)}”.</p>`;
  }
  function renderSwatches() {
    container.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', b.dataset.color === cur.color));
  }

  container.addEventListener('click', e => {
    const c = e.target.closest('[data-color]'), i = e.target.closest('[data-icon]');
    if (c) { cur.color = c.dataset.color; renderSwatches(); renderIcons(); onChange(cur); }
    if (i) { cur.icon = i.dataset.icon; renderIcons(); onChange(cur); }
  });
  search.addEventListener('input', () => { query = search.value; renderIcons(); });

  renderSwatches(); renderIcons();
  return {
    value: () => ({ ...cur }),
    set(iconName, color) { cur = { icon: iconName ?? cur.icon, color: color ?? cur.color }; renderSwatches(); renderIcons(); },
  };
}
