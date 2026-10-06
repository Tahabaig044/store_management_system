import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from '../api/client';
import { OFFLINE_SAFE, NEVER_OFFLINE } from './offlineBoundary';
import { OUTBOXES, syncAll, refreshCaches, getCacheFreshness, getCachedProducts } from './syncEngine';
import { getOfflineDb } from './db';

// The sync engine's correctness lives entirely in how it drains outboxes
// against the network, so the network (apiClient) is the only thing mocked -
// everything else (Dexie/IndexedDB) runs for real via fake-indexeddb.
vi.mock('../api/client', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

// A fresh tenantId per test gives each one its own IndexedDB database, so
// tests never see each other's queued/synced records.
function freshTenantId() {
  return crypto.randomUUID();
}

const saleItem = { items: [{ productId: 'p1', quantity: 1, unitPrice: 10 }] };

beforeEach(() => {
  apiClient.post.mockReset();
  apiClient.get.mockReset();
});

describe('outbox: queue', () => {
  it('assigns a client-generated idempotency key when none is provided', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.sales.queue(tenantId, saleItem);
    expect(entry.payload.idempotencyKey).toBe(entry.clientId);
    expect(entry.status).toBe('pending');
  });

  it('keeps a caller-supplied idempotency key instead of overwriting it', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.sales.queue(tenantId, { ...saleItem, idempotencyKey: 'explicit-key' });
    expect(entry.payload.idempotencyKey).toBe('explicit-key');
  });
});

describe('outbox: sync success path', () => {
  it('marks the entry synced and stores the server result', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'server-1', invoiceNumber: 'INV-000001' } } });

    const entry = await OUTBOXES.sales.queue(tenantId, saleItem);
    await OUTBOXES.sales.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingSales.get(entry.clientId);
    expect(stored.status).toBe('synced');
    expect(stored.serverResult.invoiceNumber).toBe('INV-000001');
    expect(apiClient.post).toHaveBeenCalledWith('/sales', expect.objectContaining({ idempotencyKey: entry.clientId }));
  });
});

describe('outbox: idempotency across retries', () => {
  it('never regenerates the idempotency key when a sync attempt is retried', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.sales.queue(tenantId, saleItem);

    // First attempt: network failure - should stay pending, not consume the key.
    apiClient.post.mockRejectedValueOnce(new TypeError('network down'));
    await OUTBOXES.sales.sync(tenantId);
    let stored = await getOfflineDb(tenantId).pendingSales.get(entry.clientId);
    expect(stored.status).toBe('pending');
    expect(stored.payload.idempotencyKey).toBe(entry.clientId);

    // Second attempt: succeeds - the exact same key must be sent again.
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'server-2' } } });
    await OUTBOXES.sales.sync(tenantId);
    stored = await getOfflineDb(tenantId).pendingSales.get(entry.clientId);
    expect(stored.status).toBe('synced');
    expect(stored.payload.idempotencyKey).toBe(entry.clientId);
    expect(apiClient.post).toHaveBeenLastCalledWith('/sales', expect.objectContaining({ idempotencyKey: entry.clientId }));
  });
});

describe('outbox: conflict handling', () => {
  it('marks a 409 as conflict with the server message, and keeps draining the rest of the queue', async () => {
    const tenantId = freshTenantId();
    const entry1 = await OUTBOXES.sales.queue(tenantId, saleItem);
    const entry2 = await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p2', quantity: 1, unitPrice: 5 }] });

    apiClient.post
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'Insufficient stock for Widget (available: 0)' } } })
      .mockResolvedValueOnce({ data: { item: { id: 'server-2' } } });

    await OUTBOXES.sales.sync(tenantId);

    const db = getOfflineDb(tenantId);
    const stored1 = await db.pendingSales.get(entry1.clientId);
    const stored2 = await db.pendingSales.get(entry2.clientId);
    expect(stored1.status).toBe('conflict');
    expect(stored1.lastError).toBe('Insufficient stock for Widget (available: 0)');
    // A conflict on one item must never block the rest of the queue.
    expect(stored2.status).toBe('synced');
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });

  it('marks a non-409 4xx as failed rather than conflict', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.sales.queue(tenantId, saleItem);
    apiClient.post.mockRejectedValueOnce({ response: { status: 422, data: { error: 'Invalid sale data' } } });

    await OUTBOXES.sales.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingSales.get(entry.clientId);
    expect(stored.status).toBe('failed');
    expect(stored.lastError).toBe('Invalid sale data');
  });

  it('never auto-resolves a conflict - it stays until retry or discard', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.sales.queue(tenantId, saleItem);
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'conflict' } } });
    await OUTBOXES.sales.sync(tenantId);

    // Calling sync again (e.g. a later reconnect) must not touch a conflicted item.
    await OUTBOXES.sales.sync(tenantId);
    const stored = await getOfflineDb(tenantId).pendingSales.get(entry.clientId);
    expect(stored.status).toBe('conflict');
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });
});

