const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-IN');

const charts = {}; // keep Chart.js instances so we can destroy/recreate on refresh

function fmtMoney(v) { return money.format(Number(v) || 0); }
function fmtNum(v) { return num.format(Number(v) || 0); }

// td() helpers: render a cell with both its display text and a raw,
// type-correct value in data-sort, so column sorting works on the real
// number/date/string rather than the formatted (comma/currency) text.
function td(display, sortVal, extraClass) {
  const cls = extraClass ? ` class="${extraClass}"` : '';
  const sort = sortVal === undefined || sortVal === null ? '' : String(sortVal);
  return `<td${cls} data-sort="${sort.replace(/"/g, '&quot;')}">${display}</td>`;
}
function moneyTd(v) { return td(fmtMoney(v), Number(v) || 0, 'num'); }
function numTd(v) { return td(fmtNum(v), Number(v) || 0, 'num'); }
function dateTd(v) { return td(v ? new Date(v).toLocaleDateString() : '', v ? new Date(v).getTime() : 0); }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    // Session expired (or never existed) mid-use — bounce to login instead
    // of leaving every table stuck showing a failed-to-load state.
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function fillTable(tableId, rows, renderRow, colSpan) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colSpan}">No data returned</td></tr>`;
  } else {
    rows.forEach(r => { tbody.insertAdjacentHTML('beforeend', renderRow(r)); });
  }
  resetTablePage(tableId);
  applyPagination(document.getElementById(tableId));
}

// ---------------- Sortable table columns ----------------
// Click a <th> to sort the current tbody rows by that column. Uses each
// <td data-sort="..."> raw value when present (see td()/moneyTd()/etc.)
// so money/number/date columns sort correctly, not just alphabetically.
// Rows are re-appended in place, so row click handlers keep working.

function initSortableTable(table) {
  if (table.dataset.sortableInit) return;
  table.dataset.sortableInit = '1';
  const headRow = table.querySelector('thead tr');
  if (!headRow) return;
  Array.from(headRow.children).forEach((th, idx) => {
    th.classList.add('sortable');
    th.addEventListener('click', () => sortTableByColumn(table, idx, th));
  });
}

function sortTableByColumn(table, colIndex, th) {
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr')).filter(r => !r.classList.contains('empty-row'));
  if (!rows.length) return;

  const nextDir = th.dataset.sortDir === 'asc' ? 'desc' : 'asc';
  table.querySelectorAll('th').forEach(h => {
    if (h !== th) { delete h.dataset.sortDir; h.classList.remove('sort-asc', 'sort-desc'); }
  });
  th.dataset.sortDir = nextDir;
  th.classList.toggle('sort-asc', nextDir === 'asc');
  th.classList.toggle('sort-desc', nextDir === 'desc');

  const cellValue = (row) => {
    const cell = row.children[colIndex];
    if (!cell) return '';
    return cell.hasAttribute('data-sort') ? cell.getAttribute('data-sort') : cell.textContent.trim();
  };
  const isNumeric = rows.every(r => {
    const v = cellValue(r);
    return v === '' || !isNaN(Number(v));
  });

  rows.sort((a, b) => {
    let va = cellValue(a), vb = cellValue(b);
    if (isNumeric) {
      va = va === '' ? -Infinity : Number(va);
      vb = vb === '' ? -Infinity : Number(vb);
      return nextDir === 'asc' ? va - vb : vb - va;
    }
    va = va.toLowerCase(); vb = vb.toLowerCase();
    if (va < vb) return nextDir === 'asc' ? -1 : 1;
    if (va > vb) return nextDir === 'asc' ? 1 : -1;
    return 0;
  });

  rows.forEach(r => tbody.appendChild(r));

  resetTablePage(table.id);
  applyPagination(table);
}

// ---------------- Table pagination ----------------
// Every .data-table gets a "Rows per page" control (10/25/50/100/All) below
// it — the chosen size is remembered per-table in localStorage, so it acts
// like a per-table setting rather than resetting every time you switch tabs.
// Pagination hides <tr> elements with the `hidden` attribute rather than
// removing them, so sorting (which reorders the same <tr> nodes) and click
// handlers on rows (month/order selection) keep working unchanged.

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 'All'];
const DEFAULT_PAGE_SIZE = 10;
const paginationState = {}; // tableId -> { page, pageSize }

function pageSizeStorageKey(tableId) { return `syncaxis.pageSize.${tableId}`; }

function getStoredPageSize(tableId) {
  try {
    const v = localStorage.getItem(pageSizeStorageKey(tableId));
    if (v === 'All') return Infinity;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAGE_SIZE;
  } catch (err) { return DEFAULT_PAGE_SIZE; }
}

function setStoredPageSize(tableId, size) {
  try { localStorage.setItem(pageSizeStorageKey(tableId), size === Infinity ? 'All' : String(size)); } catch (err) { /* ignore */ }
}

function tableDataRows(table) {
  return Array.from(table.querySelectorAll('tbody tr')).filter(r => !r.classList.contains('empty-row'));
}

function resetTablePage(tableId) {
  if (paginationState[tableId]) paginationState[tableId].page = 1;
}

function initTablePagination(table) {
  if (table.dataset.paginationInit) return;
  table.dataset.paginationInit = '1';
  const tableId = table.id;

  const bar = document.createElement('div');
  bar.className = 'table-pagination';
  bar.innerHTML = `
    <label class="page-size-label">Rows per page
      <select class="page-size-select"></select>
    </label>
    <span class="page-info"></span>
    <span class="page-buttons">
      <button type="button" class="btn-link page-prev">&laquo; Prev</button>
      <button type="button" class="btn-link page-next">Next &raquo;</button>
    </span>
  `;
  table.insertAdjacentElement('afterend', bar);

  const select = bar.querySelector('.page-size-select');
  PAGE_SIZE_OPTIONS.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    select.appendChild(o);
  });

  const storedSize = getStoredPageSize(tableId);
  paginationState[tableId] = { page: 1, pageSize: storedSize };
  select.value = storedSize === Infinity ? 'All' : String(storedSize);

  select.addEventListener('change', () => {
    const size = select.value === 'All' ? Infinity : Number(select.value);
    paginationState[tableId] = { page: 1, pageSize: size };
    setStoredPageSize(tableId, size);
    applyPagination(table);
  });
  bar.querySelector('.page-prev').addEventListener('click', () => {
    const st = paginationState[tableId];
    if (st.page > 1) { st.page--; applyPagination(table); }
  });
  bar.querySelector('.page-next').addEventListener('click', () => {
    const st = paginationState[tableId];
    const totalPages = Math.max(1, Math.ceil(tableDataRows(table).length / (st.pageSize === Infinity ? 1 : st.pageSize)));
    if (st.page < totalPages) { st.page++; applyPagination(table); }
  });

  applyPagination(table);
}

function applyPagination(table) {
  if (!table) return;
  const tableId = table.id;
  const st = paginationState[tableId];
  if (!st) return; // pagination not initialized yet for this table

  const rows = tableDataRows(table);
  const total = rows.length;
  const pageSize = st.pageSize === Infinity ? Math.max(total, 1) : st.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (st.page > totalPages) st.page = totalPages;
  if (st.page < 1) st.page = 1;
  const startIdx = (st.page - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  rows.forEach((r, i) => { r.hidden = !(i >= startIdx && i < endIdx); });

  const bar = table.nextElementSibling;
  if (!bar || !bar.classList.contains('table-pagination')) return;
  const info = bar.querySelector('.page-info');
  info.textContent = total === 0 ? 'No rows' : `${startIdx + 1}–${Math.min(endIdx, total)} of ${total}`;
  bar.querySelector('.page-prev').disabled = st.page <= 1;
  bar.querySelector('.page-next').disabled = st.page >= totalPages;
}

function lineChart(canvasId, labels, data, label, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.25 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}

function multiLineChart(canvasId, labels, series) {
  // series: [{ label, data, color }, ...]
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: series.map(s => ({
        label: s.label, data: s.data, borderColor: s.color,
        backgroundColor: s.color + '22', fill: false, tension: 0.25
      }))
    },
    options: { responsive: true, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true } } }
  });
}

function barChart(canvasId, labels, data, label, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label, data, backgroundColor: color }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}

// ---------------- Module loaders ----------------

