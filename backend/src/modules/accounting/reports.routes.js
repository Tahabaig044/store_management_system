// Every report here is derived exclusively from JournalEntry/JournalLine -
// none of these read Sale/Purchase totals directly - so a report can never
// drift from what was actually posted to the ledger. Drill-down back to the
// source transaction goes through GET /api/accounting/journal/:id.
const express = require('express');
const prisma = require('../../config/prisma');
const { dateRange } = require('../../utils/dateRange');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { getSystemAccountId, ensureChartOfAccounts, LEDGER_STATUSES } = require('./ledger');
const { branchScopeWhere, getAccessibleBranchIds } = require('../../middleware/branchScope');

const router = express.Router();
router.use(authenticate, requireTenant, requirePermission('REPORT', 'VIEW'));

function num(v) {
  return Number(v || 0);
}

// Normal-balance-aware net for an account type: ASSET/EXPENSE are debit-
// normal (net = debit - credit); LIABILITY/EQUITY/REVENUE are credit-normal
// (net = credit - debit).
function normalNet(type, debit, credit) {
  return ['ASSET', 'EXPENSE'].includes(type) ? debit - credit : credit - debit;
}

async function sumLinesByAccount(tenantId, where) {
  const rows = await prisma.journalLine.groupBy({
    by: ['accountId'],
    where: { account: { tenantId }, journalEntry: { tenantId, status: { in: LEDGER_STATUSES }, ...where } },
    _sum: { debit: true, credit: true },
  });
  return rows;
}

// Phase 2.3: the statements below are served by financialReportsService, which
// every filter (asOf / from / to / branchId / companyId) and the dashboard KPIs
// share. Response fields that existed before are unchanged; new fields are additive.
// A bare date used as "to"/"asOf" now means the END of that day (it used to
// exclude that day's own entries).
const fin = require('./financialReportsService');

async function withScope(req) {
  return fin.resolveBranchIds(prisma, req.user, { branchId: req.query.branchId, companyId: req.query.companyId });
}
const asOfOf = (req) => fin.parseDate(req.query.asOf, 'asOf', { endOfDay: true }) || new Date();

// 1. Trial Balance (optional `from` adds opening / period / closing columns)
router.get('/trial-balance', async (req, res) => {
  const ids = await withScope(req);
  res.json(await fin.trialBalance(prisma, req.user, ids, { asOf: asOfOf(req), from: fin.parseDate(req.query.from, 'from') }));
});

// 2. Profit & Loss Statement
router.get('/profit-loss', async (req, res) => {
  const ids = await withScope(req);
  res.json(await fin.profitLoss(prisma, req.user, ids, fin.parseRange(req.query)));
});

// 3. Balance Sheet
router.get('/balance-sheet', async (req, res) => {
  const ids = await withScope(req);
  res.json(await fin.balanceSheet(prisma, req.user, ids, { asOf: asOfOf(req) }));
});

// 4. Cash Flow Statement (simplified/direct method - all movement through
// the Cash and Bank accounts, grouped by originating transaction type;
// disclosed as a simplification, not a full indirect-method statement).
router.get('/cash-flow', async (req, res) => {
  const ids = await withScope(req);
  const cb = await fin.cashBank(prisma, req.user, ids, fin.parseRange(req.query));
  res.json({ from: cb.from, to: cb.to, byType: cb.bySource, netChange: cb.netChange, openingBalance: cb.totals.openingBalance, closingBalance: cb.totals.closingBalance });
});

// Phase 2.3: cash & bank position - per account opening / receipts / payments / closing.
router.get('/cash-bank', async (req, res) => {
  const ids = await withScope(req);
  res.json(await fin.cashBank(prisma, req.user, ids, fin.parseRange(req.query)));
});

