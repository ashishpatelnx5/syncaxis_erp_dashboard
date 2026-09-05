require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { getPool } = require('./db');
const queries = require('./queries');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Every response is behind a login, so none of it should ever be cached or
// restored from the browser's back-forward cache — otherwise pressing Back
// after signing out can show a stale copy of the dashboard without the
// browser re-checking the server (looks like "sign out didn't work").
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // internal LAN over plain HTTP, not HTTPS — see DEPLOYMENT.md
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

// Single shared login (AUTH_USERNAME/AUTH_PASSWORD in .env) — no per-user
// accounts. Everything except the login page itself and the assets it needs
// requires an authenticated session; API requests get a 401 instead of a
// redirect so the frontend can react without a full page reload.
const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/syncaxis-logo.png', '/favicon.png', '/style.css']);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || (req.session && req.session.authenticated)) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === process.env.AUTH_USERNAME && password === process.env.AUTH_PASSWORD) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

// Who's logged in — covered by the auth gate above like any other /api/
// route, so this only ever responds once a session already exists.
app.get('/api/session', (req, res) => {
  res.json({ username: req.session.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

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

// Resolves the date range for a "recent-*" list route: an explicit month
// (clicking a row in a monthly breakdown table) takes priority; otherwise
// ?view=all scopes to the whole selected FY; otherwise (default) unfiltered
// "most recent N" with no date range at all.
function recentListRange(req) {
  const month = parseMonthRange(req.query.month);
  if (month) return { filtered: true, params: { start: month.start, end: month.end } };
  if (req.query.view === 'all') {
    const fy = parseFYRange(req.query.fy);
    return { filtered: true, params: { start: fy.start, end: fy.end } };
  }
  return { filtered: false, params: null };
}

// ---------- Sales ----------
app.get('/api/sales/summary', (req, res) => runQuery(res, queries.sales.summary));
app.get('/api/sales/trend', (req, res) => runQuery(res, queries.sales.trend));
app.get('/api/sales/top-customers', (req, res) => runQuery(res, queries.sales.topCustomers));
app.get('/api/sales/monthly-breakdown', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.sales.monthlyBreakdown, { start: fy.start, end: fy.end });
});
// Reuses queries.crm.recentInvoices (same underlying XDCINVHDR data CRM
// Pipeline's invoice stage already reads) — kept in one place so both
// panels stay consistent, same pattern as queries.purchase.bills.
app.get('/api/sales/invoices', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.crm.recentInvoices(filtered), params);
});

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
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.crm.recentEnquiries(filtered), params);
});
app.get('/api/crm/recent-quotations', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.crm.recentQuotations(filtered), params);
});
app.get('/api/crm/recent-orders', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.crm.recentOrders(filtered), params);
});
app.get('/api/crm/recent-invoices', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.crm.recentInvoices(filtered), params);
});
app.get('/api/crm/pending-followups', (req, res) => runQuery(res, queries.crm.pendingFollowups));

// ---------- Order Lineage (end-to-end genealogy for one sales order) ----------
app.get('/api/lineage/orders', (req, res) => {
  const search = (req.query.search || '').trim() || null;
  const month = parseMonthRange(req.query.month);
  // orderList's SQL only cares whether a date range applies at all — a
  // specific month and "the whole selected FY" (view=all) bind the exact
  // same WHERE clause, just with different @start/@end values.
  const fy = (!search && !month && req.query.view === 'all') ? parseFYRange(req.query.fy) : null;
  const dateRange = month || fy;
  runQuery(res, queries.lineage.orderList(!!search, !!dateRange), {
    ...(search && { search }),
    ...(dateRange && { start: dateRange.start, end: dateRange.end })
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
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.purchase.bills(filtered), params);
});
app.get('/api/purchase/orders', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.purchase.orders(filtered), params);
});
app.get('/api/purchase/material-received', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.purchase.materialReceived(filtered), params);
});

// ---------- Inventory ----------
app.get('/api/inventory/summary', (req, res) => runQuery(res, queries.inventory.summary));
app.get('/api/inventory/low-stock', (req, res) => runQuery(res, queries.inventory.lowStock));
app.get('/api/inventory/top-items', (req, res) => runQuery(res, queries.inventory.topItemsByStock));
app.get('/api/inventory/monthly-breakdown', (req, res) => {
  const fy = parseFYRange(req.query.fy);
  runQuery(res, queries.inventory.monthlyBreakdown, { start: fy.start, end: fy.end });
});
app.get('/api/inventory/production-receipts', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.inventory.productionReceipts(filtered), params);
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
  runQuery(res, queries.finance.debtors(!!range, req.query.view === 'all'), range && { start: range.start, end: range.end });
});
app.get('/api/finance/creditors', (req, res) => {
  const range = parseMonthRange(req.query.month);
  runQuery(res, queries.finance.creditors(!!range, req.query.view === 'all'), range && { start: range.start, end: range.end });
});
// fy=all (or omitted) means "this party's entire history, no year filter" —
// the default, so an old customer/vendor doesn't look broken just because
// the current FY happens to have nothing for them. Pass a specific year to
// narrow it down.
app.get('/api/finance/debtors/:code/orders-invoices', (req, res) => {
  const filtered = /^\d{4}$/.test(req.query.fy || '');
  const params = { accountCode: req.params.code };
  if (filtered) {
    const fy = parseFYRange(req.query.fy);
    params.start = fy.start;
    params.end = fy.end;
  }
  runQuery(res, queries.finance.customerOrdersAndInvoices(filtered), params);
});
app.get('/api/finance/creditors/:code/orders-bills', (req, res) => {
  const filtered = /^\d{4}$/.test(req.query.fy || '');
  const params = { accountCode: req.params.code };
  if (filtered) {
    const fy = parseFYRange(req.query.fy);
    params.start = fy.start;
    params.end = fy.end;
  }
  runQuery(res, queries.finance.vendorOrdersAndBills(filtered), params);
});
app.get('/api/finance/purchase-bills', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.purchase.bills(filtered), params);
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
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.production.oafs(filtered), params);
});
app.get('/api/production/work-orders', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.production.workOrders(filtered), params);
});
app.get('/api/production/material-issued', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.production.materialIssued(filtered), params);
});
app.get('/api/production/ready-work-orders', (req, res) => {
  const { filtered, params } = recentListRange(req);
  runQuery(res, queries.production.readyWorkOrders(filtered), params);
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
