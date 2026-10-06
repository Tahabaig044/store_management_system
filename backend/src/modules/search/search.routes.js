// Phase 1.16: Universal Search - a NEW, additive central endpoint. No
// existing per-module list endpoint or its own `?search=` filter is
// touched, removed, or duplicated by this module; this is purely a new,
// separate aggregation point that queries the SAME tables those endpoints
// already use, with the SAME tenant/branch/warehouse scoping helpers and
// the SAME centralized Phase 0.4 permission catalog - never a second
// permission system, never a raw/unparameterized query, never an external
// search engine (Elasticsearch/Meilisearch). See this phase's verification
// report for the full architecture audit and design rationale.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { hasPermission } = require('../../middleware/permissions');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { parsePagination } = require('../../utils/pagination');
const { ValidationError } = require('../../utils/errors');

const router = express.Router();
router.use(authenticate, requireTenant);

// ---------------------------------------------------------------------------
// Normalization (Section 14) - safe, meaning-preserving only: trims outer
// whitespace and collapses internal runs of whitespace to one space. Case
// sensitivity is handled per-query by Prisma's `mode: 'insensitive'`, not
// here. No digit-only phone reformatting or other lossy transform is
// applied - see this phase's report, Known Limitations, for why.
function normalizeQuery(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

// Builds a nested Prisma `contains` filter from a dot path, e.g.
// "customer.name" -> { customer: { name: { contains, mode: 'insensitive' } } }.
// Generic so every entity below can reach into its own relations uniformly.
function nestedContains(path, q) {
  const [first, ...rest] = path.split('.');
  if (rest.length === 0) return { [first]: { contains: q, mode: 'insensitive' } };
  return { [first]: nestedContains(rest.join('.'), q) };
}

function orFilter(paths, q) {
  return { OR: paths.map((p) => nestedContains(p, q)) };
}

// Reads a dot path off a plain object (post-query, for ranking/display -
// not a Prisma filter).
function pluck(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Deterministic relevance (Section 8) - no AI/semantic scoring. Rank 0 =
// exact match, 1 = prefix, 2 = contains, 9 = no match on this field at all
// (shouldn't happen since rows were already filtered by `contains`, but
// kept as a safe fallback). The lowest rank across a row's designated
// match fields wins.
function fieldRank(value, q) {
  if (value == null) return 9;
  const v = String(value).toLowerCase();
  if (v === q) return 0;
  if (v.startsWith(q)) return 1;
  if (v.includes(q)) return 2;
  return 9;
}

function bestRank(row, matchPaths, q) {
  return Math.min(...matchPaths.map((p) => fieldRank(pluck(row, p), q)));
}

// Multi-entity mode fans out across ~19 permitted entity types per request -
// firing all of them via a single Promise.all was found, during this
// phase's own manual verification, to transiently exceed the Prisma
// client's connection pool under a cold start (a real, reproduced failure,
// not a hypothetical one - see this phase's report, Database/Performance).
// Running them in small batches keeps peak simultaneous connection demand
// bounded while still being far faster than fully sequential.
const SEARCH_FAN_OUT_BATCH_SIZE = 6;
async function mapWithBoundedConcurrency(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Entity registry. Each entry:
//   resource/action - the exact Phase 0.4 permission catalog resource/action
//     checked via hasPermission(role, resource, action) BEFORE this entity
//     type is queried at all. If the role lacks it, the entity is skipped
//     entirely - it never appears in results, and its table is never
//     queried (no wasted work, no partial-permission leakage).
//   matchPaths - dot paths (relative to the query's own `include`) used
//     both as the search OR-filter and as the relevance ranking input.
//   dateField - which column `from`/`to` filters against, if provided.
//   branchAware - whether to merge in branch scope (own branchId column).
//   buildWhere(tenantId) - extra static where fragment beyond tenantId.
//   query(prisma, where, take) - runs the actual bounded findMany.
//   toResult(row) - maps one row to the unified response shape (Section 5).
// ---------------------------------------------------------------------------
const ENTITIES = {
  PRODUCT: {
    resource: 'PRODUCT', action: 'VIEW', branchAware: false, dateField: 'createdAt',
    matchPaths: ['name', 'sku', 'barcode', 'brand'],
    query: (where, take) => prisma.product.findMany({ where, take, select: { id: true, name: true, sku: true, barcode: true, brand: true, isActive: true, stockQuantity: true, createdAt: true } }),
    toResult: (p) => ({ entityType: 'PRODUCT', entityId: p.id, title: p.name, reference: p.sku || null, subtitle: p.barcode || p.brand || null, status: p.isActive ? 'ACTIVE' : 'INACTIVE', metadata: { stockQuantity: Number(p.stockQuantity) }, route: '/products' }),
  },
  PRODUCT_VARIANT: {
    resource: 'PRODUCT', action: 'VIEW', branchAware: false, dateField: 'createdAt',
    matchPaths: ['name', 'sku', 'barcode', 'product.name'],
    query: (where, take) => prisma.productVariant.findMany({ where, take, select: { id: true, name: true, sku: true, barcode: true, isActive: true, product: { select: { name: true } } } }),
    toResult: (v) => ({ entityType: 'PRODUCT_VARIANT', entityId: v.id, title: `${v.product?.name || ''} - ${v.name}`, reference: v.sku || null, subtitle: v.barcode || null, status: v.isActive ? 'ACTIVE' : 'INACTIVE', metadata: {}, route: '/products' }),
  },
  CUSTOMER: {
    resource: 'CUSTOMER', action: 'VIEW', branchAware: false, dateField: 'createdAt',
    matchPaths: ['name', 'code', 'phone', 'email'],
    query: (where, take) => prisma.customer.findMany({ where, take, select: { id: true, name: true, code: true, phone: true, email: true, isActive: true } }),
    toResult: (c) => ({ entityType: 'CUSTOMER', entityId: c.id, title: c.name, reference: c.code || null, subtitle: c.phone || c.email || null, status: c.isActive ? 'ACTIVE' : 'INACTIVE', metadata: {}, route: '/customers' }),
  },
  SUPPLIER: {
    resource: 'SUPPLIER', action: 'VIEW', branchAware: false, dateField: 'createdAt',
    matchPaths: ['name', 'code', 'phone', 'email'],
    query: (where, take) => prisma.supplier.findMany({ where, take, select: { id: true, name: true, code: true, phone: true, email: true, isActive: true } }),
    toResult: (s) => ({ entityType: 'SUPPLIER', entityId: s.id, title: s.name, reference: s.code || null, subtitle: s.phone || s.email || null, status: s.isActive ? 'ACTIVE' : 'INACTIVE', metadata: {}, route: '/suppliers' }),
  },
  SALE: {
    resource: 'SALE', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['invoiceNumber', 'customer.name'],
    query: (where, take) => prisma.sale.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, invoiceNumber: true, total: true, status: true, paymentStatus: true, customer: { select: { name: true } } } }),
    toResult: (s) => ({ entityType: 'SALE', entityId: s.id, title: `Invoice ${s.invoiceNumber}`, reference: s.invoiceNumber, subtitle: s.customer?.name || 'Walk-in', status: s.status, metadata: { total: Number(s.total), paymentStatus: s.paymentStatus }, route: '/sales-history' }),
  },
  PURCHASE: {
    resource: 'PURCHASE', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['purchaseNumber', 'supplier.name'],
    query: (where, take) => prisma.purchase.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, purchaseNumber: true, total: true, status: true, paymentStatus: true, supplier: { select: { name: true } } } }),
    toResult: (p) => ({ entityType: 'PURCHASE', entityId: p.id, title: `Purchase ${p.purchaseNumber}`, reference: p.purchaseNumber, subtitle: p.supplier?.name || null, status: p.status, metadata: { total: Number(p.total), paymentStatus: p.paymentStatus }, route: '/purchases' }),
  },
  PAYMENT: {
    resource: 'PAYMENT', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['receiptNumber', 'customer.name', 'supplier.name'],
    query: (where, take) => prisma.payment.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, receiptNumber: true, amount: true, direction: true, status: true, customer: { select: { name: true } }, supplier: { select: { name: true } } } }),
    toResult: (p) => ({ entityType: 'PAYMENT', entityId: p.id, title: `Payment ${p.receiptNumber || p.id.slice(0, 8)}`, reference: p.receiptNumber || null, subtitle: p.customer?.name || p.supplier?.name || null, status: p.status, metadata: { amount: Number(p.amount), direction: p.direction }, route: '/customers' }),
  },
  EXPENSE: {
    resource: 'EXPENSE', action: 'VIEW', branchAware: true, dateField: 'expenseDate',
    matchPaths: ['expenseNumber', 'description', 'category.name', 'supplier.name', 'payee.name'],
    query: (where, take) => prisma.expense.findMany({ where, take, orderBy: { expenseDate: 'desc' }, select: { id: true, expenseNumber: true, description: true, amount: true, status: true, category: { select: { name: true } }, supplier: { select: { name: true } }, payee: { select: { name: true } } } }),
    toResult: (e) => ({ entityType: 'EXPENSE', entityId: e.id, title: e.expenseNumber || e.description || 'Expense', reference: e.expenseNumber || null, subtitle: e.category?.name || null, status: e.status, metadata: { amount: Number(e.amount) }, route: '/expenses' }),
  },
  SALES_RETURN: {
    resource: 'SALES_RETURN', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['returnNumber', 'customer.name'],
    query: (where, take) => prisma.salesReturn.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, returnNumber: true, total: true, status: true, customer: { select: { name: true } } } }),
    toResult: (r) => ({ entityType: 'SALES_RETURN', entityId: r.id, title: `Sales Return ${r.returnNumber}`, reference: r.returnNumber, subtitle: r.customer?.name || null, status: r.status, metadata: { total: Number(r.total) }, route: '/sales-history' }),
  },
  PURCHASE_RETURN: {
    resource: 'PURCHASE_RETURN', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['returnNumber', 'supplier.name'],
    query: (where, take) => prisma.purchaseReturn.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, returnNumber: true, total: true, status: true, supplier: { select: { name: true } } } }),
    toResult: (r) => ({ entityType: 'PURCHASE_RETURN', entityId: r.id, title: `Purchase Return ${r.returnNumber}`, reference: r.returnNumber, subtitle: r.supplier?.name || null, status: r.status, metadata: { total: Number(r.total) }, route: '/purchases' }),
  },
  CREDIT_NOTE: {
    resource: 'CREDIT_NOTE', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['creditNoteNumber', 'customer.name'],
    query: (where, take) => prisma.creditNote.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, creditNoteNumber: true, amount: true, status: true, customer: { select: { name: true } } } }),
    toResult: (n) => ({ entityType: 'CREDIT_NOTE', entityId: n.id, title: `Credit Note ${n.creditNoteNumber}`, reference: n.creditNoteNumber, subtitle: n.customer?.name || null, status: n.status, metadata: { amount: Number(n.amount) }, route: '/credit-notes' }),
  },
  DEBIT_NOTE: {
    resource: 'DEBIT_NOTE', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['debitNoteNumber', 'supplier.name'],
    query: (where, take) => prisma.debitNote.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, debitNoteNumber: true, amount: true, status: true, supplier: { select: { name: true } } } }),
    toResult: (n) => ({ entityType: 'DEBIT_NOTE', entityId: n.id, title: `Debit Note ${n.debitNoteNumber}`, reference: n.debitNoteNumber, subtitle: n.supplier?.name || null, status: n.status, metadata: { amount: Number(n.amount) }, route: '/debit-notes' }),
  },
  QUOTATION: {
    resource: 'QUOTATION', action: 'VIEW', branchAware: true, dateField: 'quotationDate',
    matchPaths: ['quotationNumber', 'customer.name'],
    query: (where, take) => prisma.quotation.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, quotationNumber: true, total: true, status: true, customer: { select: { name: true } } } }),
    toResult: (q) => ({ entityType: 'QUOTATION', entityId: q.id, title: `Quotation ${q.quotationNumber}`, reference: q.quotationNumber, subtitle: q.customer?.name || null, status: q.status, metadata: { total: Number(q.total) }, route: '/quotations' }),
  },
  SALES_ORDER: {
    resource: 'SALES_ORDER', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['orderNumber', 'customer.name'],
    query: (where, take) => prisma.salesOrder.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, orderNumber: true, total: true, status: true, customer: { select: { name: true } } } }),
    toResult: (o) => ({ entityType: 'SALES_ORDER', entityId: o.id, title: `Sales Order ${o.orderNumber}`, reference: o.orderNumber, subtitle: o.customer?.name || null, status: o.status, metadata: { total: Number(o.total) }, route: '/sales-orders' }),
  },
  PURCHASE_REQUEST: {
    resource: 'PURCHASE_REQUEST', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['requestNumber'],
    query: (where, take) => prisma.purchaseRequest.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, requestNumber: true, status: true } }),
    toResult: (r) => ({ entityType: 'PURCHASE_REQUEST', entityId: r.id, title: `Purchase Request ${r.requestNumber}`, reference: r.requestNumber, subtitle: null, status: r.status, metadata: {}, route: '/procurement' }),
  },
  RFQ: {
    resource: 'RFQ', action: 'VIEW', branchAware: false, dateField: 'createdAt',
    matchPaths: ['rfqNumber'],
    query: (where, take) => prisma.rFQ.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, rfqNumber: true, status: true } }),
    // No dedicated RFQ frontend screen exists (a disclosed, pre-existing
    // Phase 1.9 gap, unchanged) - route is left null so the frontend can
    // show the result without a broken/misleading link (Section 11).
    toResult: (r) => ({ entityType: 'RFQ', entityId: r.id, title: `RFQ ${r.rfqNumber}`, reference: r.rfqNumber, subtitle: null, status: r.status, metadata: {}, route: null }),
  },
  PURCHASE_ORDER: {
    resource: 'PURCHASE_ORDER', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['poNumber', 'supplier.name'],
    query: (where, take) => prisma.purchaseOrder.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, poNumber: true, total: true, status: true, supplier: { select: { name: true } } } }),
    toResult: (o) => ({ entityType: 'PURCHASE_ORDER', entityId: o.id, title: `PO ${o.poNumber}`, reference: o.poNumber, subtitle: o.supplier?.name || null, status: o.status, metadata: { total: Number(o.total) }, route: '/procurement' }),
  },
  GOODS_RECEIPT: {
    resource: 'GOODS_RECEIPT', action: 'VIEW', branchAware: false, dateField: 'createdAt',
    matchPaths: ['grnNumber'],
    query: (where, take) => prisma.goodsReceipt.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, grnNumber: true } }),
    toResult: (g) => ({ entityType: 'GOODS_RECEIPT', entityId: g.id, title: `GRN ${g.grnNumber}`, reference: g.grnNumber, subtitle: null, status: null, metadata: {}, route: '/procurement' }),
  },
  USER: {
    resource: 'USER', action: 'VIEW', branchAware: false, dateField: 'createdAt',
    matchPaths: ['name', 'email'],
    query: (where, take) => prisma.user.findMany({ where, take, select: { id: true, name: true, email: true, role: true, isActive: true } }),
    toResult: (u) => ({ entityType: 'USER', entityId: u.id, title: u.name, reference: u.email, subtitle: u.role, status: u.isActive ? 'ACTIVE' : 'INACTIVE', metadata: {}, route: '/users' }),
  },
  ACTIVITY_LOG: {
    resource: 'AUDIT_LOG', action: 'VIEW', branchAware: true, dateField: 'createdAt',
    matchPaths: ['action', 'entity', 'entityId'],
    query: (where, take) => prisma.auditLog.findMany({ where, take, orderBy: { createdAt: 'desc' }, select: { id: true, action: true, entity: true, entityId: true, createdAt: true, user: { select: { name: true } } } }),
    toResult: (a) => ({ entityType: 'ACTIVITY_LOG', entityId: a.id, title: a.action, reference: a.entityId || null, subtitle: a.entity ? `${a.entity}${a.user?.name ? ' - ' + a.user.name : ''}` : a.user?.name || null, status: null, metadata: {}, route: '/activity-log' }),
  },
};

