const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { FRONT_DESK } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { requireModule } = require('../../middleware/moduleAccess');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { postJournalEntry, reverseJournalEntry, getSystemAccountId, getMoneyAccountId, allocateNoteNumber } = require('../accounting/ledger');
const { logAudit } = require('../../middleware/audit');
const { triggerEvent } = require('../communication/automation');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');

// Phase 5.1: an order with product-linked items (real frame/lens stock, see
// OpticalOrderItem) posts revenue AND the COGS/Inventory leg, exactly like a
// Sale. An order with none (the pre-Phase-5.1 free-text-only path, or a
// service-only visit) posts only revenue/receivable, as before - completely
// unaffected.
async function postOpticalOrderRevenue(tx, { tenantId, order, paymentMethod, postedById, cogs = 0 }) {
  const total = Number(order.totalAmount);
  const amountPaid = Number(order.amountPaid);
  const receivable = total - amountPaid;

  const [cashBankAccountId, receivableAccountId, revenueAccountId, cogsAccountId, inventoryAccountId] = await Promise.all([
    amountPaid > 0 ? getMoneyAccountId(tx, tenantId, paymentMethod) : null,
    receivable > 0 ? getSystemAccountId(tx, tenantId, 'ACCOUNTS_RECEIVABLE') : null,
    total > 0 ? getSystemAccountId(tx, tenantId, 'OPTICAL_REVENUE') : null,
    cogs > 0 ? getSystemAccountId(tx, tenantId, 'COGS') : null,
    cogs > 0 ? getSystemAccountId(tx, tenantId, 'INVENTORY') : null,
  ]);

  const lines = [];
  if (amountPaid > 0) lines.push({ accountId: cashBankAccountId, debit: amountPaid, customerId: order.customerId });
  if (receivable > 0) lines.push({ accountId: receivableAccountId, debit: receivable, customerId: order.customerId });
  if (total > 0) lines.push({ accountId: revenueAccountId, credit: total, customerId: order.customerId });
  if (cogs > 0) {
    lines.push({ accountId: cogsAccountId, debit: cogs });
    lines.push({ accountId: inventoryAccountId, credit: cogs });
  }

  if (lines.length >= 2) {
    await postJournalEntry(tx, {
      tenantId,
      date: order.createdAt || new Date(),
      sourceType: 'OPTICAL_ORDER',
      sourceId: order.id,
      memo: `Optical order ${order.orderNumber}`,
      postedById,
      lines,
    });
  }
}

const STATUS_VALUES = ['PENDING', 'IN_LAB', 'QUALITY_CHECK', 'READY', 'DELIVERED', 'CANCELLED'];

const eyeSchema = z.object({
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().optional(),
  add: z.number().optional(),
});

const prescriptionSchema = z.object({
  od: eyeSchema.optional(),
  os: eyeSchema.optional(),
  pd: z.number().optional(),
  prescribedBy: z.string().optional(),
  prescribedAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});

// Phase 5.1: an optional frame/lens actually taken from tracked inventory (a
// FRAME/LENS-type Product, or any product a shop chooses) - additive to the
// pre-existing free-text frameDescription/lensDescription, never required.
const itemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().positive().default(1),
  unitPrice: z.number().nonnegative(),
});

const createSchema = z.object({
  customerId: z.string().uuid(),
  // Phase 7: optional clinical linkage - additive, so every pre-Phase-7
  // caller (and every plain retail optical order with no clinical context)
  // is completely unaffected.
  patientId: z.string().uuid().optional(),
  clinicalPrescriptionId: z.string().uuid().optional(),
  labId: z.string().uuid().optional(),
  labCost: z.number().nonnegative().optional(),
  // Phase 5.1: optional branch/warehouse attribution - validated via the
  // existing assertBranchAccess/assertWarehouseAccess, mirroring Sale's
  // identical pattern exactly.
  branchId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  frameDescription: z.string().optional(),
  lensDescription: z.string().optional(),
  items: z.array(itemSchema).optional(),
  totalAmount: z.number().nonnegative().default(0),
  amountPaid: z.number().nonnegative().default(0),
  paymentMethod: z.string().default('cash'),
  expectedDeliveryDate: z.coerce.date().optional(),
  notes: z.string().optional(),
  prescription: prescriptionSchema.optional(),
  idempotencyKey: z.string().optional(),
});

