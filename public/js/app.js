// App controller: one state object, one render() per view, re-render after every change.
import { api, setSessionExpiredHandler } from './api.js';
import { positionAvgLines, renderAnalytics, renderDrill } from './analytics.js';
import { deleteCategory, initCategories, openCategoryDialog, renderCategories } from './categories.js';
import { deleteExpense, initExpenseDialog, openExpenseDialog } from './expense-dialog.js';
import { expenseRow, renderHome } from './home.js';
import { $, $$, addMonths, confirmDialog, enableBackToClose, isoDate, monthLabel, monthOf, toast, todayISO } from './ui.js';
import { formatINR } from './money.js';

const VIEWS = ['home', 'analytics', 'categories'];

const state = {
  view: 'home',
  month: monthOf(todayISO()),     // month shown on Home (and Analytics in month mode)
  selectedDate: todayISO(),
  period: { type: 'month', key: monthOf(todayISO()) }, // Analytics period
  expenses: [],
  categories: [],
  homeSummary: null,
  analyticsSummary: null,
};

// ---------- data ----------
async function loadCategories() {
  state.categories = (await api.categories()).categories;
}
async function loadMonth() {
  const month = state.month;
  const [list, summary] = await Promise.all([api.expenses(month), api.summary({ type: 'month', key: month })]);
  if (state.month !== month) return; // user moved on while this was loading
  state.expenses = list.expenses;
  state.homeSummary = summary;
}
async function loadAnalytics() {
  const p = state.period;
  const s = p.type === 'month' && p.key === state.month && state.homeSummary ? state.homeSummary : await api.summary(p);
  // Ignore a late response if the user switched period while it was loading.
  if (state.period === p) state.analyticsSummary = s;
}

async function refresh({ categories = true } = {}) {
  try {
    await Promise.all([categories && loadCategories(), loadMonth()]);
    if (state.view === 'analytics') await loadAnalytics(); else state.analyticsSummary = null;
    render();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

// ---------- render ----------
function render() {
  for (const v of VIEWS) $(`#v-${v}`).hidden = v !== state.view;
  $$('[data-view]').forEach(a => a.toggleAttribute('aria-current', a.dataset.view === state.view));
  $$('[data-month-label]').forEach(el => { el.textContent = monthLabel(state.month); });

  if (state.view === 'home') renderHome(state);
  if (state.view === 'analytics') {
    const p = state.period;
    $('#period-label').textContent = p.type === 'month' ? monthLabel(p.key) : p.key;
    $$('#period-toggle button').forEach(b => {
      const on = b.dataset.period === p.type;
      b.classList.toggle('outline', !on);
      b.setAttribute('aria-pressed', on);
    });
    renderAnalytics($('#analytics'), state.analyticsSummary);
  }
  if (state.view === 'categories') renderCategories();
}

// ---------- navigation ----------
async function showView(view) {
  state.view = VIEWS.includes(view) ? view : 'home';
  if (state.view === 'analytics' && !state.analyticsSummary) {
    render();
    try { await loadAnalytics(); } catch (err) { toast(err.message, 'danger'); }
  }
  render();
}

async function goMonth(key) {
  state.month = key;
  if (state.period.type === 'month') state.period = { type: 'month', key };
  const today = todayISO();
  state.selectedDate = monthOf(today) === key ? today : isoDate(key, 1);
  state.analyticsSummary = null;
  await refresh({ categories: false });
}

async function goPeriod(period) {
  state.period = period;
  if (period.type === 'month' && period.key !== state.month) { goMonth(period.key); return; }
  state.analyticsSummary = null;
  render();
  try { await loadAnalytics(); } catch (err) { toast(err.message, 'danger'); }
  render();
}

// After any add/edit/delete: reload, and jump to the expense's month/day if it's elsewhere.
async function onExpensesChanged(date) {
  if (date && monthOf(date) !== state.month) {
    state.month = monthOf(date);
    if (state.period.type === 'month') state.period = { type: 'month', key: state.month };
  }
  if (date) state.selectedDate = date;
  state.analyticsSummary = null;
  await refresh();
}

// ---------- events (one delegated listener) ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action], [data-period]');
  if (!el) return;
  if (el.dataset.period) {
    const type = el.dataset.period;
    if (type !== state.period.type) goPeriod({ type, key: type === 'month' ? state.month : state.month.slice(0, 4) });
    return;
  }
  const id = Number(el.dataset.id);
  switch (el.dataset.action) {
    case 'add': openExpenseDialog({ date: el.dataset.date ?? (monthOf(state.selectedDate) === state.month ? state.selectedDate : todayISO()) }); break;
    case 'pick-day': state.selectedDate = el.dataset.date; renderHome(state); break;
    case 'month-prev': goMonth(addMonths(state.month, -1)); break;
    case 'month-next': goMonth(addMonths(state.month, 1)); break;
    case 'month-today': goMonth(monthOf(todayISO())); break;
    case 'period-prev':
    case 'period-next': {
      const step = el.dataset.action === 'period-next' ? 1 : -1, p = state.period;
      goPeriod(p.type === 'month' ? { type: 'month', key: addMonths(p.key, step) } : { type: 'year', key: String(+p.key + step) });
      break;
    }
    case 'edit-expense': {
      const exp = state.expenses.find(x => x.id === id);
      el.closest('[popover]')?.hidePopover?.();
      if (exp) openExpenseDialog({ expense: exp });
      break;
    }
    case 'delete-expense': {
      const exp = state.expenses.find(x => x.id === id);
      el.closest('[popover]')?.hidePopover?.();
      if (exp && await confirmDialog('Delete expense?', `${formatINR(exp.my_share)} · ${exp.note || exp.category}. This can't be undone.`)) deleteExpense(exp);
      break;
    }
    case 'drill': openDrill(id); break;
    case 'new-category': openCategoryDialog(); break;
    case 'edit-category': openCategoryDialog(state.categories.find(c => c.id === id)); break;
    case 'delete-category': deleteCategory(state.categories.find(c => c.id === id)); break;
    case 'reload': location.reload(); break;
    case 'logout':
      if (await confirmDialog('Log out?', 'You will need to sign in again on this device.', 'Log out')) {
        location.href = '/cdn-cgi/access/logout'; // ends the Cloudflare Access session
      }
      break;
  }
});

async function openDrill(categoryId) {
  const p = state.period;
  try {
    const d = await api.categorySummary(categoryId, p);
    const view = renderDrill(d, p.type === 'month' ? monthLabel(p.key) : p.key, expenseRow);
    $('#drill-title').innerHTML = view.title;
    $('#drill-sub').innerHTML = view.sub;
    $('#drill-body').innerHTML = view.body;
    $('#drill-dlg').showModal();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

addEventListener('hashchange', () => showView(location.hash.slice(1)));
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.view === 'home') renderHome(state); else positionAvgLines($('#analytics')); }, 150);
});

// ---------- boot ----------
enableBackToClose();
setSessionExpiredHandler(() => { $('#session-banner').hidden = false; });
initExpenseDialog({ getCategories: () => state.categories, onChanged: onExpensesChanged });
initCategories({ getCategories: () => state.categories, onChanged: () => { state.analyticsSummary = null; refresh(); } });

state.view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
await refresh();
if (state.view === 'analytics') await showView('analytics');
api.me().then(me => $$('[data-me-email]').forEach(el => { el.textContent = me.email; })).catch(() => {});

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
