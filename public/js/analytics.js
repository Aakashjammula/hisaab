import { formatINR } from './money.js';
import { kpiCards } from './home.js';
import { $$, catIcon, daysInMonth, esc, icon, isoDate, personIcon, shortDate, shortMonth, weekdayMon0 } from './ui.js';

const MIN_EXPECTED = 10000; // ignore "vs usual" for categories that usually cost < ₹100 (too noisy)
const pct = (a, b) => Math.round((a - b) / b * 100);
const unitName = s => s.period.type === 'month' ? 'month' : 'year';

const MIN_DAYS_FOR_PACE = 7;   // before this, lumpy bills (rent, electricity) make pace comparisons meaningless

/** Fraction of the period that has passed is enough to compare "at the same point" fairly. */
const paceReady = s => s.period.type === 'year' ? s.period.elapsed >= 60 : s.period.elapsed >= MIN_DAYS_FOR_PACE;

/**
 * How a category compares with usual.
 *   { kind: 'pace',  value } → % above/below usual for this point in the period
 *   { kind: 'share', value } → early in the period: % of a usual full period
 */
function categoryDelta(c, s) {
  if (c.baseline_avg == null || c.baseline_avg < MIN_EXPECTED || s.period.elapsed === 0) return null;
  if (!paceReady(s)) return { kind: 'share', value: Math.round(c.amount / c.baseline_avg * 100) };
  const expected = c.baseline_avg * s.period.elapsed / s.period.units;
  return expected >= MIN_EXPECTED ? { kind: 'pace', value: pct(c.amount, expected) } : null;
}

function insights(s) {
  const out = [];
  const unit = s.period.type === 'month' ? 'month' : 'year';
  const deltas = s.by_category.map(c => [c, categoryDelta(c, s)]).filter(([, d]) => d?.kind === 'pace').map(([c, d]) => [c, d.value]);
  const over = deltas.filter(([, d]) => d >= 15).sort((a, b) => b[1] - a[1])[0];
  const under = deltas.filter(([, d]) => d <= -15).sort((a, b) => a[1] - b[1])[0];
  const when = s.period.elapsed < s.period.units ? `for this point in the ${unit}` : `${unit}`;
  if (over) out.push(['trending-up', 'var(--danger)', `<b>${esc(over[0].name)}</b> is ${over[1]}% above your usual ${when}.`]);
  if (under) out.push(['trending-down', 'var(--success)', `<b>${esc(under[0].name)}</b> is ${Math.abs(under[1])}% below usual. Nice.`]);

  const big = [...s.buckets].sort((a, b) => b.amount - a.amount)[0];
  if (big) out.push(['calendar', 'var(--primary)', s.period.type === 'month'
    ? `Biggest day: <b>${shortDate(big.k)}</b> (${formatINR(big.amount)}).`
    : `Biggest month: <b>${shortMonth(big.k)}</b> (${formatINR(big.amount)}).`]);

  if (out.length < 3 && s.by_category[0] && s.my_spend > 0) {
    const top = s.by_category[0];
    out.push(['chart-column', 'var(--primary)', `Most of your spending went to <b>${esc(top.name)}</b> (${Math.round(top.amount / s.my_spend * 100)}%).`]);
  }
  if (out.length < 3 && s.splits.count) {
    const top = s.by_person[0];
    out.push(['users', 'var(--primary)', top
      ? `You spent ${formatINR(s.paid_for_others)} on others across ${s.splits.count} split bill${s.splits.count > 1 ? 's' : ''}, most on <b>${esc(top.name)}</b> (${formatINR(top.amount)}).`
      : `You fronted ${formatINR(s.paid_for_others)} for others across ${s.splits.count} split bill${s.splits.count > 1 ? 's' : ''}.`]);
  }
  return out.slice(0, 3);
}

