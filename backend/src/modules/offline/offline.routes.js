// Phase 3.1 - server side of the offline data foundation.
//
// A terminal keeps a local copy of the data it needs to keep selling without a network.
// These two read-only endpoints are how that copy is filled and kept honest:
//
//   GET /api/offline/manifest              cheap: which datasets this user may cache, the exact
//                                          access scope they were computed for, and a
//                                          {count, maxUpdatedAt} version per dataset - enough to
//                                          tell "is my local copy stale?" without downloading it
//   GET /api/offline/datasets/:name        keyset-paged rows (no silent truncation), optional
//                                          updatedSince for deltas
//
// Everything is derived through the SAME permission and branch/company/warehouse scoping the
// normal list endpoints use - a terminal can never cache more than its user may read online.
// Nothing here writes; the outboxes (Phase 2 slices) stay the only way offline work is sent.
const express = require('express');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { hasPermission } = require('../../middleware/permissions');
const { getAccessibleBranchIds, getAccessibleWarehouseIds } = require('../../middleware/branchScope');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const { round2 } = require('../accounting/ledger');
const { PRODUCT_EXTENSIONS_INCLUDE } = require('../products/productService');

const router = express.Router();
router.use(authenticate, requireTenant);

// Bump when the SHAPE of a cached dataset changes incompatibly: terminals holding an older
// shape discard and re-download instead of running on data the UI no longer understands.
const SCHEMA_VERSION = 1;
const MAX_LIMIT = 1000;

// name -> { model, permission, scope(user, ctx) -> extra where, include?, activeFlag }
const DATASETS = {
  products: {
    model: 'product',
    permission: ['PRODUCT', 'VIEW'],
    include: () => ({ category: true, ...PRODUCT_EXTENSIONS_INCLUDE }),
  },
  customers: { model: 'customer', permission: ['CUSTOMER', 'VIEW'] },
  suppliers: { model: 'supplier', permission: ['SUPPLIER', 'VIEW'] },
  expenseCategories: { model: 'expenseCategory', permission: ['EXPENSE', 'VIEW'] },
  branches: {
    model: 'branch',
    permission: ['BRANCH', 'VIEW'],
    scope: (ctx) => (ctx.branchIds === null ? {} : { id: { in: ctx.branchIds } }),
  },
  warehouses: {
    model: 'warehouse',
    permission: ['WAREHOUSE', 'VIEW'],
    scope: (ctx) => (ctx.warehouseIds === null ? {} : { id: { in: ctx.warehouseIds } }),
  },
  // Per-location quantities. No isActive flag: rows are never deleted, quantities just change.
  warehouseStock: {
    model: 'warehouseStock',
    permission: ['WAREHOUSE', 'VIEW'],
    noTenantColumn: true,
    hasNoActiveFlag: true,
    scope: (ctx, tenantId) => ({
      warehouse: { tenantId },
      ...(ctx.warehouseIds === null ? {} : { warehouseId: { in: ctx.warehouseIds } }),
    }),
  },
};

// ---------------------------------------------------------------------------------------------
// Phase 3.3: datasets that let a terminal SELECT the documents an offline return / note / application
// / refund refers to. They are not row-per-record master data: each is a bounded, derived view
// (recent returnable sales, open invoices, notes with credit left), downloaded whole whenever its
// version changes (no deltas - a document leaving the set is simply absent from the next copy).
// Scoped exactly like the online lists: permission, then branch access.
// ---------------------------------------------------------------------------------------------
const RETURN_WINDOW_DAYS = 60;
const num = (v) => Number(v || 0);
const since = () => new Date(Date.now() - RETURN_WINDOW_DAYS * 86400000);
const inBranches = (ctx) => (ctx.branchIds === null ? {} : { branchId: { in: ctx.branchIds } });

// A "version" that moves whenever anything a terminal would copy can have changed.
async function versionOf(parts) {
  const counts = await Promise.all(parts.map((p) => p.count));
  const maxes = (await Promise.all(parts.map((p) => p.max))).filter(Boolean).map((d) => new Date(d).getTime());
  return { count: counts.reduce((a, b) => a + b, 0), maxUpdatedAt: maxes.length ? new Date(Math.max(...maxes)) : null };
}

// Rows are filtered AFTER the read (a column-to-column comparison Prisma cannot express), so a page can
// hold fewer than `limit` kept rows while more remain. Paging therefore follows the RAW window: whether
// more exist and where to continue come from what was read, not from what was kept.
function withPaging(raw, limit, items) {
  return Object.assign(items, { hasMore: raw.length > limit, lastRawId: raw[Math.min(limit, raw.length) - 1]?.id });
}

