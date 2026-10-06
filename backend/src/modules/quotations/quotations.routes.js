// Phase 1.14: Customer Quotations - a NEW, additive module. Distinct from
// the existing, procurement-side SupplierQuotation (an RFQ response FROM a
// supplier, Phase 5) which this does not touch. A Quotation never creates a
// Sale, Payment, or any inventory/accounting effect by itself - only
// converting an ACCEPTED quotation into a SalesOrder (see POST /:id/convert)
// produces a new document, and even that carries no financial/inventory
// effect of its own (see salesOrders.routes.js for where those actually
// happen, at Sale-conversion time).
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { logAudit } = require('../../middleware/audit');
const { triggerEvent } = require('../communication/automation');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');

const router = express.Router();
router.use(authenticate, requireTenant);

const itemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discount: z.number().nonnegative().default(0),
  tax: z.number().nonnegative().default(0),
});

const createSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  items: z.array(itemSchema).min(1),
  validUntil: z.string().datetime().optional(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  salesPersonId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
});

function computeTotals(items) {
  let subtotal = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  const lines = items.map((i) => {
    const lineTotal = i.quantity * i.unitPrice - i.discount;
    subtotal += i.quantity * i.unitPrice;
    totalDiscount += i.discount;
    totalTax += i.tax;
    return { ...i, lineTotal };
  });
  const total = Math.max(subtotal - totalDiscount + totalTax, 0);
  return { lines, subtotal, discount: totalDiscount, tax: totalTax, total };
}

// A SENT quotation whose validUntil has passed is stale - lazily flipped to
// EXPIRED the moment it matters (accept/reject/convert), rather than via a
// background job/cron this codebase has no precedent for. Atomic, so a
// concurrent accept/expire race can't leave the quotation in an
// inconsistent state.
async function maybeExpire(tx, quotation) {
  if (quotation.status === 'SENT' && quotation.validUntil && new Date(quotation.validUntil) < new Date()) {
    const flipped = await tx.quotation.updateMany({
      where: { id: quotation.id, status: 'SENT' },
      data: { status: 'EXPIRED' },
    });
    if (flipped.count > 0) return { ...quotation, status: 'EXPIRED' };
  }
  return quotation;
}

