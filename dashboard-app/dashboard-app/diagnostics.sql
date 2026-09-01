-- Run these in SSMS against SYNCAXIS *before* trusting the dashboard numbers.
-- They show you which status/type codes actually appear in your data, and how
-- often, so you can map them to real business meaning (Open/Closed, Sales/
-- Purchase, etc.) and adjust queries.js accordingly. Paste the results back
-- to Claude if you'd like help interpreting them.

-- 1) What invoice types/subtypes exist, and how many of each?
--    NOTE: XINVHDR is empty (0 rows) in this database — Sales & Revenue now
--    reads from XDCINVHDR instead, the table that actually has real invoice
--    data (352 rows, confirmed real GST e-invoice/IRN data). This query
--    checks XDCINVHDR's doc types — in the data seen so far it's uniformly
--    XDIHDOCTYP/XDIHDOCSUBTYP = 'DI', all customer-facing (XDIHCUSTVND='C'),
--    so no type filter is applied in queries.js. Re-run this occasionally in
--    case other doc types show up as more data is entered.
SELECT XDIHDOCTYP, XDIHDOCSUBTYP, XDIHINVOF, XDIHCUSTVND, COUNT(*) AS RecordCount,
       MIN(XDIHINVDT) AS Earliest, MAX(XDIHINVDT) AS Latest
FROM XDCINVHDR
GROUP BY XDIHDOCTYP, XDIHDOCSUBTYP, XDIHINVOF, XDIHCUSTVND
ORDER BY RecordCount DESC;

-- 2) Work Order status codes in use
SELECT XWOSTATUS, COUNT(*) AS RecordCount,
       SUM(CASE WHEN XWOCLOSDT IS NULL THEN 1 ELSE 0 END) AS StillOpenCount
FROM XWOHDR
GROUP BY XWOSTATUS
ORDER BY RecordCount DESC;

-- 3) Shop Job Order status codes in use
SELECT XSHSJOSTAT, COUNT(*) AS RecordCount
FROM XSJOHDR
GROUP BY XSHSJOSTAT
ORDER BY RecordCount DESC;

-- 4) Purchase Bill status codes in use
SELECT XBHSTATUS, COUNT(*) AS RecordCount
FROM XPURBILLHDR
GROUP BY XBHSTATUS
ORDER BY RecordCount DESC;

-- 5) Outstanding (AR/AP) Dr/Cr indicator values in use
SELECT XOH_DR_CR, COUNT(*) AS RecordCount, SUM(XOH_TRN_AMT_DOM) AS TotalAmount
FROM XOUTSTNDHDR
GROUP BY XOH_DR_CR
ORDER BY RecordCount DESC;

-- 6) Enquiry status codes in use (old 1-char XININQSTAT vs newer XININQSTATUSCD)
SELECT XININQSTAT, XININQSTATUSCD, COUNT(*) AS RecordCount
FROM XINQDTL
GROUP BY XININQSTAT, XININQSTATUSCD
ORDER BY RecordCount DESC;

-- 7) Quotation status codes in use (old 1-char XQDQNSTAT vs newer XQDQUOSTATUS)
SELECT XQDQNSTAT, XQDQUOSTATUS, COUNT(*) AS RecordCount
FROM XQTNDTL
GROUP BY XQDQNSTAT, XQDQUOSTATUS
ORDER BY RecordCount DESC;

-- 8) Sales Order status codes in use
SELECT XOBORDSTAT, COUNT(*) AS RecordCount
FROM XORDDTL
GROUP BY XOBORDSTAT
ORDER BY RecordCount DESC;

-- 9) Follow-up "based on" doc-type codes in use
-- (tells you which XFWBASEON value means Enquiry vs Quotation vs Sales Order)
SELECT XFWBASEON, COUNT(*) AS RecordCount
FROM XFOLLOWUPDTL
GROUP BY XFWBASEON
ORDER BY RecordCount DESC;
