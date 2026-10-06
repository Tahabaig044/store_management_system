// Phase 1.13: a PARTIAL, line-item-level Purchase Return - distinct from
// Purchase's own existing :id/return (Phase 1.9's whole-purchase return,
// left completely unchanged by this module). Mirrors salesReturns.routes.js
// exactly, for the supplier side: PurchaseItem.returnedQuantity is the same
// atomic-conditional-increment guard, and by default atomically issues its
// own linked DebitNote in the SAME transaction and SAME journal entry.
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
const { postJournalEntry, reverseJournalEntry, getSystemAccountId, allocateNoteNumber } = require('../accounting/ledger');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { logAudit } = require('../../middleware/audit');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { triggerEvent } = require('../communication/automation');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('PURCHASE_RETURN', 'VIEW'), async (req, res) => {
  const { purchaseId, supplierId, status, from, to, search } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (purchaseId) where.purchaseId = purchaseId;
  if (supplierId) where.supplierId = supplierId;
  if (status) where.status = status;
  if (search) where.returnNumber = { contains: search, mode: 'insensitive' };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    prisma.purchaseReturn.findMany({
      where,
      include: { purchase: { select: { purchaseNumber: true } }, supplier: { select: { name: true } }, items: true, debitNote: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.purchaseReturn.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('PURCHASE_RETURN', 'VIEW'), async (req, res) => {
  const item = await prisma.purchaseReturn.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { purchase: true, supplier: true, items: { include: { product: true, purchaseItem: true } }, debitNote: true },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

const createSchema = z.object({
  purchaseId: z.string().uuid(),
  items: z.array(z.object({ purchaseItemId: z.string().uuid(), quantity: z.number().positive() })).min(1),
  reason: z.string().optional(),
  notes: z.string().optional(),
  branchId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  issueDebitNote: z.boolean().default(true),
  idempotencyKey: z.string().optional(),
  // Phase 3.3: when an offline terminal actually sent the goods back (see utils/eventTime.js).
  occurredAt: z.coerce.date().optional(),
});

router.post('/', requirePermission('PURCHASE_RETURN', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid purchase return data', parsed.error.flatten());
  const { purchaseId, items, reason, notes, issueDebitNote, idempotencyKey } = parsed.data;
  const eventTime = resolveEventTime(parsed.data.occurredAt);

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.purchaseReturn, req.user.tenantId, idempotencyKey, { items: true, debitNote: true });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const purchase = await prisma.purchase.findFirst({ where: { id: purchaseId, tenantId: req.user.tenantId }, include: { items: true } });
  if (!purchase) throw new NotFoundError('Purchase not found');
  if (!['RECEIVED'].includes(purchase.status)) throw new ConflictError('Only a received purchase can be returned against', 'DOCUMENT_NOT_OPEN');

  const branchId = parsed.data.branchId ?? purchase.branchId ?? null;
  const warehouseId = parsed.data.warehouseId ?? purchase.warehouseId ?? null;
  await assertBranchAccess(prisma, req.user, branchId);
  await assertWarehouseAccess(prisma, req.user, warehouseId);

  const purchaseItemsById = new Map(purchase.items.map((i) => [i.id, i]));
  for (const line of items) {
    const purchaseItem = purchaseItemsById.get(line.purchaseItemId);
    if (!purchaseItem) throw new NotFoundError(`Purchase item ${line.purchaseItemId} not found on this purchase`);
    const remaining = Number(purchaseItem.quantity) - Number(purchaseItem.returnedQuantity);
    if (line.quantity > remaining + 0.0001) {
      throw new ValidationError(`Cannot return more than the remaining ${remaining} units for this line`, { purchaseItemId: line.purchaseItemId, remaining }, 'RETURN_EXCEEDS');
    }
  }

  const MAX_NUMBER_RETRIES = 8;
  let result;
  for (let attempt = 1; attempt <= MAX_NUMBER_RETRIES; attempt++) {
    try {
      result = await runReturnTransaction();
      break;
    } catch (err) {
      // A duplicate of an operation that already succeeded resolves to that operation (see sales.routes.js).
      if (idempotencyKey) {
        const existing = await findExistingByIdempotencyKey(prisma.purchaseReturn, req.user.tenantId, idempotencyKey, { items: true, debitNote: true });
        if (existing) return res.status(200).json({ item: existing, deduplicated: true });
      }
      const isCollision = err.code === 'P2002' && (err.meta?.target?.includes('returnNumber') || err.meta?.target?.includes('debitNoteNumber'));
      if (!isCollision || attempt === MAX_NUMBER_RETRIES) throw err;
    }
  }

  async function runReturnTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
      let subtotal = 0;
      const returnItemsData = [];
      const stockMutations = [];
      const allowNegative = await (async () => {
        const setting = await tx.setting.findUnique({ where: { tenantId_key: { tenantId: req.user.tenantId, key: 'allowNegativeStock' } } });
        return setting?.value === 'true';
      })();

      for (const line of items) {
        const purchaseItem = purchaseItemsById.get(line.purchaseItemId);
        // Authoritative atomic guard - mirrors SalesReturn's identical
        // pattern (and GRN's over-receiving guard) exactly.
        const claim = await tx.purchaseItem.updateMany({
          where: { id: purchaseItem.id, returnedQuantity: { lte: Number(purchaseItem.quantity) - line.quantity + 0.0001 } },
          data: { returnedQuantity: { increment: line.quantity } },
        });
        if (claim.count === 0) {
          throw new ConflictError('Cannot return more than the remaining quantity for this line - it may have just been returned by another request', 'RETURN_EXCEEDS');
        }

        const product = await tx.product.findFirst({ where: { id: purchaseItem.productId, tenantId: req.user.tenantId } });
        const lineTotal = Number(purchaseItem.unitCost) * line.quantity;
        subtotal += lineTotal;
        returnItemsData.push({
          purchaseItemId: purchaseItem.id,
          productId: purchaseItem.productId,
          quantity: line.quantity,
          unitCost: purchaseItem.unitCost,
          lineTotal,
        });

        // Deferred until after the PurchaseReturn row exists below, so its
        // own id (not the Purchase's) can be used as the
        // InventoryTransaction's reference.
        if (product.productKind !== 'SERVICE') {
          if (!allowNegative) {
            const stockClaim = await tx.product.updateMany({
              where: { id: product.id, stockQuantity: { gte: line.quantity } },
              data: { stockQuantity: { decrement: line.quantity } },
            });
            if (stockClaim.count === 0) throw new ConflictError(`Cannot return more of ${product.name} than is currently in stock`, 'STOCK_INSUFFICIENT', { productId: product.id, name: product.name });
          } else {
            await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { decrement: line.quantity } } });
          }
          stockMutations.push({ productId: product.id, quantity: line.quantity });
        }
      }

      // Proportional tax share of the original purchase's own header-level
      // tax - an approximation (see this phase's report, Known Limitations).
      const tax = Number(purchase.subtotal) > 0 ? Math.round((Number(purchase.tax) * (subtotal / Number(purchase.subtotal))) * 100) / 100 : 0;
      const total = Math.max(subtotal + tax, 0);

      const returnNumber = await nextSequenceNumber(tx.purchaseReturn, req.user.tenantId, 'PRT', { tx });
      const purchaseReturn = await tx.purchaseReturn.create({
        data: {
          tenantId: req.user.tenantId,
          returnNumber,
          purchaseId,
          supplierId: purchase.supplierId,
          branchId,
          warehouseId,
          reason,
          notes,
          subtotal,
          tax,
          total,
          idempotencyKey,
          createdAt: eventTime,
          createdById: req.user.id,
          items: { create: returnItemsData },
        },
        include: { items: true },
      });

      for (const move of stockMutations) {
        const refreshed = await tx.product.findUnique({ where: { id: move.productId }, select: { stockQuantity: true } });
        await tx.inventoryTransaction.create({
          data: {
            tenantId: req.user.tenantId,
            productId: move.productId,
            warehouseId,
            type: 'PURCHASE_RETURN',
            quantity: -move.quantity,
            balanceAfter: Number(refreshed.stockQuantity),
            reference: purchaseReturn.id,
            createdById: req.user.id,
          },
        });
      }

      const journalLines = [];
      let debitNote = null;
      if (issueDebitNote && total > 0) {
        const [payableAccountId, inventoryAccountId, inputTaxAccountId] = await Promise.all([
          getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_PAYABLE'),
          getSystemAccountId(tx, req.user.tenantId, 'INVENTORY'),
          tax > 0 ? getSystemAccountId(tx, req.user.tenantId, 'INPUT_TAX') : null,
        ]);
        journalLines.push({ accountId: payableAccountId, debit: total, supplierId: purchase.supplierId });
        journalLines.push({ accountId: inventoryAccountId, credit: subtotal, supplierId: purchase.supplierId });
        if (tax > 0) journalLines.push({ accountId: inputTaxAccountId, credit: tax, supplierId: purchase.supplierId });

        const debitNoteNumber = await allocateNoteNumber(tx, req.user.tenantId, 'DN');
        debitNote = await tx.debitNote.create({
          data: {
            tenantId: req.user.tenantId,
            debitNoteNumber,
            supplierId: purchase.supplierId,
            purchaseReturnId: purchaseReturn.id,
            branchId,
            amount: total,
            tax,
            reason,
            notes,
            createdAt: eventTime,
            createdById: req.user.id,
          },
        });
      }

      if (journalLines.length >= 2) {
        await postJournalEntry(tx, {
          tenantId: req.user.tenantId,
          branchId,
          date: eventTime,
          sourceType: 'PURCHASE_RETURN',
          sourceId: purchaseReturn.id,
          memo: `Purchase return ${returnNumber} against purchase ${purchase.purchaseNumber}`,
          postedById: req.user.id,
          lines: journalLines,
        });
      }

      return tx.purchaseReturn.findUnique({ where: { id: purchaseReturn.id }, include: { items: true, debitNote: true } });
    });
  }

  await logAudit({ req, action: 'PURCHASE_RETURN_CREATE', entity: 'PurchaseReturn', entityId: result.id, metadata: { purchaseId, total: result.total }, branchId: result.branchId });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'RETURN_CREATED',
    sourceId: result.id,
    entityType: 'PurchaseReturn',
    branchId: result.branchId,
    variables: { kind: 'PURCHASE', returnNumber: result.returnNumber, total: Number(result.total) },
    internalTitle: `Purchase return recorded: ${result.returnNumber}`,
    internalBody: `A purchase return of ${Number(result.total).toFixed(2)} was recorded against purchase ${purchaseId}.`,
  });

  res.status(201).json({ item: result });
});

