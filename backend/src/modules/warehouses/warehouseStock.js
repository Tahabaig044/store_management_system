// Location-aware inventory core. Product.stockQuantity remains the
// tenant-wide authoritative total used everywhere it always was (POS stock
// checks, reports, accounting COGS) - completely unchanged in meaning.
// WarehouseStock adds a per-location breakdown on top, kept in sync with
// Product.stockQuantity by every function here, so the two numbers can
// never drift apart.
const { ConflictError, NotFoundError } = require('../../utils/errors');

// Idempotent: the first warehouse a tenant ever needs is created lazily and
// reused after that - a single-branch shop that never visits a warehouse
// screen never gets one, so nothing forces unnecessary setup.
//
// Phase 1.3: prefers the explicitly-marked `isDefault` warehouse when one
// exists (set via PATCH /api/warehouses/:id, see warehouses.routes.js), and
// falls back to the original "earliest created" convention otherwise - so a
// tenant that never touches the new isDefault flag sees no change in
// behavior at all. Mirrors ensureDefaultCompany()'s identical Phase 1.1
// upgrade (companyService.js).
async function ensureDefaultWarehouse(tx, tenantId) {
  const marked = await tx.warehouse.findFirst({ where: { tenantId, isDefault: true } });
  if (marked) return marked;

  const existing = await tx.warehouse.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  if (existing) return existing;

  const mainBranch = await tx.branch.findFirst({ where: { tenantId, isMain: true } });
  return tx.warehouse.create({
    data: {
      tenantId,
      branchId: mainBranch?.id ?? null,
      companyId: mainBranch?.companyId ?? null,
      name: 'Main Warehouse',
      isCentral: !mainBranch,
      isDefault: true,
      isActive: true,
    },
  });
}

// Returns a product's WarehouseStock row for a given warehouse, lazily
// materializing it. The safe migration moment happens here: the FIRST time
// any warehouse asks about a product that has no WarehouseStock row
// anywhere yet, that product's full existing Product.stockQuantity is
// assigned to the tenant's default warehouse - never silently split,
// duplicated, or lost.
async function ensureWarehouseStock(tx, tenantId, warehouseId, productId) {
  const existingAny = await tx.warehouseStock.findMany({ where: { productId } });

  if (existingAny.length === 0) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundError('Product not found');
    const defaultWarehouse = await ensureDefaultWarehouse(tx, tenantId);
    const seeded = await tx.warehouseStock.upsert({
      where: { warehouseId_productId: { warehouseId: defaultWarehouse.id, productId } },
      create: { warehouseId: defaultWarehouse.id, productId, quantity: product.stockQuantity },
      update: {},
    });
    if (defaultWarehouse.id === warehouseId) return seeded;
  }

  const row = await tx.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
  if (row) return row;
  return tx.warehouseStock.create({ data: { warehouseId, productId, quantity: 0 } });
}

// The one function any warehouse-scoped stock change must go through.
// Applies `delta` to the warehouse's stock and to Product.stockQuantity in
// the same amount, inside the caller's transaction.
//
// Phase 1.10: both updates are now atomic conditional updates, not a
// read-current-value-then-blind-SET. Before this fix, two concurrent calls
// for the same warehouse+product (e.g. two simultaneous stock adjustments, or
// a stock transfer dispatch racing a direct warehouse dispatch) could both
// read the same stale `stock.quantity`, both pass the insufficient-stock
// check, and then each blindly overwrite the other's WarehouseStock row (a
// lost update) - while Product.stockQuantity's own `{ increment }` still
// applied both deltas correctly, silently diverging the two numbers and
// potentially allowing the warehouse to be drawn down further than the
// pre-check actually allowed. This mirrors the exact atomic-conditional-
// update pattern already used for Sale (Phase 1.8) and Purchase/GRN
// (Phase 1.9) stock mutations.
async function adjustWarehouseStock(tx, { tenantId, warehouseId, productId, delta, allowNegative = false }) {
  const stock = await ensureWarehouseStock(tx, tenantId, warehouseId, productId);

  if (delta >= 0 || allowNegative) {
    // An increase (or an explicitly-permitted decrease past zero) can never
    // be invalidated by a concurrent change to the same row - a plain atomic
    // increment is sufficient, no guard needed.
    const updatedStock = await tx.warehouseStock.update({ where: { id: stock.id }, data: { quantity: { increment: delta } } });
    await tx.product.update({ where: { id: productId }, data: { stockQuantity: { increment: delta } } });
    return updatedStock;
  }

  const claim = await tx.warehouseStock.updateMany({
    where: { id: stock.id, quantity: { gte: -delta } },
    data: { quantity: { increment: delta } },
  });
  if (claim.count === 0) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    const fresh = await tx.warehouseStock.findUnique({ where: { id: stock.id } });
    throw new ConflictError(`Insufficient stock for ${product?.name ?? productId} at this warehouse (available: ${fresh?.quantity ?? 0})`, 'STOCK_INSUFFICIENT', { productId, name: product?.name, available: Number(fresh?.quantity ?? 0), requested: -delta });
  }
  await tx.product.update({ where: { id: productId }, data: { stockQuantity: { increment: delta } } });
  return tx.warehouseStock.findUnique({ where: { id: stock.id } });
}

module.exports = { ensureDefaultWarehouse, ensureWarehouseStock, adjustWarehouseStock };