function categoriesCard(s) {
  const max = s.by_category[0]?.amount || 1;
  const rows = s.by_category.map(c => {
    const d = categoryDelta(c, s);
    return `
      <button class="catrow" data-action="drill" data-id="${c.id}" style="--c:var(--cat-${esc(c.color)})">
        ${catIcon(c)}
        <div class="bar">
          <div><span>${esc(c.name)}</span><span>${formatINR(c.amount)}</span></div>
          <progress value="${c.amount}" max="${max}"></progress>
          <div class="meta"><span>${c.count} expense${c.count === 1 ? '' : 's'} · ${s.my_spend ? Math.round(c.amount / s.my_spend * 100) : 0}%</span>
            ${d == null ? '' : d.kind === 'share'
              ? `<span class="delta muted">${d.value}% of usual ${unitName(s)}</span>`
              : Math.abs(d.value) < 3 ? '<span class="delta muted">≈ usual</span>'
              : `<span class="delta ${d.value > 0 ? 'up' : 'down'}">${d.value > 0 ? '▲' : '▼'} ${Math.abs(d.value)}%</span>`}</div>
        </div>
      </button>`;
  }).join('');
  return `
    <article class="card span-2 row-2">
      <header><h4>By category</h4><small>${s.period.type === 'month' ? 'vs 6-month avg' : 'vs last year'}</small></header>
      ${rows || '<p class="muted">No expenses yet.</p>'}
      ${rows ? '<p class="hint">Tap a category for details</p>' : ''}
    </article>`;
}

function topCard(s) {
  return `
    <article class="card">
      <header><h4>Biggest expenses</h4></header>
      ${s.top.length ? s.top.map((e, i) => `
        <div class="top-row"><span class="rank">${i + 1}</span>${catIcon(e, 'sm')}
          <div class="mid"><b>${esc(e.note || e.category)}</b><small>${shortDate(e.spent_on)} · ${esc(e.category)}</small></div>
          <b>${formatINR(e.my_share)}</b></div>`).join('') : '<p class="muted">Nothing yet.</p>'}
    </article>`;
}

function othersCard(s) {
  const max = Math.max(1, s.by_person[0]?.amount ?? 0, s.unassigned);
  const bills = n => `${n} bill${n === 1 ? '' : 's'}`;
  const rows = s.by_person.map(p => `
    <button class="catrow" data-action="drill-person" data-id="${p.id}" style="--c:var(--primary)">
      ${personIcon(p.name)}
      <div class="bar">
        <div><span>${esc(p.name)}</span><span>${formatINR(p.amount)}</span></div>
        <progress value="${p.amount}" max="${max}"></progress>
        <div class="meta"><span>${bills(p.count)}</span></div>
      </div>
    </button>`).join('');
  const unassigned = s.unassigned > 0 ? `
    <div class="catrow static" style="--c:var(--cat-slate)">
      <span class="avatar" style="--c:var(--cat-slate)" aria-hidden="true">?</span>
      <div class="bar">
        <div><span class="muted">Not assigned to anyone</span><span>${formatINR(s.unassigned)}</span></div>
        <progress value="${s.unassigned}" max="${max}"></progress>
      </div>
    </div>` : '';
  return `
    <article class="card">
      <header><h4>Spent on others</h4><small>${s.splits.count ? `${formatINR(s.paid_for_others)} · ${bills(s.splits.count)}` : ''}</small></header>
      ${rows || unassigned ? rows + unassigned : '<p class="muted">No split bills this period.</p>'}
      ${rows ? '<p class="hint">Tap a person for their bills</p>' : ''}
    </article>`;
}

function dowCard(s) {
  const { elapsed } = s.period;
  if (s.period.type !== 'month' || elapsed === 0) return '';
  const totals = Object.fromEntries(s.buckets.map(b => [b.k, b.amount]));
  const sum = Array(7).fill(0), cnt = Array(7).fill(0);
  for (let d = 1; d <= elapsed; d++) {
    const iso = isoDate(s.period.key, d), w = weekdayMon0(iso);
    sum[w] += totals[iso] ?? 0; cnt[w]++;
  }
  const avg = sum.map((v, i) => cnt[i] ? Math.round(v / cnt[i]) : 0);
  const max = Math.max(1, ...avg);
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const wkday = Math.round(avg.slice(0, 5).reduce((a, b) => a + b) / 5), wkend = Math.round((avg[5] + avg[6]) / 2);
  return `
    <article class="card">
      <header><h4>Day of week</h4><small>avg per day</small></header>
      <div class="chart-box h-dow"><table class="charts-css column show-labels data-spacing-6"><tbody>
        ${avg.map((v, i) => `<tr><th scope="row">${names[i]}</th><td style="--size:${Math.max(v / max, .01).toFixed(3)}"><span class="sr-only" hidden>${formatINR(v)}</span></td></tr>`).join('')}
      </tbody></table></div>
      <p class="hint">${s.my_spend ? (wkend > wkday
        ? `Weekends average ${formatINR(wkend)} a day vs ${formatINR(wkday)} on weekdays.`
        : `Weekdays average ${formatINR(wkday)} a day vs ${formatINR(wkend)} on weekends.`) : ''}</p>
    </article>`;
}