// amountPaid is intentionally excluded here - it can only change via POST
// /:id/pay, which also records the corresponding Payment ledger entry. items
// is excluded too: once stock has been deducted and COGS posted, quantities
// and pricing are locked - the same "cancel and re-create" design already
// used for a Purchase Order's own locked items (procurement/purchaseOrders.routes.js).
const updateSchema = createSchema
  .omit({ amountPaid: true, idempotencyKey: true, items: true })
  .partial()
  .extend({
    status: z.enum(STATUS_VALUES).optional(),
    qcPassed: z.boolean().optional(),
    qcNotes: z.string().optional(),
    fittingNotes: z.string().optional(),
  });

function toPrescriptionData(p) {
  if (!p) return undefined;
  return {
    odSphere: p.od?.sphere,
    odCylinder: p.od?.cylinder,
    odAxis: p.od?.axis,
    odAdd: p.od?.add,
    osSphere: p.os?.sphere,
    osCylinder: p.os?.cylinder,
    osAxis: p.os?.axis,
    osAdd: p.os?.add,
    pd: p.pd,
    prescribedBy: p.prescribedBy,
    prescribedAt: p.prescribedAt,
    notes: p.notes,
  };
}

const router = express.Router();
router.use(authenticate, requireTenant, requireModule('OPTICAL'));