router.get('/', requirePermission('QUOTATION', 'VIEW'), async (req, res) => {
  const { customerId, status, from, to, search, branchId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (customerId) where.customerId = customerId;
  if (status) where.status = status;
  if (search) where.quotationNumber = { contains: search, mode: 'insensitive' };
  if (from || to) {
    where.quotationDate = {};
    if (from) where.quotationDate.gte = new Date(from);
    if (to) where.quotationDate.lte = new Date(to);
  }
  if (branchId) {
    await assertBranchAccess(prisma, req.user, branchId);
    where.branchId = branchId;
  }

  const [items, total] = await Promise.all([
    prisma.quotation.findMany({
      where,
      include: { customer: { select: { name: true } }, salesOrder: { select: { orderNumber: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.quotation.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('QUOTATION', 'VIEW'), async (req, res) => {
  const item = await prisma.quotation.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { customer: true, items: { include: { product: true } }, salesOrder: true, salesPerson: { select: { name: true } } },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

router.post('/', requirePermission('QUOTATION', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid quotation data', parsed.error.flatten());
  const { customerId, items, validUntil, notes, terms, idempotencyKey } = parsed.data;
  const branchId = parsed.data.branchId ?? req.user.branchId ?? null;
  const warehouseId = parsed.data.warehouseId ?? null;
  const salesPersonId = parsed.data.salesPersonId ?? req.user.id;

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.quotation, req.user.tenantId, idempotencyKey, { items: true });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: req.user.tenantId } });
  if (!customer) throw new NotFoundError('Customer not found');
  await assertBranchAccess(prisma, req.user, branchId);
  await assertWarehouseAccess(prisma, req.user, warehouseId);

  for (const line of items) {
    const product = await prisma.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
    if (!product) throw new NotFoundError(`Product ${line.productId} not found`);
    if (line.variantId) {
      const variant = await prisma.productVariant.findFirst({ where: { id: line.variantId, tenantId: req.user.tenantId, productId: product.id } });
      if (!variant) throw new NotFoundError(`Variant not found for product ${product.name}`);
    }
  }

  const { lines, subtotal, discount, tax, total } = computeTotals(items);

  // Same class of collision risk as every other module built on
  // nextSequenceNumber (see docs/phase1-9 and later reports' Known
  // Limitations) - the whole-transaction bounded retry is the established
  // mitigation, not a rewrite of the shared utility itself.
  const MAX_NUMBER_RETRIES = 8;
  let quotation;
  for (let attempt = 1; attempt <= MAX_NUMBER_RETRIES; attempt++) {
    try {
      quotation = await prisma.$transaction(async (tx) => {
        const quotationNumber = await nextSequenceNumber(tx.quotation, req.user.tenantId, 'QT', { tx });
        return tx.quotation.create({
          data: {
            tenantId: req.user.tenantId,
            branchId,
            warehouseId,
            quotationNumber,
            customerId,
            validUntil: validUntil ? new Date(validUntil) : null,
            subtotal,
            discount,
            tax,
            total,
            notes,
            terms,
            salesPersonId,
            idempotencyKey,
            items: {
              create: lines.map((l) => ({
                productId: l.productId,
                variantId: l.variantId,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                discount: l.discount,
                tax: l.tax,
                lineTotal: l.lineTotal,
              })),
            },
          },
          include: { items: true },
        });
      });
      break;
    } catch (err) {
      const isCollision = err.code === 'P2002' && err.meta?.target?.includes('quotationNumber');
      if (!isCollision || attempt === MAX_NUMBER_RETRIES) throw err;
    }
  }

  await logAudit({ req, action: 'QUOTATION_CREATE', entity: 'Quotation', entityId: quotation.id });
  res.status(201).json({ item: quotation });
});

const updateSchema = z.object({
  notes: z.string().optional(),
  terms: z.string().optional(),
  validUntil: z.string().datetime().nullable().optional(),
}).strict();

// Editing is restricted to DRAFT only, and to non-financial fields - once a
// quotation has been sent, its pricing must stay a stable, auditable
// snapshot of what the customer was actually shown (Section 8's "editing an
// existing quotation must not silently modify a downstream document" -
// enforced here even more strictly, by not allowing pricing edits at all
// past DRAFT, rather than by trying to propagate a change forward).
router.patch('/:id', requirePermission('QUOTATION', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid update data', parsed.error.flatten());

  const existing = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);
  if (existing.status !== 'DRAFT') throw new ConflictError('Only a draft quotation can be edited');

  const item = await prisma.quotation.update({
    where: { id: existing.id },
    data: {
      notes: parsed.data.notes,
      terms: parsed.data.terms,
      validUntil: parsed.data.validUntil === undefined ? undefined : parsed.data.validUntil ? new Date(parsed.data.validUntil) : null,
    },
  });
  await logAudit({ req, action: 'QUOTATION_UPDATE', entity: 'Quotation', entityId: item.id });
  res.json({ item });
});

router.post('/:id/send', requirePermission('QUOTATION', 'UPDATE'), async (req, res) => {
  const existing = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const flipped = await prisma.quotation.updateMany({ where: { id: existing.id, status: 'DRAFT' }, data: { status: 'SENT' } });
  if (flipped.count === 0) throw new ConflictError('Only a draft quotation can be sent');

  const item = await prisma.quotation.findUnique({ where: { id: existing.id } });
  await logAudit({ req, action: 'QUOTATION_SEND', entity: 'Quotation', entityId: item.id });
  res.json({ item });
});

router.post('/:id/accept', requirePermission('QUOTATION', 'APPROVE'), async (req, res) => {
  const preCheck = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!preCheck) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, preCheck.branchId);
  // Committed independently, BEFORE the main transaction - if this ran
  // inside the same transaction that the ConflictError below aborts, the
  // expiry flip itself would be rolled back along with it (Prisma rolls
  // back the whole transaction on any throw), silently undoing the very
  // status change this is meant to persist. A real bug caught by this
  // phase's own test suite, not by inspection.
  await maybeExpire(prisma, preCheck);

  const item = await prisma.$transaction(async (tx) => {
    const existing = await tx.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();
    if (existing.status === 'EXPIRED') throw new ConflictError('This quotation has expired and can no longer be accepted');

    const flipped = await tx.quotation.updateMany({ where: { id: existing.id, status: 'SENT' }, data: { status: 'ACCEPTED' } });
    if (flipped.count === 0) throw new ConflictError('Only a sent quotation can be accepted');
    return tx.quotation.findUnique({ where: { id: existing.id } });
  });
  await logAudit({ req, action: 'QUOTATION_ACCEPT', entity: 'Quotation', entityId: item.id, branchId: item.branchId });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'QUOTATION_ACCEPTED',
    sourceId: item.id,
    entityType: 'Quotation',
    branchId: item.branchId,
    variables: { quotationNumber: item.quotationNumber, total: Number(item.total) },
    internalTitle: `Quotation accepted: ${item.quotationNumber}`,
    internalBody: `Quotation ${item.quotationNumber} (${Number(item.total).toFixed(2)}) was accepted by the customer.`,
  });

  res.json({ item });
});

router.post('/:id/reject', requirePermission('QUOTATION', 'REVERSE'), async (req, res) => {
  const preCheck = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!preCheck) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, preCheck.branchId);
  await maybeExpire(prisma, preCheck);

  const item = await prisma.$transaction(async (tx) => {
    const existing = await tx.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();
    if (existing.status === 'EXPIRED') throw new ConflictError('This quotation has already expired');

    const flipped = await tx.quotation.updateMany({ where: { id: existing.id, status: 'SENT' }, data: { status: 'REJECTED' } });
    if (flipped.count === 0) throw new ConflictError('Only a sent quotation can be rejected');
    return tx.quotation.findUnique({ where: { id: existing.id } });
  });
  await logAudit({ req, action: 'QUOTATION_REJECT', entity: 'Quotation', entityId: item.id });
  res.json({ item });
});