let crmSelectedMonth = null; // 'YYYY-MM', or null = not filtered to a specific month
let crmViewMode = 'recent'; // 'recent' (most recent 15, default) or 'all' (every record in the selected FY) — overridden by crmSelectedMonth when set

function crmMonthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function selectCrmMonth(period) {
  crmSelectedMonth = period;
  refreshCurrent();
}

function setCrmViewMode(mode) {
  crmViewMode = mode;
  crmSelectedMonth = null;
  refreshCurrent();
}

// Indian financial year: 1 April of startYear -> 31 March of startYear+1.
function currentFYStartYear() {
  const now = new Date();
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // Apr = month index 3
}

let crmSelectedFY = currentFYStartYear();
let crmFYInitialized = false;

function fyLabel(startYear) {
  return `FY ${startYear}-${String(startYear + 1).slice(-2)}`;
}

function initCrmFYSelect() {
  if (crmFYInitialized) return;
  crmFYInitialized = true;
  const select = document.getElementById('crm-fy-select');
  const current = currentFYStartYear();
  for (let y = current; y >= current - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = fyLabel(y);
    select.appendChild(opt);
  }
  select.value = crmSelectedFY;
  select.addEventListener('change', () => {
    crmSelectedFY = Number(select.value);
    refreshCurrent();
  });
}

async function loadCRM() {
  initCrmFYSelect();
  // A specific month (clicking a monthly-breakdown row) always wins; otherwise
  // 'all' scopes the 4 recent-* lists to the whole selected FY (default), or
  // 'recent' asks for the unfiltered "most recent 15" instead.
  const listQuery = crmSelectedMonth
    ? `?month=${encodeURIComponent(crmSelectedMonth)}`
    : (crmViewMode === 'all' ? `?view=all&fy=${crmSelectedFY}` : '');
  const fyQuery = `?fy=${crmSelectedFY}`;
  const [summary, funnel, monthly, enquiries, quotations, orders, invoices, followups] = await Promise.all([
    fetchJSON('/api/crm/summary' + fyQuery),
    fetchJSON('/api/crm/pipeline-funnel' + fyQuery),
    fetchJSON('/api/crm/monthly-breakdown' + fyQuery),
    fetchJSON('/api/crm/recent-enquiries' + listQuery),
    fetchJSON('/api/crm/recent-quotations' + listQuery),
    fetchJSON('/api/crm/recent-orders' + listQuery),
    fetchJSON('/api/crm/recent-invoices' + listQuery),
    fetchJSON('/api/crm/pending-followups')
  ]);

  const fyText = fyLabel(crmSelectedFY);
  document.getElementById('crm-funnel-title').textContent = `Pipeline volume — ${fyText}`;
  document.getElementById('crm-trend-title').textContent = `Monthly pipeline trend — ${fyText}`;
  document.getElementById('crm-breakdown-title').textContent = `Monthly breakdown — ${fyText}`;
  const s = summary[0] || {};
  document.getElementById('crm-enquiries').textContent = fmtNum(s.enquiriesInFY);
  document.getElementById('crm-quotations').textContent = fmtNum(s.quotationsInFY);
  document.getElementById('crm-orders').textContent = fmtNum(s.ordersInFY);
  document.getElementById('crm-order-value').textContent = fmtMoney(s.orderValueInFY);
  document.getElementById('crm-followups-due').textContent = fmtNum(s.followupsDue);
  document.getElementById('crm-enquiries-label').textContent = `Enquiries — ${fyText}`;
  document.getElementById('crm-quotations-label').textContent = `Quotations — ${fyText}`;
  document.getElementById('crm-orders-label').textContent = `Sales orders — ${fyText}`;

  barChart('chart-crm-funnel', funnel.map(r => r.stage), funnel.map(r => r.count), 'Count', ['#3E6B94', '#B8862F', '#3F7859']);

  multiLineChart('chart-crm-monthly-trend', monthly.map(r => r.period), [
    { label: 'Enquiries', data: monthly.map(r => r.enquiryCount), color: '#3E6B94' },
    { label: 'Quotations', data: monthly.map(r => r.quotationCount), color: '#B8862F' },
    { label: 'Sales Orders', data: monthly.map(r => r.orderCount), color: '#3F7859' }
  ]);

  fillTable('table-crm-monthly-breakdown', monthly,
    r => `<tr class="${r.period === crmSelectedMonth ? 'selected' : ''}" onclick="selectCrmMonth('${r.period}')"><td>${r.period}</td>${numTd(r.enquiryCount)}${numTd(r.quotationCount)}${moneyTd(r.quotationValue)}${numTd(r.orderCount)}${moneyTd(r.orderValue)}${numTd(r.invoiceCount)}${moneyTd(r.invoiceValue)}${numTd(r.followUpCount)}</tr>`, 9);
  const fySum = (key) => monthly.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
  document.getElementById('crm-breakdown-summary').innerHTML =
    `FY total &middot; Enquiries: <strong>${fmtNum(fySum('enquiryCount'))}</strong>` +
    ` &middot; Quotations: <strong>${fmtNum(fySum('quotationCount'))}</strong> (<strong>${fmtMoney(fySum('quotationValue'))}</strong>)` +
    ` &middot; Orders: <strong>${fmtNum(fySum('orderCount'))}</strong> (<strong>${fmtMoney(fySum('orderValue'))}</strong>)` +
    ` &middot; Invoices: <strong>${fmtNum(fySum('invoiceCount'))}</strong> (<strong>${fmtMoney(fySum('invoiceValue'))}</strong>)` +
    ` &middot; Follow-ups: <strong>${fmtNum(fySum('followUpCount'))}</strong>`;

  // A complete data set (no arbitrary row cap) when a month is selected or
  // when in "all" mode — only "recent" mode is genuinely a capped subset.
  const isCompleteSet = !!crmSelectedMonth || crmViewMode === 'all';
  const label = crmSelectedMonth ? crmMonthLabel(crmSelectedMonth) : (crmViewMode === 'all' ? `All — ${fyText}` : 'Most recent 15');
  document.getElementById('crm-filter-label').textContent = label;
  document.getElementById('crm-filter-all').hidden = !crmSelectedMonth && crmViewMode === 'all';
  document.getElementById('crm-filter-recent').hidden = !crmSelectedMonth && crmViewMode === 'recent';

  document.getElementById('crm-enquiries-title').textContent = crmSelectedMonth
    ? `Enquiries — ${label}` : (crmViewMode === 'all' ? `All enquiries — ${fyText}` : 'Recent enquiries');
  document.getElementById('crm-quotations-title').textContent = crmSelectedMonth
    ? `Quotations — ${label}` : (crmViewMode === 'all' ? `All quotations — ${fyText}` : 'Recent quotations');
  document.getElementById('crm-orders-title').textContent = crmSelectedMonth
    ? `Sales orders — ${label}` : (crmViewMode === 'all' ? `All sales orders — ${fyText}` : 'Recent sales orders');
  document.getElementById('crm-invoices-title').textContent = crmSelectedMonth
    ? `Invoices — ${label}` : (crmViewMode === 'all' ? `All invoices — ${fyText}` : 'Recent invoices');

  fillTable('table-crm-enquiries', enquiries,
    r => `<tr><td>${r.enquiryNo ?? ''}</td><td>${r.customerName || ''}</td>${dateTd(r.enquiryDate)}<td>${r.statusLabel ?? r.statusCode ?? ''}</td><td>${r.quotationNo ?? '—'}</td>${dateTd(r.nextFollowUp)}</tr>`, 6);
  tableSummary('crm-enquiries-summary', enquiries, null, 'enquiry', null);

  fillTable('table-crm-quotations', quotations,
    r => `<tr><td>${r.quotationNo ?? ''}</td><td>${r.customerName || ''}</td>${moneyTd(r.quotationValue)}<td>${r.statusLabel ?? r.statusCode ?? ''}</td><td>${r.syncaxisOrderNo ?? '—'}</td></tr>`, 5);
  tableSummary('crm-quotations-summary', quotations, 'quotationValue', 'quotation', isCompleteSet ? 'Total' : 'Total (of rows shown)');

  fillTable('table-crm-orders', orders,
    r => `<tr><td>${r.syncaxisOrderNo ?? ''}</td><td>${r.customerRefNo ?? ''}</td><td>${r.customerName || ''}</td>${moneyTd(r.orderValue)}<td>${r.statusLabel ?? r.statusCode ?? ''}</td>${td(r.invoiceCount ? fmtNum(r.invoiceCount) : 'No', Number(r.invoiceCount) || 0, 'num')}<td>${r.lastInvoiceNo ?? '—'}</td>${td(r.invoicedAmount ? fmtMoney(r.invoicedAmount) : '—', Number(r.invoicedAmount) || 0, 'num')}</tr>`, 8);
  tableSummary('crm-orders-summary', orders, 'orderValue', 'order', isCompleteSet ? 'Total' : 'Total (of rows shown)');

  fillTable('table-crm-invoices', invoices,
    r => `<tr><td>${r.invoiceNo ?? ''}</td><td>${r.customerName || ''}</td>${dateTd(r.invoiceDate)}${moneyTd(r.invoiceValue)}<td>${r.statusCode ?? ''}</td><td>${r.syncaxisOrderNo ?? '—'}</td></tr>`, 6);
  tableSummary('crm-invoices-summary', invoices, 'invoiceValue', 'invoice', isCompleteSet ? 'Total' : 'Total (of rows shown)');

  fillTable('table-crm-followups', followups,
    r => `<tr><td>${r.customerName ?? ''}</td><td>${r.basedOnLabel ?? r.basedOn ?? ''}</td>${dateTd(r.nextFollowUpDate)}<td>${r.salesperson ?? ''}</td><td>${r.remark ?? r.nextAgenda ?? ''}</td></tr>`, 5);
  tableSummary('crm-followups-summary', followups, null, 'follow-up', null);
}