router.get('/', requirePermission('OPTICAL_ORDER', 'VIEW'), async (req, res) => {
  const { search, status } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (status) where.status = status;
  if (search) where.orderNumber = { contains: search, mode: 'insensitive' };

  const [items, total] = await Promise.all([
    prisma.opticalOrder.findMany({
      where,
      include: { customer: true, prescription: true, items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.opticalOrder.count({ where }),
  ]);

  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('OPTICAL_ORDER', 'VIEW'), async (req, res) => {
  const item = await prisma.opticalOrder.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { customer: true, prescription: true, payments: true, items: { include: { product: true } } },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

router.post('/', requirePermission('OPTICAL_ORDER', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid optical order data', parsed.error.flatten());
  const { prescription, paymentMethod, items, ...data } = parsed.data;
  if (data.amountPaid > data.totalAmount) {
    throw new ValidationError('Amount paid cannot exceed the order total');
  }

  const customer = await prisma.customer.findFirst({ where: { id: data.customerId, tenantId: req.user.tenantId } });
  if (!customer) throw new NotFoundError('Customer not found');
  if (data.patientId) {
    const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId: req.user.tenantId } });
    if (!patient) throw new NotFoundError('Patient not found');
  }
  if (data.labId) {
    const lab = await prisma.lab.findFirst({ where: { id: data.labId, tenantId: req.user.tenantId } });
    if (!lab) throw new NotFoundError('Lab not found');
  }
  if (data.branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: data.branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
    await assertBranchAccess(prisma, req.user, data.branchId);
  }
  if (data.warehouseId) {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: data.warehouseId, tenantId: req.user.tenantId } });
    if (!warehouse) throw new NotFoundError('Warehouse not found');
  }
  await assertWarehouseAccess(prisma, req.user, data.warehouseId);
  if (items?.length) {
    for (const line of items) {
      const product = await prisma.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
      if (!product) throw new NotFoundError(`Product ${line.productId} not found`);
    }
  }

  // Clinical-to-commercial integration: a ClinicalPrescription can initiate
  // this order without re-typing OD/OS/PD values - they're only used as a
  // default, so an explicitly-provided `prescription` in the request always
  // wins (e.g. the receptionist adjusted something at order time).
  let effectivePrescription = prescription;
  let clinicalRx = null;
  if (data.clinicalPrescriptionId) {
    clinicalRx = await prisma.clinicalPrescription.findFirst({
      where: { id: data.clinicalPrescriptionId, tenantId: req.user.tenantId },
      include: { doctor: true },
    });
    if (!clinicalRx) throw new NotFoundError('Prescription not found');
    if (data.patientId && clinicalRx.patientId !== data.patientId) {
      throw new ValidationError('This prescription does not belong to the specified patient');
    }
    if (!effectivePrescription) {
      effectivePrescription = {
        od: { sphere: clinicalRx.odSphere ?? undefined, cylinder: clinicalRx.odCylinder ?? undefined, axis: clinicalRx.odAxis ?? undefined, add: clinicalRx.odAdd ?? undefined },
        os: { sphere: clinicalRx.osSphere ?? undefined, cylinder: clinicalRx.osCylinder ?? undefined, axis: clinicalRx.osAxis ?? undefined, add: clinicalRx.osAdd ?? undefined },
        pd: clinicalRx.pd ?? undefined,
        prescribedBy: clinicalRx.doctor?.name,
        prescribedAt: clinicalRx.issueDate,
        notes: clinicalRx.notes ?? undefined,
      };
    }
  }

  if (data.idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.opticalOrder, req.user.tenantId, data.idempotencyKey, {
      customer: true,
      prescription: true,
      items: true,
    });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const item = await runFinancialTransaction(prisma, async (tx) => {
    const orderNumber = await nextSequenceNumber(tx.opticalOrder, req.user.tenantId, 'OO', { tx });
    const created = await tx.opticalOrder.create({
      data: {
        ...data,
        tenantId: req.user.tenantId,
        orderNumber,
        prescription: effectivePrescription ? { create: toPrescriptionData(effectivePrescription) } : undefined,
        items: items?.length
          ? { create: items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.quantity * i.unitPrice })) }
          : undefined,
      },
      include: { customer: true, prescription: true, items: true },
    });

    // Phase 5.1: deduct stock for each linked frame/lens, exactly like Sale's own
    // atomic-conditional deduction (sales.routes.js) - a SERVICE-kind product never
    // holds stock and is skipped, and a concurrent order for the same last unit can
    // never both succeed (the loser sees STOCK_INSUFFICIENT and the whole order,
    // including the row just created above, rolls back).
    let cogs = 0;
    for (const line of created.items) {
      const product = await tx.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
      if (product.productKind === 'SERVICE') continue;
      cogs += Number(line.quantity) * Number(product.purchasePrice);

      const result = await tx.product.updateMany({
        where: { id: product.id, stockQuantity: { gte: line.quantity } },
        data: { stockQuantity: { decrement: line.quantity } },
      });
      if (result.count === 0) {
        throw new ConflictError(`Insufficient stock for ${product.name} (available: ${product.stockQuantity})`, 'STOCK_INSUFFICIENT', { productId: product.id, name: product.name, available: Number(product.stockQuantity), requested: Number(line.quantity) });
      }
      const updated = await tx.product.findUnique({ where: { id: product.id }, select: { stockQuantity: true } });
      await tx.inventoryTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          productId: product.id,
          type: 'SALE_DEDUCTION',
          quantity: -Number(line.quantity),
          balanceAfter: Number(updated.stockQuantity),
          reference: created.id,
          createdById: req.user.id,
        },
      });
    }

    if (data.amountPaid > 0) {
      await tx.payment.create({
        data: {
          tenantId: req.user.tenantId,
          direction: 'IN',
          amount: data.amountPaid,
          method: paymentMethod,
          opticalOrderId: created.id,
          customerId: created.customerId,
        },
      });
    }

    await postOpticalOrderRevenue(tx, {
      tenantId: req.user.tenantId,
      order: created,
      paymentMethod,
      postedById: req.user.id,
      cogs,
    });

    return created;
  });

  await logAudit({ req, action: 'OPTICAL_ORDER_CREATE', entity: 'OpticalOrder', entityId: item.id, metadata: { patientId: item.patientId, clinicalPrescriptionId: item.clinicalPrescriptionId } });

  if (item.customer?.phone) {
    await triggerEvent(prisma, {
      tenantId: req.user.tenantId,
      event: 'OPTICAL_ORDER_CREATED',
      sourceId: item.id,
      customer: item.customer,
      variables: { customerName: item.customer.name, orderNumber: item.orderNumber, total: Number(item.totalAmount).toFixed(2) },
    });
  }

  res.status(201).json({ item });
});