// Phase 3.4: read models for offline VIEWING - recent sales and purchases (every status, so a reversed one
// is shown as reversed). Bounded by a window and by the user's branch access, downloaded whole like the
// other derived views. Statements and summaries are computed on the terminal from these plus the open
// documents/notes lists; nothing here is a source of truth for accounting.
const HISTORY_WINDOW_DAYS = 90;
const historySince = () => new Date(Date.now() - HISTORY_WINDOW_DAYS * 86400000);

function history(model, partyModel, permResource, numberField, dateField) {
  const partyField = `${partyModel}Id`;
  return {
    permission: [permResource, 'VIEW'],
    version: (ctx, req) => {
      const w = { tenantId: req.user.tenantId, createdAt: { gte: historySince() }, ...inBranches(ctx) };
      return versionOf([{ count: prisma[model].count({ where: w }), max: prisma[model].aggregate({ where: w, _max: { updatedAt: true } }).then((a) => a._max.updatedAt) }]);
    },
    rows: async (ctx, req, { after, take }) => {
      const raw = await prisma[model].findMany({
        where: { tenantId: req.user.tenantId, createdAt: { gte: historySince() }, ...inBranches(ctx), ...(after ? { id: { gt: after } } : {}) },
        include: { [partyModel]: { select: { name: true } }, items: { select: { id: true } } },
        orderBy: { id: 'asc' },
        take,
      });
      const kept = raw.slice(0, take - 1);
      return withPaging(raw, take - 1, kept.map((d) => ({
        id: d.id,
        number: d[numberField],
        partyId: d[partyField],
        partyName: d[partyModel]?.name || null,
        branchId: d.branchId,
        date: d[dateField] || d.createdAt,
        status: d.status,
        paymentStatus: d.paymentStatus,
        paymentMethod: d.paymentMethod || null,
        total: num(d.total),
        amountPaid: num(d.amountPaid),
        itemCount: d.items.length,
        isActive: true,
      })));
    },
    cursorOf: (row) => row.id,
  };
}

