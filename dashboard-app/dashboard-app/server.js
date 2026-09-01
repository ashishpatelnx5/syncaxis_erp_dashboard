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

// ---------- Purchase ----------
app.get('/api/purchase/summary', (req, res) => runQuery(res, queries.purchase.summary));
app.get('/api/purchase/trend', (req, res) => runQuery(res, queries.purchase.trend));
app.get('/api/purchase/top-vendors', (req, res) => runQuery(res, queries.purchase.topVendors));

// ---------- Inventory ----------
app.get('/api/inventory/summary', (req, res) => runQuery(res, queries.inventory.summary));
app.get('/api/inventory/low-stock', (req, res) => runQuery(res, queries.inventory.lowStock));
app.get('/api/inventory/top-items', (req, res) => runQuery(res, queries.inventory.topItemsByStock));

// ---------- Finance ----------
app.get('/api/finance/summary', (req, res) => runQuery(res, queries.finance.summary));
app.get('/api/finance/aging', (req, res) => runQuery(res, queries.finance.aging));

// ---------- Production ----------
app.get('/api/production/summary', (req, res) => runQuery(res, queries.production.summary));
app.get('/api/production/wo-status', (req, res) => runQuery(res, queries.production.statusBreakdown));
app.get('/api/production/sjo-status', (req, res) => runQuery(res, queries.production.sjoStatus));

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
