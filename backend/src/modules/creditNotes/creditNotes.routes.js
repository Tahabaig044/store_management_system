// Phase 1.13: Customer Credit Notes. Most are created automatically as a
// side effect of a SalesReturn (see salesReturns.routes.js) - this module's
// own POST / is for the standalone case (Section 4's "price/amount
// adjustment" or "other legitimate customer credit adjustment", with no
// physical return involved), which posts its own journal entry since there
// is no return entry to combine with. :id/cancel is deliberately scoped to
// standalone credit notes only - a return-linked one is cancelled by
// reversing its SalesReturn instead (mirrors POST /payments/:id/reverse's
// identical Phase 1.11 scoping precedent).
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

router.get('/', requirePermission('CREDIT_NOTE', 'VIEW'), async (req, res) => {
  const { customerId, status, from, to, search } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (customerId) where.customerId = customerId;
  if (status) where.status = status;
  if (search) where.creditNoteNumber = { contains: search, mode: 'insensitive' };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    prisma.creditNote.findMany({
      where,
      include: { customer: { select: { name: true } }, salesReturn: { select: { returnNumber: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.creditNote.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('CREDIT_NOTE', 'VIEW'), async (req, res) => {
  const item = await prisma.creditNote.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { customer: true, salesReturn: true, refundPayments: true },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

const createSchema = z.object({
  customerId: z.string().uuid(),
  amount: z.number().positive(),
  tax: z.number().nonnegative().default(0),
  reason: z.string().min(1),
  notes: z.string().optional(),
  branchId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
  // Phase 3.3: when an offline terminal actually issued it (see utils/eventTime.js).
  occurredAt: z.coerce.date().optional(),
});

router.post('/', requirePermission('CREDIT_NOTE', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid credit note data', parsed.error.flatten());
  const { customerId, amount, tax, reason, notes, idempotencyKey } = parsed.data;
  const eventTime = resolveEventTime(parsed.data.occurredAt);
  const branchId = parsed.data.branchId ?? req.user.branchId ?? null;

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.creditNote, req.user.tenantId, idempotencyKey);
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: req.user.tenantId } });
  if (!customer) throw new NotFoundError('Customer not found');
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
        const existing = await findExistingByIdempotencyKey(prisma.creditNote, req.user.tenantId, idempotencyKey);
        if (existing) return res.status(200).json({ item: existing, deduplicated: true });
      }
      const isCollision = err.code === 'P2002' && err.meta?.target?.includes('creditNoteNumber');
      if (!isCollision || attempt === MAX_NUMBER_RETRIES) throw err;
    }
  }

  async function runTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
      const creditNoteNumber = await allocateNoteNumber(tx, req.user.tenantId, 'CN');
      const creditNote = await tx.creditNote.create({
        data: {
          tenantId: req.user.tenantId,
          creditNoteNumber,
          customerId,
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

      const [revenueAccountId, taxPayableAccountId, receivableAccountId] = await Promise.all([
        getSystemAccountId(tx, req.user.tenantId, 'SALES_REVENUE'),
        tax > 0 ? getSystemAccountId(tx, req.user.tenantId, 'TAX_PAYABLE') : null,
        getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_RECEIVABLE'),
      ]);
      const lines = [{ accountId: revenueAccountId, debit: amount, customerId }];
      if (tax > 0) lines.push({ accountId: taxPayableAccountId, debit: tax, customerId });
      lines.push({ accountId: receivableAccountId, credit: total, customerId });

      await postJournalEntry(tx, {
        tenantId: req.user.tenantId,
        branchId,
        date: eventTime,
        sourceType: 'CREDIT_NOTE',
        sourceId: creditNote.id,
        memo: reason,
        postedById: req.user.id,
        lines,
      });

      return creditNote;
    });
  }

  await logAudit({ req, action: 'CREDIT_NOTE_CREATE', entity: 'CreditNote', entityId: item.id, metadata: { customerId, amount: total }, branchId: item.branchId });

  // Only the standalone creation path here fires this event - a credit
  // note auto-issued alongside a SalesReturn (salesReturns.routes.js) is
  // already covered by that return's own RETURN_CREATED event, so firing a
  // second, separate notification for the same underlying action would be
  // redundant noise for the same staff audience.
  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'CREDIT_NOTE_CREATED',
    sourceId: item.id,
    entityType: 'CreditNote',
    branchId: item.branchId,
    variables: { creditNoteNumber: item.creditNoteNumber, amount: total },
    internalTitle: `Credit note issued: ${item.creditNoteNumber}`,
    internalBody: `A standalone credit note of ${Number(total).toFixed(2)} was issued.`,
  });

  res.status(201).json({ item });
});

