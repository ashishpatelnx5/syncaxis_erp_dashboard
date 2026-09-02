require('dotenv').config();
const express = require('express');
const path = require('path');
const { getPool } = require('./db');
const queries = require('./queries');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Generic helper: run a query and return JSON, with consistent error handling.
// `params` (optional) is an object of { name: value } bound with .input() —
// always use this instead of string-concatenating values into sqlText.
async function runQuery(res, sqlText, params) {
  try {
    const pool = await getPool();
    const request = pool.request();
    if (params) {
      for (const [name, value] of Object.entries(params)) request.input(name, value);
    }
    const result = await request.query(sqlText);
    res.json(result.recordset);
  } catch (err) {
    console.error('Query failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// Parses a "YYYY-MM" query param into a [start, end) date range for safe,
// parameterized month filtering. Returns null if missing/malformed (caller
// then falls back to the unfiltered "most recent" query).
function parseMonthRange(monthStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr || '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  if (month < 1 || month > 12) return null;
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1))
  };
}

// Indian financial year: 1 April of `startYear` -> 31 March of startYear+1.
// `?fy=2026` means FY 2026-27. Falls back to the FY containing today's date
// if missing/malformed.
function currentFYStartYear() {
  const now = new Date();
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // Apr = month index 3
}

function parseFYRange(fyStr) {
  const startYear = /^\d{4}$/.test(fyStr || '') ? Number(fyStr) : currentFYStartYear();
  return {
    startYear,
    start: new Date(Date.UTC(startYear, 3, 1)),
    end: new Date(Date.UTC(startYear + 1, 3, 1))
  };
}

// ---------- Sales ----------
app.get('/api/sales/summary', (req, res) => runQuery(res, queries.sales.summary));
app.get('/api/sales/trend', (req, res) => runQuery(res, queries.sales.trend));
app.get('/api/sales/top-customers', (req, res) => runQuery(res, queries.sales.topCustomers));

// ---------- CRM (Enquiry / Quotation / Sales Order / Follow-up) ----------
app.get('/api/crm/summary', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.crm.summary, { start: fy.start, end: fy.end });
});
app.get('/api/crm/pipeline-funnel', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.crm.pipelineFunnel, { start: fy.start, end: fy.end });
});
app.get('/api/crm/monthly-breakdown', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.crm.monthlyBreakdown, { start: fy.start, end: fy.end });
});
app.get('/api/crm/recent-enquiries', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.crm.recentEnquiries(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/crm/recent-quotations', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.crm.recentQuotations(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/crm/recent-orders', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.crm.recentOrders(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/crm/recent-invoices', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.crm.recentInvoices(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/crm/pending-followups', (req, res) => runQuery(res, queries.crm.pendingFollowups));

// ---------- Order Lineage (end-to-end genealogy for one sales order) ----------
app.get('/api/lineage/orders', (req, res) => {
  const search = (req.query.search || '').trim() || null;
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.lineage.orderList(!!search, !!range), {
    ...(search && { search }),
    ...(range && { start: range.start, end: range.end })
  });
});
app.get('/api/lineage/monthly-breakdown', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.lineage.monthlyBreakdown, { start: fy.start, end: fy.end });
});
app.get('/api/lineage/order/:id', async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'Invalid order id' });
  }
  try {
    const pool = await getPool();
    const run = (sqlText) => pool.request().input('orderId', orderId).query(sqlText);
    const [header, shopJobOrders, production, storeIssues, despatchChallans, invoices, customerAR] = await Promise.all([
      run(queries.lineage.header),
      run(queries.lineage.shopJobOrders),
      run(queries.lineage.production),
      run(queries.lineage.storeIssues),
      run(queries.lineage.despatchChallans),
      run(queries.lineage.invoices),
      run(queries.lineage.customerAR)
    ]);
    res.json({
      header: header.recordset[0] || null,
      shopJobOrders: shopJobOrders.recordset,
      production: production.recordset,
      storeIssues: storeIssues.recordset,
      despatchChallans: despatchChallans.recordset,
      invoices: invoices.recordset,
      customerAR: customerAR.recordset[0] || null
    });
  } catch (err) {
    console.error('Lineage query failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Purchase ----------
app.get('/api/purchase/summary', (req, res) => runQuery(res, queries.purchase.summary));
app.get('/api/purchase/trend', (req, res) => runQuery(res, queries.purchase.trend));
app.get('/api/purchase/top-vendors', (req, res) => runQuery(res, queries.purchase.topVendors));
app.get('/api/purchase/monthly-breakdown', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.purchase.monthlyBreakdown, { start: fy.start, end: fy.end });
});
app.get('/api/purchase/bills', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.purchase.bills(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/purchase/orders', (req, res) => runQuery(res, queries.purchase.orders));
app.get('/api/purchase/material-received', (req, res) => runQuery(res, queries.purchase.materialReceived));

// ---------- Inventory ----------
app.get('/api/inventory/summary', (req, res) => runQuery(res, queries.inventory.summary));
app.get('/api/inventory/low-stock', (req, res) => runQuery(res, queries.inventory.lowStock));
app.get('/api/inventory/top-items', (req, res) => runQuery(res, queries.inventory.topItemsByStock));
app.get('/api/inventory/monthly-breakdown', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.inventory.monthlyBreakdown, { start: fy.start, end: fy.end });
});
app.get('/api/inventory/production-receipts', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.inventory.productionReceipts(!!range), range && { start: range.start, end: range.end });
});

// ---------- Finance ----------
app.get('/api/finance/summary', (req, res) => runQuery(res, queries.finance.summary));
app.get('/api/finance/aging', (req, res) => runQuery(res, queries.finance.aging));
app.get('/api/finance/monthly-breakdown', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.finance.monthlyBreakdown, { start: fy.start, end: fy.end });
});
app.get('/api/finance/debtors', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.finance.debtors(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/finance/creditors', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.finance.creditors(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/finance/purchase-bills', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.purchase.bills(!!range), range && { start: range.start, end: range.end });
});

// ---------- Production ----------
app.get('/api/production/summary', (req, res) => runQuery(res, queries.production.summary));
app.get('/api/production/wo-status', (req, res) => runQuery(res, queries.production.statusBreakdown));
app.get('/api/production/sjo-status', (req, res) => runQuery(res, queries.production.sjoStatus));
app.get('/api/production/monthly-breakdown', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.production.monthlyBreakdown, { start: fy.start, end: fy.end });
});
app.get('/api/production/oafs', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.production.oafs(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/production/work-orders', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.production.workOrders(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/production/material-issued', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.production.materialIssued(!!range), range && { start: range.start, end: range.end });
});
app.get('/api/production/ready-work-orders', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.production.readyWorkOrders(!!range), range && { start: range.start, end: range.end });
});

// Health check — quick way to confirm the DB connection works at all
app.get('/api/health', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS ok');
    res.json({ status: 'ok', database: process.env.DB_DATABASE });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SYNCAXIS Dashboard running at http://localhost:${PORT}`);
});