function paceCard(s) {
  const { elapsed, units, key, prev } = s.period;
  if (s.period.type !== 'month' || elapsed === 0) return '';
  const cumulative = (rows, monthKey, days) => {
    const m = Object.fromEntries(rows.map(r => [r.k, r.amount]));
    const out = []; let acc = 0;
    for (let d = 1; d <= days; d++) { acc += m[isoDate(monthKey, d)] ?? 0; out.push(acc); }
    return out;
  };
  const cur = cumulative(s.buckets, key, units).map((v, i) => i < elapsed ? v : null);
  const prevDays = daysInMonth(prev);
  const prevCum = s.prev.has_data ? cumulative(s.prev_buckets, prev, prevDays) : null;
  const prevAt = i => prevCum ? prevCum[Math.min(i, prevDays - 1)] : null;
  const usual = s.baseline?.avg_total ?? null;
  const usualAt = i => usual == null ? null : Math.round(usual * (i + 1) / units);
  const projected = elapsed < units && paceReady(s) ? Math.round(s.my_spend / elapsed * units) : null;

  const top = Math.max(1, s.my_spend, projected ?? 0, prevCum?.at(-1) ?? 0, usual ?? 0) * 1.05;
  const seg = (a, b, color) => a == null || b == null
    ? '<td style="--start:0;--end:0;--color:transparent"></td>'
    : `<td style="--start:${(a / top).toFixed(4)};--end:${(b / top).toFixed(4)};--color:${color}"></td>`;
  const rows = [];
  for (let i = 1; i < units; i++) {
    rows.push(`<tr>${seg(cur[i - 1], cur[i], 'var(--primary)')}${seg(prevAt(i - 1), prevAt(i), 'var(--prev-line)')}${seg(usualAt(i - 1), usualAt(i), i % 2 ? 'var(--avg-line)' : 'transparent')}</tr>`);
  }

  const headline = projected != null
    ? `<b>${formatINR(s.my_spend)}</b> spent in ${elapsed} day${elapsed > 1 ? 's' : ''}. At this rate you'll reach <b>${formatINR(projected)}</b> this month${usual ? `, against a usual <b>${formatINR(usual)}</b>` : ''}.`
    : elapsed < units
      ? `<b>${formatINR(s.my_spend)}</b> spent in ${elapsed} day${elapsed > 1 ? 's' : ''}. A projection for the month appears from day ${MIN_DAYS_FOR_PACE}.`
      : `<b>${formatINR(s.my_spend)}</b> spent this month${usual ? `, against a usual <b>${formatINR(usual)}</b>` : ''}.`;
  const badge = projected != null && usual
    ? `<span class="badge" data-variant="${projected > usual ? 'danger' : 'success'}">On pace for ${formatINR(projected)}</span>` : '';
  const prevName = shortMonth(prev);

  return `
    <article class="card span-2">
      <header><h4>Spending pace</h4>${badge}</header>
      <p class="pace-head">${headline}</p>
      <div class="chart-box h-pace"><table class="charts-css line multiple show-primary-axis"><tbody>${rows.join('')}</tbody></table></div>
      <div class="axis"><span>1</span><span>8</span><span>15</span><span>22</span><span>${units}</span></div>
      <div class="series">
        <span><i style="--c:var(--primary)"></i>This month</span>
        ${prevCum ? `<span><i style="--c:var(--prev-line)"></i>${esc(prevName)}</span>` : ''}
        ${usual ? `<span><i class="dash"></i>Usual (${s.baseline.months}-month avg)</span>` : ''}
      </div>
    </article>`;
}

