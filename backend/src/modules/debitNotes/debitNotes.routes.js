// Phase 1.13: Supplier Debit Notes - mirrors creditNotes.routes.js exactly
// for the supplier side. Most are created automatically as a side effect of
// a PurchaseReturn (see purchaseReturns.routes.js); this module's own
// POST / is for a standalone supplier credit adjustment with no physical
// return involved. :id/cancel is scoped to standalone debit notes only -
// a return-linked one is cancelled by reversing its PurchaseReturn instead.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { resolveEventTime } = require('../../utils/eventTime');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { SIDES, assertRefundFits } = require('../receivables/arapService');
const { postJournalEntry, reverseJournalEntry, getSystemAccountId, getMoneyAccountId, allocateReceiptNumber, allocateNoteNumber } = require('../accounting/ledger');
const { branchScopeWhere, assertBranchAccess } = require('../../middleware/branchScope');
const { logAudit } = require('../../middleware/audit');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { triggerEvent } = require('../communication/automation');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('DEBIT_NOTE', 'VIEW'), async (req, res) => {
  const { supplierId, status, from, to, search } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (supplierId) where.supplierId = supplierId;
  if (status) where.status = status;
  if (search) where.debitNoteNumber = { contains: search, mode: 'insensitive' };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    prisma.debitNote.findMany({
      where,
      include: { supplier: { select: { name: true } }, purchaseReturn: { select: { returnNumber: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.debitNote.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('DEBIT_NOTE', 'VIEW'), async (req, res) => {
  const item = await prisma.debitNote.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { supplier: true, purchaseReturn: true, refundPayments: true },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

const createSchema = z.object({
  supplierId: z.string().uuid(),
  amount: z.number().positive(),
  tax: z.number().nonnegative().default(0),
  reason: z.string().min(1),
  notes: z.string().optional(),
  branchId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
  // Phase 3.3: when an offline terminal actually issued it (see utils/eventTime.js).
  occurredAt: z.coerce.date().optional(),
});

router.post('/', requirePermission('DEBIT_NOTE', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid debit note data', parsed.error.flatten());
  const { supplierId, amount, tax, reason, notes, idempotencyKey } = parsed.data;
  const eventTime = resolveEventTime(parsed.data.occurredAt);
  const branchId = parsed.data.branchId ?? req.user.branchId ?? null;

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.debitNote, req.user.tenantId, idempotencyKey);
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId: req.user.tenantId } });
  if (!supplier) throw new NotFoundError('Supplier not found');
  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }
  await assertBranchAccess(prisma, req.user, branchId);

  const total = amount + tax;
  const MAX_NUMBER_RETRIES = 8;
  let item;
  for (let attempt = 1; attempt <= MAX_NUMBER_RETRIES; attempt++) {
    try {
      item = await runTransaction();
      break;
    } catch (err) {
      // A duplicate of an operation that already succeeded resolves to that operation (see sales.routes.js).
      if (idempotencyKey) {
        const existing = await findExistingByIdempotencyKey(prisma.debitNote, req.user.tenantId, idempotencyKey);
        if (existing) return res.status(200).json({ item: existing, deduplicated: true });
      }
      const isCollision = err.code === 'P2002' && err.meta?.target?.includes('debitNoteNumber');
      if (!isCollision || attempt === MAX_NUMBER_RETRIES) throw err;
    }
  }

  async function runTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
      const debitNoteNumber = await allocateNoteNumber(tx, req.user.tenantId, 'DN');
      const debitNote = await tx.debitNote.create({
        data: {
          tenantId: req.user.tenantId,
          debitNoteNumber,
          supplierId,
          branchId,
          amount: total,
          tax,
          reason,
          notes,
          idempotencyKey,
          createdAt: eventTime,
          createdById: req.user.id,
        },
      });

      const [payableAccountId, inventoryAccountId, inputTaxAccountId] = await Promise.all([
        getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_PAYABLE'),
        getSystemAccountId(tx, req.user.tenantId, 'INVENTORY'),
        tax > 0 ? getSystemAccountId(tx, req.user.tenantId, 'INPUT_TAX') : null,
      ]);
      const lines = [{ accountId: payableAccountId, debit: total, supplierId }];
      lines.push({ accountId: inventoryAccountId, credit: amount, supplierId });
      if (tax > 0) lines.push({ accountId: inputTaxAccountId, credit: tax, supplierId });

      await postJournalEntry(tx, {
        tenantId: req.user.tenantId,
        branchId,
        date: eventTime,
        sourceType: 'DEBIT_NOTE',
        sourceId: debitNote.id,
        memo: reason,
        postedById: req.user.id,
        lines,
      });

      return debitNote;
    });
  }

  await logAudit({ req, action: 'DEBIT_NOTE_CREATE', entity: 'DebitNote', entityId: item.id, metadata: { supplierId, amount: total }, branchId: item.branchId });

  // Only the standalone creation path here fires this event - mirrors
  // creditNotes.routes.js's identical reasoning: a debit note auto-issued
  // alongside a PurchaseReturn is already covered by that return's own
  // RETURN_CREATED event.
  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'DEBIT_NOTE_CREATED',
    sourceId: item.id,
    entityType: 'DebitNote',
    branchId: item.branchId,
    variables: { debitNoteNumber: item.debitNoteNumber, amount: total },
    internalTitle: `Debit note issued: ${item.debitNoteNumber}`,
    internalBody: `A standalone debit note of ${Number(total).toFixed(2)} was issued.`,
  });

  res.status(201).json({ item });
});

