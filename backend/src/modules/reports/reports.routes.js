const express = require('express');
const prisma = require('../../config/prisma');
const { dateRange } = require('../../utils/dateRange');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireModule } = require('../../middleware/moduleAccess');
const { branchScopeWhere, getAccessibleBranchIds } = require('../../middleware/branchScope');

const router = express.Router();
router.use(authenticate, requireTenant, requirePermission('REPORT', 'VIEW'));

// 1. Daily Sales Report
router.get('/sales/daily', async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end = new Date(date); end.setHours(23, 59, 59, 999);

  const sales = await prisma.sale.findMany({
    where: { tenantId: req.user.tenantId, status: 'COMPLETED', createdAt: { gte: start, lte: end }, ...(await branchScopeWhere(prisma, req.user)) },
    include: { items: true, customer: true },
    orderBy: { createdAt: 'asc' },
  });
  const totals = sales.reduce(
    (acc, s) => ({
      subtotal: acc.subtotal + Number(s.subtotal),
      discount: acc.discount + Number(s.discount),
      total: acc.total + Number(s.total),
      amountPaid: acc.amountPaid + Number(s.amountPaid),
    }),
    { subtotal: 0, discount: 0, total: 0, amountPaid: 0 }
  );
  res.json({ date: start, sales, totals, count: sales.length });
});

// 2. Monthly Sales Report
router.get('/sales/monthly', async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const month = req.query.month ? parseInt(req.query.month, 10) - 1 : new Date().getMonth();
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);

  const sales = await prisma.sale.findMany({
    where: { tenantId: req.user.tenantId, status: 'COMPLETED', createdAt: { gte: start, lt: end }, ...(await branchScopeWhere(prisma, req.user)) },
  });
  const byDay = {};
  for (const s of sales) {
    const day = s.createdAt.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + Number(s.total);
  }
  const total = sales.reduce((sum, s) => sum + Number(s.total), 0);
  res.json({ year, month: month + 1, total, count: sales.length, byDay });
});

// 3. Inventory Report
router.get('/inventory', async (req, res) => {
  const products = await prisma.product.findMany({
    where: { tenantId: req.user.tenantId, isActive: true },
    include: { category: true },
    orderBy: { name: 'asc' },
  });
  const rows = products.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    category: p.category?.name,
    type: p.type,
    stockQuantity: Number(p.stockQuantity),
    purchasePrice: Number(p.purchasePrice),
    sellingPrice: Number(p.sellingPrice),
    stockValue: Number(p.stockQuantity) * Number(p.purchasePrice),
    lowStock: Number(p.stockQuantity) <= Number(p.lowStockThreshold),
  }));
  const totalStockValue = rows.reduce((sum, r) => sum + r.stockValue, 0);
  res.json({ rows, totalStockValue, count: rows.length });
});

// 4. Stock Movement Report
router.get('/stock-movement', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const { productId } = req.query;

  const where = { tenantId: req.user.tenantId, createdAt: { gte: from, lte: to } };
  if (productId) where.productId = productId;
  // InventoryTransaction has no branchId of its own - scoped via the
  // warehouse it moved stock through (a transaction with no warehouse is
  // invisible to a branch-restricted user, consistent with how a null
  // branchId is handled everywhere else in this codebase).
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  if (accessibleBranchIds !== null) where.warehouse = { branchId: { in: accessibleBranchIds } };

  const transactions = await prisma.inventoryTransaction.findMany({
    where,
    include: { product: { select: { name: true, sku: true, unit: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ from, to, transactions, count: transactions.length });
});

// 7. Expense Report
router.get('/expenses', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const expenses = await prisma.expense.findMany({
    where: { tenantId: req.user.tenantId, expenseDate: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) },
    include: { category: true },
    orderBy: { expenseDate: 'desc' },
  });
  const byCategory = {};
  for (const e of expenses) {
    const key = e.category.name;
    byCategory[key] = (byCategory[key] || 0) + Number(e.amount);
  }
  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  res.json({ from, to, expenses, total, byCategory });
});

// 8. Basic Profit & Loss
router.get('/profit-loss', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;

  const branchScope = await branchScopeWhere(prisma, req.user);
  const [saleItems, expenses] = await Promise.all([
    prisma.saleItem.findMany({
      where: { sale: { tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to }, ...branchScope } },
      include: { product: { select: { purchasePrice: true } } },
    }),
    prisma.expense.aggregate({
      where: { tenantId, expenseDate: { gte: from, lte: to }, ...branchScope },
      _sum: { amount: true },
    }),
  ]);

  const revenue = saleItems.reduce((sum, i) => sum + Number(i.lineTotal), 0);
  const cogs = saleItems.reduce((sum, i) => sum + Number(i.quantity) * Number(i.product.purchasePrice), 0);
  const grossProfit = revenue - cogs;
  const totalExpenses = Number(expenses._sum.amount || 0);
  const netProfit = grossProfit - totalExpenses;

  res.json({ from, to, revenue, cogs, grossProfit, totalExpenses, netProfit });
});

