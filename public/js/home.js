import { formatINR, formatShort } from './money.js';
import { $, catIcon, daysInMonth, dayLabel, esc, icon, isoDate, todayISO, weekdayMon0 } from './ui.js';

/** Summary cards shared by Home and Analytics. */
export function kpiCards(s) {
  const elapsed = s.period.elapsed;
  const vs = s.prev.has_data && s.prev.same_point > 0 && elapsed > 0
    ? Math.round((s.my_spend - s.prev.same_point) / s.prev.same_point * 100) : null;
  const prevName = s.period.type === 'month'
    ? new Date(+s.period.prev.slice(0, 4), +s.period.prev.slice(5) - 1, 1).toLocaleDateString('en-IN', { month: 'short' })
    : s.period.prev;
  const samePoint = elapsed > 0 && elapsed < s.period.units;
  return `
    <article class="card kpi hero"><small>${icon('wallet')} My spend${samePoint ? ', so far' : ''}</small><b>${formatINR(s.my_spend)}</b></article>
    <article class="card kpi"><small>${icon(vs != null && vs < 0 ? 'trending-down' : 'trending-up')} vs ${esc(prevName)}${samePoint ? ', same day' : ''}</small>
      <b class="${vs == null ? 'muted' : vs > 0 ? 'up' : 'down'}">${vs == null ? '—' : `${vs > 0 ? '+' : ''}${vs}%`}</b></article>
    <article class="card kpi"><small>${icon('users')} Paid for others</small><b>${formatINR(s.paid_for_others)}</b></article>
    <article class="card kpi"><small>${icon('calendar-range')} Daily average</small><b>${elapsed > 0 ? formatINR(Math.round(s.my_spend / elapsed / 100) * 100) : '—'}</b></article>`;
}

/** Expense row with an Edit/Delete menu. */
export function expenseRow(e, { menu = true, index = 0, flash = false } = {}) {
  const tag = e.my_share === 0 ? '<span class="badge outline">For others</span>'
    : e.my_share !== e.paid ? '<span class="badge outline">Split</span>' : '';
  return `
    <div class="exp${flash ? ' flash' : ''}" style="--i:${index}">
      ${catIcon(e)}
      <div class="mid"><b>${esc(e.note || e.category)}</b><small>${e.note ? esc(e.category) : ''} ${tag}</small></div>
      <div class="amt"><b>${formatINR(e.my_share)}</b>${e.paid !== e.my_share ? `<small>paid ${formatINR(e.paid)}</small>` : ''}</div>
      ${menu ? `<ot-dropdown>
        <button popovertarget="m-${e.id}" class="ghost small" aria-label="Actions">${icon('ellipsis-vertical')}</button>
        <menu popover id="m-${e.id}">
          <button role="menuitem" class="ghost" data-action="edit-expense" data-id="${e.id}">${icon('pencil')} Edit</button>
          <button role="menuitem" class="ghost danger-text" data-action="delete-expense" data-id="${e.id}">${icon('trash-2')} Delete</button>
        </menu>
      </ot-dropdown>` : ''}
    </div>`;
}

export function renderHome(state) {
  const { month, expenses, homeSummary: summary, selectedDate } = state;
  const today = todayISO();
  const days = daysInMonth(month);

  const totals = {};
  for (const e of expenses) totals[e.spent_on] = (totals[e.spent_on] ?? 0) + e.my_share;
  const max = Math.max(1, ...Object.values(totals));

  if (summary) $('#home-kpis').innerHTML = kpiCards(summary);

  const narrow = innerWidth < 500;
  let cal = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${narrow ? d[0] : d}</div>`).join('');
  cal += '<span></span>'.repeat(weekdayMon0(isoDate(month, 1)));
  for (let d = 1; d <= days; d++) {
    const iso = isoDate(month, d), t = totals[iso] ?? 0, r = t / max;
    const cls = [r > .45 && 'hot', iso === today && 'today', iso > today && 'future'].filter(Boolean).join(' ');
    cal += `<button class="d ${cls}" data-action="pick-day" data-date="${iso}" aria-pressed="${iso === selectedDate}"
              style="--h:${t ? (.1 + .8 * r).toFixed(2) : .04}" aria-label="${dayLabel(iso)}, ${formatINR(t)}">
              <span class="n">${d}</span><span class="a">${t ? formatShort(t) : ''}</span></button>`;
  }
  $('#cal').innerHTML = cal;

  const list = expenses.filter(e => e.spent_on === selectedDate);
  $('#day-title').textContent = (selectedDate === today ? 'Today, ' : '') + dayLabel(selectedDate);
  $('#day-total').textContent = formatINR(totals[selectedDate] ?? 0);
  const dayList = $('#day-list');
  // Animate the list in only when it really changes (new day, or after a save), not on every redraw.
  const key = `${selectedDate}|${list.map(e => e.id).join(',')}`;
  dayList.classList.toggle('animate', dayList.dataset.key !== key);
  dayList.dataset.key = key;
  dayList.innerHTML = list.length
    ? list.map((e, i) => expenseRow(e, { index: i, flash: e.id === state.flashId })).join('')
    : `<div class="empty">${icon('calendar-x')}No expenses this day
         <button class="outline small" data-action="add" data-date="${selectedDate}">${icon('plus')} Add one</button></div>`;
}