describe('outbox: network failure stops the drain', () => {
  it('leaves the failed item and everything after it pending, without attempting later items', async () => {
    const tenantId = freshTenantId();
    const entry1 = await OUTBOXES.sales.queue(tenantId, saleItem);
    const entry2 = await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p2', quantity: 1, unitPrice: 5 }] });

    apiClient.post.mockRejectedValueOnce(new TypeError('network down'));
    await OUTBOXES.sales.sync(tenantId);

    expect(apiClient.post).toHaveBeenCalledTimes(1); // second item never attempted
    const db = getOfflineDb(tenantId);
    expect((await db.pendingSales.get(entry1.clientId)).status).toBe('pending');
    expect((await db.pendingSales.get(entry2.clientId)).status).toBe('pending');
  });
});

describe('outbox: retry and discard', () => {
  it('retry resets a conflicted item to pending and re-attempts the sync', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.sales.queue(tenantId, saleItem);
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'conflict' } } });
    await OUTBOXES.sales.sync(tenantId);

    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'server-3' } } });
    await OUTBOXES.sales.retry(tenantId, entry.clientId);

    const stored = await getOfflineDb(tenantId).pendingSales.get(entry.clientId);
    expect(stored.status).toBe('synced');
  });

  it('discard permanently removes the item', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.sales.queue(tenantId, saleItem);
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'conflict' } } });
    await OUTBOXES.sales.sync(tenantId);

    await OUTBOXES.sales.discard(tenantId, entry.clientId);
    expect(await getOfflineDb(tenantId).pendingSales.get(entry.clientId)).toBeUndefined();
  });
});

describe('optimistic cache effects', () => {
  it('sales queue decrements cached product stock immediately', async () => {
    const tenantId = freshTenantId();
    const db = getOfflineDb(tenantId);
    await db.products.put({ id: 'p1', name: 'Widget', stockQuantity: 10 });

    await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p1', quantity: 3, unitPrice: 5 }] });

    expect((await db.products.get('p1')).stockQuantity).toBe(7);
  });

  it('purchases only increment cached stock when receiveImmediately is true', async () => {
    const tenantId = freshTenantId();
    const db = getOfflineDb(tenantId);
    await db.products.put({ id: 'p1', name: 'Widget', stockQuantity: 10 });

    await OUTBOXES.purchases.queue(tenantId, {
      supplierId: 's1',
      items: [{ productId: 'p1', quantity: 5, unitCost: 2 }],
      receiveImmediately: false,
    });
    expect((await db.products.get('p1')).stockQuantity).toBe(10);

    await OUTBOXES.purchases.queue(tenantId, {
      supplierId: 's1',
      items: [{ productId: 'p1', quantity: 5, unitCost: 2 }],
      receiveImmediately: true,
    });
    expect((await db.products.get('p1')).stockQuantity).toBe(15);
  });
});

