const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { postInventoryAdjustment } = require('../accounting/inventoryPosting');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { INVENTORY_STAFF } = require('../../constants/roles');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { requirePermission } = require('../../middleware/permissions');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const {
  PRODUCT_KINDS,
  PRODUCT_EXTENSIONS_INCLUDE,
  syncExtensionsFromLegacyFields,
  resolveProductKind,
} = require('./productService');

// The barcode field has no DB-level unique constraint (kept schema-additive
// per project convention), so uniqueness is enforced here at write time -
// the single source of truth for both manually-typed and generated barcodes.
async function assertBarcodeUnique(tenantId, barcode, excludeId) {
  if (!barcode) return;
  const conflict = await prisma.product.findFirst({
    where: { tenantId, barcode, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (conflict) throw new ConflictError(`Barcode "${barcode}" is already used by another product`);
}

// Phase 1.5: verifies a supplied brandId/unitId actually belongs to this
// tenant - the same foreign-key ownership-check pattern used everywhere
// else in this codebase (e.g. categoryId just below).
async function assertBrandAndUnitOwnership(tenantId, { brandId, unitId }) {
  if (brandId) {
    const brand = await prisma.brand.findFirst({ where: { id: brandId, tenantId } });
    if (!brand) throw new NotFoundError('Brand not found');
  }
  if (unitId) {
    const unit = await prisma.unitOfMeasure.findFirst({ where: { id: unitId, tenantId } });
    if (!unit) throw new NotFoundError('Unit of measure not found');
  }
}

const PRODUCT_TYPES = ['GENERAL', 'MEDICINE', 'FRAME', 'LENS'];

const createSchema = z.object({
  categoryId: z.string().uuid().optional(),
  type: z.enum(PRODUCT_TYPES).default('GENERAL'),
  // Phase 0.2: universal fields, additive - see docs/phase0-2-architecture-package.md.
  // productKind is optional and derived from `type` when omitted, so every
  // existing caller that only ever sent `type` keeps working unchanged.
  productKind: z.enum(PRODUCT_KINDS).optional(),
  brand: z.string().optional(),
  // Phase 1.5: optional structured references to the new Brand/UnitOfMeasure
  // catalogs - additive alongside the free-text `brand`/`unit` fields above,
  // so a caller that only ever sends the strings keeps working unchanged.
  brandId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  name: z.string().min(1),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  description: z.string().optional(),
  purchasePrice: z.number().nonnegative().default(0),
  sellingPrice: z.number().nonnegative().default(0),
  openingStock: z.number().nonnegative().default(0),
  lowStockThreshold: z.number().nonnegative().default(0),
  unit: z.string().default('pcs'),
  frameBrand: z.string().optional(),
  frameModel: z.string().optional(),
  frameColor: z.string().optional(),
  frameSize: z.string().optional(),
  lensType: z.string().optional(),
  lensMaterial: z.string().optional(),
  lensCoating: z.string().optional(),
  batchNumber: z.string().optional(),
  expiryDate: z.coerce.date().optional(),
});

const updateSchema = createSchema.partial().omit({ openingStock: true }).extend({ isActive: z.boolean().optional() });

const adjustSchema = z.object({
  quantity: z.number().refine((v) => v !== 0, 'Quantity must be non-zero'),
  note: z.string().optional(),
  // Phase 1.10: optional client-generated key so a retried adjustment
  // (flaky connection, offline outbox retry) is recognized as the same
  // operation instead of double-mutating stock - mirrors the identical
  // pattern already used by Purchase/Sale/StockTransfer/GoodsReceipt.
  idempotencyKey: z.string().optional(),
});

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('PRODUCT', 'VIEW'), async (req, res) => {
  const { search, type, productKind, lowStockOnly, includeInactive } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (includeInactive !== 'true') where.isActive = true;
  if (type) where.type = type;
  // Phase 1.4: filter by the universal productKind (PHYSICAL_GOOD/SERVICE) -
  // independent of the legacy `type` filter above, so a tenant can list
  // "just Services" regardless of industry type.
  if (productKind) where.productKind = productKind;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { sku: { contains: search, mode: 'insensitive' } },
      { barcode: { contains: search, mode: 'insensitive' } },
    ];
  }

  let items = await prisma.product.findMany({
    where,
    include: { category: true, ...PRODUCT_EXTENSIONS_INCLUDE },
    orderBy: { name: 'asc' },
    skip,
    take,
  });
  if (lowStockOnly === 'true') {
    items = items.filter((p) => Number(p.stockQuantity) <= Number(p.lowStockThreshold));
  }
  const total = await prisma.product.count({ where });

  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('PRODUCT', 'VIEW'), async (req, res) => {
  const item = await prisma.product.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { category: true, ...PRODUCT_EXTENSIONS_INCLUDE },
  });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.post('/', requirePermission('PRODUCT', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid product data', parsed.error.flatten());
  const { openingStock, ...data } = parsed.data;
  await assertBarcodeUnique(req.user.tenantId, data.barcode);
  if (data.categoryId) {
    const category = await prisma.category.findFirst({ where: { id: data.categoryId, tenantId: req.user.tenantId } });
    if (!category) throw new NotFoundError('Category not found');
  }
  await assertBrandAndUnitOwnership(req.user.tenantId, data);

  const item = await runFinancialTransaction(prisma, async (tx) => {
    const product = await tx.product.create({
      data: {
        ...data,
        tenantId: req.user.tenantId,
        stockQuantity: openingStock,
        productKind: resolveProductKind(data),
      },
    });
    await syncExtensionsFromLegacyFields(tx, { ...data, tenantId: req.user.tenantId, productId: product.id });
    if (openingStock > 0) {
      const txn = await tx.inventoryTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          productId: product.id,
          type: 'OPENING_STOCK',
          quantity: openingStock,
          balanceAfter: openingStock,
          createdById: req.user.id,
        },
      });
      // Phase 2.4: the stock is an asset the moment it exists.
      await postInventoryAdjustment(tx, { tenantId: req.user.tenantId, branchId: req.user.branchId, product, quantity: openingStock, kind: 'OPENING', sourceId: txn.id, postedById: req.user.id });
    }
    return tx.product.findFirst({ where: { id: product.id }, include: { category: true, ...PRODUCT_EXTENSIONS_INCLUDE } });
  });

  await logAudit({ req, action: 'PRODUCT_CREATE', entity: 'Product', entityId: item.id });
  res.status(201).json({ item });
});