// ---------------- Order Lineage ----------------

function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : ''; }

let lineageSelectedFY = currentFYStartYear();
let lineageFYInitialized = false;
let lineageSelectedMonth = null; // 'YYYY-MM', or null = no month filter
let lineageViewMode = 'recent'; // 'recent' (most recent 10, default) or 'all' (every order in the selected FY) — overridden by a search term or lineageSelectedMonth when set

function initLineageFYSelect() {
  if (lineageFYInitialized) return;
  lineageFYInitialized = true;
  const select = document.getElementById('lineage-fy-select');
  const current = currentFYStartYear();
  for (let y = current; y >= current - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = fyLabel(y);
    select.appendChild(opt);
  }
  select.value = lineageSelectedFY;
  select.addEventListener('change', () => {
    lineageSelectedFY = Number(select.value);
    refreshCurrent();
  });
}

function selectLineageMonth(period) {
  lineageSelectedMonth = period;
  document.getElementById('lineage-search').value = '';
  refreshCurrent();
}

function clearLineageMonth() {
  lineageSelectedMonth = null;
  refreshCurrent();
}

function lineageSearchSubmit() {
  lineageSelectedMonth = null;
  refreshCurrent();
}

function lineageClearSearch() {
  document.getElementById('lineage-search').value = '';
  lineageSelectedMonth = null;
  lineageViewMode = 'recent';
  refreshCurrent();
}

function setLineageViewMode(mode) {
  document.getElementById('lineage-search').value = '';
  lineageSelectedMonth = null;
  lineageViewMode = mode;
  refreshCurrent();
}

async function loadLineage() {
  initLineageFYSelect();
  const fyText = fyLabel(lineageSelectedFY);

  const monthly = await fetchJSON('/api/lineage/monthly-breakdown?fy=' + lineageSelectedFY);
  document.getElementById('lineage-breakdown-title').innerHTML =
    `Monthly breakdown — ${fyText} <span class="muted">(click a month row to filter the order list below)</span>`;
  fillTable('table-lineage-monthly-breakdown', monthly,
    r => `<tr class="${r.period === lineageSelectedMonth ? 'selected' : ''}" onclick="selectLineageMonth('${r.period}')"><td>${r.period}</td>${numTd(r.orderCount)}${moneyTd(r.orderValue)}</tr>`, 3);

  const filterBar = document.getElementById('lineage-month-filter-bar');
  filterBar.hidden = !lineageSelectedMonth;
  document.getElementById('lineage-month-filter-label').textContent = lineageSelectedMonth ? crmMonthLabel(lineageSelectedMonth) : '';

  await lineageSearch();

  // Re-fetch the currently-open order's detail too, so the global Refresh
  // button (and FY/month changes) actually refresh what's on screen instead
  // of leaving stale data in the timeline below.
  if (lineageCurrentOrderId) {
    await loadLineageDetail(lineageCurrentOrderId);
    document.querySelectorAll('#table-lineage-orders tbody tr').forEach(tr => {
      tr.classList.toggle('selected', Number(tr.dataset.orderId) === lineageCurrentOrderId);
    });
  }
}

async function lineageSearch() {
  const term = document.getElementById('lineage-search').value.trim();
  const params = [];
  if (term) params.push('search=' + encodeURIComponent(term));
  if (lineageSelectedMonth) params.push('month=' + encodeURIComponent(lineageSelectedMonth));
  if (!term && !lineageSelectedMonth && lineageViewMode === 'all') {
    params.push('view=all', 'fy=' + lineageSelectedFY);
  }
  const url = '/api/lineage/orders' + (params.length ? '?' + params.join('&') : '');
  const orders = await fetchJSON(url);
  fillTable('table-lineage-orders', orders,
    r => `<tr onclick="viewLineage(${r.orderId})" data-order-id="${r.orderId}"><td>${r.syncaxisOrderNo ?? ''}</td><td>${r.customerRefNo ?? ''}</td><td>${r.customerName || ''}</td>${dateTd(r.orderDate)}${moneyTd(r.orderValue)}<td>${r.statusCode ?? ''}</td><td>${r.itemNames || '—'}</td></tr>`, 7);
  tableSummary('lineage-orders-summary', orders, 'orderValue', 'order', (lineageSelectedMonth || (!term && lineageViewMode === 'all')) ? 'Total' : 'Total (of rows shown)');

  const isSearching = !!term;
  document.getElementById('lineage-filter-all').hidden = !isSearching && !lineageSelectedMonth && lineageViewMode === 'all';
  document.getElementById('lineage-clear-btn').hidden = !isSearching && !lineageSelectedMonth && lineageViewMode === 'recent';
}

function lineageStage(title, count, dotClass, bodyHtml) {
  return `
    <div class="lineage-stage">
      <div class="lineage-stage-marker">
        <div class="lineage-dot ${dotClass}"></div>
        <div class="lineage-connector"></div>
      </div>
      <div class="lineage-stage-body">
        <div class="lineage-stage-title">${title}${count != null ? `<span class="lineage-count-badge">${count}</span>` : ''}</div>
        ${bodyHtml}
      </div>
    </div>`;
}

function lineageSubList(headers, rowsHtml) {
  if (!rowsHtml.length) return '';
  const thead = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
  return `<div class="lineage-sublist"><table>${thead}<tbody>${rowsHtml.join('')}</tbody></table></div>`;
}