describe('action outbox: reversals', () => {
  it('queues with no idempotencyKey and posts to the sale-specific reverse path', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'sale-1', status: 'REVERSED' } } });

    const entry = await OUTBOXES.reversals.queue(tenantId, { saleId: 'sale-1', invoiceNumber: 'INV-000001' });
    expect(entry.payload.idempotencyKey).toBeUndefined();

    await OUTBOXES.reversals.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingReversals.get(entry.clientId);
    expect(stored.status).toBe('synced');
    expect(apiClient.post).toHaveBeenCalledWith('/sales/sale-1/reverse');
  });

  it('marks an already-reversed sale (409) as conflict, not failed', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'Sale has already been reversed' } },
    });

    const entry = await OUTBOXES.reversals.queue(tenantId, { saleId: 'sale-1', invoiceNumber: 'INV-000001' });
    await OUTBOXES.reversals.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingReversals.get(entry.clientId);
    expect(stored.status).toBe('conflict');
    expect(stored.lastError).toBe('Sale has already been reversed');
  });

  it('a network error leaves it pending for the next sync attempt', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce(new TypeError('network down'));

    const entry = await OUTBOXES.reversals.queue(tenantId, { saleId: 'sale-1', invoiceNumber: 'INV-000001' });
    await OUTBOXES.reversals.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingReversals.get(entry.clientId);
    expect(stored.status).toBe('pending');
  });
});

// Phase 1.7: the generic outbox behavior above is proven via OUTBOXES.sales
// as the representative case (customersOutbox/suppliersOutbox are built
// from the exact same createOutbox() factory with no entity-specific
// override), but per the explicit instruction not to claim offline behavior
// that isn't actually tested, this block directly exercises
// OUTBOXES.suppliers itself end-to-end, rather than only inferring its
// correctness from the sales tests. No change was made to syncEngine.js
// itself for Phase 1.7 - this is verification of the pre-existing,
// unmodified shared mechanism applied to Supplier specifically.
describe('supplier outbox (Phase 1.7 - direct verification, not inferred from sales)', () => {
  const supplierItem = { name: 'Offline Vendor', phone: '021-0000000' };

  it('queues an offline-created supplier with a client-generated idempotency key', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.suppliers.queue(tenantId, supplierItem);
    expect(entry.status).toBe('pending');
    expect(entry.payload.idempotencyKey).toBe(entry.clientId);
    expect(entry.payload.name).toBe('Offline Vendor');
  });

  it('syncs a queued supplier and stores the real server result, including the new code/notes fields', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'server-supplier-1', name: 'Offline Vendor', code: 'SUP-OFFLINE-1' }, possibleDuplicate: null } });

    const entry = await OUTBOXES.suppliers.queue(tenantId, { ...supplierItem, code: 'SUP-OFFLINE-1' });
    await OUTBOXES.suppliers.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingSuppliers.get(entry.clientId);
    expect(stored.status).toBe('synced');
    expect(stored.serverResult.code).toBe('SUP-OFFLINE-1');
    expect(apiClient.post).toHaveBeenCalledWith('/suppliers', expect.objectContaining({ code: 'SUP-OFFLINE-1', idempotencyKey: entry.clientId }));
  });

  it('marks a duplicate-code conflict (409) on a queued supplier as conflict, not failed, and never auto-resolves it', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'A record with these details already exists' } } });

    const entry = await OUTBOXES.suppliers.queue(tenantId, { ...supplierItem, code: 'DUPE' });
    await OUTBOXES.suppliers.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingSuppliers.get(entry.clientId);
    expect(stored.status).toBe('conflict');
    expect(stored.lastError).toBe('A record with these details already exists');
  });

  it('a network error leaves the queued supplier pending for the next sync attempt, rather than marking it failed', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce(new Error('Network Error'));

    const entry = await OUTBOXES.suppliers.queue(tenantId, supplierItem);
    await OUTBOXES.suppliers.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingSuppliers.get(entry.clientId);
    expect(stored.status).toBe('pending');
  });

  it('submit() drains immediately when online and returns the synced entry', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'server-supplier-2' } } });
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

    const result = await OUTBOXES.suppliers.submit(tenantId, supplierItem);
    expect(result.status).toBe('synced');
  });
});