router.post('/:id/cancel', requirePermission('CREDIT_NOTE', 'REVERSE'), async (req, res) => {
  const item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.creditNote.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(prisma, req.user, existing.branchId);
    if (existing.reversedSaleId) {
      throw new ValidationError('This credit note was issued when a sale was reversed - refund it or apply it to an invoice instead of cancelling it');
    }
    if (existing.salesReturnId) {
      throw new ValidationError('This credit note was issued alongside a sales return - reverse the sales return instead of cancelling the note directly');
    }
    if (Number(existing.refundedAmount) > 0) {
      throw new ConflictError('Cannot cancel a credit note that has already been partially or fully refunded');
    }
    // Phase 2.2: applied credit is allocated against real documents - reverse that first.
    if (Number(existing.appliedAmount) > 0) {
      throw new ConflictError('Cannot cancel a note that has been applied to documents - reverse the application first');
    }

    const flipped = await tx.creditNote.updateMany({
      where: { id: existing.id, status: 'ISSUED' },
      data: { status: 'CANCELLED' },
    });
    if (flipped.count === 0) throw new ConflictError('Credit note has already been cancelled');

    const originalEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'CREDIT_NOTE', sourceId: existing.id, status: 'POSTED' },
    });
    if (originalEntry) {
      await reverseJournalEntry(tx, {
        tenantId: req.user.tenantId,
        sourceEntryId: originalEntry.id,
        sourceType: 'CREDIT_NOTE_CANCEL',
        sourceId: existing.id,
        memo: `Cancellation of credit note ${existing.creditNoteNumber || existing.id}`,
        postedById: req.user.id,
      });
    }

    return tx.creditNote.findUnique({ where: { id: existing.id } });
  });

  await logAudit({ req, action: 'CREDIT_NOTE_CANCEL', entity: 'CreditNote', entityId: item.id });
  res.json({ item });
});

const refundSchema = z.object({
  amount: z.number().positive(),
  method: z.string().default('cash'),
  idempotencyKey: z.string().optional(),
  occurredAt: z.coerce.date().optional(), // Phase 3.3: when an offline terminal actually paid/received it
});

router.post('/:id/refund', requirePermission('CREDIT_NOTE', 'REFUND'), async (req, res) => {
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid refund data', parsed.error.flatten());

  if (parsed.data.idempotencyKey) {
    const existingPayment = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, parsed.data.idempotencyKey);
    if (existingPayment) {
      const current = await prisma.creditNote.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
      if (!current) throw new NotFoundError();
      return res.json({ item: current, deduplicated: true });
    }
  }

  const eventTime = resolveEventTime(parsed.data.occurredAt);
  let item;
  try {
  item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.creditNote.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(prisma, req.user, existing.branchId);
    if (existing.status !== 'ISSUED') throw new ConflictError('Only an issued credit note can be refunded');

    // Atomic conditional accumulation - two concurrent refund requests could
    // otherwise both read the same stale refundedAmount and each compute a
    // value that individually looks valid, together exceeding the credit
    // note's amount (the same class of race fixed for Sale/Purchase/Payment
    // amountPaid accumulation).
    // Phase 2.2: the guard below only sees refundedAmount; the credit still
    // available is amount - refunded - APPLIED, checked under a row lock so a
    // concurrent application and refund cannot together over-consume the note.
    await assertRefundFits(tx, SIDES.AR, existing.id, parsed.data.amount);
    const maxPriorRefunded = Number(existing.amount) - parsed.data.amount;
    const claim = await tx.creditNote.updateMany({
      where: { id: existing.id, refundedAmount: { lte: maxPriorRefunded + 0.0001 } },
      data: { refundedAmount: { increment: parsed.data.amount } },
    });
    if (claim.count === 0) throw new ValidationError('Refund would exceed the credit note amount', undefined, 'BALANCE_CHANGED');

    const receiptNumber = await allocateReceiptNumber(tx, req.user.tenantId);
    await tx.payment.create({
      data: {
        tenantId: req.user.tenantId,
        direction: 'OUT',
        amount: parsed.data.amount,
        method: parsed.data.method,
        customerId: existing.customerId,
        creditNoteId: existing.id,
        branchId: existing.branchId,
        receiptNumber,
        idempotencyKey: parsed.data.idempotencyKey,
        paidAt: eventTime,
      },
    });

    const [receivableAccountId, cashBankAccountId] = await Promise.all([
      getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_RECEIVABLE'),
      getMoneyAccountId(tx, req.user.tenantId, parsed.data.method),
    ]);
    await postJournalEntry(tx, {
      tenantId: req.user.tenantId,
      branchId: existing.branchId,
      date: eventTime,
      sourceType: 'CREDIT_NOTE_REFUND',
      sourceId: existing.id,
      memo: `Refund against credit note ${existing.creditNoteNumber || existing.id}`,
      postedById: req.user.id,
      lines: [
        { accountId: receivableAccountId, debit: parsed.data.amount, customerId: existing.customerId },
        { accountId: cashBankAccountId, credit: parsed.data.amount, customerId: existing.customerId },
      ],
    });

    return tx.creditNote.findUnique({ where: { id: existing.id } });
  });
  } catch (err) {
    // A duplicate of a refund that already succeeded resolves to that refund, whatever else went wrong for it.
    if (parsed.data.idempotencyKey) {
      const done = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, parsed.data.idempotencyKey);
      if (done) {
        const current = await prisma.creditNote.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
        if (current) return res.json({ item: current, deduplicated: true });
      }
    }
    throw err;
  }

  await logAudit({ req, action: 'CREDIT_NOTE_REFUND', entity: 'CreditNote', entityId: item.id, metadata: { amount: parsed.data.amount } });
  res.json({ item });
});

module.exports = router;
