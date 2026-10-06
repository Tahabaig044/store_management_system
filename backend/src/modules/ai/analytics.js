// The deterministic data/analytics layer that every AI feature is built on
// top of. Every function here is a plain, auditable aggregation over the
// tenant's own data - no AI, no external calls, no randomness. This is the
// "source of truth" the AI providers are only ever allowed to *interpret*,
// never replace: per the phase's non-negotiable rules, factual numbers
// always come from here, and every AI-facing answer/insight must be able to
// point back to the exact function (and its output) that produced them.
//
// Every function takes `tenantId` first and an optional `branchId` to
// narrow the query - callers are responsible for verifying the caller is
// allowed to see that scope (see context.js) before calling these.
const prisma = require('../../config/prisma');

function num(v) { return Number(v || 0); }
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function daysAgo(n, from = new Date()) { const x = new Date(from); x.setDate(x.getDate() - n); return x; }
function daysBetween(a, b) { return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 86400000); }

function branchWhere(branchId) {
  return branchId ? { branchId } : {};
}

// ---------------------------------------------------------------------------
// Sales / profit
// ---------------------------------------------------------------------------

async function salesTotals(tenantId, { from, to, branchId }) {
  const where = { tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to }, ...branchWhere(branchId) };
  const [agg, items] = await Promise.all([
    prisma.sale.aggregate({ where, _sum: { total: true, discount: true }, _count: true }),
    prisma.saleItem.findMany({
      where: { sale: where },
      select: { quantity: true, lineTotal: true, product: { select: { purchasePrice: true } } },
    }),
  ]);
  const cogs = items.reduce((s, i) => s + num(i.quantity) * num(i.product.purchasePrice), 0);
  const revenue = num(agg._sum.total);
  return {
    revenue,
    discount: num(agg._sum.discount),
    saleCount: agg._count,
    cogs,
    grossProfit: revenue - cogs,
    grossMarginPercent: revenue > 0 ? ((revenue - cogs) / revenue) * 100 : null,
  };
}

// "Compared with last period" - same-length prior window immediately
// preceding `from`, so "this month vs last month" and "this week vs last
// week" both fall out of the same function.
async function salesComparison(tenantId, { from, to, branchId }) {
  const spanMs = new Date(to).getTime() - new Date(from).getTime();
  const prevTo = new Date(new Date(from).getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  const [current, previous] = await Promise.all([
    salesTotals(tenantId, { from, to, branchId }),
    salesTotals(tenantId, { from: prevFrom, to: prevTo, branchId }),
  ]);
  const changePercent = previous.revenue > 0 ? ((current.revenue - previous.revenue) / previous.revenue) * 100 : null;
  return { current, previous, period: { from, to }, comparedPeriod: { from: prevFrom, to: prevTo }, changePercent };
}

async function branchProfitability(tenantId, { from, to }) {
  const branches = await prisma.branch.findMany({ where: { tenantId, isActive: true } });
  const rows = await Promise.all(
    branches.map(async (b) => {
      const totals = await salesTotals(tenantId, { from, to, branchId: b.id });
      return { branchId: b.id, branchName: b.name, ...totals };
    })
  );
  return rows.sort((a, b) => b.grossProfit - a.grossProfit);
}

// Explains a profit change by decomposing it into revenue, COGS, and
// expense deltas between two periods - the deterministic backbone behind
// "why did profit decline this month?".
async function profitDeclineAnalysis(tenantId, { from, to, branchId }) {
  const spanMs = new Date(to).getTime() - new Date(from).getTime();
  const prevTo = new Date(new Date(from).getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - spanMs);

  const [curSales, prevSales, curExpenses, prevExpenses] = await Promise.all([
    salesTotals(tenantId, { from, to, branchId }),
    salesTotals(tenantId, { from: prevFrom, to: prevTo, branchId }),
    prisma.expense.aggregate({ where: { tenantId, status: 'PAID', expenseDate: { gte: from, lte: to }, ...branchWhere(branchId) }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { tenantId, status: 'PAID', expenseDate: { gte: prevFrom, lte: prevTo }, ...branchWhere(branchId) }, _sum: { amount: true } }),
  ]);

  const curNetProfit = curSales.grossProfit - num(curExpenses._sum.amount);
  const prevNetProfit = prevSales.grossProfit - num(prevExpenses._sum.amount);

  return {
    period: { from, to },
    comparedPeriod: { from: prevFrom, to: prevTo },
    netProfit: { current: curNetProfit, previous: prevNetProfit, change: curNetProfit - prevNetProfit },
    revenue: { current: curSales.revenue, previous: prevSales.revenue, change: curSales.revenue - prevSales.revenue },
    cogs: { current: curSales.cogs, previous: prevSales.cogs, change: curSales.cogs - prevSales.cogs },
    expenses: { current: num(curExpenses._sum.amount), previous: num(prevExpenses._sum.amount), change: num(curExpenses._sum.amount) - num(prevExpenses._sum.amount) },
    saleCount: { current: curSales.saleCount, previous: prevSales.saleCount, change: curSales.saleCount - prevSales.saleCount },
  };
}

// ---------------------------------------------------------------------------
// Product & margin intelligence
// ---------------------------------------------------------------------------

async function productMargins(tenantId, { from, to, branchId, limit = 10 }) {
  const items = await prisma.saleItem.findMany({
    where: { sale: { tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to }, ...branchWhere(branchId) } },
    select: { quantity: true, lineTotal: true, productId: true, product: { select: { name: true, purchasePrice: true, categoryId: true } } },
  });
  const byProduct = new Map();
  for (const i of items) {
    const cur = byProduct.get(i.productId) || { productId: i.productId, name: i.product.name, revenue: 0, cost: 0, quantitySold: 0 };
    cur.revenue += num(i.lineTotal);
    cur.cost += num(i.quantity) * num(i.product.purchasePrice);
    cur.quantitySold += num(i.quantity);
    byProduct.set(i.productId, cur);
  }
  const rows = [...byProduct.values()].map((r) => ({
    ...r,
    margin: r.revenue - r.cost,
    marginPercent: r.revenue > 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : null,
  }));
  return {
    bestSelling: [...rows].sort((a, b) => b.quantitySold - a.quantitySold).slice(0, limit),
    mostProfitable: [...rows].sort((a, b) => b.margin - a.margin).slice(0, limit),
    lowMargin: [...rows].filter((r) => r.marginPercent !== null).sort((a, b) => a.marginPercent - b.marginPercent).slice(0, limit),
  };
}