function renderLineageTimeline(data) {
  const h = data.header;
  if (!h) return '<div class="lineage-empty-note">Order not found.</div>';

  const sjos = data.shopJobOrders || [];
  const prod = data.production || [];
  const issues = data.storeIssues || [];
  const challans = data.despatchChallans || [];
  const invoices = data.invoices || [];
  const ar = data.customerAR || {};

  let html = '';

  html += lineageStage('Enquiry', null, h.enquiryId ? 'done' : 'empty',
    h.enquiryId
      ? `<div class="lineage-fact-row"><span class="muted">No.</span>${h.enquiryNo} <span class="muted">Date</span>${fmtDate(h.enquiryDate)}</div>`
      : `<div class="lineage-empty-note">No enquiry on record — order created directly.</div>`);

  html += lineageStage('Quotation', null, h.quotationId ? 'done' : 'empty',
    h.quotationId
      ? `<div class="lineage-fact-row"><span class="muted">No.</span>${h.quotationNo} <span class="muted">Date</span>${fmtDate(h.quotationDate)} <span class="muted">Value</span>${fmtMoney(h.quotationValue)}</div>`
      : `<div class="lineage-empty-note">No quotation on record.</div>`);

  html += lineageStage('Customer Order / Sales Order', null, 'done',
    `<div class="lineage-fact-row"><span class="muted">SO No.</span>${h.syncaxisOrderNo} <span class="muted">Customer PO No.</span>${h.customerRefNo || '—'}</div>
     <div class="lineage-fact-row"><span class="muted">Date</span>${fmtDate(h.orderDate)} <span class="muted">Value</span>${fmtMoney(h.orderValue)} <span class="muted">Status</span>${h.statusLabel}</div>
     <div class="lineage-fact-row"><span class="muted">Customer</span>${h.customerName || ''} <span class="muted">Salesperson</span>${h.salesperson || '—'}</div>
     <div class="lineage-fact-row"><span class="muted">Item(s)</span>${h.itemNames || '—'}</div>`);

  html += lineageStage('Order Acceptance Form (OAF)', null, h.oafId ? 'done' : 'empty',
    h.oafId
      ? `<div class="lineage-fact-row"><span class="muted">No.</span>${h.oafNo} <span class="muted">Date</span>${fmtDate(h.oafDate)}</div>`
      : `<div class="lineage-empty-note">No OAF on record.</div>`);

  html += lineageStage('Manufacturing (Shop Job Orders)', sjos.length || null,
    sjos.length ? (sjos.every(s => s.statusCode === 'F') ? 'done' : 'partial') : 'empty',
    sjos.length
      ? lineageSubList(['SJO No.', 'Date', 'Item', 'Qty', 'Status'],
          sjos.map(s => `<tr><td>${s.sjoNo}</td><td>${fmtDate(s.sjoDate)}</td><td class="wrap">${(s.itemName || s.itemCode || '').trim()}</td><td>${fmtNum(s.orderedQty)}</td><td>${s.statusCode ?? ''}</td></tr>`))
      : `<div class="lineage-empty-note">No manufacturing job triggered for this order.</div>`);

  html += lineageStage('Work Order &amp; Production Receipt', prod.length || null,
    prod.length ? (prod.every(p => p.statusCode === 'C') ? 'done' : 'partial') : 'empty',
    prod.length
      ? lineageSubList(['WO No.', 'Receipt Date', 'Item', 'Received / Ordered', 'Status'],
          prod.map(p => `<tr><td>${p.workOrderNo ?? ''}</td><td>${fmtDate(p.receiptDate)}</td><td class="wrap">${(p.itemName || p.itemCode || '').trim()}</td><td>${fmtNum(p.receivedQty)} / ${fmtNum(p.orderedQty)}</td><td>${p.statusCode ?? ''}</td></tr>`))
      : `<div class="lineage-empty-note">No production receipt recorded yet.</div>`);

  html += lineageStage('Store — Material Issued', issues.length || null, issues.length ? 'done' : 'empty',
    issues.length
      ? lineageSubList(['Issue No.', 'Date', 'SJO No.', 'Item(s)'],
          issues.map(i => `<tr><td>${i.issueNo}</td><td>${fmtDate(i.issueDate)}</td><td>${i.sjoNo ?? ''}</td><td class="wrap">${i.itemNames || '—'}</td></tr>`))
      : `<div class="lineage-empty-note">No material issued from store yet.</div>`);

  html += lineageStage('Despatch', challans.length || null, challans.length ? 'done' : (invoices.length ? 'partial' : 'empty'),
    challans.length
      ? lineageSubList(['Challan No.', 'Date', 'Item(s)', 'Status'],
          challans.map(c => `<tr><td>${c.challanNo}</td><td>${fmtDate(c.challanDate)}</td><td class="wrap">${c.itemNames || '—'}</td><td>${c.statusCode ?? ''}</td></tr>`))
      : (invoices.length
          ? `<div class="lineage-empty-note">No separate delivery challan — despatched together with the invoice below.</div>`
          : `<div class="lineage-empty-note">Not yet despatched.</div>`));

  html += lineageStage('Invoice', invoices.length || null, invoices.length ? 'done' : 'empty',
    invoices.length
      ? lineageSubList(['Invoice No.', 'Date', 'Item(s)', 'Value', 'Status'],
          invoices.map(i => `<tr><td>${i.invoiceNo}</td><td>${fmtDate(i.invoiceDate)}</td><td class="wrap">${i.itemNames || '—'}</td><td class="num">${fmtMoney(i.invoiceValue)}</td><td>${i.statusCode ?? ''}</td></tr>`))
      : `<div class="lineage-empty-note">Not yet invoiced.</div>`);

  html += `
    <div class="lineage-stage">
      <div class="lineage-stage-marker">
        <div class="lineage-dot ${ar.receivable > 0 ? 'partial' : 'done'}"></div>
      </div>
      <div class="lineage-stage-body">
        <div class="lineage-stage-title">Financial Settlement</div>
        <div class="lineage-fact-row"><span class="muted">Customer's overall outstanding receivable</span>${fmtMoney(ar.receivable)} <span class="muted">across</span>${fmtNum(ar.outstandingEntries)} <span class="muted">entries</span></div>
        <div class="lineage-empty-note">Account-level balance for ${h.customerName ? h.customerName.trim() : 'this customer'} — not traceable to this specific invoice (no reliable per-invoice link found in the data).</div>
      </div>
    </div>`;

  return html;
}

let lineageCurrentOrderId = null; // whichever order's detail is open, so Refresh/filter changes re-fetch it too

async function loadLineageDetail(orderId) {
  const wrap = document.getElementById('lineage-detail-wrap');
  const timelineEl = document.getElementById('lineage-timeline');
  wrap.hidden = false;
  timelineEl.innerHTML = '<div class="lineage-empty-note">Loading…</div>';
  document.getElementById('lineage-detail-title').textContent = 'Order Lineage — loading…';
  try {
    const data = await fetchJSON('/api/lineage/order/' + orderId);
    document.getElementById('lineage-detail-title').textContent = data.header ? `Order Lineage — ${data.header.syncaxisOrderNo}` : 'Order Lineage';
    timelineEl.innerHTML = renderLineageTimeline(data);
  } catch (err) {
    timelineEl.innerHTML = '<div class="lineage-empty-note">Failed to load lineage — see console.</div>';
    console.error(err);
  }
}

async function viewLineage(orderId) {
  lineageCurrentOrderId = orderId;
  document.querySelectorAll('#table-lineage-orders tbody tr').forEach(tr => {
    tr.classList.toggle('selected', Number(tr.dataset.orderId) === orderId);
  });
  await loadLineageDetail(orderId);
}

let salesSelectedFY = currentFYStartYear();
let salesFYInitialized = false;
let salesSelectedMonth = null; // 'YYYY-MM', or null = not filtered to a specific month
let salesViewMode = 'recent'; // 'recent' (most recent 10, default) or 'all' (every invoice in the selected FY) — overridden by salesSelectedMonth when set

function initSalesFYSelect() {
  if (salesFYInitialized) return;
  salesFYInitialized = true;
  const select = document.getElementById('sales-fy-select');
  const current = currentFYStartYear();
  for (let y = current; y >= current - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = fyLabel(y);
    select.appendChild(opt);
  }
  select.value = salesSelectedFY;
  select.addEventListener('change', () => {
    salesSelectedFY = Number(select.value);
    refreshCurrent();
  });
}

function selectSalesMonth(period) {
  salesSelectedMonth = period;
  refreshCurrent();
}

function setSalesViewMode(mode) {
  salesViewMode = mode;
  salesSelectedMonth = null;
  refreshCurrent();
}

