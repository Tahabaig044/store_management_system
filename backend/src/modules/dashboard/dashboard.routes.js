const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { ValidationError } = require('../../utils/errors');
const fin = require('../accounting/financialReportsService');
const { branchScopeWhere } = require('../../middleware/branchScope');
// Phase 6.1/6.2: reuses the deterministic BI/analytics layer rather than re-deriving
// top-suppliers/top-debtors/sales-by-category/sales-by-payment-method/overstock here.
const analytics = require('../ai/analytics');

const router = express.Router();
router.use(authenticate, requireTenant);

// Phase 0.5: this dashboard is a Universal Module - it aggregates whatever
// Core/Universal/Industry data is enabled for the tenant, so (unlike an
// Industry module's own routes) it is never blocked outright. Instead, the
// Optical/Clinical sections below are computed only when the module is
// enabled, so a tenant that has disabled it gets a dashboard with those
// fields empty/zeroed rather than Optical data it never opted into.
function isOpticalEnabled(req) {
  return (req.tenant?.enabledIndustryPacks || []).includes('OPTICAL');
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

router.get('/', async (req, res) => {
  const tenantId = req.user.tenantId;
  const today = startOfDay();
  const monthStart = startOfMonth();
  const opticalEnabled = isOpticalEnabled(req);
  // Phase 0.6: this basic dashboard has no role gate at all (any authenticated
  // staff member can view it, unlike /command-center below which is
  // MANAGEMENT-only) - so unlike command-center, a branch-restricted role
  // hitting this endpoint must only see their own accessible branch(es)'
  // sales/purchases, not the whole tenant. Previously these two aggregates
  // were unconditionally tenant-wide, silently leaking every branch's totals
  // to e.g. a single-branch CASHIER or RECEPTIONIST.
  const scope = await branchScopeWhere(prisma, req.user);

  const [
    todaySales,
    monthSales,
    monthPurchases,
    products,
    customerCount,
    supplierCount,
    pendingOpticalOrders,
    lowStockCandidates,
    expiringMedicines,
  ] = await Promise.all([
    prisma.sale.aggregate({
      where: { tenantId, status: 'COMPLETED', createdAt: { gte: today }, ...scope },
      _sum: { total: true },
      _count: true,
    }),
    prisma.sale.aggregate({
      where: { tenantId, status: 'COMPLETED', createdAt: { gte: monthStart }, ...scope },
      _sum: { total: true },
      _count: true,
    }),
    prisma.purchase.aggregate({
      where: { tenantId, status: 'RECEIVED', createdAt: { gte: monthStart }, ...scope },
      _sum: { total: true },
    }),
    prisma.product.findMany({
      where: { tenantId, isActive: true },
      select: { stockQuantity: true, purchasePrice: true, lowStockThreshold: true, expiryDate: true, name: true },
    }),
    prisma.customer.count({ where: { tenantId, isActive: true } }),
    prisma.supplier.count({ where: { tenantId, isActive: true } }),
    opticalEnabled
      ? prisma.opticalOrder.count({ where: { tenantId, status: { in: ['PENDING', 'IN_LAB', 'READY'] } } })
      : Promise.resolve(0),
    null,
    null,
  ]);

  const inventoryValue = products.reduce((sum, p) => sum + Number(p.stockQuantity) * Number(p.purchasePrice), 0);
  const lowStockItems = products.filter((p) => Number(p.stockQuantity) <= Number(p.lowStockThreshold));

  const in30Days = new Date();
  in30Days.setDate(in30Days.getDate() + 30);
  const expiring = products.filter((p) => p.expiryDate && new Date(p.expiryDate) <= in30Days);

  // Gross profit estimate: sale line revenue minus each product's current
  // average purchase cost - a simplification since Phase 1 doesn't do FIFO/lot costing.
  const monthSaleItems = await prisma.saleItem.findMany({
    where: { sale: { tenantId, status: 'COMPLETED', createdAt: { gte: monthStart } } },
    include: { product: { select: { purchasePrice: true } } },
  });
  const grossProfitEstimate = monthSaleItems.reduce(
    (sum, item) => sum + (Number(item.lineTotal) - Number(item.quantity) * Number(item.product.purchasePrice)),
    0
  );

  res.json({
    todaySales: { total: Number(todaySales._sum.total || 0), count: todaySales._count },
    monthSales: { total: Number(monthSales._sum.total || 0), count: monthSales._count },
    monthPurchases: { total: Number(monthPurchases._sum.total || 0) },
    grossProfitEstimate,
    inventoryValue,
    customerCount,
    supplierCount,
    pendingOpticalOrders,
    lowStockItems: lowStockItems.slice(0, 20),
    lowStockCount: lowStockItems.length,
    expiringMedicines: expiring.slice(0, 20),
    expiringCount: expiring.length,
  });
});

// ---------------------------------------------------------------------------
// Advanced Admin/Owner Business Command Center (Phase 4)
// ---------------------------------------------------------------------------
// Restricted to TENANT_ADMIN/MANAGER only - this surface aggregates
// financial totals (cash/bank/receivables/payables) across the whole
// tenant, which is deliberately narrower than who can see the basic
// dashboard above.

const filterSchema = z.object({
  range: z.enum(['today', 'yesterday', 'week', 'month', 'custom']).default('today'),
  from: z.string().optional(),
  to: z.string().optional(),
  branchId: z.string().uuid().optional(),
  // Phase 6.2: company/warehouse join branch as first-class Command Center filters,
  // matching what the mobile dashboard (Phase 4.2) already supports.
  companyId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
  paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID']).optional(),
  orderStatus: z.enum(['PENDING', 'IN_LAB', 'READY', 'DELIVERED', 'CANCELLED']).optional(),
});

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
    const from = new Date(startOfToday); from.setDate(from.getDate() - 1);
    const to = new Date(from); to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  if (f.range === 'week') {
    const from = new Date(startOfToday); from.setDate(from.getDate() - 6);
    return { from, to: now };
  }
  if (f.range === 'month') {
    return { from: startOfMonth(now), to: now };
  }
  return { from: startOfToday, to: now };
}