// Notification is deliberately NOT in the permission-checked registry above:
// it has no resource in the permission catalog at all (self-scoped by
// design, Phase 1.15) - every authenticated user may search their OWN
// notifications, never another user's, regardless of role. Handled as its
// own special case in the handler below rather than forcing a fake
// permission entry into the catalog for a resource that was deliberately
// designed not to need one.
async function searchNotifications(req, q, take) {
  const rows = await prisma.notification.findMany({
    where: { tenantId: req.user.tenantId, userId: req.user.id, OR: [{ title: { contains: q, mode: 'insensitive' } }, { body: { contains: q, mode: 'insensitive' } }] },
    take,
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, body: true, type: true, isRead: true, createdAt: true },
  });
  return rows
    .map((n) => ({ row: n, rank: Math.min(fieldRank(n.title, q), fieldRank(n.body, q)) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ row: n }) => ({ entityType: 'NOTIFICATION', entityId: n.id, title: n.title, reference: null, subtitle: n.body || null, status: n.isRead ? 'READ' : 'UNREAD', metadata: { type: n.type }, route: '/notifications' }));
}

const MULTI_ENTITY_PER_TYPE_LIMIT = 5;
const MULTI_ENTITY_CANDIDATE_LIMIT = 15;
const MULTI_ENTITY_GLOBAL_CAP = 100;