// 9. Optical Order Report
// Phase 0.5: this report is owned by the Optical industry module (see
// constants/moduleRegistry.js) but colocated here to preserve the existing
// /api/reports/optical-orders URL - gated so a tenant without Optical
// enabled gets a clean 403 instead of Optical data it never opted into.
router.get('/optical-orders', requireModule('OPTICAL'), async (req, res) => {
  const { from, to } = dateRange(req.query, 90);
  // Phase 7.1: this report had no branch scope at all, unlike every sibling
  // report in this file - a branch-restricted role (e.g. ACCOUNTANT) could see
  // every branch's optical orders. OpticalOrder carries its own branchId
  // (Phase 5.1), so this reuses the exact same helper every other report here
  // already uses, rather than inventing a separate mechanism.
  const orders = await prisma.opticalOrder.findMany({
    where: { tenantId: req.user.tenantId, createdAt: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) },
    include: { customer: true },
    orderBy: { createdAt: 'desc' },
  });
  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  res.json({ from, to, orders, count: orders.length, byStatus });
});

// 10. Medicine Expiry Report
// Phase 0.5: owned by the Medicine industry module, colocated here for the
// same reason as /optical-orders above.
router.get('/medicine-expiry', requireModule('MEDICINE'), async (req, res) => {
  const withinDays = parseInt(req.query.withinDays, 10) || 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);
  const now = new Date();

  // Phase 7.1: this report had no branch scope at all, unlike every sibling
  // report in this file. Product itself carries no branchId (stock is
  // tenant-wide, tracked per-warehouse), so this reuses the exact same
  // getAccessibleBranchIds + warehouse-branchId join /stock-movement already
  // uses above, rather than inventing a separate mechanism - a branch-
  // restricted role only sees a medicine if it has stock in one of their
  // accessible warehouses.
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  const where = {
    tenantId: req.user.tenantId,
    type: 'MEDICINE',
    isActive: true,
    expiryDate: { not: null, lte: cutoff },
  };
  if (accessibleBranchIds !== null) where.warehouseStocks = { some: { warehouse: { branchId: { in: accessibleBranchIds } } } };

  const rows = await prisma.product.findMany({
    where,
    orderBy: { expiryDate: 'asc' },
  });
  // Phase 5.3: "near-expiry" and "already expired" are two distinct concerns for the
  // business (a heads-up vs. stock that must not be sold - see the sale-time block
  // in sales.routes.js) - each row is now explicitly flagged rather than left for the
  // caller to re-derive from a raw date comparison.
  const products = rows.map((p) => ({ ...p, isExpired: p.expiryDate < now }));
  const expiredCount = products.filter((p) => p.isExpired).length;
  res.json({ withinDays, products, count: products.length, expiredCount, nearExpiryCount: products.length - expiredCount });
});

// 10. Quotations & Sales Orders Report (Phase 1.14)
// Descriptive counts/values only - no ranking or unrelated analytics, per
// this phase's explicit instruction. "Conversion rate" is a single
// tenant-wide, date-range-scoped percentage (converted / (every quotation
// that reached a final-or-converted outcome)), not a per-salesperson or
// per-customer leaderboard.
router.get('/quotations-orders', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;
  const branchScope = await branchScopeWhere(prisma, req.user);

  const [quotations, salesOrders] = await Promise.all([
    prisma.quotation.findMany({
      where: { tenantId, quotationDate: { gte: from, lte: to }, ...branchScope },
      select: { status: true, total: true },
    }),
    prisma.salesOrder.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to }, ...branchScope },
      select: { status: true, total: true, items: { select: { quantity: true, fulfilledQuantity: true } } },
    }),
  ]);

  const quotationsByStatus = {};
  for (const q of quotations) {
    const bucket = quotationsByStatus[q.status] || { count: 0, value: 0 };
    bucket.count += 1;
    bucket.value += Number(q.total);
    quotationsByStatus[q.status] = bucket;
  }
  // Only quotations that reached a terminal, decision-based outcome count
  // toward the rate - a still-DRAFT/SENT quotation hasn't been decided yet
  // and would understate the rate if included as a non-conversion.
  const decided = ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'CONVERTED'].reduce((sum, s) => sum + (quotationsByStatus[s]?.count || 0), 0);
  const converted = quotationsByStatus.CONVERTED?.count || 0;
  const conversionRate = decided > 0 ? Math.round((converted / decided) * 10000) / 100 : null;

  const salesOrdersByStatus = {};
  let outstandingQuantity = 0;
  let fulfilledQuantity = 0;
  for (const o of salesOrders) {
    const bucket = salesOrdersByStatus[o.status] || { count: 0, value: 0 };
    bucket.count += 1;
    bucket.value += Number(o.total);
    salesOrdersByStatus[o.status] = bucket;
    if (o.status !== 'CANCELLED') {
      for (const line of o.items) {
        fulfilledQuantity += Number(line.fulfilledQuantity);
        outstandingQuantity += Number(line.quantity) - Number(line.fulfilledQuantity);
      }
    }
  }

  res.json({
    from,
    to,
    quotations: { byStatus: quotationsByStatus, conversionRate },
    salesOrders: { byStatus: salesOrdersByStatus, outstandingQuantity, fulfilledQuantity },
  });
});

module.exports = router;
