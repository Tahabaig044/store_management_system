const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { resolveEventTime } = require('../../utils/eventTime');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { INVENTORY_STAFF } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { postJournalEntry, reverseJournalEntry, getSystemAccountId, getMoneyAccountId, allocateReceiptNumber, allocateNoteNumber } = require('../accounting/ledger');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { SIDES, assertDocumentHasNoActiveApplications, withReceiptRetry } = require('../receivables/arapService');
const {
  postImmediateReceiptEntry,
  postDeferredReceiptEntry,
  postAdvanceEntry,
  receivePurchaseStock,
} = require('./purchaseService');

const itemSchema = z.object({
  productId: z.string().uuid(),
  // Phase 1.9: optional variant attribution, mirroring SaleItem.variantId
  // (Phase 1.8) - the ordered/received quantity still tracks against the
  // parent Product; this only records which specific variant was purchased.
  variantId: z.string().uuid().optional(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
});

const createSchema = z.object({
  supplierId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  // Phase 1.9: optional warehouse attribution, validated via the existing
  // assertWarehouseAccess (Phase 0.4), mirroring Sale.warehouseId (Phase 1.8).
  // Attribution/authorization only - does not yet drive per-warehouse
  // WarehouseStock adjustment.
  warehouseId: z.string().uuid().optional(),
  notes: z.string().optional(),
  items: z.array(itemSchema).min(1),
  discount: z.number().nonnegative().default(0),
  tax: z.number().nonnegative().default(0),
  amountPaid: z.number().nonnegative().default(0),
  paymentMethod: z.string().default('cash'),
  receiveImmediately: z.boolean().default(false),
  idempotencyKey: z.string().optional(),
  // Phase 3.2: when an offline terminal actually recorded the purchase (see utils/eventTime.js).
  occurredAt: z.coerce.date().optional(),
});

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('PURCHASE', 'VIEW'), async (req, res) => {
  const { search, status, supplierId, paymentStatus, branchId, warehouseId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (status) where.status = status;
  if (paymentStatus) where.paymentStatus = paymentStatus;
  if (supplierId) where.supplierId = supplierId;
  if (search) where.purchaseNumber = { contains: search, mode: 'insensitive' };
  // branchId/warehouseId filters are validated against the caller's own access
  // first (reusing assertBranchAccess/assertWarehouseAccess, not new logic)
  // before narrowing `where` - mirrors Sale's Phase 1.8 filter pattern exactly.
  if (branchId) {
    await assertBranchAccess(prisma, req.user, branchId);
    where.branchId = branchId;
  }
  if (warehouseId) {
    await assertWarehouseAccess(prisma, req.user, warehouseId);
    where.warehouseId = warehouseId;
  }

  const [items, total] = await Promise.all([
    prisma.purchase.findMany({
      where,
      include: { supplier: true, items: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.purchase.count({ where }),
  ]);

  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('PURCHASE', 'VIEW'), async (req, res) => {
  const item = await prisma.purchase.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) },
    include: { supplier: true, items: { include: { product: true } }, payments: true },
  });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.post('/', requirePermission('PURCHASE', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid purchase data', parsed.error.flatten());
  const { supplierId, items, discount, tax, amountPaid, paymentMethod, receiveImmediately, idempotencyKey, notes } = parsed.data;
  const branchId = parsed.data.branchId ?? req.user.branchId ?? null;
  const warehouseId = parsed.data.warehouseId ?? null;
  const eventTime = resolveEventTime(parsed.data.occurredAt);

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.purchase, req.user.tenantId, idempotencyKey, {
      items: true,
      supplier: true,
    });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitCost, 0);
  const total = Math.max(subtotal - discount + tax, 0);
  if (amountPaid > total) throw new ValidationError('Amount paid cannot exceed purchase total');
  await assertBranchAccess(prisma, req.user, branchId);
  if (warehouseId) {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.user.tenantId } });
    if (!warehouse) throw new NotFoundError('Warehouse not found');
  }
  await assertWarehouseAccess(prisma, req.user, warehouseId);

  // Phase 1.9: audited per the Phase 1.8 precedent (Sale's invoiceNumber
  // collision) - the shared nextSequenceNumber utility (Phase 0.6) generates
  // a purchase number from a plain per-tenant row count, which its own doc
  // comment already discloses is "not guaranteed gap-free under concurrent
  // creates." Direct testing confirmed the identical collision reproduces
  // for Purchase (a 15-way concurrent create test failed 10/15 with a clean
  // 409 "already exists" - not a real business conflict, just two
  // transactions computing the same next number). Rewriting the shared
  // utility's counting algorithm would affect every other module that reuses
  // it (PurchaseOrder, PurchaseRequest, RFQ, GoodsReceipt, Sale, and others)
  // - out of scope for Phase 1.9 (see this phase's report, Known
  // Limitations). Instead, mirroring Sale's own Phase 1.8 fix exactly:
  // retry the whole transaction (which re-derives a fresh number from the
  // now-current count) on exactly this collision, making Purchase's own
  // numbering collision-safe without touching the shared utility or any
  // other module that calls it.
  const MAX_PURCHASE_NUMBER_RETRIES = 15;
  let purchase;
  for (let attempt = 1; attempt <= MAX_PURCHASE_NUMBER_RETRIES; attempt++) {
    try {
      purchase = await runPurchaseTransaction();
      break;
    } catch (err) {
      // Two identical requests racing past the pre-check: the loser hits the (tenantId,
      // idempotencyKey) unique index - answer it as the duplicate it is.
      // A duplicate of an operation that already succeeded resolves to that operation, whatever else
      // went wrong for the duplicate (another request with the same key raced it past the pre-check
      // and won: e.g. the stock the winner consumed is why this one now fails).
      if (idempotencyKey) {
        const existing = await findExistingByIdempotencyKey(prisma.purchase, req.user.tenantId, idempotencyKey, { items: true, supplier: true });
        if (existing) return res.status(200).json({ item: existing, deduplicated: true });
      }
      const isPurchaseNumberCollision = err.code === 'P2002' && err.meta?.target?.includes('purchaseNumber');
      if (!isPurchaseNumberCollision || attempt === MAX_PURCHASE_NUMBER_RETRIES) throw err;
      // Every failed attempt means at least one concurrent request won that round, so the
      // bound must simply exceed the realistic number of simultaneous creates; jitter spreads the retries.
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
    }
  }

  async function runPurchaseTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
    // A client-supplied supplierId/productId must belong to this tenant -
    // otherwise a purchase could attach to another tenant's supplier, or
    // (combined with receiveImmediately) inflate another tenant's stock.
    const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId: req.user.tenantId } });
    if (!supplier) throw new NotFoundError('Supplier not found');
    for (const item of items) {
      const product = await tx.product.findFirst({ where: { id: item.productId, tenantId: req.user.tenantId } });
      if (!product) throw new NotFoundError(`Product ${item.productId} not found`);
      if (item.variantId) {
        const variant = await tx.productVariant.findFirst({ where: { id: item.variantId, productId: item.productId } });
        if (!variant) throw new NotFoundError(`Variant not found for product ${product.name}`);
      }
    }
    if (branchId) {
      const branch = await tx.branch.findFirst({ where: { id: branchId, tenantId: req.user.tenantId } });
      if (!branch) throw new NotFoundError('Branch not found');
    }

    const purchaseNumber = await nextSequenceNumber(tx.purchase, req.user.tenantId, 'PO', { tx });
    const created = await tx.purchase.create({
      data: {
        tenantId: req.user.tenantId,
        supplierId,
        branchId,
        warehouseId,
        notes,
        purchaseNumber,
        subtotal,
        discount,
        tax,
        total,
        amountPaid,
        idempotencyKey,
        paymentStatus: amountPaid <= 0 ? 'UNPAID' : amountPaid >= total ? 'PAID' : 'PARTIAL',
        status: receiveImmediately ? 'RECEIVED' : 'DRAFT',
        createdAt: eventTime,
        receivedAt: receiveImmediately ? eventTime : null,
        createdById: req.user.id,
        items: {
          create: items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            quantity: i.quantity,
            unitCost: i.unitCost,
            lineTotal: i.quantity * i.unitCost,
          })),
        },
      },
      include: { items: true, supplier: true },
    });

    if (receiveImmediately) {
      await receivePurchaseStock(tx, created, req.user.id);
    }

    // Stock rows are locked above; the journal lock (taken by the receipt allocation and by
    // the posting) is deliberately acquired AFTER them so no transaction ever holds it while
    // waiting for a product row.
    if (amountPaid > 0) {
      const receiptNumber = await allocateReceiptNumber(tx, req.user.tenantId);
      await tx.payment.create({
        data: {
          tenantId: req.user.tenantId,
          direction: 'OUT',
          amount: amountPaid,
          method: paymentMethod,
          purchaseId: created.id,
          supplierId,
          branchId,
          receiptNumber,
          paidAt: eventTime,
        },
      });
    }

    if (receiveImmediately) {
      await postImmediateReceiptEntry(tx, {
        tenantId: req.user.tenantId,
        branchId,
        purchase: created,
        paymentMethod,
        postedById: req.user.id,
      });
    } else if (amountPaid > 0) {
      // Paid up front on a purchase that hasn't arrived yet - a genuine
      // prepayment, not (yet) a reduction of Accounts Payable.
      await postAdvanceEntry(tx, {
        tenantId: req.user.tenantId,
        branchId,
        purchase: created,
        paymentMethod,
        postedById: req.user.id,
      });
    }

    return created;
    });
  }

  await logAudit({ req, action: 'PURCHASE_CREATE', entity: 'Purchase', entityId: purchase.id });
  res.status(201).json({ item: purchase });
});