const querySchema = z.object({
  q: z.string().max(200),
  entity: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
  branchId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

router.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid search request', parsed.error.flatten());

  const q = normalizeQuery(parsed.data.q);
  if (!q) throw new ValidationError('Search query must not be empty');

  const requestedEntity = parsed.data.entity ? parsed.data.entity.toUpperCase() : null;
  if (requestedEntity && requestedEntity !== 'NOTIFICATION' && !ENTITIES[requestedEntity]) {
    throw new ValidationError(`Unknown entity type: ${requestedEntity}`);
  }

  const { branchId, warehouseId, from, to } = parsed.data;
  if (branchId) await assertBranchAccess(prisma, req.user, branchId);
  if (warehouseId) await assertWarehouseAccess(prisma, req.user, warehouseId);
  const branchScope = await branchScopeWhere(prisma, req.user);
  const dateRangeFor = (field) => {
    if (!from && !to) return {};
    const range = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { [field]: range };
  };

  // Single-entity, fully paginated mode.
  if (requestedEntity) {
    const { page, pageSize, skip, take } = parsePagination(req.query);

    if (requestedEntity === 'NOTIFICATION') {
      const rows = await searchNotifications(req, q, take + skip);
      const page_ = rows.slice(skip, skip + take);
      return res.json({ items: page_, total: rows.length, page, pageSize: take, entity: 'NOTIFICATION' });
    }

    const def = ENTITIES[requestedEntity];
    const allowed = await hasPermission(req.user.role, def.resource, def.action);
    if (!allowed) return res.json({ items: [], total: 0, page, pageSize: take, entity: requestedEntity });

    const where = {
      tenantId: req.user.tenantId,
      ...orFilter(def.matchPaths, q),
      ...(def.branchAware ? (branchId ? { branchId } : branchScope) : {}),
      ...dateRangeFor(def.dateField),
    };
    // Single-entity mode uses a real skip/take window (rawFind), not
    // def.query()'s flat `take`-only shape (which is only used by the
    // bounded, unpaginated multi-entity mode below) - see Section 9/12 of
    // this phase's report for why relevance ranking is intentionally NOT
    // re-applied on top of this paginated ordering.
    const [items, total] = await Promise.all([
      rawFind(requestedEntity, where, skip, take),
      prisma[modelNameFor(requestedEntity)].count({ where }),
    ]);
    return res.json({ items: items.map(def.toResult), total, page, pageSize: take, entity: requestedEntity });
  }

  // Multi-entity "quick search" mode: bounded, ranked, grouped.
  const entityKeys = Object.keys(ENTITIES);
  const permissionChecks = await Promise.all(entityKeys.map((k) => hasPermission(req.user.role, ENTITIES[k].resource, ENTITIES[k].action)));
  const permittedKeys = entityKeys.filter((_, i) => permissionChecks[i]);

  const resultsByEntity = await mapWithBoundedConcurrency(
    permittedKeys,
    SEARCH_FAN_OUT_BATCH_SIZE,
    async (key) => {
      const def = ENTITIES[key];
      const where = {
        tenantId: req.user.tenantId,
        ...orFilter(def.matchPaths, q),
        ...(def.branchAware ? (branchId ? { branchId } : branchScope) : {}),
        ...dateRangeFor(def.dateField),
      };
      const rows = await def.query(where, MULTI_ENTITY_CANDIDATE_LIMIT);
      const ranked = rows
        .map((row) => ({ row, rank: bestRank(row, def.matchPaths, q.toLowerCase()) }))
        .sort((a, b) => a.rank - b.rank)
        .slice(0, MULTI_ENTITY_PER_TYPE_LIMIT)
        .map(({ row }) => def.toResult(row));
      return { entity: key, count: ranked.length, items: ranked };
    }
  );

  // Notifications are always self-searchable regardless of the permission
  // catalog (Section 6 - no resource exists for them, by design).
  const notificationItems = await searchNotifications(req, q, MULTI_ENTITY_CANDIDATE_LIMIT);
  if (!requestedEntity) {
    resultsByEntity.push({ entity: 'NOTIFICATION', count: Math.min(notificationItems.length, MULTI_ENTITY_PER_TYPE_LIMIT), items: notificationItems.slice(0, MULTI_ENTITY_PER_TYPE_LIMIT) });
  }

  const nonEmpty = resultsByEntity.filter((g) => g.items.length > 0);
  const totalReturned = nonEmpty.reduce((s, g) => s + g.items.length, 0);
  // Global cap (Section 9/12): if every permitted entity type happened to
  // match, trim the lowest-priority (alphabetically-last, arbitrary but
  // deterministic) groups rather than truncate silently mid-group.
  let capped = nonEmpty;
  if (totalReturned > MULTI_ENTITY_GLOBAL_CAP) {
    let budget = MULTI_ENTITY_GLOBAL_CAP;
    capped = [];
    for (const g of nonEmpty) {
      if (budget <= 0) break;
      const take = Math.min(g.items.length, budget);
      capped.push({ ...g, items: g.items.slice(0, take), count: take });
      budget -= take;
    }
  }

  res.json({ query: q, groups: capped, totalGroups: capped.length, totalResults: capped.reduce((s, g) => s + g.items.length, 0) });
});

