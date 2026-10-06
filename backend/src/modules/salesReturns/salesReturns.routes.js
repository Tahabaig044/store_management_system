// Phase 1.13: a PARTIAL, line-item-level Sales Return - distinct from
// Sale's own existing :id/reverse (Phase 1.8's whole-sale reversal, left
// completely unchanged by this module). A SalesReturn can happen multiple
// times against the same Sale, tracked via SaleItem.returnedQuantity (the
// same atomic-conditional-increment guard pattern already used for
// PurchaseOrderItem.receivedQuantity/Sale.amountPaid/etc.), and by default
// atomically issues its own linked CreditNote in the SAME transaction and
// SAME journal entry - see schema.prisma's module header comment on why
// this is one combined posting, not two.
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
const { postJournalEntry, reverseJournalEntry, getSystemAccountId, allocateNoteNumber, getMoneyAccountId, allocateReceiptNumber } = require('../accounting/ledger');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { logAudit } = require('../../middleware/audit');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { triggerEvent } = require('../communication/automation');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('SALES_RETURN', 'VIEW'), async (req, res) => {
  const { saleId, customerId, status, from, to, search } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (saleId) where.saleId = saleId;
  if (customerId) where.customerId = customerId;
  if (status) where.status = status;
  if (search) where.returnNumber = { contains: search, mode: 'insensitive' };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    prisma.salesReturn.findMany({
      where,
      include: { sale: { select: { invoiceNumber: true } }, customer: { select: { name: true } }, items: true, creditNote: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.salesReturn.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('SALES_RETURN', 'VIEW'), async (req, res) => {
  const item = await prisma.salesReturn.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { sale: true, customer: true, items: { include: { product: true, saleItem: true } }, creditNote: true },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

const createSchema = z.object({
  saleId: z.string().uuid(),
  items: z.array(z.object({ saleItemId: z.string().uuid(), quantity: z.number().positive() })).min(1),
  reason: z.string().optional(),
  notes: z.string().optional(),
  branchId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  issueCreditNote: z.boolean().default(true),
  // Only used for a walk-in sale (no customer to hold a credit for): how the cash goes back.
  refundMethod: z.string().default('cash'),
  idempotencyKey: z.string().optional(),
  // Phase 3.3: when an offline terminal actually took the goods back (see utils/eventTime.js).
  occurredAt: z.coerce.date().optional(),
});

router.post('/', requirePermission('SALES_RETURN', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid sales return data', parsed.error.flatten());
  const { saleId, items, reason, notes, issueCreditNote, idempotencyKey, refundMethod } = parsed.data;
  const eventTime = resolveEventTime(parsed.data.occurredAt);

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.salesReturn, req.user.tenantId, idempotencyKey, { items: true, creditNote: true });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const sale = await prisma.sale.findFirst({ where: { id: saleId, tenantId: req.user.tenantId }, include: { items: true } });
  if (!sale) throw new NotFoundError('Sale not found');
  if (sale.status !== 'COMPLETED') throw new ConflictError('Cannot return against a reversed sale', 'DOCUMENT_NOT_OPEN');

  const branchId = parsed.data.branchId ?? sale.branchId ?? null;
  const warehouseId = parsed.data.warehouseId ?? sale.warehouseId ?? null;
  await assertBranchAccess(prisma, req.user, branchId);
  await assertWarehouseAccess(prisma, req.user, warehouseId);

  const saleItemsById = new Map(sale.items.map((i) => [i.id, i]));
  for (const line of items) {
    const saleItem = saleItemsById.get(line.saleItemId);
    if (!saleItem) throw new NotFoundError(`Sale item ${line.saleItemId} not found on this sale`);
    // Fast, friendly rejection for the common non-concurrent case only - NOT
    // the authoritative guard (that's the atomic updateMany inside the
    // transaction below, mirroring GRN's identical Phase 1.9 pattern).
    const remaining = Number(saleItem.quantity) - Number(saleItem.returnedQuantity);
    if (line.quantity > remaining + 0.0001) {
      throw new ValidationError(`Cannot return more than the remaining ${remaining} units for this line`, { saleItemId: line.saleItemId, remaining }, 'RETURN_EXCEEDS');
    }
  }

  // Phase 1.8-1.12 precedent: the shared nextSequenceNumber utility is not
  // guaranteed collision-free under concurrent creates - bounded retry
  // mitigation, not a rewrite of the shared utility.
  const MAX_NUMBER_RETRIES = 8;
  let result;
  for (let attempt = 1; attempt <= MAX_NUMBER_RETRIES; attempt++) {
    try {
      result = await runReturnTransaction();
      break;
    } catch (err) {
      // A duplicate of an operation that already succeeded resolves to that operation (see sales.routes.js).
      if (idempotencyKey) {
        const existing = await findExistingByIdempotencyKey(prisma.salesReturn, req.user.tenantId, idempotencyKey, { items: true, creditNote: true });
        if (existing) return res.status(200).json({ item: existing, deduplicated: true });
      }
      const isCollision = err.code === 'P2002' && (err.meta?.target?.includes('returnNumber') || err.meta?.target?.includes('creditNoteNumber'));
      if (!isCollision || attempt === MAX_NUMBER_RETRIES) throw err;
    }
  }

  async function runReturnTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
      let subtotal = 0;
      let cogs = 0;
      const returnItemsData = [];
      const stockMutations = [];

      for (const line of items) {
        const saleItem = saleItemsById.get(line.saleItemId);
        // Authoritative atomic guard: claim the return quantity against this
        // line first. Re-evaluated by Postgres against the latest-committed
        // row when it runs, so two concurrent returns of the same line can
        // never together return more than was originally sold (mirrors GRN's
        // over-receiving guard and Sale's own stock-deduction guard exactly).
        const claim = await tx.saleItem.updateMany({
          where: { id: saleItem.id, returnedQuantity: { lte: Number(saleItem.quantity) - line.quantity + 0.0001 } },
          data: { returnedQuantity: { increment: line.quantity } },
        });
        if (claim.count === 0) {
          throw new ConflictError('Cannot return more than the remaining quantity for this line - it may have just been returned by another request', 'RETURN_EXCEEDS');
        }

        const product = await tx.product.findFirst({ where: { id: saleItem.productId, tenantId: req.user.tenantId } });
        const lineTotal = Number(saleItem.unitPrice) * line.quantity;
        subtotal += lineTotal;
        returnItemsData.push({
          saleItemId: saleItem.id,
          productId: saleItem.productId,
          quantity: line.quantity,
          unitPrice: saleItem.unitPrice,
          lineTotal,
        });

        // A SERVICE-kind line was never stock-deducted at sale time (Phase
        // 1.8) - it must never be "returned" to stock either. Deferred until
        // after the SalesReturn row exists below, so its own id (not the
        // Sale's) can be used as the InventoryTransaction's reference.
        if (product.productKind !== 'SERVICE') {
          cogs += line.quantity * Number(product.purchasePrice);
          stockMutations.push({ productId: product.id, quantity: line.quantity });
        }
      }

      // Proportional tax share of the original sale's own (header-level,
      // not per-line) tax amount - an approximation, since SaleItem carries
      // no per-line tax to allocate exactly. Documented as such (see this
      // phase's report, Known Limitations).
      const tax = Number(sale.subtotal) > 0 ? Math.round((Number(sale.tax) * (subtotal / Number(sale.subtotal))) * 100) / 100 : 0;
      const total = Math.max(subtotal + tax, 0);

      const returnNumber = await nextSequenceNumber(tx.salesReturn, req.user.tenantId, 'SRT', { tx });
      const salesReturn = await tx.salesReturn.create({
        data: {
          tenantId: req.user.tenantId,
          returnNumber,
          saleId,
          customerId: sale.customerId,
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
        const updated = await tx.product.update({ where: { id: move.productId }, data: { stockQuantity: { increment: move.quantity } } });
        await tx.inventoryTransaction.create({
          data: {
            tenantId: req.user.tenantId,
            productId: move.productId,
            warehouseId,
            type: 'SALES_RETURN',
            quantity: move.quantity,
            balanceAfter: updated.stockQuantity,
            reference: salesReturn.id,
            createdById: req.user.id,
          },
        });
      }

      const journalLines = [];
      const [inventoryAccountId, cogsAccountId] = cogs > 0
        ? await Promise.all([getSystemAccountId(tx, req.user.tenantId, 'INVENTORY'), getSystemAccountId(tx, req.user.tenantId, 'COGS')])
        : [null, null];
      if (cogs > 0) {
        journalLines.push({ accountId: inventoryAccountId, debit: cogs, customerId: sale.customerId });
        journalLines.push({ accountId: cogsAccountId, credit: cogs, customerId: sale.customerId });
      }

      let creditNote = null;
      if (issueCreditNote && total > 0 && !sale.customerId) {
        // A walk-in sale has no customer account to hold a credit on (and CreditNote requires one), so the
        // goods coming back are refunded in cash at once: Dr Revenue/Tax, Cr Cash/Bank, with the matching
        // Payment record so the cash reconciliation still ties. (Before this, such a return failed with a 500.)
        const [revenueAccountId, taxPayableAccountId, moneyAccountId] = await Promise.all([
          getSystemAccountId(tx, req.user.tenantId, 'SALES_REVENUE'),
          tax > 0 ? getSystemAccountId(tx, req.user.tenantId, 'TAX_PAYABLE') : null,
          getMoneyAccountId(tx, req.user.tenantId, refundMethod),
        ]);
        journalLines.push({ accountId: revenueAccountId, debit: subtotal });
        if (tax > 0) journalLines.push({ accountId: taxPayableAccountId, debit: tax });
        journalLines.push({ accountId: moneyAccountId, credit: total });
        await tx.payment.create({
          data: {
            tenantId: req.user.tenantId,
            direction: 'OUT',
            amount: total,
            method: refundMethod,
            saleId,
            branchId,
            note: `Cash refund for sales return ${returnNumber}`,
            receiptNumber: await allocateReceiptNumber(tx, req.user.tenantId),
            paidAt: eventTime,
          },
        });
      } else if (issueCreditNote && total > 0) {
        const [revenueAccountId, taxPayableAccountId, receivableAccountId] = await Promise.all([
          getSystemAccountId(tx, req.user.tenantId, 'SALES_REVENUE'),
          tax > 0 ? getSystemAccountId(tx, req.user.tenantId, 'TAX_PAYABLE') : null,
          getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_RECEIVABLE'),
        ]);
        journalLines.push({ accountId: revenueAccountId, debit: subtotal, customerId: sale.customerId });
        if (tax > 0) journalLines.push({ accountId: taxPayableAccountId, debit: tax, customerId: sale.customerId });
        journalLines.push({ accountId: receivableAccountId, credit: total, customerId: sale.customerId });

        const creditNoteNumber = await allocateNoteNumber(tx, req.user.tenantId, 'CN');
        creditNote = await tx.creditNote.create({
          data: {
            tenantId: req.user.tenantId,
            creditNoteNumber,
            customerId: sale.customerId,
            salesReturnId: salesReturn.id,
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
          sourceType: 'SALES_RETURN',
          sourceId: salesReturn.id,
          memo: `Sales return ${returnNumber} against sale ${sale.invoiceNumber}`,
          postedById: req.user.id,
          lines: journalLines,
        });
      }

      return tx.salesReturn.findUnique({ where: { id: salesReturn.id }, include: { items: true, creditNote: true } });
    });
  }

  await logAudit({ req, action: 'SALES_RETURN_CREATE', entity: 'SalesReturn', entityId: result.id, metadata: { saleId, total: result.total }, branchId: result.branchId });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'RETURN_CREATED',
    sourceId: result.id,
    entityType: 'SalesReturn',
    branchId: result.branchId,
    variables: { kind: 'SALES', returnNumber: result.returnNumber, total: Number(result.total) },
    internalTitle: `Sales return recorded: ${result.returnNumber}`,
    internalBody: `A sales return of ${Number(result.total).toFixed(2)} was recorded against sale ${saleId}.`,
  });

  res.status(201).json({ item: result });
});

router.post('/:id/reverse', requirePermission('SALES_RETURN', 'REVERSE'), async (req, res) => {
  const item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.salesReturn.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      include: { items: true, creditNote: true },
    });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(prisma, req.user, existing.branchId);

    if (existing.creditNote && Number(existing.creditNote.refundedAmount) > 0) {
      throw new ConflictError('Cannot reverse a sales return whose linked credit note has already been partially or fully refunded');
    }

    // Atomic guard against a concurrent double-reversal - mirrors Sale's
    // own :id/reverse guard exactly.
    const flipped = await tx.salesReturn.updateMany({
      where: { id: existing.id, status: 'COMPLETED' },
      data: { status: 'REVERSED', reversedAt: new Date() },
    });
    if (flipped.count === 0) throw new ConflictError('Sales return has already been reversed', 'ALREADY_APPLIED');

    const allowNegative = await (async () => {
      const setting = await tx.setting.findUnique({ where: { tenantId_key: { tenantId: req.user.tenantId, key: 'allowNegativeStock' } } });
      return setting?.value === 'true';
    })();

    for (const line of existing.items) {
      await tx.saleItem.update({ where: { id: line.saleItemId }, data: { returnedQuantity: { decrement: Number(line.quantity) } } });

      const product = await tx.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
      if (product.productKind === 'SERVICE') continue;

      let newBalance;
      if (!allowNegative) {
        const claim = await tx.product.updateMany({
          where: { id: product.id, stockQuantity: { gte: Number(line.quantity) } },
          data: { stockQuantity: { decrement: Number(line.quantity) } },
        });
        if (claim.count === 0) throw new ConflictError(`Cannot reverse this return - insufficient current stock of ${product.name}`);
      } else {
        await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { decrement: Number(line.quantity) } } });
      }
      const refreshed = await tx.product.findUnique({ where: { id: product.id }, select: { stockQuantity: true } });
      newBalance = Number(refreshed.stockQuantity);
      await tx.inventoryTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          productId: product.id,
          warehouseId: existing.warehouseId,
          type: 'SALES_RETURN',
          quantity: -Number(line.quantity),
          balanceAfter: newBalance,
          reference: existing.id,
          createdById: req.user.id,
        },
      });
    }

    if (existing.creditNote) {
      // Phase 2.2: credit already applied to invoices must be un-applied first.
      if (Number(existing.creditNote.appliedAmount) > 0) throw new ConflictError('The credit note from this return has been applied to invoices - reverse that application first');
      await tx.creditNote.update({ where: { id: existing.creditNote.id }, data: { status: 'CANCELLED' } });
    }

    const originalEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'SALES_RETURN', sourceId: existing.id, status: 'POSTED' },
    });
    if (originalEntry) {
      await reverseJournalEntry(tx, {
        tenantId: req.user.tenantId,
        sourceEntryId: originalEntry.id,
        sourceType: 'SALES_RETURN_REVERSAL',
        sourceId: existing.id,
        memo: `Reversal of sales return ${existing.returnNumber || existing.id}`,
        postedById: req.user.id,
      });
    }

    return tx.salesReturn.findUnique({ where: { id: existing.id }, include: { items: true, creditNote: true } });
  });

  await logAudit({ req, action: 'SALES_RETURN_REVERSE', entity: 'SalesReturn', entityId: item.id });
  res.json({ item });
});

module.exports = router;
