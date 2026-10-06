// Phase 1.14: Sales Orders - a NEW, additive module. Distinct from Sale
// (the existing completed-transaction/invoice record, unchanged) - a
// SalesOrder is a pre-fulfillment commitment that carries NO financial or
// inventory effect of its own. Only POST /:id/convert, which creates a real,
// ordinary Sale for some or all of an order's remaining quantity, ever
// touches stock or the ledger - reusing Sale's own atomic stock-deduction
// and journal-posting shape exactly (see sales.routes.js), not a parallel
// invoicing engine. Mirrors the PurchaseOrder -> GoodsReceipt -> Purchase
// conversion pattern (Phase 1.9) applied to the sales side.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { postJournalEntry, getSystemAccountId, getMoneyAccountId, allocateReceiptNumber } = require('../accounting/ledger');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { logAudit } = require('../../middleware/audit');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { triggerEvent } = require('../communication/automation');

const router = express.Router();
router.use(authenticate, requireTenant);

const itemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discount: z.number().nonnegative().default(0),
});

const createSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  items: z.array(itemSchema).min(1),
  tax: z.number().nonnegative().default(0),
  notes: z.string().optional(),
  salesPersonId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
});

async function isNegativeStockAllowed(tenantId) {
  const setting = await prisma.setting.findUnique({ where: { tenantId_key: { tenantId, key: 'allowNegativeStock' } } });
  return setting?.value === 'true';
}

