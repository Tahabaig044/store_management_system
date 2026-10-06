// Owner Mobile dashboard - Phase 2. Every figure here is produced by calling
// the tenant's existing, already-tested calculation engine
// (backend/src/modules/ai/analytics.js - "the deterministic data/analytics
// layer that every AI feature is built on top of") or a small number of
// straightforward Prisma aggregates that mirror an existing convention
// elsewhere in the app (documented inline at each point). Nothing here
// invents a new business formula, and nothing is computed on the Android
// side - the client only ever displays what this module returns.
const prisma = require('../../config/prisma');
const analytics = require('../ai/analytics');
const { ValidationError } = require('../../utils/errors');
const { cashBank } = require('../accounting/financialReportsService');

function num(v) {
  return Number(v || 0);
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// Mirrors dashboard.routes.js's resolveRange() exactly (same preset
// semantics: today/yesterday/week/month/custom), so "this week"/"this
// month" mean the same thing on Android as they do on the web Command
// Center. Kept as its own copy here rather than importing from
// dashboard.routes.js so this new, additive module carries zero risk of
// changing existing web route behavior.
function resolveRange(f) {
  const now = new Date();
  const startOfToday = startOfDay(now);
  if (f.range === 'custom' && f.from && f.to) {
    const from = startOfDay(new Date(f.from));
    const to = new Date(f.to);
    to.setHours(23, 59, 59, 999);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new ValidationError('Invalid custom date range');
    }
    return { from, to };
  }
  if (f.range === 'yesterday') {
    const from = new Date(startOfToday);
    from.setDate(from.getDate() - 1);
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  if (f.range === 'week') {
    const from = new Date(startOfToday);
    from.setDate(from.getDate() - 6);
    return { from, to: now };
  }
  if (f.range === 'month') {
    return { from: startOfMonth(now), to: now };
  }
  return { from: startOfToday, to: now };
}

// Same 0-30/31-60/61-90/90+ boundaries as accounting/reports.routes.js's
// ar-aging/ap-aging (ageBucket()) - kept as its own copy for the same
// zero-risk-to-existing-code reason as resolveRange above.
function ageBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

// `branchId` is either one branch id (checked here) or, when the caller chose a company or is limited to several
// branches, a { in: [...] } set the route has already resolved against their access - nothing to check.
async function assertFilterOwnership(tenantId, { branchId, categoryId }) {
  const checks = [
    typeof branchId === 'string' && prisma.branch.findFirst({ where: { id: branchId, tenantId } }),
    categoryId && prisma.category.findFirst({ where: { id: categoryId, tenantId } }),
  ].filter(Boolean);
  if (checks.length === 0) return;
  const results = await Promise.all(checks);
  if (results.some((r) => !r)) {
    throw new ValidationError('One or more filters reference a record outside this tenant');
  }
}

// ---------------------------------------------------------------------------
// GET /dashboard/summary
// ---------------------------------------------------------------------------

async function getSummary(tenantId, filters) {
  await assertFilterOwnership(tenantId, filters);
  const { branchId } = filters;
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayEnd = new Date(yesterday);
  yesterdayEnd.setHours(23, 59, 59, 999);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);
  const monthStart = startOfMonth(now);

  const [todayCmp, yesterdayCmp, weekCmp, monthCmp, monthExpenseAgg, expensesSummary, receivables, inventory, purchasesBlock, payables, cash] = await Promise.all([
    analytics.salesComparison(tenantId, { from: today, to: now, branchId }),
    analytics.salesComparison(tenantId, { from: yesterday, to: yesterdayEnd, branchId }),
    analytics.salesComparison(tenantId, { from: weekStart, to: now, branchId }),
    analytics.salesComparison(tenantId, { from: monthStart, to: now, branchId }),
    prisma.expense.aggregate({ where: { tenantId, status: 'PAID', expenseDate: { gte: monthStart }, ...(branchId && { branchId }) }, _sum: { amount: true } }),
    getExpensesSummary(tenantId, filters),
    getReceivablesSummary(tenantId, filters),
    getInventorySummary(tenantId, filters),
    purchaseTotals(tenantId, branchId, { from: today, to: now }),
    payablesBlock(tenantId, branchId),
    cashPosition(tenantId, branchId, now),
  ]);
  const monthPurchases = await purchaseTotals(tenantId, branchId, { from: monthStart, to: now });

  const monthNetProfit = monthCmp.current.grossProfit - num(monthExpenseAgg._sum.amount);

  const salesBlock = (cmp) => ({
    total: cmp.current.revenue,
    count: cmp.current.saleCount,
    changePercent: cmp.changePercent,
  });

  const ordersBlock = (cmp) => ({
    transactionCount: cmp.current.saleCount,
    averageTransactionValue: cmp.current.saleCount > 0 ? cmp.current.revenue / cmp.current.saleCount : null,
  });

  return {
    sales: {
      today: salesBlock(todayCmp),
      yesterday: salesBlock(yesterdayCmp),
      week: salesBlock(weekCmp),
      month: salesBlock(monthCmp),
    },
    profit: {
      grossProfit: monthCmp.current.grossProfit,
      netProfit: monthNetProfit,
      grossMarginPercent: monthCmp.current.grossMarginPercent,
      netMarginPercent: monthCmp.current.revenue > 0 ? (monthNetProfit / monthCmp.current.revenue) * 100 : null,
    },
    expenses: expensesSummary,
    receivables: {
      totalOutstanding: receivables.totalOutstanding,
      overdueAmount: receivables.overdueAmount,
      recentCollections: receivables.recentCollections,
    },
    orders: {
      today: ordersBlock(todayCmp),
      month: ordersBlock(monthCmp),
    },
    inventory: {
      inventoryValue: inventory.inventoryValue,
      lowStockCount: inventory.lowStockCount,
      outOfStockCount: inventory.outOfStockCount,
      // Stock is held per product for the whole business, not per branch, so this block ignores the branch/company
      // filter. The response says so instead of letting a filtered screen imply otherwise.
      scope: 'ALL_BRANCHES',
    },
    purchases: { today: purchasesBlock, month: monthPurchases },
    payables: { totalOutstanding: payables.totalOutstanding, overdueAmount: payables.overdueAmount },
    cash,
  };
}