// 5. General Ledger / 15. Account-wise transaction report (same shape - one
// account's full activity with a running balance - registered under both
// paths since the phase requirement lists them as distinct report names).
async function generalLedgerHandler(req, res) {
  const { from, to } = fin.parseRange(req.query, 90);
  const { accountId } = req.query;
  const where = { tenantId: req.user.tenantId, status: { in: LEDGER_STATUSES }, date: { gte: from, lte: to }, ...fin.branchWhere(await withScope(req)) };
  if (accountId) where.lines = { some: { accountId } };

  const entries = await prisma.journalEntry.findMany({
    where,
    include: { lines: { where: accountId ? { accountId } : undefined, include: { account: true } }, branch: true },
    orderBy: { date: 'asc' },
  });

  let running = 0;
  const rows = [];
  for (const e of entries) {
    for (const l of e.lines) {
      running += normalNet(l.account.type, num(l.debit), num(l.credit));
      rows.push({
        journalEntryId: e.id,
        entryNumber: e.entryNumber,
        date: e.date,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        memo: e.memo,
        branchName: e.branch?.name,
        accountId: l.accountId,
        accountName: l.account.name,
        debit: num(l.debit),
        credit: num(l.credit),
        runningBalance: running,
      });
    }
  }
  res.json({ from, to, rows });
}
router.get('/general-ledger', generalLedgerHandler);

// 6. Cash Book, 7. Bank Book - the running balance now starts from the account's
// balance before the period (it used to start from zero) and openingBalance is returned.
async function bookReport(req, res, key) {
  const ids = await withScope(req);
  res.json(await fin.moneyBook(prisma, req.user, ids, key, fin.parseRange(req.query, 90)));
}
router.get('/cash-book', (req, res) => bookReport(req, res, 'CASH'));
router.get('/bank-book', (req, res) => bookReport(req, res, 'BANK'));

// Phase 2.3: ledger-derived KPIs (the same figures the dashboard shows).
router.get('/kpis', async (req, res) => {
  const ids = await withScope(req);
  res.json(await fin.kpis(prisma, req.user, ids, fin.parseRange(req.query)));
});

// Phase 2.3: ledger-to-subledger and cash reconciliation (one consistent snapshot).
router.get('/reconciliation', async (req, res) => {
  res.json(
    await fin.reconciliationReport(prisma, req.user, {
      branchId: req.query.branchId,
      companyId: req.query.companyId,
      to: fin.parseDate(req.query.asOf, 'asOf', { endOfDay: true }) || new Date(),
    }),
  );
});

// 8. Accounts Receivable Aging / 9. Accounts Payable Aging
function ageBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

router.get('/ar-aging', async (req, res) => {
  const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
  const sales = await prisma.sale.findMany({
    where: { tenantId: req.user.tenantId, status: 'COMPLETED', paymentStatus: { not: 'PAID' }, ...(await branchScopeWhere(prisma, req.user)) },
    include: { customer: true },
  });
  const rows = sales
    .map((s) => ({
      id: s.id,
      invoiceNumber: s.invoiceNumber,
      customerName: s.customer?.name || 'Walk-in',
      amountDue: num(s.total) - num(s.amountPaid),
      ageDays: Math.floor((asOf - new Date(s.createdAt)) / 86400000),
    }))
    .filter((r) => r.amountDue > 0.001)
    .map((r) => ({ ...r, bucket: ageBucket(r.ageDays) }));

  const totals = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rows) totals[r.bucket] += r.amountDue;
  res.json({ asOf, rows, totals, total: rows.reduce((s, r) => s + r.amountDue, 0) });
});

router.get('/ap-aging', async (req, res) => {
  const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
  const purchases = await prisma.purchase.findMany({
    where: { tenantId: req.user.tenantId, status: 'RECEIVED', paymentStatus: { not: 'PAID' }, ...(await branchScopeWhere(prisma, req.user)) },
    include: { supplier: true },
  });
  const rows = purchases
    .map((p) => ({
      id: p.id,
      purchaseNumber: p.purchaseNumber,
      supplierName: p.supplier?.name || 'Unknown',
      amountDue: num(p.total) - num(p.amountPaid),
      ageDays: Math.floor((asOf - new Date(p.receivedAt || p.createdAt)) / 86400000),
    }))
    .filter((r) => r.amountDue > 0.001)
    .map((r) => ({ ...r, bucket: ageBucket(r.ageDays) }));

  const totals = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rows) totals[r.bucket] += r.amountDue;
  res.json({ asOf, rows, totals, total: rows.reduce((s, r) => s + r.amountDue, 0) });
});

