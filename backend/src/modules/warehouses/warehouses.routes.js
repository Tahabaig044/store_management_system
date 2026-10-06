// Warehouse/store management + location-aware stock visibility. A tenant
// that never visits this module keeps working exactly as before Phase 6 -
// Product.stockQuantity is untouched, and no warehouse is created until
// something (this module, or a stock transfer) actually needs one.
//
// Phase 0.4: this module is one of the demonstration points for the new
// centralized, permission-based authorization layer - router-level
// requireRole(...INVENTORY_STAFF) is replaced by per-route
// requirePermission('WAREHOUSE', action) calls, seeded to be behaviorally
// identical to the role groups this module used before (see
// src/constants/permissionCatalog.js). Branch-level access checks are
// upgraded to warehouse-level checks (getAccessibleWarehouseIds), the new
// third scope tier - see docs/phase0-4-authorization-architecture.md.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { resolveEventTime } = require('../../utils/eventTime');
const { postInventoryAdjustment } = require('../accounting/inventoryPosting');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT, TENANT_ADMIN_ONLY } = require('../../constants/roles');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { ensureDefaultWarehouse, ensureWarehouseStock, adjustWarehouseStock } = require('./warehouseStock');
const { warehouseScopeWhere, assertWarehouseAccess, assertBranchAccess } = require('../../middleware/branchScope');
const { requirePermission } = require('../../middleware/permissions');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('WAREHOUSE', 'VIEW'), async (req, res) => {
  const items = await prisma.warehouse.findMany({
    where: {
      tenantId: req.user.tenantId,
      ...(req.query.includeInactive === 'true' ? {} : { isActive: true }),
      ...(await warehouseScopeWhere(prisma, req.user)),
    },
    include: { branch: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ items });
});

const createSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  branchId: z.string().uuid().optional(),
  isCentral: z.boolean().default(false),
  isDefault: z.boolean().optional(),
});

// Phase 1.3: isDefault is enforced as at-most-one-per-tenant here, in
// application code - the same way Company.isDefault (Phase 1.1) and
// Branch.isMain are already enforced without a DB-level constraint.
async function setWarehouseAsDefault(tenantId, warehouseId) {
  await prisma.$transaction([
    prisma.warehouse.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } }),
    prisma.warehouse.update({ where: { id: warehouseId }, data: { isDefault: true } }),
  ]);
}