// Record an additional payment against an existing order (e.g. balance paid on
// delivery) - deposits and later payments both need to be visible in the
// Payments ledger, not just tracked as a running total on the order itself.
router.post('/:id/pay', requireRole(...FRONT_DESK), async (req, res) => {
  const schema = z.object({
    amount: z.number().positive(),
    method: z.string().default('cash'),
    note: z.string().optional(),
    idempotencyKey: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid payment data', parsed.error.flatten());

  // Phase 7.1: a retried payment submission (flaky connection, offline outbox
  // retry) is recognized as the same operation instead of double-recording it -
  // mirrors Sale's/Purchase's own identical :id/pay dedup pattern exactly.
  if (parsed.data.idempotencyKey) {
    const existingPayment = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, parsed.data.idempotencyKey);
    if (existingPayment) {
      const current = await prisma.opticalOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { customer: true, prescription: true } });
      if (!current) throw new NotFoundError();
      return res.json({ item: current, deduplicated: true });
    }
  }

  const item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.opticalOrder.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
    });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(tx, req.user, existing.branchId);

    // Phase 7.1 concurrency fix: two concurrent payments on the same order
    // could otherwise both read the same stale amountPaid and each compute a
    // newPaid that individually looks valid, together exceeding the total -
    // the identical race already fixed for Sale's/Purchase's own :id/pay. The
    // guard's `lte` threshold, and the CANCELLED exclusion, are both
    // re-evaluated against the latest-committed row when this UPDATE actually
    // runs, not against the stale `existing` read above.
    const maxPriorPaid = Number(existing.totalAmount) - parsed.data.amount;
    const claim = await tx.opticalOrder.updateMany({
      where: { id: existing.id, status: { not: 'CANCELLED' }, amountPaid: { lte: maxPriorPaid + 0.0001 } },
      data: { amountPaid: { increment: parsed.data.amount } },
    });
    if (claim.count === 0) {
      const current = await tx.opticalOrder.findUnique({ where: { id: existing.id }, select: { status: true } });
      if (current.status === 'CANCELLED') throw new ConflictError('This order has been cancelled and cannot receive a payment', 'DOCUMENT_NOT_OPEN');
      throw new ValidationError('Payment would exceed the order total', undefined, 'BALANCE_CHANGED');
    }

    await tx.payment.create({
      data: {
        tenantId: req.user.tenantId,
        direction: 'IN',
        amount: parsed.data.amount,
        method: parsed.data.method,
        note: parsed.data.note,
        opticalOrderId: existing.id,
        customerId: existing.customerId,
        branchId: existing.branchId,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });

    const [cashBankAccountId, receivableAccountId] = await Promise.all([
      getMoneyAccountId(tx, req.user.tenantId, parsed.data.method),
      getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_RECEIVABLE'),
    ]);
    await postJournalEntry(tx, {
      tenantId: req.user.tenantId,
      branchId: existing.branchId,
      sourceType: 'PAYMENT',
      sourceId: existing.id,
      memo: `Payment on optical order ${existing.orderNumber}`,
      postedById: req.user.id,
      lines: [
        { accountId: cashBankAccountId, debit: parsed.data.amount, customerId: existing.customerId },
        { accountId: receivableAccountId, credit: parsed.data.amount, customerId: existing.customerId },
      ],
    });

    return tx.opticalOrder.findUnique({ where: { id: existing.id }, include: { customer: true, prescription: true } });
  });

  await logAudit({ req, action: 'OPTICAL_ORDER_PAYMENT_RECORD', entity: 'OpticalOrder', entityId: item.id, metadata: { amount: parsed.data.amount, method: parsed.data.method } });
  res.json({ item });
});