router.get('/', requirePermission('SALES_ORDER', 'VIEW'), async (req, res) => {
  const { customerId, status, sourceQuotationId, branchId, warehouseId, search, from, to } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (customerId) where.customerId = customerId;
  if (status) where.status = status;
  if (sourceQuotationId) where.sourceQuotationId = sourceQuotationId;
  if (search) where.orderNumber = { contains: search, mode: 'insensitive' };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (branchId) {
    await assertBranchAccess(prisma, req.user, branchId);
    where.branchId = branchId;
  }
  if (warehouseId) {
    await assertWarehouseAccess(prisma, req.user, warehouseId);
    where.warehouseId = warehouseId;
  }

  const [items, total] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      include: { customer: { select: { name: true } }, sourceQuotation: { select: { quotationNumber: true } }, items: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.salesOrder.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('SALES_ORDER', 'VIEW'), async (req, res) => {
  const item = await prisma.salesOrder.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: {
      customer: true,
      items: { include: { product: true } },
      sourceQuotation: { select: { quotationNumber: true } },
      sales: { select: { id: true, invoiceNumber: true, total: true, createdAt: true } },
    },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

router.post('/', requirePermission('SALES_ORDER', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid sales order data', parsed.error.flatten());
  const { customerId, items, tax, notes, idempotencyKey } = parsed.data;
  const branchId = parsed.data.branchId ?? req.user.branchId ?? null;
  const warehouseId = parsed.data.warehouseId ?? null;
  const salesPersonId = parsed.data.salesPersonId ?? req.user.id;

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.salesOrder, req.user.tenantId, idempotencyKey, { items: true });
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

  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice - i.discount, 0);
  const totalDiscount = items.reduce((sum, i) => sum + i.discount, 0);
  const total = Math.max(subtotal - totalDiscount + tax, 0);

  const MAX_NUMBER_RETRIES = 8;
  let order;
  for (let attempt = 1; attempt <= MAX_NUMBER_RETRIES; attempt++) {
    try {
      order = await runFinancialTransaction(prisma, async (tx) => {
        const orderNumber = await nextSequenceNumber(tx.salesOrder, req.user.tenantId, 'SO', { tx });
        return tx.salesOrder.create({
          data: {
            tenantId: req.user.tenantId,
            branchId,
            warehouseId,
            orderNumber,
            customerId,
            subtotal,
            discount: totalDiscount,
            tax,
            total,
            notes,
            salesPersonId,
            idempotencyKey,
            items: {
              create: items.map((i) => ({
                productId: i.productId,
                variantId: i.variantId,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                discount: i.discount,
                lineTotal: i.quantity * i.unitPrice - i.discount,
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

  await logAudit({ req, action: 'SALES_ORDER_CREATE', entity: 'SalesOrder', entityId: order.id });
  res.status(201).json({ item: order });
});

const updateSchema = z.object({
  notes: z.string().optional(),
}).strict();

router.patch('/:id', requirePermission('SALES_ORDER', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid update data', parsed.error.flatten());

  const existing = await prisma.salesOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);
  if (existing.status !== 'DRAFT') throw new ConflictError('Only a draft sales order can be edited');

  const item = await prisma.salesOrder.update({ where: { id: existing.id }, data: { notes: parsed.data.notes } });
  await logAudit({ req, action: 'SALES_ORDER_UPDATE', entity: 'SalesOrder', entityId: item.id });
  res.json({ item });
});

router.post('/:id/confirm', requirePermission('SALES_ORDER', 'APPROVE'), async (req, res) => {
  const existing = await prisma.salesOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const flipped = await prisma.salesOrder.updateMany({ where: { id: existing.id, status: 'DRAFT' }, data: { status: 'CONFIRMED' } });
  if (flipped.count === 0) throw new ConflictError('Only a draft sales order can be confirmed');

  const item = await prisma.salesOrder.findUnique({ where: { id: existing.id } });
  await logAudit({ req, action: 'SALES_ORDER_CONFIRM', entity: 'SalesOrder', entityId: item.id, branchId: item.branchId });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'SALES_ORDER_CONFIRMED',
    sourceId: item.id,
    entityType: 'SalesOrder',
    branchId: item.branchId,
    variables: { orderNumber: item.orderNumber, total: Number(item.total) },
    internalTitle: `Sales order confirmed: ${item.orderNumber}`,
    internalBody: `Sales order ${item.orderNumber} (${Number(item.total).toFixed(2)}) was confirmed.`,
  });

  res.json({ item });
});

router.post('/:id/cancel', requirePermission('SALES_ORDER', 'REVERSE'), async (req, res) => {
  const existing = await prisma.salesOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const flipped = await prisma.salesOrder.updateMany({
    where: { id: existing.id, status: { in: ['DRAFT', 'CONFIRMED', 'PROCESSING'] } },
    data: { status: 'CANCELLED' },
  });
  if (flipped.count === 0) throw new ConflictError('This sales order cannot be cancelled from its current state');

  const item = await prisma.salesOrder.findUnique({ where: { id: existing.id } });
  await logAudit({ req, action: 'SALES_ORDER_CANCEL', entity: 'SalesOrder', entityId: item.id, branchId: item.branchId });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'SALES_ORDER_CANCELLED',
    sourceId: item.id,
    entityType: 'SalesOrder',
    branchId: item.branchId,
    variables: { orderNumber: item.orderNumber, total: Number(item.total) },
    internalTitle: `Sales order cancelled: ${item.orderNumber}`,
    internalBody: `Sales order ${item.orderNumber} (${Number(item.total).toFixed(2)}) was cancelled.`,
  });

  res.json({ item });
});

const convertSchema = z.object({
  // Optional - when omitted, converts the full remaining quantity of every
  // line (the common "fulfill the whole order at once" case).
  items: z.array(z.object({ salesOrderItemId: z.string().uuid(), quantity: z.number().positive() })).optional(),
  paymentMethod: z.string().default('cash'),
  amountPaid: z.number().nonnegative().optional(),
  idempotencyKey: z.string().optional(),
});

// Sales Order -> Sale. Creates one ORDINARY Sale (not a parallel invoicing
// concept) for some or all of the order's remaining quantity - every
// existing Sale feature (return, reverse, pay, reporting) works on the
// result unchanged. Gated on SALE:CREATE (the permission for the document
// actually being created), not a separate SALES_ORDER:CONVERT action.
router.post('/:id/convert', requirePermission('SALE', 'CREATE'), async (req, res) => {
  const parsed = convertSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ValidationError('Invalid conversion data', parsed.error.flatten());
  const { paymentMethod, idempotencyKey } = parsed.data;

  if (idempotencyKey) {
    const existingSale = await findExistingByIdempotencyKey(prisma.sale, req.user.tenantId, idempotencyKey, { items: true });
    if (existingSale) return res.status(200).json({ item: existingSale, deduplicated: true });
  }

  const order = await prisma.salesOrder.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { items: true } });
  if (!order) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, order.branchId);
  await assertWarehouseAccess(prisma, req.user, order.warehouseId);
  if (!['CONFIRMED', 'PROCESSING'].includes(order.status)) {
    throw new ConflictError('Only a confirmed sales order can be fulfilled');
  }

  const orderItemsById = new Map(order.items.map((i) => [i.id, i]));
  const requestedLines = parsed.data.items ?? order.items.map((i) => ({ salesOrderItemId: i.id, quantity: Number(i.quantity) - Number(i.fulfilledQuantity) })).filter((l) => l.quantity > 0.0001);
  if (requestedLines.length === 0) throw new ValidationError('No remaining quantity to fulfill');

  for (const line of requestedLines) {
    const orderItem = orderItemsById.get(line.salesOrderItemId);
    if (!orderItem) throw new NotFoundError(`Sales order item ${line.salesOrderItemId} not found on this order`);
    // Fast, friendly pre-check only - NOT authoritative. The atomic
    // transaction-scoped claim below is what actually prevents two racing
    // conversions from over-fulfilling the same line (mirrors the identical
    // pattern in goodsReceipts.routes.js/salesReturns.routes.js).
    const remaining = Number(orderItem.quantity) - Number(orderItem.fulfilledQuantity);
    if (line.quantity > remaining + 0.0001) {
      throw new ValidationError(`Cannot fulfill more than the remaining ${remaining} units for this line`);
    }
  }

  const allowNegative = await isNegativeStockAllowed(req.user.tenantId);

  const MAX_INVOICE_NUMBER_RETRIES = 8;
  let sale;
  for (let attempt = 1; attempt <= MAX_INVOICE_NUMBER_RETRIES; attempt++) {
    try {
      sale = await runConvertTransaction();
      break;
    } catch (err) {
      const isInvoiceNumberCollision = err.code === 'P2002' && err.meta?.target?.includes('invoiceNumber');
      if (!isInvoiceNumberCollision || attempt === MAX_INVOICE_NUMBER_RETRIES) throw err;
    }
  }

  async function runConvertTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
      let cogs = 0;
      let subtotal = 0;
      const saleItemsData = [];

      for (const line of requestedLines) {
        const orderItem = orderItemsById.get(line.salesOrderItemId);

        // Authoritative over-fulfillment guard - mirrors
        // PurchaseOrderItem.receivedQuantity's identical Phase 1.9 pattern
        // (itself mirrored by SaleItem.returnedQuantity in Phase 1.13).
        const claim = await tx.salesOrderItem.updateMany({
          where: { id: orderItem.id, fulfilledQuantity: { lte: Number(orderItem.quantity) - line.quantity + 0.0001 } },
          data: { fulfilledQuantity: { increment: line.quantity } },
        });
        if (claim.count === 0) {
          throw new ConflictError('Cannot fulfill more than the remaining quantity for this line - it may have just been fulfilled by another request');
        }

        const product = await tx.product.findFirst({ where: { id: orderItem.productId, tenantId: req.user.tenantId } });
        if (!product) throw new NotFoundError(`Product ${orderItem.productId} not found`);
        if (product.productKind !== 'SERVICE') {
          const resultingStock = Number(product.stockQuantity) - line.quantity;
          if (resultingStock < 0 && !allowNegative) {
            throw new ConflictError(`Insufficient stock for ${product.name} (available: ${product.stockQuantity})`, 'STOCK_INSUFFICIENT');
          }
          cogs += line.quantity * Number(product.purchasePrice);
        }

        const lineTotal = line.quantity * Number(orderItem.unitPrice) - (Number(orderItem.discount) * (line.quantity / Number(orderItem.quantity)));
        subtotal += lineTotal;
        saleItemsData.push({
          productId: orderItem.productId,
          variantId: orderItem.variantId,
          quantity: line.quantity,
          unitPrice: orderItem.unitPrice,
          discount: Math.round(Number(orderItem.discount) * (line.quantity / Number(orderItem.quantity)) * 100) / 100,
          lineTotal: Math.round(lineTotal * 100) / 100,
          salesOrderItemId: orderItem.id,
        });
      }

      // Proportional share of the order's own aggregate tax, mirroring the
      // exact pattern Phase 1.13 established for partial-return tax
      // allocation - no per-line tax exists on SalesOrderItem/SaleItem to
      // allocate more precisely (see this phase's report, Known Limitations).
      const orderSubtotal = Number(order.subtotal);
      const tax = orderSubtotal > 0 ? Math.round((Number(order.tax) * (subtotal / orderSubtotal)) * 100) / 100 : 0;
      const total = Math.max(subtotal + tax, 0);
      const amountPaid = parsed.data.amountPaid ?? 0;
      if (amountPaid > total) throw new ValidationError('Amount paid cannot exceed the converted sale total');

      const invoiceNumber = await nextSequenceNumber(tx.sale, req.user.tenantId, 'INV', { tx });
      const created = await tx.sale.create({
        data: {
          tenantId: req.user.tenantId,
          customerId: order.customerId,
          branchId: order.branchId,
          warehouseId: order.warehouseId,
          salesOrderId: order.id,
          invoiceNumber,
          subtotal,
          discount: saleItemsData.reduce((s, l) => s + Number(l.discount), 0),
          tax,
          total,
          amountPaid,
          paymentMethod,
          paymentStatus: amountPaid >= total ? 'PAID' : amountPaid <= 0 ? 'UNPAID' : 'PARTIAL',
          cashierId: req.user.id,
          idempotencyKey,
          items: { create: saleItemsData },
        },
        include: { items: true, customer: true },
      });

      for (const item of saleItemsData) {
        const product = await tx.product.findUnique({ where: { id: item.productId } });
        if (product.productKind === 'SERVICE') continue;

        if (!allowNegative) {
          const result = await tx.product.updateMany({
            where: { id: product.id, stockQuantity: { gte: item.quantity } },
            data: { stockQuantity: { decrement: item.quantity } },
          });
          if (result.count === 0) throw new ConflictError(`Insufficient stock for ${product.name} (available: ${product.stockQuantity})`, 'STOCK_INSUFFICIENT');
        } else {
          await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { decrement: item.quantity } } });
        }

        const updated = await tx.product.findUnique({ where: { id: product.id }, select: { stockQuantity: true } });
        await tx.inventoryTransaction.create({
          data: {
            tenantId: req.user.tenantId,
            productId: product.id,
            type: 'SALE_DEDUCTION',
            quantity: -item.quantity,
            balanceAfter: Number(updated.stockQuantity),
            reference: created.id,
            createdById: req.user.id,
          },
        });
      }

      if (amountPaid > 0) {
        const receiptNumber = await allocateReceiptNumber(tx, req.user.tenantId);
        await tx.payment.create({
          data: {
            tenantId: req.user.tenantId,
            direction: 'IN',
            amount: amountPaid,
            method: paymentMethod,
            saleId: created.id,
            customerId: order.customerId,
            branchId: order.branchId,
            receiptNumber,
          },
        });
      }

      const netRevenue = subtotal - saleItemsData.reduce((s, l) => s + Number(l.discount), 0);
      const receivable = total - amountPaid;
      const [cashBankAccountId, receivableAccountId, revenueAccountId, taxPayableAccountId, cogsAccountId, inventoryAccountId] = await Promise.all([
        amountPaid > 0 ? getMoneyAccountId(tx, req.user.tenantId, paymentMethod) : null,
        receivable > 0 ? getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_RECEIVABLE') : null,
        getSystemAccountId(tx, req.user.tenantId, 'SALES_REVENUE'),
        tax > 0 ? getSystemAccountId(tx, req.user.tenantId, 'TAX_PAYABLE') : null,
        getSystemAccountId(tx, req.user.tenantId, 'COGS'),
        getSystemAccountId(tx, req.user.tenantId, 'INVENTORY'),
      ]);

      const lines = [];
      if (amountPaid > 0) lines.push({ accountId: cashBankAccountId, debit: amountPaid, customerId: order.customerId });
      if (receivable > 0) lines.push({ accountId: receivableAccountId, debit: receivable, customerId: order.customerId });
      if (netRevenue > 0) lines.push({ accountId: revenueAccountId, credit: netRevenue });
      else if (netRevenue < 0) lines.push({ accountId: revenueAccountId, debit: -netRevenue });
      if (tax > 0) lines.push({ accountId: taxPayableAccountId, credit: tax });
      if (cogs > 0) {
        lines.push({ accountId: cogsAccountId, debit: cogs });
        lines.push({ accountId: inventoryAccountId, credit: cogs });
      }
      if (lines.length >= 2) {
        await postJournalEntry(tx, {
          tenantId: req.user.tenantId,
          branchId: order.branchId,
          date: created.createdAt,
          sourceType: 'SALE',
          sourceId: created.id,
          memo: `Sale ${created.invoiceNumber} (fulfilling order ${order.orderNumber})`,
          postedById: req.user.id,
          lines,
        });
      }

      // Roll the order's own status up to PROCESSING or fully COMPLETED,
      // guarded so it only applies while still in a fulfillable state -
      // the same disclosed, narrow non-linearizable-against-other-lines
      // best-effort rollup pattern as goodsReceipts.routes.js's identical
      // PO status rollup.
      const refreshedItems = await tx.salesOrderItem.findMany({ where: { salesOrderId: order.id } });
      const fullyFulfilled = refreshedItems.every((i) => Number(i.fulfilledQuantity) >= Number(i.quantity) - 0.0001);
      const rollup = await tx.salesOrder.updateMany({
        where: { id: order.id, status: { in: ['CONFIRMED', 'PROCESSING'] } },
        data: { status: fullyFulfilled ? 'COMPLETED' : 'PROCESSING' },
      });
      if (rollup.count === 0) {
        throw new ConflictError('This sales order is no longer fulfillable - its status changed');
      }

      return created;
    });
  }

  await logAudit({ req, action: 'SALES_ORDER_CONVERT', entity: 'SalesOrder', entityId: order.id, metadata: { saleId: sale.id } });
  res.status(201).json({ item: sale });
});

module.exports = router;