// ---------------------------------------------------------------------------
// GET /dashboard/sales
// ---------------------------------------------------------------------------

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function getSales(tenantId, filters) {
  await assertFilterOwnership(tenantId, filters);
  const { branchId, categoryId, productType } = filters;
  const { from, to } = resolveRange(filters);

  const comparison = await analytics.salesComparison(tenantId, { from, to, branchId });

  const saleWhere = {
    tenantId,
    status: 'COMPLETED',
    createdAt: { gte: from, lte: to },
    ...(branchId && { branchId }),
  };
  const [sales, saleItems, productMargins, branches] = await Promise.all([
    prisma.sale.findMany({
      where: saleWhere,
      select: { total: true, createdAt: true, branchId: true, paymentMethod: true },
    }),
    prisma.saleItem.findMany({
      where: {
        sale: saleWhere,
        ...(categoryId && { product: { categoryId } }),
        ...(productType && { product: { type: productType } }),
      },
      select: { quantity: true, lineTotal: true, product: { select: { categoryId: true, category: { select: { name: true } } } } },
    }),
    analytics.productMargins(tenantId, { from, to, branchId, limit: 10 }),
    prisma.branch.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);

  const branchNameById = new Map(branches.map((b) => [b.id, b.name]));

  const trendMap = new Map();
  const branchMap = new Map();
  const methodMap = new Map();
  for (const s of sales) {
    const k = dayKey(s.createdAt);
    const trendCur = trendMap.get(k) || { date: k, total: 0, count: 0 };
    trendCur.total += num(s.total);
    trendCur.count += 1;
    trendMap.set(k, trendCur);

    const bKey = s.branchId || 'unassigned';
    const bCur = branchMap.get(bKey) || { branchId: s.branchId, branchName: s.branchId ? branchNameById.get(s.branchId) || 'Unknown' : 'Unassigned', total: 0, count: 0 };
    bCur.total += num(s.total);
    bCur.count += 1;
    branchMap.set(bKey, bCur);

    const mKey = s.paymentMethod || 'cash';
    const mCur = methodMap.get(mKey) || { method: mKey, total: 0, count: 0 };
    mCur.total += num(s.total);
    mCur.count += 1;
    methodMap.set(mKey, mCur);
  }

  const categoryMap = new Map();
  for (const i of saleItems) {
    const key = i.product.categoryId || 'uncategorized';
    const cur = categoryMap.get(key) || { categoryId: i.product.categoryId, categoryName: i.product.category?.name || 'Uncategorized', total: 0, quantity: 0 };
    cur.total += num(i.lineTotal);
    cur.quantity += num(i.quantity);
    categoryMap.set(key, cur);
  }

  const spanDays = Math.min(Math.ceil((to - from) / 86400000) + 1, 90);

  return {
    range: { from, to },
    totals: {
      revenue: comparison.current.revenue,
      discount: comparison.current.discount,
      saleCount: comparison.current.saleCount,
      averageTransactionValue: comparison.current.saleCount > 0 ? comparison.current.revenue / comparison.current.saleCount : null,
    },
    comparison: { previous: comparison.previous, changePercent: comparison.changePercent, comparedPeriod: comparison.comparedPeriod },
    trend: [...trendMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-spanDays),
    byBranch: [...branchMap.values()].sort((a, b) => b.total - a.total),
    byCategory: [...categoryMap.values()].sort((a, b) => b.total - a.total),
    byPaymentMethod: [...methodMap.values()].sort((a, b) => b.total - a.total),
    byProduct: productMargins,
  };
}

// ---------------------------------------------------------------------------
// GET /dashboard/profit
// ---------------------------------------------------------------------------

async function getProfit(tenantId, filters) {
  await assertFilterOwnership(tenantId, filters);
  const { branchId } = filters;
  const { from, to } = resolveRange(filters);

  const comparison = await analytics.salesComparison(tenantId, { from, to, branchId });
  const branchWhere = branchId ? { branchId } : {};
  const [curExpenses, prevExpenses] = await Promise.all([
    prisma.expense.aggregate({ where: { tenantId, status: 'PAID', expenseDate: { gte: from, lte: to }, ...branchWhere }, _sum: { amount: true } }),
    prisma.expense.aggregate({
      where: { tenantId, status: 'PAID', expenseDate: { gte: comparison.comparedPeriod.from, lte: comparison.comparedPeriod.to }, ...branchWhere },
      _sum: { amount: true },
    }),
  ]);

  const buildPeriod = (totals, expenses) => {
    const netProfit = totals.grossProfit - expenses;
    return {
      grossSales: totals.revenue,
      discounts: totals.discount,
      cogs: totals.cogs,
      grossProfit: totals.grossProfit,
      grossMarginPercent: totals.grossMarginPercent,
      expenses,
      netProfit,
      netMarginPercent: totals.revenue > 0 ? (netProfit / totals.revenue) * 100 : null,
    };
  };

  const current = buildPeriod(comparison.current, num(curExpenses._sum.amount));
  const previous = buildPeriod(comparison.previous, num(prevExpenses._sum.amount));

  return {
    range: { from, to },
    comparedPeriod: comparison.comparedPeriod,
    current,
    previous,
    changePercent: {
      revenue: comparison.changePercent,
      grossProfit: previous.grossProfit > 0 ? ((current.grossProfit - previous.grossProfit) / previous.grossProfit) * 100 : null,
      netProfit: previous.netProfit > 0 ? ((current.netProfit - previous.netProfit) / previous.netProfit) * 100 : null,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /dashboard/expenses
// ---------------------------------------------------------------------------

async function getExpensesSummary(tenantId, filters) {
  await assertFilterOwnership(tenantId, filters);
  const { branchId } = filters;
  const branchWhere = branchId ? { branchId } : {};
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const monthStart = startOfMonth(now);
  const prevMonthStart = new Date(monthStart);
  prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);
  const prevMonthEnd = new Date(monthStart.getTime() - 1);

  const [todayAgg, yesterdayAgg, monthAgg, prevMonthAgg, byCategoryRows] = await Promise.all([
    prisma.expense.aggregate({ where: { tenantId, status: 'PAID', expenseDate: { gte: today }, ...branchWhere }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { tenantId, status: 'PAID', expenseDate: { gte: yesterday, lt: today }, ...branchWhere }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { tenantId, status: 'PAID', expenseDate: { gte: monthStart }, ...branchWhere }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { tenantId, status: 'PAID', expenseDate: { gte: prevMonthStart, lte: prevMonthEnd }, ...branchWhere }, _sum: { amount: true } }),
    prisma.expense.groupBy({
      by: ['categoryId'],
      where: { tenantId, status: 'PAID', expenseDate: { gte: monthStart }, ...branchWhere },
      _sum: { amount: true },
    }),
  ]);

  const categoryIds = byCategoryRows.map((r) => r.categoryId);
  const categories = await prisma.expenseCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } });
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const todayTotal = num(todayAgg._sum.amount);
  const yesterdayTotal = num(yesterdayAgg._sum.amount);
  const monthTotal = num(monthAgg._sum.amount);
  const prevMonthTotal = num(prevMonthAgg._sum.amount);

  return {
    today: { total: todayTotal, changePercent: yesterdayTotal > 0 ? ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100 : null },
    month: { total: monthTotal, changePercent: prevMonthTotal > 0 ? ((monthTotal - prevMonthTotal) / prevMonthTotal) * 100 : null },
    byCategory: byCategoryRows
      .map((r) => ({ categoryId: r.categoryId, categoryName: nameById.get(r.categoryId) || 'Uncategorized', total: num(r._sum.amount) }))
      .sort((a, b) => b.total - a.total),
  };
}