async function loadSales() {
  initSalesFYSelect();
  const listQuery = salesSelectedMonth
    ? `?month=${encodeURIComponent(salesSelectedMonth)}`
    : (salesViewMode === 'all' ? `?view=all&fy=${salesSelectedFY}` : '');
  const [summary, trend, topCustomers, monthly, invoices] = await Promise.all([
    fetchJSON('/api/sales/summary'),
    fetchJSON('/api/sales/trend'),
    fetchJSON('/api/sales/top-customers'),
    fetchJSON('/api/sales/monthly-breakdown?fy=' + salesSelectedFY),
    fetchJSON('/api/sales/invoices' + listQuery)
  ]);
  const s = summary[0] || {};
  document.getElementById('sales-revenue').textContent = fmtMoney(s.totalRevenue);
  document.getElementById('sales-invoices').textContent = fmtNum(s.invoiceCount);
  document.getElementById('sales-avg').textContent = fmtMoney(s.avgInvoiceValue);

  lineChart('chart-sales-trend', trend.map(r => r.period), trend.map(r => r.revenue), 'Revenue', '#3E6B94');

  fillTable('table-top-customers', topCustomers,
    r => `<tr><td>${r.customerName}</td>${moneyTd(r.totalRevenue)}${numTd(r.invoiceCount)}</tr>`, 3);

  const fyText = fyLabel(salesSelectedFY);
  document.getElementById('sales-breakdown-title').innerHTML =
    `Monthly breakdown — ${fyText} <span class="muted">(click a month row to filter the invoice list below)</span>`;
  fillTable('table-sales-monthly-breakdown', monthly,
    r => `<tr class="${r.period === salesSelectedMonth ? 'selected' : ''}" onclick="selectSalesMonth('${r.period}')"><td>${r.period}</td>${numTd(r.invoiceCount)}${moneyTd(r.revenue)}</tr>`, 3);
  const fyInvoiceTotal = monthly.reduce((sum, r) => sum + (Number(r.invoiceCount) || 0), 0);
  const fyRevenueTotal = monthly.reduce((sum, r) => sum + (Number(r.revenue) || 0), 0);
  document.getElementById('sales-breakdown-summary').innerHTML =
    `FY total &middot; Invoices: <strong>${fmtNum(fyInvoiceTotal)}</strong> &middot; Revenue: <strong>${fmtMoney(fyRevenueTotal)}</strong>`;

  const isCompleteSet = !!salesSelectedMonth || salesViewMode === 'all';
  const label = salesSelectedMonth ? crmMonthLabel(salesSelectedMonth) : (salesViewMode === 'all' ? `All — ${fyText}` : 'Most recent 10');
  document.getElementById('sales-month-filter-label').textContent = label;
  document.getElementById('sales-filter-all').hidden = !salesSelectedMonth && salesViewMode === 'all';
  document.getElementById('sales-filter-recent').hidden = !salesSelectedMonth && salesViewMode === 'recent';
  document.getElementById('sales-invoices-title').textContent = salesSelectedMonth
    ? `Invoices — ${label}` : (salesViewMode === 'all' ? `All invoices — ${fyText}` : 'Recent invoices');

  fillTable('table-sales-invoices', invoices,
    r => `<tr><td>${r.invoiceNo ?? ''}</td><td>${r.customerName || ''}</td>${dateTd(r.invoiceDate)}${moneyTd(r.invoiceValue)}<td>${r.statusCode ?? ''}</td><td>${r.syncaxisOrderNo ?? '—'}</td></tr>`, 6);
  tableSummary('sales-invoices-summary', invoices, 'invoiceValue', 'invoice', isCompleteSet ? 'Total' : 'Total (of rows shown)');
}

let purchaseSelectedFY = currentFYStartYear();
let purchaseFYInitialized = false;
let purchaseSelectedMonth = null; // 'YYYY-MM', or null = not filtered to a specific month
let purchaseViewMode = 'recent'; // 'recent' (most recent 10, default) or 'all' (every record in the selected FY) — governs bills/orders/GRN together, overridden by purchaseSelectedMonth when set

function initPurchaseFYSelect() {
  if (purchaseFYInitialized) return;
  purchaseFYInitialized = true;
  const select = document.getElementById('purchase-fy-select');
  const current = currentFYStartYear();
  for (let y = current; y >= current - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = fyLabel(y);
    select.appendChild(opt);
  }
  select.value = purchaseSelectedFY;
  select.addEventListener('change', () => {
    purchaseSelectedFY = Number(select.value);
    refreshCurrent();
  });
}

function selectPurchaseMonth(period) {
  purchaseSelectedMonth = period;
  refreshCurrent();
}

function setPurchaseViewMode(mode) {
  purchaseViewMode = mode;
  purchaseSelectedMonth = null;
  refreshCurrent();
}

async function loadPurchase() {
  initPurchaseFYSelect();
  const listQuery = purchaseSelectedMonth
    ? `?month=${encodeURIComponent(purchaseSelectedMonth)}`
    : (purchaseViewMode === 'all' ? `?view=all&fy=${purchaseSelectedFY}` : '');
  const [summary, trend, topVendors, monthly, bills, orders, materialReceived] = await Promise.all([
    fetchJSON('/api/purchase/summary'),
    fetchJSON('/api/purchase/trend'),
    fetchJSON('/api/purchase/top-vendors'),
    fetchJSON('/api/purchase/monthly-breakdown?fy=' + purchaseSelectedFY),
    fetchJSON('/api/purchase/bills' + listQuery),
    fetchJSON('/api/purchase/orders' + listQuery),
    fetchJSON('/api/purchase/material-received' + listQuery)
  ]);
  const s = summary[0] || {};
  document.getElementById('purchase-spend').textContent = fmtMoney(s.totalSpend);
  document.getElementById('purchase-bills').textContent = fmtNum(s.billCount);
  document.getElementById('purchase-avg').textContent = fmtMoney(s.avgBillValue);

  lineChart('chart-purchase-trend', trend.map(r => r.period), trend.map(r => r.spend), 'Spend', '#B8862F');

  fillTable('table-top-vendors', topVendors,
    r => `<tr><td>${r.vendorName}</td>${moneyTd(r.totalSpend)}${numTd(r.billCount)}</tr>`, 3);

  const fyText = fyLabel(purchaseSelectedFY);
  document.getElementById('purchase-breakdown-title').innerHTML =
    `Monthly breakdown — ${fyText} <span class="muted">(click a month row to filter the bill list below)</span>`;
  fillTable('table-purchase-monthly-breakdown', monthly,
    r => `<tr class="${r.period === purchaseSelectedMonth ? 'selected' : ''}" onclick="selectPurchaseMonth('${r.period}')"><td>${r.period}</td>${numTd(r.billCount)}${moneyTd(r.spend)}</tr>`, 3);
  const fyBillTotal = monthly.reduce((sum, r) => sum + (Number(r.billCount) || 0), 0);
  const fySpendTotal = monthly.reduce((sum, r) => sum + (Number(r.spend) || 0), 0);
  document.getElementById('purchase-breakdown-summary').innerHTML =
    `FY total &middot; Bills: <strong>${fmtNum(fyBillTotal)}</strong> &middot; Spend: <strong>${fmtMoney(fySpendTotal)}</strong>`;

  const isCompleteSet = !!purchaseSelectedMonth || purchaseViewMode === 'all';
  const label = purchaseSelectedMonth ? crmMonthLabel(purchaseSelectedMonth) : (purchaseViewMode === 'all' ? `All — ${fyText}` : 'Most recent 10');
  document.getElementById('purchase-month-filter-label').textContent = label;
  document.getElementById('purchase-filter-all').hidden = !purchaseSelectedMonth && purchaseViewMode === 'all';
  document.getElementById('purchase-filter-recent').hidden = !purchaseSelectedMonth && purchaseViewMode === 'recent';
  document.getElementById('purchase-bill-detail-title').textContent = purchaseSelectedMonth
    ? `Purchase bills — ${label}` : (purchaseViewMode === 'all' ? `All purchase bills — ${fyText}` : 'Recent purchase bills');
  document.getElementById('purchase-orders-title').textContent = purchaseSelectedMonth
    ? `Purchase orders — ${label}` : (purchaseViewMode === 'all' ? `All purchase orders — ${fyText}` : 'Recent purchase orders');
  document.getElementById('purchase-grn-title').textContent = purchaseSelectedMonth
    ? `Material received — ${label}` : (purchaseViewMode === 'all' ? `All material received — ${fyText}` : 'Material received (GRN)');

  fillTable('table-purchase-bill-detail', bills,
    r => `<tr><td>${r.billNo ?? ''}</td><td>${r.vendorBillNo ?? '—'}</td><td>${r.vendorName || ''}</td>${dateTd(r.billDate)}${moneyTd(r.billAmount)}<td>${r.statusCode ?? ''}</td></tr>`, 6);
  tableSummary('purchase-bill-detail-summary', bills, 'billAmount', 'bill', isCompleteSet ? 'Total' : 'Total (of rows shown)');

  fillTable('table-purchase-orders', orders,
    r => `<tr><td>${r.poNo ?? ''}</td><td>${r.vendorName || ''}</td>${dateTd(r.orderDate)}${moneyTd(r.orderValue)}${moneyTd(r.receivedValue)}<td>${r.statusLabel ?? r.statusCode ?? ''}</td></tr>`, 6);
  tableSummary('purchase-orders-summary', orders, 'orderValue', 'PO', isCompleteSet ? 'Total' : 'Total (of rows shown)');

  fillTable('table-purchase-grn', materialReceived,
    r => `<tr><td>${r.grnNo ?? ''}</td><td>${r.poNo ?? '—'}</td><td>${r.vendorName || ''}</td>${dateTd(r.receiptDate)}<td>${r.vendorChallanNo ?? ''}</td>${dateTd(r.vendorChallanDate)}<td>${r.statusLabel ?? r.statusCode ?? ''}</td></tr>`, 7);
  tableSummary('purchase-grn-summary', materialReceived, null, 'GRN', null);
}