// Maps an ENTITIES registry key to its Prisma delegate name, for the
// count()/paginated-refetch calls in single-entity mode.
const MODEL_BY_ENTITY = {
  PRODUCT: 'product',
  PRODUCT_VARIANT: 'productVariant',
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier',
  SALE: 'sale',
  PURCHASE: 'purchase',
  PAYMENT: 'payment',
  EXPENSE: 'expense',
  SALES_RETURN: 'salesReturn',
  PURCHASE_RETURN: 'purchaseReturn',
  CREDIT_NOTE: 'creditNote',
  DEBIT_NOTE: 'debitNote',
  QUOTATION: 'quotation',
  SALES_ORDER: 'salesOrder',
  PURCHASE_REQUEST: 'purchaseRequest',
  RFQ: 'rFQ',
  PURCHASE_ORDER: 'purchaseOrder',
  GOODS_RECEIPT: 'goodsReceipt',
  USER: 'user',
  ACTIVITY_LOG: 'auditLog',
};
function modelNameFor(entityKey) {
  return MODEL_BY_ENTITY[entityKey];
}

// The same `select`/`orderBy`/relation shape as each entity's own query(),
// but with real skip/take for single-entity pagination (query() above is
// only ever called with a flat `take` for the bounded multi-entity mode).
const SELECT_BY_ENTITY = {
  PRODUCT: { id: true, name: true, sku: true, barcode: true, brand: true, isActive: true, stockQuantity: true, createdAt: true },
  PRODUCT_VARIANT: { id: true, name: true, sku: true, barcode: true, isActive: true, product: { select: { name: true } } },
  CUSTOMER: { id: true, name: true, code: true, phone: true, email: true, isActive: true },
  SUPPLIER: { id: true, name: true, code: true, phone: true, email: true, isActive: true },
  SALE: { id: true, invoiceNumber: true, total: true, status: true, paymentStatus: true, customer: { select: { name: true } } },
  PURCHASE: { id: true, purchaseNumber: true, total: true, status: true, paymentStatus: true, supplier: { select: { name: true } } },
  PAYMENT: { id: true, receiptNumber: true, amount: true, direction: true, status: true, customer: { select: { name: true } }, supplier: { select: { name: true } } },
  EXPENSE: { id: true, expenseNumber: true, description: true, amount: true, status: true, category: { select: { name: true } }, supplier: { select: { name: true } }, payee: { select: { name: true } } },
  SALES_RETURN: { id: true, returnNumber: true, total: true, status: true, customer: { select: { name: true } } },
  PURCHASE_RETURN: { id: true, returnNumber: true, total: true, status: true, supplier: { select: { name: true } } },
  CREDIT_NOTE: { id: true, creditNoteNumber: true, amount: true, status: true, customer: { select: { name: true } } },
  DEBIT_NOTE: { id: true, debitNoteNumber: true, amount: true, status: true, supplier: { select: { name: true } } },
  QUOTATION: { id: true, quotationNumber: true, total: true, status: true, customer: { select: { name: true } } },
  SALES_ORDER: { id: true, orderNumber: true, total: true, status: true, customer: { select: { name: true } } },
  PURCHASE_REQUEST: { id: true, requestNumber: true, status: true },
  RFQ: { id: true, rfqNumber: true, status: true },
  PURCHASE_ORDER: { id: true, poNumber: true, total: true, status: true, supplier: { select: { name: true } } },
  GOODS_RECEIPT: { id: true, grnNumber: true },
  USER: { id: true, name: true, email: true, role: true, isActive: true },
  ACTIVITY_LOG: { id: true, action: true, entity: true, entityId: true, createdAt: true, user: { select: { name: true } } },
};
const ORDER_BY_ENTITY = {
  PRODUCT: { createdAt: 'desc' },
  PRODUCT_VARIANT: undefined,
  CUSTOMER: undefined,
  SUPPLIER: undefined,
  SALE: { createdAt: 'desc' },
  PURCHASE: { createdAt: 'desc' },
  PAYMENT: { createdAt: 'desc' },
  EXPENSE: { expenseDate: 'desc' },
  SALES_RETURN: { createdAt: 'desc' },
  PURCHASE_RETURN: { createdAt: 'desc' },
  CREDIT_NOTE: { createdAt: 'desc' },
  DEBIT_NOTE: { createdAt: 'desc' },
  QUOTATION: { createdAt: 'desc' },
  SALES_ORDER: { createdAt: 'desc' },
  PURCHASE_REQUEST: { createdAt: 'desc' },
  RFQ: { createdAt: 'desc' },
  PURCHASE_ORDER: { createdAt: 'desc' },
  GOODS_RECEIPT: { createdAt: 'desc' },
  USER: undefined,
  ACTIVITY_LOG: { createdAt: 'desc' },
};

async function rawFind(entityKey, where, skip, take) {
  const model = MODEL_BY_ENTITY[entityKey];
  const select = SELECT_BY_ENTITY[entityKey];
  const orderBy = ORDER_BY_ENTITY[entityKey];
  return prisma[model].findMany({ where, select, orderBy, skip, take });
}

module.exports = router;
