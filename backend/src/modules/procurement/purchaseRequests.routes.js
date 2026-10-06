// Purchase Requisition / Purchase Request - the first step of the Phase 5
// procurement lifecycle: Request -> RFQ -> Quotations -> Approval -> PO ->
// GRN -> Inventory -> Supplier Invoice -> Payment -> Supplier Ledger.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { INVENTORY_STAFF, MANAGEMENT } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');

const itemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().positive(),
  note: z.string().optional(),
});

const createSchema = z.object({
  branchId: z.string().uuid().optional(),
  // Phase 1.9: optional warehouse attribution - validated via the existing
  // assertWarehouseAccess (Phase 0.4), mirroring Sale.warehouseId (Phase 1.8).
  warehouseId: z.string().uuid().optional(),
  notes: z.string().optional(),
  // Phase 4.3: when the business needs the goods by - purely informational.
  requiredDate: z.coerce.date().optional(),
  items: z.array(itemSchema).min(1),
  // Phase 4.3: a request can be saved as a DRAFT (editable, not yet visible to an
  // approver) instead of submitting straight for approval. Defaulting to
  // PENDING_APPROVAL keeps every existing caller's behavior unchanged.
  status: z.enum(['DRAFT', 'PENDING_APPROVAL']).default('PENDING_APPROVAL'),
});

// Phase 4.3: editing a draft reuses the same item/branch/warehouse/notes/requiredDate
// shape as creation - a draft is fully replaceable until it is submitted.
const editSchema = z.object({
  branchId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
  requiredDate: z.coerce.date().nullable().optional(),
  items: z.array(itemSchema).min(1).optional(),
});


const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('PURCHASE_REQUEST', 'VIEW'), async (req, res) => {
  const { status } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (status) where.status = status;

  const [items, total] = await Promise.all([
    prisma.purchaseRequest.findMany({
      where,
      include: { items: { include: { product: true } }, requestedBy: { select: { name: true } }, branch: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.purchaseRequest.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('PURCHASE_REQUEST', 'VIEW'), async (req, res) => {
  const item = await prisma.purchaseRequest.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: {
      items: { include: { product: true } },
      requestedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      branch: true,
      rfqs: true,
    },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

router.post('/', requirePermission('PURCHASE_REQUEST', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid purchase request data', parsed.error.flatten());
  const { branchId, notes, items, requiredDate, status } = parsed.data;
  const warehouseId = parsed.data.warehouseId ?? null;

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

  const item = await prisma.$transaction(async (tx) => {
    const requestNumber = await nextSequenceNumber(tx.purchaseRequest, req.user.tenantId, 'PR', { tx });
    return tx.purchaseRequest.create({
      data: {
        tenantId: req.user.tenantId,
        branchId,
        warehouseId,
        notes,
        requiredDate,
        status,
        requestNumber,
        requestedById: req.user.id,
        items: { create: items.map((i) => ({ productId: i.productId, quantity: i.quantity, note: i.note })) },
      },
      include: { items: { include: { product: true } } },
    });
  });

  await logAudit({ req, action: 'PURCHASE_REQUEST_CREATE', entity: 'PurchaseRequest', entityId: item.id, metadata: { status: item.status } });
  res.status(201).json({ item });
});

// Phase 4.3: a DRAFT request is fully editable (items replaced wholesale, matching
// how offline-editing.js already treats a "replace this document" edit elsewhere in
// the app) - once submitted, the approval workflow below is the only way to change
// its status, and editing is refused.
router.patch('/:id', requirePermission('PURCHASE_REQUEST', 'UPDATE'), async (req, res) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid purchase request data', parsed.error.flatten());

  const existing = await prisma.purchaseRequest.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  if (existing.status !== 'DRAFT') throw new ConflictError('Only a draft request can be edited');
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const { branchId, warehouseId, notes, requiredDate, items } = parsed.data;
  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
    await assertBranchAccess(prisma, req.user, branchId);
  }
  if (warehouseId) {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.user.tenantId } });
    if (!warehouse) throw new NotFoundError('Warehouse not found');
  }
  if (warehouseId !== undefined) await assertWarehouseAccess(prisma, req.user, warehouseId);
  if (items) {
    for (const line of items) {
      const product = await prisma.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
      if (!product) throw new NotFoundError(`Product ${line.productId} not found`);
    }
  }

  const item = await prisma.$transaction(async (tx) => {
    // Guard against a concurrent submit/cancel racing this edit - only applies while
    // still DRAFT, exactly like the atomic conditional transitions below.
    const claimed = await tx.purchaseRequest.updateMany({
      where: { id: existing.id, status: 'DRAFT' },
      data: {
        ...(branchId !== undefined && { branchId }),
        ...(warehouseId !== undefined && { warehouseId }),
        ...(notes !== undefined && { notes }),
        ...(requiredDate !== undefined && { requiredDate }),
      },
    });
    if (claimed.count === 0) throw new ConflictError('Only a draft request can be edited');
    if (items) {
      await tx.purchaseRequestItem.deleteMany({ where: { purchaseRequestId: existing.id } });
      await tx.purchaseRequestItem.createMany({
        data: items.map((i) => ({ purchaseRequestId: existing.id, productId: i.productId, quantity: i.quantity, note: i.note })),
      });
    }
    return tx.purchaseRequest.findFirst({ where: { id: existing.id }, include: { items: { include: { product: true } } } });
  });

  await logAudit({ req, action: 'PURCHASE_REQUEST_EDIT', entity: 'PurchaseRequest', entityId: item.id });
  res.json({ item });
});

router.post('/:id/submit', requirePermission('PURCHASE_REQUEST', 'UPDATE'), async (req, res) => {
  const existing = await prisma.purchaseRequest.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const flipped = await prisma.purchaseRequest.updateMany({
    where: { id: existing.id, status: 'DRAFT' },
    data: { status: 'PENDING_APPROVAL' },
  });
  if (flipped.count === 0) throw new ConflictError('Only a draft request can be submitted');
  const item = await prisma.purchaseRequest.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'PURCHASE_REQUEST_SUBMIT', entity: 'PurchaseRequest', entityId: item.id });
  res.json({ item });
});

