/**
 * All SQL lives here, grouped by dashboard module, so you can tune business
 * logic (status codes, filters) in one place without touching server.js.
 *
 * IMPORTANT — please read before trusting the numbers:
 * Several tables use short status/type codes (e.g. XIHDOCTYP, XWOSTATUS,
 * XBHSTATUS, XSHSJOSTAT) whose *meaning* (which code = "Sales" vs "Purchase",
 * which code = "Open" vs "Closed") isn't visible from the schema alone —
 * it lives in your application's lookup/config tables or business logic.
 * Queries below are built on the safe assumptions documented inline; use
 * diagnostics.sql (in this folder) to check the actual code values in your
 * data and adjust the WHERE clauses marked "VERIFY" accordingly.
 */

const queries = {

  // ---------------- SALES & REVENUE ----------------
  // Reads from XDCINVHDR, not XINVHDR — XINVHDR is empty (0 rows) in this
  // database; XDCINVHDR is the actively-used invoice table (confirmed via
  // real GST e-invoice/IRN/e-way-bill fields and 352 real rows). Its only
  // doc type in this data is 'DI' (all customer-facing, XDIHCUSTVND='C'),
  // so no type filter is needed the way the old XIHDOCTYP note assumed.
  sales: {
    summary: `
      SELECT
        ISNULL(SUM(XDIHAMT), 0) AS totalRevenue,
        COUNT(*) AS invoiceCount,
        ISNULL(AVG(XDIHAMT), 0) AS avgInvoiceValue
      FROM XDCINVHDR
      WHERE MONTH(XDIHINVDT) = MONTH(GETDATE())
        AND YEAR(XDIHINVDT) = YEAR(GETDATE())
    `,
    trend: `
      SELECT
        FORMAT(XDIHINVDT, 'yyyy-MM') AS [period],
        SUM(XDIHAMT) AS revenue,
        COUNT(*) AS invoiceCount
      FROM XDCINVHDR
      WHERE XDIHINVDT >= DATEADD(MONTH, -12, GETDATE())
      GROUP BY FORMAT(XDIHINVDT, 'yyyy-MM')
      ORDER BY [period];
    `,
    topCustomers: `
      SELECT TOP 10
        c.MCMCUSTNM AS customerName,
        SUM(h.XDIHAMT) AS totalRevenue,
        COUNT(*) AS invoiceCount
      FROM XDCINVHDR h
      JOIN MCUSTMST c ON h.XDIHCUSTCD = c.MCMCUSTCD
      WHERE h.XDIHINVDT >= DATEADD(MONTH, -12, GETDATE())
      GROUP BY c.MCMCUSTNM
      ORDER BY totalRevenue DESC;
    `,
    // Indian FY-bound monthly breakdown, same always-12-rows shape as
    // crm.monthlyBreakdown (which also tracks invoices, but as one column
    // among enquiry/quotation/order counts inside the pipeline funnel — this
    // is the revenue-first view of the same underlying XDCINVHDR data).
    monthlyBreakdown: `
      WITH Months AS (
        SELECT TOP 12 FORMAT(DATEADD(MONTH, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @start), 'yyyy-MM') AS period
        FROM sys.all_objects
      ),
      Inv AS (
        SELECT FORMAT(XDIHINVDT, 'yyyy-MM') AS period, COUNT(*) AS invoiceCount, SUM(XDIHAMT) AS revenue
        FROM XDCINVHDR WHERE XDIHINVDT >= @start AND XDIHINVDT < @end
        GROUP BY FORMAT(XDIHINVDT, 'yyyy-MM')
      )
      SELECT m.period, ISNULL(i.invoiceCount, 0) AS invoiceCount, ISNULL(i.revenue, 0) AS revenue
      FROM Months m
      LEFT JOIN Inv i ON m.period = i.period
      ORDER BY m.period;
    `
  },

  // ---------------- PURCHASE & VENDOR SPEND ----------------
  purchase: {
    summary: `
      SELECT
        ISNULL(SUM(XBHACTBILLAMT), 0) AS totalSpend,
        COUNT(*) AS billCount,
        ISNULL(AVG(XBHACTBILLAMT), 0) AS avgBillValue
      FROM XPURBILLHDR
      WHERE MONTH(XBHDOCDT) = MONTH(GETDATE())
        AND YEAR(XBHDOCDT) = YEAR(GETDATE());
    `,
    trend: `
      SELECT
        FORMAT(XBHDOCDT, 'yyyy-MM') AS [period],
        SUM(XBHACTBILLAMT) AS spend,
        COUNT(*) AS billCount
      FROM XPURBILLHDR
      WHERE XBHDOCDT >= DATEADD(MONTH, -12, GETDATE())
      GROUP BY FORMAT(XBHDOCDT, 'yyyy-MM')
      ORDER BY [period];
    `,
    topVendors: `
      SELECT TOP 10
        v.MVmName AS vendorName,
        SUM(b.XBHACTBILLAMT) AS totalSpend,
        COUNT(*) AS billCount
      FROM XPURBILLHDR b
      JOIN MVNDMAST v ON b.XBHVNDCD = v.MVmVndCode
      WHERE b.XBHDOCDT >= DATEADD(MONTH, -12, GETDATE())
      GROUP BY v.MVmName
      ORDER BY totalSpend DESC;
    `,
    // Indian FY-bound monthly breakdown, same always-12-rows shape as
    // crm.monthlyBreakdown — bill count + spend per month, grouped by
    // XBHDOCDT (the bill's own doc date, same field summary/trend/topVendors
    // above already use).
    monthlyBreakdown: `
      WITH Months AS (
        SELECT TOP 12 FORMAT(DATEADD(MONTH, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @start), 'yyyy-MM') AS period
        FROM sys.all_objects
      ),
      Bills AS (
        SELECT FORMAT(XBHDOCDT, 'yyyy-MM') AS period, COUNT(*) AS billCount, SUM(XBHACTBILLAMT) AS spend
        FROM XPURBILLHDR
        WHERE XBHDOCDT >= @start AND XBHDOCDT < @end
        GROUP BY FORMAT(XBHDOCDT, 'yyyy-MM')
      )
      SELECT m.period, ISNULL(b.billCount, 0) AS billCount, ISNULL(b.spend, 0) AS spend
      FROM Months m
      LEFT JOIN Bills b ON m.period = b.period
      ORDER BY m.period;
    `,
    // Bill-level detail report (the Purchase & Vendors equivalent of CRM's
    // recent-* tables). Same `filtered` pattern: false = most recent 50
    // overall, true = every bill in the caller's @start/@end month range
    // (used when a month row is clicked in monthlyBreakdown above).
    // Internal bill number is assembled from XBHYEAR/XBHGRP/XBHNO (there is
    // no single XBHBILLNO column) — same "internal doc no. assembled from
    // year/group/sequence" pattern used for sales orders elsewhere in this
    // file. XBHVNDBILLNO is the vendor's own bill reference (the payable-side
    // equivalent of a customer PO number). Verified against live columns.
    // Also used by the Finance panel's "Expenses" section (see finance's
    // /api/finance/purchase-bills route in server.js, which calls this same
    // query) — kept in one place so both panels stay consistent.
    bills: (filtered) => `
      SELECT ${filtered ? 'TOP 200' : 'TOP 50'}
        b.XBHAUTOID AS billId,
        CONCAT(b.XBHYEAR, '/', b.XBHGRP, '/', b.XBHNO) AS billNo,
        b.XBHVNDBILLNO AS vendorBillNo,
        v.MVmName AS vendorName,
        b.XBHDOCDT AS billDate,
        b.XBHACTBILLAMT AS billAmount,
        b.XBHSTATUS AS statusCode
      FROM XPURBILLHDR b
      LEFT JOIN MVNDMAST v ON b.XBHVNDCD = v.MVmVndCode
      ${filtered ? 'WHERE b.XBHDOCDT >= @start AND b.XBHDOCDT < @end' : ''}
      ORDER BY b.XBHDOCDT DESC;
    `,
    // Purchase Order report. RFQ (XPURINQHDR) and vendor quotation
    // (XPURQTNHDR) — the two stages that would normally precede a PO — are
    // NOT included here: both tables have 0 rows in this database, so
    // SYNCAXIS isn't using that workflow; a report on them would always be
    // empty. POHSTATUS labels ARE verified (unlike the same-shaped guess on
    // sales XOBORDSTAT): 'C' correlates 100% with a populated POHCLOSDT AND
    // a linked GRN across all 404 'C' rows, so it means fully closed/received,
    // not merely "confirmed". 'O'/'N' overwhelmingly have no GRN yet.
    // POHRCPVAL (received value so far) is populated and included; POHINVVAL/
    // POHPAIDVAL are NULL on every row in this data, so left out.
    orders: `
      SELECT TOP 50
        p.POHAUTOID AS poId,
        CONCAT(p.POHORDYEAR, '/', p.POHGRPCD, '/', p.POHORDNO) AS poNo,
        v.MVmName AS vendorName,
        p.POHORDDT AS orderDate,
        p.POHNETVAL AS orderValue,
        p.POHRCPVAL AS receivedValue,
        p.POHSTATUS AS statusCode,
        CASE p.POHSTATUS
          WHEN 'C' THEN 'Closed'
          WHEN 'O' THEN 'Open'
          WHEN 'N' THEN 'New'
          WHEN 'D' THEN 'Cancelled'
          ELSE p.POHSTATUS
        END AS statusLabel
      FROM XPOHEAD p
      LEFT JOIN MVNDMAST v ON p.POHVNDCODE = v.MVmVndCode
      ORDER BY p.POHORDDT DESC;
    `,
    // Material Received (GRN) report, with the PO number it was received
    // against. GRN -> PO link is at the line level (XGRNDTL.XGRNDPOID ->
    // XPOHEAD.POHAUTOID) — verified every one of the 650 GRNs in this data
    // links to exactly one distinct PO across all its lines (never more than
    // one), so a single OUTER APPLY TOP 1 is safe, same pattern used for
    // order->invoice lookups elsewhere in this file. XGRNHSTATUS meaning is
    // a guess (only 'O'/641 rows and 'D'/9 rows seen, no downstream link to
    // cross-check against) — 'O' does NOT mean "not yet received": a GRN
    // record only exists once goods are physically receipted, so 'O' more
    // likely reflects the record's own open/not-yet-billed state.
    materialReceived: `
      SELECT TOP 50
        h.XGRNHAUTOID AS grnId,
        CONCAT(h.XGRNHORDYR, '/', h.XGRNHGRPCD, '/', h.XGRNHORDNO) AS grnNo,
        po.poNo,
        v.MVmName AS vendorName,
        h.XGRNHORDDT AS receiptDate,
        h.XGRNHCHALNO AS vendorChallanNo,
        h.XGRNHCHALDT AS vendorChallanDate,
        h.XGRNHSTATUS AS statusCode,
        CASE h.XGRNHSTATUS WHEN 'O' THEN 'Open' WHEN 'D' THEN 'Cancelled' ELSE h.XGRNHSTATUS END AS statusLabel
      FROM XGRNHDR h
      LEFT JOIN MVNDMAST v ON h.XGRNHVNDCD = v.MVmVndCode
      OUTER APPLY (
        SELECT TOP 1 CONCAT(p.POHORDYEAR, '/', p.POHGRPCD, '/', p.POHORDNO) AS poNo
        FROM XGRNDTL d
        JOIN XPOHEAD p ON p.POHAUTOID = d.XGRNDPOID
        WHERE d.XGRNDAUTOID = h.XGRNHAUTOID
      ) po
      ORDER BY h.XGRNHORDDT DESC;
    `
  },

  // ---------------- INVENTORY & STOCK ----------------
  inventory: {
    summary: `
      SELECT
        COUNT(DISTINCT si.XSIITMCD) AS totalSkusInStock,
        ISNULL(SUM(s.XSHQTYONHAND), 0) AS totalQtyOnHand
      FROM XSTKONHAND s
      JOIN XSTKIDEN si ON s.XSHREFID = si.XSIAUTOID;
    `,
    lowStock: `
      -- Items whose total on-hand quantity has fallen below their reorder level
      SELECT TOP 25
        m.MIMITMICOD AS itemCode,
        m.MIMNAME AS itemName,
        SUM(s.XSHQTYONHAND) AS qtyOnHand,
        m.MIMRORDLVL AS reorderLevel,
        m.MIMMINLVL AS minLevel
      FROM XSTKONHAND s
      JOIN XSTKIDEN si ON s.XSHREFID = si.XSIAUTOID
      JOIN MITMMAST m ON si.XSIITMCD = m.MIMITMICOD
      WHERE m.MIMRORDLVL > 0
      GROUP BY m.MIMITMICOD, m.MIMNAME, m.MIMRORDLVL, m.MIMMINLVL
      HAVING SUM(s.XSHQTYONHAND) < m.MIMRORDLVL
      ORDER BY (SUM(s.XSHQTYONHAND) - m.MIMRORDLVL) ASC;
    `,
    topItemsByStock: `
      SELECT TOP 10
        m.MIMITMICOD AS itemCode,
        m.MIMNAME AS itemName,
        SUM(s.XSHQTYONHAND) AS qtyOnHand
      FROM XSTKONHAND s
      JOIN XSTKIDEN si ON s.XSHREFID = si.XSIAUTOID
      JOIN MITMMAST m ON si.XSIITMCD = m.MIMITMICOD
      GROUP BY m.MIMITMICOD, m.MIMNAME
      ORDER BY qtyOnHand DESC;
    `,
    // Monthly stock ACTIVITY (movement document counts), Indian FY-bound,
    // same always-12-rows shape used everywhere else. XSTKONHAND is only a
    // current balance with no history, so a month-by-month "stock level"
    // report isn't possible from this data — this instead shows how many
    // movement documents happened each month: Received (GRN) -> Issued (to
    // production) -> Produced (finished goods receipted back into stock).
    // Counts, not summed quantities: XGRNDTL/XISSDTL/XWORCPHDR lines cover
    // many different items in different units (kg, pcs, m...), so summing
    // raw quantities across them would be meaningless — same reasoning
    // already applied to the GRN and Material Issued tables elsewhere.
    // "Despatched" was considered as a fourth stage and dropped: the plain
    // delivery-challan table (XDCHDR) has only 17 rows in the ENTIRE
    // database — most despatch in this data happens via the combined
    // despatch-cum-invoice document instead (see Sales & CRM panels), so a
    // monthly delivery-challan count would misleadingly read as ~0 nearly
    // every month.
    monthlyBreakdown: `
      WITH Months AS (
        SELECT TOP 12 FORMAT(DATEADD(MONTH, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @start), 'yyyy-MM') AS period
        FROM sys.all_objects
      ),
      Received AS (
        SELECT FORMAT(XGRNHORDDT, 'yyyy-MM') AS period, COUNT(*) AS receivedCount
        FROM XGRNHDR WHERE XGRNHORDDT >= @start AND XGRNHORDDT < @end
        GROUP BY FORMAT(XGRNHORDDT, 'yyyy-MM')
      ),
      Issued AS (
        SELECT FORMAT(XIHISSDT, 'yyyy-MM') AS period, COUNT(*) AS issuedCount
        FROM XISSHDR WHERE XIHSJOWOTYP = 'S' AND XIHISSDT >= @start AND XIHISSDT < @end
        GROUP BY FORMAT(XIHISSDT, 'yyyy-MM')
      ),
      Produced AS (
        SELECT FORMAT(XWRHWODT, 'yyyy-MM') AS period, COUNT(*) AS producedCount
        FROM XWORCPHDR WHERE XWRHWODT >= @start AND XWRHWODT < @end
        GROUP BY FORMAT(XWRHWODT, 'yyyy-MM')
      )
      SELECT
        m.period,
        ISNULL(r.receivedCount, 0) AS receivedCount,
        ISNULL(i.issuedCount, 0) AS issuedCount,
        ISNULL(p.producedCount, 0) AS producedCount
      FROM Months m
      LEFT JOIN Received r ON m.period = r.period
      LEFT JOIN Issued i ON m.period = i.period
      LEFT JOIN Produced p ON m.period = p.period
      ORDER BY m.period;
    `,
    // Production receipts: finished/processed items received back into
    // stock (the "Produced" stage above). Not shown anywhere else in the app.
    productionReceipts: (filtered) => `
      SELECT ${filtered ? 'TOP 200' : 'TOP 50'}
        w.XWRHAUTOID AS receiptId,
        w.XWRHWONO AS workOrderNo,
        w.XWRHITMCD AS itemCode,
        w.XWRHWODT AS receiptDate,
        w.XWRHRCPQTY AS receiptQty,
        w.XWRHSTATUS AS statusCode
      FROM XWORCPHDR w
      ${filtered ? 'WHERE w.XWRHWODT >= @start AND w.XWRHWODT < @end' : ''}
      ORDER BY w.XWRHWODT DESC;
    `
  },

  // ---------------- FINANCE / AR-AP ----------------
  finance: {
    // XOH_DR_CR: assumed 'D' = receivable (owed to us), 'C' = payable (we owe)
    // VERIFY the actual values used in your data via diagnostics.sql.
    summary: `
      SELECT
        ISNULL(SUM(CASE WHEN XOH_DR_CR = 'D' THEN XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM ELSE 0 END), 0) AS totalReceivable,
        ISNULL(SUM(CASE WHEN XOH_DR_CR = 'C' THEN XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM ELSE 0 END), 0) AS totalPayable,
        ISNULL(SUM(CASE WHEN XOH_DR_CR = 'D' AND XOH_DUE_DATE < GETDATE() THEN XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM ELSE 0 END), 0) AS overdueReceivable
      FROM XOUTSTNDHDR;
    `,
    aging: `
      SELECT
        CASE
          WHEN DATEDIFF(DAY, XOH_DUE_DATE, GETDATE()) <= 0 THEN '0. Not yet due'
          WHEN DATEDIFF(DAY, XOH_DUE_DATE, GETDATE()) BETWEEN 1 AND 30 THEN '1. 1-30 days'
          WHEN DATEDIFF(DAY, XOH_DUE_DATE, GETDATE()) BETWEEN 31 AND 60 THEN '2. 31-60 days'
          WHEN DATEDIFF(DAY, XOH_DUE_DATE, GETDATE()) BETWEEN 61 AND 90 THEN '3. 61-90 days'
          ELSE '4. 90+ days'
        END AS bucket,
        SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM) AS amount
      FROM XOUTSTNDHDR
      WHERE XOH_DR_CR = 'D'
      GROUP BY
        CASE
          WHEN DATEDIFF(DAY, XOH_DUE_DATE, GETDATE()) <= 0 THEN '0. Not yet due'
          WHEN DATEDIFF(DAY, XOH_DUE_DATE, GETDATE()) BETWEEN 1 AND 30 THEN '1. 1-30 days'
          WHEN DATEDIFF(DAY, XOH_DUE_DATE, GETDATE()) BETWEEN 31 AND 60 THEN '2. 31-60 days'
          WHEN DATEDIFF(DAY, XOH_DUE_DATE, GETDATE()) BETWEEN 61 AND 90 THEN '3. 61-90 days'
          ELSE '4. 90+ days'
        END
      ORDER BY bucket;
    `,
    // Monthly breakdown, Indian FY-bound, same always-12-rows shape as
    // crm.monthlyBreakdown / lineage.monthlyBreakdown. Grouped by
    // XOH_DUE_DATE, NOT a "raised this month" date — XOH_BILLDATE (which
    // would give that) is NULL on all 1999 rows in this database, unusable.
    // XOUTSTNDHDR only holds CURRENTLY outstanding items (already-settled
    // ones aren't in it), so this is a forward/backward-looking view of
    // when today's outstanding balance falls due, not a historical activity
    // trend — a customer whose invoice was raised last year but is still
    // unpaid shows up in whatever month its due date falls in, which may be
    // in the past (still-overdue) or ahead in this FY.
    monthlyBreakdown: `
      WITH Months AS (
        SELECT TOP 12 FORMAT(DATEADD(MONTH, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @start), 'yyyy-MM') AS period
        FROM sys.all_objects
      ),
      Outstanding AS (
        SELECT
          FORMAT(XOH_DUE_DATE, 'yyyy-MM') AS period,
          SUM(CASE WHEN XOH_DR_CR = 'D' THEN XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM ELSE 0 END) AS receivableDue,
          SUM(CASE WHEN XOH_DR_CR = 'C' THEN XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM ELSE 0 END) AS payableDue,
          SUM(CASE WHEN XOH_DR_CR = 'D' THEN 1 ELSE 0 END) AS receivableCount,
          SUM(CASE WHEN XOH_DR_CR = 'C' THEN 1 ELSE 0 END) AS payableCount
        FROM XOUTSTNDHDR
        WHERE XOH_DUE_DATE >= @start AND XOH_DUE_DATE < @end
        GROUP BY FORMAT(XOH_DUE_DATE, 'yyyy-MM')
      )
      SELECT
        m.period,
        ISNULL(o.receivableDue, 0) AS receivableDue,
        ISNULL(o.payableDue, 0) AS payableDue,
        ISNULL(o.receivableCount, 0) AS receivableCount,
        ISNULL(o.payableCount, 0) AS payableCount
      FROM Months m
      LEFT JOIN Outstanding o ON m.period = o.period
      ORDER BY m.period;
    `,
    // Debtors report: customer-wise outstanding receivable, one row per
    // customer, with the oldest due date in that balance driving the aging
    // bucket (so a customer with any old overdue item shows as overdue even
    // if their balance also includes fresh, not-yet-due entries).
    // XOH_ACCCD -> MCMCUSTCD: same join already relied on by lineage.customerAR
    // (account-level receivable for a specific order's customer), so this is
    // not a new assumption. Rows where the balance nets to ~0 are dropped.
    // `filtered` (true when the caller clicked a month in the Finance
    // monthly breakdown table): restricts to entries whose due date falls in
    // the caller's @start/@end month, and the aggregates (amount, oldest due
    // date, entry count) are then scoped to just that month's entries — i.e.
    // "what this customer owes that's due in month X", not their full balance.
    debtors: (filtered) => `
      SELECT
        ISNULL(c.MCMCUSTNM, o.XOH_ACCCD) AS customerName,
        o.XOH_ACCCD AS customerCode,
        SUM(o.XOH_TRN_AMT_DOM - o.XOH_ADJ_AMT_DOM) AS outstandingAmount,
        MIN(o.XOH_DUE_DATE) AS oldestDueDate,
        DATEDIFF(DAY, MIN(o.XOH_DUE_DATE), GETDATE()) AS daysOverdue,
        COUNT(*) AS entryCount
      FROM XOUTSTNDHDR o
      LEFT JOIN MCUSTMST c ON o.XOH_ACCCD = c.MCMCUSTCD
      WHERE o.XOH_DR_CR = 'D'
      ${filtered ? 'AND o.XOH_DUE_DATE >= @start AND o.XOH_DUE_DATE < @end' : ''}
      GROUP BY o.XOH_ACCCD, c.MCMCUSTNM
      HAVING ABS(SUM(o.XOH_TRN_AMT_DOM - o.XOH_ADJ_AMT_DOM)) > 0.01
      ORDER BY outstandingAmount DESC;
    `,
    // Creditors report: vendor-wise outstanding payable, mirrors debtors above.
    // XOH_ACCCD -> MVmVndCode is UNVERIFIED (no existing query in this file
    // joins XOUTSTNDHDR to MVNDMAST) — if vendorName comes back as the raw
    // account code for most/all rows, the account-code namespace likely
    // doesn't line up 1:1 with MVmVndCode; see diagnostics.sql query 10.
    creditors: (filtered) => `
      SELECT
        ISNULL(v.MVmName, o.XOH_ACCCD) AS vendorName,
        o.XOH_ACCCD AS vendorCode,
        SUM(o.XOH_TRN_AMT_DOM - o.XOH_ADJ_AMT_DOM) AS outstandingAmount,
        MIN(o.XOH_DUE_DATE) AS oldestDueDate,
        DATEDIFF(DAY, MIN(o.XOH_DUE_DATE), GETDATE()) AS daysOverdue,
        COUNT(*) AS entryCount
      FROM XOUTSTNDHDR o
      LEFT JOIN MVNDMAST v ON o.XOH_ACCCD = v.MVmVndCode
      WHERE o.XOH_DR_CR = 'C'
      ${filtered ? 'AND o.XOH_DUE_DATE >= @start AND o.XOH_DUE_DATE < @end' : ''}
      GROUP BY o.XOH_ACCCD, v.MVmName
      HAVING ABS(SUM(o.XOH_TRN_AMT_DOM - o.XOH_ADJ_AMT_DOM)) > 0.01
      ORDER BY outstandingAmount DESC;
    `,
    // Expenses: full purchase-bill list — see queries.purchase.bills (shared
    // with the Purchase & Vendors panel's own bill-detail report, so both
    // stay consistent instead of maintaining two copies of the same query).
  },

  // ---------------- CRM: ENQUIRY -> QUOTATION -> SALES ORDER -> FOLLOW-UP ----------------
  // Pipeline stages are three separate tables linked by ID:
  //   XINQDTL (enquiry) --[XINQTNID]--> XQTNDTL (quotation) --[XOBQTNID]--> XORDDTL (sales order)
  // Follow-up activity is logged per source document in XFOLLOWUPDTL, keyed by
  // XFWBASEON (VERIFY: which code marks Enquiry/Quotation/Order) + XFWDOCID.
  // Status codes (XININQSTAT, XQDQNSTAT, XOBORDSTAT) aren't mapped to labels
  // here for the same reason as elsewhere — see diagnostics.sql.
  crm: {
    // enquiriesInFY/quotationsInFY/ordersInFY/orderValueInFY are scoped to
    // the caller's @start/@end (the selected financial year) — NOT the
    // current calendar month. followupsDue is intentionally independent of
    // that range: "due in the next 7 days" is always relative to today,
    // never to a historical FY.
    summary: `
      WITH LatestFollowup AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY XFWCUSTCD, XFWBASEON, XFWDOCID ORDER BY XFWFUPDT DESC, XFWUAUTOID DESC) AS rn
        FROM XFOLLOWUPDTL
      )
      SELECT
        (SELECT COUNT(*) FROM XINQDTL WHERE XININQDT >= @start AND XININQDT < @end) AS enquiriesInFY,
        (SELECT COUNT(*) FROM XQTNDTL WHERE XQDQTNDT >= @start AND XQDQTNDT < @end) AS quotationsInFY,
        (SELECT COUNT(*) FROM XORDDTL WHERE XOBORDDT >= @start AND XOBORDDT < @end) AS ordersInFY,
        ISNULL((SELECT SUM(XOBTOTDMCY) FROM XORDDTL WHERE XOBORDDT >= @start AND XOBORDDT < @end), 0) AS orderValueInFY,
        (SELECT COUNT(*) FROM LatestFollowup WHERE rn = 1 AND XFWNXTFWPDT IS NOT NULL AND CAST(XFWNXTFWPDT AS DATE) <= CAST(GETDATE() AS DATE)) AS followupsDue;
    `,
    // pipelineFunnel/monthlyBreakdown are bound to the Indian financial year
    // (1 April @start's year -> 31 March following year), passed in as
    // @start/@end by the caller — matches how SYNCAXIS itself numbers
    // documents internally (e.g. XQDQTNYEAR values like "26-27").
    pipelineFunnel: `
      SELECT 'Enquiries' AS stage, COUNT(*) AS count FROM XINQDTL WHERE XININQDT >= @start AND XININQDT < @end
      UNION ALL
      SELECT 'Quotations', COUNT(*) FROM XQTNDTL WHERE XQDQTNDT >= @start AND XQDQTNDT < @end
      UNION ALL
      SELECT 'Sales Orders', COUNT(*) FROM XORDDTL WHERE XOBORDDT >= @start AND XOBORDDT < @end;
    `,
    monthlyBreakdown: `
      -- Always returns exactly 12 rows (April..March), even months with zero
      -- activity, so the table/chart always show the full FY shape.
      WITH Months AS (
        SELECT TOP 12 FORMAT(DATEADD(MONTH, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @start), 'yyyy-MM') AS period
        FROM sys.all_objects
      ),
      Enq AS (
        SELECT FORMAT(XININQDT, 'yyyy-MM') AS period, COUNT(*) AS enquiryCount
        FROM XINQDTL WHERE XININQDT >= @start AND XININQDT < @end
        GROUP BY FORMAT(XININQDT, 'yyyy-MM')
      ),
      Qtn AS (
        SELECT FORMAT(XQDQTNDT, 'yyyy-MM') AS period, COUNT(*) AS quotationCount, SUM(XQDTOTDMCY) AS quotationValue
        FROM XQTNDTL WHERE XQDQTNDT >= @start AND XQDQTNDT < @end
        GROUP BY FORMAT(XQDQTNDT, 'yyyy-MM')
      ),
      Ord AS (
        SELECT FORMAT(XOBORDDT, 'yyyy-MM') AS period, COUNT(*) AS orderCount, SUM(XOBTOTDMCY) AS orderValue
        FROM XORDDTL WHERE XOBORDDT >= @start AND XOBORDDT < @end
        GROUP BY FORMAT(XOBORDDT, 'yyyy-MM')
      ),
      Fwp AS (
        SELECT FORMAT(XFWFUPDT, 'yyyy-MM') AS period, COUNT(*) AS followUpCount
        FROM XFOLLOWUPDTL WHERE XFWFUPDT >= @start AND XFWFUPDT < @end
        GROUP BY FORMAT(XFWFUPDT, 'yyyy-MM')
      ),
      -- NOTE: XINVHDR (what the Sales module currently reads) is empty in
      -- this database — 0 rows. The real, actively-used invoice table is
      -- XDCINVHDR (352 rows, all XDIHCUSTVND = 'C' i.e. customer-facing —
      -- confirmed real GST e-invoice data with IRN/e-way bill fields).
      Inv AS (
        SELECT FORMAT(XDIHINVDT, 'yyyy-MM') AS period, COUNT(*) AS invoiceCount, SUM(XDIHAMT) AS invoiceValue
        FROM XDCINVHDR WHERE XDIHINVDT >= @start AND XDIHINVDT < @end
        GROUP BY FORMAT(XDIHINVDT, 'yyyy-MM')
      )
      SELECT
        m.period,
        ISNULL(e.enquiryCount, 0) AS enquiryCount,
        ISNULL(q.quotationCount, 0) AS quotationCount,
        ISNULL(q.quotationValue, 0) AS quotationValue,
        ISNULL(o.orderCount, 0) AS orderCount,
        ISNULL(o.orderValue, 0) AS orderValue,
        ISNULL(i.invoiceCount, 0) AS invoiceCount,
        ISNULL(i.invoiceValue, 0) AS invoiceValue,
        ISNULL(f.followUpCount, 0) AS followUpCount
      FROM Months m
      LEFT JOIN Enq e ON m.period = e.period
      LEFT JOIN Qtn q ON m.period = q.period
      LEFT JOIN Ord o ON m.period = o.period
      LEFT JOIN Inv i ON m.period = i.period
      LEFT JOIN Fwp f ON m.period = f.period
      ORDER BY m.period;
    `,
    // recentEnquiries/recentQuotations/recentOrders take a `filtered` flag:
    // false (default) = most recent 15 overall, no date filter.
    // true = ALL rows in the @start/@end date range (bound by caller), used
    // when the user drills into a specific month from the monthly breakdown.
    recentEnquiries: (filtered) => `
      -- XININQSTAT confirmed via cross-check against XINQTNID (quotation link):
      -- Q = Quoted (100% have a quotation), R = Lost/Regret (100% WERE quoted
      -- but didn't convert), O = Open (92% have no quotation yet), D = Dropped.
      SELECT ${filtered ? 'TOP 200' : 'TOP 15'}
        i.XINAUTOID AS enquiryId,
        i.XININQNO AS enquiryNo,
        c.MCMCUSTNM AS customerName,
        i.XININQDT AS enquiryDate,
        i.XININQSTAT AS statusCode,
        CASE i.XININQSTAT
          WHEN 'O' THEN 'Open'
          WHEN 'Q' THEN 'Quoted'
          WHEN 'R' THEN 'Lost / Regret'
          WHEN 'D' THEN 'Dropped'
          ELSE i.XININQSTAT
        END AS statusLabel,
        e.MEMEMPNAME AS salesperson,
        i.XINNXTFUP AS nextFollowUp,
        CASE WHEN i.XINQTNID IS NOT NULL THEN 'Quoted' ELSE 'Open' END AS quoteStatus,
        qq.XQDQTNNO AS quotationNo
      FROM XINQDTL i
      LEFT JOIN MCUSTMST c ON i.XINCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON i.XINSPCODE = e.MEMEMPCODE
      LEFT JOIN XQTNDTL qq ON i.XINQTNID = qq.XQDAUTOID
      ${filtered ? 'WHERE i.XININQDT >= @start AND i.XININQDT < @end' : ''}
      ORDER BY i.XININQDT DESC;
    `,
    recentQuotations: (filtered) => `
      -- XQDQNSTAT confirmed via cross-check against XORDDTL.XOBQTNID (order
      -- link): R = Order Placed / Won (99% converted to a sales order),
      -- O = Open/pending (93% did NOT convert). XQDQUOSTATUS is a submission
      -- sub-status: SB = Submitted, NS = Not Submitted, CN = Cancelled.
      SELECT ${filtered ? 'TOP 200' : 'TOP 15'}
        q.XQDAUTOID AS quotationId,
        q.XQDQTNNO AS quotationNo,
        c.MCMCUSTNM AS customerName,
        q.XQDQTNDT AS quotationDate,
        q.XQDTOTDMCY AS quotationValue,
        q.XQDQNSTAT AS statusCode,
        CASE q.XQDQNSTAT
          WHEN 'O' THEN 'Open'
          WHEN 'R' THEN 'Order Placed'
          ELSE q.XQDQNSTAT
        END AS statusLabel,
        CASE q.XQDQUOSTATUS
          WHEN 'SB' THEN 'Submitted'
          WHEN 'NS' THEN 'Not Submitted'
          WHEN 'CN' THEN 'Cancelled'
          ELSE q.XQDQUOSTATUS
        END AS submissionStatus,
        e.MEMEMPNAME AS salesperson,
        so.syncaxisOrderNo
      FROM XQTNDTL q
      LEFT JOIN MCUSTMST c ON q.XQDCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON q.XQNSPCODE = e.MEMEMPCODE
      OUTER APPLY (
        -- A quotation can in principle spawn more than one order; show the
        -- most recent if so rather than duplicating the quotation row.
        SELECT TOP 1 CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo
        FROM XORDDTL o WHERE o.XOBQTNID = q.XQDAUTOID
        ORDER BY o.XOBORDDT DESC
      ) so
      ${filtered ? 'WHERE q.XQDQTNDT >= @start AND q.XQDQTNDT < @end' : ''}
      ORDER BY q.XQDQTNDT DESC;
    `,
    recentOrders: (filtered) => `
      -- XOBORDSTAT labels are a BEST GUESS — unlike enquiry/quotation status,
      -- there's no downstream link to cross-check these against. C is the
      -- default state for 89% of orders across the full date range (so most
      -- likely "Confirmed", not "Cancelled"). VERIFY before relying on this.
      -- XOBORDNO is the CUSTOMER's own PO/reference (values like "VERBAL" or
      -- a customer's SAP PO number confirm this) — it is NOT the SYNCAXIS
      -- sales order number. The real internal SO number is assembled from
      -- XOBIntOrdYr + XOBIntOrdGrp + XOBIntOrdNo (e.g. "26-27/SO/000098").
      SELECT ${filtered ? 'TOP 200' : 'TOP 15'}
        o.XOBAUTOID AS orderId,
        CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo,
        o.XOBORDNO AS customerRefNo,
        c.MCMCUSTNM AS customerName,
        o.XOBORDDT AS orderDate,
        o.XOBTOTDMCY AS orderValue,
        o.XOBORDSTAT AS statusCode,
        CASE o.XOBORDSTAT
          WHEN 'C' THEN 'Confirmed'
          WHEN 'A' THEN 'Amended'
          WHEN 'N' THEN 'New'
          WHEN 'D' THEN 'Deleted'
          WHEN 'O' THEN 'On Hold'
          ELSE o.XOBORDSTAT
        END AS statusLabel,
        e.MEMEMPNAME AS salesperson,
        inv.invoiceCount,
        inv.invoicedAmount,
        inv.lastInvoiceNo
      FROM XORDDTL o
      LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON o.XOBSPCODE = e.MEMEMPCODE
      OUTER APPLY (
        -- Order -> Order Acceptance Form -> invoice detail lines -> invoice
        -- header (verified: customer names match end-to-end on real data).
        -- DISTINCT on invoice header first, since XDCINVDTL has multiple
        -- line rows per invoice and would otherwise double-count amounts.
        SELECT COUNT(*) AS invoiceCount, SUM(XDIHAMT) AS invoicedAmount, MAX(XDIHINVNO) AS lastInvoiceNo
        FROM (
          SELECT DISTINCT ih.XDIHAUTOID, ih.XDIHAMT, ih.XDIHINVNO
          FROM XOAFHDR oaf
          JOIN XDCINVDTL id ON id.XDIDOAFID = oaf.XOAFHAUTOID
          JOIN XDCINVHDR ih ON id.XDIDREFID = ih.XDIHAUTOID
          WHERE oaf.XOAFHORDID = o.XOBAUTOID
        ) DistinctInv
      ) inv
      ${filtered ? 'WHERE o.XOBORDDT >= @start AND o.XOBORDDT < @end' : ''}
      ORDER BY o.XOBORDDT DESC;
    `,
    recentInvoices: (filtered) => `
      -- XDCINVHDR, not XINVHDR (empty) — see the note on the sales queries.
      -- XDIHSTATUS values seen: 'O' (97%) and 'N' (3%) — meaning unverified,
      -- shown as raw code. Salesperson/customer-PO fields on this table are
      -- blank for every row in this data, so they're not included here.
      -- Sales order traced back via Invoice -> XDCINVDTL -> XOAFHDR -> Order
      -- (same chain used forward on the orders table); confirmed no invoice
      -- in this data spans more than one distinct order, so TOP 1 is safe.
      SELECT ${filtered ? 'TOP 200' : 'TOP 15'}
        h.XDIHAUTOID AS invoiceId,
        h.XDIHINVNO AS invoiceNo,
        c.MCMCUSTNM AS customerName,
        h.XDIHINVDT AS invoiceDate,
        h.XDIHAMT AS invoiceValue,
        h.XDIHSTATUS AS statusCode,
        so.syncaxisOrderNo
      FROM XDCINVHDR h
      LEFT JOIN MCUSTMST c ON h.XDIHCUSTCD = c.MCMCUSTCD
      OUTER APPLY (
        SELECT TOP 1 CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo
        FROM XDCINVDTL d
        JOIN XOAFHDR oaf ON d.XDIDOAFID = oaf.XOAFHAUTOID
        JOIN XORDDTL o ON oaf.XOAFHORDID = o.XOBAUTOID
        WHERE d.XDIDREFID = h.XDIHAUTOID
      ) so
      ${filtered ? 'WHERE h.XDIHINVDT >= @start AND h.XDIHINVDT < @end' : ''}
      ORDER BY h.XDIHINVDT DESC;
    `,
    pendingFollowups: `
      -- Latest logged follow-up per source document, flagged when its planned
      -- next follow-up date has arrived or is within the next 7 days.
      -- NOTE: XFOLLOWUPDTL only has ~13 rows total in this database (and its
      -- sibling XFUPDTL has zero) — this log is barely used day-to-day, so
      -- expect this panel to stay mostly empty. XFWBASEON confirmed literal:
      -- 'I' = Enquiry (Inquiry), 'Q' = Quotation; 'O' (Sales Order) is a guess,
      -- not observed in the data.
      WITH LatestFollowup AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY XFWCUSTCD, XFWBASEON, XFWDOCID ORDER BY XFWFUPDT DESC, XFWUAUTOID DESC) AS rn
        FROM XFOLLOWUPDTL
      )
      SELECT TOP 25
        c.MCMCUSTNM AS customerName,
        f.XFWBASEON AS basedOn,
        CASE f.XFWBASEON
          WHEN 'I' THEN 'Enquiry'
          WHEN 'Q' THEN 'Quotation'
          WHEN 'O' THEN 'Sales Order'
          ELSE f.XFWBASEON
        END AS basedOnLabel,
        f.XFWDOCID AS docId,
        f.XFWFUPDT AS lastFollowUpDate,
        f.XFWNXTFWPDT AS nextFollowUpDate,
        f.XFUNFAGNDA AS nextAgenda,
        e.MEMEMPNAME AS salesperson,
        f.XFWREMARK AS remark
      FROM LatestFollowup f
      LEFT JOIN MCUSTMST c ON f.XFWCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON f.XFWSPCODE = e.MEMEMPCODE
      WHERE f.rn = 1
        AND f.XFWNXTFWPDT IS NOT NULL
        AND CAST(f.XFWNXTFWPDT AS DATE) <= DATEADD(DAY, 7, CAST(GETDATE() AS DATE))
      ORDER BY f.XFWNXTFWPDT ASC;
    `
  },

  // ---------------- ORDER LINEAGE (end-to-end genealogy) ----------------
  // Full chain verified empirically against real data (not just column
  // names) before building this — every hop below was cross-checked by
  // matching items/quantities/dates across tables:
  //   Enquiry (XINQDTL) <-[XQDINQID]- Quotation (XQTNDTL) <-[XOBQTNID]-
  //   Sales Order (XORDDTL) <-[XOAFHORDID]- OAF (XOAFHDR) <-[XSHOAFID]-
  //   Shop Job Order / manufacturing (XSJOHDR) <-[XWRHSJOID]- Production
  //   Receipt (XWORCPHDR) -[XWRHWOREFID]-> Work Order (XWOHDR); Store issues
  //   (XISSHDR) via XIHDOCID = SJO auto-no; Despatch via XDCDTL.XDCDOAFID
  //   (a separate plain Delivery Challan, only used for ~17 orders) and/or
  //   Invoice via XDCINVDTL.XDIDOAFID -> XDCINVHDR (dispatch-cum-invoice,
  //   the common case). One order = exactly one OAF (confirmed 1:1 in this
  //   data), but one OAF can spawn many Shop Job Orders (1 to 42 seen).
  //
  // Financial Settlement is NOT traced per-invoice: XOUTSTNDHDR has no
  // reliable invoice-level link (XOH_VCH_REF_ID looked promising but
  // amounts didn't match on verification — a false positive). Shown instead
  // as the customer's overall outstanding balance via XOH_ACCCD.
  lineage: {
    orderList: (search, month) => {
      const conditions = [];
      if (search) {
        conditions.push(`(c.MCMCUSTNM LIKE '%' + @search + '%'
          OR o.XOBORDNO LIKE '%' + @search + '%'
          OR CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) LIKE '%' + @search + '%')`);
      }
      if (month) conditions.push('o.XOBORDDT >= @start AND o.XOBORDDT < @end');
      return `
        SELECT ${search || month ? 'TOP 200' : 'TOP 50'}
          o.XOBAUTOID AS orderId,
          CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo,
          o.XOBORDNO AS customerRefNo,
          c.MCMCUSTNM AS customerName,
          o.XOBORDDT AS orderDate,
          o.XOBTOTDMCY AS orderValue,
          o.XOBORDSTAT AS statusCode
        FROM XORDDTL o
        LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        ORDER BY o.XOBORDDT DESC;
      `;
    },
    // FY-bound monthly order count/value for this page's own breakdown —
    // same 12-row-always shape as crm.monthlyBreakdown, but orders only.
    monthlyBreakdown: `
      WITH Months AS (
        SELECT TOP 12 FORMAT(DATEADD(MONTH, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @start), 'yyyy-MM') AS period
        FROM sys.all_objects
      ),
      Ord AS (
        SELECT FORMAT(XOBORDDT, 'yyyy-MM') AS period, COUNT(*) AS orderCount, SUM(XOBTOTDMCY) AS orderValue
        FROM XORDDTL WHERE XOBORDDT >= @start AND XOBORDDT < @end
        GROUP BY FORMAT(XOBORDDT, 'yyyy-MM')
      )
      SELECT m.period, ISNULL(o.orderCount, 0) AS orderCount, ISNULL(o.orderValue, 0) AS orderValue
      FROM Months m
      LEFT JOIN Ord o ON m.period = o.period
      ORDER BY m.period;
    `,
    header: `
      SELECT
        o.XOBAUTOID AS orderId,
        CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo,
        o.XOBORDNO AS customerRefNo,
        o.XOBORDDT AS orderDate,
        o.XOBTOTDMCY AS orderValue,
        o.XOBORDSTAT AS statusCode,
        CASE o.XOBORDSTAT
          WHEN 'C' THEN 'Confirmed' WHEN 'A' THEN 'Amended' WHEN 'N' THEN 'New'
          WHEN 'D' THEN 'Deleted' WHEN 'O' THEN 'On Hold' ELSE o.XOBORDSTAT
        END AS statusLabel,
        c.MCMCUSTNM AS customerName,
        o.XOBCUSTCD AS customerCode,
        e.MEMEMPNAME AS salesperson,
        q.XQDAUTOID AS quotationId,
        q.XQDQTNNO AS quotationNo,
        q.XQDQTNDT AS quotationDate,
        q.XQDTOTDMCY AS quotationValue,
        i.XINAUTOID AS enquiryId,
        i.XININQNO AS enquiryNo,
        i.XININQDT AS enquiryDate,
        oaf.XOAFHAUTOID AS oafId,
        CONCAT(oaf.XOAFHYEAR, '/', oaf.XOAFHGRPCD, '/', oaf.XOAFHNO) AS oafNo,
        oaf.XOAFHDATE AS oafDate
      FROM XORDDTL o
      LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON o.XOBSPCODE = e.MEMEMPCODE
      LEFT JOIN XQTNDTL q ON o.XOBQTNID = q.XQDAUTOID
      LEFT JOIN XINQDTL i ON q.XQDINQID = i.XINAUTOID
      LEFT JOIN XOAFHDR oaf ON oaf.XOAFHORDID = o.XOBAUTOID
      WHERE o.XOBAUTOID = @orderId;
    `,
    shopJobOrders: `
      SELECT
        s.XSHSJAUTONO AS sjoId,
        CONCAT(s.XSHSJOYEAR, '/', s.XSHSJOGRP, '/', s.XSHSJONO) AS sjoNo,
        s.XSHSITMCD AS itemCode,
        s.XSHORDQTY AS orderedQty,
        s.XSHCOMPQTY AS completedQty,
        s.XSHSJOSTAT AS statusCode,
        s.XSHSJODT AS sjoDate,
        s.XSHCMPLTDT AS completedDate
      FROM XOAFHDR oaf
      JOIN XSJOHDR s ON s.XSHOAFID = oaf.XOAFHAUTOID
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY s.XSHSJODT;
    `,
    production: `
      SELECT
        wo.XWONO AS workOrderNo,
        wo.XWOITMCD AS itemCode,
        wo.XWOQTYORD AS orderedQty,
        wo.XWOQTYRECV AS receivedQty,
        wo.XWOSTATUS AS statusCode,
        wo.XWODT AS workOrderDate,
        wo.XWOCLOSDT AS closedDate,
        wr.XWRHRCPQTY AS receiptQty,
        wr.XWRHWODT AS receiptDate,
        CONCAT(s.XSHSJOYEAR, '/', s.XSHSJOGRP, '/', s.XSHSJONO) AS sjoNo
      FROM XOAFHDR oaf
      JOIN XSJOHDR s ON s.XSHOAFID = oaf.XOAFHAUTOID
      JOIN XWORCPHDR wr ON wr.XWRHSJOID = s.XSHSJAUTONO
      LEFT JOIN XWOHDR wo ON wo.XWOAUTOID = wr.XWRHWOREFID
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY wr.XWRHWODT;
    `,
    storeIssues: `
      SELECT
        i.XIHISSNO AS issueNo,
        i.XIHISSDT AS issueDate,
        i.XIHSTATUS AS statusCode,
        CONCAT(s.XSHSJOYEAR, '/', s.XSHSJOGRP, '/', s.XSHSJONO) AS sjoNo
      FROM XOAFHDR oaf
      JOIN XSJOHDR s ON s.XSHOAFID = oaf.XOAFHAUTOID
      JOIN XISSHDR i ON i.XIHDOCID = s.XSHSJAUTONO AND i.XIHSJOWOTYP = 'S'
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY i.XIHISSDT;
    `,
    despatchChallans: `
      -- Plain Delivery Challan — only populated for a minority of orders in
      -- this data (17 headers total). When empty for an order, despatch
      -- happened via the combined dispatch-cum-invoice document instead
      -- (see the invoices query below).
      SELECT DISTINCT
        h.XDCHDCNO AS challanNo,
        h.XDCHDATE AS challanDate,
        h.XDCHSTAT AS statusCode
      FROM XOAFHDR oaf
      JOIN XDCDTL d ON d.XDCDOAFID = oaf.XOAFHAUTOID
      JOIN XDCHDR h ON d.XDCDHID = h.XDCHAUTOID
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY h.XDCHDATE;
    `,
    invoices: `
      SELECT DISTINCT
        ih.XDIHAUTOID AS invoiceId,
        ih.XDIHINVNO AS invoiceNo,
        ih.XDIHINVDT AS invoiceDate,
        ih.XDIHAMT AS invoiceValue,
        ih.XDIHSTATUS AS statusCode
      FROM XOAFHDR oaf
      JOIN XDCINVDTL d ON d.XDIDOAFID = oaf.XOAFHAUTOID
      JOIN XDCINVHDR ih ON d.XDIDREFID = ih.XDIHAUTOID
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY ih.XDIHINVDT;
    `,
    customerAR: `
      -- Account-level, NOT specific to this order/invoice — see module note.
      SELECT
        ISNULL(SUM(CASE WHEN XOH_DR_CR = 'D' THEN XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM ELSE 0 END), 0) AS receivable,
        COUNT(*) AS outstandingEntries
      FROM XOUTSTNDHDR
      WHERE XOH_ACCCD = (SELECT XOBCUSTCD FROM XORDDTL WHERE XOBAUTOID = @orderId);
    `
  },

  // ---------------- PRODUCTION / WORK ORDERS ----------------
  production: {
    // XWOCLOSDT IS NULL is used as the "still open" signal, which is a safe
    // assumption regardless of what the XWOSTATUS codes mean.
    summary: `
      SELECT
        SUM(CASE WHEN XWOCLOSDT IS NULL THEN 1 ELSE 0 END) AS openWorkOrders,
        SUM(CASE WHEN XWOCLOSDT IS NOT NULL AND MONTH(XWOCLOSDT) = MONTH(GETDATE()) AND YEAR(XWOCLOSDT) = YEAR(GETDATE()) THEN 1 ELSE 0 END) AS closedThisMonth,
        SUM(CASE WHEN XWOCLOSDT IS NULL AND XWODUEDT < GETDATE() THEN 1 ELSE 0 END) AS overdueWorkOrders
      FROM XWOHDR;
    `,
    statusBreakdown: `
      SELECT
        XWOSTATUS AS statusCode,
        COUNT(*) AS count
      FROM XWOHDR
      GROUP BY XWOSTATUS
      ORDER BY count DESC;
      -- VERIFY: map XWOSTATUS codes to friendly labels (Open/In-Progress/Closed/etc.)
      -- once you confirm them — see diagnostics.sql.
    `,
    sjoStatus: `
      SELECT
        XSHSJOSTAT AS statusCode,
        COUNT(*) AS count
      FROM XSJOHDR
      GROUP BY XSHSJOSTAT
      ORDER BY count DESC;
    `,
    // ---- Production pipeline: OAF -> Work Order -> Material Issued ->
    // Ready (fully received) ----
    // Same shape as CRM Pipeline (crm.monthlyBreakdown / recentEnquiries etc)
    // but for the production side. Purchase Order was considered as a fifth
    // stage but dropped: POHOAFID (PO -> OAF link) is populated with a real
    // OAF reference on only 3 of 451 POs — mostly it's just 0, not a
    // meaningful production-job link. PO reporting stays in the Purchase &
    // Vendors panel instead. Every remaining stage's own date field, verified:
    //   OAF: XOAFHDATE.
    //   Work Order: XWODT.
    //   Material Issued: XIHISSDT, filtered to XIHSJOWOTYP = 'S' (issues
    //   against a Shop Job Order) — same filter Order Lineage's storeIssues
    //   query already uses; no 'W' (direct-to-WO) issues exist in this data.
    //   Ready = Work Order fully received (XWOQTYRECV >= XWOQTYORD, guarded
    //   by XWOQTYORD > 0). Verified ALL 483 fully-received work orders also
    //   have XWOCLOSDT populated (100% correlation), so XWOCLOSDT is used as
    //   the "became ready" date for monthly bucketing.
    monthlyBreakdown: `
      WITH Months AS (
        SELECT TOP 12 FORMAT(DATEADD(MONTH, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @start), 'yyyy-MM') AS period
        FROM sys.all_objects
      ),
      Oaf AS (
        SELECT FORMAT(XOAFHDATE, 'yyyy-MM') AS period, COUNT(*) AS oafCount
        FROM XOAFHDR WHERE XOAFHDATE >= @start AND XOAFHDATE < @end
        GROUP BY FORMAT(XOAFHDATE, 'yyyy-MM')
      ),
      Wo AS (
        SELECT FORMAT(XWODT, 'yyyy-MM') AS period, COUNT(*) AS woCount
        FROM XWOHDR WHERE XWODT >= @start AND XWODT < @end
        GROUP BY FORMAT(XWODT, 'yyyy-MM')
      ),
      Issue AS (
        SELECT FORMAT(XIHISSDT, 'yyyy-MM') AS period, COUNT(*) AS issueCount
        FROM XISSHDR WHERE XIHSJOWOTYP = 'S' AND XIHISSDT >= @start AND XIHISSDT < @end
        GROUP BY FORMAT(XIHISSDT, 'yyyy-MM')
      ),
      Ready AS (
        SELECT FORMAT(XWOCLOSDT, 'yyyy-MM') AS period, COUNT(*) AS readyCount
        FROM XWOHDR
        WHERE XWOQTYORD > 0 AND XWOQTYRECV >= XWOQTYORD AND XWOCLOSDT >= @start AND XWOCLOSDT < @end
        GROUP BY FORMAT(XWOCLOSDT, 'yyyy-MM')
      )
      SELECT
        m.period,
        ISNULL(o.oafCount, 0) AS oafCount,
        ISNULL(w.woCount, 0) AS woCount,
        ISNULL(i.issueCount, 0) AS issueCount,
        ISNULL(r.readyCount, 0) AS readyCount
      FROM Months m
      LEFT JOIN Oaf o ON m.period = o.period
      LEFT JOIN Wo w ON m.period = w.period
      LEFT JOIN Issue i ON m.period = i.period
      LEFT JOIN Ready r ON m.period = r.period
      ORDER BY m.period;
    `,
    oafs: (filtered) => `
      SELECT ${filtered ? 'TOP 200' : 'TOP 50'}
        oaf.XOAFHAUTOID AS oafId,
        CONCAT(oaf.XOAFHYEAR, '/', oaf.XOAFHGRPCD, '/', oaf.XOAFHNO) AS oafNo,
        oaf.XOAFHDATE AS oafDate,
        CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo,
        c.MCMCUSTNM AS customerName
      FROM XOAFHDR oaf
      LEFT JOIN XORDDTL o ON o.XOBAUTOID = oaf.XOAFHORDID
      LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
      ${filtered ? 'WHERE oaf.XOAFHDATE >= @start AND oaf.XOAFHDATE < @end' : ''}
      ORDER BY oaf.XOAFHDATE DESC;
    `,
    workOrders: (filtered) => `
      SELECT ${filtered ? 'TOP 200' : 'TOP 50'}
        w.XWOAUTOID AS woId,
        CONCAT(w.XWOYR, '/', w.XWOGRCD, '/', w.XWONO) AS woNo,
        w.XWOITMCD AS itemCode,
        w.XWODT AS orderDate,
        w.XWODUEDT AS dueDate,
        w.XWOQTYORD AS orderedQty,
        w.XWOQTYRECV AS receivedQty,
        w.XWOSTATUS AS statusCode,
        w.XWOCLOSDT AS closedDate
      FROM XWOHDR w
      ${filtered ? 'WHERE w.XWODT >= @start AND w.XWODT < @end' : ''}
      ORDER BY w.XWODT DESC;
    `,
    // XIHSJOWOTYP = 'S' filter matches lineage.storeIssues — no 'W'-typed
    // (direct-to-work-order) issues exist in this data, only SJO-linked ones.
    materialIssued: (filtered) => `
      SELECT ${filtered ? 'TOP 200' : 'TOP 50'}
        i.XIHAUTOID AS issueId,
        i.XIHISSNO AS issueNo,
        i.XIHISSDT AS issueDate,
        CONCAT(s.XSHSJOYEAR, '/', s.XSHSJOGRP, '/', s.XSHSJONO) AS sjoNo,
        i.XIHSTATUS AS statusCode
      FROM XISSHDR i
      LEFT JOIN XSJOHDR s ON i.XIHDOCID = s.XSHSJAUTONO AND i.XIHSJOWOTYP = 'S'
      WHERE i.XIHSJOWOTYP = 'S'
      ${filtered ? 'AND i.XIHISSDT >= @start AND i.XIHISSDT < @end' : ''}
      ORDER BY i.XIHISSDT DESC;
    `,
    // "Project ready" = fully received (see monthlyBreakdown comment above).
    readyWorkOrders: (filtered) => `
      SELECT ${filtered ? 'TOP 200' : 'TOP 50'}
        w.XWOAUTOID AS woId,
        CONCAT(w.XWOYR, '/', w.XWOGRCD, '/', w.XWONO) AS woNo,
        w.XWOITMCD AS itemCode,
        w.XWOQTYORD AS orderedQty,
        w.XWOQTYRECV AS receivedQty,
        w.XWOCLOSDT AS readyDate
      FROM XWOHDR w
      WHERE w.XWOQTYORD > 0 AND w.XWOQTYRECV >= w.XWOQTYORD
      ${filtered ? 'AND w.XWOCLOSDT >= @start AND w.XWOCLOSDT < @end' : ''}
      ORDER BY w.XWOCLOSDT DESC;
    `
  }
};

module.exports = queries;
