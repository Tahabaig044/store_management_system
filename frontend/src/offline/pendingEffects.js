// Phase 3.1: the local stock effects of work that is queued but not yet accepted by the server.
//
// A queued sale / receiving purchase / warehouse move changes what is physically available NOW,
// so the local cache reflects it immediately (applyOptimisticEffect at queue time). But a fresh
// download from the server knows nothing about work still waiting in the outbox - so after every
// cache refresh these effects are re-applied on top of the authoritative server numbers
// (applyPendingOverlay). Result: the local stock is "server truth, minus/plus what this terminal
// has queued", never a number that forgets an unsynced sale.
//
// Only entries that may still take effect ('pending', 'syncing') are counted; 'conflict' /
// 'failed' were rejected by the server (no effect), 'synced' is already in the server number.
// A 'syncing' entry may already be in a snapshot taken mid-request - counting it again errs on
// the SAFE side (lower stock), and self-corrects on the next refresh.

const LIVE = ['pending', 'syncing'];

// A row that was never downloaded (created locally, or cached before the base existed) has no
// `_baseStock` yet: capture the figure as it is BEFORE the first queued effect touches it, so the
// overlay can always be recomputed from scratch - which is what makes editing a queued entry (whose
// effect changes) exact instead of a fragile "undo the old, apply the new".
const withBase = (row, field) => (row._baseStock !== undefined ? {} : { _baseStock: Number(row[field]) });

export async function decrementCachedStock(db, payload) {
  for (const line of payload.items) {
    const product = await db.products.get(line.productId);
    if (product) await db.products.update(line.productId, { ...withBase(product, 'stockQuantity'), stockQuantity: Number(product.stockQuantity) - Number(line.quantity) });
  }
}

// Phase 5.1: an optical order's items are optional (a free-text-only order has
// none), unlike a Sale's - so this can't just be decrementCachedStock directly.
export async function decrementCachedStockIfItems(db, payload) {
  if (!payload.items?.length) return;
  await decrementCachedStock(db, payload);
}

export async function incrementCachedStockIfReceiving(db, payload) {
  if (!payload.receiveImmediately) return;
  for (const line of payload.items) {
    const product = await db.products.get(line.productId);
    if (product) await db.products.update(line.productId, { ...withBase(product, 'stockQuantity'), stockQuantity: Number(product.stockQuantity) + Number(line.quantity) });
  }
}

// 'receive'/'adjust' apply their quantity as given (adjust's is already signed by the caller),
// 'dispatch' is always a decrease. Updates the tenant-wide product figure and, when this terminal
// holds that warehouse's stock, the per-location row too.
export async function applyWarehouseStockMoveOptimistically(db, payload) {
  const delta = payload.action === 'dispatch' ? -Number(payload.quantity) : Number(payload.quantity);
  const product = await db.products.get(payload.productId);
  if (product) await db.products.update(payload.productId, { ...withBase(product, 'stockQuantity'), stockQuantity: Number(product.stockQuantity) + delta });
  const row = await db.warehouseStock.where('warehouseId').equals(payload.warehouseId).and((r) => r.productId === payload.productId).first();
  if (row) await db.warehouseStock.update(row.id, { ...withBase(row, 'quantity'), quantity: Number(row.quantity) + delta });
}

// Idempotent: every stock figure is first reset to the last authoritative server number
// (`_baseStock`, written by the download), then the live queue is applied once. Running it any number
// of times - after a full download, after a delta that touched only some rows - gives the same result.
export async function applyPendingOverlay(db) {
  await db.products.toCollection().modify((r) => { if (r._baseStock !== undefined) r.stockQuantity = r._baseStock; });
  await db.warehouseStock.toCollection().modify((r) => { if (r._baseStock !== undefined) r.quantity = r._baseStock; });
  const [sales, purchases, moves, opticalOrders] = await Promise.all([
    db.pendingSales.where('status').anyOf(LIVE).sortBy('createdAt'),
    db.pendingPurchases.where('status').anyOf(LIVE).sortBy('createdAt'),
    db.pendingWarehouseStockMoves.where('status').anyOf(LIVE).sortBy('createdAt'),
    db.pendingOpticalOrders.where('status').anyOf(LIVE).sortBy('createdAt'),
  ]);
  for (const s of sales) await decrementCachedStock(db, s.payload);
  for (const p of purchases) await incrementCachedStockIfReceiving(db, p.payload);
  for (const m of moves) await applyWarehouseStockMoveOptimistically(db, m.payload);
  for (const o of opticalOrders) await decrementCachedStockIfItems(db, o.payload);
  await applyReturnOverlay(db);
}

// Phase 3.3: a queued RETURN moves goods too. Goods coming back from a customer are restocked, goods
// going back to a supplier leave the shelf. The productId of each returned line is not part of the
// request (the server knows it from the sale/purchase line), so the form records it in `entry.display`
// as { products: { <lineId>: <productId> }, warehouseId }.
async function shiftStock(db, entry, lineKey, sign) {
  const map = entry.display?.products || {};
  for (const line of entry.payload.items || []) {
    const productId = map[line[lineKey]];
    if (!productId) continue;
    const delta = sign * Number(line.quantity);
    const product = await db.products.get(productId);
    if (product) await db.products.update(productId, { ...withBase(product, 'stockQuantity'), stockQuantity: Number(product.stockQuantity) + delta });
    const warehouseId = entry.display?.warehouseId;
    const row = warehouseId ? await db.warehouseStock.where('warehouseId').equals(warehouseId).and((r) => r.productId === productId).first() : null;
    if (row) await db.warehouseStock.update(row.id, { ...withBase(row, 'quantity'), quantity: Number(row.quantity) + delta });
  }
}
export const applySalesReturnEffect = (db, payload, entry) => shiftStock(db, { ...entry, payload }, 'saleItemId', +1);
export const applyPurchaseReturnEffect = (db, payload, entry) => shiftStock(db, { ...entry, payload }, 'purchaseItemId', -1);

export async function applyReturnOverlay(db) {
  const [salesReturns, purchaseReturns] = await Promise.all([
    db.pendingSalesReturns.where('status').anyOf(LIVE).sortBy('createdAt'),
    db.pendingPurchaseReturns.where('status').anyOf(LIVE).sortBy('createdAt'),
  ]);
  for (const r of salesReturns) await shiftStock(db, r, 'saleItemId', +1);
  for (const r of purchaseReturns) await shiftStock(db, r, 'purchaseItemId', -1);
}