router.patch('/:id', requirePermission('OPTICAL_ORDER', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid optical order data', parsed.error.flatten());
  const { prescription, ...data } = parsed.data;

  const existing = await prisma.opticalOrder.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { items: true },
  });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);
  if (data.labId) {
    const lab = await prisma.lab.findFirst({ where: { id: data.labId, tenantId: req.user.tenantId } });
    if (!lab) throw new NotFoundError('Lab not found');
  }
  // A delivered or cancelled order is a closed record - matches the same
  // "terminal state, no further edits" rule already used for a cancelled
  // Purchase Order/Request elsewhere in procurement.
  if (['DELIVERED', 'CANCELLED'].includes(existing.status)) {
    throw new ConflictError(`This order is ${existing.status.toLowerCase()} and can no longer be edited`);
  }

  if (data.status === 'DELIVERED' && !data.deliveredAt) data.deliveredAt = new Date();
  if (data.qcPassed !== undefined && !data.qcAt) data.qcAt = new Date();

  const item = await runFinancialTransaction(prisma, async (tx) => {
    if (prescription) {
      await tx.prescription.upsert({
        where: { opticalOrderId: existing.id },
        create: { opticalOrderId: existing.id, ...toPrescriptionData(prescription) },
        update: toPrescriptionData(prescription),
      });
    }
    // Phase 5.1 concurrency fix: two staff updating the same order at once (e.g. one
    // moving PENDING -> IN_LAB, another PENDING -> CANCELLED) must not silently let
    // the second overwrite the first's intent. The atomic conditional claim below -
    // the same pattern already used for PR/PO/RFQ status transitions - makes only
    // the first request's read-status still hold; the loser gets a clean conflict
    // instead of clobbering a status another user just set.
    // A request with nothing left to set (e.g. only amountPaid was sent, which is
    // stripped - see updateSchema above) has no race to guard: Prisma's updateMany
    // returns count 0 for an empty `data` without touching the row at all, which
    // would otherwise be misread as "someone else changed it first".
    if (Object.keys(data).length > 0) {
      const claimed = await tx.opticalOrder.updateMany({ where: { id: existing.id, status: existing.status }, data });
      if (claimed.count === 0) {
        throw new ConflictError('This order was just updated by someone else - reload and try again', 'BALANCE_CHANGED');
      }
    }

    // Phase 7.1: cancellation must reverse whatever this order actually posted -
    // the atomic claim just above guarantees this branch runs at most once per
    // order (a second cancel attempt hits the terminal-state guard before the
    // transaction even opens), and reverseJournalEntry below has its own
    // independent atomic claim on the journal entry as a second layer of
    // protection against a duplicate reversal.
    if (data.status === 'CANCELLED') {
      for (const line of existing.items) {
        const product = await tx.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
        // A SERVICE-kind line was never stock-deducted at order time - it must never be "restored" either.
        if (!product || product.productKind === 'SERVICE') continue;
        await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { increment: Number(line.quantity) } } });
        const updated = await tx.product.findUnique({ where: { id: product.id }, select: { stockQuantity: true } });
        await tx.inventoryTransaction.create({
          data: {
            tenantId: req.user.tenantId,
            productId: product.id,
            type: 'SALE_REVERSAL',
            quantity: Number(line.quantity),
            balanceAfter: Number(updated.stockQuantity),
            reference: existing.id,
            createdById: req.user.id,
          },
        });
      }

      const originalEntry = await tx.journalEntry.findFirst({
        where: { tenantId: req.user.tenantId, sourceType: 'OPTICAL_ORDER', sourceId: existing.id, status: 'POSTED' },
      });
      if (originalEntry) {
        // Money already collected is not silently handed back - it is booked to the
        // customer's receivable instead (a credit they can be refunded or apply to
        // another invoice later), exactly mirroring Sale's own reversal design.
        const collected = Number(existing.amountPaid);
        const holdsCredit = collected > 0;
        let settleTo;
        if (holdsCredit) {
          const [receivableId, cashId, bankId] = await Promise.all([
            getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_RECEIVABLE'),
            getSystemAccountId(tx, req.user.tenantId, 'CASH'),
            getSystemAccountId(tx, req.user.tenantId, 'BANK'),
          ]);
          settleTo = { accountId: receivableId, partyField: 'customerId', partyId: existing.customerId, moneyAccountIds: [cashId, bankId] };
        }
        // sourceType is intentionally omitted - it defaults to the original
        // entry's own type (OPTICAL_ORDER); the enum has no separate
        // "_REVERSAL" variant for this source the way SALE/EXPENSE do, and
        // adding one isn't needed since reversalOfId already makes a
        // reversing entry unambiguously identifiable.
        await reverseJournalEntry(tx, {
          tenantId: req.user.tenantId,
          branchId: existing.branchId,
          sourceEntryId: originalEntry.id,
          sourceId: existing.id,
          memo: `Reversal of optical order ${existing.orderNumber}`,
          postedById: req.user.id,
          settleTo,
        });
        if (holdsCredit) {
          await tx.creditNote.create({
            data: {
              tenantId: req.user.tenantId,
              creditNoteNumber: await allocateNoteNumber(tx, req.user.tenantId, 'CN'),
              customerId: existing.customerId,
              branchId: existing.branchId,
              amount: collected,
              tax: 0,
              reason: `Cancellation of optical order ${existing.orderNumber}`,
              reversedOpticalOrderId: existing.id,
              createdById: req.user.id,
            },
          });
        }
      }
    }

    return tx.opticalOrder.findFirst({ where: { id: existing.id }, include: { customer: true, prescription: true, items: { include: { product: true } } } });
  });

  await logAudit({ req, action: 'OPTICAL_ORDER_UPDATE', entity: 'OpticalOrder', entityId: item.id, metadata: { from: existing.status, to: data.status } });

  const statusChanged = data.status && data.status !== existing.status;
  if (statusChanged && item.customer?.phone) {
    const event = data.status === 'READY' ? 'OPTICAL_JOB_READY' : data.status === 'DELIVERED' ? 'OPTICAL_ORDER_DELIVERED' : null;
    if (event) {
      await triggerEvent(prisma, {
        tenantId: req.user.tenantId,
        event,
        sourceId: item.id,
        customer: item.customer,
        variables: { customerName: item.customer.name, orderNumber: item.orderNumber },
      });
    }
  }

  res.json({ item });
});

module.exports = router;
