const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { resolveEventTime } = require('../../utils/eventTime');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { getAccessibleBranchIds, assertBranchAccess } = require('../../middleware/branchScope');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { postJournalEntry, reverseJournalEntry, getSystemAccountId, getMoneyAccountId, allocateReceiptNumber } = require('../accounting/ledger');
const { triggerEvent } = require('../communication/automation');
const { settleDocument, releaseDocument } = require('../receivables/arapService');

const router = express.Router();
router.use(authenticate, requireTenant);

// Read-only aggregate view - most payments are still created as a side
// effect of sales/purchases/expenses (see those modules), unchanged. Phase
// 1.11 adds a genuine, standalone creation path below for a customer/
// supplier payment not necessarily tied to one specific sale/purchase.
router.get('/', requirePermission('PAYMENT', 'VIEW'), async (req, res) => {
  const { direction, from, to, customerId, supplierId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (direction) where.direction = direction;
  if (customerId) where.customerId = customerId;
  if (supplierId) where.supplierId = supplierId;
  if (from || to) {
    where.paidAt = {};
    if (from) where.paidAt.gte = new Date(from);
    if (to) where.paidAt.lte = new Date(to);
  }

  // Payment has no branchId of its own on every row (older rows created
  // before Phase 1.11, or ones with none of the branch-bearing links) -
  // scoped via whichever branch-bearing record it's linked to, or its own
  // new branchId when set directly (a standalone payment with allocations
  // across multiple branches has neither and stays visible tenant-wide).
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  if (accessibleBranchIds !== null) {
    where.OR = [
      { saleId: null, purchaseId: null, expenseId: null, branchId: null },
      { sale: { branchId: { in: accessibleBranchIds } } },
      { purchase: { branchId: { in: accessibleBranchIds } } },
      { expense: { branchId: { in: accessibleBranchIds } } },
      { branchId: { in: accessibleBranchIds } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: { sale: true, purchase: true, customer: true, supplier: true, expense: true, allocations: true },
      orderBy: { paidAt: 'desc' },
      skip,
      take,
    }),
    prisma.payment.count({ where }),
  ]);

  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('PAYMENT', 'VIEW'), async (req, res) => {
  const item = await prisma.payment.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { sale: true, purchase: true, customer: true, supplier: true, expense: true, allocations: { include: { sale: true, purchase: true } } },
  });
  if (!item) throw new NotFoundError();
  // Phase 2.2: a payment attributed to (or linked to a document of) a branch the
  // caller cannot access is not readable by id either, matching the list scope.
  await assertBranchAccess(prisma, req.user, item.branchId);
  await assertBranchAccess(prisma, req.user, item.sale?.branchId);
  await assertBranchAccess(prisma, req.user, item.purchase?.branchId);
  res.json({ item });
});

const allocationSchema = z.object({
  saleId: z.string().uuid().optional(),
  purchaseId: z.string().uuid().optional(),
  amount: z.number().positive(),
});

const createSchema = z.object({
  direction: z.enum(['IN', 'OUT']),
  customerId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  amount: z.number().positive(),
  method: z.string().default('cash'),
  note: z.string().optional(),
  // Explicit split across one or more sales (direction IN) or purchases
  // (direction OUT) - amounts must sum to `amount` exactly.
  allocations: z.array(allocationSchema).optional(),
  // When true and `allocations` is omitted, applies the payment to this
  // customer's/supplier's own open (UNPAID/PARTIAL) sales/purchases,
  // oldest-first, until the amount is exhausted.
  autoAllocate: z.boolean().default(false),
  idempotencyKey: z.string().optional(),
  // Phase 3.2: when an offline terminal actually took the payment (see utils/eventTime.js).
  occurredAt: z.coerce.date().optional(),
});

// Sale/Purchase amountPaid is moved by the shared settle/release primitives in
// receivables/arapService.js (the same atomic-conditional-update guard Sale's and
// Purchase's own :id/pay use, now also used by credit/debit note applications).

