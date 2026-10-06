// Inter-branch/inter-warehouse stock transfer lifecycle:
// Request -> Approval (where required) -> Dispatch -> In Transit -> Receive
// -> Completed. Source stock only ever decreases at Dispatch; destination
// stock only ever increases at Receive, and only for the accepted quantity
// - short/damaged quantities never enter destination stock. Every step goes
// through warehouseStock.js's adjustWarehouseStock(), which keeps
// Product.stockQuantity in sync automatically.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { adjustWarehouseStock } = require('./warehouseStock');
const { triggerEvent } = require('../communication/automation');
const { getAccessibleWarehouseIds, assertWarehouseAccess } = require('../../middleware/branchScope');
const { requirePermission } = require('../../middleware/permissions');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');

// Phase 0.4: StockTransfer has no warehouse-level "owner" field of its own
// (a transfer spans two warehouses, possibly in different branches - see
// Phase 0.1 database audit), so access is checked directly against its
// source/destination warehouse ids via the warehouse-level scope tier
// (which itself respects branch/company access underneath - see
// branchScope.js's getAccessibleWarehouseIds). Viewing/cancelling a
// transfer requires access to at least one side; dispatching requires
// access to the source warehouse specifically (stock leaves from there);
// receiving requires access to the destination warehouse specifically
// (stock arrives there) - matching where the real-world action happens.
async function assertEitherWarehouseAccess(user, sourceWarehouseId, destinationWarehouseId) {
  const ids = await getAccessibleWarehouseIds(prisma, user);
  if (ids === null) return; // unrestricted
  if ((sourceWarehouseId && ids.includes(sourceWarehouseId)) || (destinationWarehouseId && ids.includes(destinationWarehouseId))) return;
  throw new ForbiddenError('You do not have access to this transfer');
}


async function getApprovalThreshold(tenantId) {
  const setting = await prisma.setting.findUnique({
    where: { tenantId_key: { tenantId, key: 'transferApprovalThreshold' } },
  });
  return setting?.value != null ? Number(setting.value) : null;
}

