// Purchase Orders. Can be created directly (the common path for a small
// shop's routine reorders) or via RFQ quotation selection (rfqs.routes.js) -
// RFQ/quotation is a capability, not a mandatory gate, per the Phase 5 UX
// requirement to keep workflows simple for small/medium businesses.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { INVENTORY_STAFF, MANAGEMENT } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { triggerEvent } = require('../communication/automation');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');

async function getApprovalThreshold(tenantId) {
  const setting = await prisma.setting.findUnique({
    where: { tenantId_key: { tenantId, key: 'purchaseApprovalThreshold' } },
  });
  return setting?.value != null ? Number(setting.value) : null;
}

const createSchema = z.object({
  supplierId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  // Phase 1.9: optional warehouse attribution - validated via the existing
  // assertWarehouseAccess (Phase 0.4), mirroring Sale.warehouseId (Phase 1.8).
  // The warehouse goods against this PO are expected to be received into;
  // GRN falls back to this when its own warehouseId is omitted.
  warehouseId: z.string().uuid().optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().positive(), unitCost: z.number().nonnegative() })).min(1),
  discount: z.number().nonnegative().default(0),
  tax: z.number().nonnegative().default(0),
  notes: z.string().optional(),
});

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('PURCHASE_ORDER', 'VIEW'), async (req, res) => {
  const { status, supplierId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (status) where.status = status;
  if (supplierId) where.supplierId = supplierId;

  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: { supplier: true, items: { include: { product: true } }, grns: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('PURCHASE_ORDER', 'VIEW'), async (req, res) => {
  const item = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: {
      supplier: true,
      items: { include: { product: true } },
      grns: { include: { items: true } },
      purchases: true,
      sourceQuotation: true,
    },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

router.post('/', requirePermission('PURCHASE_ORDER', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid purchase order data', parsed.error.flatten());
  const { supplierId, branchId, items, discount, tax, notes } = parsed.data;
  const warehouseId = parsed.data.warehouseId ?? null;

  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId: req.user.tenantId } });
  if (!supplier) throw new NotFoundError('Supplier not found');
  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
    await assertBranchAccess(prisma, req.user, branchId);
  }
  if (warehouseId) {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.user.tenantId } });
    if (!warehouse) throw new NotFoundError('Warehouse not found');
  }
  await assertWarehouseAccess(prisma, req.user, warehouseId);
  for (const line of items) {
    const product = await prisma.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
    if (!product) throw new NotFoundError(`Product ${line.productId} not found`);
  }

  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitCost, 0);
  const total = Math.max(subtotal - discount + tax, 0);
  const threshold = await getApprovalThreshold(req.user.tenantId);
  // No threshold configured => every PO auto-approves, matching the "keep it
  // simple by default" UX requirement; a tenant opts into stricter control
  // by setting one via PUT /api/settings/purchaseApprovalThreshold.
  const needsApproval = threshold != null && total > threshold;

  const item = await prisma.$transaction(async (tx) => {
    const poNumber = await nextSequenceNumber(tx.purchaseOrder, req.user.tenantId, 'PO', { tx });
    return tx.purchaseOrder.create({
      data: {
        tenantId: req.user.tenantId,
        branchId,
        warehouseId,
        supplierId,
        poNumber,
        subtotal,
        discount,
        tax,
        total,
        notes,
        status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED',
        createdById: req.user.id,
        approvedById: needsApproval ? null : req.user.id,
        approvedAt: needsApproval ? null : new Date(),
        items: { create: items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitCost: i.unitCost, lineTotal: i.quantity * i.unitCost })) },
      },
      include: { items: true, supplier: true },
    });
  });

  await logAudit({ req, action: 'PURCHASE_ORDER_CREATE', entity: 'PurchaseOrder', entityId: item.id });
  res.status(201).json({ item });
});

router.post('/:id/approve', requirePermission('PURCHASE_ORDER', 'APPROVE'), async (req, res) => {
  const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  // Atomic conditional status transition, not check-then-blind-write: guards
  // against a concurrent approve/reject/cancel of the same PO racing this one
  // (same class of race fixed for GRN receiving and Sale reversal).
  const flipped = await prisma.purchaseOrder.updateMany({
    where: { id: existing.id, status: 'PENDING_APPROVAL' },
    data: { status: 'APPROVED', approvedById: req.user.id, approvedAt: new Date() },
  });
  if (flipped.count === 0) throw new ConflictError('Only a pending purchase order can be approved');
  const item = await prisma.purchaseOrder.findFirst({ where: { id: existing.id }, include: { supplier: true } });
  await logAudit({ req, action: 'PURCHASE_ORDER_APPROVE', entity: 'PurchaseOrder', entityId: item.id });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'PURCHASE_APPROVED',
    sourceId: item.id,
    branchId: item.branchId,
    internalTitle: 'Purchase order approved',
    internalBody: `PO ${item.poNumber} to ${item.supplier?.name || 'supplier'} for ${Number(item.total).toFixed(2)} has been approved`,
    variables: { link: `/procurement/purchase-orders/${item.id}` },
  });

  res.json({ item });
});

router.post('/:id/reject', requireRole(...MANAGEMENT), async (req, res) => {
  const schema = z.object({ reason: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('A rejection reason is required', parsed.error.flatten());

  const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const flipped = await prisma.purchaseOrder.updateMany({
    where: { id: existing.id, status: 'PENDING_APPROVAL' },
    data: { status: 'REJECTED', rejectionReason: parsed.data.reason },
  });
  if (flipped.count === 0) throw new ConflictError('Only a pending purchase order can be rejected');
  const item = await prisma.purchaseOrder.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'PURCHASE_ORDER_REJECT', entity: 'PurchaseOrder', entityId: item.id });
  res.json({ item });
});

router.post('/:id/cancel', requireRole(...INVENTORY_STAFF), async (req, res) => {
  const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  // Atomic conditional cancel - a concurrent GRN could be receiving against
  // this same PO right now (moving it to PARTIALLY_RECEIVED/RECEIVED); a
  // blind unconditioned write here could otherwise clobber that legitimate
  // status change to CANCELLED after the fact. The guard also symmetrically
  // protects the GRN side, which itself only rolls its own status update
  // forward while the PO is still APPROVED/PARTIALLY_RECEIVED.
  const flipped = await prisma.purchaseOrder.updateMany({
    where: { id: existing.id, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
    data: { status: 'CANCELLED' },
  });
  if (flipped.count === 0) throw new ConflictError('This purchase order can no longer be cancelled');
  const item = await prisma.purchaseOrder.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'PURCHASE_ORDER_CANCEL', entity: 'PurchaseOrder', entityId: item.id });
  res.json({ item });
});

// Phase 4.3: a PO's notes are editable at any time (they carry no business-logic
// weight); quantities/pricing are deliberately locked once created - changing what
// was actually ordered goes through cancel + a new PO, not a silent edit here.
router.patch('/:id', requirePermission('PURCHASE_ORDER', 'UPDATE'), async (req, res) => {
  const schema = z.object({ notes: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid purchase order data', parsed.error.flatten());

  const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const item = await prisma.purchaseOrder.update({ where: { id: existing.id }, data: { notes: parsed.data.notes } });
  await logAudit({ req, action: 'PURCHASE_ORDER_EDIT', entity: 'PurchaseOrder', entityId: item.id });
  res.json({ item });
});

module.exports = router;