async function supplierPriceChanges(tenantId, { days = 90, limit = 10 }) {
  const since = daysAgo(days);
  const lines = await prisma.purchaseOrderItem.findMany({
    where: { purchaseOrder: { tenantId, createdAt: { gte: since } } },
    select: {
      productId: true,
      unitCost: true,
      product: { select: { name: true } },
      purchaseOrder: { select: { createdAt: true, supplierId: true, supplier: { select: { name: true } } } },
    },
    orderBy: { purchaseOrder: { createdAt: 'asc' } },
  });
  const byKey = new Map();
  for (const l of lines) {
    const key = `${l.productId}:${l.purchaseOrder.supplierId}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        productId: l.productId,
        productName: l.product.name,
        supplierId: l.purchaseOrder.supplierId,
        supplierName: l.purchaseOrder.supplier.name,
        firstCost: num(l.unitCost),
        firstDate: l.purchaseOrder.createdAt,
        lastCost: num(l.unitCost),
        lastDate: l.purchaseOrder.createdAt,
      });
    } else {
      const row = byKey.get(key);
      row.lastCost = num(l.unitCost);
      row.lastDate = l.purchaseOrder.createdAt;
    }
  }
  const rows = [...byKey.values()]
    .filter((r) => r.firstDate.getTime() !== r.lastDate.getTime())
    .map((r) => ({ ...r, changePercent: r.firstCost > 0 ? ((r.lastCost - r.firstCost) / r.firstCost) * 100 : null }))
    .filter((r) => r.changePercent !== null)
    .sort((a, b) => b.changePercent - a.changePercent);
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Inventory demand intelligence
// ---------------------------------------------------------------------------

async function lowStockRisk(tenantId, { branchId, velocityDays = 30 } = {}) {
  // Product has no branchId of its own (stock is tenant-wide, tracked per-warehouse via
  // WarehouseStock, not per-branch) - branchId only narrows the sales velocity below,
  // never which products are considered.
  const products = await prisma.product.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true, stockQuantity: true, lowStockThreshold: true },
  });
  const since = daysAgo(velocityDays);
  const soldRows = await prisma.saleItem.groupBy({
    by: ['productId'],
    where: { sale: { tenantId, status: 'COMPLETED', createdAt: { gte: since }, ...branchWhere(branchId) } },
    _sum: { quantity: true },
  });
  const soldByProduct = new Map(soldRows.map((r) => [r.productId, num(r._sum.quantity)]));

  return products
    .map((p) => {
      const soldInWindow = soldByProduct.get(p.id) || 0;
      const dailyVelocity = soldInWindow / velocityDays;
      const daysOfStockRemaining = dailyVelocity > 0 ? Number((num(p.stockQuantity) / dailyVelocity).toFixed(1)) : null;
      return {
        productId: p.id,
        name: p.name,
        stockQuantity: num(p.stockQuantity),
        lowStockThreshold: num(p.lowStockThreshold),
        dailyVelocity: Number(dailyVelocity.toFixed(2)),
        daysOfStockRemaining,
        isLowStock: num(p.stockQuantity) <= num(p.lowStockThreshold),
        // A simple, explainable reorder suggestion: cover 14 days of
        // observed demand minus what's already on hand. Never auto-applied
        // - always requires an authorized user to confirm before any
        // procurement transaction is created (see Phase 9's non-negotiable rules).
        suggestedReorderQuantity: dailyVelocity > 0 ? Math.max(Math.ceil(dailyVelocity * 14 - num(p.stockQuantity)), 0) : null,
      };
    })
    .filter((r) => r.isLowStock || (r.daysOfStockRemaining !== null && r.daysOfStockRemaining <= 14))
    .sort((a, b) => (a.daysOfStockRemaining ?? Infinity) - (b.daysOfStockRemaining ?? Infinity));
}

async function slowMovingStock(tenantId, { days = 60 } = {}) {
  // Product has no branchId of its own - see lowStockRisk's identical note above.
  const since = daysAgo(days);
  const products = await prisma.product.findMany({
    where: { tenantId, isActive: true, stockQuantity: { gt: 0 } },
    select: { id: true, name: true, stockQuantity: true, purchasePrice: true },
  });
  const soldRows = await prisma.saleItem.groupBy({
    by: ['productId'],
    where: { sale: { tenantId, status: 'COMPLETED', createdAt: { gte: since } } },
    _sum: { quantity: true },
  });
  const soldSince = new Set(soldRows.filter((r) => num(r._sum.quantity) > 0).map((r) => r.productId));

  const rows = products
    .filter((p) => !soldSince.has(p.id))
    .map((p) => ({ productId: p.id, name: p.name, stockQuantity: num(p.stockQuantity), capitalTiedUp: num(p.stockQuantity) * num(p.purchasePrice) }))
    .sort((a, b) => b.capitalTiedUp - a.capitalTiedUp);

  return { windowDays: days, items: rows, totalCapitalTiedUp: rows.reduce((s, r) => s + r.capitalTiedUp, 0) };
}

async function expiryRisk(tenantId, { withinDays = 30 } = {}) {
  // Product has no branchId of its own - see lowStockRisk's identical note above.
  const to = daysAgo(-withinDays); // "in `withinDays` days" from now
  const products = await prisma.product.findMany({
    where: { tenantId, isActive: true, expiryDate: { not: null, lte: to }, stockQuantity: { gt: 0 } },
    select: { id: true, name: true, stockQuantity: true, expiryDate: true, batchNumber: true },
    orderBy: { expiryDate: 'asc' },
  });
  return products.map((p) => ({ ...p, stockQuantity: num(p.stockQuantity), daysUntilExpiry: daysBetween(p.expiryDate, new Date()) }));
}

// ---------------------------------------------------------------------------
// Receivables / payables
// ---------------------------------------------------------------------------

async function receivablesAging(tenantId, { minDaysOverdue = 0, branchId } = {}) {
  const sales = await prisma.sale.findMany({
    where: { tenantId, status: 'COMPLETED', paymentStatus: { in: ['UNPAID', 'PARTIAL'] }, ...branchWhere(branchId) },
    include: { customer: true },
  });
  const now = new Date();
  return sales
    .map((s) => ({
      saleId: s.id,
      invoiceNumber: s.invoiceNumber,
      customerId: s.customerId,
      customerName: s.customer?.name || 'Walk-in',
      amountDue: num(s.total) - num(s.amountPaid),
      daysOverdue: daysBetween(now, s.createdAt),
    }))
    .filter((r) => r.amountDue > 0.001 && r.daysOverdue >= minDaysOverdue)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

async function payablesSummary(tenantId, { branchId } = {}) {
  const purchases = await prisma.purchase.findMany({
    // Only purchases actually received owe money: a draft, cancelled or returned one is not a payable (the
    // web AP aging report makes the same cut).
    where: { tenantId, status: 'RECEIVED', paymentStatus: { in: ['UNPAID', 'PARTIAL'] }, ...branchWhere(branchId) },
    include: { supplier: true },
  });
  const now = new Date();
  return purchases
    .map((p) => ({
      purchaseId: p.id,
      supplierId: p.supplierId,
      supplierName: p.supplier?.name,
      amountDue: num(p.total) - num(p.amountPaid),
      // Phase 6.1: days since the purchase was received, unpaid - the AP-side mirror of
      // receivablesAging's daysOverdue, so payables can be treated symmetrically wherever
      // a "how overdue is this" signal is needed (e.g. an overdue-payables recommendation).
      daysOutstanding: daysBetween(now, p.receivedAt || p.createdAt),
    }))
    .filter((r) => r.amountDue > 0.001)
    .sort((a, b) => b.amountDue - a.amountDue);
}

// Phase 6.1: "which customers owe us the most" - receivablesAging is per-sale; this
// aggregates it per-customer, reusing the exact same underlying data rather than a
// second query.
async function topDebtors(tenantId, { branchId, limit = 10 } = {}) {
  const rows = await receivablesAging(tenantId, { branchId });
  const byCustomer = new Map();
  for (const r of rows) {
    const key = r.customerId || 'walk-in';
    const cur = byCustomer.get(key) || { customerId: r.customerId, customerName: r.customerName, amountDue: 0, oldestDaysOverdue: 0 };
    cur.amountDue += r.amountDue;
    cur.oldestDaysOverdue = Math.max(cur.oldestDaysOverdue, r.daysOverdue);
    byCustomer.set(key, cur);
  }
  return [...byCustomer.values()].sort((a, b) => b.amountDue - a.amountDue).slice(0, limit);
}

// Phase 6.1: "top suppliers" by purchase volume in a period - mirrors highValueCustomers'
// shape/pattern but for the supplier/purchase side.
async function topSuppliers(tenantId, { from, to, branchId, limit = 10 } = {}) {
  const rows = await prisma.purchase.groupBy({
    by: ['supplierId'],
    where: { tenantId, status: 'RECEIVED', createdAt: { gte: from, lte: to }, ...branchWhere(branchId) },
    _sum: { total: true },
    _count: true,
  });
  const top = rows.sort((a, b) => num(b._sum.total) - num(a._sum.total)).slice(0, limit);
  const suppliers = await prisma.supplier.findMany({ where: { id: { in: top.map((r) => r.supplierId) } }, select: { id: true, name: true } });
  const nameById = new Map(suppliers.map((s) => [s.id, s.name]));
  return top.map((r) => ({ supplierId: r.supplierId, supplierName: nameById.get(r.supplierId), totalPurchased: num(r._sum.total), purchaseCount: r._count }));
}

// Phase 6.1: sales broken down by product category - reuses the same saleItem query
// shape as productMargins, just grouped by category instead of product.
async function salesByCategory(tenantId, { from, to, branchId, limit = 10 } = {}) {
  const items = await prisma.saleItem.findMany({
    where: { sale: { tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to }, ...branchWhere(branchId) } },
    select: { quantity: true, lineTotal: true, product: { select: { categoryId: true, category: { select: { name: true } } } } },
  });
  const byCategory = new Map();
  for (const i of items) {
    const key = i.product.categoryId || 'uncategorized';
    const cur = byCategory.get(key) || { categoryId: i.product.categoryId, categoryName: i.product.category?.name || 'Uncategorized', revenue: 0, quantitySold: 0 };
    cur.revenue += num(i.lineTotal);
    cur.quantitySold += num(i.quantity);
    byCategory.set(key, cur);
  }
  return [...byCategory.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

// Phase 6.1: sales broken down by payment method.
async function salesByPaymentMethod(tenantId, { from, to, branchId } = {}) {
  const rows = await prisma.sale.groupBy({
    by: ['paymentMethod'],
    where: { tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to }, ...branchWhere(branchId) },
    _sum: { total: true },
    _count: true,
  });
  return rows.map((r) => ({ paymentMethod: r.paymentMethod, total: num(r._sum.total), saleCount: r._count })).sort((a, b) => b.total - a.total);
}

// Phase 6.1: expense breakdown by category - the same aggregation reports.routes.js's
// /expenses report already does, exposed here so the BI/AI layer can reuse it too
// instead of re-deriving it.
async function expenseBreakdown(tenantId, { from, to, branchId } = {}) {
  const rows = await prisma.expense.groupBy({
    by: ['categoryId'],
    where: { tenantId, status: 'PAID', expenseDate: { gte: from, lte: to }, ...branchWhere(branchId) },
    _sum: { amount: true },
  });
  const categories = await prisma.expenseCategory.findMany({ where: { tenantId }, select: { id: true, name: true } });
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  return rows
    .map((r) => ({ categoryId: r.categoryId, categoryName: nameById.get(r.categoryId) || 'Uncategorized', total: num(r._sum.amount) }))
    .sort((a, b) => b.total - a.total);
}

// Phase 6.1: overstock - the inverse case of lowStockRisk. A product that IS selling
// (has real velocity) but holds far more stock than that velocity justifies, distinct
// from slowMovingStock (which is specifically zero sales in the window).
async function overstockRisk(tenantId, { branchId, velocityDays = 30, daysThreshold = 180 } = {}) {
  // Product has no branchId of its own - see lowStockRisk's identical note above;
  // branchId still correctly narrows the sales velocity query below.
  const products = await prisma.product.findMany({
    where: { tenantId, isActive: true, stockQuantity: { gt: 0 } },
    select: { id: true, name: true, stockQuantity: true, purchasePrice: true },
  });
  const since = daysAgo(velocityDays);
  const soldRows = await prisma.saleItem.groupBy({
    by: ['productId'],
    where: { sale: { tenantId, status: 'COMPLETED', createdAt: { gte: since }, ...branchWhere(branchId) } },
    _sum: { quantity: true },
  });
  const soldByProduct = new Map(soldRows.map((r) => [r.productId, num(r._sum.quantity)]));

  return products
    .map((p) => {
      const soldInWindow = soldByProduct.get(p.id) || 0;
      const dailyVelocity = soldInWindow / velocityDays;
      const daysOfStockRemaining = dailyVelocity > 0 ? Number((num(p.stockQuantity) / dailyVelocity).toFixed(1)) : null;
      return { productId: p.id, name: p.name, stockQuantity: num(p.stockQuantity), dailyVelocity: Number(dailyVelocity.toFixed(2)), daysOfStockRemaining, capitalTiedUp: num(p.stockQuantity) * num(p.purchasePrice) };
    })
    .filter((r) => r.daysOfStockRemaining !== null && r.daysOfStockRemaining > daysThreshold)
    .sort((a, b) => b.capitalTiedUp - a.capitalTiedUp);
}

// ---------------------------------------------------------------------------
// Customer intelligence
// ---------------------------------------------------------------------------

async function newVsReturningCustomers(tenantId, { from, to }) {
  const [newCustomers, activeInRange] = await Promise.all([
    prisma.customer.count({ where: { tenantId, createdAt: { gte: from, lte: to } } }),
    prisma.sale.findMany({
      where: { tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to }, customerId: { not: null } },
      select: { customer: { select: { id: true, createdAt: true } } },
      distinct: ['customerId'],
    }),
  ]);
  const returning = activeInRange.filter((s) => s.customer && new Date(s.customer.createdAt) < from).length;
  return { newCustomers, returningCustomers: returning };
}

async function inactiveCustomers(tenantId, { days = 180, limit = 20 } = {}) {
  const cutoff = daysAgo(days);
  const customers = await prisma.customer.findMany({
    where: { tenantId, isActive: true, createdAt: { lt: cutoff }, sales: { none: { createdAt: { gte: cutoff }, status: 'COMPLETED' } } },
    select: { id: true, name: true, phone: true, createdAt: true },
    take: limit,
  });
  return customers;
}

async function highValueCustomers(tenantId, { limit = 10 } = {}) {
  const rows = await prisma.sale.groupBy({
    by: ['customerId'],
    where: { tenantId, status: 'COMPLETED', customerId: { not: null } },
    _sum: { total: true },
    _count: true,
  });
  const top = rows.sort((a, b) => num(b._sum.total) - num(a._sum.total)).slice(0, limit);
  const customers = await prisma.customer.findMany({ where: { id: { in: top.map((r) => r.customerId) } }, select: { id: true, name: true } });
  const nameById = new Map(customers.map((c) => [c.id, c.name]));
  return top.map((r) => ({ customerId: r.customerId, customerName: nameById.get(r.customerId), lifetimeValue: num(r._sum.total), orderCount: r._count }));
}

// ---------------------------------------------------------------------------
// Optical / clinic intelligence
// ---------------------------------------------------------------------------

async function delayedOpticalJobs(tenantId, { branchId } = {}) {
  const now = new Date();
  const orders = await prisma.opticalOrder.findMany({
    where: {
      tenantId,
      status: { notIn: ['DELIVERED', 'CANCELLED'] },
      expectedDeliveryDate: { not: null, lt: now },
      ...branchWhere(branchId),
    },
    include: { customer: true },
    orderBy: { expectedDeliveryDate: 'asc' },
  });
  return orders.map((o) => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    customerName: o.customer?.name,
    status: o.status,
    expectedDeliveryDate: o.expectedDeliveryDate,
    daysOverdue: daysBetween(now, o.expectedDeliveryDate),
  }));
}

async function labPerformance(tenantId, { from, to } = {}) {
  const orders = await prisma.opticalOrder.findMany({
    where: { tenantId, labId: { not: null }, createdAt: { gte: from, lte: to }, deliveredAt: { not: null } },
    select: { labId: true, lab: { select: { name: true } }, createdAt: true, deliveredAt: true },
  });
  const byLab = new Map();
  for (const o of orders) {
    const cur = byLab.get(o.labId) || { labId: o.labId, labName: o.lab.name, totalDays: 0, count: 0 };
    cur.totalDays += daysBetween(o.deliveredAt, o.createdAt);
    cur.count += 1;
    byLab.set(o.labId, cur);
  }
  return [...byLab.values()].map((l) => ({ ...l, avgTurnaroundDays: l.count > 0 ? Number((l.totalDays / l.count).toFixed(1)) : null }));
}

async function appointmentNoShowTrend(tenantId, { from, to, branchId } = {}) {
  const appointments = await prisma.appointment.findMany({
    where: { tenantId, scheduledAt: { gte: from, lte: to }, ...branchWhere(branchId) },
    select: { status: true },
  });
  const total = appointments.length;
  const noShows = appointments.filter((a) => a.status === 'NO_SHOW').length;
  return { total, noShows, noShowRatePercent: total > 0 ? (noShows / total) * 100 : null };
}

async function examinationConversion(tenantId, { from, to } = {}) {
  const [examCount, orders] = await Promise.all([
    prisma.examination.count({ where: { tenantId, examDate: { gte: from, lte: to } } }),
    prisma.opticalOrder.count({ where: { tenantId, createdAt: { gte: from, lte: to }, patientId: { not: null } } }),
  ]);
  return { examinationsCount: examCount, opticalOrdersFromExam: orders, conversionRatePercent: examCount > 0 ? (orders / examCount) * 100 : null };
}

// ---------------------------------------------------------------------------
// Cash / accounting snapshot (reads existing ledger balances, never
// recomputes accounting - the ledger itself remains the single source of truth)
// ---------------------------------------------------------------------------

async function cashSnapshot(tenantId) {
  const [receivables, payables] = await Promise.all([
    receivablesAging(tenantId, {}),
    payablesSummary(tenantId, {}),
  ]);
  return {
    totalReceivables: receivables.reduce((s, r) => s + r.amountDue, 0),
    totalPayables: payables.reduce((s, r) => s + r.amountDue, 0),
    overdue60Receivables: receivables.filter((r) => r.daysOverdue >= 60),
  };
}

module.exports = {
  num, startOfDay, daysAgo, daysBetween,
  salesTotals, salesComparison, branchProfitability, profitDeclineAnalysis,
  productMargins, supplierPriceChanges,
  lowStockRisk, slowMovingStock, expiryRisk, overstockRisk,
  receivablesAging, payablesSummary, topDebtors,
  newVsReturningCustomers, inactiveCustomers, highValueCustomers, topSuppliers,
  salesByCategory, salesByPaymentMethod, expenseBreakdown,
  delayedOpticalJobs, labPerformance, appointmentNoShowTrend, examinationConversion,
  cashSnapshot,
};