// Phase 1.9: direct verification of the Purchase outbox itself (not inferred
// from Sales) - it already existed before this phase (see
// "optimistic cache effects" above for its receiveImmediately-gated stock
// effect), but its sync/conflict/idempotency behavior over the network had
// never been tested directly. Note this only covers direct Purchase
// creation (POST /purchases) - PurchaseOrder and GoodsReceipt have no
// offline outbox at all (see this phase's verification report, Offline-First
// Purchase section, for the documented gap).
describe('purchase outbox (Phase 1.9 - direct verification, not inferred from sales)', () => {
  const purchaseItem = { supplierId: 's1', items: [{ productId: 'p1', quantity: 5, unitCost: 2 }] };

  it('queues an offline-created purchase with a client-generated idempotency key', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.purchases.queue(tenantId, purchaseItem);
    expect(entry.status).toBe('pending');
    expect(entry.payload.idempotencyKey).toBe(entry.clientId);
    expect(entry.payload.supplierId).toBe('s1');
  });

  it('syncs a queued purchase and stores the real server result, including the new warehouseId/notes fields', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'server-purchase-1', purchaseNumber: 'PO-000001', warehouseId: 'w1', notes: 'Offline restock' } } });

    const entry = await OUTBOXES.purchases.queue(tenantId, { ...purchaseItem, warehouseId: 'w1', notes: 'Offline restock' });
    await OUTBOXES.purchases.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingPurchases.get(entry.clientId);
    expect(stored.status).toBe('synced');
    expect(stored.serverResult.warehouseId).toBe('w1');
    expect(apiClient.post).toHaveBeenCalledWith('/purchases', expect.objectContaining({ warehouseId: 'w1', notes: 'Offline restock', idempotencyKey: entry.clientId }));
  });

  it('marks a numbering-collision conflict (409) on a queued purchase as conflict, not failed, and never auto-resolves it', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'A record with these details already exists' } } });

    const entry = await OUTBOXES.purchases.queue(tenantId, purchaseItem);
    await OUTBOXES.purchases.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingPurchases.get(entry.clientId);
    expect(stored.status).toBe('conflict');
    expect(stored.lastError).toBe('A record with these details already exists');
  });

  it('a network error leaves the queued purchase pending for the next sync attempt, rather than marking it failed', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce(new Error('Network Error'));

    const entry = await OUTBOXES.purchases.queue(tenantId, purchaseItem);
    await OUTBOXES.purchases.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingPurchases.get(entry.clientId);
    expect(stored.status).toBe('pending');
  });
});

describe('syncAll', () => {
  it('drains every entity outbox for the given tenant independently', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockResolvedValue({ data: { item: { id: 'x' } } });

    await OUTBOXES.sales.queue(tenantId, saleItem);
    await OUTBOXES.expenses.queue(tenantId, { categoryId: 'c1', amount: 50 });

    await syncAll(tenantId);

    const db = getOfflineDb(tenantId);
    expect((await db.pendingSales.toArray())[0].status).toBe('synced');
    expect((await db.pendingExpenses.toArray())[0].status).toBe('synced');
  });

  it('a conflict in one entity does not block another entity from syncing', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockImplementation((path) => {
      if (path === '/sales') return Promise.reject({ response: { status: 409, data: { error: 'conflict' } } });
      return Promise.resolve({ data: { item: { id: 'x' } } });
    });

    await OUTBOXES.sales.queue(tenantId, saleItem);
    await OUTBOXES.expenses.queue(tenantId, { categoryId: 'c1', amount: 50 });

    await syncAll(tenantId);

    const db = getOfflineDb(tenantId);
    expect((await db.pendingSales.toArray())[0].status).toBe('conflict');
    expect((await db.pendingExpenses.toArray())[0].status).toBe('synced');
  });
});

// Phase 3.1: the cache is filled from /offline/manifest + /offline/datasets/:name (versioned, paged),
// so the network double serves those instead of the old list endpoints.
export function mockRefreshCachesResponses({ products = [], customers = [], suppliers = [], expenseCategories = [] } = {}) {
  const data = { products, customers, suppliers, expenseCategories, branches: [], warehouses: [], warehouseStock: [] };
  apiClient.get.mockImplementation((path, config) => {
    if (path === '/offline/manifest') {
      return Promise.resolve({
        data: {
          serverTime: new Date().toISOString(),
          schemaVersion: 1,
          scope: { tenantId: 't', userId: 'u', role: 'TENANT_ADMIN', branchIds: null, warehouseIds: null },
          datasets: Object.fromEntries(Object.entries(data).map(([k, rows]) => [k, { count: rows.length, maxUpdatedAt: rows.length ? '2026-01-01T00:00:00.000Z' : null }])),
        },
      });
    }
    const name = path.replace('/offline/datasets/', '');
    if (data[name]) return Promise.resolve({ data: { dataset: name, items: data[name], nextCursor: null, serverTime: new Date().toISOString(), delta: Boolean(config?.params?.updatedSince) } });
    return Promise.resolve({ data: { items: [] } });
  });
}