let invSelectedFY = currentFYStartYear();
let invFYInitialized = false;
let invViewMode = 'recent'; // 'recent' (most recent 10, default) or 'all' (every production receipt in the selected FY)

function setInvViewMode(mode) {
  invViewMode = mode;
  refreshCurrent();
}

function initInvFYSelect() {
  if (invFYInitialized) return;
  invFYInitialized = true;
  const select = document.getElementById('inv-fy-select');
  const current = currentFYStartYear();
  for (let y = current; y >= current - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = fyLabel(y);
    select.appendChild(opt);
  }
  select.value = invSelectedFY;
  select.addEventListener('change', () => {
    invSelectedFY = Number(select.value);
    refreshCurrent();
  });
}

async function loadInventory() {
  initInvFYSelect();
  const fyQuery = `?fy=${invSelectedFY}`;
  const listQuery = invViewMode === 'all' ? `?view=all&fy=${invSelectedFY}` : '';
  const [summary, lowStock, topItems, monthly, productionReceipts] = await Promise.all([
    fetchJSON('/api/inventory/summary'),
    fetchJSON('/api/inventory/low-stock'),
    fetchJSON('/api/inventory/top-items'),
    fetchJSON('/api/inventory/monthly-breakdown' + fyQuery),
    fetchJSON('/api/inventory/production-receipts' + listQuery)
  ]);
  const s = summary[0] || {};
  document.getElementById('inv-skus').textContent = fmtNum(s.totalSkusInStock);
  document.getElementById('inv-qty').textContent = fmtNum(s.totalQtyOnHand);
  document.getElementById('inv-lowstock-count').textContent = fmtNum(lowStock.length);

  fillTable('table-low-stock', lowStock,
    r => `<tr><td>${r.itemName || r.itemCode}</td>${numTd(r.qtyOnHand)}${numTd(r.reorderLevel)}</tr>`, 3);

  fillTable('table-top-items', topItems,
    r => `<tr><td>${r.itemName || r.itemCode}</td>${numTd(r.qtyOnHand)}</tr>`, 2);

  const fyText = fyLabel(invSelectedFY);
  document.getElementById('inv-breakdown-title').textContent = `Monthly stock activity — Received → Issued → Produced — ${fyText}`;
  fillTable('table-inv-monthly-breakdown', monthly,
    r => `<tr><td>${r.period}</td>${numTd(r.receivedCount)}${numTd(r.issuedCount)}${numTd(r.producedCount)}</tr>`, 4);
  const fyReceived = monthly.reduce((sum, r) => sum + (Number(r.receivedCount) || 0), 0);
  const fyIssued = monthly.reduce((sum, r) => sum + (Number(r.issuedCount) || 0), 0);
  const fyProduced = monthly.reduce((sum, r) => sum + (Number(r.producedCount) || 0), 0);
  document.getElementById('inv-breakdown-summary').innerHTML =
    `FY total &middot; Received: <strong>${fmtNum(fyReceived)}</strong> &middot; Issued: <strong>${fmtNum(fyIssued)}</strong> &middot; Produced: <strong>${fmtNum(fyProduced)}</strong>`;

  document.getElementById('inv-receipts-filter-label').textContent = invViewMode === 'all' ? `All — ${fyText}` : 'Most recent 10';
  document.getElementById('inv-receipts-filter-all').hidden = invViewMode === 'all';
  document.getElementById('inv-receipts-filter-recent').hidden = invViewMode === 'recent';
  document.getElementById('inv-production-receipts-title').textContent = invViewMode === 'all' ? `All production receipts — ${fyText}` : 'Recent production receipts';

  fillTable('table-inv-production-receipts', productionReceipts,
    r => `<tr><td>${r.workOrderNo ?? ''}</td><td>${(r.itemCode || '').trim()}</td>${dateTd(r.receiptDate)}${numTd(r.receiptQty)}<td>${r.statusCode ?? ''}</td></tr>`, 5);
  tableSummary('inv-production-receipts-summary', productionReceipts, null, 'receipt', null);
}

let financeSelectedFY = currentFYStartYear();
let financeFYInitialized = false;
let financeSelectedMonth = null; // 'YYYY-MM', or null = show current outstanding (unfiltered)

function selectFinanceMonth(period) {
  financeSelectedMonth = period;
  refreshCurrent();
}

function clearFinanceMonth() {
  financeSelectedMonth = null;
  refreshCurrent();
}

// Debtors/Creditors have no "recent vs all" concept (always the complete
// outstanding list) — this mode only governs the purchase-bills list, and
// only when no month is selected (month selection, via financeSelectedMonth,
// already overrides it for all three tables).
let financeViewMode = 'recent'; // 'recent' (most recent 10, default) or 'all' (every bill in the selected FY)

function setFinanceViewMode(mode) {
  financeViewMode = mode;
  refreshCurrent();
}

function initFinanceFYSelect() {
  if (financeFYInitialized) return;
  financeFYInitialized = true;
  const select = document.getElementById('finance-fy-select');
  const current = currentFYStartYear();
  for (let y = current; y >= current - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = fyLabel(y);
    select.appendChild(opt);
  }
  select.value = financeSelectedFY;
  select.addEventListener('change', () => {
    financeSelectedFY = Number(select.value);
    refreshCurrent();
  });
}

// Shows "N <noun>(s) · <label>: <money>" above a table, e.g.
// "91 customers · Total outstanding: ₹3,02,37,479". Pass rows already
// scoped to whatever's currently displayed (a month filter, etc.) so the
// total tracks the table, not the unfiltered dataset.
function pluralize(noun) {
  return /[^aeiou]y$/i.test(noun) ? noun.slice(0, -1) + 'ies' : noun + 's';
}

function tableSummary(elId, rows, valueKey, noun, label) {
  const el = document.getElementById(elId);
  if (!el) return;
  const count = rows ? rows.length : 0;
  if (count === 0) {
    el.textContent = `No ${pluralize(noun)}`;
    return;
  }
  const countText = `${fmtNum(count)} ${count === 1 ? noun : pluralize(noun)}`;
  if (!valueKey) { // count-only: no clean monetary field to total (e.g. GRN)
    el.textContent = countText;
    return;
  }
  const total = rows.reduce((sum, r) => sum + (Number(r[valueKey]) || 0), 0);
  el.innerHTML = `${countText} &middot; ${label}: <strong>${fmtMoney(total)}</strong>`;
}

function partyAgingRow(r, nameKey) {
  const overdue = r.daysOverdue != null ? Number(r.daysOverdue) : null;
  const overdueDisplay = overdue == null ? '—' : (overdue <= 0 ? 'Not yet due' : `${fmtNum(overdue)} days`);
  const overdueSort = overdue == null ? -Infinity : overdue;
  return `<tr><td>${r[nameKey] ?? ''}</td>${moneyTd(r.outstandingAmount)}${dateTd(r.oldestDueDate)}${td(overdueDisplay, overdueSort, 'num')}${numTd(r.entryCount)}</tr>`;
}