router.post('/', requirePermission('WAREHOUSE', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid warehouse data', parsed.error.flatten());

  // Phase 1.3: companyId is a derived convenience field (schema.prisma's
  // comment on Warehouse) - populated from the branch's own company so an
  // offline terminal (Phase 1.10) can always resolve which company/branch/
  // warehouse its local inventory belongs to. Left null for a central/
  // company-wide warehouse with no specific branch, matching the existing
  // isCentral design.
  let companyId = null;
  if (parsed.data.branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: parsed.data.branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
    await assertBranchAccess(prisma, req.user, parsed.data.branchId);
    companyId = branch.companyId;
  }

  const { isDefault, ...rest } = parsed.data;
  const item = await prisma.warehouse.create({ data: { ...rest, companyId, isDefault: false, tenantId: req.user.tenantId } });
  await logAudit({ req, action: 'WAREHOUSE_CREATE', entity: 'Warehouse', entityId: item.id });

  if (isDefault) {
    await setWarehouseAsDefault(req.user.tenantId, item.id);
    return res.status(201).json({ item: await prisma.warehouse.findUnique({ where: { id: item.id } }) });
  }
  res.status(201).json({ item });
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

router.patch('/:id', requirePermission('WAREHOUSE', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid warehouse data', parsed.error.flatten());

  const existing = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertWarehouseAccess(prisma, req.user, existing.id);

  const { isDefault, ...rest } = parsed.data;
  if (isDefault === true && !existing.isDefault) {
    await setWarehouseAsDefault(req.user.tenantId, existing.id);
  }
  const item = await prisma.warehouse.update({ where: { id: existing.id }, data: rest });
  res.json({ item: isDefault === true ? await prisma.warehouse.findUnique({ where: { id: item.id } }) : item });
});

// Stock on hand at this warehouse - lazily backfills any product that has
// never been assigned to a location yet (see ensureWarehouseStock).
router.get('/:id/stock', requirePermission('WAREHOUSE', 'VIEW'), async (req, res) => {
  const warehouse = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!warehouse) throw new NotFoundError();
  await assertWarehouseAccess(prisma, req.user, warehouse.id);

  const products = await prisma.product.findMany({ where: { tenantId: req.user.tenantId, isActive: true } });
  await runFinancialTransaction(prisma, async (tx) => {
    for (const p of products) await ensureWarehouseStock(tx, req.user.tenantId, warehouse.id, p.id);
  });

  const rows = await prisma.warehouseStock.findMany({
    where: { warehouseId: warehouse.id },
    include: { product: { select: { name: true, sku: true, purchasePrice: true, lowStockThreshold: true } } },
  });
  const items = rows
    .filter((r) => products.some((p) => p.id === r.productId))
    .map((r) => ({
      productId: r.productId,
      name: r.product.name,
      sku: r.product.sku,
      quantity: Number(r.quantity),
      value: Number(r.quantity) * Number(r.product.purchasePrice),
      lowStockThreshold: r.lowStockThreshold != null ? Number(r.lowStockThreshold) : Number(r.product.lowStockThreshold),
      lowStock: Number(r.quantity) <= (r.lowStockThreshold != null ? Number(r.lowStockThreshold) : Number(r.product.lowStockThreshold)),
    }));
  res.json({ warehouse, items, totalValue: items.reduce((s, i) => s + i.value, 0) });
});

// Direct stock receiving into a warehouse not tied to a purchase (e.g.
// correcting an initial location assignment, or receiving stock whose
// purchase was recorded before Phase 6 existed).
// Phase 1.10: idempotencyKey lets a retried receive/dispatch/adjust (flaky
// connection, offline outbox retry) be recognized as the same operation
// instead of double-mutating stock - mirrors the identical pattern already
// used by Purchase/Sale/StockTransfer/GoodsReceipt.
const stockMoveSchema = z.object({ productId: z.string().uuid(), quantity: z.number().positive(), note: z.string().optional(), idempotencyKey: z.string().optional(), occurredAt: z.coerce.date().optional() });

router.post('/:id/receive', requirePermission('WAREHOUSE', 'APPROVE'), async (req, res) => {
  const parsed = stockMoveSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid stock receiving data', parsed.error.flatten());

  const warehouse = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!warehouse) throw new NotFoundError();
  await assertWarehouseAccess(prisma, req.user, warehouse.id);
  const product = await prisma.product.findFirst({ where: { id: parsed.data.productId, tenantId: req.user.tenantId } });
  if (!product) throw new NotFoundError('Product not found');

  if (parsed.data.idempotencyKey) {
    const existingTxn = await findExistingByIdempotencyKey(prisma.inventoryTransaction, req.user.tenantId, parsed.data.idempotencyKey);
    if (existingTxn) {
      const current = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId: product.id } } });
      return res.json({ item: current, deduplicated: true });
    }
  }

  let stock;
  try {
  stock = await runFinancialTransaction(prisma, async (tx) => {
    const updated = await adjustWarehouseStock(tx, {
      tenantId: req.user.tenantId,
      warehouseId: warehouse.id,
      productId: product.id,
      delta: parsed.data.quantity,
    });
    const txn = await tx.inventoryTransaction.create({
      data: {
        tenantId: req.user.tenantId,
        productId: product.id,
        warehouseId: warehouse.id,
        type: 'ADJUSTMENT_IN',
        quantity: parsed.data.quantity,
        balanceAfter: updated.quantity,
        note: parsed.data.note || 'Direct warehouse receiving',
        idempotencyKey: parsed.data.idempotencyKey,
        createdById: req.user.id,
        createdAt: resolveEventTime(parsed.data.occurredAt),
      },
    });
    await postInventoryAdjustment(tx, { tenantId: req.user.tenantId, branchId: warehouse.branchId, product, quantity: parsed.data.quantity, memo: `Warehouse ${warehouse.name}: ${parsed.data.note || 'Direct warehouse receiving'}`, sourceId: txn.id, postedById: req.user.id, date: resolveEventTime(parsed.data.occurredAt) });
    return updated;
  })  } catch (err) {
    // Two identical requests racing past the pre-check above: the loser hits the
    // (tenantId, idempotencyKey) unique index - answer it as the duplicate it is.
    if (err.code === 'P2002' && parsed.data.idempotencyKey && String(err.meta?.target).includes('idempotencyKey')) {
      const current = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId: product.id } } });
      return res.json({ item: current, deduplicated: true });
    }
    throw err;
  }
;

  await logAudit({ req, action: 'WAREHOUSE_RECEIVE', entity: 'Warehouse', entityId: warehouse.id, metadata: { productId: product.id, quantity: parsed.data.quantity } });
  res.json({ item: stock });
});