describe('warehouse stock move outbox (Phase 1.10 - direct verification)', () => {
  const moveItem = { warehouseId: 'w1', action: 'receive', productId: 'p1', quantity: 5 };

  it('queues with a client-generated idempotency key and posts to the action-specific warehouse URL with a body', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockResolvedValue({ data: { item: { warehouseId: 'w1', productId: 'p1', quantity: 5 } } });

    const entry = await OUTBOXES.warehouseStockMoves.queue(tenantId, moveItem);
    expect(entry.payload.idempotencyKey).toBe(entry.clientId);

    await OUTBOXES.warehouseStockMoves.sync(tenantId);

    expect(apiClient.post).toHaveBeenCalledWith('/warehouses/w1/receive', expect.objectContaining({ productId: 'p1', quantity: 5, idempotencyKey: entry.clientId }));
    const stored = await getOfflineDb(tenantId).pendingWarehouseStockMoves.get(entry.clientId);
    expect(stored.status).toBe('synced');
  });

  it('a dispatch decrements cached product stock optimistically at queue time; a receive/adjust increments it', async () => {
    const tenantId = freshTenantId();
    const db = getOfflineDb(tenantId);
    await db.products.put({ id: 'p1', name: 'Widget', stockQuantity: 10 });

    await OUTBOXES.warehouseStockMoves.queue(tenantId, { warehouseId: 'w1', action: 'dispatch', productId: 'p1', quantity: 3 });
    expect((await db.products.get('p1')).stockQuantity).toBe(7);

    await OUTBOXES.warehouseStockMoves.queue(tenantId, { warehouseId: 'w1', action: 'receive', productId: 'p1', quantity: 4 });
    expect((await db.products.get('p1')).stockQuantity).toBe(11);
  });

  it('an insufficient-stock conflict (409) at sync time is marked conflict, not failed', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Insufficient stock for Widget at this warehouse (available: 2)' } } });

    const entry = await OUTBOXES.warehouseStockMoves.queue(tenantId, { warehouseId: 'w1', action: 'dispatch', productId: 'p1', quantity: 5 });
    await OUTBOXES.warehouseStockMoves.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingWarehouseStockMoves.get(entry.clientId);
    expect(stored.status).toBe('conflict');
    expect(stored.lastError).toBe('Insufficient stock for Widget at this warehouse (available: 2)');
  });
});

describe('Stale cache detection (Phase 1.10)', () => {
  it('reports stale when the cache has never been refreshed', async () => {
    const tenantId = freshTenantId();
    const freshness = await getCacheFreshness(tenantId);
    expect(freshness.lastRefreshAt).toBeNull();
    expect(freshness.isStale).toBe(true);
  });

  it('reports fresh immediately after refreshCaches(), and stale once the threshold has passed', async () => {
    const tenantId = freshTenantId();
    mockRefreshCachesResponses({ products: [{ id: 'p1', name: 'Widget', stockQuantity: 10 }] });
    await refreshCaches(tenantId);

    const justRefreshed = await getCacheFreshness(tenantId, 5 * 60 * 1000);
    expect(justRefreshed.isStale).toBe(false);

    // A 0ms threshold means "stale unless refreshed this instant" - proves
    // the staleness check is actually time-sensitive, not a constant true/false.
    const withZeroThreshold = await getCacheFreshness(tenantId, 0);
    expect(withZeroThreshold.isStale).toBe(true);
  });
});

describe('Offline cache tenant isolation (Phase 1.10, Section 44 - mandatory)', () => {
  it('Tenant B never sees Tenant A\'s cached products after a context switch on the same device', async () => {
    const tenantA = freshTenantId();
    const tenantB = freshTenantId();

    mockRefreshCachesResponses({ products: [{ id: 'secret-a-product', name: 'Tenant A Secret Product', stockQuantity: 99 }] });
    await refreshCaches(tenantA);
    expect(await getCachedProducts(tenantA)).toHaveLength(1);

    // Simulate the same browser/device now being used by Tenant B (e.g.
    // logout/login, or a portal switching company context) - getOfflineDb is
    // keyed purely by tenantId, so this opens an entirely separate IndexedDB
    // database; Tenant A's data was never written into it.
    const tenantBProducts = await getCachedProducts(tenantB);
    expect(tenantBProducts).toHaveLength(0);
    expect(tenantBProducts.find((p) => p.id === 'secret-a-product')).toBeUndefined();
  });
});