// ---------------------------------------------------------------------------
// GET /dashboard/receivables
// ---------------------------------------------------------------------------

async function getReceivablesSummary(tenantId, filters) {
  await assertFilterOwnership(tenantId, filters);
  const { branchId } = filters;
  const rows = await analytics.receivablesAging(tenantId, { branchId });

  const agingBuckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rows) {
    agingBuckets[ageBucket(r.daysOverdue)] += r.amountDue;
  }

  const totalOutstanding = rows.reduce((s, r) => s + r.amountDue, 0);
  // Consistent with the existing web Command Center's own 30-day cutoff
  // (dashboard.routes.js's receivablesOverdue) - "overdue" means aged past
  // 30 days, not merely unpaid.
  const overdueAmount = rows.filter((r) => r.daysOverdue > 30).reduce((s, r) => s + r.amountDue, 0);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const collectionRows = await prisma.payment.findMany({
    where: { tenantId, status: 'COMPLETED', direction: 'IN', customerId: { not: null }, paidAt: { gte: thirtyDaysAgo }, ...(branchId && { branchId }) },
    select: { amount: true, paidAt: true },
  });
  const collectionsTrendMap = new Map();
  for (const p of collectionRows) {
    const k = dayKey(p.paidAt);
    collectionsTrendMap.set(k, (collectionsTrendMap.get(k) || 0) + num(p.amount));
  }
  const collectionsTrend = [...collectionsTrendMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, total]) => ({ date, total }));

  const byCustomer = new Map();
  for (const r of rows) {
    const key = r.customerId || 'walkin';
    const cur = byCustomer.get(key) || { customerId: r.customerId, customerName: r.customerName, amountDue: 0, daysOverdue: 0 };
    cur.amountDue += r.amountDue;
    cur.daysOverdue = Math.max(cur.daysOverdue, r.daysOverdue);
    byCustomer.set(key, cur);
  }

  return {
    totalOutstanding,
    overdueAmount,
    recentCollections: collectionRows.reduce((s, p) => s + num(p.amount), 0),
    collectionsTrend,
    agingBuckets,
    topDebtors: [...byCustomer.values()].sort((a, b) => b.amountDue - a.amountDue).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// GET /dashboard/inventory
// ---------------------------------------------------------------------------

async function getInventorySummary(tenantId, filters) {
  await assertFilterOwnership(tenantId, filters);
  const { categoryId, productType } = filters;
  // Product.stockQuantity is the tenant-wide authoritative total (see
  // schema.prisma comment on WarehouseStock) - there is no per-branch stock
  // split at the Product level, so inventory visibility here is
  // intentionally tenant-wide, not branch-filtered.
  const products = await prisma.product.findMany({
    where: {
      tenantId,
      isActive: true,
      ...(categoryId && { categoryId }),
      ...(productType && { type: productType }),
    },
    select: { id: true, stockQuantity: true, purchasePrice: true, lowStockThreshold: true },
  });

  const inventoryValue = products.reduce((s, p) => s + num(p.stockQuantity) * num(p.purchasePrice), 0);
  const outOfStockCount = products.filter((p) => num(p.stockQuantity) <= 0).length;
  const lowStockCount = products.filter((p) => num(p.stockQuantity) > 0 && num(p.stockQuantity) <= num(p.lowStockThreshold)).length;

  const [lowStockRisk, slowMoving, recentMovementsRaw] = await Promise.all([
    analytics.lowStockRisk(tenantId, {}),
    analytics.slowMovingStock(tenantId, {}),
    prisma.inventoryTransaction.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { type: true, quantity: true, balanceAfter: true, createdAt: true, product: { select: { name: true } } },
    }),
  ]);

  return {
    inventoryValue,
    lowStockCount,
    outOfStockCount,
    lowStockItems: lowStockRisk.slice(0, 20),
    slowMoving,
    recentMovements: recentMovementsRaw.map((m) => ({
      productName: m.product.name,
      type: m.type,
      quantity: num(m.quantity),
      balanceAfter: num(m.balanceAfter),
      createdAt: m.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Purchases, payables, cash & bank (Phase 4.2)
// ---------------------------------------------------------------------------
// Purchases count when they are RECEIVED (stock in, money owed): a draft, cancelled or returned purchase is not
// a purchase for these totals - the same cut the web AP aging report makes. Cash and bank come from the ledger
// through the SAME report function the web Cash/Bank report uses (financialReportsService.cashBank), so the
// phone and the web can never disagree.

async function purchaseTotals(tenantId, branchId, { from, to }) {
  const agg = await prisma.purchase.aggregate({
    where: { tenantId, status: 'RECEIVED', receivedAt: { gte: from, lte: to }, ...(branchId && { branchId }) },
    _sum: { total: true },
    _count: { _all: true },
  });
  return { total: num(agg._sum.total), count: agg._count._all };
}

async function payablesBlock(tenantId, branchId) {
  const purchases = await prisma.purchase.findMany({
    where: { tenantId, status: 'RECEIVED', paymentStatus: { in: ['UNPAID', 'PARTIAL'] }, ...(branchId && { branchId }) },
    select: { id: true, total: true, amountPaid: true, receivedAt: true, createdAt: true, supplierId: true, supplier: { select: { name: true } } },
  });
  const now = Date.now();
  const rows = purchases
    .map((p) => ({
      supplierId: p.supplierId,
      supplierName: p.supplier?.name || 'Unknown',
      amountDue: num(p.total) - num(p.amountPaid),
      daysOverdue: Math.floor((now - new Date(p.receivedAt || p.createdAt).getTime()) / 86400000),
    }))
    .filter((r) => r.amountDue > 0.001);
  const agingBuckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rows) agingBuckets[ageBucket(r.daysOverdue)] += r.amountDue;
  const bySupplier = new Map();
  for (const r of rows) {
    const cur = bySupplier.get(r.supplierId) || { supplierId: r.supplierId, supplierName: r.supplierName, amountDue: 0, daysOverdue: 0 };
    cur.amountDue += r.amountDue;
    cur.daysOverdue = Math.max(cur.daysOverdue, r.daysOverdue);
    bySupplier.set(r.supplierId, cur);
  }
  return {
    totalOutstanding: rows.reduce((s, r) => s + r.amountDue, 0),
    // "Overdue" = aged past 30 days, the same cutoff receivables use.
    overdueAmount: rows.filter((r) => r.daysOverdue > 30).reduce((s, r) => s + r.amountDue, 0),
    agingBuckets,
    topCreditors: [...bySupplier.values()].sort((a, b) => b.amountDue - a.amountDue).slice(0, 10),
  };
}

// branchId here is undefined (everything), one id, or a { in: [...] } set - the ledger report wants null or an array.
const idsFor = (branchId) => (!branchId ? null : typeof branchId === 'string' ? [branchId] : branchId.in);

async function cashPosition(tenantId, branchId, asOf) {
  const cb = await cashBank(prisma, { tenantId }, idsFor(branchId), { from: startOfDay(asOf), to: asOf });
  const byKey = Object.fromEntries(cb.accounts.map((a) => [a.key, a.closingBalance]));
  return { cash: byKey.CASH || 0, bank: byKey.BANK || 0, total: cb.totals.closingBalance };
}

async function getPurchases(tenantId, filters) {
  await assertFilterOwnership(tenantId, filters);
  const { branchId } = filters;
  const { from, to } = resolveRange(filters);
  const span = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - span);

  const where = { tenantId, status: 'RECEIVED', ...(branchId && { branchId }) };
  const [current, previous, rows, payables] = await Promise.all([
    purchaseTotals(tenantId, branchId, { from, to }),
    purchaseTotals(tenantId, branchId, { from: prevFrom, to: prevTo }),
    prisma.purchase.findMany({
      where: { ...where, receivedAt: { gte: from, lte: to } },
      select: { total: true, receivedAt: true, supplierId: true, supplier: { select: { name: true } } },
    }),
    payablesBlock(tenantId, branchId),
  ]);

  const trend = new Map();
  const suppliers = new Map();
  for (const p of rows) {
    const k = dayKey(p.receivedAt);
    const t = trend.get(k) || { date: k, total: 0, count: 0 };
    t.total += num(p.total);
    t.count += 1;
    trend.set(k, t);
    const s = suppliers.get(p.supplierId) || { supplierId: p.supplierId, supplierName: p.supplier?.name || 'Unknown', total: 0, count: 0 };
    s.total += num(p.total);
    s.count += 1;
    suppliers.set(p.supplierId, s);
  }
  const spanDays = Math.min(Math.ceil(span / 86400000) + 1, 90);
  return {
    range: { from, to },
    totals: current,
    previous,
    changePercent: previous.total > 0 ? ((current.total - previous.total) / previous.total) * 100 : null,
    trend: [...trend.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-spanDays),
    topSuppliers: [...suppliers.values()].sort((a, b) => b.total - a.total).slice(0, 10),
    payables,
  };
}

async function getCash(tenantId, filters) {
  await assertFilterOwnership(tenantId, filters);
  const { from, to } = resolveRange(filters);
  const cb = await cashBank(prisma, { tenantId }, idsFor(filters.branchId), { from, to });
  const accountBlock = (key) => {
    const a = cb.accounts.find((x) => x.key === key);
    return { openingBalance: a?.openingBalance || 0, receipts: a?.receipts || 0, payments: a?.payments || 0, closingBalance: a?.closingBalance || 0 };
  };
  return {
    range: { from, to },
    cash: accountBlock('CASH'),
    bank: accountBlock('BANK'),
    totals: cb.totals,
    netChange: cb.netChange,
    // Where the money came from / went to (sale, purchase, expense, payment...), largest first.
    bySource: Object.entries(cb.bySource).map(([source, net]) => ({ source, net })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// GET /dashboard/filters
// ---------------------------------------------------------------------------

async function getFilters(tenantId) {
  const [branches, categories, companies] = await Promise.all([
    prisma.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, companyId: true }, orderBy: { name: 'asc' } }),
    prisma.category.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.company.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  return {
    companies,
    branches,
    categories,
    businessAreas: ['GENERAL', 'MEDICINE', 'FRAME', 'LENS'],
  };
}

module.exports = {
  resolveRange,
  getSummary,
  getSales,
  getProfit,
  getExpensesSummary,
  getReceivablesSummary,
  getInventorySummary,
  getPurchases,
  getCash,
  getFilters,
};