function trendCard(s) {
  const t = s.trend;
  const withData = t.filter(m => m.amount > 0);
  const avg = s.period.type === 'month' ? s.baseline?.avg_total
    : withData.length ? Math.round(withData.reduce((a, m) => a + m.amount, 0) / withData.length) : null;
  const max = Math.max(1, ...t.map(m => m.amount), avg ?? 0) * 1.1;
  const partialKey = s.period.type === 'month' && s.period.elapsed < s.period.units ? s.period.key : null;
  return `
    <article class="card span-all">
      <header><h4>${s.period.type === 'month' ? 'Last 12 months' : `Months of ${esc(s.period.key)}`}</h4>
        <small>${avg ? 'dashed line = average' : ''}</small></header>
      <div class="chart-box h-trend">
        <table class="charts-css column show-labels data-spacing-4"><tbody>
          ${t.map(m => `<tr><th scope="row">${shortMonth(m.k)}</th><td class="${m.k === partialKey ? 'projected' : ''}" style="--size:${Math.max(m.amount / max, .005).toFixed(4)}" title="${formatINR(m.amount)}"></td></tr>`).join('')}
        </tbody></table>
        ${avg ? `<div class="avg-line" data-ratio="${(avg / max).toFixed(4)}"><span>avg ${formatINR(avg)}</span></div>` : ''}
      </div>
    </article>`;
}

export function renderAnalytics(el, s) {
  if (!s) { el.innerHTML = '<div class="skeleton box" role="status"></div>'; return; }
  const ins = insights(s);
  el.innerHTML = `
    <div class="an-grid">
      <div class="kpis span-all">${kpiCards(s)}</div>
      ${ins.length ? `<article class="card span-all insights"><header><h4>${icon('sparkles')} Insights</h4></header>
        <ul>${ins.map(([i, c, t]) => `<li style="--c:${c}">${icon(i)}<span>${t}</span></li>`).join('')}</ul></article>` : ''}
      ${categoriesCard(s)}
      ${topCard(s)}
      ${othersCard(s)}
      ${dowCard(s)}
      ${paceCard(s)}
      ${trendCard(s)}
    </div>`;
  positionAvgLines(el);
}

/** Place dashed average lines once the chart has a height. */
export function positionAvgLines(root) {
  requestAnimationFrame(() => {
    for (const line of $$('.avg-line', root)) {
      const body = line.parentElement.querySelector('tbody');
      if (!body) continue;
      line.style.top = `${body.offsetTop + body.offsetHeight * (1 - Number(line.dataset.ratio))}px`;
    }
  });
}

/** Category drill-down dialog content. */
export function renderDrill(d, periodLabel, expenseRow) {
  const total = d.expenses.reduce((a, e) => a + e.my_share, 0);
  const max = Math.max(1, ...d.trend.map(m => m.amount)) * 1.1;
  return {
    title: `<span class="hstack" style="gap:10px">${catIcon(d.category)} ${esc(d.category.name)}</span>`,
    sub: `${esc(periodLabel)} · last 12 months below`,
    body: `
      <div class="mini-kpis">
        <div><small>This ${d.period.type}</small><b>${formatINR(total)}</b></div>
        <div><small>Expenses</small><b>${d.expenses.length}</b></div>
        <div><small>12-month total</small><b>${formatINR(d.trend.reduce((a, m) => a + m.amount, 0))}</b></div>
      </div>
      <div class="chart-box h-drill">
        <table class="charts-css column show-labels data-spacing-3" style="--color:var(--cat-${esc(d.category.color)})"><tbody>
          ${d.trend.map(m => `<tr><th scope="row">${shortMonth(m.k)[0]}</th><td style="--size:${Math.max(m.amount / max, .005).toFixed(4)}" title="${shortMonth(m.k)} ${formatINR(m.amount)}"></td></tr>`).join('')}
        </tbody></table>
      </div>
      <div>${d.expenses.length ? d.expenses.map(e => expenseRow(e, { menu: false })).join('') : '<p class="muted">No expenses in this period.</p>'}</div>`,
  };
}

/** Person drill-down dialog content: the bills they were part of. */
export function renderPersonDrill(d, periodLabel, expenseRow) {
  const theirs = d.expenses.reduce((a, e) => a + (e.shares.find(x => x.person_id === d.person.id)?.amount ?? 0), 0);
  const total = d.expenses.reduce((a, e) => a + e.paid, 0);
  return {
    title: `<span class="hstack" style="gap:10px">${personIcon(d.person.name)} ${esc(d.person.name)}</span>`,
    sub: esc(periodLabel),
    body: `
      <div class="mini-kpis">
        <div><small>Spent on ${esc(d.person.name)}</small><b>${formatINR(theirs)}</b></div>
        <div><small>Bills</small><b>${d.expenses.length}</b></div>
        <div><small>Total paid</small><b>${formatINR(total)}</b></div>
      </div>
      <div>${d.expenses.length ? d.expenses.map(e => expenseRow(e, { menu: false })).join('') : '<p class="muted">No bills with them in this period.</p>'}</div>`,
  };
}