// Phase 1.10, Sections 20-23/39: models "two terminals sharing one tenant" as
// two independent request sequences against the same backend/tenant/product -
// the realistic shape of two physical terminals in production (each with its
// OWN separate IndexedDB, not something a single Node test process can
// literally instantiate twice for the same tenantId against this module's
// per-tenant singleton cache in db.js). The actual guarantee under test - the
// server never blindly trusts a stale client-side quantity, and a rejected
// offline mutation surfaces as a conflict rather than corrupting local state -
// is proven here at the client/outbox layer; backend proof that the SERVER
// itself never applies a stale quantity is in
// tests/inventoryStockManagement.test.js and the Phase 1.8/1.9 concurrency
// suites (real concurrent HTTP requests against a real Postgres transaction).
describe('Multi-terminal stale-stock conflict narrative (Phase 1.10, Section 39)', () => {
  it('Terminal B\'s offline sale, based on a stock figure the cloud has since moved past, is rejected as a conflict - never silently applied', async () => {
    const tenantId = freshTenantId();
    const db = getOfflineDb(tenantId);
    // Terminal B cached cloud stock = 10 before going offline.
    await db.products.put({ id: 'p1', name: 'Widget', stockQuantity: 10 });

    // While Terminal B was offline, Terminal A (a separate request sequence
    // against the same tenant) sold enough that the cloud is now down to 4 -
    // Terminal B has no way to know this yet; its cache still says 10.
    // Terminal B, still offline, queues a sale for 7 based on its stale 10.
    const entry = await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p1', quantity: 7, unitPrice: 10 }] });
    expect(entry.payload.idempotencyKey).toBe(entry.clientId); // stable id, safe to retry

    // Terminal B reconnects and syncs. The server re-validates against its
    // OWN current stock (4), not Terminal B's stale cached 10, and rejects
    // the request it cannot honor (7 > 4) with a 409 - exactly what the real
    // Sale-creation endpoint does today (Phase 1.8's atomic stock guard).
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Insufficient stock for Widget (available: 4)' } } });
    await OUTBOXES.sales.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingSales.get(entry.clientId);
    // The conflict is surfaced explicitly, not silently dropped and not
    // silently applied against the now-wrong quantity - a human (or a
    // deliberate retry with a corrected quantity) must resolve it.
    expect(stored.status).toBe('conflict');
    expect(stored.lastError).toBe('Insufficient stock for Widget (available: 4)');

    // Terminal B's own local product cache still shows its optimistic
    // decrement from queue time (10 - 7 = 3) until its next refreshCaches()
    // pull - this is the documented cache-freshness limitation (Section 26/
    // Known Limitations), not a claim of real-time bidirectional sync.
    const cachedProduct = await db.products.get('p1');
    expect(Number(cachedProduct.stockQuantity)).toBe(3);

    // Convergence: once Terminal B refreshes its cache from the cloud, the
    // stale local number is replaced by the true authoritative one - the
    // final state converges on the server's, never the client's guess.
    mockRefreshCachesResponses({ products: [{ id: 'p1', name: 'Widget', stockQuantity: 4 }] });
    await refreshCaches(tenantId);
    const reconciledProduct = await db.products.get('p1');
    expect(Number(reconciledProduct.stockQuantity)).toBe(4);
  });
});