router.post('/', requirePermission('PAYMENT', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid payment data', parsed.error.flatten());
  const { direction, amount, method, note, allocations, autoAllocate, idempotencyKey } = parsed.data;
  const { customerId, supplierId } = parsed.data;
  const eventTime = resolveEventTime(parsed.data.occurredAt);

  if (direction === 'IN') {
    if (!customerId) throw new ValidationError('customerId is required for an incoming (customer) payment');
    if (supplierId) throw new ValidationError('supplierId must not be set for an incoming (customer) payment');
  } else {
    if (!supplierId) throw new ValidationError('supplierId is required for an outgoing (supplier) payment');
    if (customerId) throw new ValidationError('customerId must not be set for an outgoing (supplier) payment');
  }
  if (!allocations?.length && !autoAllocate) {
    throw new ValidationError('Provide either explicit allocations or autoAllocate: true');
  }
  if (allocations?.length) {
    const sum = allocations.reduce((s, a) => s + a.amount, 0);
    if (Math.abs(sum - amount) > 0.01) throw new ValidationError('Allocation amounts must sum to the total payment amount');
    const targets = allocations.map((a) => a.saleId || a.purchaseId);
    if (new Set(targets).size !== targets.length) throw new ValidationError('The same document appears more than once in the allocations');
    for (const a of allocations) {
      if (a.saleId && a.purchaseId) throw new ValidationError('An allocation must reference either a saleId or a purchaseId, not both');
      if (direction === 'IN' && !a.saleId) throw new ValidationError('Each allocation must reference a saleId for an incoming payment');
      if (direction === 'OUT' && !a.purchaseId) throw new ValidationError('Each allocation must reference a purchaseId for an outgoing payment');
    }
  }

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, idempotencyKey, { allocations: true });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  if (direction === 'IN') {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: req.user.tenantId } });
    if (!customer) throw new NotFoundError('Customer not found');
  } else {
    const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId: req.user.tenantId } });
    if (!supplier) throw new NotFoundError('Supplier not found');
  }

  // Phase 1.11: audited per the Phase 1.8/1.9 precedent (Sale's
  // invoiceNumber / Purchase's purchaseNumber collision) - the shared
  // nextSequenceNumber utility (Phase 0.6) is not guaranteed gap/collision-
  // free under concurrent creates. Rather than rewrite the shared utility,
  // this mirrors the same local, bounded retry mitigation applied to Sale/
  // Purchase: retry the whole transaction (which re-derives a fresh receipt
  // number from the now-current count) on exactly this collision.
  const MAX_RECEIPT_NUMBER_RETRIES = 8;
  let payment;
  for (let attempt = 1; attempt <= MAX_RECEIPT_NUMBER_RETRIES; attempt++) {
    try {
      payment = await runPaymentTransaction();
      break;
    } catch (err) {
      // Two identical requests racing past the pre-check above: the loser hits the
      // (tenantId, idempotencyKey) unique index - answer it as the duplicate it is.
      if (err.code === 'P2002' && idempotencyKey && err.meta?.target?.includes('idempotencyKey')) {
        const existing = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, idempotencyKey, { allocations: true });
        if (existing) return res.status(200).json({ item: existing, deduplicated: true });
      }
      const isReceiptCollision = err.code === 'P2002' && err.meta?.target?.includes('receiptNumber');
      if (!isReceiptCollision || attempt === MAX_RECEIPT_NUMBER_RETRIES) throw err;
    }
  }

  async function runPaymentTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
      let resolvedAllocations = allocations;

      if (!resolvedAllocations?.length) {
        // autoAllocate: oldest-open-invoice-first, exhausting `amount`.
        const openTargets = direction === 'IN'
          ? await tx.sale.findMany({
              where: { tenantId: req.user.tenantId, customerId, status: 'COMPLETED', paymentStatus: { in: ['UNPAID', 'PARTIAL'] } },
              orderBy: { createdAt: 'asc' },
            })
          : await tx.purchase.findMany({
              where: { tenantId: req.user.tenantId, supplierId, status: { in: ['DRAFT', 'RECEIVED'] }, paymentStatus: { in: ['UNPAID', 'PARTIAL'] } },
              orderBy: { createdAt: 'asc' },
            });
        if (openTargets.length === 0) throw new ValidationError('No outstanding invoices to allocate this payment to');

        let remaining = amount;
        resolvedAllocations = [];
        for (const t of openTargets) {
          if (remaining <= 0.0001) break;
          const outstanding = Number(t.total) - Number(t.amountPaid);
          if (outstanding <= 0.0001) continue;
          const apply = Math.min(remaining, outstanding);
          resolvedAllocations.push(direction === 'IN' ? { saleId: t.id, amount: apply } : { purchaseId: t.id, amount: apply });
          remaining -= apply;
        }
        // Overpayment handling: this codebase has no credit/on-account
        // ledger for a customer/supplier (Sale/Purchase both already reject
        // amountPaid > total the same way), so a payment that exceeds every
        // open invoice combined is rejected outright rather than silently
        // creating an unapplied credit balance that nothing else in the
        // system knows how to represent or later apply.
        if (remaining > 0.0001) throw new ValidationError('Payment amount exceeds total outstanding balance across all open invoices');
      }

      // Fixed lock order (by document id): concurrent payments/applications that
      // touch the same documents can never deadlock on each other.
      resolvedAllocations = [...resolvedAllocations].sort((x, y) => ((x.saleId || x.purchaseId) < (y.saleId || y.purchaseId) ? -1 : 1));

      const journalLines = [];
      let advanceAmount = 0;
      let derivedBranchId = null;
      const oneBranchOnly = new Set();

      for (const a of resolvedAllocations) {
        if (direction === 'IN') {
          const sale = await tx.sale.findFirst({ where: { id: a.saleId, tenantId: req.user.tenantId } });
          if (!sale) throw new NotFoundError('Sale not found');
          if (sale.customerId !== customerId) throw new ValidationError('This sale does not belong to the given customer');
          if (sale.status !== 'COMPLETED') throw new ConflictError('Cannot allocate a payment to a reversed sale', 'DOCUMENT_NOT_OPEN');
          await assertBranchAccess(tx, req.user, sale.branchId);
          await settleDocument(tx.sale, sale, a.amount, 'Payment would exceed the sale total', ['COMPLETED']);
          oneBranchOnly.add(sale.branchId || null);
        } else {
          const purchase = await tx.purchase.findFirst({ where: { id: a.purchaseId, tenantId: req.user.tenantId } });
          if (!purchase) throw new NotFoundError('Purchase not found');
          if (purchase.supplierId !== supplierId) throw new ValidationError('This purchase does not belong to the given supplier');
          if (!['DRAFT', 'RECEIVED'].includes(purchase.status)) throw new ConflictError('Cannot allocate a payment to a cancelled/returned purchase', 'DOCUMENT_NOT_OPEN');
          await assertBranchAccess(tx, req.user, purchase.branchId);
          await settleDocument(tx.purchase, purchase, a.amount, 'Payment would exceed the purchase total', ['DRAFT', 'RECEIVED']);
          // A DRAFT purchase has no Accounts Payable yet: its prepayment belongs in the
          // Advance-to-Suppliers asset (exactly what Purchase's own :id/pay posts), because
          // receiving the purchase later clears that advance against Payable. Debiting
          // Payable here would be cleared a second time at receipt.
          if (purchase.status === 'DRAFT') advanceAmount += a.amount;
          oneBranchOnly.add(purchase.branchId || null);
        }
      }
      // Attribution only when every allocation shares the same branch -
      // ambiguous otherwise, left null rather than arbitrarily picking one.
      if (oneBranchOnly.size === 1) derivedBranchId = [...oneBranchOnly][0];

      const receiptNumber = await allocateReceiptNumber(tx, req.user.tenantId);
      const created = await tx.payment.create({
        data: {
          tenantId: req.user.tenantId,
          direction,
          amount,
          method,
          note,
          customerId: direction === 'IN' ? customerId : null,
          supplierId: direction === 'OUT' ? supplierId : null,
          branchId: derivedBranchId,
          receiptNumber,
          idempotencyKey,
          paidAt: eventTime,
          allocations: {
            create: resolvedAllocations.map((a) => ({
              tenantId: req.user.tenantId,
              saleId: a.saleId || null,
              purchaseId: a.purchaseId || null,
              amount: a.amount,
            })),
          },
        },
        include: { allocations: true },
      });

      // Dr Cash/Bank, Cr Accounts Receivable for a customer payment; the
      // mirror image (Dr Accounts Payable, Cr Cash/Bank) for a supplier
      // payment - same shape as Sale's/Purchase's own :id/pay, posted once
      // for the whole receipt (sourceId is this Payment's own id, not any
      // one sale/purchase, since one receipt can cover several).
      const [cashBankAccountId, otherAccountId] = await Promise.all([
        getMoneyAccountId(tx, req.user.tenantId, method),
        getSystemAccountId(tx, req.user.tenantId, direction === 'IN' ? 'ACCOUNTS_RECEIVABLE' : 'ACCOUNTS_PAYABLE'),
      ]);
      const advanceAccountId = advanceAmount > 0 ? await getSystemAccountId(tx, req.user.tenantId, 'ADVANCE_TO_SUPPLIERS') : null;
      if (direction === 'IN') {
        journalLines.push({ accountId: cashBankAccountId, debit: amount, customerId });
        journalLines.push({ accountId: otherAccountId, credit: amount, customerId });
      } else {
        const payableAmount = Math.round((amount - advanceAmount) * 100) / 100;
        if (payableAmount > 0) journalLines.push({ accountId: otherAccountId, debit: payableAmount, supplierId });
        if (advanceAmount > 0) journalLines.push({ accountId: advanceAccountId, debit: advanceAmount, supplierId });
        journalLines.push({ accountId: cashBankAccountId, credit: amount, supplierId });
      }
      await postJournalEntry(tx, {
        tenantId: req.user.tenantId,
        branchId: derivedBranchId,
        date: eventTime,
        sourceType: 'PAYMENT',
        sourceId: created.id,
        memo: `${direction === 'IN' ? 'Customer' : 'Supplier'} payment ${receiptNumber}`,
        postedById: req.user.id,
        lines: journalLines,
      });

      return created;
    });
  }

  await logAudit({ req, action: 'PAYMENT_CREATE', entity: 'Payment', entityId: payment.id, metadata: { direction, amount, method }, branchId: payment.branchId });

  if (direction === 'IN') {
    await triggerEvent(prisma, {
      tenantId: req.user.tenantId,
      event: 'PAYMENT_RECEIVED',
      sourceId: payment.id,
      entityType: 'Payment',
      branchId: payment.branchId,
      variables: { amount, method, receiptNumber: payment.receiptNumber },
      internalTitle: `Payment received: ${payment.receiptNumber}`,
      internalBody: `A payment of ${Number(amount).toFixed(2)} (${method}) was recorded.`,
    });
  }

  res.status(201).json({ item: payment });
});