async function loadFinance() {
  initFinanceFYSelect();
  const fyQuery = `?fy=${financeSelectedFY}`;
  const monthQuery = financeSelectedMonth ? `?month=${encodeURIComponent(financeSelectedMonth)}` : '';
  const billsQuery = financeSelectedMonth
    ? monthQuery
    : (financeViewMode === 'all' ? `?view=all&fy=${financeSelectedFY}` : '');
  const [summary, aging, monthly, debtors, creditors, purchaseBills] = await Promise.all([
    fetchJSON('/api/finance/summary'),
    fetchJSON('/api/finance/aging'),
    fetchJSON('/api/finance/monthly-breakdown' + fyQuery),
    fetchJSON('/api/finance/debtors' + monthQuery),
    fetchJSON('/api/finance/creditors' + monthQuery),
    fetchJSON('/api/finance/purchase-bills' + billsQuery)
  ]);
  const s = summary[0] || {};
  document.getElementById('fin-receivable').textContent = fmtMoney(s.totalReceivable);
  document.getElementById('fin-payable').textContent = fmtMoney(s.totalPayable);
  document.getElementById('fin-overdue').textContent = fmtMoney(s.overdueReceivable);

  barChart('chart-aging', aging.map(r => r.bucket.replace(/^\d\.\s*/, '')), aging.map(r => r.amount), 'Outstanding', '#A6423A');

  const fyText = fyLabel(financeSelectedFY);
  document.getElementById('finance-breakdown-title').innerHTML =
    `Monthly breakdown — amounts due — ${fyText} <span class="muted">(click a month row to filter the tables below)</span>`;
  fillTable('table-finance-monthly-breakdown', monthly,
    r => `<tr class="${r.period === financeSelectedMonth ? 'selected' : ''}" onclick="selectFinanceMonth('${r.period}')"><td>${r.period}</td>${moneyTd(r.receivableDue)}${numTd(r.receivableCount)}${moneyTd(r.payableDue)}${numTd(r.payableCount)}</tr>`, 5);
  const fyReceivableTotal = monthly.reduce((sum, r) => sum + (Number(r.receivableDue) || 0), 0);
  const fyPayableTotal = monthly.reduce((sum, r) => sum + (Number(r.payableDue) || 0), 0);
  document.getElementById('finance-breakdown-summary').innerHTML =
    `FY total &middot; Receivable due: <strong>${fmtMoney(fyReceivableTotal)}</strong> &middot; Payable due: <strong>${fmtMoney(fyPayableTotal)}</strong>`;

  const filterBar = document.getElementById('finance-month-filter-bar');
  filterBar.hidden = !financeSelectedMonth;
  const monthLabel = financeSelectedMonth ? crmMonthLabel(financeSelectedMonth) : '';
  document.getElementById('finance-month-filter-label').textContent = monthLabel;
  document.getElementById('finance-debtors-title').textContent = financeSelectedMonth
    ? `Debtors — receivable due in ${monthLabel}` : 'Debtors — outstanding receivable by customer';
  document.getElementById('finance-creditors-title').textContent = financeSelectedMonth
    ? `Creditors — payable due in ${monthLabel}` : 'Creditors — outstanding payable by vendor';
  const billsFilterBar = document.getElementById('finance-bills-filter-bar');
  billsFilterBar.hidden = !!financeSelectedMonth; // month selection already covers this via the shared bar above
  const billsIsCompleteSet = !!financeSelectedMonth || financeViewMode === 'all';
  const billsLabel = financeSelectedMonth ? monthLabel : (financeViewMode === 'all' ? `All — ${fyText}` : 'Most recent 10');
  document.getElementById('finance-bills-filter-label').textContent = billsLabel;
  document.getElementById('finance-bills-filter-all').hidden = financeViewMode === 'all';
  document.getElementById('finance-bills-filter-recent').hidden = financeViewMode === 'recent';
  document.getElementById('finance-purchase-bills-title').textContent = financeSelectedMonth
    ? `Purchase bills — ${monthLabel}` : (financeViewMode === 'all' ? `All purchase bills — ${fyText}` : 'Recent purchase bills (expenses)');

  fillTable('table-debtors', debtors, r => partyAgingRow(r, 'customerName'), 5);
  tableSummary('finance-debtors-summary', debtors, 'outstandingAmount', 'customer', 'Total outstanding');

  fillTable('table-creditors', creditors, r => partyAgingRow(r, 'vendorName'), 5);
  tableSummary('finance-creditors-summary', creditors, 'outstandingAmount', 'vendor', 'Total outstanding');

  fillTable('table-purchase-bills', purchaseBills,
    r => `<tr><td>${r.billNo ?? ''}</td><td>${r.vendorBillNo ?? '—'}</td><td>${r.vendorName || ''}</td>${dateTd(r.billDate)}${moneyTd(r.billAmount)}<td>${r.statusCode ?? ''}</td></tr>`, 6);
  tableSummary('finance-purchase-bills-summary', purchaseBills, 'billAmount', 'bill', billsIsCompleteSet ? 'Total' : 'Total (of rows shown)');
}

let prodSelectedFY = currentFYStartYear();
let prodFYInitialized = false;
let prodSelectedMonth = null; // 'YYYY-MM', or null = not filtered to a specific month
let prodViewMode = 'recent'; // 'recent' (most recent 10, default) or 'all' (every record in the selected FY) — governs all 4 tables together, overridden by prodSelectedMonth when set

function initProdFYSelect() {
  if (prodFYInitialized) return;
  prodFYInitialized = true;
  const select = document.getElementById('prod-fy-select');
  const current = currentFYStartYear();
  for (let y = current; y >= current - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = fyLabel(y);
    select.appendChild(opt);
  }
  select.value = prodSelectedFY;
  select.addEventListener('change', () => {
    prodSelectedFY = Number(select.value);
    refreshCurrent();
  });
}

function selectProdMonth(period) {
  prodSelectedMonth = period;
  refreshCurrent();
}

function setProdViewMode(mode) {
  prodViewMode = mode;
  prodSelectedMonth = null;
  refreshCurrent();
}