router.post('/:id/cancel', requirePermission('DEBIT_NOTE', 'REVERSE'), async (req, res) => {
  const item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.debitNote.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(prisma, req.user, existing.branchId);
    if (existing.returnedPurchaseId) {
      throw new ValidationError('This debit note was issued when a purchase was returned - collect it from the supplier or apply it to a purchase instead of cancelling it');
    }
    if (existing.purchaseReturnId) {
      throw new ValidationError('This debit note was issued alongside a purchase return - reverse the purchase return instead of cancelling the note directly');
    }
    if (Number(existing.refundedAmount) > 0) {
      throw new ConflictError('Cannot cancel a debit note that has already been partially or fully refunded');
    }
    // Phase 2.2: applied credit is allocated against real documents - reverse that first.
    if (Number(existing.appliedAmount) > 0) {
      throw new ConflictError('Cannot cancel a note that has been applied to documents - reverse the application first');
    }

    const flipped = await tx.debitNote.updateMany({
      where: { id: existing.id, status: 'ISSUED' },
      data: { status: 'CANCELLED' },
    });
    if (flipped.count === 0) throw new ConflictError('Debit note has already been cancelled');

    const originalEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'DEBIT_NOTE', sourceId: existing.id, status: 'POSTED' },
    });
    if (originalEntry) {
      await reverseJournalEntry(tx, {
        tenantId: req.user.tenantId,
        sourceEntryId: originalEntry.id,
        sourceType: 'DEBIT_NOTE_CANCEL',
        sourceId: existing.id,
        memo: `Cancellation of debit note ${existing.debitNoteNumber || existing.id}`,
        postedById: req.user.id,
      });
    }

    return tx.debitNote.findUnique({ where: { id: existing.id } });
  });

  await logAudit({ req, action: 'DEBIT_NOTE_CANCEL', entity: 'DebitNote', entityId: item.id });
  res.json({ item });
});

const refundSchema = z.object({
  amount: z.number().positive(),
  method: z.string().default('cash'),
  idempotencyKey: z.string().optional(),
  occurredAt: z.coerce.date().optional(), // Phase 3.3: when an offline terminal actually paid/received it
});

// A "refund" here means the supplier physically paying the business back
// (direction IN - money entering the business), the mirror image of a
// customer credit-note refund.
router.post('/:id/refund', requirePermission('DEBIT_NOTE', 'REFUND'), async (req, res) => {
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid refund data', parsed.error.flatten());

  if (parsed.data.idempotencyKey) {
    const existingPayment = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, parsed.data.idempotencyKey);
    if (existingPayment) {
      const current = await prisma.debitNote.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
      if (!current) throw new NotFoundError();
      return res.json({ item: current, deduplicated: true });
    }
  }

  const eventTime = resolveEventTime(parsed.data.occurredAt);
  let item;
  try {
  item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.debitNote.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(prisma, req.user, existing.branchId);
    if (existing.status !== 'ISSUED') throw new ConflictError('Only an issued debit note can be refunded');

    // Phase 2.2: the guard below only sees refundedAmount; the credit still
    // available is amount - refunded - APPLIED, checked under a row lock so a
    // concurrent application and refund cannot together over-consume the note.
    await assertRefundFits(tx, SIDES.AP, existing.id, parsed.data.amount);
    const maxPriorRefunded = Number(existing.amount) - parsed.data.amount;
    const claim = await tx.debitNote.updateMany({
      where: { id: existing.id, refundedAmount: { lte: maxPriorRefunded + 0.0001 } },
      data: { refundedAmount: { increment: parsed.data.amount } },
    });
    if (claim.count === 0) throw new ValidationError('Refund would exceed the debit note amount', undefined, 'BALANCE_CHANGED');

    const receiptNumber = await allocateReceiptNumber(tx, req.user.tenantId);
    await tx.payment.create({
      data: {
        tenantId: req.user.tenantId,
        direction: 'IN',
        amount: parsed.data.amount,
        method: parsed.data.method,
        supplierId: existing.supplierId,
        debitNoteId: existing.id,
        branchId: existing.branchId,
        receiptNumber,
        idempotencyKey: parsed.data.idempotencyKey,
        paidAt: eventTime,
      },
    });

    const [payableAccountId, cashBankAccountId] = await Promise.all([
      getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_PAYABLE'),
      getMoneyAccountId(tx, req.user.tenantId, parsed.data.method),
    ]);
    await postJournalEntry(tx, {
      tenantId: req.user.tenantId,
      branchId: existing.branchId,
      date: eventTime,
      sourceType: 'DEBIT_NOTE_REFUND',
      sourceId: existing.id,
      memo: `Refund received against debit note ${existing.debitNoteNumber || existing.id}`,
      postedById: req.user.id,
      lines: [
        { accountId: cashBankAccountId, debit: parsed.data.amount, supplierId: existing.supplierId },
        { accountId: payableAccountId, credit: parsed.data.amount, supplierId: existing.supplierId },
      ],
    });

    return tx.debitNote.findUnique({ where: { id: existing.id } });
  });
  } catch (err) {
    // A duplicate of a refund that already succeeded resolves to that refund, whatever else went wrong for it.
    if (parsed.data.idempotencyKey) {
      const done = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, parsed.data.idempotencyKey);
      if (done) {
        const current = await prisma.debitNote.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
        if (current) return res.json({ item: current, deduplicated: true });
      }
    }
    throw err;
  }

  await logAudit({ req, action: 'DEBIT_NOTE_REFUND', entity: 'DebitNote', entityId: item.id, metadata: { amount: parsed.data.amount } });
  res.json({ item });
});

module.exports = router;
