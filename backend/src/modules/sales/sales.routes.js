const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { resolveEventTime } = require('../../utils/eventTime');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT, SALES_STAFF } = require('../../constants/roles');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { postJournalEntry, reverseJournalEntry, getSystemAccountId, getMoneyAccountId, allocateReceiptNumber, allocateNoteNumber } = require('../accounting/ledger');
const { branchScopeWhere, assertBranchAccess, assertWarehouseAccess } = require('../../middleware/branchScope');
const { triggerEvent } = require('../communication/automation');
const { requirePermission } = require('../../middleware/permissions');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { SIDES, assertDocumentHasNoActiveApplications, withReceiptRetry } = require('../receivables/arapService');

const itemSchema = z.object({
  productId: z.string().uuid(),
  // Phase 1.8: optional attribution to a specific Product Variant (Phase
  // 1.4) - additive, validated below for tenant+product ownership. Does not
  // affect stock deduction, which stays at the Product level (see
  // schema.prisma's comment on SaleItem.variantId).
  variantId: z.string().uuid().optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discount: z.number().nonnegative().default(0),
});

const createSchema = z.object({
  customerId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  // Phase 1.8: optional warehouse attribution - validated via the existing
  // assertWarehouseAccess (Phase 0.4), same as branchId. See schema.prisma's
  // comment on Sale.warehouseId for why this doesn't yet drive per-warehouse
  // stock deduction.
  warehouseId: z.string().uuid().optional(),
  // Phase 5.2: optional link to the clinical visit this sale bills (e.g. a
  // consultation fee sold as a SERVICE-kind product) - additive traceability
  // only, validated for tenant ownership below like every other reference.
  appointmentId: z.string().uuid().optional(),
  items: z.array(itemSchema).min(1),
  discount: z.number().nonnegative().default(0),
  tax: z.number().nonnegative().default(0),
  amountPaid: z.number().nonnegative().optional(),
  paymentMethod: z.string().default('cash'),
  notes: z.string().optional(),
  idempotencyKey: z.string().optional(),
  // Phase 3.2: when an offline terminal actually made the sale (see utils/eventTime.js).
  occurredAt: z.coerce.date().optional(),
});