function isCashMethod(method) {
  return (method || '').trim().toLowerCase() === 'cash';
}

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

router.get('/command-center', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid dashboard filters', parsed.error.flatten());
  const f = parsed.data;
  const tenantId = req.user.tenantId;
  const { from, to } = resolveRange(f);
  const opticalEnabled = isOpticalEnabled(req);

  // Ownership checks for any filter referencing another tenant-owned record -
  // same IDOR-prevention pattern used everywhere else in the codebase.
  const ownershipChecks = [
    f.branchId && prisma.branch.findFirst({ where: { id: f.branchId, tenantId } }),
    f.companyId && prisma.company.findFirst({ where: { id: f.companyId, tenantId } }),
    f.warehouseId && prisma.warehouse.findFirst({ where: { id: f.warehouseId, tenantId } }),
    f.categoryId && prisma.category.findFirst({ where: { id: f.categoryId, tenantId } }),
    f.productId && prisma.product.findFirst({ where: { id: f.productId, tenantId } }),
    f.supplierId && prisma.supplier.findFirst({ where: { id: f.supplierId, tenantId } }),
    f.customerId && prisma.customer.findFirst({ where: { id: f.customerId, tenantId } }),
    f.staffId && prisma.user.findFirst({ where: { id: f.staffId, tenantId } }),
  ].filter(Boolean);
  if (ownershipChecks.length) {
    const results = await Promise.all(ownershipChecks);
    if (results.some((r) => !r)) throw new ValidationError('One or more filters reference a record outside this tenant');
  }

  // Phase 6.2: resolves branchId + companyId together into the exact set of branch ids
  // this response must be limited to (or null for "every branch") - reused everywhere
  // a single f.branchId spread used to be the only option, so a company filter now
  // narrows every KPI/widget the same way a single branch always did.
  const scopedBranchIds = (f.branchId || f.companyId) ? await fin.resolveBranchIds(prisma, req.user, { branchId: f.branchId, companyId: f.companyId }) : null;
  const branchScope = scopedBranchIds === null ? {} : { branchId: { in: scopedBranchIds } };

  const saleWhere = {
    tenantId,
    status: 'COMPLETED',
    createdAt: { gte: from, lte: to },
    ...branchScope,
    ...(f.warehouseId && { warehouseId: f.warehouseId }),
    ...(f.customerId && { customerId: f.customerId }),
    ...(f.staffId && { cashierId: f.staffId }),
    ...(f.paymentStatus && { paymentStatus: f.paymentStatus }),
  };
  const purchaseWhere = {
    tenantId,
    status: 'RECEIVED',
    receivedAt: { gte: from, lte: to },
    ...branchScope,
    ...(f.warehouseId && { warehouseId: f.warehouseId }),
    ...(f.supplierId && { supplierId: f.supplierId }),
    ...(f.paymentStatus && { paymentStatus: f.paymentStatus }),
  };
  const productWhere = {
    tenantId,
    isActive: true,
    ...(f.categoryId && { categoryId: f.categoryId }),
    ...(f.productId && { id: f.productId }),
  };

  const [
    sales,
    saleItems,
    purchaseAgg,
    expenseAgg,
    payments,
    products,
    openReceivableSales,
    openOpticalOrders,
    openPayablePurchases,
    branches,
    staffUsers,
    opticalOrdersInScope,
    salesCustomers,
  ] = await Promise.all([
    prisma.sale.findMany({ where: saleWhere, select: { id: true, total: true, createdAt: true, branchId: true, cashierId: true, customerId: true } }),
    prisma.saleItem.findMany({
      where: { sale: saleWhere, ...(f.productId && { productId: f.productId }), ...(f.categoryId && { product: { categoryId: f.categoryId } }) },
      select: { productId: true, quantity: true, lineTotal: true, sale: { select: { createdAt: true } }, product: { select: { name: true, purchasePrice: true } } },
    }),
    prisma.purchase.aggregate({ where: purchaseWhere, _sum: { total: true }, _count: true }),
    prisma.expense.aggregate({ where: { tenantId, expenseDate: { gte: from, lte: to } }, _sum: { amount: true } }),
    prisma.payment.findMany({ where: { tenantId, paidAt: { gte: from, lte: to } }, select: { direction: true, amount: true, method: true } }),
    prisma.product.findMany({ where: productWhere, select: { id: true, name: true, stockQuantity: true, purchasePrice: true, lowStockThreshold: true, expiryDate: true, createdAt: true } }),
    prisma.sale.findMany({
      where: { tenantId, status: 'COMPLETED', paymentStatus: { not: 'PAID' }, ...(f.customerId && { customerId: f.customerId }), ...branchScope },
      select: { id: true, total: true, amountPaid: true, customer: { select: { id: true, name: true } } },
    }),
    opticalEnabled
      ? prisma.opticalOrder.findMany({
          where: { tenantId, status: { not: 'CANCELLED' }, ...(f.customerId && { customerId: f.customerId }) },
          select: { id: true, totalAmount: true, amountPaid: true, status: true, expectedDeliveryDate: true, customer: { select: { id: true, name: true } } },
        })
      : Promise.resolve([]),
    prisma.purchase.findMany({
      where: { tenantId, status: 'RECEIVED', paymentStatus: { not: 'PAID' }, ...(f.supplierId && { supplierId: f.supplierId }), ...branchScope },
      select: { id: true, total: true, amountPaid: true, supplier: { select: { id: true, name: true } } },
    }),
    prisma.branch.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    opticalEnabled
      ? prisma.opticalOrder.findMany({
          where: { tenantId, ...(f.orderStatus ? { status: f.orderStatus } : { status: { not: 'CANCELLED' } }), ...(f.customerId && { customerId: f.customerId }) },
          select: { id: true, status: true, expectedDeliveryDate: true },
        })
      : Promise.resolve([]),
    prisma.sale.findMany({
      where: { ...saleWhere, customerId: { not: null } },
      select: { customer: { select: { id: true, createdAt: true } } },
      distinct: ['customerId'],
    }),
  ]);

  // --- KPIs ---
  const rangeSalesTotal = sales.reduce((s, x) => s + Number(x.total), 0);
  const grossProfit = saleItems.reduce((s, i) => s + (Number(i.lineTotal) - Number(i.quantity) * Number(i.product.purchasePrice)), 0);
  const totalExpenses = Number(expenseAgg._sum.amount || 0);
  const netProfit = grossProfit - totalExpenses;
  const purchasesTotal = Number(purchaseAgg._sum.total || 0);

  let cashIn = 0, cashOut = 0, bankIn = 0, bankOut = 0;
  for (const p of payments) {
    const amt = Number(p.amount);
    if (isCashMethod(p.method)) {
      if (p.direction === 'IN') cashIn += amt; else cashOut += amt;
    } else {
      if (p.direction === 'IN') bankIn += amt; else bankOut += amt;
    }
  }

  const receivables = openReceivableSales.reduce((s, x) => s + Math.max(Number(x.total) - Number(x.amountPaid), 0), 0)
    + openOpticalOrders.reduce((s, x) => s + Math.max(Number(x.totalAmount) - Number(x.amountPaid), 0), 0);
  const payables = openPayablePurchases.reduce((s, x) => s + Math.max(Number(x.total) - Number(x.amountPaid), 0), 0);
  const inventoryValue = products.reduce((s, p) => s + Number(p.stockQuantity) * Number(p.purchasePrice), 0);

  // --- Trends (daily buckets, capped to 90 points for payload/perf safety) ---
  const spanDays = Math.min(Math.ceil((to - from) / 86400000) + 1, 90);
  const salesTrendMap = new Map();
  const profitTrendMap = new Map();
  for (const s of sales) {
    const k = dayKey(s.createdAt);
    salesTrendMap.set(k, (salesTrendMap.get(k) || 0) + Number(s.total));
  }
  for (const i of saleItems) {
    const k = dayKey(i.sale.createdAt);
    const profit = Number(i.lineTotal) - Number(i.quantity) * Number(i.product.purchasePrice);
    profitTrendMap.set(k, (profitTrendMap.get(k) || 0) + profit);
  }
  const salesTrend = [...salesTrendMap.entries()].sort().slice(-spanDays).map(([date, total]) => ({ date, total }));
  const profitTrend = [...profitTrendMap.entries()].sort().slice(-spanDays).map(([date, profit]) => ({ date, profit }));

  // --- Top / most-profitable products ---
  const productAgg = new Map();
  for (const i of saleItems) {
    const cur = productAgg.get(i.productId) || { name: i.product.name, quantity: 0, revenue: 0, profit: 0 };
    cur.quantity += Number(i.quantity);
    cur.revenue += Number(i.lineTotal);
    cur.profit += Number(i.lineTotal) - Number(i.quantity) * Number(i.product.purchasePrice);
    productAgg.set(i.productId, cur);
  }
  const productAggList = [...productAgg.entries()].map(([productId, v]) => ({ productId, ...v }));
  const topProducts = [...productAggList].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const mostProfitableProducts = [...productAggList].sort((a, b) => b.profit - a.profit).slice(0, 10);

  // --- Stock widgets ---
  const lowStockItems = products.filter((p) => Number(p.stockQuantity) <= Number(p.lowStockThreshold));
  const soldProductIds = new Set(productAggList.map((p) => p.productId));
  const sixtyDaysAgo = new Date(); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const slowMovingStock = products.filter((p) => Number(p.stockQuantity) > 0 && !soldProductIds.has(p.id) && new Date(p.createdAt) <= sixtyDaysAgo);
  // Dead stock (no sale ever, not just within the selected range) requires a
  // separate lifetime lookup - the range-scoped saleItems above can't tell us that.
  const everSoldIds = new Set(
    (await prisma.saleItem.findMany({
      where: { productId: { in: products.map((p) => p.id) }, sale: { status: 'COMPLETED' } },
      select: { productId: true },
      distinct: ['productId'],
    })).map((r) => r.productId)
  );
  const deadStock = products.filter((p) => Number(p.stockQuantity) > 0 && !everSoldIds.has(p.id) && new Date(p.createdAt) <= sixtyDaysAgo);

  const in30Days = new Date(); in30Days.setDate(in30Days.getDate() + 30);
  const expiringMedicines = products.filter((p) => p.expiryDate && new Date(p.expiryDate) <= in30Days);

  // --- Optical jobs ---
  const now = new Date();
  const pendingJobs = opticalOrdersInScope.filter((o) => o.status === 'PENDING');
  const readyJobs = opticalOrdersInScope.filter((o) => o.status === 'READY');
  const delayedJobs = opticalOrdersInScope.filter(
    (o) => ['PENDING', 'IN_LAB', 'READY'].includes(o.status) && o.expectedDeliveryDate && new Date(o.expectedDeliveryDate) < now
  );

  // --- New vs returning customers ---
  // "New" = the customer's own createdAt falls inside the selected range
  // (they were created and bought within the same window); "returning" =
  // they already existed before this range started.
  const newCustomersCount = salesCustomers.filter((s) => s.customer && new Date(s.customer.createdAt) >= from).length;
  const returningCustomersCount = salesCustomers.filter((s) => s.customer && new Date(s.customer.createdAt) < from).length;

  // --- Branch / staff performance ---
  const branchMap = new Map(branches.map((b) => [b.id, b.name]));
  const staffMap = new Map(staffUsers.map((u) => [u.id, u.name]));
  const byBranch = new Map();
  const byStaff = new Map();
  for (const s of sales) {
    const bKey = s.branchId || 'unassigned';
    const bCur = byBranch.get(bKey) || { branchId: s.branchId, branchName: s.branchId ? branchMap.get(s.branchId) || 'Unknown' : 'Unassigned', total: 0, count: 0 };
    bCur.total += Number(s.total); bCur.count += 1;
    byBranch.set(bKey, bCur);

    const stKey = s.cashierId || 'unassigned';
    const stCur = byStaff.get(stKey) || { staffId: s.cashierId, staffName: s.cashierId ? staffMap.get(s.cashierId) || 'Unknown' : 'Unassigned', total: 0, count: 0 };
    stCur.total += Number(s.total); stCur.count += 1;
    byStaff.set(stKey, stCur);
  }

  // --- Phase 5: accounting/procurement intelligence -----------------------
  // Cash/bank *position* (a running balance, unlike the kpis.cash/bank
  // period-movement figures above) is derived straight from the ledger -
  // the accounting-authoritative source, not a re-derivation of Sale/
  // Purchase rows.
  // Phase 2.3: the same ledger-derived KPI service the financial reports use, so
  // the dashboard can never disagree with the Trial Balance / P&L / Balance Sheet,
  // and the cash/bank position now honors the dashboard's branch/company filter (it
  // used to show the tenant-wide balance even when a branch was selected).
  // Phase 6.2: reuses the same scopedBranchIds already resolved above (branch+company
  // combined), instead of resolving branchId alone a second time.
  const ledgerKpis = await fin.kpis(prisma, req.user, scopedBranchIds, { from, to });
  const cashBalance = ledgerKpis.cashBalance;
  const bankBalance = ledgerKpis.bankBalance;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const receivablesOverdue = openReceivableSales
    .filter((s) => new Date(s.createdAt || 0) < thirtyDaysAgo)
    .reduce((sum, s) => sum + Math.max(Number(s.total) - Number(s.amountPaid), 0), 0);
  const payablesOverdue = openPayablePurchases
    .filter((p) => new Date(p.receivedAt || p.createdAt || 0) < thirtyDaysAgo)
    .reduce((sum, p) => sum + Math.max(Number(p.total) - Number(p.amountPaid), 0), 0);

  const [pendingPurchaseRequestApprovals, pendingPurchaseOrderApprovals, pendingPOs, purchasePriceSamples] = await Promise.all([
    prisma.purchaseRequest.count({ where: { tenantId, status: 'PENDING_APPROVAL' } }),
    prisma.purchaseOrder.count({ where: { tenantId, status: 'PENDING_APPROVAL' } }),
    prisma.purchaseOrder.findMany({
      where: { tenantId, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } },
      select: { id: true, poNumber: true, total: true, status: true, supplier: { select: { name: true } } },
    }),
    // Most recent purchase cost per product, used below to flag price changes.
    prisma.purchaseItem.findMany({
      where: { purchase: { tenantId, status: 'RECEIVED' } },
      select: { productId: true, unitCost: true, purchase: { select: { createdAt: true } }, product: { select: { name: true } } },
      orderBy: { purchase: { createdAt: 'desc' } },
      take: 500,
    }),
  ]);

  const latestTwoByProduct = new Map();
  for (const row of purchasePriceSamples) {
    const list = latestTwoByProduct.get(row.productId) || [];
    if (list.length < 2) list.push(row);
    latestTwoByProduct.set(row.productId, list);
  }
  const purchasePriceChanges = [...latestTwoByProduct.values()]
    .filter((list) => list.length === 2 && Number(list[1].unitCost) > 0)
    .map(([latest, previous]) => ({
      productId: latest.productId,
      productName: latest.product.name,
      previousCost: Number(previous.unitCost),
      latestCost: Number(latest.unitCost),
      changePercent: ((Number(latest.unitCost) - Number(previous.unitCost)) / Number(previous.unitCost)) * 100,
    }))
    .filter((c) => Math.abs(c.changePercent) > 0.01)
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, 10);

  // --- Phase 6: multi-branch/warehouse intelligence -----------------------
  const [warehouses, pendingTransferApprovals, transferPipelineRows] = await Promise.all([
    prisma.warehouse.findMany({ where: { tenantId, isActive: true } }),
    prisma.stockTransfer.count({ where: { tenantId, status: 'PENDING_APPROVAL' } }),
    prisma.stockTransfer.findMany({
      where: { tenantId, status: { in: ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_TRANSIT'] } },
      include: { sourceWarehouse: true, destinationWarehouse: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);
  const warehouseComparison = await Promise.all(
    warehouses.map(async (w) => {
      const stocks = await prisma.warehouseStock.findMany({ where: { warehouseId: w.id }, include: { product: { select: { purchasePrice: true } } } });
      const totalValue = stocks.reduce((s, r) => s + Number(r.quantity) * Number(r.product.purchasePrice), 0);
      return { warehouseId: w.id, warehouseName: w.name, branchId: w.branchId, isCentral: w.isCentral, totalValue, productCount: stocks.length };
    })
  );

  // --- Phase 7: clinical/optical Command Center intelligence --------------
  // Phase 0.5: this whole self-contained block (queries + calculation) is
  // owned by the Optical industry module - skipped entirely when a tenant
  // has it disabled, so no Optical/Clinical table is even queried, and
  // `clinical` in the response below is simply null.
  const clinicalKpis = !opticalEnabled ? null : await (async () => {
    // "Today" figures are always literal-today (a live ops view), independent
    // of the range filter above - the same convention the original Phase 1
    // dashboard uses for "today's sales".
    const todayStart = startOfDay();
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [
      todaysAppointments,
      seenTodayPatientIds,
      examsToday,
      opticalOrdersInRange,
      examsInRange,
      doctors,
      newPatientsInRange,
      patientsWithApptInRange,
    ] = await Promise.all([
      prisma.appointment.findMany({ where: { tenantId, scheduledAt: { gte: todayStart, lte: todayEnd } }, select: { id: true, status: true } }),
      prisma.appointment.findMany({
        where: { tenantId, scheduledAt: { gte: todayStart, lte: todayEnd }, status: { in: ['ARRIVED', 'IN_PROGRESS', 'COMPLETED'] } },
        select: { patientId: true },
        distinct: ['patientId'],
      }),
      prisma.examination.count({ where: { tenantId, examDate: { gte: todayStart, lte: todayEnd } } }),
      prisma.opticalOrder.findMany({ where: { tenantId, createdAt: { gte: from, lte: to } }, select: { id: true, status: true, patientId: true, totalAmount: true, amountPaid: true, expectedDeliveryDate: true } }),
      prisma.examination.count({ where: { tenantId, examDate: { gte: from, lte: to } } }),
      prisma.doctor.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } }),
      prisma.patient.count({ where: { tenantId, createdAt: { gte: from, lte: to } } }),
      prisma.appointment.findMany({ where: { tenantId, scheduledAt: { gte: from, lte: to } }, select: { patientId: true, patient: { select: { createdAt: true } } }, distinct: ['patientId'] }),
    ]);

    const prescriptionsIssuedToday = await prisma.clinicalPrescription.count({ where: { tenantId, issueDate: { gte: todayStart, lte: todayEnd } } });
    const doctorAppointmentRows = await prisma.appointment.findMany({
      where: { tenantId, scheduledAt: { gte: from, lte: to }, doctorId: { not: null } },
      select: { doctorId: true, status: true },
    });
    const doctorMap = new Map(doctors.map((d) => [d.id, d.name]));
    const byDoctor = new Map();
    for (const a of doctorAppointmentRows) {
      const cur = byDoctor.get(a.doctorId) || { doctorId: a.doctorId, doctorName: doctorMap.get(a.doctorId) || 'Unknown', appointments: 0, completed: 0 };
      cur.appointments += 1;
      if (a.status === 'COMPLETED') cur.completed += 1;
      byDoctor.set(a.doctorId, cur);
    }

    const opticalStatusCounts = {};
    let outstandingOpticalPayments = 0;
    let clinicalDelayedJobs = 0;
    for (const o of opticalOrdersInRange) {
      opticalStatusCounts[o.status] = (opticalStatusCounts[o.status] || 0) + 1;
      outstandingOpticalPayments += Math.max(Number(o.totalAmount) - Number(o.amountPaid), 0);
      if (o.expectedDeliveryDate && new Date(o.expectedDeliveryDate) < now && !['READY', 'DELIVERED', 'CANCELLED'].includes(o.status)) clinicalDelayedJobs += 1;
    }
    const opticalOrdersFromExam = opticalOrdersInRange.filter((o) => o.patientId).length;

    const returningPatientsInRange = patientsWithApptInRange.filter((a) => a.patient && new Date(a.patient.createdAt) < from).length;

    return {
      today: {
        appointments: todaysAppointments.length,
        patientsSeen: seenTodayPatientIds.length,
        waitingQueue: todaysAppointments.filter((a) => ['SCHEDULED', 'CONFIRMED', 'ARRIVED'].includes(a.status)).length,
        completedExaminations: examsToday,
        prescriptionsIssued: prescriptionsIssuedToday,
      },
      range: {
        examinationsCount: examsInRange,
        opticalOrdersCreated: opticalOrdersInRange.length,
        opticalOrdersByStatus: opticalStatusCounts,
        pendingJobs: (opticalStatusCounts.PENDING || 0) + (opticalStatusCounts.IN_LAB || 0) + (opticalStatusCounts.QUALITY_CHECK || 0),
        delayedJobs: clinicalDelayedJobs,
        readyOrders: opticalStatusCounts.READY || 0,
        deliveredOrders: opticalStatusCounts.DELIVERED || 0,
        outstandingOpticalPayments,
        newPatients: newPatientsInRange,
        returningPatients: returningPatientsInRange,
        examinationToOpticalOrderConversionPercent: examsInRange > 0 ? (opticalOrdersFromExam / examsInRange) * 100 : null,
      },
      doctorPerformance: [...byDoctor.values()].sort((a, b) => b.appointments - a.appointments),
    };
  })();

  // Phase 8 - communication/automation Command Center intelligence.
  // Additive: existing consumers of this endpoint that don't know about
  // this key are unaffected.
  const [messagesInRange, queuedMessages, failedAutomationExecutions, followUpNotifications] = await Promise.all([
    prisma.message.findMany({
      where: { tenantId, queuedAt: { gte: from, lte: to } },
      select: { status: true, channel: true, branchId: true },
    }),
    prisma.message.count({ where: { tenantId, status: 'QUEUED' } }),
    prisma.automationExecution.findMany({
      where: { tenantId, status: 'FAILED', createdAt: { gte: from, lte: to } },
      include: { automationRule: { select: { name: true, event: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.notification.count({ where: { tenantId, type: 'PORTAL_FOLLOW_UP_REQUEST', isRead: false } }),
  ]);

  const messageStatusCounts = {};
  const messageChannelCounts = {};
  const messagesByBranch = new Map();
  for (const m of messagesInRange) {
    messageStatusCounts[m.status] = (messageStatusCounts[m.status] || 0) + 1;
    messageChannelCounts[m.channel] = (messageChannelCounts[m.channel] || 0) + 1;
    const branchKey = m.branchId || 'unassigned';
    const cur = messagesByBranch.get(branchKey) || { branchId: m.branchId, total: 0, sent: 0, failed: 0 };
    cur.total += 1;
    if (['SENT', 'DELIVERED', 'READ'].includes(m.status)) cur.sent += 1;
    if (m.status === 'FAILED') cur.failed += 1;
    messagesByBranch.set(branchKey, cur);
  }

  const communicationKpis = {
    total: messagesInRange.length,
    byStatus: messageStatusCounts,
    byChannel: messageChannelCounts,
    pendingQueue: queuedMessages,
    failedRequiringAttention: failedAutomationExecutions.map((e) => ({
      id: e.id,
      ruleName: e.automationRule?.name,
      event: e.event,
      error: e.error,
      at: e.createdAt,
    })),
    overdueFollowUps: followUpNotifications,
    performanceByBranch: [...messagesByBranch.values()],
  };

  // --- Phase 6.1/6.2: growth + BI-layer widgets --------------------------
  // "Compared with the immediately preceding, same-length period" - the same
  // convention analytics.js's salesComparison already uses elsewhere.
  const growthSpanMs = to.getTime() - from.getTime();
  const growthPrevTo = new Date(from.getTime() - 1);
  const growthPrevFrom = new Date(growthPrevTo.getTime() - growthSpanMs);
  const [prevSalesAgg, prevPurchaseAgg, topSuppliersList, topDebtorsList, salesByCategoryList, salesByPaymentMethodList, overstockList] = await Promise.all([
    prisma.sale.aggregate({ where: { tenantId, status: 'COMPLETED', createdAt: { gte: growthPrevFrom, lte: growthPrevTo }, ...branchScope, ...(f.warehouseId && { warehouseId: f.warehouseId }) }, _sum: { total: true } }),
    prisma.purchase.aggregate({ where: { tenantId, status: 'RECEIVED', receivedAt: { gte: growthPrevFrom, lte: growthPrevTo }, ...branchScope, ...(f.warehouseId && { warehouseId: f.warehouseId }) }, _sum: { total: true } }),
    analytics.topSuppliers(tenantId, { from, to, branchId: f.branchId }),
    analytics.topDebtors(tenantId, { branchId: f.branchId }),
    analytics.salesByCategory(tenantId, { from, to, branchId: f.branchId }),
    analytics.salesByPaymentMethod(tenantId, { from, to, branchId: f.branchId }),
    analytics.overstockRisk(tenantId, { branchId: f.branchId }),
  ]);
  const prevSalesTotal = Number(prevSalesAgg._sum.total || 0);
  const prevPurchasesTotal = Number(prevPurchaseAgg._sum.total || 0);
  const salesGrowthPercent = prevSalesTotal > 0 ? ((rangeSalesTotal - prevSalesTotal) / prevSalesTotal) * 100 : null;
  const purchaseGrowthPercent = prevPurchasesTotal > 0 ? ((purchasesTotal - prevPurchasesTotal) / prevPurchasesTotal) * 100 : null;
  const averageInvoiceValue = sales.length > 0 ? rangeSalesTotal / sales.length : null;

  res.json({
    range: { from, to, preset: f.range },
    kpis: {
      sales: rangeSalesTotal,
      grossProfit,
      netProfit,
      purchases: purchasesTotal,
      expenses: totalExpenses,
      cash: cashIn - cashOut,
      bank: bankIn - bankOut,
      receivables,
      payables,
      inventoryValue,
      salesGrowthPercent,
      purchaseGrowthPercent,
      averageInvoiceValue,
    },
    topSuppliers: topSuppliersList,
    topDebtors: topDebtorsList,
    salesByCategory: salesByCategoryList,
    salesByPaymentMethod: salesByPaymentMethodList,
    overstock: { items: overstockList.slice(0, 20), count: overstockList.length },
    trends: { sales: salesTrend, profit: profitTrend },
    topProducts,
    mostProfitableProducts,
    stock: {
      lowStock: lowStockItems.slice(0, 20),
      lowStockCount: lowStockItems.length,
      slowMoving: slowMovingStock.slice(0, 20),
      slowMovingCount: slowMovingStock.length,
      deadStock: deadStock.slice(0, 20),
      deadStockCount: deadStock.length,
      expiringMedicines: expiringMedicines.slice(0, 20),
      expiringCount: expiringMedicines.length,
    },
    opticalJobs: {
      pending: pendingJobs.length,
      ready: readyJobs.length,
      delayed: delayedJobs.length,
    },
    customers: {
      new: newCustomersCount,
      returning: returningCustomersCount,
    },
    outstandingPayments: {
      receivablesTotal: receivables,
      payablesTotal: payables,
      topReceivables: openReceivableSales
        .map((s) => ({ id: s.id, name: s.customer?.name || 'Walk-in', amountDue: Math.max(Number(s.total) - Number(s.amountPaid), 0) }))
        .filter((x) => x.amountDue > 0)
        .sort((a, b) => b.amountDue - a.amountDue)
        .slice(0, 10),
      topPayables: openPayablePurchases
        .map((p) => ({ id: p.id, name: p.supplier?.name || 'Unknown', amountDue: Math.max(Number(p.total) - Number(p.amountPaid), 0) }))
        .filter((x) => x.amountDue > 0)
        .sort((a, b) => b.amountDue - a.amountDue)
        .slice(0, 10),
    },
    branchPerformance: [...byBranch.values()].sort((a, b) => b.total - a.total),
    staffPerformance: [...byStaff.values()].sort((a, b) => b.total - a.total),
    // Phase 5 - accounting/procurement intelligence. Additive: existing
    // consumers of this endpoint that don't know about these keys are
    // unaffected.
    accounting: {
      cashBalance,
      bankBalance,
      receivablesOverdue,
      payablesOverdue,
      // Phase 2.3: ledger-derived financials for the selected range/branch.
      ledger: ledgerKpis,
    },
    procurement: {
      pendingApprovals: pendingPurchaseRequestApprovals + pendingPurchaseOrderApprovals,
      pendingPurchaseOrders: pendingPOs.length,
      pendingGoodsReceipts: pendingPOs.length, // same underlying set: approved/partially-received POs still awaiting (further) receiving
      supplierPaymentCommitments: payables,
      purchasePriceChanges,
      pipeline: pendingPOs.map((po) => ({ id: po.id, poNumber: po.poNumber, supplierName: po.supplier?.name, total: Number(po.total), status: po.status })),
    },
    // Phase 6 - lets the owner switch between consolidated and location-level
    // views without leaving the dashboard: branchPerformance/branchId filter
    // above already provide the global-vs-single-branch toggle; this adds
    // warehouse comparison and the transfer pipeline specifically.
    locations: {
      warehouseComparison,
      pendingTransferApprovals,
      transferPipeline: transferPipelineRows.map((t) => ({
        id: t.id,
        transferNumber: t.transferNumber,
        sourceWarehouseName: t.sourceWarehouse.name,
        destinationWarehouseName: t.destinationWarehouse.name,
        status: t.status,
      })),
    },
    clinical: clinicalKpis,
    communication: communicationKpis,
    // Phase 9 - reads only the most recently generated AiInsight rows
    // (a plain, fast DB read) rather than running any live AI scan on every
    // dashboard load, so the Command Center stays responsive regardless of
    // AI provider availability. Insights themselves are (re)computed by
    // POST /api/ai/insights/refresh or the Daily Brief, not here.
    ai: await (async () => {
      const [config, insights] = await Promise.all([
        prisma.aiConfig.findUnique({ where: { tenantId } }),
        prisma.aiInsight.findMany({ where: { tenantId, status: 'NEW' }, orderBy: { createdAt: 'desc' }, take: 100 }),
      ]);
      const bySeverity = (sev) => insights.filter((i) => i.severity === sev).slice(0, 5);
      return {
        isEnabled: config?.isEnabled ?? true,
        topRisks: [...bySeverity('URGENT'), ...bySeverity('ATTENTION')].slice(0, 5),
        topOpportunities: bySeverity('OPPORTUNITY'),
        anomalyAlerts: insights.filter((i) => i.type === 'ANOMALY').slice(0, 5),
        inventoryRecommendations: insights.filter((i) => i.category === 'inventory').slice(0, 5),
        customerFollowUps: insights.filter((i) => i.category === 'receivables').slice(0, 5),
        totalNewInsights: insights.length,
      };
    })(),
  });
});

const PREFERENCES_KEY_PREFIX = 'commandCenterPrefs:';
const preferencesSchema = z.object({
  widgets: z.array(z.object({ id: z.string(), visible: z.boolean(), order: z.number().int() })),
});

// Saved widget layout - tenant AND user scoped (stored via the existing
// per-tenant Setting table, keyed per-user, so no schema migration is needed).
router.get('/preferences', requireRole(...MANAGEMENT), async (req, res) => {
  const setting = await prisma.setting.findUnique({
    where: { tenantId_key: { tenantId: req.user.tenantId, key: `${PREFERENCES_KEY_PREFIX}${req.user.id}` } },
  });
  res.json({ preferences: setting ? JSON.parse(setting.value) : null });
});

router.put('/preferences', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = preferencesSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid dashboard preferences', parsed.error.flatten());

  const key = `${PREFERENCES_KEY_PREFIX}${req.user.id}`;
  const setting = await prisma.setting.upsert({
    where: { tenantId_key: { tenantId: req.user.tenantId, key } },
    create: { tenantId: req.user.tenantId, key, value: JSON.stringify(parsed.data) },
    update: { value: JSON.stringify(parsed.data) },
  });
  res.json({ preferences: JSON.parse(setting.value) });
});

module.exports = router;