async function loadProduction() {
  initProdFYSelect();
  const listQuery = prodSelectedMonth
    ? `?month=${encodeURIComponent(prodSelectedMonth)}`
    : (prodViewMode === 'all' ? `?view=all&fy=${prodSelectedFY}` : '');
  const [summary, woStatus, sjoStatus, monthly, oafs, workOrders, materialIssued, readyWorkOrders] = await Promise.all([
    fetchJSON('/api/production/summary'),
    fetchJSON('/api/production/wo-status'),
    fetchJSON('/api/production/sjo-status'),
    fetchJSON('/api/production/monthly-breakdown?fy=' + prodSelectedFY),
    fetchJSON('/api/production/oafs' + listQuery),
    fetchJSON('/api/production/work-orders' + listQuery),
    fetchJSON('/api/production/material-issued' + listQuery),
    fetchJSON('/api/production/ready-work-orders' + listQuery)
  ]);
  const s = summary[0] || {};
  document.getElementById('prod-open').textContent = fmtNum(s.openWorkOrders);
  document.getElementById('prod-closed').textContent = fmtNum(s.closedThisMonth);
  document.getElementById('prod-overdue').textContent = fmtNum(s.overdueWorkOrders);

  barChart('chart-wo-status', woStatus.map(r => r.statusCode ?? '(blank)'), woStatus.map(r => r.count), 'Work Orders', '#3E6B94');
  barChart('chart-sjo-status', sjoStatus.map(r => r.statusCode ?? '(blank)'), sjoStatus.map(r => r.count), 'Shop Job Orders', '#3F7859');

  const fyText = fyLabel(prodSelectedFY);
  document.getElementById('prod-breakdown-title').innerHTML =
    `Monthly breakdown — OAF &rarr; Work Order &rarr; Material Issued &rarr; Ready — ${fyText} <span class="muted">(click a month row to filter the tables below)</span>`;
  fillTable('table-prod-monthly-breakdown', monthly,
    r => `<tr class="${r.period === prodSelectedMonth ? 'selected' : ''}" onclick="selectProdMonth('${r.period}')"><td>${r.period}</td>${numTd(r.oafCount)}${numTd(r.woCount)}${numTd(r.issueCount)}${numTd(r.readyCount)}</tr>`, 5);
  const fyOaf = monthly.reduce((sum, r) => sum + (Number(r.oafCount) || 0), 0);
  const fyWo = monthly.reduce((sum, r) => sum + (Number(r.woCount) || 0), 0);
  const fyIssue = monthly.reduce((sum, r) => sum + (Number(r.issueCount) || 0), 0);
  const fyReady = monthly.reduce((sum, r) => sum + (Number(r.readyCount) || 0), 0);
  document.getElementById('prod-breakdown-summary').innerHTML =
    `FY total &middot; OAFs: <strong>${fmtNum(fyOaf)}</strong> &middot; Work Orders: <strong>${fmtNum(fyWo)}</strong> &middot; Material Issued: <strong>${fmtNum(fyIssue)}</strong> &middot; Ready: <strong>${fmtNum(fyReady)}</strong>`;

  const label = prodSelectedMonth ? crmMonthLabel(prodSelectedMonth) : (prodViewMode === 'all' ? `All — ${fyText}` : 'Most recent 10');
  document.getElementById('prod-month-filter-label').textContent = label;
  document.getElementById('prod-filter-all').hidden = !prodSelectedMonth && prodViewMode === 'all';
  document.getElementById('prod-filter-recent').hidden = !prodSelectedMonth && prodViewMode === 'recent';
  document.getElementById('prod-oafs-title').textContent = prodSelectedMonth
    ? `OAFs — ${label}` : (prodViewMode === 'all' ? `All OAFs — ${fyText}` : 'Recent Order Acceptance Forms (OAF)');
  document.getElementById('prod-work-orders-title').textContent = prodSelectedMonth
    ? `Work Orders — ${label}` : (prodViewMode === 'all' ? `All Work Orders — ${fyText}` : 'Recent Work Orders');
  document.getElementById('prod-material-issued-title').textContent = prodSelectedMonth
    ? `Material issued — ${label}` : (prodViewMode === 'all' ? `All material issued — ${fyText}` : 'Recent material issued');
  document.getElementById('prod-ready-title').textContent = prodSelectedMonth
    ? `Ready — ${label}` : (prodViewMode === 'all' ? `All ready — ${fyText}` : 'Ready (fully received work orders)');

  fillTable('table-prod-oafs', oafs,
    r => `<tr><td>${r.oafNo ?? ''}</td>${dateTd(r.oafDate)}<td>${r.syncaxisOrderNo ?? ''}</td><td>${r.customerName || ''}</td></tr>`, 4);
  tableSummary('prod-oafs-summary', oafs, null, 'OAF', null);

  fillTable('table-prod-work-orders', workOrders,
    r => `<tr><td>${r.woNo ?? ''}</td><td>${(r.itemCode || '').trim()}</td>${dateTd(r.orderDate)}${dateTd(r.dueDate)}${numTd(r.orderedQty)}${numTd(r.receivedQty)}<td>${r.statusCode ?? ''}</td></tr>`, 7);
  tableSummary('prod-work-orders-summary', workOrders, null, 'work order', null);

  fillTable('table-prod-material-issued', materialIssued,
    r => `<tr><td>${r.issueNo ?? ''}</td>${dateTd(r.issueDate)}<td>${r.sjoNo ?? ''}</td><td>${r.statusCode ?? ''}</td></tr>`, 4);
  tableSummary('prod-material-issued-summary', materialIssued, null, 'issue', null);

  fillTable('table-prod-ready', readyWorkOrders,
    r => `<tr><td>${r.woNo ?? ''}</td><td>${(r.itemCode || '').trim()}</td>${numTd(r.orderedQty)}${numTd(r.receivedQty)}${dateTd(r.readyDate)}</tr>`, 5);
  tableSummary('prod-ready-summary', readyWorkOrders, null, 'work order', null);
}

const loaders = {
  crm: loadCRM,
  lineage: loadLineage,
  sales: loadSales,
  purchase: loadPurchase,
  inventory: loadInventory,
  finance: loadFinance,
  production: loadProduction
};

const titles = {
  crm: 'CRM Pipeline — Enquiry to Order',
  lineage: 'Order Lineage — Enquiry to Despatch',
  sales: 'Sales & Revenue',
  purchase: 'Purchase & Vendors',
  inventory: 'Inventory & Stock',
  finance: 'Finance (AR / AP)',
  production: 'Production & Work Orders'
};

let currentModule = 'crm';

async function activateModule(mod) {
  currentModule = mod;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.module === mod));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${mod}`));
  document.getElementById('pageTitle').textContent = titles[mod];
  await refreshCurrent();
}

async function refreshCurrent() {
  document.getElementById('lastUpdated').textContent = 'Loading…';
  try {
    await loaders[currentModule]();
    document.getElementById('lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    document.getElementById('lastUpdated').textContent = 'Failed to load — see console';
    console.error(err);
  }
}

async function loadSessionInfo() {
  try {
    const session = await fetchJSON('/api/session');
    const name = session.username || '';
    document.getElementById('userAvatar').textContent = name ? name.charAt(0) : '?';
    document.getElementById('userName').textContent = name || 'Signed in';
    document.getElementById('userName').title = name;
  } catch (err) {
    // fetchJSON already redirects to login on a 401; nothing else to do here
  }
}

async function checkHealth() {
  const dot = document.getElementById('dbStatusDot');
  const text = document.getElementById('dbStatusText');
  try {
    const health = await fetchJSON('/api/health');
    dot.className = 'status-dot ok';
    text.textContent = `Connected — ${health.database}`;
  } catch (err) {
    dot.className = 'status-dot error';
    text.textContent = 'DB connection failed';
  }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => activateModule(btn.dataset.module));
});
document.getElementById('refreshBtn').addEventListener('click', refreshCurrent);
document.getElementById('logoutBtn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Signing out…';
  // Always land on the login page, even if /api/logout is slow or fails —
  // a destroyed-or-not session either way means the next page load bounces
  // through the auth gate correctly.
  const goToLogin = () => { location.href = '/login.html'; };
  const fallback = setTimeout(goToLogin, 1500);
  fetch('/api/logout', { method: 'POST' }).finally(() => {
    clearTimeout(fallback);
    goToLogin();
  });
});

// If this page is ever restored from the browser's back-forward cache
// (e.g. pressing Back right after signing out), force a real reload so the
// server's auth check runs again instead of showing the stale cached DOM.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});
document.getElementById('crm-filter-all').addEventListener('click', () => setCrmViewMode('all'));
document.getElementById('crm-filter-recent').addEventListener('click', () => setCrmViewMode('recent'));
document.getElementById('lineage-search-btn').addEventListener('click', lineageSearchSubmit);
document.getElementById('lineage-filter-all').addEventListener('click', () => setLineageViewMode('all'));
document.getElementById('lineage-clear-btn').addEventListener('click', lineageClearSearch);
document.getElementById('lineage-month-filter-clear').addEventListener('click', clearLineageMonth);
document.getElementById('finance-month-filter-clear').addEventListener('click', clearFinanceMonth);
document.getElementById('finance-bills-filter-all').addEventListener('click', () => setFinanceViewMode('all'));
document.getElementById('finance-bills-filter-recent').addEventListener('click', () => setFinanceViewMode('recent'));
document.getElementById('purchase-filter-all').addEventListener('click', () => setPurchaseViewMode('all'));
document.getElementById('purchase-filter-recent').addEventListener('click', () => setPurchaseViewMode('recent'));
document.getElementById('prod-filter-all').addEventListener('click', () => setProdViewMode('all'));
document.getElementById('prod-filter-recent').addEventListener('click', () => setProdViewMode('recent'));
document.getElementById('inv-receipts-filter-all').addEventListener('click', () => setInvViewMode('all'));
document.getElementById('inv-receipts-filter-recent').addEventListener('click', () => setInvViewMode('recent'));
document.getElementById('sales-filter-all').addEventListener('click', () => setSalesViewMode('all'));
document.getElementById('sales-filter-recent').addEventListener('click', () => setSalesViewMode('recent'));
document.getElementById('lineage-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lineageSearchSubmit();
});

// Monthly breakdown tables always have exactly 12 rows (Apr-Mar, one full
// FY) and are meant to be scanned as a whole calendar year at a glance, so
// they're exempt from pagination — sorting still applies, but no
// Prev/Next/rows-per-page control that would hide 2 of the 12 rows behind
// the default page size.
const NO_PAGINATION_TABLES = new Set([
  'table-crm-monthly-breakdown',
  'table-lineage-monthly-breakdown',
  'table-sales-monthly-breakdown',
  'table-purchase-monthly-breakdown',
  'table-inv-monthly-breakdown',
  'table-finance-monthly-breakdown',
  'table-prod-monthly-breakdown'
]);

document.querySelectorAll('.data-table').forEach(t => {
  initSortableTable(t);
  if (!NO_PAGINATION_TABLES.has(t.id)) initTablePagination(t);
});

checkHealth();
loadSessionInfo();
activateModule('crm');