router.post('/:id/cancel', requirePermission('QUOTATION', 'REVERSE'), async (req, res) => {
  const existing = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const flipped = await prisma.quotation.updateMany({
    where: { id: existing.id, status: { in: ['DRAFT', 'SENT'] } },
    data: { status: 'CANCELLED' },
  });
  if (flipped.count === 0) throw new ConflictError('Only a draft or sent quotation can be cancelled');

  const item = await prisma.quotation.findUnique({ where: { id: existing.id } });
  await logAudit({ req, action: 'QUOTATION_CANCEL', entity: 'Quotation', entityId: item.id });
  res.json({ item });
});

// Explicit, on-demand expiry - useful both for a client that wants to mark
// a stale quotation without touching it any other way, and for
// deterministic testing (rather than relying solely on the lazy check
// inside accept/reject/convert).
router.post('/:id/expire', requirePermission('QUOTATION', 'UPDATE'), async (req, res) => {
  const existing = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);
  if (existing.status !== 'SENT') throw new ConflictError('Only a sent quotation can expire');
  if (!existing.validUntil || new Date(existing.validUntil) >= new Date()) {
    throw new ConflictError('This quotation has not yet passed its valid-until date');
  }

  const flipped = await prisma.quotation.updateMany({ where: { id: existing.id, status: 'SENT' }, data: { status: 'EXPIRED' } });
  if (flipped.count === 0) throw new ConflictError('Only a sent quotation can expire');

  const item = await prisma.quotation.findUnique({ where: { id: existing.id } });
  await logAudit({ req, action: 'QUOTATION_EXPIRE', entity: 'Quotation', entityId: item.id });
  res.json({ item });
});