// 10. Expense Summary
router.get('/expense-summary', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const accounts = await prisma.account.findMany({ where: { tenantId: req.user.tenantId, type: 'EXPENSE' }, include: { expenseCategory: true } });
  const sums = await sumLinesByAccount(req.user.tenantId, { date: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) });
  const sumMap = new Map(sums.map((s) => [s.accountId, s]));

  const rows = accounts
    .map((a) => {
      const s = sumMap.get(a.id);
      const amount = normalNet(a.type, num(s?._sum.debit), num(s?._sum.credit));
      return amount === 0 ? null : { accountId: a.id, name: a.name, amount };
    })
    .filter(Boolean);
  res.json({ from, to, rows, total: rows.reduce((s, r) => s + r.amount, 0) });
});

// 11. Income Summary
router.get('/income-summary', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const accounts = await prisma.account.findMany({ where: { tenantId: req.user.tenantId, type: 'REVENUE' } });
  const sums = await sumLinesByAccount(req.user.tenantId, { date: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) });
  const sumMap = new Map(sums.map((s) => [s.accountId, s]));

  const rows = accounts
    .map((a) => {
      const s = sumMap.get(a.id);
      const amount = normalNet(a.type, num(s?._sum.debit), num(s?._sum.credit));
      return amount === 0 ? null : { accountId: a.id, name: a.name, amount };
    })
    .filter(Boolean);
  res.json({ from, to, rows, total: rows.reduce((s, r) => s + r.amount, 0) });
});

// 12. Sales vs Cost vs Gross Profit (ledger-authoritative version of the
// existing Phase 1 reports.routes.js profit-loss estimate - kept as a
// separate endpoint so the two can be cross-checked rather than one
// silently replacing the other).
router.get('/sales-cost-profit', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;
  const [salesRevenueId, cogsId] = await prisma.$transaction(async (tx) => [
    await getSystemAccountId(tx, tenantId, 'SALES_REVENUE'),
    await getSystemAccountId(tx, tenantId, 'COGS'),
  ]);
  const sums = await sumLinesByAccount(tenantId, { date: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) });
  const sumMap = new Map(sums.map((s) => [s.accountId, s]));
  const revenue = normalNet('REVENUE', num(sumMap.get(salesRevenueId)?._sum.debit), num(sumMap.get(salesRevenueId)?._sum.credit));
  const cost = normalNet('EXPENSE', num(sumMap.get(cogsId)?._sum.debit), num(sumMap.get(cogsId)?._sum.credit));
  res.json({ from, to, sales: revenue, cost, grossProfit: revenue - cost });
});

// 13. Branch-wise Profit & Loss
router.get('/branch-profit-loss', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;

  // Phase 0.3: this previously showed every branch's figures with no access
  // restriction at all - the one report where the branch-scope gap wasn't
  // just "missing," it actively defeated the purpose of a "branch-wise"
  // report for a restricted caller. Note: Branch itself is filtered by its
  // own `id`, not `branchId` (that field belongs to the child records this
  // report aggregates, e.g. JournalEntry) - branch-comparison below had this
  // exact mix-up, fixed in the same pass.
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  const [branches, accounts] = await Promise.all([
    prisma.branch.findMany({ where: { tenantId, ...(accessibleBranchIds !== null ? { id: { in: accessibleBranchIds } } : {}) } }),
    prisma.account.findMany({ where: { tenantId, type: { in: ['REVENUE', 'EXPENSE'] } } }),
  ]);
  const accountTypeById = new Map(accounts.map((a) => [a.id, a.type]));

  const rows = await prisma.journalLine.findMany({
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      journalEntry: { tenantId, status: { in: LEDGER_STATUSES }, date: { gte: from, lte: to }, ...(accessibleBranchIds !== null ? { branchId: { in: accessibleBranchIds } } : {}) },
    },
    include: { journalEntry: { select: { branchId: true } } },
  });

  const byBranch = new Map();
  for (const b of branches) byBranch.set(b.id, { branchId: b.id, branchName: b.name, revenue: 0, expense: 0 });
  // "Unassigned" (branchId null) postings are only shown to an unrestricted
  // caller - a restricted caller has no way to be "assigned" to null, so
  // per the standard convention it stays out of their scope.
  if (accessibleBranchIds === null) byBranch.set('unassigned', { branchId: null, branchName: 'Unassigned', revenue: 0, expense: 0 });

  for (const r of rows) {
    const key = r.journalEntry.branchId || 'unassigned';
    const bucket = byBranch.get(key) || byBranch.get('unassigned');
    const type = accountTypeById.get(r.accountId);
    const net = normalNet(type, num(r.debit), num(r.credit));
    if (type === 'REVENUE') bucket.revenue += net; else bucket.expense += net;
  }

  const result = [...byBranch.values()]
    .map((b) => ({ ...b, netProfit: b.revenue - b.expense }))
    .filter((b) => b.revenue !== 0 || b.expense !== 0);
  res.json({ from, to, rows: result });
});

