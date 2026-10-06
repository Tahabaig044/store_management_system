// RFQ creation/supplier selection, supplier quotation entry, and side-by-side
// comparison with a best-quotation recommendation. Suppliers in this system
// don't have their own login (no supplier portal), so quotations are
// recorded by staff on the supplier's behalf - consistent with how the rest
// of the app already treats suppliers as records, not accounts.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { MANAGEMENT } = require('../../constants/roles');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');

const createSchema = z.object({
  purchaseRequestId: z.string().uuid().optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().positive() })).min(1),
  supplierIds: z.array(z.string().uuid()).min(1),
  // Phase 4.3: when the buyer needs delivery by - purely informational.
  expectedDeliveryDate: z.coerce.date().optional(),
});

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('RFQ', 'VIEW'), async (req, res) => {
  const { status } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = { tenantId: req.user.tenantId };
  if (status) where.status = status;

  const [items, total] = await Promise.all([
    prisma.rFQ.findMany({
      where,
      include: { items: { include: { product: true } }, suppliers: { include: { supplier: true } }, quotations: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.rFQ.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('RFQ', 'VIEW'), async (req, res) => {
  const item = await prisma.rFQ.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: {
      items: { include: { product: true } },
      suppliers: { include: { supplier: true } },
      quotations: { include: { items: true, supplier: true } },
      purchaseRequest: true,
    },
  });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.post('/', requirePermission('RFQ', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid RFQ data', parsed.error.flatten());
  const { purchaseRequestId, items, supplierIds, expectedDeliveryDate } = parsed.data;

  if (purchaseRequestId) {
    const pr = await prisma.purchaseRequest.findFirst({ where: { id: purchaseRequestId, tenantId: req.user.tenantId } });
    if (!pr) throw new NotFoundError('Purchase request not found');
    // Phase 4.3: an RFQ sourced from a request must come from one that has actually
    // been approved - a manual/no-source RFQ (the common small-shop path) is unaffected.
    if (pr.status !== 'APPROVED') throw new ConflictError('An RFQ can only be created from an approved purchase request');
  }
  for (const line of items) {
    const product = await prisma.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
    if (!product) throw new NotFoundError(`Product ${line.productId} not found`);
  }
  const suppliers = await prisma.supplier.findMany({ where: { id: { in: supplierIds }, tenantId: req.user.tenantId } });
  if (suppliers.length !== supplierIds.length) throw new NotFoundError('One or more suppliers not found');

  const item = await prisma.$transaction(async (tx) => {
    const rfqNumber = await nextSequenceNumber(tx.rFQ, req.user.tenantId, 'RFQ', { tx });
    return tx.rFQ.create({
      data: {
        tenantId: req.user.tenantId,
        purchaseRequestId,
        rfqNumber,
        expectedDeliveryDate,
        createdById: req.user.id,
        items: { create: items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
        suppliers: { create: supplierIds.map((supplierId) => ({ supplierId })) },
      },
      include: { items: true, suppliers: { include: { supplier: true } } },
    });
  });

  await logAudit({ req, action: 'RFQ_CREATE', entity: 'RFQ', entityId: item.id });
  res.status(201).json({ item });
});

// Phase 4.3: closes the RFQ to further quotations without selecting one - e.g. no
// supplier responded in time, or the buyer changed their mind. Distinct from the
// automatic close that happens when a quotation is selected (rfqs.routes.js above).
router.post('/:id/close', requirePermission('RFQ', 'UPDATE'), async (req, res) => {
  const existing = await prisma.rFQ.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  const flipped = await prisma.rFQ.updateMany({ where: { id: existing.id, status: 'OPEN' }, data: { status: 'CLOSED' } });
  if (flipped.count === 0) throw new ConflictError('Only an open RFQ can be closed');
  const item = await prisma.rFQ.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'RFQ_CLOSE', entity: 'RFQ', entityId: item.id });
  res.json({ item });
});

router.post('/:id/cancel', requirePermission('RFQ', 'UPDATE'), async (req, res) => {
  const existing = await prisma.rFQ.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  const flipped = await prisma.rFQ.updateMany({ where: { id: existing.id, status: 'OPEN' }, data: { status: 'CANCELLED' } });
  if (flipped.count === 0) throw new ConflictError('Only an open RFQ can be cancelled');
  const item = await prisma.rFQ.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'RFQ_CANCEL', entity: 'RFQ', entityId: item.id });
  res.json({ item });
});

const quotationSchema = z.object({
  supplierId: z.string().uuid(),
  validUntil: z.coerce.date().optional(),
  deliveryDays: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
  discount: z.number().nonnegative().default(0),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative(),
    tax: z.number().nonnegative().default(0),
    discount: z.number().nonnegative().default(0),
  })).min(1),
});