// Quotation -> Sales Order. Gated on SALES_ORDER:CREATE (the permission for
// the document actually being created here), not a separate
// QUOTATION:CONVERT action - mirrors the precedent already established in
// Phase 1.13 for SalesReturn/PurchaseReturn auto-issuing a linked
// CreditNote/DebitNote under a single CREATE permission.
router.post('/:id/convert', requirePermission('SALES_ORDER', 'CREATE'), async (req, res) => {
  const bodySchema = z.object({ idempotencyKey: z.string().optional() });
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) throw new ValidationError('Invalid request', parsed.error.flatten());

  if (parsed.data.idempotencyKey) {
    const existingOrder = await findExistingByIdempotencyKey(prisma.salesOrder, req.user.tenantId, parsed.data.idempotencyKey, { items: true });
    if (existingOrder) return res.status(200).json({ item: existingOrder, deduplicated: true });
  }

  const preCheck = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!preCheck) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, preCheck.branchId);
  // Committed independently, BEFORE the transaction/retry loop below - see
  // the identical fix (and its rationale) in POST /:id/accept above.
  await maybeExpire(prisma, preCheck);

  const MAX_NUMBER_RETRIES = 8;
  let salesOrder;
  for (let attempt = 1; attempt <= MAX_NUMBER_RETRIES; attempt++) {
    try {
      salesOrder = await prisma.$transaction(async (tx) => {
        const quotation = await tx.quotation.findFirst({
          where: { id: req.params.id, tenantId: req.user.tenantId },
          include: { items: true },
        });
        if (!quotation) throw new NotFoundError();
        if (quotation.status === 'EXPIRED') throw new ConflictError('This quotation has expired and can no longer be converted');

        // Atomic guard against duplicate/concurrent conversion - the sole
        // authoritative defense (the @@unique on SalesOrder.sourceQuotationId
        // is a second, DB-level line of defense below). Two concurrent
        // convert requests for the same quotation: only one can flip
        // ACCEPTED -> CONVERTED; the other sees count: 0 and fails cleanly,
        // never reaching SalesOrder creation.
        const flipped = await tx.quotation.updateMany({ where: { id: quotation.id, status: 'ACCEPTED' }, data: { status: 'CONVERTED' } });
        if (flipped.count === 0) throw new ConflictError('Only an accepted quotation can be converted, and it may have already been converted');

        const orderNumber = await nextSequenceNumber(tx.salesOrder, req.user.tenantId, 'SO', { tx });
        return tx.salesOrder.create({
          data: {
            tenantId: req.user.tenantId,
            branchId: quotation.branchId,
            warehouseId: quotation.warehouseId,
            orderNumber,
            customerId: quotation.customerId,
            sourceQuotationId: quotation.id,
            subtotal: quotation.subtotal,
            discount: quotation.discount,
            tax: quotation.tax,
            total: quotation.total,
            notes: quotation.notes,
            salesPersonId: quotation.salesPersonId,
            idempotencyKey: parsed.data.idempotencyKey,
            items: {
              create: quotation.items.map((i) => ({
                productId: i.productId,
                variantId: i.variantId,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                discount: i.discount,
                lineTotal: i.lineTotal,
              })),
            },
          },
          include: { items: true },
        });
      });
      break;
    } catch (err) {
      const isCollision = err.code === 'P2002' && err.meta?.target?.includes('orderNumber');
      if (!isCollision || attempt === MAX_NUMBER_RETRIES) throw err;
    }
  }

  await logAudit({ req, action: 'QUOTATION_CONVERT', entity: 'Quotation', entityId: req.params.id, metadata: { salesOrderId: salesOrder.id } });
  res.status(201).json({ item: salesOrder });
});

module.exports = router;