async function isNegativeStockAllowed(tenantId) {
  const setting = await prisma.setting.findUnique({
    where: { tenantId_key: { tenantId, key: 'allowNegativeStock' } },
  });
  return setting?.value === 'true';
}

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('SALE', 'VIEW'), async (req, res) => {
  const { search, from, to, customerId, status, paymentStatus, branchId, warehouseId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (search) where.invoiceNumber = { contains: search, mode: 'insensitive' };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (customerId) where.customerId = customerId;
  if (status) where.status = status;
  if (paymentStatus) where.paymentStatus = paymentStatus;
  // branchId/warehouseId filters are validated against the caller's own
  // access first (reusing the existing assertBranchAccess/assertWarehouseAccess
  // checks, not new logic) before narrowing `where` - so a restricted user
  // can never use an explicit filter to see into a branch/warehouse the
  // branchScopeWhere() restriction above would otherwise have excluded.
  if (branchId) {
    await assertBranchAccess(prisma, req.user, branchId);
    where.branchId = branchId;
  }
  if (warehouseId) {
    await assertWarehouseAccess(prisma, req.user, warehouseId);
    where.warehouseId = warehouseId;
  }

  const [items, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      include: { customer: true, items: true, cashier: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.sale.count({ where }),
  ]);

  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('SALE', 'VIEW'), async (req, res) => {
  const item = await prisma.sale.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) },
    include: { customer: true, items: { include: { product: true } }, payments: true, cashier: { select: { name: true } } },
  });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.post('/', requirePermission('SALE', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid sale data', parsed.error.flatten());
  const { customerId, items, discount, tax, paymentMethod, notes, idempotencyKey, appointmentId } = parsed.data;
  const branchId = parsed.data.branchId ?? req.user.branchId ?? null;
  const warehouseId = parsed.data.warehouseId ?? null;
  const eventTime = resolveEventTime(parsed.data.occurredAt);

  // Idempotent retry: if this exact operation was already recorded, return it
  // instead of double-selling (important once POS clients start retrying on
  // flaky connections, and a required foundation for Phase 2 offline sync).
  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.sale, req.user.tenantId, idempotencyKey, { items: true });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  if (customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: req.user.tenantId } });
    if (!customer) throw new NotFoundError('Customer not found');
  }
  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }
  await assertBranchAccess(prisma, req.user, branchId);
  if (warehouseId) {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.user.tenantId } });
    if (!warehouse) throw new NotFoundError('Warehouse not found');
  }
  await assertWarehouseAccess(prisma, req.user, warehouseId);
  if (appointmentId) {
    const appointment = await prisma.appointment.findFirst({ where: { id: appointmentId, tenantId: req.user.tenantId } });
    if (!appointment) throw new NotFoundError('Appointment not found');
  }

  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice - i.discount, 0);
  const total = Math.max(subtotal - discount + tax, 0);
  const amountPaid = parsed.data.amountPaid ?? total;
  if (amountPaid > total) throw new ValidationError('Amount paid cannot exceed sale total');

  // Large-discount approval control: a configurable threshold above which
  // only MANAGEMENT can apply the discount - enforced here, not just hidden
  // in the UI, so a direct API call can't bypass it either.
  const totalDiscount = discount + items.reduce((sum, i) => sum + i.discount, 0);
  if (totalDiscount > 0 && !MANAGEMENT.includes(req.user.role)) {
    const thresholdSetting = await prisma.setting.findUnique({
      where: { tenantId_key: { tenantId: req.user.tenantId, key: 'largeDiscountThreshold' } },
    });
    const threshold = thresholdSetting?.value != null ? Number(thresholdSetting.value) : null;
    if (threshold != null && totalDiscount > threshold) {
      throw new ConflictError('This discount exceeds the configured threshold and requires a MANAGEMENT-role user');
    }
  }

  const allowNegative = await isNegativeStockAllowed(req.user.tenantId);

  // Phase 1.8: the shared nextSequenceNumber utility (Phase 0.6) generates
  // an invoice number from a plain per-tenant row count - its own doc
  // comment already discloses this is "not guaranteed gap-free under
  // concurrent creates". Two simultaneous sales for the same tenant can
  // legitimately compute the same next number; whichever transaction
  // commits second then fails on the @@unique([tenantId, invoiceNumber])
  // constraint (Prisma P2002), NOT on stock. Rewriting the shared utility's
  // counting algorithm itself would affect eleven other modules that reuse
  // it (Purchase, PurchaseOrder, RFQ, GoodsReceipt, StockTransfer,
  // OpticalOrder, Patient, JournalEntry, and others) - a materially larger,
  // cross-cutting change outside "Sales Management," so it is not attempted
  // here (see this phase's report, Known Limitations). Instead, Sales
  // specifically retries the whole transaction (which re-derives a fresh
  // number from the now-current count) on exactly this collision, making
  // Sales' own numbering collision-safe without touching the shared utility
  // or any other module that calls it.
  const MAX_INVOICE_NUMBER_RETRIES = 15;
  let sale;
  for (let attempt = 1; attempt <= MAX_INVOICE_NUMBER_RETRIES; attempt++) {
    try {
      sale = await runSaleTransaction();
      break;
    } catch (err) {
      // Two identical requests racing past the pre-check: the loser hits the (tenantId,
      // idempotencyKey) unique index - answer it as the duplicate it is.
      // A duplicate of an operation that already succeeded resolves to that operation, whatever else
      // went wrong for the duplicate (another request with the same key raced it past the pre-check
      // and won: e.g. the stock the winner consumed is why this one now fails).
      if (idempotencyKey) {
        const existing = await findExistingByIdempotencyKey(prisma.sale, req.user.tenantId, idempotencyKey, { items: true });
        if (existing) return res.status(200).json({ item: existing, deduplicated: true });
      }
      const isInvoiceNumberCollision = err.code === 'P2002' && err.meta?.target?.includes('invoiceNumber');
      if (!isInvoiceNumberCollision || attempt === MAX_INVOICE_NUMBER_RETRIES) throw err;
      // Every failed attempt means at least one concurrent request won that round, so the
      // bound must simply exceed the realistic number of simultaneous creates; jitter spreads the retries.
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
    }
  }

  async function runSaleTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
    // Optimistic pre-check + cost capture. This loop is deliberately not the
    // sole source of truth for stock sufficiency - see the atomic deduction
    // loop below, which is what actually prevents overselling under
    // concurrent requests. Rejecting early here just gives a fast, friendly
    // error in the common (non-racing) case before any row is written.
    // Phase 1.8: a SERVICE-kind product (Phase 0.2/1.4) has no stock concept
    // at all (its stockQuantity is always 0 by design) - selling one must
    // never be treated as an insufficient-stock condition.
    let cogs = 0;
    for (const line of items) {
      const product = await tx.product.findFirst({
        where: { id: line.productId, tenantId: req.user.tenantId },
      });
      if (!product) throw new NotFoundError(`Product ${line.productId} not found`);
      // Phase 5.3: a product whose expiry date has already passed must not be sold -
      // this is a genuine gap the Phase 5 audit found (expiry was tracked and
      // reportable, but nothing stopped a sale of it). Checked against real time at
      // the moment of sale, not the pre-check's read time, matching every other
      // guard in this loop.
      if (product.expiryDate && product.expiryDate < new Date()) {
        throw new ConflictError(`${product.name} expired on ${product.expiryDate.toISOString().slice(0, 10)} and cannot be sold`, 'PRODUCT_EXPIRED', { productId: product.id, name: product.name, expiryDate: product.expiryDate });
      }
      if (line.variantId) {
        const variant = await tx.productVariant.findFirst({
          where: { id: line.variantId, tenantId: req.user.tenantId, productId: product.id },
        });
        if (!variant) throw new NotFoundError(`Variant not found for product ${product.name}`);
      }
      if (product.productKind !== 'SERVICE') {
        const resultingStock = Number(product.stockQuantity) - line.quantity;
        if (resultingStock < 0 && !allowNegative) {
          throw new ConflictError(`Insufficient stock for ${product.name} (available: ${product.stockQuantity})`, 'STOCK_INSUFFICIENT', { productId: product.id, name: product.name, available: Number(product.stockQuantity), requested: line.quantity });
        }
      }
      cogs += line.quantity * Number(product.purchasePrice);
    }

    const invoiceNumber = await nextSequenceNumber(tx.sale, req.user.tenantId, 'INV', { tx });
    const created = await tx.sale.create({
      data: {
        tenantId: req.user.tenantId,
        customerId,
        branchId,
        warehouseId,
        appointmentId,
        invoiceNumber,
        createdAt: eventTime,
        subtotal,
        discount,
        tax,
        total,
        amountPaid,
        paymentMethod,
        notes,
        paymentStatus: amountPaid >= total ? 'PAID' : amountPaid <= 0 ? 'UNPAID' : 'PARTIAL',
        cashierId: req.user.id,
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
      include: { items: true, customer: true },
    });

    // Atomic, race-safe stock deduction. The WHERE guard
    // (stockQuantity >= quantity) and the decrement both execute as a single
    // conditional UPDATE at the database level, so two concurrent sales for
    // the same product can never both act on a stale pre-deduction quantity
    // and silently overwrite each other's result (the classic
    // check-then-write lost-update race the pre-check loop above cannot, by
    // itself, prevent). If the guard fails, `count` is 0 and we know -
    // authoritatively, from the actual write attempt, not an earlier read -
    // that stock was insufficient at the moment of deduction; the whole
    // transaction (including the Sale row just created above) rolls back.
    for (const line of items) {
      const product = await tx.product.findUnique({ where: { id: line.productId } });
      if (product.productKind === 'SERVICE') continue;

      if (!allowNegative) {
        const result = await tx.product.updateMany({
          where: { id: product.id, stockQuantity: { gte: line.quantity } },
          data: { stockQuantity: { decrement: line.quantity } },
        });
        if (result.count === 0) {
          throw new ConflictError(`Insufficient stock for ${product.name} (available: ${product.stockQuantity})`, 'STOCK_INSUFFICIENT', { productId: product.id, name: product.name, available: Number(product.stockQuantity), requested: line.quantity });
        }
      } else {
        await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { decrement: line.quantity } } });
      }

      const updated = await tx.product.findUnique({ where: { id: product.id }, select: { stockQuantity: true } });
      await tx.inventoryTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          productId: product.id,
          type: 'SALE_DEDUCTION',
          quantity: -line.quantity,
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
          customerId,
          branchId,
          receiptNumber,
          paidAt: eventTime,
        },
      });
    }

    // Accounting effect: Dr Cash/Bank (what was actually collected) and/or
    // Dr Accounts Receivable (the remaining balance), Cr Sales Revenue (net
    // of discount) and Cr Tax Payable; plus the COGS/Inventory leg so gross
    // profit is a real ledger fact, not just a report-time estimate.
    const netRevenue = subtotal - discount;
    const receivable = total - amountPaid;
    const [cashBankAccountId, receivableAccountId, revenueAccountId, taxPayableAccountId, cogsAccountId, inventoryAccountId] =
      await Promise.all([
        amountPaid > 0 ? getMoneyAccountId(tx, req.user.tenantId, paymentMethod) : null,
        receivable > 0 ? getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_RECEIVABLE') : null,
        getSystemAccountId(tx, req.user.tenantId, 'SALES_REVENUE'),
        tax > 0 ? getSystemAccountId(tx, req.user.tenantId, 'TAX_PAYABLE') : null,
        getSystemAccountId(tx, req.user.tenantId, 'COGS'),
        getSystemAccountId(tx, req.user.tenantId, 'INVENTORY'),
      ]);

    const lines = [];
    if (amountPaid > 0) lines.push({ accountId: cashBankAccountId, debit: amountPaid, customerId });
    if (receivable > 0) lines.push({ accountId: receivableAccountId, debit: receivable, customerId });
    // Journal lines are always non-negative (standard accounting convention) -
    // an edge-case discount larger than the subtotal makes "net revenue"
    // negative, which posts as a debit against Revenue instead of a
    // negative credit.
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
        branchId,
        date: created.createdAt,
        sourceType: 'SALE',
        sourceId: created.id,
        memo: `Sale ${created.invoiceNumber}`,
        postedById: req.user.id,
        lines,
      });
    }

    return created;
    });
  }

  await logAudit({ req, action: 'SALE_CREATE', entity: 'Sale', entityId: sale.id });

  // Runs strictly after the transaction has committed, so a messaging/
  // automation failure can never roll back the sale - it's awaited (rather
  // than left detached) only because this backend runs as Vercel
  // serverless functions, which may freeze the process the instant the
  // response is sent, killing any promise still in flight.
  if (sale.customer?.phone) {
    await triggerEvent(prisma, {
      tenantId: req.user.tenantId,
      event: 'SALE_COMPLETED',
      sourceId: sale.id,
      branchId: sale.branchId,
      customer: sale.customer,
      variables: { customerName: sale.customer.name, invoiceNumber: sale.invoiceNumber, total: Number(sale.total).toFixed(2), amount: Number(sale.total) },
    });
  }

  res.status(201).json({ item: sale });
});