router.patch('/:id', requirePermission('PRODUCT', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid product data', parsed.error.flatten());

  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!existing) throw new NotFoundError();
  await assertBarcodeUnique(req.user.tenantId, parsed.data.barcode, existing.id);
  if (parsed.data.categoryId) {
    const category = await prisma.category.findFirst({ where: { id: parsed.data.categoryId, tenantId: req.user.tenantId } });
    if (!category) throw new NotFoundError('Category not found');
  }
  await assertBrandAndUnitOwnership(req.user.tenantId, parsed.data);

  const effectiveType = parsed.data.type ?? existing.type;
  const item = await runFinancialTransaction(prisma, async (tx) => {
    const updated = await tx.product.update({
      where: { id: existing.id },
      data: {
        ...parsed.data,
        ...(parsed.data.productKind || parsed.data.type
          ? { productKind: resolveProductKind({ productKind: parsed.data.productKind, type: effectiveType }) }
          : {}),
      },
    });
    await syncExtensionsFromLegacyFields(tx, { ...parsed.data, type: effectiveType, tenantId: req.user.tenantId, productId: updated.id });
    return tx.product.findFirst({ where: { id: updated.id }, include: { category: true, ...PRODUCT_EXTENSIONS_INCLUDE } });
  });
  await logAudit({ req, action: 'PRODUCT_UPDATE', entity: 'Product', entityId: item.id });
  res.json({ item });
});

router.delete('/:id', requirePermission('PRODUCT', 'DELETE'), async (req, res) => {
  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!existing) throw new NotFoundError();
  const item = await prisma.product.update({
    where: { id: existing.id },
    data: { isActive: false, archivedAt: new Date() },
  });
  await logAudit({ req, action: 'PRODUCT_ARCHIVE', entity: 'Product', entityId: item.id });
  res.json({ item });
});

// Manual stock adjustment - always creates an audit-tracked inventory transaction,
// never mutates stockQuantity directly without a paper trail.
router.post('/:id/adjust-stock', requireRole(...INVENTORY_STAFF), async (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid adjustment data', parsed.error.flatten());
  const { quantity, note, idempotencyKey } = parsed.data;

  if (idempotencyKey) {
    const existingTxn = await findExistingByIdempotencyKey(prisma.inventoryTransaction, req.user.tenantId, idempotencyKey);
    if (existingTxn) {
      const current = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
      if (!current) throw new NotFoundError();
      return res.json({ item: current, deduplicated: true });
    }
  }

  let result;
  try {
  result = await runFinancialTransaction(prisma, async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
    });
    if (!product) throw new NotFoundError();

    // Atomic conditional update (not read-current-value-then-blind-SET): two
    // concurrent adjustments on the same product could otherwise each read
    // the same stale stockQuantity, each independently compute a "safe"
    // newBalance, and together drive stock negative undetected - the same
    // race already fixed for Sale/Purchase/WarehouseStock. An increase can
    // never be invalidated by a concurrent change, so it uses a plain atomic
    // increment; a decrease is guarded by a conditional updateMany whose
    // WHERE is re-evaluated against the latest-committed row when it runs.
    let updated;
    if (quantity >= 0) {
      updated = await tx.product.update({ where: { id: product.id }, data: { stockQuantity: { increment: quantity } } });
    } else {
      const claim = await tx.product.updateMany({
        where: { id: product.id, stockQuantity: { gte: -quantity } },
        data: { stockQuantity: { increment: quantity } },
      });
      if (claim.count === 0) throw new ValidationError('Adjustment would result in negative stock', undefined, 'STOCK_INSUFFICIENT');
      updated = await tx.product.findUnique({ where: { id: product.id } });
    }

    const txn = await tx.inventoryTransaction.create({
      data: {
        tenantId: req.user.tenantId,
        productId: product.id,
        type: quantity > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        quantity,
        balanceAfter: updated.stockQuantity,
        note,
        idempotencyKey,
        createdById: req.user.id,
      },
    });
    await postInventoryAdjustment(tx, { tenantId: req.user.tenantId, branchId: req.user.branchId, product, quantity, memo: `Stock adjustment: ${product.name} - ${note}`, sourceId: txn.id, postedById: req.user.id });
    return updated;
  });
  } catch (err) {
    // Two identical requests racing past the pre-check: answer the loser as a duplicate.
    if (err.code === 'P2002' && idempotencyKey && String(err.meta?.target).includes('idempotencyKey')) {
      const current = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
      if (current) return res.json({ item: current, deduplicated: true });
    }
    throw err;
  }

  await logAudit({ req, action: 'STOCK_ADJUST', entity: 'Product', entityId: result.id, metadata: { quantity, note } });
  res.json({ item: result });
});