// 14. Account-wise transaction report - same handler as General Ledger.
router.get('/account-transactions', generalLedgerHandler);

// ---------------------------------------------------------------------------
// Phase 6 - Branch-wise and location reporting
// ---------------------------------------------------------------------------

// 15. Branch Sales Report
router.get('/branch-sales', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const scope = await branchScopeWhere(prisma, req.user);
  const sales = await prisma.sale.findMany({
    where: { tenantId: req.user.tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to }, ...scope },
    select: { total: true, branchId: true, branch: { select: { name: true } } },
  });
  const byBranch = new Map();
  for (const s of sales) {
    const key = s.branchId || 'unassigned';
    const cur = byBranch.get(key) || { branchId: s.branchId, branchName: s.branch?.name || 'Unassigned', total: 0, count: 0 };
    cur.total += num(s.total);
    cur.count += 1;
    byBranch.set(key, cur);
  }
  res.json({ from, to, rows: [...byBranch.values()].sort((a, b) => b.total - a.total) });
});

// 16. Branch Expense Report
router.get('/branch-expenses', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const scope = await branchScopeWhere(prisma, req.user);
  const expenses = await prisma.expense.findMany({
    where: { tenantId: req.user.tenantId, expenseDate: { gte: from, lte: to }, ...scope },
    select: { amount: true, branchId: true, branch: { select: { name: true } } },
  });
  const byBranch = new Map();
  for (const e of expenses) {
    const key = e.branchId || 'unassigned';
    const cur = byBranch.get(key) || { branchId: e.branchId, branchName: e.branch?.name || 'Unassigned', total: 0, count: 0 };
    cur.total += num(e.amount);
    cur.count += 1;
    byBranch.set(key, cur);
  }
  res.json({ from, to, rows: [...byBranch.values()].sort((a, b) => b.total - a.total) });
});

// 17. Branch-wise Receivables/Payables
router.get('/branch-receivables-payables', async (req, res) => {
  const scope = await branchScopeWhere(prisma, req.user);
  const [sales, purchases] = await Promise.all([
    prisma.sale.findMany({
      where: { tenantId: req.user.tenantId, status: 'COMPLETED', paymentStatus: { not: 'PAID' }, ...scope },
      select: { total: true, amountPaid: true, branchId: true, branch: { select: { name: true } } },
    }),
    prisma.purchase.findMany({
      where: { tenantId: req.user.tenantId, status: 'RECEIVED', paymentStatus: { not: 'PAID' }, ...scope },
      select: { total: true, amountPaid: true, branchId: true, branch: { select: { name: true } } },
    }),
  ]);
  const byBranch = new Map();
  const bucket = (branchId, branchName) => {
    const key = branchId || 'unassigned';
    if (!byBranch.has(key)) byBranch.set(key, { branchId, branchName: branchName || 'Unassigned', receivables: 0, payables: 0 });
    return byBranch.get(key);
  };
  for (const s of sales) bucket(s.branchId, s.branch?.name).receivables += Math.max(num(s.total) - num(s.amountPaid), 0);
  for (const p of purchases) bucket(p.branchId, p.branch?.name).payables += Math.max(num(p.total) - num(p.amountPaid), 0);
  res.json({ rows: [...byBranch.values()] });
});