// Phase 1.11: record a LATER payment against a sale that was left
// PARTIAL/UNPAID at creation time - a genuine, previously-missing gap
// (Purchase already had its own :id/pay since Phase 5; Sale had no
// equivalent). Mirrors Purchase's :id/pay pattern exactly: same
// atomic-conditional accumulation guard, same idempotencyKey/receiptNumber
// support, same role gate style (SALES_STAFF here, the Sale-side equivalent
// of Purchase's INVENTORY_STAFF), same "Dr money, Cr the receivable/payable
// account" journal shape (mirrored: Purchase debits Payable/credits cash;
// a Sale payment debits cash and credits Accounts Receivable instead).
router.post('/:id/pay', requireRole(...SALES_STAFF), async (req, res) => {
  const schema = z.object({
    amount: z.number().positive(),
    method: z.string().default('cash'),
    note: z.string().optional(),
    idempotencyKey: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid payment data', parsed.error.flatten());

  if (parsed.data.idempotencyKey) {
    const existingPayment = await findExistingByIdempotencyKey(prisma.payment, req.user.tenantId, parsed.data.idempotencyKey);
    if (existingPayment) {
      const current = await prisma.sale.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
      if (!current) throw new NotFoundError();
      return res.json({ item: current, deduplicated: true });
    }
  }

  let sale;
  try {
  sale = await withReceiptRetry(() => runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.sale.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();
    if (existing.status !== 'COMPLETED') throw new ConflictError('Only a completed (non-reversed) sale can receive a payment', 'DOCUMENT_NOT_OPEN');
    // Phase 2.2: a payment must not cross a branch boundary the caller isn't allowed in.
    await assertBranchAccess(tx, req.user, existing.branchId);

    // Atomic conditional accumulation - two concurrent payments on the same
    // sale could otherwise both read the same stale amountPaid and each
    // compute a newPaid that individually looks valid, together exceeding
    // the total (the identical race already fixed for Purchase's own :id/pay
    // and Sale's own create-time stock deduction, Phase 1.8/1.9). The
    // guard's `lte` threshold is re-evaluated against the latest-committed
    // amountPaid when this UPDATE actually runs.
    const maxPriorPaid = Number(existing.total) - parsed.data.amount;
    const claim = await tx.sale.updateMany({
      where: { id: existing.id, status: 'COMPLETED', amountPaid: { lte: maxPriorPaid + 0.0001 } },
      data: { amountPaid: { increment: parsed.data.amount } },
    });
    if (claim.count === 0) {
      const current = await tx.sale.findUnique({ where: { id: existing.id }, select: { status: true } });
      if (current.status !== 'COMPLETED') throw new ConflictError('Only a completed (non-reversed) sale can receive a payment', 'DOCUMENT_NOT_OPEN');
      throw new ValidationError('Payment would exceed sale total', undefined, 'BALANCE_CHANGED');
    }
    const refreshed = await tx.sale.findUnique({ where: { id: existing.id } });
    const newPaid = Number(refreshed.amountPaid);

    const receiptNumber = await allocateReceiptNumber(tx, req.user.tenantId);
    await tx.payment.create({
      data: {
        tenantId: req.user.tenantId,
        direction: 'IN',
        amount: parsed.data.amount,
        method: parsed.data.method,
        note: parsed.data.note,
        saleId: existing.id,
        customerId: existing.customerId,
        branchId: existing.branchId,
        receiptNumber,
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
      memo: `Payment on sale ${existing.invoiceNumber}`,
      postedById: req.user.id,
      lines: [
        { accountId: cashBankAccountId, debit: parsed.data.amount, customerId: existing.customerId },
        { accountId: receivableAccountId, credit: parsed.data.amount, customerId: existing.customerId },
      ],
    });

    // amountPaid was already atomically incremented above; only
    // paymentStatus (a derived label) needs setting here.
    return tx.sale.update({
      where: { id: existing.id },
      data: { paymentStatus: newPaid >= Number(existing.total) ? 'PAID' : 'PARTIAL' },
    });
  }));
  } catch (err) {
    // Two identical requests racing past the pre-check: the loser hits the
    // (tenantId, idempotencyKey) unique index - answer it as the duplicate it is.
    if (err.code === 'P2002' && parsed.data.idempotencyKey && err.meta?.target?.includes('idempotencyKey')) {
      const current = await prisma.sale.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
      if (current) return res.json({ item: current, deduplicated: true });
    }
    throw err;
  }

  await logAudit({ req, action: 'SALE_PAYMENT_RECORD', entity: 'Sale', entityId: sale.id, metadata: { amount: parsed.data.amount, method: parsed.data.method } });
  res.json({ item: sale });
});

// Reversal instead of deletion - the original sale record is preserved
// (financial transactions must be immutable / reversal-based, never deleted).
router.post('/:id/reverse', requirePermission('SALE', 'REVERSE'), async (req, res) => {
  const sale = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.sale.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(tx, req.user, existing.branchId);

    // Atomic guard against a concurrent double-reversal: two simultaneous
    // reverse requests for the same sale could otherwise both read
    // status: 'COMPLETED' before either writes, and both proceed to restore
    // stock - the same check-then-write race the Sale-create path above is
    // guarded against. Flipping the status here, conditioned on it still
    // being COMPLETED, ensures only one of two racing requests ever
    // proceeds past this point; the other sees count: 0 and fails cleanly
    // with the same "already reversed" error a sequential retry would get.
    const flipped = await tx.sale.updateMany({
      where: { id: existing.id, status: 'COMPLETED' },
      data: { status: 'REVERSED' },
    });
    if (flipped.count === 0) throw new ConflictError('Sale has already been reversed', 'ALREADY_APPLIED');
    // Phase 2.2: credit applied to this invoice would otherwise be stranded on a voided document.
    await assertDocumentHasNoActiveApplications(tx, SIDES.AR, existing.id, req.user.tenantId);

    for (const line of existing.items) {
      const product = await tx.product.findUnique({ where: { id: line.productId } });
      // A SERVICE-kind line was never stock-deducted at sale time (see the
      // create handler above) - it must never be "restored" either.
      if (product.productKind === 'SERVICE') continue;

      await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { increment: Number(line.quantity) } } });
      const updated = await tx.product.findUnique({ where: { id: product.id }, select: { stockQuantity: true } });
      await tx.inventoryTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          productId: product.id,
          type: 'SALE_REVERSAL',
          quantity: line.quantity,
          balanceAfter: Number(updated.stockQuantity),
          reference: existing.id,
          createdById: req.user.id,
        },
      });
    }

    const originalEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'SALE', sourceId: existing.id, status: 'POSTED' },
    });
    if (originalEntry) {
      // Phase 2.4: money already collected from a known customer is not silently handed
      // back by the reversal. Cash settled inside the original entry is booked to the
      // customer's receivable instead (so it stays as their credit, exactly like a payment
      // made later via /pay), and a credit note for everything collected is issued - the
      // customer can be refunded or apply it to another invoice. A walk-in sale has no
      // account to hold a credit on, so it keeps the full mirror (cash goes back).
      // Re-read AFTER the atomic status flip: `existing` was read before it, and a payment that
      // committed while the flip waited on the row lock is already part of amountPaid. From the
      // flip on no further payment can land (settlement requires an open status).
      const settledNow = await tx.sale.findUnique({ where: { id: existing.id }, select: { amountPaid: true } });
      const collected = Number(settledNow.amountPaid);
      const holdsCredit = Boolean(existing.customerId) && collected > 0;
      let settleTo;
      if (holdsCredit) {
        const [receivableId, cashId, bankId] = await Promise.all([
          getSystemAccountId(tx, req.user.tenantId, 'ACCOUNTS_RECEIVABLE'),
          getSystemAccountId(tx, req.user.tenantId, 'CASH'),
          getSystemAccountId(tx, req.user.tenantId, 'BANK'),
        ]);
        settleTo = { accountId: receivableId, partyField: 'customerId', partyId: existing.customerId, moneyAccountIds: [cashId, bankId] };
      }
      await reverseJournalEntry(tx, {
        tenantId: req.user.tenantId,
        sourceEntryId: originalEntry.id,
        sourceType: 'SALE_REVERSAL',
        sourceId: existing.id,
        memo: `Reversal of sale ${existing.invoiceNumber}`,
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
            reason: `Reversal of sale ${existing.invoiceNumber}`,
            reversedSaleId: existing.id,
            createdById: req.user.id,
          },
        });
      }
    }

    return tx.sale.findUnique({ where: { id: existing.id } });
  });

  await logAudit({ req, action: 'SALE_REVERSE', entity: 'Sale', entityId: sale.id, branchId: sale.branchId });

  // Phase 1.15: fire-and-forget, strictly after the transaction has
  // committed - mirrors SALE_COMPLETED's own identical call above exactly.
  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'SALE_CANCELLED',
    sourceId: sale.id,
    entityType: 'Sale',
    branchId: sale.branchId,
    variables: { invoiceNumber: sale.invoiceNumber, total: Number(sale.total) },
    internalTitle: `Sale ${sale.invoiceNumber} reversed`,
    internalBody: `Invoice ${sale.invoiceNumber} (${Number(sale.total).toFixed(2)}) was reversed.`,
  });

  res.json({ item: sale });
});

module.exports = router;