router.post('/:id/quotations', requirePermission('RFQ', 'UPDATE'), async (req, res) => {
  const parsed = quotationSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid quotation data', parsed.error.flatten());

  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { suppliers: true } });
  if (!rfq) throw new NotFoundError('RFQ not found');
  if (rfq.status !== 'OPEN') throw new ConflictError('This RFQ is no longer accepting quotations');
  if (!rfq.suppliers.some((s) => s.supplierId === parsed.data.supplierId)) {
    throw new ValidationError('This supplier was not invited to this RFQ');
  }

  const subtotal = parsed.data.items.reduce((s, i) => s + i.quantity * i.unitPrice - i.discount, 0);
  const tax = parsed.data.items.reduce((s, i) => s + i.tax, 0);
  const total = Math.max(subtotal - parsed.data.discount + tax, 0);

  const item = await prisma.supplierQuotation.create({
    data: {
      tenantId: req.user.tenantId,
      rfqId: rfq.id,
      supplierId: parsed.data.supplierId,
      validUntil: parsed.data.validUntil,
      deliveryDays: parsed.data.deliveryDays,
      notes: parsed.data.notes,
      subtotal,
      tax,
      discount: parsed.data.discount,
      total,
      items: {
        create: parsed.data.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          tax: i.tax,
          discount: i.discount,
          lineTotal: i.quantity * i.unitPrice - i.discount,
        })),
      },
    },
    include: { items: true, supplier: true },
  });
  res.status(201).json({ item });
});

// Side-by-side comparison with a lowest-total-price recommendation. Other
// criteria (fastest delivery, best per-unit price) are surfaced too so a
// buyer isn't forced into the default recommendation.
router.get('/:id/compare', requirePermission('RFQ', 'VIEW'), async (req, res) => {
  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!rfq) throw new NotFoundError('RFQ not found');

  const quotations = await prisma.supplierQuotation.findMany({
    where: { rfqId: rfq.id, status: { not: 'REJECTED' } },
    include: { items: { include: { product: true } }, supplier: true },
    orderBy: { total: 'asc' },
  });

  const recommendedId = quotations[0]?.id || null;
  const fastestDelivery = [...quotations].sort((a, b) => (a.deliveryDays ?? Infinity) - (b.deliveryDays ?? Infinity))[0]?.id || null;

  res.json({ quotations, recommendation: { lowestTotalId: recommendedId, fastestDeliveryId: fastestDelivery } });
});

// Selecting a quotation closes the RFQ, rejects the other quotations, and
// creates the Purchase Order that carries the procurement forward.
router.post('/:id/quotations/:quotationId/select', requireRole(...MANAGEMENT), async (req, res) => {
  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!rfq) throw new NotFoundError('RFQ not found');

  const quotation = await prisma.supplierQuotation.findFirst({
    where: { id: req.params.quotationId, rfqId: rfq.id, tenantId: req.user.tenantId },
    include: { items: true },
  });
  if (!quotation) throw new NotFoundError('Quotation not found');
  if (quotation.status === 'SELECTED') throw new ConflictError('This quotation has already been selected');
  if (quotation.status === 'REJECTED') throw new ConflictError('This quotation was rejected and cannot be selected');
  // Phase 4.3 bug fix: a quotation whose validity date has passed must not be
  // accepted into a PO - it was found to be un-guarded during this phase's audit.
  if (quotation.validUntil && quotation.validUntil.getTime() < Date.now()) {
    throw new ConflictError('This quotation has expired and can no longer be selected');
  }

  const threshold = await prisma.setting.findUnique({
    where: { tenantId_key: { tenantId: req.user.tenantId, key: 'purchaseApprovalThreshold' } },
  });
  const needsApproval = threshold?.value != null && Number(quotation.total) > Number(threshold.value);

  const po = await prisma.$transaction(async (tx) => {
    // Phase 4.3 concurrency fix: this used to be an unconditional update, so two
    // quotations of the same RFQ selected at once could each pass the pre-check
    // above (reading different rows) and both go on to close the RFQ and create a
    // PO. The atomic conditional claim below - mirroring the same pattern already
    // used for PR/PO/GRN status transitions - makes only the first selection win;
    // a losing concurrent request gets a clean conflict instead of a duplicate PO.
    const claimedRfq = await tx.rFQ.updateMany({ where: { id: rfq.id, status: 'OPEN' }, data: { status: 'CLOSED' } });
    if (claimedRfq.count === 0) throw new ConflictError('This RFQ is no longer open - a quotation may already have been selected');
    const claimedQuotation = await tx.supplierQuotation.updateMany({
      where: { id: quotation.id, status: quotation.status },
      data: { status: 'SELECTED' },
    });
    if (claimedQuotation.count === 0) throw new ConflictError('This quotation was just changed by someone else - reload and try again');
    await tx.supplierQuotation.updateMany({
      where: { rfqId: rfq.id, id: { not: quotation.id }, status: { notIn: ['SELECTED', 'REJECTED'] } },
      data: { status: 'REJECTED' },
    });

    const poNumber = await nextSequenceNumber(tx.purchaseOrder, req.user.tenantId, 'PO', { tx });
    return tx.purchaseOrder.create({
      data: {
        tenantId: req.user.tenantId,
        supplierId: quotation.supplierId,
        sourceQuotationId: quotation.id,
        poNumber,
        subtotal: quotation.subtotal,
        discount: quotation.discount,
        tax: quotation.tax,
        total: quotation.total,
        status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED',
        createdById: req.user.id,
        approvedById: needsApproval ? null : req.user.id,
        approvedAt: needsApproval ? null : new Date(),
        items: {
          create: quotation.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitCost: i.unitPrice,
            lineTotal: i.lineTotal,
          })),
        },
      },
      include: { items: true, supplier: true },
    });
  });

  await logAudit({ req, action: 'RFQ_QUOTATION_SELECT', entity: 'PurchaseOrder', entityId: po.id });
  res.status(201).json({ item: po });
});

module.exports = router;