// 18. Branch comparison dashboard/report - sales, gross profit, expenses,
// and net profit side by side, all ledger-derived.
router.get('/branch-comparison', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;
  // Phase 0.3 fix: this previously spread branchScopeWhere()'s `{branchId:
  // {in: ids}}` fragment directly into a Branch query - but Branch is
  // filtered by its own `id`, not a `branchId` field (which belongs to
  // child records like JournalEntry) - a restricted caller hitting this
  // endpoint would have gotten a Prisma validation error, not a
  // silently-wrong result. Fixed by resolving accessible ids once, up front.
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);

  const [branches, accounts] = await Promise.all([
    prisma.branch.findMany({ where: { tenantId, ...(accessibleBranchIds !== null ? { id: { in: accessibleBranchIds } } : {}) } }),
    prisma.account.findMany({ where: { tenantId, type: { in: ['REVENUE', 'EXPENSE'] } } }),
  ]);
  const accountTypeById = new Map(accounts.map((a) => [a.id, a.type]));

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      journalEntry: {
        tenantId,
        status: { in: LEDGER_STATUSES },
        date: { gte: from, lte: to },
        ...(accessibleBranchIds ? { branchId: { in: accessibleBranchIds } } : {}),
      },
    },
    include: { journalEntry: { select: { branchId: true } } },
  });

  const byBranch = new Map();
  for (const b of branches) byBranch.set(b.id, { branchId: b.id, branchName: b.name, revenue: 0, expense: 0 });
  for (const r of lines) {
    const key = r.journalEntry.branchId;
    if (!key || !byBranch.has(key)) continue; // skip unassigned/out-of-scope for a comparison view
    const bucket = byBranch.get(key);
    const type = accountTypeById.get(r.accountId);
    const net = normalNet(type, num(r.debit), num(r.credit));
    if (type === 'REVENUE') bucket.revenue += net; else bucket.expense += net;
  }

  const rows = [...byBranch.values()].map((b) => ({ ...b, netProfit: b.revenue - b.expense }));
  const ranked = [...rows].sort((a, b) => b.netProfit - a.netProfit);
  res.json({
    from,
    to,
    rows,
    topPerformer: ranked[0] || null,
    underperformer: ranked[ranked.length - 1] || null,
  });
});

// 19. Warehouse Stock Report - inventory value at every warehouse.
router.get('/warehouse-stock', async (req, res) => {
  const warehouses = await prisma.warehouse.findMany({
    where: { tenantId: req.user.tenantId, isActive: true, ...(await branchScopeWhere(prisma, req.user)) },
  });
  const rows = await Promise.all(
    warehouses.map(async (w) => {
      const stocks = await prisma.warehouseStock.findMany({
        where: { warehouseId: w.id },
        include: { product: { select: { name: true, purchasePrice: true } } },
      });
      const totalValue = stocks.reduce((s, r) => s + num(r.quantity) * num(r.product.purchasePrice), 0);
      const totalQuantity = stocks.reduce((s, r) => s + num(r.quantity), 0);
      return { warehouseId: w.id, warehouseName: w.name, branchId: w.branchId, isCentral: w.isCentral, totalValue, totalQuantity, productCount: stocks.length };
    })
  );
  res.json({ rows });
});

// 20. Stock Transfer Report
router.get('/stock-transfers', async (req, res) => {
  const { from, to } = dateRange(req.query, 90);
  const where = { tenantId: req.user.tenantId, createdAt: { gte: from, lte: to } };
  // StockTransfer has no branchId of its own - scoped via either side's
  // warehouse, same convention as stockTransfers.routes.js's list endpoint.
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  if (accessibleBranchIds !== null) {
    const accessibleWarehouses = await prisma.warehouse.findMany({
      where: { tenantId: req.user.tenantId, branchId: { in: accessibleBranchIds } },
      select: { id: true },
    });
    const whIds = accessibleWarehouses.map((w) => w.id);
    where.OR = [{ sourceWarehouseId: { in: whIds } }, { destinationWarehouseId: { in: whIds } }];
  }
  const transfers = await prisma.stockTransfer.findMany({
    where,
    include: { items: true, sourceWarehouse: true, destinationWarehouse: true },
    orderBy: { createdAt: 'desc' },
  });
  const byStatus = {};
  for (const t of transfers) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  res.json({ from, to, rows: transfers, byStatus, count: transfers.length });
});

// 21. Stock Movement by Location
router.get('/stock-movement-by-location', async (req, res) => {
  const { from, to } = dateRange(req.query, 90);
  const { warehouseId } = req.query;
  const where = { tenantId: req.user.tenantId, warehouseId: warehouseId || { not: null }, createdAt: { gte: from, lte: to } };
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  if (accessibleBranchIds !== null) where.warehouse = { branchId: { in: accessibleBranchIds } };
  const rows = await prisma.inventoryTransaction.findMany({
    where,
    include: { product: { select: { name: true, sku: true } }, warehouse: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ from, to, rows });
});

module.exports = router;