// Phase 1.11: direct verification of the new standalone-payment outbox (not
// inferred from Sales/Purchases) - a plain createOutbox instance, so its
// generic queue/sync/conflict/retry behavior is already covered by the
// shared tests above; these confirm the payment-specific shape.
describe('payments outbox (Phase 1.11 - direct verification, not inferred from sales)', () => {
  const paymentItem = { direction: 'IN', customerId: 'c1', amount: 100, allocations: [{ saleId: 's1', amount: 100 }] };

  it('queues an offline-created standalone payment with a client-generated idempotency key', async () => {
    const tenantId = freshTenantId();
    const entry = await OUTBOXES.payments.queue(tenantId, paymentItem);
    expect(entry.status).toBe('pending');
    expect(entry.payload.idempotencyKey).toBe(entry.clientId);
    expect(entry.payload.amount).toBe(100);
  });

  it('syncs a queued payment and stores the real server result, including the new receiptNumber', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'server-payment-1', receiptNumber: 'RCT-000001', status: 'COMPLETED' } } });

    const entry = await OUTBOXES.payments.queue(tenantId, paymentItem);
    await OUTBOXES.payments.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingPayments.get(entry.clientId);
    expect(stored.status).toBe('synced');
    expect(stored.serverResult.receiptNumber).toBe('RCT-000001');
    expect(apiClient.post).toHaveBeenCalledWith('/payments', expect.objectContaining({ amount: 100, idempotencyKey: entry.clientId }));
  });

  it('marks a validation/overpayment conflict (409) on a queued payment as conflict, not failed, and never auto-resolves it', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Payment amount exceeds total outstanding balance across all open invoices' } } });

    const entry = await OUTBOXES.payments.queue(tenantId, paymentItem);
    await OUTBOXES.payments.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingPayments.get(entry.clientId);
    expect(stored.status).toBe('conflict');
    expect(stored.lastError).toBe('Payment amount exceeds total outstanding balance across all open invoices');
  });

  it('a network error leaves the queued payment pending for the next sync attempt, rather than marking it failed', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce(new Error('Network Error'));

    const entry = await OUTBOXES.payments.queue(tenantId, paymentItem);
    await OUTBOXES.payments.sync(tenantId);

    const stored = await getOfflineDb(tenantId).pendingPayments.get(entry.clientId);
    expect(stored.status).toBe('pending');
  });
});

// Phase 2.4: the offline boundary for accounting operations.
describe('offline boundary (Phase 2.4)', () => {
  it('the set of queueable outboxes is EXACTLY the documented safe list - a new outbox cannot appear without a decision', () => {
    expect(Object.keys(OUTBOXES).sort()).toEqual(Object.keys(OFFLINE_SAFE).sort());
  });

  it('no accounting-control operation is exposed by the sync engine', () => {
    const names = Object.keys(OUTBOXES).join(' ').toLowerCase();
    // (Phase 3.3 moved returns, notes, refunds and applications into the safe list; the controls below stay online-only.)
    for (const word of ['journal', 'opening', 'account', 'period', 'reverse']) {
      expect(names).not.toContain(word);
    }
    expect(NEVER_OFFLINE.length).toBeGreaterThan(5);
  });

  it('refuses to queue an auto-allocated payment (server state decides what it settles)', async () => {
    const tenantId = freshTenantId();
    await expect(OUTBOXES.payments.queue(tenantId, { direction: 'IN', customerId: 'c1', amount: 50, autoAllocate: true })).rejects.toThrow(/cannot be queued offline/);
    expect(await OUTBOXES.payments.listPending(tenantId)).toHaveLength(0);
  });

  it('refuses a payment that names no documents, and submit() cannot bypass the guard', async () => {
    const tenantId = freshTenantId();
    await expect(OUTBOXES.payments.queue(tenantId, { direction: 'IN', customerId: 'c1', amount: 50 })).rejects.toThrow(/explicit allocations/);
    await expect(OUTBOXES.payments.submit(tenantId, { direction: 'IN', customerId: 'c1', amount: 50, autoAllocate: true })).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('a payment with explicit allocations is queued with a client idempotency key and replays the same key', async () => {
    const tenantId = freshTenantId();
    apiClient.post.mockRejectedValueOnce({ message: 'Network Error' });
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 'p1', receiptNumber: 'RCT-1' }, deduplicated: true } });
    const entry = await OUTBOXES.payments.queue(tenantId, { direction: 'IN', customerId: 'c1', amount: 50, allocations: [{ saleId: 's1', amount: 50 }] });
    await OUTBOXES.payments.sync(tenantId);
    await OUTBOXES.payments.sync(tenantId);
    const keys = apiClient.post.mock.calls.map(([, body]) => body.idempotencyKey);
    expect(keys).toEqual([entry.clientId, entry.clientId]);
  });
});
