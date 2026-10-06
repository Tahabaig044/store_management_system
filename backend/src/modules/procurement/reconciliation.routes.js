// Phase 4.3.8 / 4.4.3 / 4.4.5 - procurement reconciliation, dashboard summary, and
// supplier performance. Read-only: nothing here writes to the database. Reuses the
// same PurchaseOrderItem.receivedQuantity / Purchase / GoodsReceipt records the
// rest of procurement already writes - no new ledger or duplicate tracking is
// introduced. Gated on the existing PURCHASE_ORDER:VIEW permission (already granted
// to INVENTORY_STAFF/MANAGEMENT) rather than a new permission key, since this is a
// procurement-specific view, not a general financial report.
const express = require('express');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { NotFoundError } = require('../../utils/errors');
const { branchScopeWhere, assertBranchAccess } = require('../../middleware/branchScope');

const router = express.Router();
router.use(authenticate, requireTenant);

const num = (v) => Number(v ?? 0);

// --- 4.3.8: per-PO reconciliation -----------------------------------------------------------------------------

// Ordered/Received/Billed/Remaining, in quantity and value, per line and in total.
// "Billed" here means "carried into a Purchase record" - every accepted-quantity GRN
// already creates one (goodsReceipts.routes.js), so a line that's Received but not
// yet Billed can only happen if a historical/imported record is inconsistent; this
// report surfaces that rather than assuming it can never occur.
router.get('/purchase-orders/:id/reconciliation', requirePermission('PURCHASE_ORDER', 'VIEW'), async (req, res) => {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: {
      items: { include: { product: { select: { name: true, sku: true } } } },
      grns: { include: { items: true, purchase: { include: { items: true } } } },
    },
  });
  if (!po) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, po.branchId);

  const billedByProduct = new Map();
  for (const grn of po.grns) {
    for (const line of grn.purchase?.items || []) {
      billedByProduct.set(line.productId, (billedByProduct.get(line.productId) || 0) + num(line.quantity));
    }
  }

  const lines = po.items.map((item) => {
    const ordered = num(item.quantity);
    const received = num(item.receivedQuantity);
    const billed = billedByProduct.get(item.productId) || 0;
    const unitCost = num(item.unitCost);
    return {
      productId: item.productId,
      productName: item.product?.name,
      sku: item.product?.sku,
      orderedQty: ordered,
      receivedQty: received,
      billedQty: billed,
      remainingQty: Math.max(ordered - received, 0),
      orderedValue: Math.round(ordered * unitCost * 100) / 100,
      receivedValue: Math.round(received * unitCost * 100) / 100,
      billedValue: Math.round(billed * unitCost * 100) / 100,
      // A discrepancy never silently disappears from this report - see rule 4.3.8.
      flags: [
        received > ordered ? 'OVER_RECEIVED' : null,
        billed > received ? 'BILLED_EXCEEDS_RECEIVED' : null,
      ].filter(Boolean),
    };
  });

  const totals = lines.reduce(
    (acc, l) => ({
      orderedValue: acc.orderedValue + l.orderedValue,
      receivedValue: acc.receivedValue + l.receivedValue,
      billedValue: acc.billedValue + l.billedValue,
    }),
    { orderedValue: 0, receivedValue: 0, billedValue: 0 }
  );

  res.json({
    purchaseOrder: { id: po.id, poNumber: po.poNumber, status: po.status, total: num(po.total) },
    lines,
    totals,
    hasDiscrepancies: lines.some((l) => l.flags.length > 0),
  });
});

// --- 4.4.5: tenant-wide integrity check -----------------------------------------------------------------------

