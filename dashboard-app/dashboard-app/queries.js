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
    `
  }
};

module.exports = queries;
