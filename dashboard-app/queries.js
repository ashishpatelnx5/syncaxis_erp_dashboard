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
      SELECT ${filtered ? '' : 'TOP 10'}
        b.XBHAUTOID AS billId,
        CONCAT(b.XBHYEAR, '/', b.XBHGRP, '/', b.XBHNO) AS billNo,
        b.XBHVNDBILLNO AS vendorBillNo,
        v.MVmName AS vendorName,
        b.XBHDOCDT AS billDate,
        b.XBHACTBILLAMT AS billAmount,
        b.XBHSTATUS AS statusCode,
        -- Only 2 values in this data (908 'O', 3 'D'). Labelled by the same
        -- O=Open/D=Cancelled convention verified independently on POHSTATUS,
        -- XGRNHSTATUS and XIHSTATUS elsewhere in this file — not directly
        -- confirmed against SourcePro's own bill screen, but consistent
        -- with every other status field in this procure-to-pay chain.
        CASE b.XBHSTATUS WHEN 'O' THEN 'Open' WHEN 'D' THEN 'Cancelled' ELSE b.XBHSTATUS END AS statusLabel,
        po.poId
      FROM XPURBILLHDR b
      LEFT JOIN MVNDMAST v ON b.XBHVNDCD = v.MVmVndCode
      OUTER APPLY (
        -- Same Bill->PO link as finance.vendorOrdersAndBills/
        -- lineage.billsByPurchaseOrder, just walked in the other direction.
        -- TOP 1: a bill's GRN lines should all trace to the same PO (see the
        -- note on vendorOrdersAndBills for the verified match rate).
        SELECT TOP 1 g.XBGPOID AS poId
        FROM XPURBILLGRNDTL g
        WHERE g.XBGREFID = b.XBHAUTOID AND g.XBGPOID <> '0'
      ) po
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
    orders: (filtered) => `
      SELECT ${filtered ? '' : 'TOP 10'}
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
      ${filtered ? 'WHERE p.POHORDDT >= @start AND p.POHORDDT < @end' : ''}
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
    materialReceived: (filtered) => `
      SELECT ${filtered ? '' : 'TOP 10'}
        h.XGRNHAUTOID AS grnId,
        CONCAT(h.XGRNHORDYR, '/', h.XGRNHGRPCD, '/', h.XGRNHORDNO) AS grnNo,
        po.poId,
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
        SELECT TOP 1 p.POHAUTOID AS poId, CONCAT(p.POHORDYEAR, '/', p.POHGRPCD, '/', p.POHORDNO) AS poNo
        FROM XGRNDTL d
        JOIN XPOHEAD p ON p.POHAUTOID = d.XGRNDPOID
        WHERE d.XGRNDAUTOID = h.XGRNHAUTOID
      ) po
      ${filtered ? 'WHERE h.XGRNHORDDT >= @start AND h.XGRNHORDDT < @end' : ''}
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
      -- w.XWRHWONO is a denormalized text copy of the work order number, no
      -- year/group split of its own — joined to the real XWOHDR (via the
      -- verified XWRHWOREFID link, same as lineage.production) for the full
      -- "YY-YY/GRP/NNNNNN" form instead.
      SELECT ${filtered ? '' : 'TOP 10'}
        w.XWRHAUTOID AS receiptId,
        CASE WHEN wo.XWOAUTOID IS NULL THEN w.XWRHWONO ELSE CONCAT(wo.XWOYR, '/', wo.XWOGRCD, '/', wo.XWONO) END AS workOrderNo,
        w.XWRHITMCD AS itemCode,
        w.XWRHWODT AS receiptDate,
        w.XWRHRCPQTY AS receiptQty,
        w.XWRHSTATUS AS statusCode,
        -- Only 2 values (491 'C', 2 'D'). C=Completed/D=Cancelled by the
        -- same convention verified on XWOSTATUS/POHSTATUS elsewhere (a
        -- receipt record only exists once production is done, so 'C' here
        -- plausibly means the receipt itself, not the work order).
        CASE w.XWRHSTATUS WHEN 'C' THEN 'Completed' WHEN 'D' THEN 'Cancelled' ELSE w.XWRHSTATUS END AS statusLabel
      FROM XWORCPHDR w
      LEFT JOIN XWOHDR wo ON wo.XWOAUTOID = w.XWRHWOREFID
      ${filtered ? 'WHERE w.XWRHWODT >= @start AND w.XWRHWODT < @end' : ''}
      ORDER BY w.XWRHWODT DESC;
    `
  },

  // ---------------- FINANCE / AR-AP ----------------
  finance: {
    // XOH_DR_CR: assumed 'D' = receivable (owed to us), 'C' = payable (we owe)
    // VERIFY the actual values used in your data via diagnostics.sql.
    summary: `
      -- Netted per customer/vendor, same methodology as pending.
      -- receivablesSummary and finance.debtors/creditors (group by account,
      -- HAVING |net balance| > 0.01) — NOT a plain COUNT(DISTINCT XOH_ACCCD
      -- WHERE XOH_DR_CR='D'), which counts anyone with at least one debit
      -- ROW even if their debits and credits net to ~zero (already settled,
      -- just unmatched/uncleared ledger entries). That naive version showed
      -- 174 "customers with outstanding receivable" against Action Items'
      -- 77 for the exact same rupee total — 97 of those 174 net to ~zero.
      WITH RecvByAcc AS (
        SELECT XOH_ACCCD, SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM) AS bal,
          SUM(CASE WHEN XOH_DUE_DATE < GETDATE() THEN XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM ELSE 0 END) AS overdueBal
        FROM XOUTSTNDHDR WHERE XOH_DR_CR = 'D'
        GROUP BY XOH_ACCCD
        HAVING ABS(SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM)) > 0.01
      ),
      PayByAcc AS (
        SELECT XOH_ACCCD, SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM) AS bal,
          SUM(CASE WHEN XOH_DUE_DATE < GETDATE() THEN XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM ELSE 0 END) AS overdueBal
        FROM XOUTSTNDHDR WHERE XOH_DR_CR = 'C'
        GROUP BY XOH_ACCCD
        HAVING ABS(SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM)) > 0.01
      )
      SELECT
        ISNULL((SELECT SUM(bal) FROM RecvByAcc), 0) AS totalReceivable,
        (SELECT COUNT(*) FROM RecvByAcc) AS receivableCount,
        ISNULL((SELECT SUM(bal) FROM PayByAcc), 0) AS totalPayable,
        (SELECT COUNT(*) FROM PayByAcc) AS payableCount,
        ISNULL((SELECT SUM(overdueBal) FROM RecvByAcc), 0) AS overdueReceivable,
        (SELECT COUNT(*) FROM RecvByAcc WHERE ABS(overdueBal) > 0.01) AS overdueReceivableCount,
        ISNULL((SELECT SUM(overdueBal) FROM PayByAcc), 0) AS overduePayable,
        (SELECT COUNT(*) FROM PayByAcc WHERE ABS(overdueBal) > 0.01) AS overduePayableCount;
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
    // Payable-side mirror of aging above (XOH_DR_CR='C' instead of 'D') —
    // same bucket boundaries, so Payables aging sits directly alongside
    // Receivables aging instead of only the customer side having one.
    agingPayable: `
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
      WHERE XOH_DR_CR = 'C'
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
    // `showAll` caps the default (unfiltered, no month selected) view at the
    // top 10 by outstanding amount — same "Most recent"/"Show all" pattern
    // used everywhere else in this app, applied here to the biggest balances
    // instead of the newest date (there's no transaction date to sort by on
    // this snapshot-of-current-balance table). Ignored when `filtered` (a
    // month was clicked): that view already shows every matching entry.
    debtors: (filtered, showAll) => `
      SELECT ${(!filtered && !showAll) ? 'TOP 10' : ''}
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
    creditors: (filtered, showAll) => `
      SELECT ${(!filtered && !showAll) ? 'TOP 10' : ''}
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

    // Sales Orders & Invoices for one specific customer, one row per SO (or
    // per SO+Invoice pair when an order has been invoiced) — a genuine join,
    // not a guess: Order -> XOAFHDR (Order Acceptance Form) -> XDCINVDTL ->
    // XDCINVHDR, the same chain already verified end-to-end in
    // crm.recentOrders/recentInvoices. (Separate from the debtor/creditor
    // outstanding-balance rows above — XOUTSTNDHDR has no reliable per-invoice
    // link, see the customerAR note in lineage below — so this is scoped by
    // account code + financial year instead, as its own reference view.)
    // OUTER APPLY keeps orders with no invoice yet (all invoice columns null)
    // and repeats the order once per invoice if it was invoiced more than once.
    //
    // XOBORDSTAT='N' is labelled 'Cancelled', not the original guess 'New':
    // spot-checked against SourcePro's own Sales Order list directly on
    // 25-26/SO/000003 and 26-27/SO/000007 (both XOBORDSTAT='N') and both
    // show "CANCELLED" there — 2/2, no counterexamples yet. 13 orders total
    // carry this code across the dataset; if any of the untested ones turn
    // out not to be cancelled, this label (and the pending.invoicing /
    // pending.workOrders exclusion below) needs revisiting.
    customerOrdersAndInvoices: (filtered) => `
      SELECT
        o.XOBAUTOID AS orderId,
        CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS soNo,
        o.XOBORDDT AS soDate,
        o.XOBTOTDMCY AS soValue,
        CASE o.XOBORDSTAT
          WHEN 'C' THEN 'Confirmed'
          WHEN 'A' THEN 'Amended'
          WHEN 'N' THEN 'Cancelled'
          WHEN 'D' THEN 'Deleted'
          WHEN 'O' THEN 'On Hold'
          ELSE o.XOBORDSTAT
        END AS soStatus,
        inv.invoiceNo,
        inv.invoiceDate,
        inv.invoiceValue,
        inv.invoiceStatus
      FROM XORDDTL o
      OUTER APPLY (
        -- XDIHAMTTAX (tax-incl.), not XDIHAMT (excl.) — soValue (o.XOBTOTDMCY)
        -- is tax-inclusive, so this must match it or a fully-invoiced order
        -- shows invoiceValue short of soValue. See pending.invoicing.
        -- XDIHSTATUS: 'O' -> 'Open' by convention with POHSTATUS/XGRNHSTATUS
        -- elsewhere in this database (both reliably use 'O' for that). 'N'
        -- is left as the raw code — unlike 'O', it's NOT consistent across
        -- this schema (means 'Cancelled' on XOBORDSTAT, 'New' on POHSTATUS)
        -- and there's no other field on this table that disambiguates it;
        -- PENDING VERIFICATION directly against SourcePro.
        SELECT DISTINCT CONCAT(ih.XDIHINVYR, '/', ih.XDIHINVGRP, '/', ih.XDIHINVNO) AS invoiceNo, ih.XDIHINVDT AS invoiceDate, ih.XDIHAMTTAX AS invoiceValue,
          CASE ih.XDIHSTATUS WHEN 'O' THEN 'Open' ELSE ih.XDIHSTATUS END AS invoiceStatus
        FROM XOAFHDR oaf
        JOIN XDCINVDTL id ON id.XDIDOAFID = oaf.XOAFHAUTOID
        JOIN XDCINVHDR ih ON id.XDIDREFID = ih.XDIHAUTOID
        WHERE oaf.XOAFHORDID = o.XOBAUTOID
      ) inv
      WHERE o.XOBCUSTCD = @accountCode
      ${filtered ? 'AND o.XOBORDDT >= @start AND o.XOBORDDT < @end' : ''}
      ORDER BY o.XOBORDDT DESC;
    `,
    // Purchase Orders & Bills for one specific vendor, mirroring
    // customerOrdersAndInvoices above. Also a genuine, verified join — PO ->
    // XPURBILLGRNDTL (bill's GRN detail lines carry XBGPOID) -> XPURBILLHDR —
    // checked against live data: 1159/1275 GRN-detail rows with a non-zero
    // XBGPOID have their bill's vendor match the PO's vendor exactly (the
    // remainder are most likely consolidated/split bills, an existing data
    // quality quirk, not a join error). XBGPOID = '0' on ~20% of rows means
    // "not linked to a PO" and is excluded, same idea as XOH_BILLNO being
    // blank elsewhere in this data.
    vendorOrdersAndBills: (filtered) => `
      SELECT
        p.POHAUTOID AS poId,
        CONCAT(p.POHORDYEAR, '/', p.POHGRPCD, '/', p.POHORDNO) AS poNo,
        p.POHORDDT AS poDate,
        p.POHNETVAL AS poValue,
        CASE p.POHSTATUS
          WHEN 'C' THEN 'Closed'
          WHEN 'O' THEN 'Open'
          WHEN 'N' THEN 'New'
          WHEN 'D' THEN 'Cancelled'
          ELSE p.POHSTATUS
        END AS poStatus,
        bill.billNo,
        bill.billDate,
        bill.billAmount,
        bill.vendorBillNo
      FROM XPOHEAD p
      OUTER APPLY (
        SELECT DISTINCT CONCAT(b.XBHYEAR, '/', b.XBHGRP, '/', b.XBHNO) AS billNo, b.XBHDOCDT AS billDate, b.XBHACTBILLAMT AS billAmount, b.XBHVNDBILLNO AS vendorBillNo
        FROM XPURBILLGRNDTL g
        JOIN XPURBILLHDR b ON g.XBGREFID = b.XBHAUTOID
        WHERE g.XBGPOID = p.POHAUTOID AND g.XBGPOID <> '0'
      ) bill
      WHERE p.POHVNDCODE = @accountCode
      ${filtered ? 'AND p.POHORDDT >= @start AND p.POHORDDT < @end' : ''}
      ORDER BY p.POHORDDT DESC;
    `
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
      -- but didn't convert), O = Open (92% have no quotation yet — the other
      -- 8% do have one; XININQSTAT just wasn't flipped to 'Q' when the
      -- quotation was created, confirmed on 7 real rows), D = Dropped.
      -- statusLabel overrides 'O' to 'Quoted' whenever a link exists, so the
      -- displayed status always agrees with the Quotation No. column instead
      -- of showing "Open" next to a real quotation number. Action Items'
      -- pending.enquiries already keyed off the link (not this status field)
      -- so it wasn't affected by the same staleness.
      SELECT ${filtered ? '' : 'TOP 10'}
        i.XINAUTOID AS enquiryId,
        CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) AS enquiryNo,
        c.MCMCUSTNM AS customerName,
        i.XININQDT AS enquiryDate,
        i.XININQSTAT AS statusCode,
        CASE
          WHEN i.XININQSTAT = 'O' AND i.XINQTNID IS NOT NULL THEN 'Quoted'
          WHEN i.XININQSTAT = 'O' THEN 'Open'
          WHEN i.XININQSTAT = 'Q' THEN 'Quoted'
          WHEN i.XININQSTAT = 'R' THEN 'Lost / Regret'
          WHEN i.XININQSTAT = 'D' THEN 'Dropped'
          ELSE i.XININQSTAT
        END AS statusLabel,
        e.MEMEMPNAME AS salesperson,
        i.XINNXTFUP AS nextFollowUp,
        CASE WHEN i.XINQTNID IS NOT NULL THEN 'Quoted' ELSE 'Open' END AS quoteStatus,
        -- CONCAT() turns NULL args into '' rather than propagating NULL, so
        -- a plain CONCAT here would show "//" (not blank/—) for enquiries
        -- with no linked quotation, since qq's columns come from a LEFT JOIN.
        CASE WHEN qq.XQDAUTOID IS NULL THEN NULL ELSE CONCAT(qq.XQDQTNYEAR, '/', qq.XQDQTNGRP, '/', qq.XQDQTNNO) END AS quotationNo
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
      -- O = Open/pending (93% did NOT convert — the other 7% do have an
      -- order; XQDQNSTAT just wasn't flipped to 'R' when the order was
      -- placed, confirmed on 6 real FY2025-26 rows, same staleness as
      -- XININQSTAT on enquiries). XQDQUOSTATUS is a submission sub-status:
      -- SB = Submitted, NS = Not Submitted, CN = Cancelled.
      -- statusLabel overrides 'O' to 'Order Placed' whenever an order is
      -- actually linked, so the displayed status always agrees with the
      -- SO No. column instead of showing "Open" next to a real order
      -- number. Action Items' pending.quotations already keyed off the
      -- link (not this status field) so it wasn't affected.
      SELECT ${filtered ? '' : 'TOP 10'}
        q.XQDAUTOID AS quotationId,
        CONCAT(q.XQDQTNYEAR, '/', q.XQDQTNGRP, '/', q.XQDQTNNO) AS quotationNo,
        c.MCMCUSTNM AS customerName,
        q.XQDQTNDT AS quotationDate,
        q.XQDTOTDMCY AS quotationValue,
        q.XQDQNSTAT AS statusCode,
        CASE
          WHEN q.XQDQNSTAT = 'O' AND so.syncaxisOrderNo IS NOT NULL THEN 'Order Placed'
          WHEN q.XQDQNSTAT = 'O' THEN 'Open'
          WHEN q.XQDQNSTAT = 'R' THEN 'Order Placed'
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
      -- XOBORDSTAT labels — C is the default state for 89% of orders across
      -- the full date range (so most likely "Confirmed"). N is labelled
      -- 'Cancelled', not the original guess 'New' — see the note on
      -- finance.customerOrdersAndInvoices for the spot-check evidence
      -- (2/13 confirmed so far). Still VERIFY A/O if relying on those.
      -- XOBORDNO is the CUSTOMER's own PO/reference (values like "VERBAL" or
      -- a customer's SAP PO number confirm this) — it is NOT the SYNCAXIS
      -- sales order number. The real internal SO number is assembled from
      -- XOBIntOrdYr + XOBIntOrdGrp + XOBIntOrdNo (e.g. "26-27/SO/000098").
      SELECT ${filtered ? '' : 'TOP 10'}
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
          WHEN 'N' THEN 'Cancelled'
          WHEN 'D' THEN 'Deleted'
          WHEN 'O' THEN 'On Hold'
          ELSE o.XOBORDSTAT
        END AS statusLabel,
        e.MEMEMPNAME AS salesperson,
        inv.invoiceCount,
        inv.invoicedAmount,
        lastInv.lastInvoiceNo
      FROM XORDDTL o
      LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON o.XOBSPCODE = e.MEMEMPCODE
      OUTER APPLY (
        -- Order -> Order Acceptance Form -> invoice detail lines -> invoice
        -- header (verified: customer names match end-to-end on real data).
        -- DISTINCT on invoice header first, since XDCINVDTL has multiple
        -- line rows per invoice and would otherwise double-count amounts.
        -- invoicedAmount uses XDIHAMTTAX (tax-incl.) to match orderValue
        -- (o.XOBTOTDMCY, also tax-incl.) — see the note on pending.invoicing
        -- for why the tax-excl. XDIHAMT made fully-invoiced orders look
        -- partially invoiced here.
        SELECT COUNT(*) AS invoiceCount, SUM(XDIHAMTTAX) AS invoicedAmount
        FROM (
          SELECT DISTINCT ih.XDIHAUTOID, ih.XDIHAMTTAX
          FROM XOAFHDR oaf
          JOIN XDCINVDTL id ON id.XDIDOAFID = oaf.XOAFHAUTOID
          JOIN XDCINVHDR ih ON id.XDIDREFID = ih.XDIHAUTOID
          WHERE oaf.XOAFHORDID = o.XOBAUTOID
        ) DistinctInv
      ) inv
      OUTER APPLY (
        -- Separate APPLY (not folded into the aggregate above) because
        -- picking "the latest invoice's full number" needs an ORDER BY +
        -- TOP 1 on a real row, not an aggregate like MAX() — MAX() on a
        -- bare invoice number ignores year/group entirely and was also
        -- comparing across different invoice series as if they were one
        -- sortable sequence.
        SELECT TOP 1 CONCAT(ih.XDIHINVYR, '/', ih.XDIHINVGRP, '/', ih.XDIHINVNO) AS lastInvoiceNo
        FROM XOAFHDR oaf
        JOIN XDCINVDTL id ON id.XDIDOAFID = oaf.XOAFHAUTOID
        JOIN XDCINVHDR ih ON id.XDIDREFID = ih.XDIHAUTOID
        WHERE oaf.XOAFHORDID = o.XOBAUTOID
        ORDER BY ih.XDIHINVDT DESC
      ) lastInv
      ${filtered ? 'WHERE o.XOBORDDT >= @start AND o.XOBORDDT < @end' : ''}
      ORDER BY o.XOBORDDT DESC;
    `,
    recentInvoices: (filtered) => `
      -- XDCINVHDR, not XINVHDR (empty) — see the note on the sales queries.
      -- XDIHSTATUS values seen: 'O' (97%) and 'N' (3%) — 'O' -> 'Open' by
      -- convention with POHSTATUS/XGRNHSTATUS elsewhere in this database
      -- (both reliably use 'O' for that); 'N' is left as the raw code since
      -- it's NOT consistent across this schema (means 'Cancelled' on
      -- XOBORDSTAT, 'New' on POHSTATUS) and nothing else on this table
      -- disambiguates it — PENDING VERIFICATION directly against SourcePro.
      -- Salesperson/customer-PO fields on this table are blank for every
      -- row in this data, so they're not included here.
      -- Sales order traced back via Invoice -> XDCINVDTL -> XOAFHDR -> Order
      -- (same chain used forward on the orders table); confirmed no invoice
      -- in this data spans more than one distinct order, so TOP 1 is safe.
      SELECT ${filtered ? '' : 'TOP 10'}
        h.XDIHAUTOID AS invoiceId,
        CONCAT(h.XDIHINVYR, '/', h.XDIHINVGRP, '/', h.XDIHINVNO) AS invoiceNo,
        c.MCMCUSTNM AS customerName,
        h.XDIHINVDT AS invoiceDate,
        h.XDIHAMT AS invoiceValue,
        h.XDIHSTATUS AS statusCode,
        CASE h.XDIHSTATUS WHEN 'O' THEN 'Open' ELSE h.XDIHSTATUS END AS statusLabel,
        so.orderId,
        so.syncaxisOrderNo
      FROM XDCINVHDR h
      LEFT JOIN MCUSTMST c ON h.XDIHCUSTCD = c.MCMCUSTCD
      OUTER APPLY (
        SELECT TOP 1 o.XOBAUTOID AS orderId, CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo
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
    // Item names via XORDITMDLV (order line item) -> MITMMAST. XORDAUTOID
    // matches XOBAUTOID (order header id) directly — verified an order with
    // 3 line items (XOBAUTOID 10292) resolves all 3 correctly. Several
    // distinct items per order are common, so aggregated with STRING_AGG,
    // same pattern used for issue/despatch/invoice lines elsewhere in this
    // file, rather than exploding into one row per item.
    orderList: (search, month) => {
      const conditions = [];
      if (search) {
        conditions.push(`(c.MCMCUSTNM LIKE '%' + @search + '%'
          OR o.XOBORDNO LIKE '%' + @search + '%'
          OR CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) LIKE '%' + @search + '%')`);
      }
      if (month) conditions.push('o.XOBORDDT >= @start AND o.XOBORDDT < @end');
      return `
        SELECT ${search || month ? '' : 'TOP 10'}
          o.XOBAUTOID AS orderId,
          CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo,
          o.XOBORDNO AS customerRefNo,
          c.MCMCUSTNM AS customerName,
          o.XOBORDDT AS orderDate,
          o.XOBTOTDMCY AS orderValue,
          o.XOBORDSTAT AS statusCode,
          CASE o.XOBORDSTAT
            WHEN 'C' THEN 'Confirmed' WHEN 'A' THEN 'Amended' WHEN 'N' THEN 'Cancelled'
            WHEN 'D' THEN 'Deleted' WHEN 'O' THEN 'On Hold' ELSE o.XOBORDSTAT
          END AS statusLabel,
          items.itemNames
        FROM XORDDTL o
        LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
        OUTER APPLY (
          SELECT STRING_AGG(itemName, ', ') AS itemNames
          FROM (
            SELECT DISTINCT LTRIM(RTRIM(REPLACE(REPLACE(m.MIMNAME, CHAR(13), ''), CHAR(10), ''))) AS itemName
            FROM XORDITMDLV d
            LEFT JOIN MITMMAST m ON d.XORDSITMCD = m.MIMITMICOD
            WHERE d.XORDAUTOID = o.XOBAUTOID
          ) x
        ) items
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        ORDER BY o.XOBORDDT DESC;
      `;
    },
    // True cross-document search for the "Order Lineage" (new, search-only)
    // page: one term can match at the SO/customer/PO level directly, or at
    // any of the three documents that feed into an order, each resolved
    // back to its order via the same links already verified elsewhere in
    // this file — Quotation via XOBQTNID (recentQuotations), Enquiry via
    // Quotation.XQDINQID (recentEnquiries/pending.enquiries), Invoice via
    // OAF -> XDCINVDTL -> XDCINVHDR (lineage.invoices/pending.invoicing).
    // UNION (not UNION ALL) inside MatchedOrderIds so an order matched via
    // more than one path (e.g. its own SO number AND its invoice number
    // both contain the typed digits) only appears once.
    //
    // Also matches quotations and enquiries that never made it to an order
    // — Action Items' "pending Quotation"/"pending Sales Order" lists are
    // full of these, and a search box that can't find them isn't a *global*
    // search. Each is its own kind (order/quotation/enquiry) with its own
    // detail endpoint (see server.js /api/lineage/{order,quotation,enquiry}
    // /:id and headerByQuotation/headerByEnquiry below) since there's no
    // order row to key a lineage view off yet. The quotation branch only
    // includes quotations with NOT EXISTS an order (otherwise it'd
    // double-list something the order branch above already found via its
    // own quotation-number match), and the enquiry branch the same via any
    // of its quotations.
    globalSearch: `
      WITH MatchedOrderIds AS (
        SELECT o.XOBAUTOID AS orderId
        FROM XORDDTL o
        LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
        WHERE c.MCMCUSTNM LIKE '%' + @search + '%'
           OR o.XOBORDNO LIKE '%' + @search + '%'
           OR CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) LIKE '%' + @search + '%'

        UNION

        SELECT o.XOBAUTOID
        FROM XORDDTL o
        JOIN XQTNDTL q ON o.XOBQTNID = q.XQDAUTOID
        WHERE CONCAT(q.XQDQTNYEAR, '/', q.XQDQTNGRP, '/', q.XQDQTNNO) LIKE '%' + @search + '%'

        UNION

        SELECT o.XOBAUTOID
        FROM XORDDTL o
        JOIN XQTNDTL q ON o.XOBQTNID = q.XQDAUTOID
        JOIN XINQDTL i ON q.XQDINQID = i.XINAUTOID
        WHERE CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) LIKE '%' + @search + '%'

        UNION

        SELECT o.XOBAUTOID
        FROM XORDDTL o
        JOIN XOAFHDR oaf ON oaf.XOAFHORDID = o.XOBAUTOID
        JOIN XDCINVDTL id ON id.XDIDOAFID = oaf.XOAFHAUTOID
        JOIN XDCINVHDR ih ON id.XDIDREFID = ih.XDIHAUTOID
        WHERE ih.XDIHINVNO LIKE '%' + @search + '%'
           OR CONCAT(ih.XDIHINVYR, '/', ih.XDIHINVGRP, '/', ih.XDIHINVNO) LIKE '%' + @search + '%'
      )
      SELECT TOP 50 * FROM (
        SELECT
          'order' AS kind,
          o.XOBAUTOID AS id,
          CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS docNo,
          o.XOBORDNO AS customerRefNo,
          c.MCMCUSTNM AS customerName,
          o.XOBORDDT AS docDate,
          o.XOBTOTDMCY AS docValue,
          CASE o.XOBORDSTAT
            WHEN 'C' THEN 'Confirmed' WHEN 'A' THEN 'Amended' WHEN 'N' THEN 'Cancelled'
            WHEN 'D' THEN 'Deleted' WHEN 'O' THEN 'On Hold' ELSE o.XOBORDSTAT
          END AS statusLabel,
          items.itemNames
        FROM MatchedOrderIds mo
        JOIN XORDDTL o ON o.XOBAUTOID = mo.orderId
        LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
        OUTER APPLY (
          SELECT STRING_AGG(itemName, ', ') AS itemNames
          FROM (
            SELECT DISTINCT LTRIM(RTRIM(REPLACE(REPLACE(m.MIMNAME, CHAR(13), ''), CHAR(10), ''))) AS itemName
            FROM XORDITMDLV d
            LEFT JOIN MITMMAST m ON d.XORDSITMCD = m.MIMITMICOD
            WHERE d.XORDAUTOID = o.XOBAUTOID
          ) x
        ) items

        UNION ALL

        SELECT
          'quotation' AS kind,
          q.XQDAUTOID AS id,
          CONCAT(q.XQDQTNYEAR, '/', q.XQDQTNGRP, '/', q.XQDQTNNO) AS docNo,
          NULL AS customerRefNo,
          c.MCMCUSTNM AS customerName,
          q.XQDQTNDT AS docDate,
          q.XQDTOTDMCY AS docValue,
          'Quoted — no order yet' AS statusLabel,
          NULL AS itemNames
        FROM XQTNDTL q
        LEFT JOIN MCUSTMST c ON q.XQDCUSTCD = c.MCMCUSTCD
        LEFT JOIN XINQDTL i ON q.XQDINQID = i.XINAUTOID
        WHERE (CONCAT(q.XQDQTNYEAR, '/', q.XQDQTNGRP, '/', q.XQDQTNNO) LIKE '%' + @search + '%'
               OR c.MCMCUSTNM LIKE '%' + @search + '%'
               OR CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) LIKE '%' + @search + '%')
          AND NOT EXISTS (SELECT 1 FROM XORDDTL o WHERE o.XOBQTNID = q.XQDAUTOID)

        UNION ALL

        SELECT
          'enquiry' AS kind,
          i.XINAUTOID AS id,
          CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) AS docNo,
          NULL AS customerRefNo,
          c.MCMCUSTNM AS customerName,
          i.XININQDT AS docDate,
          NULL AS docValue,
          'Lead — no quotation yet' AS statusLabel,
          NULL AS itemNames
        FROM XINQDTL i
        LEFT JOIN MCUSTMST c ON i.XINCUSTCD = c.MCMCUSTCD
        WHERE (CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) LIKE '%' + @search + '%'
               OR c.MCMCUSTNM LIKE '%' + @search + '%')
          -- Excludes any lead that already has a quotation at all (not just
          -- one that went on to become an order) — a lead that's already
          -- been quoted isn't its own dead-end result, it's part of that
          -- quotation's lineage. Without this a lead+quotation pair (e.g.
          -- 26-27/SI/000089 -> 26-27/SQ/000093) showed up as two separate,
          -- inconsistent search hits: clicking the lead showed only the
          -- lead, clicking the quotation showed lead+quotation both.
          AND NOT EXISTS (SELECT 1 FROM XQTNDTL q2 WHERE q2.XQDINQID = i.XINAUTOID)

        UNION ALL

        -- Purchase side — a separate, short chain (PO -> GRN -> Bill), not
        -- part of the Enquiry->Invoice sales chain above. See
        -- headerByPurchaseOrder for the full detail-view query.
        SELECT
          'purchaseOrder' AS kind,
          p.POHAUTOID AS id,
          CONCAT(p.POHORDYEAR, '/', p.POHGRPCD, '/', p.POHORDNO) AS docNo,
          NULL AS customerRefNo,
          v.MVmName AS customerName,
          p.POHORDDT AS docDate,
          p.POHNETVAL AS docValue,
          CASE p.POHSTATUS
            WHEN 'C' THEN 'Closed' WHEN 'O' THEN 'Open' WHEN 'N' THEN 'New' WHEN 'D' THEN 'Cancelled'
            ELSE p.POHSTATUS
          END AS statusLabel,
          NULL AS itemNames
        FROM XPOHEAD p
        LEFT JOIN MVNDMAST v ON p.POHVNDCODE = v.MVmVndCode
        WHERE CONCAT(p.POHORDYEAR, '/', p.POHGRPCD, '/', p.POHORDNO) LIKE '%' + @search + '%'
           OR v.MVmName LIKE '%' + @search + '%'
      ) results
      ORDER BY docDate DESC;
    `,
    // Detail-view headers for a search hit that stopped short of becoming an
    // order (kind='quotation'/'enquiry' above) — same field *names* as
    // lineage.header's enquiry/quotation columns so renderLineageTimeline()
    // on the client needs no kind-specific branching, just orderId/oafId
    // left absent so those stages render as their existing empty state.
    headerByQuotation: `
      SELECT
        i.XINAUTOID AS enquiryId,
        CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) AS enquiryNo,
        i.XININQDT AS enquiryDate,
        q.XQDAUTOID AS quotationId,
        CONCAT(q.XQDQTNYEAR, '/', q.XQDQTNGRP, '/', q.XQDQTNNO) AS quotationNo,
        q.XQDQTNDT AS quotationDate,
        q.XQDTOTDMCY AS quotationValue,
        c.MCMCUSTNM AS customerName,
        e.MEMEMPNAME AS salesperson
      FROM XQTNDTL q
      LEFT JOIN XINQDTL i ON q.XQDINQID = i.XINAUTOID
      LEFT JOIN MCUSTMST c ON q.XQDCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON q.XQNSPCODE = e.MEMEMPCODE
      WHERE q.XQDAUTOID = @quotationId;
    `,
    customerARByQuotation: `
      SELECT
        ISNULL(SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM), 0) AS receivable,
        COUNT(*) AS outstandingEntries
      FROM XOUTSTNDHDR
      WHERE XOH_DR_CR = 'D'
        AND XOH_ACCCD = (SELECT XQDCUSTCD FROM XQTNDTL WHERE XQDAUTOID = @quotationId);
    `,
    headerByEnquiry: `
      SELECT
        i.XINAUTOID AS enquiryId,
        CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) AS enquiryNo,
        i.XININQDT AS enquiryDate,
        c.MCMCUSTNM AS customerName,
        e.MEMEMPNAME AS salesperson
      FROM XINQDTL i
      LEFT JOIN MCUSTMST c ON i.XINCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON i.XINSPCODE = e.MEMEMPCODE
      WHERE i.XINAUTOID = @enquiryId;
    `,
    customerARByEnquiry: `
      SELECT
        ISNULL(SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM), 0) AS receivable,
        COUNT(*) AS outstandingEntries
      FROM XOUTSTNDHDR
      WHERE XOH_DR_CR = 'D'
        AND XOH_ACCCD = (SELECT XINCUSTCD FROM XINQDTL WHERE XINAUTOID = @enquiryId);
    `,
    // ---- Purchase-side lineage (PO -> GRN -> Bill -> Vendor Settlement) ----
    // A separate, much shorter chain from the sales-side one above — reuses
    // the same verified joins already proven out in queries.purchase
    // (materialReceived: GRN->PO via XGRNDTL.XGRNDPOID) and
    // finance.vendorOrdersAndBills (Bill->PO via XPURBILLGRNDTL.XBGPOID).
    // POHSTATUS is a real, verified status field here (unlike sales
    // XOBORDSTAT) — see the note on purchase.orders: 'C'=Closed correlates
    // 100% with a populated close date + linked GRN, 'D'=Cancelled.
    headerByPurchaseOrder: `
      SELECT
        p.POHAUTOID AS poId,
        CONCAT(p.POHORDYEAR, '/', p.POHGRPCD, '/', p.POHORDNO) AS poNo,
        p.POHORDDT AS poDate,
        p.POHNETVAL AS poValue,
        p.POHRCPVAL AS receivedValue,
        p.POHSTATUS AS statusCode,
        CASE p.POHSTATUS
          WHEN 'C' THEN 'Closed' WHEN 'O' THEN 'Open' WHEN 'N' THEN 'New' WHEN 'D' THEN 'Cancelled'
          ELSE p.POHSTATUS
        END AS statusLabel,
        v.MVmName AS vendorName,
        p.POHVNDCODE AS vendorCode
      FROM XPOHEAD p
      LEFT JOIN MVNDMAST v ON p.POHVNDCODE = v.MVmVndCode
      WHERE p.POHAUTOID = @poId;
    `,
    grnByPurchaseOrder: `
      SELECT DISTINCT
        h.XGRNHAUTOID AS grnId,
        CONCAT(h.XGRNHORDYR, '/', h.XGRNHGRPCD, '/', h.XGRNHORDNO) AS grnNo,
        h.XGRNHORDDT AS receiptDate,
        h.XGRNHCHALNO AS vendorChallanNo,
        h.XGRNHCHALDT AS vendorChallanDate,
        CASE h.XGRNHSTATUS WHEN 'O' THEN 'Open' WHEN 'D' THEN 'Cancelled' ELSE h.XGRNHSTATUS END AS statusLabel
      FROM XGRNDTL d
      JOIN XGRNHDR h ON h.XGRNHAUTOID = d.XGRNDAUTOID
      WHERE d.XGRNDPOID = @poId
      ORDER BY h.XGRNHORDDT;
    `,
    billsByPurchaseOrder: `
      SELECT DISTINCT
        b.XBHAUTOID AS billId,
        CONCAT(b.XBHYEAR, '/', b.XBHGRP, '/', b.XBHNO) AS billNo,
        b.XBHDOCDT AS billDate,
        b.XBHACTBILLAMT AS billAmount,
        b.XBHVNDBILLNO AS vendorBillNo
      FROM XPURBILLGRNDTL g
      JOIN XPURBILLHDR b ON g.XBGREFID = b.XBHAUTOID
      WHERE g.XBGPOID = @poId AND g.XBGPOID <> '0'
      ORDER BY b.XBHDOCDT;
    `,
    // Mirrors lineage.customerAR, payable side: XOH_DR_CR='C'. XOH_ACCCD ->
    // MVmVndCode is UNVERIFIED here (see the note on finance.creditors) —
    // shown anyway since it's the same account-level best-effort the
    // sales-side Financial Settlement stage already makes for receivables.
    vendorAPByPurchaseOrder: `
      SELECT
        ISNULL(SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM), 0) AS payable,
        COUNT(*) AS outstandingEntries
      FROM XOUTSTNDHDR
      WHERE XOH_DR_CR = 'C'
        AND XOH_ACCCD = (SELECT POHVNDCODE FROM XPOHEAD WHERE POHAUTOID = @poId);
    `,
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
        -- N -> 'Cancelled', see the note on finance.customerOrdersAndInvoices
        CASE o.XOBORDSTAT
          WHEN 'C' THEN 'Confirmed' WHEN 'A' THEN 'Amended' WHEN 'N' THEN 'Cancelled'
          WHEN 'D' THEN 'Deleted' WHEN 'O' THEN 'On Hold' ELSE o.XOBORDSTAT
        END AS statusLabel,
        c.MCMCUSTNM AS customerName,
        o.XOBCUSTCD AS customerCode,
        e.MEMEMPNAME AS salesperson,
        q.XQDAUTOID AS quotationId,
        CONCAT(q.XQDQTNYEAR, '/', q.XQDQTNGRP, '/', q.XQDQTNNO) AS quotationNo,
        q.XQDQTNDT AS quotationDate,
        q.XQDTOTDMCY AS quotationValue,
        i.XINAUTOID AS enquiryId,
        CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) AS enquiryNo,
        i.XININQDT AS enquiryDate,
        oaf.XOAFHAUTOID AS oafId,
        CONCAT(oaf.XOAFHYEAR, '/', oaf.XOAFHGRPCD, '/', oaf.XOAFHNO) AS oafNo,
        oaf.XOAFHDATE AS oafDate,
        items.itemNames
      FROM XORDDTL o
      LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
      LEFT JOIN MEMPMST e ON o.XOBSPCODE = e.MEMEMPCODE
      LEFT JOIN XQTNDTL q ON o.XOBQTNID = q.XQDAUTOID
      LEFT JOIN XINQDTL i ON q.XQDINQID = i.XINAUTOID
      LEFT JOIN XOAFHDR oaf ON oaf.XOAFHORDID = o.XOBAUTOID
      OUTER APPLY (
        SELECT STRING_AGG(itemName, ', ') AS itemNames
        FROM (
          SELECT DISTINCT LTRIM(RTRIM(REPLACE(REPLACE(m.MIMNAME, CHAR(13), ''), CHAR(10), ''))) AS itemName
          FROM XORDITMDLV d
          LEFT JOIN MITMMAST m ON d.XORDSITMCD = m.MIMITMICOD
          WHERE d.XORDAUTOID = o.XOBAUTOID
        ) x
      ) items
      WHERE o.XOBAUTOID = @orderId;
    `,
    // XSHSITMCD/XWOITMCD join straight to MITMMAST.MIMITMICOD (verified) —
    // one item per SJO/work-order row, so a plain LEFT JOIN is enough here,
    // unlike the STRING_AGG needed below for issue/despatch/invoice lines
    // (which can carry several different items per document).
    shopJobOrders: `
      SELECT
        s.XSHSJAUTONO AS sjoId,
        CONCAT(s.XSHSJOYEAR, '/', s.XSHSJOGRP, '/', s.XSHSJONO) AS sjoNo,
        s.XSHSITMCD AS itemCode,
        LTRIM(RTRIM(REPLACE(REPLACE(m.MIMNAME, CHAR(13), ''), CHAR(10), ''))) AS itemName,
        s.XSHORDQTY AS orderedQty,
        s.XSHCOMPQTY AS completedQty,
        s.XSHSJOSTAT AS statusCode,
        -- 5 values seen: F=487 rows (100% have XSHORDQTY<=XSHCOMPQTY, i.e.
        -- fully completed — confirms 'F'=Finished, and confirms the "done"
        -- vs "partial" dot the lineage timeline already inferred from this
        -- code, see dashboardCurrentStage below), D=11 (0% complete,
        -- Cancelled by the same convention as every other status field in
        -- this schema). N/P/W (65/3/7 rows) are NOT independently verified
        -- — labelled as the plausible expansion of the letter itself
        -- (New/Partial/Work in progress), all 0% complete, consistent with
        -- "not yet finished" but not distinguished further than that.
        CASE s.XSHSJOSTAT
          WHEN 'F' THEN 'Finished' WHEN 'D' THEN 'Cancelled'
          WHEN 'N' THEN 'New' WHEN 'P' THEN 'Partial' WHEN 'W' THEN 'Work in Progress'
          ELSE s.XSHSJOSTAT
        END AS statusLabel,
        s.XSHSJODT AS sjoDate,
        s.XSHCMPLTDT AS completedDate
      FROM XOAFHDR oaf
      JOIN XSJOHDR s ON s.XSHOAFID = oaf.XOAFHAUTOID
      LEFT JOIN MITMMAST m ON s.XSHSITMCD = m.MIMITMICOD
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY s.XSHSJODT;
    `,
    production: `
      SELECT
        CASE WHEN wo.XWOAUTOID IS NULL THEN NULL ELSE CONCAT(wo.XWOYR, '/', wo.XWOGRCD, '/', wo.XWONO) END AS workOrderNo,
        wo.XWOITMCD AS itemCode,
        LTRIM(RTRIM(REPLACE(REPLACE(m.MIMNAME, CHAR(13), ''), CHAR(10), ''))) AS itemName,
        wo.XWOQTYORD AS orderedQty,
        wo.XWOQTYRECV AS receivedQty,
        wo.XWOSTATUS AS statusCode,
        -- 4 values seen, cross-checked against XWOCLOSDT/qty-received:
        -- C=489 rows, 100% have a close date AND full receipt -> 'Closed'
        -- (matches the "done" dot the lineage timeline already infers from
        -- this code, see the JS side). O=4 rows, 0% close date/0% received
        -- -> genuinely still 'Open'. D=8 rows, 0% either -> 'Cancelled' by
        -- the same convention as every other status field in this schema.
        -- N=22 rows is the interesting one: ALL 22 have a close date (like
        -- C) but NONE are fully received (like O/D) — i.e. manually closed
        -- before completion, not "New" as the letter might suggest.
        -- Labelled 'Short Closed' on that data pattern, not confirmed
        -- against SourcePro's own screen.
        CASE wo.XWOSTATUS
          WHEN 'C' THEN 'Closed' WHEN 'O' THEN 'Open' WHEN 'D' THEN 'Cancelled' WHEN 'N' THEN 'Short Closed'
          ELSE wo.XWOSTATUS
        END AS statusLabel,
        wo.XWODT AS workOrderDate,
        wo.XWOCLOSDT AS closedDate,
        wr.XWRHRCPQTY AS receiptQty,
        wr.XWRHWODT AS receiptDate,
        CONCAT(s.XSHSJOYEAR, '/', s.XSHSJOGRP, '/', s.XSHSJONO) AS sjoNo
      FROM XOAFHDR oaf
      JOIN XSJOHDR s ON s.XSHOAFID = oaf.XOAFHAUTOID
      JOIN XWORCPHDR wr ON wr.XWRHSJOID = s.XSHSJAUTONO
      LEFT JOIN XWOHDR wo ON wo.XWOAUTOID = wr.XWRHWOREFID
      LEFT JOIN MITMMAST m ON wo.XWOITMCD = m.MIMITMICOD
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY wr.XWRHWODT;
    `,
    // Item names via XISSDTL (issue line) -> XIDSTKID -> XSTKIDEN -> MITMMAST
    // (same stock-identity join used by the Inventory queries). One issue
    // header can have several line items (verified: up to 3+ distinct items
    // per issue in this data), so they're STRING_AGG'd into one column
    // rather than exploding this into a line-level table, keeping the same
    // one-row-per-document shape as every other lineage sub-list. A few
    // MIMNAME values in this data carry a stray trailing newline — stripped
    // explicitly since RTRIM only trims spaces, not CHAR(10)/CHAR(13).
    storeIssues: `
      SELECT
        i.XIHISSNO AS issueNo,
        i.XIHISSDT AS issueDate,
        i.XIHSTATUS AS statusCode,
        -- Only 2 values (930 'O', 20 'D'). O=Open/D=Cancelled by the same
        -- convention verified on POHSTATUS/XGRNHSTATUS/XBHSTATUS elsewhere.
        CASE i.XIHSTATUS WHEN 'O' THEN 'Open' WHEN 'D' THEN 'Cancelled' ELSE i.XIHSTATUS END AS statusLabel,
        CONCAT(s.XSHSJOYEAR, '/', s.XSHSJOGRP, '/', s.XSHSJONO) AS sjoNo,
        items.itemNames
      FROM XOAFHDR oaf
      JOIN XSJOHDR s ON s.XSHOAFID = oaf.XOAFHAUTOID
      JOIN XISSHDR i ON i.XIHDOCID = s.XSHSJAUTONO AND i.XIHSJOWOTYP = 'S'
      OUTER APPLY (
        SELECT STRING_AGG(itemName, ', ') AS itemNames
        FROM (
          SELECT DISTINCT LTRIM(RTRIM(REPLACE(REPLACE(m.MIMNAME, CHAR(13), ''), CHAR(10), ''))) AS itemName
          FROM XISSDTL d
          LEFT JOIN XSTKIDEN si ON d.XIDSTKID = si.XSIAUTOID
          LEFT JOIN MITMMAST m ON si.XSIITMCD = m.MIMITMICOD
          WHERE d.XIDISSID = i.XIHAUTOID
        ) x
      ) items
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY i.XIHISSDT;
    `,
    despatchChallans: `
      -- Plain Delivery Challan — only populated for a minority of orders in
      -- this data (17 headers total). When empty for an order, despatch
      -- happened via the combined dispatch-cum-invoice document instead
      -- (see the invoices query below).
      -- XDCDSITMCD (the item-code column on the detail line) is NULL on
      -- every row in this data — item is resolved the same indirect way as
      -- Store Issues instead: XDCDSTKID -> XSTKIDEN -> MITMMAST (verified
      -- 22/22 sampled lines resolve this way).
      SELECT DISTINCT
        h.XDCHDCNO AS challanNo,
        h.XDCHDATE AS challanDate,
        h.XDCHSTAT AS statusCode,
        -- Tiny sample (17 headers total): O=8, C=8, N=1. O=Open/C=Closed by
        -- the convention verified elsewhere; 'N' left as the raw code — on
        -- XWOSTATUS 'N' turned out NOT to mean "New" (see that query's
        -- comment), so it's not assumed here on a single-row sample either.
        CASE h.XDCHSTAT WHEN 'O' THEN 'Open' WHEN 'C' THEN 'Closed' ELSE h.XDCHSTAT END AS statusLabel,
        items.itemNames
      FROM XOAFHDR oaf
      JOIN XDCDTL d ON d.XDCDOAFID = oaf.XOAFHAUTOID
      JOIN XDCHDR h ON d.XDCDHID = h.XDCHAUTOID
      OUTER APPLY (
        SELECT STRING_AGG(itemName, ', ') AS itemNames
        FROM (
          SELECT DISTINCT LTRIM(RTRIM(REPLACE(REPLACE(m.MIMNAME, CHAR(13), ''), CHAR(10), ''))) AS itemName
          FROM XDCDTL d2
          LEFT JOIN XSTKIDEN si ON d2.XDCDSTKID = si.XSIAUTOID
          LEFT JOIN MITMMAST m ON si.XSIITMCD = m.MIMITMICOD
          WHERE d2.XDCDHID = h.XDCHAUTOID
        ) x
      ) items
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY h.XDCHDATE;
    `,
    // XDIDITMCD joins straight to MITMMAST.MIMITMICOD (verified) — unlike
    // Store Issues/Despatch, no XSTKIDEN indirection needed here.
    invoices: `
      -- invoiceValue uses XDIHAMTTAX (tax-incl.) to match what SourcePro's
      -- own DC-cum-Invoice screen calls "Total Amount with Taxes", and what
      -- this order's XOBTOTDMCY represents — see pending.invoicing for why
      -- XDIHAMT (excl. tax) makes a fully-invoiced order look short.
      SELECT DISTINCT
        ih.XDIHAUTOID AS invoiceId,
        CONCAT(ih.XDIHINVYR, '/', ih.XDIHINVGRP, '/', ih.XDIHINVNO) AS invoiceNo,
        ih.XDIHINVDT AS invoiceDate,
        ih.XDIHAMTTAX AS invoiceValue,
        ih.XDIHSTATUS AS statusCode,
        -- XDIHSTATUS: 'O' -> 'Open' (safe by convention, see recentInvoices
        -- above); 'N' left as the raw code — unverified, see that note.
        CASE ih.XDIHSTATUS WHEN 'O' THEN 'Open' ELSE ih.XDIHSTATUS END AS statusLabel,
        items.itemNames
      FROM XOAFHDR oaf
      JOIN XDCINVDTL d ON d.XDIDOAFID = oaf.XOAFHAUTOID
      JOIN XDCINVHDR ih ON d.XDIDREFID = ih.XDIHAUTOID
      OUTER APPLY (
        SELECT STRING_AGG(itemName, ', ') AS itemNames
        FROM (
          SELECT DISTINCT LTRIM(RTRIM(REPLACE(REPLACE(m.MIMNAME, CHAR(13), ''), CHAR(10), ''))) AS itemName
          FROM XDCINVDTL d2
          LEFT JOIN MITMMAST m ON d2.XDIDITMCD = m.MIMITMICOD
          WHERE d2.XDIDREFID = ih.XDIHAUTOID
        ) x
      ) items
      WHERE oaf.XOAFHORDID = @orderId
      ORDER BY ih.XDIHINVDT;
    `,
    customerAR: `
      -- Account-level, NOT specific to this order/invoice — see module note.
      -- outstandingEntries counts only the 'D' (receivable) rows, matching
      -- the WHERE filter, not COUNT(*) over the account's whole ledger —
      -- that used to include 'C' (payment/credit) rows too, so a customer
      -- with 2 receivable entries and 2 payments against them showed
      -- "...across 4 entries" next to a total that only 2 of them made up.
      SELECT
        ISNULL(SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM), 0) AS receivable,
        COUNT(*) AS outstandingEntries
      FROM XOUTSTNDHDR
      WHERE XOH_DR_CR = 'D'
        AND XOH_ACCCD = (SELECT XOBCUSTCD FROM XORDDTL WHERE XOBAUTOID = @orderId);
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
    // XWOSTATUS labels cross-checked against XWOCLOSDT/qty-received — see
    // the full reasoning on lineage.production's copy of this same CASE.
    statusBreakdown: `
      SELECT
        XWOSTATUS AS statusCode,
        CASE XWOSTATUS
          WHEN 'C' THEN 'Closed' WHEN 'O' THEN 'Open' WHEN 'D' THEN 'Cancelled' WHEN 'N' THEN 'Short Closed'
          ELSE XWOSTATUS
        END AS statusLabel,
        COUNT(*) AS count
      FROM XWOHDR
      GROUP BY XWOSTATUS
      ORDER BY count DESC;
    `,
    // XSHSJOSTAT labels cross-checked against qty-complete — see the full
    // reasoning on lineage.shopJobOrders' copy of this same CASE.
    sjoStatus: `
      SELECT
        XSHSJOSTAT AS statusCode,
        CASE XSHSJOSTAT
          WHEN 'F' THEN 'Finished' WHEN 'D' THEN 'Cancelled'
          WHEN 'N' THEN 'New' WHEN 'P' THEN 'Partial' WHEN 'W' THEN 'Work in Progress'
          ELSE XSHSJOSTAT
        END AS statusLabel,
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
      SELECT ${filtered ? '' : 'TOP 10'}
        oaf.XOAFHAUTOID AS oafId,
        CONCAT(oaf.XOAFHYEAR, '/', oaf.XOAFHGRPCD, '/', oaf.XOAFHNO) AS oafNo,
        oaf.XOAFHDATE AS oafDate,
        o.XOBAUTOID AS orderId,
        CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS syncaxisOrderNo,
        c.MCMCUSTNM AS customerName
      FROM XOAFHDR oaf
      LEFT JOIN XORDDTL o ON o.XOBAUTOID = oaf.XOAFHORDID
      LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
      ${filtered ? 'WHERE oaf.XOAFHDATE >= @start AND oaf.XOAFHDATE < @end' : ''}
      ORDER BY oaf.XOAFHDATE DESC;
    `,
    workOrders: (filtered) => `
      SELECT ${filtered ? '' : 'TOP 10'}
        w.XWOAUTOID AS woId,
        CONCAT(w.XWOYR, '/', w.XWOGRCD, '/', w.XWONO) AS woNo,
        w.XWOITMCD AS itemCode,
        w.XWODT AS orderDate,
        w.XWODUEDT AS dueDate,
        w.XWOQTYORD AS orderedQty,
        w.XWOQTYRECV AS receivedQty,
        w.XWOSTATUS AS statusCode,
        CASE w.XWOSTATUS
          WHEN 'C' THEN 'Closed' WHEN 'O' THEN 'Open' WHEN 'D' THEN 'Cancelled' WHEN 'N' THEN 'Short Closed'
          ELSE w.XWOSTATUS
        END AS statusLabel,
        w.XWOCLOSDT AS closedDate
      FROM XWOHDR w
      ${filtered ? 'WHERE w.XWODT >= @start AND w.XWODT < @end' : ''}
      ORDER BY w.XWODT DESC;
    `,
    // XIHSJOWOTYP = 'S' filter matches lineage.storeIssues — no 'W'-typed
    // (direct-to-work-order) issues exist in this data, only SJO-linked ones.
    materialIssued: (filtered) => `
      SELECT ${filtered ? '' : 'TOP 10'}
        i.XIHAUTOID AS issueId,
        i.XIHISSNO AS issueNo,
        i.XIHISSDT AS issueDate,
        CONCAT(s.XSHSJOYEAR, '/', s.XSHSJOGRP, '/', s.XSHSJONO) AS sjoNo,
        i.XIHSTATUS AS statusCode,
        CASE i.XIHSTATUS WHEN 'O' THEN 'Open' WHEN 'D' THEN 'Cancelled' ELSE i.XIHSTATUS END AS statusLabel
      FROM XISSHDR i
      LEFT JOIN XSJOHDR s ON i.XIHDOCID = s.XSHSJAUTONO AND i.XIHSJOWOTYP = 'S'
      WHERE i.XIHSJOWOTYP = 'S'
      ${filtered ? 'AND i.XIHISSDT >= @start AND i.XIHISSDT < @end' : ''}
      ORDER BY i.XIHISSDT DESC;
    `,
    // "Project ready" = fully received (see monthlyBreakdown comment above).
    readyWorkOrders: (filtered) => `
      SELECT ${filtered ? '' : 'TOP 10'}
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
  },

  // ---------------- ACTION ITEMS: where the pipeline is stuck ----------------
  // One "not yet converted to the next stage" list per handoff point:
  //   Enquiry -> Quotation -> Sales Order -> Work Order/SJO -> Invoice -> Paid
  //   Purchase Order -> GRN/Closed
  // Every join here reuses a chain already verified elsewhere in this file
  // (see crm.recentOrders/recentInvoices and lineage.production) — nothing
  // new or unverified. "Dead" statuses (Dropped enquiries, Deleted/Cancelled
  // orders and POs) are excluded throughout: they're closed out, not stuck.
  pending: {
    // Open enquiries (XININQSTAT='O') with no linked quotation at all.
    // XININQSTAT='D' (Dropped, 5 rows in this data) is excluded — already
    // dead, not a pending action. Verified via XQDINQID (enquiry->quotation
    // link): 'Q' status enquiries have a quotation 146/146 of the time.
    enquiries: `
      SELECT
        i.XINAUTOID AS enquiryId,
        CONCAT(i.XININQYR, '/', i.XININQGRP, '/', i.XININQNO) AS enquiryNo,
        i.XININQDT AS enquiryDate,
        DATEDIFF(DAY, i.XININQDT, GETDATE()) AS daysPending,
        ISNULL(c.MCMCUSTNM, i.XINCUSTCD) AS customerName
      FROM XINQDTL i
      LEFT JOIN MCUSTMST c ON i.XINCUSTCD = c.MCMCUSTCD
      WHERE i.XININQSTAT = 'O'
        AND NOT EXISTS (SELECT 1 FROM XQTNDTL q WHERE q.XQDINQID = i.XINAUTOID)
      ORDER BY i.XININQDT DESC;
    `,
    // Open quotations (XQDQNSTAT='O') with no linked sales order — i.e. no
    // customer PO received/converted yet. Verified via XOBQTNID.
    quotations: `
      SELECT
        q.XQDAUTOID AS quotationId,
        CONCAT(q.XQDQTNYEAR, '/', q.XQDQTNGRP, '/', q.XQDQTNNO) AS quotationNo,
        q.XQDQTNDT AS quotationDate,
        DATEDIFF(DAY, q.XQDQTNDT, GETDATE()) AS daysPending,
        ISNULL(c.MCMCUSTNM, q.XQDCUSTCD) AS customerName,
        q.XQDTOTDMCY AS quotationValue
      FROM XQTNDTL q
      LEFT JOIN MCUSTMST c ON q.XQDCUSTCD = c.MCMCUSTCD
      WHERE q.XQDQNSTAT = 'O'
        AND NOT EXISTS (SELECT 1 FROM XORDDTL o WHERE o.XOBQTNID = q.XQDAUTOID)
      ORDER BY q.XQDQTNDT DESC;
    `,
    // Live sales orders (excludes XOBORDSTAT='D' [Deleted, 2 rows] and 'N'
    // [Cancelled, 13 rows — see the note on finance.customerOrdersAndInvoices])
    // with no Work Order/Shop Job Order created yet — same Order->OAF->XSJOHDR
    // chain verified in lineage.production.
    workOrders: `
      SELECT
        o.XOBAUTOID AS orderId,
        CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS soNo,
        o.XOBORDDT AS soDate,
        DATEDIFF(DAY, o.XOBORDDT, GETDATE()) AS daysPending,
        ISNULL(c.MCMCUSTNM, o.XOBCUSTCD) AS customerName,
        o.XOBTOTDMCY AS soValue
      FROM XORDDTL o
      LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
      WHERE o.XOBORDSTAT NOT IN ('D', 'N')
        AND NOT EXISTS (
          SELECT 1 FROM XOAFHDR oaf JOIN XSJOHDR s ON s.XSHOAFID = oaf.XOAFHAUTOID
          WHERE oaf.XOAFHORDID = o.XOBAUTOID
        )
      ORDER BY o.XOBORDDT DESC;
    `,
    // Live sales orders not yet fully invoiced (invoiced amount < order
    // value), sorted by order date, most recent first. Same OAF->Invoice
    // chain as crm.recentOrders.
    //
    // Uses XDIHAMTTAX (invoice total incl. tax), not XDIHAMT (excl. tax):
    // o.XOBTOTDMCY (the order value we compare against) is itself tax-
    // inclusive — verified against SourcePro directly on 25-26/SO/000009
    // (RAAD Systems): a single, fully-covering invoice has XDIHAMTTAX =
    // 99,472.11 = XOBTOTDMCY exactly, while XDIHAMT is only 82,298.40.
    // Comparing tax-excl. invoiced against tax-incl. order value had 220 of
    // 270 rows in this list wrongly flagged as pending (fully invoiced/
    // closed orders showing a fake ~15-20% gap) — fixed by matching bases.
    //
    // The pendingValue > 1 (not > 0) threshold below is a deliberate
    // rounding tolerance: closed orders like 25-26/SO/000047 and
    // 26-27/SO/000017 still showed up with a "pending" amount of a few
    // paise (0.02, 0.28) after the tax-basis fix above — leftover
    // round-off noise from summing per-line tax across multiple invoices,
    // confirmed by comparing SUM(XDIHAMTTAX) to XOBTOTDMCY directly. A
    // genuine unbilled order is at minimum hundreds of rupees in this data,
    // so >1 filters the noise without hiding real partial invoicing.
    invoicing: `
      SELECT
        o.XOBAUTOID AS orderId,
        CONCAT(o.XOBIntOrdYr, '/', o.XOBIntOrdGrp, '/', o.XOBIntOrdNo) AS soNo,
        o.XOBORDDT AS soDate,
        ISNULL(c.MCMCUSTNM, o.XOBCUSTCD) AS customerName,
        o.XOBTOTDMCY AS soValue,
        ISNULL(inv.invoicedAmount, 0) AS invoicedValue,
        o.XOBTOTDMCY - ISNULL(inv.invoicedAmount, 0) AS pendingValue
      FROM XORDDTL o
      LEFT JOIN MCUSTMST c ON o.XOBCUSTCD = c.MCMCUSTCD
      OUTER APPLY (
        SELECT SUM(XDIHAMTTAX) AS invoicedAmount
        FROM (
          SELECT DISTINCT ih.XDIHAUTOID, ih.XDIHAMTTAX
          FROM XOAFHDR oaf
          JOIN XDCINVDTL id ON id.XDIDOAFID = oaf.XOAFHAUTOID
          JOIN XDCINVHDR ih ON id.XDIDREFID = ih.XDIHAUTOID
          WHERE oaf.XOAFHORDID = o.XOBAUTOID
        ) d
      ) inv
      WHERE o.XOBORDSTAT NOT IN ('D', 'N')
        AND o.XOBTOTDMCY - ISNULL(inv.invoicedAmount, 0) > 1
      ORDER BY o.XOBORDDT DESC;
    `,
    // Purchase Orders not yet closed (POHSTATUS 'O'=Open or 'N'=New) —
    // excludes 'D' (Cancelled, 8 rows). POHSTATUS='C' correlates 100% with a
    // populated close date and a linked GRN (verified in purchase.orders),
    // so 'O'/'N' reliably means "GRN not done / materials not fully received".
    purchaseOrders: `
      SELECT
        p.POHAUTOID AS poId,
        CONCAT(p.POHORDYEAR, '/', p.POHGRPCD, '/', p.POHORDNO) AS poNo,
        p.POHORDDT AS poDate,
        DATEDIFF(DAY, p.POHORDDT, GETDATE()) AS daysPending,
        ISNULL(v.MVmName, p.POHVNDCODE) AS vendorName,
        p.POHNETVAL AS poValue,
        p.POHRCPVAL AS receivedValue,
        CASE p.POHSTATUS WHEN 'O' THEN 'Open' WHEN 'N' THEN 'New' ELSE p.POHSTATUS END AS statusLabel
      FROM XPOHEAD p
      LEFT JOIN MVNDMAST v ON p.POHVNDCODE = v.MVmVndCode
      WHERE p.POHSTATUS IN ('O', 'N')
      ORDER BY p.POHORDDT DESC;
    `,
    // Receivables can only be tracked at customer level, not per-invoice —
    // XOUTSTNDHDR has no reliable link to a specific invoice (see the
    // customerAR note in lineage above, and finance.debtors). This mirrors
    // finance.debtors' own grouping/HAVING exactly so the count matches what
    // the Finance panel shows.
    receivablesSummary: `
      SELECT COUNT(*) AS customerCount, ISNULL(SUM(bal), 0) AS totalOutstanding
      FROM (
        SELECT XOH_ACCCD, SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM) AS bal
        FROM XOUTSTNDHDR
        WHERE XOH_DR_CR = 'D'
        GROUP BY XOH_ACCCD
        HAVING ABS(SUM(XOH_TRN_AMT_DOM - XOH_ADJ_AMT_DOM)) > 0.01
      ) x;
    `
  },

  // ---------------- SALES PERFORMANCE SCORECARD ----------------
  // Built against management's "Sales Department – KPI & Monthly Performance
  // Scorecard". Only the KPIs SYNCAXIS actually has source data for are
  // here — "Customer Visits" and "Follow-up Closure" have no home in this
  // schema (no visit log at all; XFOLLOWUPDTL exists but has ~13 rows total
  // in this database, too sparse to be a real metric) and "Collection
  // achieved vs due" can't be computed either — XOUTSTNDHDR is a snapshot of
  // what's currently outstanding, not a payment/receipt log, and no such log
  // exists anywhere in this database (checked). Ratings/increment-eligibility
  // are deliberately NOT computed here — this reports actual numbers only.
  salesPerformance: {
    // All salespeople combined, FY-bound, same always-12-rows shape as
    // crm.monthlyBreakdown — feeds "click a month to filter the scorecard
    // below", the same pattern used throughout this app. newCustomerCount is
    // company-wide (not per salesperson) — each customer's very first
    // enquiry ever, falling in that month; see the scorecard note below for
    // why this proxy is used instead of an MCUSTMST creation date.
    monthlyBreakdown: `
      WITH Months AS (
        SELECT TOP 12 FORMAT(DATEADD(MONTH, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @start), 'yyyy-MM') AS period
        FROM sys.all_objects
      ),
      Enq AS (
        SELECT FORMAT(XININQDT, 'yyyy-MM') AS period, COUNT(*) AS c
        FROM XINQDTL WHERE XININQDT >= @start AND XININQDT < @end
        GROUP BY FORMAT(XININQDT, 'yyyy-MM')
      ),
      Qtn AS (
        SELECT FORMAT(XQDQTNDT, 'yyyy-MM') AS period, COUNT(*) AS c, SUM(XQDTOTDMCY) AS val
        FROM XQTNDTL WHERE XQDQTNDT >= @start AND XQDQTNDT < @end
        GROUP BY FORMAT(XQDQTNDT, 'yyyy-MM')
      ),
      Ord AS (
        SELECT FORMAT(XOBORDDT, 'yyyy-MM') AS period, COUNT(*) AS c, SUM(XOBTOTDMCY) AS val
        FROM XORDDTL WHERE XOBORDDT >= @start AND XOBORDDT < @end
        GROUP BY FORMAT(XOBORDDT, 'yyyy-MM')
      ),
      Inv AS (
        SELECT FORMAT(XDIHINVDT, 'yyyy-MM') AS period, SUM(XDIHAMT) AS val
        FROM XDCINVHDR WHERE XDIHINVDT >= @start AND XDIHINVDT < @end
        GROUP BY FORMAT(XDIHINVDT, 'yyyy-MM')
      ),
      CompanyFirstEnquiry AS (
        SELECT XINCUSTCD, XININQDT,
          ROW_NUMBER() OVER (PARTITION BY XINCUSTCD ORDER BY XININQDT ASC) AS rn
        FROM XINQDTL
      ),
      NewCust AS (
        SELECT FORMAT(XININQDT, 'yyyy-MM') AS period, COUNT(*) AS c
        FROM CompanyFirstEnquiry
        WHERE rn = 1 AND XININQDT >= @start AND XININQDT < @end
        GROUP BY FORMAT(XININQDT, 'yyyy-MM')
      )
      SELECT
        m.period,
        ISNULL(e.c, 0) AS enquiryCount,
        ISNULL(q.c, 0) AS quotationCount,
        ISNULL(q.val, 0) AS quotationValue,
        ISNULL(o.c, 0) AS orderCount,
        ISNULL(o.val, 0) AS orderValue,
        ISNULL(i.val, 0) AS billingValue,
        ISNULL(nc.c, 0) AS newCustomerCount
      FROM Months m
      LEFT JOIN Enq e ON m.period = e.period
      LEFT JOIN Qtn q ON m.period = q.period
      LEFT JOIN Ord o ON m.period = o.period
      LEFT JOIN Inv i ON m.period = i.period
      LEFT JOIN NewCust nc ON m.period = nc.period
      ORDER BY m.period;
    `,
    // Per-salesperson breakdown for a period (a clicked month, or the whole
    // FY when unfiltered). Billing is attributed via Invoice->OAF->Order
    // (the same chain verified in crm.recentOrders/recentInvoices), NOT
    // XDCINVHDR's own salesperson field — that's blank on every row in this
    // data (see the recentInvoices note). "New customers" = each customer's
    // very first enquiry ever, attributed to whoever handled it, falling in
    // this period — a proxy; MCUSTMST's own creation date (if it has one and
    // is more authoritative) hasn't been checked against this yet.
    scorecard: (filtered) => `
      WITH FirstEnquiry AS (
        SELECT XINCUSTCD, XININQDT, XINSPCODE,
          ROW_NUMBER() OVER (PARTITION BY XINCUSTCD ORDER BY XININQDT ASC) AS rn
        FROM XINQDTL
      )
      SELECT
        e.MEMEMPNAME AS salesperson,
        ISNULL(enq.c, 0) AS enquiryCount,
        ISNULL(qtn.c, 0) AS quotationCount,
        ISNULL(qtn.val, 0) AS quotationValue,
        ISNULL(ord.c, 0) AS orderCount,
        ISNULL(ord.val, 0) AS orderValue,
        ISNULL(inv.val, 0) AS billingValue,
        ISNULL(newcust.c, 0) AS newCustomerCount
      FROM MEMPMST e
      LEFT JOIN (
        SELECT XINSPCODE AS spCode, COUNT(*) AS c
        FROM XINQDTL
        ${filtered ? 'WHERE XININQDT >= @start AND XININQDT < @end' : ''}
        GROUP BY XINSPCODE
      ) enq ON enq.spCode = e.MEMEMPCODE
      LEFT JOIN (
        SELECT XQNSPCODE AS spCode, COUNT(*) AS c, SUM(XQDTOTDMCY) AS val
        FROM XQTNDTL
        ${filtered ? 'WHERE XQDQTNDT >= @start AND XQDQTNDT < @end' : ''}
        GROUP BY XQNSPCODE
      ) qtn ON qtn.spCode = e.MEMEMPCODE
      LEFT JOIN (
        SELECT XOBSPCODE AS spCode, COUNT(*) AS c, SUM(XOBTOTDMCY) AS val
        FROM XORDDTL
        ${filtered ? 'WHERE XOBORDDT >= @start AND XOBORDDT < @end' : ''}
        GROUP BY XOBSPCODE
      ) ord ON ord.spCode = e.MEMEMPCODE
      LEFT JOIN (
        SELECT o.XOBSPCODE AS spCode, SUM(ih.XDIHAMT) AS val
        FROM XDCINVHDR ih
        JOIN XDCINVDTL id ON id.XDIDREFID = ih.XDIHAUTOID
        JOIN XOAFHDR oaf ON id.XDIDOAFID = oaf.XOAFHAUTOID
        JOIN XORDDTL o ON oaf.XOAFHORDID = o.XOBAUTOID
        ${filtered ? 'WHERE ih.XDIHINVDT >= @start AND ih.XDIHINVDT < @end' : ''}
        GROUP BY o.XOBSPCODE
      ) inv ON inv.spCode = e.MEMEMPCODE
      LEFT JOIN (
        SELECT XINSPCODE AS spCode, COUNT(*) AS c
        FROM FirstEnquiry
        WHERE rn = 1
        ${filtered ? 'AND XININQDT >= @start AND XININQDT < @end' : ''}
        GROUP BY XINSPCODE
      ) newcust ON newcust.spCode = e.MEMEMPCODE
      WHERE ISNULL(enq.c, 0) + ISNULL(qtn.c, 0) + ISNULL(ord.c, 0) + ISNULL(inv.val, 0) > 0
      ORDER BY ISNULL(ord.val, 0) DESC;
    `,
    // Current open pipeline (quotations sent but not yet won or lost) per
    // salesperson — a snapshot, not scoped to a month, same idea as
    // finance.debtors' "current outstanding" default. Reuses the exact
    // "no matching order" check already verified in pending.quotations.
    pipeline: `
      SELECT
        ISNULL(e.MEMEMPNAME, 'Unassigned') AS salesperson,
        SUM(q.XQDTOTDMCY) AS pipelineValue,
        COUNT(*) AS openQuotationCount
      FROM XQTNDTL q
      LEFT JOIN MEMPMST e ON q.XQNSPCODE = e.MEMEMPCODE
      WHERE q.XQDQNSTAT = 'O'
        AND NOT EXISTS (SELECT 1 FROM XORDDTL o WHERE o.XOBQTNID = q.XQDAUTOID)
      GROUP BY e.MEMEMPNAME
      ORDER BY pipelineValue DESC;
    `
  }
};

module.exports = queries;