// Reversal is scoped to payments created via the standalone endpoint above
// (i.e. ones that have allocation rows). A payment created inline by Sale/
// Purchase creation, or via Sale's/Purchase's own :id/pay, posted its
// journal entry against that SALE'S/PURCHASE'S OWN id as sourceId, not this
// Payment's - reversing it here could restore the amountPaid bookkeeping
// without correctly reversing the matching journal entry. Reversing one of
// those is Sale's own :id/reverse (whole-sale reversal) or, for Purchase,
// not yet independently supported - a disclosed scope boundary, not
// silently mishandled.
router.post('/:id/reverse', requirePermission('PAYMENT', 'REVERSE'), async (req, res) => {
  const item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.payment.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      include: { allocations: true },
    });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(tx, req.user, existing.branchId);
    for (const allocation of existing.allocations) {
      const target = allocation.saleId
        ? await tx.sale.findUnique({ where: { id: allocation.saleId }, select: { branchId: true } })
        : await tx.purchase.findUnique({ where: { id: allocation.purchaseId }, select: { branchId: true } });
      await assertBranchAccess(tx, req.user, target?.branchId);
    }
    if (existing.allocations.length === 0) {
      throw new ValidationError('This payment was recorded inline with a sale/purchase and cannot be reversed independently here');
    }

    // A prepayment allocated to a DRAFT purchase was posted to Advance-to-Suppliers, and
    // receiving that purchase has since cleared the advance against Payable - mirroring
    // the original entry now would credit the advance a second time.
    const priorEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'PAYMENT', sourceId: existing.id, status: 'POSTED' },
      include: { lines: { include: { account: { select: { systemKey: true } } } } },
    });
    if (priorEntry?.lines.some((l) => l.account.systemKey === 'ADVANCE_TO_SUPPLIERS')) {
      const purchaseIds = existing.allocations.map((a) => a.purchaseId).filter(Boolean);
      const received = await tx.purchase.count({ where: { id: { in: purchaseIds }, status: { not: 'DRAFT' } } });
      if (received > 0) throw new ConflictError('This payment was a prepayment on a purchase that has since been received - it can no longer be reversed independently');
    }

    // Atomic guard against a concurrent double-reversal - mirrors Sale
    // reversal's identical Phase 1.8 guard exactly.
    const flipped = await tx.payment.updateMany({
      where: { id: existing.id, status: 'COMPLETED' },
      data: { status: 'REVERSED' },
    });
    if (flipped.count === 0) throw new ConflictError('Payment has already been reversed', 'ALREADY_APPLIED');

    // Fixed lock order (by document id), each release guarded so amountPaid can
    // never go below zero.
    const releaseOrder = [...existing.allocations].sort((x, y) => ((x.saleId || x.purchaseId) < (y.saleId || y.purchaseId) ? -1 : 1));
    for (const allocation of releaseOrder) {
      if (allocation.saleId) await releaseDocument(tx.sale, allocation.saleId, Number(allocation.amount));
      else if (allocation.purchaseId) await releaseDocument(tx.purchase, allocation.purchaseId, Number(allocation.amount));
    }

    const originalEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'PAYMENT', sourceId: existing.id, status: 'POSTED' },
    });
    if (originalEntry) {
      await reverseJournalEntry(tx, {
        tenantId: req.user.tenantId,
        sourceEntryId: originalEntry.id,
        sourceType: 'PAYMENT_REVERSAL',
        sourceId: existing.id,
        memo: `Reversal of payment ${existing.receiptNumber || existing.id}`,
        postedById: req.user.id,
      });
    }

    return tx.payment.findUnique({ where: { id: existing.id }, include: { allocations: true } });
  });

  await logAudit({ req, action: 'PAYMENT_REVERSE', entity: 'Payment', entityId: item.id, branchId: item.branchId });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'PAYMENT_REVERSED',
    sourceId: item.id,
    entityType: 'Payment',
    branchId: item.branchId,
    variables: { amount: Number(item.amount), receiptNumber: item.receiptNumber },
    internalTitle: `Payment reversed: ${item.receiptNumber || item.id}`,
    internalBody: `A payment of ${Number(item.amount).toFixed(2)} was reversed.`,
  });

  res.json({ item });
});

module.exports = router;