// Detects orphaned/inconsistent procurement records. Never repairs anything - a
// finding here is reported, not silently fixed, per this phase's explicit instruction.
router.get('/summary', requirePermission('PURCHASE_ORDER', 'VIEW'), async (req, res) => {
  const scope = await branchScopeWhere(prisma, req.user);
  const findings = [];

  const pos = await prisma.purchaseOrder.findMany({
    where: { tenantId: req.user.tenantId, ...scope },
    include: { items: true, grns: { include: { purchase: true } } },
  });

  for (const po of pos) {
    for (const item of po.items) {
      if (num(item.receivedQuantity) > num(item.quantity) + 0.001) {
        findings.push({ type: 'OVER_RECEIPT', purchaseOrderId: po.id, poNumber: po.poNumber, productId: item.productId, ordered: num(item.quantity), received: num(item.receivedQuantity) });
      }
    }
    const fullyOrZeroReceived = po.items.every((i) => num(i.receivedQuantity) <= 0.001);
    if (['PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status) && fullyOrZeroReceived) {
      findings.push({ type: 'STATUS_WITHOUT_RECEIPT', purchaseOrderId: po.id, poNumber: po.poNumber, status: po.status });
    }
    for (const grn of po.grns) {
      if (!grn.purchase && grn.items?.length) {
        // A GRN whose lines total zero accepted quantity legitimately has no Purchase
        // (goodsReceipts.routes.js only bills when acceptedSubtotal > 0) - only flag
        // one that looks like it should have billed something.
        const acceptedTotal = (grn.items || []).reduce((s, l) => s + num(l.receivedQuantity), 0);
        if (acceptedTotal > 0) findings.push({ type: 'GRN_WITHOUT_PURCHASE', goodsReceiptId: grn.id, grnNumber: grn.grnNumber, purchaseOrderId: po.id });
      }
    }
  }

  // Orphaned RFQs: a quotation referencing an RFQ that no longer exists cannot occur
  // (foreign key enforced) - what CAN happen is an RFQ left OPEN long past every
  // quotation's own validity, which is worth surfacing as an operational finding
  // even though it isn't a data-integrity bug.
  const staleOpenRfqs = await prisma.rFQ.findMany({
    where: { tenantId: req.user.tenantId, status: 'OPEN', quotations: { every: { validUntil: { lt: new Date() } } } },
    include: { quotations: true },
  });
  for (const rfq of staleOpenRfqs) {
    if (rfq.quotations.length > 0) findings.push({ type: 'RFQ_ALL_QUOTATIONS_EXPIRED', rfqId: rfq.id, rfqNumber: rfq.rfqNumber });
  }

  res.json({
    counts: {
      purchaseOrders: pos.length,
      findings: findings.length,
    },
    findings,
  });
});

// --- 4.4.3: procurement dashboard / reporting ----------------------------------------------------------------

router.get('/dashboard', requirePermission('PURCHASE_ORDER', 'VIEW'), async (req, res) => {
  const scope = await branchScopeWhere(prisma, req.user);
  const { from, to, supplierId } = req.query;
  const dateWhere = {};
  if (from) dateWhere.gte = new Date(from);
  if (to) dateWhere.lte = new Date(to);

  const poWhere = { tenantId: req.user.tenantId, ...scope, ...(supplierId ? { supplierId } : {}) };
  if (from || to) poWhere.createdAt = dateWhere;

  const [statusCounts, pendingApprovalPOs, pendingApprovalPRs, pendingReceiptPOs, supplierTotals] = await Promise.all([
    prisma.purchaseOrder.groupBy({ by: ['status'], where: poWhere, _count: { _all: true }, _sum: { total: true } }),
    prisma.purchaseOrder.count({ where: { ...poWhere, status: 'PENDING_APPROVAL' } }),
    prisma.purchaseRequest.count({ where: { tenantId: req.user.tenantId, ...scope, status: 'PENDING_APPROVAL' } }),
    prisma.purchaseOrder.count({ where: { ...poWhere, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } } }),
    prisma.purchaseOrder.groupBy({ by: ['supplierId'], where: poWhere, _count: { _all: true }, _sum: { total: true }, orderBy: { _sum: { total: 'desc' } }, take: 10 }),
  ]);

  const supplierIds = supplierTotals.map((s) => s.supplierId);
  const suppliers = await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } });
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

  res.json({
    filters: { from: from || null, to: to || null, supplierId: supplierId || null },
    statusSummary: statusCounts.map((s) => ({ status: s.status, count: s._count._all, total: num(s._sum.total) })),
    pendingApprovals: { purchaseOrders: pendingApprovalPOs, purchaseRequests: pendingApprovalPRs },
    pendingReceipts: pendingReceiptPOs,
    topSuppliers: supplierTotals.map((s) => ({ supplierId: s.supplierId, supplierName: supplierName.get(s.supplierId), orderCount: s._count._all, totalValue: num(s._sum.total) })),
  });
});

// --- 4.4.2: supplier performance -------------------------------------------------------------------------------

router.get('/suppliers/:id/performance', requirePermission('PURCHASE_ORDER', 'VIEW'), async (req, res) => {
  const supplier = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!supplier) throw new NotFoundError();

  const [purchases, poAgg, pendingOrders, returns] = await Promise.all([
    prisma.purchase.findMany({ where: { tenantId: req.user.tenantId, supplierId: supplier.id, status: 'RECEIVED' }, select: { total: true, amountPaid: true } }),
    prisma.purchaseOrderItem.findMany({
      where: { purchaseOrder: { tenantId: req.user.tenantId, supplierId: supplier.id } },
      select: { quantity: true, receivedQuantity: true },
    }),
    prisma.purchaseOrder.count({ where: { tenantId: req.user.tenantId, supplierId: supplier.id, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED'] } } }),
    prisma.purchaseReturn.aggregate({ where: { tenantId: req.user.tenantId, supplierId: supplier.id }, _count: { _all: true }, _sum: { total: true } }),
  ]);

  const totalPurchases = purchases.reduce((s, p) => s + num(p.total), 0);
  const outstandingPayable = purchases.reduce((s, p) => s + Math.max(num(p.total) - num(p.amountPaid), 0), 0);
  const orderedQty = poAgg.reduce((s, i) => s + num(i.quantity), 0);
  const receivedQty = poAgg.reduce((s, i) => s + num(i.receivedQuantity), 0);

  res.json({
    supplier: { id: supplier.id, name: supplier.name },
    totalPurchases,
    purchaseCount: purchases.length,
    averagePurchaseValue: purchases.length ? Math.round((totalPurchases / purchases.length) * 100) / 100 : 0,
    orderedVsReceived: { orderedQty, receivedQty, fulfillmentRate: orderedQty > 0 ? Math.round((receivedQty / orderedQty) * 1000) / 10 : null },
    pendingOrders,
    outstandingPayable: Math.round(outstandingPayable * 100) / 100,
    returns: { count: returns._count._all, total: num(returns._sum.total) },
  });
});

module.exports = router;
