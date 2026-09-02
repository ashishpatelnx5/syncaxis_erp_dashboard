const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-IN');

const charts = {}; // keep Chart.js instances so we can destroy/recreate on refresh

function fmtMoney(v) { return money.format(Number(v) || 0); }
function fmtNum(v) { return num.format(Number(v) || 0); }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function fillTable(tableId, rows, renderRow, colSpan) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colSpan}">No data returned</td></tr>`;
    return;
  }
  rows.forEach(r => { tbody.insertAdjacentHTML('beforeend', renderRow(r)); });
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

let crmSelectedMonth = null; // 'YYYY-MM', or null = show most-recent-15 (default)

function crmMonthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function selectCrmMonth(period) {
  crmSelectedMonth = period;
  refreshCurrent();
}

function clearCrmMonth() {
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
  const monthQuery = crmSelectedMonth ? `?month=${encodeURIComponent(crmSelectedMonth)}` : '';
  const fyQuery = `?fy=${crmSelectedFY}`;
  const [summary, funnel, monthly, enquiries, quotations, orders, invoices, followups] = await Promise.all([
    fetchJSON('/api/crm/summary' + fyQuery),
    fetchJSON('/api/crm/pipeline-funnel' + fyQuery),
    fetchJSON('/api/crm/monthly-breakdown' + fyQuery),
    fetchJSON('/api/crm/recent-enquiries' + monthQuery),
    fetchJSON('/api/crm/recent-quotations' + monthQuery),
    fetchJSON('/api/crm/recent-orders' + monthQuery),
    fetchJSON('/api/crm/recent-invoices' + monthQuery),
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
    r => `<tr class="${r.period === crmSelectedMonth ? 'selected' : ''}" onclick="selectCrmMonth('${r.period}')"><td>${r.period}</td><td>${fmtNum(r.enquiryCount)}</td><td>${fmtNum(r.quotationCount)}</td><td class="num">${fmtMoney(r.quotationValue)}</td><td>${fmtNum(r.orderCount)}</td><td class="num">${fmtMoney(r.orderValue)}</td><td>${fmtNum(r.invoiceCount)}</td><td class="num">${fmtMoney(r.invoiceValue)}</td><td>${fmtNum(r.followUpCount)}</td></tr>`, 9);

  const filterBar = document.getElementById('crm-filter-bar');
  filterBar.hidden = !crmSelectedMonth;
  const label = crmSelectedMonth ? crmMonthLabel(crmSelectedMonth) : '';
  document.getElementById('crm-filter-label').textContent = label;
  document.getElementById('crm-enquiries-title').textContent = crmSelectedMonth ? `Enquiries — ${label}` : 'Recent enquiries';
  document.getElementById('crm-quotations-title').textContent = crmSelectedMonth ? `Quotations — ${label}` : 'Recent quotations';
  document.getElementById('crm-orders-title').textContent = crmSelectedMonth ? `Sales orders — ${label}` : 'Recent sales orders';
  document.getElementById('crm-invoices-title').textContent = crmSelectedMonth ? `Invoices — ${label}` : 'Recent invoices';

  fillTable('table-crm-enquiries', enquiries,
    r => `<tr><td>${r.enquiryNo ?? ''}</td><td>${r.customerName || ''}</td><td>${r.enquiryDate ? new Date(r.enquiryDate).toLocaleDateString() : ''}</td><td>${r.statusLabel ?? r.statusCode ?? ''}</td><td>${r.quotationNo ?? '—'}</td><td>${r.nextFollowUp ? new Date(r.nextFollowUp).toLocaleDateString() : '—'}</td></tr>`, 6);

  fillTable('table-crm-quotations', quotations,
    r => `<tr><td>${r.quotationNo ?? ''}</td><td>${r.customerName || ''}</td><td class="num">${fmtMoney(r.quotationValue)}</td><td>${r.statusLabel ?? r.statusCode ?? ''}</td><td>${r.syncaxisOrderNo ?? '—'}</td></tr>`, 5);

  fillTable('table-crm-orders', orders,
    r => `<tr><td>${r.syncaxisOrderNo ?? ''}</td><td>${r.customerRefNo ?? ''}</td><td>${r.customerName || ''}</td><td class="num">${fmtMoney(r.orderValue)}</td><td>${r.statusLabel ?? r.statusCode ?? ''}</td><td>${r.invoiceCount ? fmtNum(r.invoiceCount) : 'No'}</td><td>${r.lastInvoiceNo ?? '—'}</td><td class="num">${r.invoicedAmount ? fmtMoney(r.invoicedAmount) : '—'}</td></tr>`, 8);

  fillTable('table-crm-invoices', invoices,
    r => `<tr><td>${r.invoiceNo ?? ''}</td><td>${r.customerName || ''}</td><td>${r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : ''}</td><td class="num">${fmtMoney(r.invoiceValue)}</td><td>${r.statusCode ?? ''}</td><td>${r.syncaxisOrderNo ?? '—'}</td></tr>`, 6);

  fillTable('table-crm-followups', followups,
    r => `<tr><td>${r.customerName ?? ''}</td><td>${r.basedOnLabel ?? r.basedOn ?? ''}</td><td>${r.nextFollowUpDate ? new Date(r.nextFollowUpDate).toLocaleDateString() : ''}</td><td>${r.salesperson ?? ''}</td><td>${r.remark ?? r.nextAgenda ?? ''}</td></tr>`, 5);
}

// ---------------- Order Lineage ----------------

function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : ''; }