router.post('/:id/dispatch', requirePermission('WAREHOUSE', 'APPROVE'), async (req, res) => {
  const parsed = stockMoveSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid stock dispatch data', parsed.error.flatten());

  const warehouse = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!warehouse) throw new NotFoundError();
  await assertWarehouseAccess(prisma, req.user, warehouse.id);
  const product = await prisma.product.findFirst({ where: { id: parsed.data.productId, tenantId: req.user.tenantId } });
  if (!product) throw new NotFoundError('Product not found');

  if (parsed.data.idempotencyKey) {
    const existingTxn = await findExistingByIdempotencyKey(prisma.inventoryTransaction, req.user.tenantId, parsed.data.idempotencyKey);
    if (existingTxn) {
      const current = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId: product.id } } });
      return res.json({ item: current, deduplicated: true });
    }
  }

  let stock;
  try {
  stock = await runFinancialTransaction(prisma, async (tx) => {
    const updated = await adjustWarehouseStock(tx, {
      tenantId: req.user.tenantId,
      warehouseId: warehouse.id,
      productId: product.id,
      delta: -parsed.data.quantity,
    });
    const txn = await tx.inventoryTransaction.create({
      data: {
        tenantId: req.user.tenantId,
        productId: product.id,
        warehouseId: warehouse.id,
        type: 'ADJUSTMENT_OUT',
        quantity: -parsed.data.quantity,
        balanceAfter: updated.quantity,
        note: parsed.data.note || 'Direct warehouse dispatch',
        idempotencyKey: parsed.data.idempotencyKey,
        createdById: req.user.id,
        createdAt: resolveEventTime(parsed.data.occurredAt),
      },
    });
    await postInventoryAdjustment(tx, { tenantId: req.user.tenantId, branchId: warehouse.branchId, product, quantity: -parsed.data.quantity, memo: `Warehouse ${warehouse.name}: ${parsed.data.note || 'Direct warehouse dispatch'}`, sourceId: txn.id, postedById: req.user.id, date: resolveEventTime(parsed.data.occurredAt) });
    return updated;
  })  } catch (err) {
    // Two identical requests racing past the pre-check above: the loser hits the
    // (tenantId, idempotencyKey) unique index - answer it as the duplicate it is.
    if (err.code === 'P2002' && parsed.data.idempotencyKey && String(err.meta?.target).includes('idempotencyKey')) {
      const current = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId: product.id } } });
      return res.json({ item: current, deduplicated: true });
    }
    throw err;
  }
;

  await logAudit({ req, action: 'WAREHOUSE_DISPATCH', entity: 'Warehouse', entityId: warehouse.id, metadata: { productId: product.id, quantity: parsed.data.quantity } });
  res.json({ item: stock });
});

// Stock adjustment with an approval control: above a configurable
// threshold, only MANAGEMENT can perform it directly. Backend-enforced -
// not a UI-only restriction. This threshold check is a runtime,
// value-dependent business rule (not a static resource:action permission),
// so it deliberately stays as an explicit in-handler check rather than
// being folded into the Permission catalog.
const adjustSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().refine((v) => v !== 0, 'Quantity cannot be zero'),
  note: z.string().min(1),
  idempotencyKey: z.string().optional(),
  occurredAt: z.coerce.date().optional(), // Phase 3.2: when an offline terminal actually made the move
});