router.post('/:id/approve', requirePermission('PURCHASE_REQUEST', 'APPROVE'), async (req, res) => {
  const existing = await prisma.purchaseRequest.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  // Atomic conditional status transition - guards against a concurrent
  // approve/reject/cancel of the same request racing this one (same class of
  // check-then-blind-write race fixed elsewhere in procurement/Sales).
  const flipped = await prisma.purchaseRequest.updateMany({
    where: { id: existing.id, status: 'PENDING_APPROVAL' },
    data: { status: 'APPROVED', approvedById: req.user.id, approvedAt: new Date() },
  });
  if (flipped.count === 0) throw new ConflictError('Only a pending request can be approved');
  const item = await prisma.purchaseRequest.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'PURCHASE_REQUEST_APPROVE', entity: 'PurchaseRequest', entityId: item.id });
  res.json({ item });
});

router.post('/:id/reject', requireRole(...MANAGEMENT), async (req, res) => {
  const schema = z.object({ reason: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('A rejection reason is required', parsed.error.flatten());

  const existing = await prisma.purchaseRequest.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const flipped = await prisma.purchaseRequest.updateMany({
    where: { id: existing.id, status: 'PENDING_APPROVAL' },
    data: { status: 'REJECTED', approvedById: req.user.id, approvedAt: new Date(), rejectionReason: parsed.data.reason },
  });
  if (flipped.count === 0) throw new ConflictError('Only a pending request can be rejected');
  const item = await prisma.purchaseRequest.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'PURCHASE_REQUEST_REJECT', entity: 'PurchaseRequest', entityId: item.id });
  res.json({ item });
});

router.post('/:id/cancel', requireRole(...INVENTORY_STAFF), async (req, res) => {
  const existing = await prisma.purchaseRequest.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const flipped = await prisma.purchaseRequest.updateMany({
    where: { id: existing.id, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
    data: { status: 'CANCELLED' },
  });
  if (flipped.count === 0) throw new ConflictError('This request can no longer be cancelled');
  const item = await prisma.purchaseRequest.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'PURCHASE_REQUEST_CANCEL', entity: 'PurchaseRequest', entityId: item.id });
  res.json({ item });
});

module.exports = router;