// Phase 1.4: Product Variant CRUD. ProductVariant has existed in the schema
// since Phase 0.2 (ADR-6) - declared as a Core Product entity in
// moduleRegistry.js - but had no route at all until now. Variants are a
// sub-resource of their parent Product: they have no independent visibility
// or lifecycle, so they're gated by the same PRODUCT:* permissions as the
// parent (matching e.g. Company's /:id/access sub-resource reusing COMPANY
// authorization) rather than a new PRODUCT_VARIANT permission resource.
async function assertProductOwnership(productId, tenantId) {
  const product = await prisma.product.findFirst({ where: { id: productId, tenantId } });
  if (!product) throw new NotFoundError('Product not found');
  return product;
}

async function assertVariantBarcodeUnique(tenantId, barcode, excludeId) {
  if (!barcode) return;
  const conflict = await prisma.productVariant.findFirst({
    where: { tenantId, barcode, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (conflict) throw new ConflictError(`Barcode "${barcode}" is already used by another variant`);
}

const variantCreateSchema = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  priceOverride: z.number().nonnegative().optional(),
  stockQuantity: z.number().nonnegative().optional(),
});
const variantUpdateSchema = variantCreateSchema.partial().extend({ isActive: z.boolean().optional() });

router.get('/:productId/variants', requirePermission('PRODUCT', 'VIEW'), async (req, res) => {
  await assertProductOwnership(req.params.productId, req.user.tenantId);
  const items = await prisma.productVariant.findMany({
    where: { productId: req.params.productId, tenantId: req.user.tenantId },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ items });
});

router.post('/:productId/variants', requirePermission('PRODUCT', 'CREATE'), async (req, res) => {
  const parsed = variantCreateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid variant data', parsed.error.flatten());
  await assertProductOwnership(req.params.productId, req.user.tenantId);
  await assertVariantBarcodeUnique(req.user.tenantId, parsed.data.barcode);

  const item = await prisma.productVariant.create({
    data: { ...parsed.data, tenantId: req.user.tenantId, productId: req.params.productId },
  });
  await logAudit({ req, action: 'PRODUCT_VARIANT_CREATE', entity: 'ProductVariant', entityId: item.id, metadata: { productId: req.params.productId } });
  res.status(201).json({ item });
});

router.patch('/:productId/variants/:id', requirePermission('PRODUCT', 'UPDATE'), async (req, res) => {
  const parsed = variantUpdateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid variant data', parsed.error.flatten());
  await assertProductOwnership(req.params.productId, req.user.tenantId);

  const existing = await prisma.productVariant.findFirst({
    where: { id: req.params.id, productId: req.params.productId, tenantId: req.user.tenantId },
  });
  if (!existing) throw new NotFoundError();
  await assertVariantBarcodeUnique(req.user.tenantId, parsed.data.barcode, existing.id);

  const item = await prisma.productVariant.update({ where: { id: existing.id }, data: parsed.data });
  await logAudit({ req, action: 'PRODUCT_VARIANT_UPDATE', entity: 'ProductVariant', entityId: item.id, metadata: { changedFields: Object.keys(parsed.data) } });
  res.json({ item });
});

// Soft-delete, matching Product's own archive convention (isActive: false)
// rather than a physical delete - a variant may already be referenced by
// historical sales/purchases once the full Inventory Engine (Phase 1.10)
// exists.
router.delete('/:productId/variants/:id', requirePermission('PRODUCT', 'DELETE'), async (req, res) => {
  await assertProductOwnership(req.params.productId, req.user.tenantId);
  const existing = await prisma.productVariant.findFirst({
    where: { id: req.params.id, productId: req.params.productId, tenantId: req.user.tenantId },
  });
  if (!existing) throw new NotFoundError();

  const item = await prisma.productVariant.update({ where: { id: existing.id }, data: { isActive: false } });
  await logAudit({ req, action: 'PRODUCT_VARIANT_ARCHIVE', entity: 'ProductVariant', entityId: item.id });
  res.json({ item });
});

module.exports = router;