router.post('/:id/adjust', requirePermission('WAREHOUSE', 'APPROVE'), async (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid adjustment data', parsed.error.flatten());

  const warehouse = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!warehouse) throw new NotFoundError();
  await assertWarehouseAccess(prisma, req.user, warehouse.id);
  const product = await prisma.product.findFirst({ where: { id: parsed.data.productId, tenantId: req.user.tenantId } });
  if (!product) throw new NotFoundError('Product not found');

  if (parsed.data.idempotencyKey) {
    const existingTxn = await findExistingByIdempotencyKey(prisma.inventoryTransaction, req.user.tenantId, parsed.data.idempotencyKey);
    if (existingTxn) {
      const current = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId: product.id } } });
      return res.json({ item: current, deduplicated: true });
    }
  }

  const thresholdSetting = await prisma.setting.findUnique({
    where: { tenantId_key: { tenantId: req.user.tenantId, key: 'stockAdjustmentApprovalThreshold' } },
  });
  const threshold = thresholdSetting?.value != null ? Number(thresholdSetting.value) : null;
  const adjustmentValue = Math.abs(parsed.data.quantity) * Number(product.purchasePrice);
  if (threshold != null && adjustmentValue > threshold && !MANAGEMENT.includes(req.user.role)) {
    throw new ConflictError('This adjustment exceeds the configured threshold and requires a MANAGEMENT-role user');
  }

  let stock;
  try {
  stock = await runFinancialTransaction(prisma, async (tx) => {
    const updated = await adjustWarehouseStock(tx, {
      tenantId: req.user.tenantId,
      warehouseId: warehouse.id,
      productId: product.id,
      delta: parsed.data.quantity,
    });
    const txn = await tx.inventoryTransaction.create({
      data: {
        tenantId: req.user.tenantId,
        productId: product.id,
        warehouseId: warehouse.id,
        type: parsed.data.quantity > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        quantity: parsed.data.quantity,
        balanceAfter: updated.quantity,
        note: parsed.data.note,
        idempotencyKey: parsed.data.idempotencyKey,
        createdById: req.user.id,
        createdAt: resolveEventTime(parsed.data.occurredAt),
      },
    });
    await postInventoryAdjustment(tx, { tenantId: req.user.tenantId, branchId: warehouse.branchId, product, quantity: parsed.data.quantity, memo: `Warehouse ${warehouse.name}: ${parsed.data.note}`, sourceId: txn.id, postedById: req.user.id, date: resolveEventTime(parsed.data.occurredAt) });
    return updated;
  })  } catch (err) {
    // Two identical requests racing past the pre-check above: the loser hits the
    // (tenantId, idempotencyKey) unique index - answer it as the duplicate it is.
    if (err.code === 'P2002' && parsed.data.idempotencyKey && String(err.meta?.target).includes('idempotencyKey')) {
      const current = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId: product.id } } });
      return res.json({ item: current, deduplicated: true });
    }
    throw err;
  }
;

  await logAudit({ req, action: 'WAREHOUSE_ADJUST', entity: 'Warehouse', entityId: warehouse.id, metadata: { productId: product.id, quantity: parsed.data.quantity, note: parsed.data.note } });
  res.json({ item: stock });
});

// Warehouse activity/history.
router.get('/:id/history', requirePermission('WAREHOUSE', 'VIEW'), async (req, res) => {
  const warehouse = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!warehouse) throw new NotFoundError();
  await assertWarehouseAccess(prisma, req.user, warehouse.id);

  const items = await prisma.inventoryTransaction.findMany({
    where: { tenantId: req.user.tenantId, warehouseId: warehouse.id },
    include: { product: { select: { name: true, sku: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ items });
});

// Phase 0.4: fine-grained warehouse access grants - mirrors the
// branches.routes.js and companies.routes.js /:id/access sub-resource
// exactly, but for UserWarehouseAccess. TENANT_ADMIN-only, matching the
// other two access-grant endpoints.
router.get('/:id/access', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const warehouse = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!warehouse) throw new NotFoundError();
  const items = await prisma.userWarehouseAccess.findMany({
    where: { warehouseId: warehouse.id },
    include: { user: { select: { name: true, email: true, role: true } } },
  });
  res.json({ items });
});

router.post('/:id/access', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const schema = z.object({ userId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('A userId is required', parsed.error.flatten());

  const warehouse = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!warehouse) throw new NotFoundError('Warehouse not found');
  const user = await prisma.user.findFirst({ where: { id: parsed.data.userId, tenantId: req.user.tenantId } });
  if (!user) throw new NotFoundError('User not found');

  const item = await prisma.userWarehouseAccess.upsert({
    where: { userId_warehouseId: { userId: user.id, warehouseId: warehouse.id } },
    create: { tenantId: req.user.tenantId, userId: user.id, warehouseId: warehouse.id },
    update: {},
  });
  await logAudit({ req, action: 'WAREHOUSE_ACCESS_GRANT', entity: 'Warehouse', entityId: warehouse.id, metadata: { userId: user.id } });
  res.status(201).json({ item });
});

router.delete('/:id/access/:userId', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const warehouse = await prisma.warehouse.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!warehouse) throw new NotFoundError();
  await prisma.userWarehouseAccess.deleteMany({ where: { warehouseId: warehouse.id, userId: req.params.userId } });
  await logAudit({ req, action: 'WAREHOUSE_ACCESS_REVOKE', entity: 'Warehouse', entityId: warehouse.id, metadata: { userId: req.params.userId } });
  res.status(204).send();
});

module.exports = router;