router.post('/:id/reverse', requirePermission('PURCHASE_RETURN', 'REVERSE'), async (req, res) => {
  const item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.purchaseReturn.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      include: { items: true, debitNote: true },
    });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(prisma, req.user, existing.branchId);

    if (existing.debitNote && Number(existing.debitNote.refundedAmount) > 0) {
      throw new ConflictError('Cannot reverse a purchase return whose linked debit note has already been partially or fully refunded');
    }

    const flipped = await tx.purchaseReturn.updateMany({
      where: { id: existing.id, status: 'COMPLETED' },
      data: { status: 'REVERSED', reversedAt: new Date() },
    });
    if (flipped.count === 0) throw new ConflictError('Purchase return has already been reversed', 'ALREADY_APPLIED');

    for (const line of existing.items) {
      await tx.purchaseItem.update({ where: { id: line.purchaseItemId }, data: { returnedQuantity: { decrement: Number(line.quantity) } } });

      const product = await tx.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
      if (product.productKind === 'SERVICE') continue;

      const updated = await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { increment: Number(line.quantity) } } });
      await tx.inventoryTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          productId: product.id,
          warehouseId: existing.warehouseId,
          type: 'PURCHASE_RETURN',
          quantity: Number(line.quantity),
          balanceAfter: updated.stockQuantity,
          reference: existing.id,
          createdById: req.user.id,
        },
      });
    }

    if (existing.debitNote) {
      // Phase 2.2: debit note already applied to purchases must be un-applied first.
      if (Number(existing.debitNote.appliedAmount) > 0) throw new ConflictError('The debit note from this return has been applied to purchases - reverse that application first');
      await tx.debitNote.update({ where: { id: existing.debitNote.id }, data: { status: 'CANCELLED' } });
    }

    const originalEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'PURCHASE_RETURN', sourceId: existing.id, status: 'POSTED' },
    });
    if (originalEntry) {
      await reverseJournalEntry(tx, {
        tenantId: req.user.tenantId,
        sourceEntryId: originalEntry.id,
        sourceType: 'PURCHASE_RETURN_REVERSAL',
        sourceId: existing.id,
        memo: `Reversal of purchase return ${existing.returnNumber || existing.id}`,
        postedById: req.user.id,
      });
    }

    return tx.purchaseReturn.findUnique({ where: { id: existing.id }, include: { items: true, debitNote: true } });
  });

  await logAudit({ req, action: 'PURCHASE_RETURN_REVERSE', entity: 'PurchaseReturn', entityId: item.id });
  res.json({ item });
});

module.exports = router;
