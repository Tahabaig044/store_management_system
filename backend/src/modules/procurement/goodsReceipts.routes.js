// Goods Received Note (GRN). This is where the procurement lifecycle
// actually touches inventory and accounting: stock only increases here
// (never at PO approval), and only for the accepted quantity - rejected and
// damaged quantities are recorded for the audit trail but never enter stock
// or cost. Each GRN auto-generates the existing Purchase record (reusing
// its stock/payment/ledger machinery) rather than inventing a parallel
// "supplier invoice" table, per the Phase 5 instruction to integrate with
// existing records instead of duplicating them.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { postJournalEntry, getSystemAccountId } = require('../accounting/ledger');
const { getAccessibleBranchIds, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');

const lineSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
  receivedQuantity: z.number().nonnegative().default(0),
  rejectedQuantity: z.number().nonnegative().default(0),
  damagedQuantity: z.number().nonnegative().default(0),
  note: z.string().optional(),
});

const createSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  notes: z.string().optional(),
  // Optional warehouse attribution - validated via the existing
  // assertWarehouseAccess (Phase 0.4), same pattern as Sale.warehouseId (Phase
  // 1.8). Falls back to the linked PO's own warehouseId when omitted. Like
  // Sale, this is attribution/authorization only and does not yet drive
  // per-warehouse WarehouseStock adjustment.
  warehouseId: z.string().uuid().optional(),
  items: z.array(lineSchema).min(1),
  idempotencyKey: z.string().optional(),
});

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('GOODS_RECEIPT', 'VIEW'), async (req, res) => {
  const { purchaseOrderId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = { tenantId: req.user.tenantId };
  if (purchaseOrderId) where.purchaseOrderId = purchaseOrderId;
  // GoodsReceipt has no branchId of its own - it's scoped via the
  // PurchaseOrder it was received against.
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  if (accessibleBranchIds !== null) where.purchaseOrder = { branchId: { in: accessibleBranchIds } };

  const [items, total] = await Promise.all([
    prisma.goodsReceipt.findMany({
      where,
      include: { items: { include: { product: true } }, purchaseOrder: { include: { supplier: true } }, purchase: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.goodsReceipt.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('GOODS_RECEIPT', 'VIEW'), async (req, res) => {
  const item = await prisma.goodsReceipt.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { items: { include: { product: true } }, purchaseOrder: { include: { supplier: true, items: true } }, purchase: true },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.purchaseOrder?.branchId);
  res.json({ item });
});

router.post('/', requirePermission('GOODS_RECEIPT', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid GRN data', parsed.error.flatten());
  const { purchaseOrderId, notes, items, idempotencyKey } = parsed.data;
  const warehouseId = parsed.data.warehouseId ?? null;

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.goodsReceipt, req.user.tenantId, idempotencyKey, { items: true, purchase: true });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, tenantId: req.user.tenantId },
    include: { items: true },
  });
  if (!po) throw new NotFoundError('Purchase order not found');
  await assertBranchAccess(prisma, req.user, po.branchId);
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
    throw new ConflictError('Only an approved purchase order can receive goods');
  }
  const effectiveWarehouseId = warehouseId ?? po.warehouseId ?? null;
  if (effectiveWarehouseId) {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: effectiveWarehouseId, tenantId: req.user.tenantId } });
    if (!warehouse) throw new NotFoundError('Warehouse not found');
  }
  await assertWarehouseAccess(prisma, req.user, effectiveWarehouseId);

  const poItemsById = new Map(po.items.map((i) => [i.id, i]));
  for (const line of items) {
    const poItem = poItemsById.get(line.purchaseOrderItemId);
    if (!poItem) throw new NotFoundError(`Purchase order item ${line.purchaseOrderItemId} not found on this PO`);
    // Fast, friendly rejection for the common non-concurrent case only - NOT the
    // authoritative guard. It reads `po.items` from before the transaction, so a
    // concurrent GRN against the same PO could commit in between this check and
    // the transaction below. The atomic, transaction-scoped claim further down is
    // what actually prevents two racing GRNs from over-receiving the same line.
    const totalThisLine = line.receivedQuantity + line.rejectedQuantity + line.damagedQuantity;
    const remaining = Number(poItem.quantity) - Number(poItem.receivedQuantity);
    if (totalThisLine > remaining + 0.0001) {
      throw new ValidationError(`Cannot receive more than the remaining ${remaining} units ordered for this line`);
    }
  }

  const result = await runFinancialTransaction(prisma, async (tx) => {
    // Authoritative over-receiving guard: atomically claim each line's received
    // quantity via a conditional UPDATE before doing anything else. `poItem.quantity`
    // is immutable once a PO is created, so it's safe to use as a fixed threshold
    // here; `receivedQuantity` is re-evaluated by Postgres against the
    // latest-committed row when this UPDATE runs, so a concurrent GRN against the
    // same line blocks on the row lock and then re-checks against our committed
    // total - the two can never together claim more than was ordered (mirrors the
    // atomic-conditional-update pattern already used for Sale stock/reversal races).
    for (const line of items) {
      const poItem = poItemsById.get(line.purchaseOrderItemId);
      const totalThisLine = line.receivedQuantity + line.rejectedQuantity + line.damagedQuantity;
      if (totalThisLine <= 0) continue;
      const claim = await tx.purchaseOrderItem.updateMany({
        where: {
          id: poItem.id,
          receivedQuantity: { lte: Number(poItem.quantity) - totalThisLine + 0.0001 },
        },
        data: { receivedQuantity: { increment: totalThisLine } },
      });
      if (claim.count === 0) {
        throw new ConflictError(
          `Cannot receive more than the remaining ordered quantity for this line - it may have just been received by another GRN`
        );
      }
    }

    const grnNumber = await nextSequenceNumber(tx.goodsReceipt, req.user.tenantId, 'GRN', { tx });

    let acceptedSubtotal = 0;
    for (const line of items) {
      const poItem = poItemsById.get(line.purchaseOrderItemId);
      acceptedSubtotal += line.receivedQuantity * Number(poItem.unitCost);
    }
    const poSubtotal = Number(po.subtotal);
    const shareRatio = poSubtotal > 0 ? acceptedSubtotal / poSubtotal : 0;
    const grnDiscount = Math.round(Number(po.discount) * shareRatio * 100) / 100;
    const grnTax = Math.round(Number(po.tax) * shareRatio * 100) / 100;
    const grnTotal = Math.max(acceptedSubtotal - grnDiscount + grnTax, 0);

    // The GRN's own Purchase record ("supplier invoice" for this shipment) -
    // created RECEIVED (goods are physically in-hand) with amountPaid=0;
    // payment is a separate later step via POST /purchases/:id/pay.
    let purchase = null;
    if (acceptedSubtotal > 0) {
      const purchaseNumber = await nextSequenceNumber(tx.purchase, req.user.tenantId, 'INV-PO', { tx });
      purchase = await tx.purchase.create({
        data: {
          tenantId: req.user.tenantId,
          supplierId: po.supplierId,
          branchId: po.branchId,
          purchaseOrderId: po.id,
          purchaseNumber,
          subtotal: acceptedSubtotal,
          discount: grnDiscount,
          tax: grnTax,
          total: grnTotal,
          amountPaid: 0,
          paymentStatus: 'UNPAID',
          status: 'RECEIVED',
          receivedAt: new Date(),
          createdById: req.user.id,
          items: {
            create: items
              .filter((l) => l.receivedQuantity > 0)
              .map((l) => {
                const poItem = poItemsById.get(l.purchaseOrderItemId);
                return {
                  productId: poItem.productId,
                  quantity: l.receivedQuantity,
                  unitCost: poItem.unitCost,
                  lineTotal: l.receivedQuantity * Number(poItem.unitCost),
                };
              }),
          },
        },
      });

      for (const line of items) {
        if (line.receivedQuantity <= 0) continue;
        const poItem = poItemsById.get(line.purchaseOrderItemId);
        const product = await tx.product.findFirst({ where: { id: poItem.productId, tenantId: req.user.tenantId } });
        // Atomic increment - receiving stock is an unconditional addition, so there's
        // no read-then-write race to guard against (mirrors purchaseService.js's
        // receivePurchaseStock fix for the same class of bug).
        const updated = await tx.product.update({
          where: { id: product.id },
          data: { stockQuantity: { increment: line.receivedQuantity } },
        });
        await tx.inventoryTransaction.create({
          data: {
            tenantId: req.user.tenantId,
            productId: product.id,
            type: 'PURCHASE_RECEIVE',
            quantity: line.receivedQuantity,
            balanceAfter: updated.stockQuantity,
            reference: purchase.id,
            createdById: req.user.id,
          },
        });
      }

      const [inventoryAccountId, inputTaxAccountId, payableAccountId] = await Promise.all([
        acceptedSubtotal - grnDiscount > 0 ? getSystemAccountId(tx, req.user.tenantId, 'INVENTORY') : null,
        grnTax > 0 ? getSystemAccountId(tx, req.user.tenantId, 'INPUT_TAX') : null,
        getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_PAYABLE'),
      ]);
      const goodsCost = acceptedSubtotal - grnDiscount;
      const lines = [];
      if (goodsCost > 0) lines.push({ accountId: inventoryAccountId, debit: goodsCost, supplierId: po.supplierId });
      if (grnTax > 0) lines.push({ accountId: inputTaxAccountId, debit: grnTax, supplierId: po.supplierId });
      lines.push({ accountId: payableAccountId, credit: grnTotal, supplierId: po.supplierId });
      if (lines.length >= 2) {
        await postJournalEntry(tx, {
          tenantId: req.user.tenantId,
          branchId: po.branchId,
          sourceType: 'PURCHASE',
          sourceId: purchase.id,
          memo: `GRN ${grnNumber} for PO ${po.poNumber}`,
          postedById: req.user.id,
          lines,
        });
      }
    }

    // Each PO line's running received total was already claimed atomically above.
    // Roll the PO's own status up to PARTIALLY_RECEIVED or fully RECEIVED, guarded
    // so it only applies while the PO is still in a receivable state - this is a
    // narrower, disclosed best-effort guard (not perfectly linearizable against a
    // second concurrent GRN touching *other* lines of the same PO, which could
    // read this rollup's fullyReceived snapshot slightly stale) but it does stop
    // this GRN from clobbering a PO that was cancelled out from under it.
    const refreshedItems = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
    const fullyReceived = refreshedItems.every((i) => Number(i.receivedQuantity) >= Number(i.quantity) - 0.0001);
    const rollup = await tx.purchaseOrder.updateMany({
      where: { id: po.id, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } },
      data: { status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
    });
    if (rollup.count === 0) {
      throw new ConflictError('This purchase order is no longer receivable - its status changed');
    }

    const grn = await tx.goodsReceipt.create({
      data: {
        tenantId: req.user.tenantId,
        purchaseOrderId: po.id,
        warehouseId: effectiveWarehouseId,
        grnNumber,
        notes,
        idempotencyKey,
        receivedById: req.user.id,
        purchaseId: purchase?.id,
        items: {
          create: items.map((l) => ({
            purchaseOrderItemId: l.purchaseOrderItemId,
            productId: poItemsById.get(l.purchaseOrderItemId).productId,
            receivedQuantity: l.receivedQuantity,
            rejectedQuantity: l.rejectedQuantity,
            damagedQuantity: l.damagedQuantity,
            note: l.note,
          })),
        },
      },
      include: { items: true, purchase: true },
    });

    return grn;
  });

  await logAudit({ req, action: 'GRN_CREATE', entity: 'GoodsReceipt', entityId: result.id });
  res.status(201).json({ item: result });
});

module.exports = router;