// Receive stock for a DRAFT purchase - atomic: every item's stock update and the
// status flip to RECEIVED happen in one transaction or not at all.
router.post('/:id/receive', requireRole(...INVENTORY_STAFF), async (req, res) => {
  const purchase = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.purchase.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundError();
    if (existing.status !== 'DRAFT') throw new ConflictError('Purchase has already been received or cancelled');

    await receivePurchaseStock(tx, existing, req.user.id);
    await postDeferredReceiptEntry(tx, {
      tenantId: req.user.tenantId,
      branchId: existing.branchId,
      purchase: existing,
      postedById: req.user.id,
    });

    return tx.purchase.update({
      where: { id: existing.id },
      data: { status: 'RECEIVED', receivedAt: new Date() },
      include: { items: true, supplier: true },
    });
  });

  await logAudit({ req, action: 'PURCHASE_RECEIVE', entity: 'Purchase', entityId: purchase.id });
  res.json({ item: purchase });
});

router.post('/:id/pay', requireRole(...INVENTORY_STAFF), async (req, res) => {
  const schema = z.object({
    amount: z.number().positive(),
    method: z.string().default('cash'),
    note: z.string().optional(),
    // Phase 1.11: optional client-generated key so a retried payment
    // submission (flaky connection, offline outbox retry) is recognized as
    // the same operation instead of double-recording it.
    idempotencyKey: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid payment data', parsed.error.flatten());

  if (parsed.data.idempotencyKey) {
    const existingPayment = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, parsed.data.idempotencyKey);
    if (existingPayment) {
      const current = await prisma.purchase.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
      if (!current) throw new NotFoundError();
      return res.json({ item: current, deduplicated: true });
    }
  }

  let purchase;
  try {
  purchase = await withReceiptRetry(() => runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.purchase.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();
    // Phase 2.2: a payment must not cross a branch boundary the caller isn't allowed in,
    // and a cancelled/returned purchase no longer owes anything.
    await assertBranchAccess(tx, req.user, existing.branchId);
    if (!['DRAFT', 'RECEIVED'].includes(existing.status)) throw new ConflictError('Only a draft or received purchase can receive a payment', 'DOCUMENT_NOT_OPEN');

    // Atomic conditional accumulation - two concurrent payments on the same
    // purchase could otherwise both read the same stale amountPaid and each
    // compute a newPaid that individually looks valid, together exceeding the
    // total (the same class of race fixed for Sale stock/reversal in Phase
    // 1.8). The guard's `lte` threshold is re-evaluated against the
    // latest-committed amountPaid when this UPDATE actually runs.
    const maxPriorPaid = Number(existing.total) - parsed.data.amount;
    const claim = await tx.purchase.updateMany({
      where: { id: existing.id, status: { in: ['DRAFT', 'RECEIVED'] }, amountPaid: { lte: maxPriorPaid + 0.0001 } },
      data: { amountPaid: { increment: parsed.data.amount } },
    });
    if (claim.count === 0) {
      const current = await tx.purchase.findUnique({ where: { id: existing.id }, select: { status: true } });
      if (!['DRAFT', 'RECEIVED'].includes(current.status)) throw new ConflictError('Only a draft or received purchase can receive a payment', 'DOCUMENT_NOT_OPEN');
      throw new ValidationError('Payment would exceed purchase total', undefined, 'BALANCE_CHANGED');
    }
    const refreshed = await tx.purchase.findUnique({ where: { id: existing.id } });
    const newPaid = Number(refreshed.amountPaid);

    const receiptNumber = await allocateReceiptNumber(tx, req.user.tenantId);
    await tx.payment.create({
      data: {
        tenantId: req.user.tenantId,
        direction: 'OUT',
        amount: parsed.data.amount,
        method: parsed.data.method,
        note: parsed.data.note,
        purchaseId: existing.id,
        supplierId: existing.supplierId,
        branchId: existing.branchId,
        receiptNumber,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });

    // A payment on an already-received purchase reduces the real Accounts
    // Payable balance; a payment on a still-DRAFT purchase is a prepayment
    // (no Payable exists yet for it), same as an advance paid at creation.
    if (existing.status === 'RECEIVED') {
      const [payableAccountId, cashBankAccountId] = await Promise.all([
        getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_PAYABLE'),
        getMoneyAccountId(tx, req.user.tenantId, parsed.data.method),
      ]);
      await postJournalEntry(tx, {
        tenantId: req.user.tenantId,
        branchId: existing.branchId,
        sourceType: 'PAYMENT',
        sourceId: existing.id,
        memo: `Payment on purchase ${existing.purchaseNumber}`,
        postedById: req.user.id,
        lines: [
          { accountId: payableAccountId, debit: parsed.data.amount, supplierId: existing.supplierId },
          { accountId: cashBankAccountId, credit: parsed.data.amount, supplierId: existing.supplierId },
        ],
      });
    } else {
      await postAdvanceEntry(tx, {
        tenantId: req.user.tenantId,
        branchId: existing.branchId,
        purchase: { ...existing, amountPaid: parsed.data.amount, createdAt: new Date() },
        paymentMethod: parsed.data.method,
        postedById: req.user.id,
      });
    }

    // amountPaid was already atomically incremented above; only paymentStatus
    // (a derived label) needs setting here.
    return tx.purchase.update({
      where: { id: existing.id },
      data: {
        paymentStatus: newPaid >= Number(existing.total) ? 'PAID' : 'PARTIAL',
      },
    });
  }));
  } catch (err) {
    // Two identical requests racing past the pre-check: answer the loser as a duplicate.
    if (err.code === 'P2002' && parsed.data.idempotencyKey && err.meta?.target?.includes('idempotencyKey')) {
      const current = await prisma.purchase.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
      if (current) return res.json({ item: current, deduplicated: true });
    }
    throw err;
  }

  await logAudit({ req, action: 'PURCHASE_PAYMENT_RECORD', entity: 'Purchase', entityId: purchase.id, metadata: { amount: parsed.data.amount, method: parsed.data.method } });
  res.json({ item: purchase });
});