const createSchema = z.object({
  sourceWarehouseId: z.string().uuid(),
  destinationWarehouseId: z.string().uuid(),
  notes: z.string().optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().positive() })).min(1),
  idempotencyKey: z.string().optional(),
});

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('STOCK_TRANSFER', 'VIEW'), async (req, res) => {
  const { status, warehouseId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = { tenantId: req.user.tenantId };
  if (status) where.status = status;
  if (warehouseId) where.OR = [{ sourceWarehouseId: warehouseId }, { destinationWarehouseId: warehouseId }];

  const accessibleWarehouseIds = await getAccessibleWarehouseIds(prisma, req.user);
  if (accessibleWarehouseIds !== null) {
    where.AND = [{ OR: [{ sourceWarehouseId: { in: accessibleWarehouseIds } }, { destinationWarehouseId: { in: accessibleWarehouseIds } }] }];
  }

  const [items, total] = await Promise.all([
    prisma.stockTransfer.findMany({
      where,
      include: { items: { include: { product: true } }, sourceWarehouse: true, destinationWarehouse: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.stockTransfer.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('STOCK_TRANSFER', 'VIEW'), async (req, res) => {
  const item = await prisma.stockTransfer.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { items: { include: { product: true } }, sourceWarehouse: true, destinationWarehouse: true },
  });
  if (!item) throw new NotFoundError();
  await assertEitherWarehouseAccess(req.user, item.sourceWarehouseId, item.destinationWarehouseId);
  res.json({ item });
});

router.post('/', requirePermission('STOCK_TRANSFER', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid transfer request data', parsed.error.flatten());
  const { sourceWarehouseId, destinationWarehouseId, notes, items, idempotencyKey } = parsed.data;

  if (sourceWarehouseId === destinationWarehouseId) {
    throw new ValidationError('Source and destination warehouses must be different');
  }
  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.stockTransfer, req.user.tenantId, idempotencyKey, { items: true });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const [source, destination] = await Promise.all([
    prisma.warehouse.findFirst({ where: { id: sourceWarehouseId, tenantId: req.user.tenantId } }),
    prisma.warehouse.findFirst({ where: { id: destinationWarehouseId, tenantId: req.user.tenantId } }),
  ]);
  if (!source) throw new NotFoundError('Source warehouse not found');
  if (!destination) throw new NotFoundError('Destination warehouse not found');
  await assertWarehouseAccess(prisma, req.user, source.id);

  let transferValue = 0;
  for (const line of items) {
    const product = await prisma.product.findFirst({ where: { id: line.productId, tenantId: req.user.tenantId } });
    if (!product) throw new NotFoundError(`Product ${line.productId} not found`);
    transferValue += line.quantity * Number(product.purchasePrice);
  }

  const threshold = await getApprovalThreshold(req.user.tenantId);
  const needsApproval = threshold != null && transferValue > threshold;

  const item = await prisma.$transaction(async (tx) => {
    const transferNumber = await nextSequenceNumber(tx.stockTransfer, req.user.tenantId, 'TRF', { tx });
    return tx.stockTransfer.create({
      data: {
        tenantId: req.user.tenantId,
        sourceWarehouseId,
        destinationWarehouseId,
        notes,
        idempotencyKey,
        status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED',
        requestedById: req.user.id,
        approvedById: needsApproval ? null : req.user.id,
        approvedAt: needsApproval ? null : new Date(),
        transferNumber,
        items: { create: items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
      },
      include: { items: { include: { product: true } }, sourceWarehouse: true, destinationWarehouse: true },
    });
  });

  await logAudit({ req, action: 'STOCK_TRANSFER_REQUEST', entity: 'StockTransfer', entityId: item.id });
  res.status(201).json({ item });
});

// Phase 1.10: all status transitions below use an atomic conditional
// updateMany (not a check-then-blind-write) - two concurrent approve/reject/
// cancel/dispatch/receive requests for the same transfer could otherwise
// both read the same pre-transition status, both pass their guard, and both
// apply their effect (e.g. two concurrent dispatches each decrementing
// source stock once, for a total of two decrements from one approved
// transfer). This mirrors the identical pattern already used for
// PurchaseOrder/PurchaseRequest (Phase 1.9) and Sale reversal (Phase 1.8).
router.post('/:id/approve', requirePermission('STOCK_TRANSFER', 'APPROVE'), async (req, res) => {
  const existing = await prisma.stockTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  // Deciding a transfer needs access to at least one side of it, like viewing or cancelling one (a warehouse-
  // restricted approver could otherwise decide transfers between warehouses they cannot see).
  await assertEitherWarehouseAccess(req.user, existing.sourceWarehouseId, existing.destinationWarehouseId);

  const flipped = await prisma.stockTransfer.updateMany({
    where: { id: existing.id, status: 'PENDING_APPROVAL' },
    data: { status: 'APPROVED', approvedById: req.user.id, approvedAt: new Date() },
  });
  if (flipped.count === 0) throw new ConflictError('Only a pending transfer can be approved');
  const item = await prisma.stockTransfer.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'STOCK_TRANSFER_APPROVE', entity: 'StockTransfer', entityId: item.id });
  res.json({ item });
});

router.post('/:id/reject', requirePermission('STOCK_TRANSFER', 'APPROVE'), async (req, res) => {
  const schema = z.object({ reason: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('A rejection reason is required', parsed.error.flatten());

  const existing = await prisma.stockTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  // Deciding a transfer needs access to at least one side of it, like viewing or cancelling one (a warehouse-
  // restricted approver could otherwise decide transfers between warehouses they cannot see).
  await assertEitherWarehouseAccess(req.user, existing.sourceWarehouseId, existing.destinationWarehouseId);

  const flipped = await prisma.stockTransfer.updateMany({
    where: { id: existing.id, status: 'PENDING_APPROVAL' },
    data: { status: 'REJECTED', rejectionReason: parsed.data.reason },
  });
  if (flipped.count === 0) throw new ConflictError('Only a pending transfer can be rejected');
  const item = await prisma.stockTransfer.findFirst({ where: { id: existing.id } });
  await logAudit({ req, action: 'STOCK_TRANSFER_REJECT', entity: 'StockTransfer', entityId: item.id });
  res.json({ item });
});

router.post('/:id/cancel', requirePermission('STOCK_TRANSFER', 'UPDATE'), async (req, res) => {
  const existing = await prisma.stockTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertEitherWarehouseAccess(req.user, existing.sourceWarehouseId, existing.destinationWarehouseId);

  const flipped = await prisma.stockTransfer.updateMany({
    where: { id: existing.id, status: { in: ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED'] } },
    data: { status: 'CANCELLED' },
  });
  if (flipped.count === 0) throw new ConflictError('A dispatched transfer can no longer be cancelled');
  const item = await prisma.stockTransfer.findFirst({ where: { id: existing.id } });
  res.json({ item });
});

// Dispatch: source stock decreases now, for the full requested quantity.
// Only reachable from APPROVED. The status transition is claimed atomically
// FIRST, inside the transaction (Phase 1.10) - a plain pre-transaction read
// (as this handler used to do) could let two concurrent dispatch requests
// both observe APPROVED and both proceed to decrement source stock once
// each, double-dispatching a single approved transfer. Claiming the
// transition via a guarded updateMany means only one concurrent request can
// ever see count > 0; the loser gets a clean 409 before touching any stock.
router.post('/:id/dispatch', requirePermission('STOCK_TRANSFER', 'UPDATE'), async (req, res) => {
  const existing = await prisma.stockTransfer.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { items: true },
  });
  if (!existing) throw new NotFoundError();
  // Dispatch is checked against the SOURCE warehouse specifically - stock
  // leaves from there, so that's the access that actually matters here.
  await assertWarehouseAccess(prisma, req.user, existing.sourceWarehouseId);

  const item = await prisma.$transaction(async (tx) => {
    const claim = await tx.stockTransfer.updateMany({
      where: { id: existing.id, status: 'APPROVED' },
      data: { status: 'IN_TRANSIT', dispatchedById: req.user.id, dispatchedAt: new Date() },
    });
    if (claim.count === 0) throw new ConflictError('Only an approved transfer can be dispatched');

    for (const line of existing.items) {
      const updated = await adjustWarehouseStock(tx, {
        tenantId: req.user.tenantId,
        warehouseId: existing.sourceWarehouseId,
        productId: line.productId,
        delta: -Number(line.quantity),
      });
      await tx.inventoryTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          productId: line.productId,
          warehouseId: existing.sourceWarehouseId,
          type: 'TRANSFER_DISPATCH',
          quantity: -Number(line.quantity),
          balanceAfter: updated.quantity,
          reference: existing.id,
          createdById: req.user.id,
        },
      });
    }
    return tx.stockTransfer.findUnique({
      where: { id: existing.id },
      include: { items: { include: { product: true } }, sourceWarehouse: true, destinationWarehouse: true },
    });
  });

  await logAudit({ req, action: 'STOCK_TRANSFER_DISPATCH', entity: 'StockTransfer', entityId: item.id });
  res.json({ item });
});

// Receive: destination stock increases only for the accepted quantity per
// line; short/damaged quantities are recorded but never enter stock. Only
// reachable from IN_TRANSIT. As with dispatch (Phase 1.10), the status
// transition is claimed atomically first, inside the transaction, so two
// concurrent receive requests for the same transfer can never both credit
// destination stock.
const receiveSchema = z.object({
  items: z.array(z.object({
    productId: z.string().uuid(),
    receivedQuantity: z.number().nonnegative().default(0),
    shortQuantity: z.number().nonnegative().default(0),
    damagedQuantity: z.number().nonnegative().default(0),
  })).min(1),
});

router.post('/:id/receive', requirePermission('STOCK_TRANSFER', 'UPDATE'), async (req, res) => {
  const parsed = receiveSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid receiving data', parsed.error.flatten());

  const existing = await prisma.stockTransfer.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { items: true },
  });
  if (!existing) throw new NotFoundError();
  // Receive is checked against the DESTINATION warehouse specifically -
  // stock arrives there.
  await assertWarehouseAccess(prisma, req.user, existing.destinationWarehouseId);

  const itemsById = new Map(existing.items.map((i) => [i.productId, i]));
  for (const line of parsed.data.items) {
    const transferItem = itemsById.get(line.productId);
    if (!transferItem) throw new NotFoundError(`Product ${line.productId} is not part of this transfer`);
    const total = line.receivedQuantity + line.shortQuantity + line.damagedQuantity;
    if (total > Number(transferItem.quantity) + 0.0001) {
      throw new ValidationError(`Total accounted-for quantity exceeds the ${transferItem.quantity} dispatched for this line`);
    }
  }

  const item = await prisma.$transaction(async (tx) => {
    const claim = await tx.stockTransfer.updateMany({
      where: { id: existing.id, status: 'IN_TRANSIT' },
      data: { status: 'COMPLETED', receivedById: req.user.id, receivedAt: new Date() },
    });
    if (claim.count === 0) throw new ConflictError('Only an in-transit transfer can be received');

    for (const line of parsed.data.items) {
      const transferItem = itemsById.get(line.productId);
      if (line.receivedQuantity > 0) {
        const updated = await adjustWarehouseStock(tx, {
          tenantId: req.user.tenantId,
          warehouseId: existing.destinationWarehouseId,
          productId: line.productId,
          delta: line.receivedQuantity,
        });
        await tx.inventoryTransaction.create({
          data: {
            tenantId: req.user.tenantId,
            productId: line.productId,
            warehouseId: existing.destinationWarehouseId,
            type: 'TRANSFER_RECEIVE',
            quantity: line.receivedQuantity,
            balanceAfter: updated.quantity,
            reference: existing.id,
            createdById: req.user.id,
          },
        });
      }
      await tx.stockTransferItem.update({
        where: { id: transferItem.id },
        data: { receivedQuantity: line.receivedQuantity, shortQuantity: line.shortQuantity, damagedQuantity: line.damagedQuantity },
      });
    }

    return tx.stockTransfer.findUnique({
      where: { id: existing.id },
      include: { items: { include: { product: true } }, sourceWarehouse: true, destinationWarehouse: true },
    });
  });

  await logAudit({ req, action: 'STOCK_TRANSFER_RECEIVE', entity: 'StockTransfer', entityId: item.id });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'TRANSFER_COMPLETED',
    sourceId: item.id,
    internalTitle: 'Stock transfer completed',
    internalBody: `Transfer from ${item.sourceWarehouse?.name || 'source'} to ${item.destinationWarehouse?.name || 'destination'} has been received`,
    variables: { link: `/stock-transfers/${item.id}` },
  });

  res.json({ item });
});

module.exports = router;