const CUSTOM = {
  salesHistory: { ...history('sale', 'customer', 'SALE', 'invoiceNumber', 'createdAt') },
  purchasesHistory: { ...history('purchase', 'supplier', 'PURCHASE', 'purchaseNumber', 'receivedAt') },
  returnableSales: {
    permission: ['SALES_RETURN', 'VIEW'],
    version: (ctx, req) => {
      const w = { tenantId: req.user.tenantId, createdAt: { gte: since() }, ...inBranches(ctx) };
      return versionOf([
        { count: prisma.sale.count({ where: { ...w, status: 'COMPLETED' } }), max: prisma.sale.aggregate({ where: w, _max: { updatedAt: true } }).then((a) => a._max.updatedAt) },
        { count: prisma.salesReturn.count({ where: w }), max: prisma.salesReturn.aggregate({ where: w, _max: { updatedAt: true } }).then((a) => a._max.updatedAt) },
      ]);
    },
    rows: async (ctx, req, { after, take }) => {
      const raw = await prisma.sale.findMany({
        where: { tenantId: req.user.tenantId, status: 'COMPLETED', createdAt: { gte: since() }, ...inBranches(ctx), ...(after ? { id: { gt: after } } : {}) },
        include: { items: { include: { product: { select: { name: true } } } }, customer: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take,
      });
      const sales = raw.slice(0, take - 1);
      return withPaging(raw, take - 1, sales.map((sale) => ({
        id: sale.id,
        invoiceNumber: sale.invoiceNumber,
        customerId: sale.customerId,
        customerName: sale.customer?.name || null,
        branchId: sale.branchId,
        warehouseId: sale.warehouseId,
        createdAt: sale.createdAt,
        total: num(sale.total),
        items: sale.items.map((i) => ({ id: i.id, productId: i.productId, name: i.product?.name, quantity: num(i.quantity), returnedQuantity: num(i.returnedQuantity), unitPrice: num(i.unitPrice), discount: num(i.discount) })),
        isActive: true,
      })).filter((sale) => sale.items.some((i) => i.returnedQuantity < i.quantity - 0.0001)).map((sale) => ({ ...sale, _cursor: sale.id })));
    },
    cursorOf: (row) => row.id,
  },
  returnablePurchases: {
    permission: ['PURCHASE_RETURN', 'VIEW'],
    version: (ctx, req) => {
      const w = { tenantId: req.user.tenantId, createdAt: { gte: since() }, ...inBranches(ctx) };
      return versionOf([
        { count: prisma.purchase.count({ where: { ...w, status: 'RECEIVED' } }), max: prisma.purchase.aggregate({ where: w, _max: { updatedAt: true } }).then((a) => a._max.updatedAt) },
        { count: prisma.purchaseReturn.count({ where: w }), max: prisma.purchaseReturn.aggregate({ where: w, _max: { updatedAt: true } }).then((a) => a._max.updatedAt) },
      ]);
    },
    rows: async (ctx, req, { after, take }) => {
      const raw = await prisma.purchase.findMany({
        where: { tenantId: req.user.tenantId, status: 'RECEIVED', createdAt: { gte: since() }, ...inBranches(ctx), ...(after ? { id: { gt: after } } : {}) },
        include: { items: { include: { product: { select: { name: true } } } }, supplier: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take,
      });
      const purchases = raw.slice(0, take - 1);
      return withPaging(raw, take - 1, purchases.map((p) => ({
        id: p.id,
        purchaseNumber: p.purchaseNumber,
        supplierId: p.supplierId,
        supplierName: p.supplier?.name || null,
        branchId: p.branchId,
        warehouseId: p.warehouseId,
        createdAt: p.createdAt,
        total: num(p.total),
        items: p.items.map((i) => ({ id: i.id, productId: i.productId, name: i.product?.name, quantity: num(i.quantity), returnedQuantity: num(i.returnedQuantity), unitCost: num(i.unitCost) })),
        isActive: true,
      })).filter((p) => p.items.some((i) => i.returnedQuantity < i.quantity - 0.0001)));
    },
    cursorOf: (row) => row.id,
  },
  arDocuments: { ...openDocuments('sale', 'customer', 'CUSTOMER', 'invoiceNumber', ['COMPLETED']) },
  apDocuments: { ...openDocuments('purchase', 'supplier', 'SUPPLIER', 'purchaseNumber', ['RECEIVED']) },
  arNotes: { ...openNotes('creditNote', 'customer', 'CUSTOMER', 'creditNoteNumber', 'customerId') },
  apNotes: { ...openNotes('debitNote', 'supplier', 'SUPPLIER', 'debitNoteNumber', 'supplierId') },
};

// Open invoices/purchases: what a payment or a credit/debit note application can still settle.
function openDocuments(model, partyModel, permResource, numberField, statuses) {
  const partyField = `${partyModel}Id`;
  return {
    permission: [permResource, 'VIEW'],
    version: (ctx, req) => {
      const w = { tenantId: req.user.tenantId, status: { in: statuses }, ...inBranches(ctx) };
      return versionOf([{ count: prisma[model].count({ where: { ...w, paymentStatus: { not: 'PAID' } } }), max: prisma[model].aggregate({ where: w, _max: { updatedAt: true } }).then((a) => a._max.updatedAt) }]);
    },
    rows: async (ctx, req, { after, take }) => {
      const raw = await prisma[model].findMany({
        where: { tenantId: req.user.tenantId, status: { in: statuses }, paymentStatus: { not: 'PAID' }, ...inBranches(ctx), ...(after ? { id: { gt: after } } : {}) },
        include: { [partyModel]: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take,
      });
      const docs = raw.slice(0, take - 1);
      return withPaging(raw, take - 1, docs
        .map((d) => ({ id: d.id, number: d[numberField], partyId: d[partyField], partyName: d[partyModel]?.name || null, branchId: d.branchId, date: d.receivedAt || d.createdAt, total: num(d.total), amountPaid: num(d.amountPaid), balance: round2(num(d.total) - num(d.amountPaid)), isActive: true }))
        .filter((d) => d.balance > 0.005));
    },
    cursorOf: (row) => row.id,
  };
}

// Issued notes that still have credit left (amount - refunded - applied).
function openNotes(model, partyModel, permResource, numberField, partyField) {
  return {
    permission: [permResource, 'VIEW'],
    version: (ctx, req) => {
      const w = { tenantId: req.user.tenantId, ...inBranches(ctx) };
      return versionOf([{ count: prisma[model].count({ where: { ...w, status: 'ISSUED' } }), max: prisma[model].aggregate({ where: w, _max: { updatedAt: true } }).then((a) => a._max.updatedAt) }]);
    },
    rows: async (ctx, req, { after, take }) => {
      const raw = await prisma[model].findMany({
        where: { tenantId: req.user.tenantId, status: 'ISSUED', ...inBranches(ctx), ...(after ? { id: { gt: after } } : {}) },
        include: { [partyModel]: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take,
      });
      const notes = raw.slice(0, take - 1);
      return withPaging(raw, take - 1, notes
        .map((n) => ({ id: n.id, number: n[numberField], partyId: n[partyField], partyName: n[partyModel]?.name || null, branchId: n.branchId, date: n.createdAt, amount: num(n.amount), refundedAmount: num(n.refundedAmount), appliedAmount: num(n.appliedAmount), available: round2(num(n.amount) - num(n.refundedAmount) - num(n.appliedAmount)), reason: n.reason, isActive: true }))
        .filter((n) => n.available > 0.005));
    },
    cursorOf: (row) => row.id,
  };
}

async function buildContext(req) {
  const [branchIds, warehouseIds] = await Promise.all([getAccessibleBranchIds(prisma, req.user), getAccessibleWarehouseIds(prisma, req.user)]);
  return { branchIds, warehouseIds };
}

function whereFor(name, req, ctx, { delta, updatedSince }) {
  const def = DATASETS[name];
  const where = { ...(def.noTenantColumn ? {} : { tenantId: req.user.tenantId }), ...(def.scope ? def.scope(ctx, req.user.tenantId) : {}) };
  // A full download holds only live rows; a delta must also carry the rows that were deactivated
  // since, so the terminal can drop them.
  if (!def.hasNoActiveFlag && !delta) where.isActive = true;
  if (updatedSince) where.updatedAt = { gte: updatedSince };
  return where;
}

async function allowedDatasets(req) {
  const names = [];
  for (const [name, def] of Object.entries(DATASETS)) {
    if (await hasPermission(req.user.role, def.permission[0], def.permission[1])) names.push(name);
  }
  return names;
}

router.get('/manifest', async (req, res) => {
  const serverTime = new Date();
  const ctx = await buildContext(req);
  const names = await allowedDatasets(req);
  const datasets = {};
  for (const [name, def] of Object.entries(CUSTOM)) {
    if (await hasPermission(req.user.role, def.permission[0], def.permission[1])) datasets[name] = await def.version(ctx, req);
  }
  for (const name of names) {
    const def = DATASETS[name];
    const where = whereFor(name, req, ctx, { delta: false });
    const [count, agg] = await Promise.all([
      prisma[def.model].count({ where }),
      // maxUpdatedAt over ALL rows in scope (including inactive) so a deactivation also changes the version.
      prisma[def.model].aggregate({ where: whereFor(name, req, ctx, { delta: true }), _max: { updatedAt: true } }),
    ]);
    datasets[name] = { count, maxUpdatedAt: agg._max.updatedAt };
  }
  res.json({
    serverTime,
    schemaVersion: SCHEMA_VERSION,
    scope: { tenantId: req.user.tenantId, userId: req.user.id, role: req.user.role, branchIds: ctx.branchIds, warehouseIds: ctx.warehouseIds },
    datasets,
  });
});

router.get('/datasets/:name', async (req, res) => {
  const name = req.params.name;
  const custom = CUSTOM[name];
  if (custom) {
    if (!(await hasPermission(req.user.role, custom.permission[0], custom.permission[1]))) throw new ForbiddenError(`You do not have permission to cache ${name}`);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), MAX_LIMIT);
    const serverTime = new Date();
    const ctx = await buildContext(req);
    const rows = await custom.rows(ctx, req, { after: req.query.after ? String(req.query.after) : undefined, take: limit + 1 });
    return res.json({ dataset: name, items: [...rows].map(({ _cursor, ...r }) => r), nextCursor: rows.hasMore ? rows.lastRawId : null, serverTime, delta: false });
  }
  const def = DATASETS[name];
  if (!def) throw new NotFoundError('Unknown dataset');
  if (!(await hasPermission(req.user.role, def.permission[0], def.permission[1]))) {
    throw new ForbiddenError(`You do not have permission to cache ${name}`);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), MAX_LIMIT);
  let updatedSince;
  if (req.query.updatedSince) {
    updatedSince = new Date(req.query.updatedSince);
    if (Number.isNaN(updatedSince.getTime())) throw new ValidationError('updatedSince is not a valid date');
  }
  // Captured BEFORE reading so anything committed while we read is picked up by the next delta.
  const serverTime = new Date();
  const ctx = await buildContext(req);
  const where = whereFor(name, req, ctx, { delta: Boolean(updatedSince), updatedSince });
  if (req.query.after) where.id = { ...(where.id || {}), gt: String(req.query.after) };

  const rows = await prisma[def.model].findMany({
    where,
    ...(def.include ? { include: def.include() } : {}),
    orderBy: { id: 'asc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  res.json({ dataset: name, items, nextCursor: hasMore ? items[items.length - 1].id : null, serverTime, delta: Boolean(updatedSince) });
});

module.exports = router;