let lineageSelectedFY = currentFYStartYear();
let lineageFYInitialized = false;
let lineageSelectedMonth = null; // 'YYYY-MM', or null = no month filter

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
  refreshCurrent();
}

async function loadLineage() {
  initLineageFYSelect();
  const fyText = fyLabel(lineageSelectedFY);

  const monthly = await fetchJSON('/api/lineage/monthly-breakdown?fy=' + lineageSelectedFY);
  document.getElementById('lineage-breakdown-title').innerHTML =
    `Monthly breakdown — ${fyText} <span class="muted">(click a month row to filter the order list below)</span>`;
  fillTable('table-lineage-monthly-breakdown', monthly,
    r => `<tr class="${r.period === lineageSelectedMonth ? 'selected' : ''}" onclick="selectLineageMonth('${r.period}')"><td>${r.period}</td><td>${fmtNum(r.orderCount)}</td><td class="num">${fmtMoney(r.orderValue)}</td></tr>`, 3);

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
  const url = '/api/lineage/orders' + (params.length ? '?' + params.join('&') : '');
  const orders = await fetchJSON(url);
  fillTable('table-lineage-orders', orders,
    r => `<tr onclick="viewLineage(${r.orderId})" data-order-id="${r.orderId}"><td>${r.syncaxisOrderNo ?? ''}</td><td>${r.customerRefNo ?? ''}</td><td>${r.customerName || ''}</td><td>${fmtDate(r.orderDate)}</td><td class="num">${fmtMoney(r.orderValue)}</td><td>${r.statusCode ?? ''}</td></tr>`, 6);
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

function lineageSubList(rowsHtml) {
  if (!rowsHtml.length) return '';
  return `<div class="lineage-sublist"><table><tbody>${rowsHtml.join('')}</tbody></table></div>`;
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
     <div class="lineage-fact-row"><span class="muted">Customer</span>${h.customerName || ''} <span class="muted">Salesperson</span>${h.salesperson || '—'}</div>`);

  html += lineageStage('Order Acceptance Form (OAF)', null, h.oafId ? 'done' : 'empty',
    h.oafId
      ? `<div class="lineage-fact-row"><span class="muted">No.</span>${h.oafNo} <span class="muted">Date</span>${fmtDate(h.oafDate)}</div>`
      : `<div class="lineage-empty-note">No OAF on record.</div>`);

  html += lineageStage('Manufacturing (Shop Job Orders)', sjos.length || null,
    sjos.length ? (sjos.every(s => s.statusCode === 'F') ? 'done' : 'partial') : 'empty',
    sjos.length
      ? lineageSubList(sjos.map(s => `<tr><td>${s.sjoNo}</td><td>${(s.itemCode || '').trim()}</td><td>${fmtNum(s.orderedQty)}</td><td>${s.statusCode ?? ''}</td></tr>`))
      : `<div class="lineage-empty-note">No manufacturing job triggered for this order.</div>`);

  html += lineageStage('Work Order &amp; Production Receipt', prod.length || null,
    prod.length ? (prod.every(p => p.statusCode === 'C') ? 'done' : 'partial') : 'empty',
    prod.length
      ? lineageSubList(prod.map(p => `<tr><td>${p.workOrderNo ?? ''}</td><td>${(p.itemCode || '').trim()}</td><td>${fmtNum(p.receivedQty)} / ${fmtNum(p.orderedQty)}</td><td>${p.statusCode ?? ''}</td></tr>`))
      : `<div class="lineage-empty-note">No production receipt recorded yet.</div>`);

  html += lineageStage('Store — Material Issued', issues.length || null, issues.length ? 'done' : 'empty',
    issues.length
      ? lineageSubList(issues.map(i => `<tr><td>${i.issueNo}</td><td>${fmtDate(i.issueDate)}</td><td>${i.sjoNo ?? ''}</td></tr>`))
      : `<div class="lineage-empty-note">No material issued from store yet.</div>`);

  html += lineageStage('Despatch', challans.length || null, challans.length ? 'done' : (invoices.length ? 'partial' : 'empty'),
    challans.length
      ? lineageSubList(challans.map(c => `<tr><td>${c.challanNo}</td><td>${fmtDate(c.challanDate)}</td><td>${c.statusCode ?? ''}</td></tr>`))
      : (invoices.length
          ? `<div class="lineage-empty-note">No separate delivery challan — despatched together with the invoice below.</div>`
          : `<div class="lineage-empty-note">Not yet despatched.</div>`));

  html += lineageStage('Invoice', invoices.length || null, invoices.length ? 'done' : 'empty',
    invoices.length
      ? lineageSubList(invoices.map(i => `<tr><td>${i.invoiceNo}</td><td>${fmtDate(i.invoiceDate)}</td><td class="num">${fmtMoney(i.invoiceValue)}</td><td>${i.statusCode ?? ''}</td></tr>`))
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

async function loadSales() {
  const [summary, trend, topCustomers] = await Promise.all([
    fetchJSON('/api/sales/summary'),
    fetchJSON('/api/sales/trend'),
    fetchJSON('/api/sales/top-customers')
  ]);
  const s = summary[0] || {};
  document.getElementById('sales-revenue').textContent = fmtMoney(s.totalRevenue);
  document.getElementById('sales-invoices').textContent = fmtNum(s.invoiceCount);
  document.getElementById('sales-avg').textContent = fmtMoney(s.avgInvoiceValue);

  lineChart('chart-sales-trend', trend.map(r => r.period), trend.map(r => r.revenue), 'Revenue', '#3E6B94');

  fillTable('table-top-customers', topCustomers,
    r => `<tr><td>${r.customerName}</td><td class="num">${fmtMoney(r.totalRevenue)}</td><td>${fmtNum(r.invoiceCount)}</td></tr>`, 3);
}

async function loadPurchase() {
  const [summary, trend, topVendors] = await Promise.all([
    fetchJSON('/api/purchase/summary'),
    fetchJSON('/api/purchase/trend'),
    fetchJSON('/api/purchase/top-vendors')
  ]);
  const s = summary[0] || {};
  document.getElementById('purchase-spend').textContent = fmtMoney(s.totalSpend);
  document.getElementById('purchase-bills').textContent = fmtNum(s.billCount);
  document.getElementById('purchase-avg').textContent = fmtMoney(s.avgBillValue);

  lineChart('chart-purchase-trend', trend.map(r => r.period), trend.map(r => r.spend), 'Spend', '#B8862F');

  fillTable('table-top-vendors', topVendors,
    r => `<tr><td>${r.vendorName}</td><td class="num">${fmtMoney(r.totalSpend)}</td><td>${fmtNum(r.billCount)}</td></tr>`, 3);
}

async function loadInventory() {
  const [summary, lowStock, topItems] = await Promise.all([
    fetchJSON('/api/inventory/summary'),
    fetchJSON('/api/inventory/low-stock'),
    fetchJSON('/api/inventory/top-items')
  ]);
  const s = summary[0] || {};
  document.getElementById('inv-skus').textContent = fmtNum(s.totalSkusInStock);
  document.getElementById('inv-qty').textContent = fmtNum(s.totalQtyOnHand);
  document.getElementById('inv-lowstock-count').textContent = fmtNum(lowStock.length);

  fillTable('table-low-stock', lowStock,
    r => `<tr><td>${r.itemName || r.itemCode}</td><td>${fmtNum(r.qtyOnHand)}</td><td>${fmtNum(r.reorderLevel)}</td></tr>`, 3);

  fillTable('table-top-items', topItems,
    r => `<tr><td>${r.itemName || r.itemCode}</td><td>${fmtNum(r.qtyOnHand)}</td></tr>`, 2);
}

async function loadFinance() {
  const [summary, aging] = await Promise.all([
    fetchJSON('/api/finance/summary'),
    fetchJSON('/api/finance/aging')
  ]);
  const s = summary[0] || {};
  document.getElementById('fin-receivable').textContent = fmtMoney(s.totalReceivable);
  document.getElementById('fin-payable').textContent = fmtMoney(s.totalPayable);
  document.getElementById('fin-overdue').textContent = fmtMoney(s.overdueReceivable);

  barChart('chart-aging', aging.map(r => r.bucket.replace(/^\d\.\s*/, '')), aging.map(r => r.amount), 'Outstanding', '#A6423A');
}

async function loadProduction() {
  const [summary, woStatus, sjoStatus] = await Promise.all([
    fetchJSON('/api/production/summary'),
    fetchJSON('/api/production/wo-status'),
    fetchJSON('/api/production/sjo-status')
  ]);
  const s = summary[0] || {};
  document.getElementById('prod-open').textContent = fmtNum(s.openWorkOrders);
  document.getElementById('prod-closed').textContent = fmtNum(s.closedThisMonth);
  document.getElementById('prod-overdue').textContent = fmtNum(s.overdueWorkOrders);

  barChart('chart-wo-status', woStatus.map(r => r.statusCode ?? '(blank)'), woStatus.map(r => r.count), 'Work Orders', '#3E6B94');
  barChart('chart-sjo-status', sjoStatus.map(r => r.statusCode ?? '(blank)'), sjoStatus.map(r => r.count), 'Shop Job Orders', '#3F7859');
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
document.getElementById('crm-filter-clear').addEventListener('click', clearCrmMonth);
document.getElementById('lineage-search-btn').addEventListener('click', lineageSearchSubmit);
document.getElementById('lineage-clear-btn').addEventListener('click', lineageClearSearch);
document.getElementById('lineage-month-filter-clear').addEventListener('click', clearLineageMonth);
document.getElementById('lineage-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lineageSearchSubmit();
});

checkHealth();
activateModule('crm');