// Purchase return: goods physically go back to the supplier. Reverses the
// entire received purchase - stock decreases, and the original journal
// entry is exactly mirrored (never edited/deleted). If the purchase had
// already been paid, Accounts Payable correctly goes negative for that
// supplier, which is the accurate signal that the supplier now owes a
// refund - no special-casing needed.
router.post('/:id/return', requirePermission('PURCHASE', 'REVERSE'), async (req, res) => {
  const purchase = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.purchase.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(tx, req.user, existing.branchId);
    // Atomic guard against a concurrent double-return: two simultaneous return
    // requests for the same purchase could otherwise both read status:
    // 'RECEIVED' before either writes, and both proceed to decrement stock -
    // the same check-then-write race fixed for Sale's reversal handler
    // (Phase 1.8). updateMany's WHERE is re-evaluated against the
    // latest-committed row when it actually runs, so only one requester wins.
    const flipped = await tx.purchase.updateMany({
      where: { id: existing.id, status: 'RECEIVED' },
      data: { status: 'RETURNED' },
    });
    if (flipped.count === 0) throw new ConflictError('Only a received purchase can be returned, or it has already been returned', 'ALREADY_APPLIED');
    // Phase 2.2: debit-note credit applied here would otherwise be stranded on a returned document.
    await assertDocumentHasNoActiveApplications(tx, SIDES.AP, existing.id, req.user.tenantId);

    const allowNegative = await (async () => {
      const setting = await tx.setting.findUnique({ where: { tenantId_key: { tenantId: req.user.tenantId, key: 'allowNegativeStock' } } });
      return setting?.value === 'true';
    })();

    for (const line of existing.items) {
      const product = await tx.product.findUnique({ where: { id: line.productId } });
      // Atomic conditional decrement (not read-then-write) - mirrors Sale
      // creation's stock-deduction guard exactly, so two concurrent returns of
      // the same product can never together push stock negative undetected.
      let newBalance;
      if (!allowNegative) {
        const result = await tx.product.updateMany({
          where: { id: product.id, stockQuantity: { gte: Number(line.quantity) } },
          data: { stockQuantity: { decrement: Number(line.quantity) } },
        });
        if (result.count === 0) {
          throw new ConflictError(`Cannot return more of ${product.name} than is currently in stock`);
        }
      } else {
        await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { decrement: Number(line.quantity) } } });
      }
      const updated = await tx.product.findUnique({ where: { id: product.id }, select: { stockQuantity: true } });
      newBalance = Number(updated.stockQuantity);
      await tx.inventoryTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          productId: product.id,
          type: 'PURCHASE_RETURN',
          quantity: -Number(line.quantity),
          balanceAfter: newBalance,
          reference: existing.id,
          createdById: req.user.id,
        },
      });
    }

    const originalEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'PURCHASE', sourceId: existing.id, status: 'POSTED' },
    });
    if (originalEntry) {
      // Phase 2.4: mirror of Sale reversal. What we already paid the supplier stays with them
      // as a balance owed to us (a debit note), not as cash silently returned by the
      // reversal entry. A prepayment that was cleared from Advance-to-Suppliers goes back to
      // that asset by the mirror itself and is not counted here.
      const originalLines = await tx.journalLine.findMany({ where: { journalEntryId: originalEntry.id }, include: { account: { select: { systemKey: true } } } });
      const advanceCleared = originalLines.filter((l) => l.account.systemKey === 'ADVANCE_TO_SUPPLIERS').reduce((sum, l) => sum + Number(l.credit), 0);
      // Re-read after the atomic status flip (see the sale reversal): payments that committed
      // while the flip waited are included, and none can land afterwards.
      const settledNow = await tx.purchase.findUnique({ where: { id: existing.id }, select: { amountPaid: true } });
      const held = Math.round((Number(settledNow.amountPaid) - advanceCleared) * 100) / 100;
      const holdsCredit = held > 0;
      let settleTo;
      if (holdsCredit) {
        const [payableId, cashId, bankId] = await Promise.all([
          getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_PAYABLE'),
          getSystemAccountId(tx, req.user.tenantId, 'CASH'),
          getSystemAccountId(tx, req.user.tenantId, 'BANK'),
        ]);
        settleTo = { accountId: payableId, partyField: 'supplierId', partyId: existing.supplierId, moneyAccountIds: [cashId, bankId] };
      }
      await reverseJournalEntry(tx, {
        tenantId: req.user.tenantId,
        sourceEntryId: originalEntry.id,
        sourceType: 'PURCHASE_RETURN',
        sourceId: existing.id,
        memo: `Return of purchase ${existing.purchaseNumber}`,
        postedById: req.user.id,
        settleTo,
      });
      if (holdsCredit) {
        await tx.debitNote.create({
          data: {
            tenantId: req.user.tenantId,
            debitNoteNumber: await allocateNoteNumber(tx, req.user.tenantId, 'DN'),
            supplierId: existing.supplierId,
            branchId: existing.branchId,
            amount: held,
            tax: 0,
            reason: `Return of purchase ${existing.purchaseNumber}`,
            returnedPurchaseId: existing.id,
            createdById: req.user.id,
          },
        });
      }
    }

    return tx.purchase.findUnique({ where: { id: existing.id } });
  });

  await logAudit({ req, action: 'PURCHASE_RETURN', entity: 'Purchase', entityId: purchase.id });
  res.json({ item: purchase });
});

module.exports = router;
