import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Dexie from 'dexie';
import apiClient from '../api/client';
import { getOfflineDb, setOfflineScope, closeOfflineDb, offlineDbName, adoptLegacyDatabase } from './db';
import {
  syncLocalData as realSync, getFreshness, computeFreshness, markStockPossiblyStale, purgeReadCaches, startLocalDataKeeper,
  getCachedProducts, getCachedWarehouseStock, getCachedBranches, getCachedCustomers, STOCK_MUTATED_EVENT,
} from './localData';
import { OUTBOXES } from './syncEngine';
import { secureState } from './secureStore';
import { unlockFor } from '../test/secure';

// A signed-in terminal has the key that seals personal data; tests that are not about protection get it here.
const withKey = async (tenantId, opts) => {
  if (secureState(tenantId) !== 'unlocked') await unlockFor(tenantId);
  return realSync(tenantId, opts);
};

vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const freshTenant = () => crypto.randomUUID();
const setOnline = (value) => Object.defineProperty(navigator, 'onLine', { value, configurable: true });

// A tiny stand-in for the server side of /api/offline: mutable datasets with versions, keyset paging,
// deltas by updatedSince, per-role forbidden datasets and a scope descriptor.
class FakeServer {
  constructor() {
    this.clock = Date.parse('2026-06-01T00:00:00Z');
    this.data = { products: [], customers: [], suppliers: [], expenseCategories: [], branches: [], warehouses: [], warehouseStock: [] };
    this.forbidden = new Set();
    this.scope = { tenantId: 't', userId: 'u1', role: 'TENANT_ADMIN', branchIds: null, warehouseIds: null };
    this.schemaVersion = 1;
    this.calls = [];
    this.failDatasets = new Set();
  }

  put(name, row) {
    this.clock += 1000;
    const stamped = { isActive: true, ...row, updatedAt: new Date(this.clock).toISOString() };
    const i = this.data[name].findIndex((r) => r.id === row.id);
    if (i >= 0) this.data[name][i] = { ...this.data[name][i], ...stamped };
    else this.data[name].push(stamped);
    return stamped;
  }

  bulk(name, n, make) {
    for (let i = 0; i < n; i += 1) this.data[name].push({ isActive: true, updatedAt: new Date(this.clock).toISOString(), ...make(i) });
  }

  manifest() {
    const datasets = {};
    for (const [name, rows] of Object.entries(this.data)) {
      if (this.forbidden.has(name)) continue;
      const active = rows.filter((r) => r.isActive !== false);
      datasets[name] = { count: active.length, maxUpdatedAt: rows.length ? rows.map((r) => r.updatedAt).sort().pop() : null };
    }
    return { serverTime: new Date(this.clock).toISOString(), schemaVersion: this.schemaVersion, scope: this.scope, datasets };
  }

  dataset(name, { limit = 500, after, updatedSince } = {}) {
    let rows = [...this.data[name]].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (updatedSince) rows = rows.filter((r) => r.updatedAt >= updatedSince);
    else rows = rows.filter((r) => r.isActive !== false);
    if (after) rows = rows.filter((r) => r.id > after);
    const page = rows.slice(0, limit);
    return { dataset: name, items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null, serverTime: new Date(this.clock).toISOString(), delta: Boolean(updatedSince) };
  }

  install() {
    apiClient.get.mockImplementation((path, config) => {
      this.calls.push({ path, params: config?.params });
      if (path === '/offline/manifest') return Promise.resolve({ data: this.manifest() });
      const name = path.replace('/offline/datasets/', '');
      if (this.failDatasets.has(name)) return Promise.reject(new Error('boom'));
      if (this.data[name] && !this.forbidden.has(name)) return Promise.resolve({ data: this.dataset(name, config?.params) });
      return Promise.reject({ response: { status: 403 } });
    });
    return this;
  }

  datasetCalls(name) {
    return this.calls.filter((c) => c.path === `/offline/datasets/${name}`);
  }
}

let server;
const keepers = [];
const keeper = (tenantId) => {
  const stop = startLocalDataKeeper(tenantId);
  keepers.push(stop);
  return stop;
};
beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  setOnline(true);
  setOfflineScope(null);
  server = new FakeServer().install();
});
afterEach(() => {
  while (keepers.length) keepers.pop()();
  vi.useRealTimers();
  setOnline(true);
  setOfflineScope(null);
});

describe('Local data: complete, versioned downloads', () => {
  it('downloads every row across pages - a tenant with more than 100 (or 500) products is not truncated', async () => {
    const tenantId = freshTenant();
    server.bulk('products', 1200, (i) => ({ id: `p${String(i).padStart(5, '0')}`, name: `P${i}`, stockQuantity: 10 }));
    const result = await withKey(tenantId);
    expect(result.ok).toBe(true);
    expect(result.downloaded).toContain('products');
    expect(await getCachedProducts(tenantId)).toHaveLength(1200);
    expect(server.datasetCalls('products')).toHaveLength(3); // 500 + 500 + 200
  }, 30000); // 1200 rows through fake-indexeddb: ~3.5 s alone, more under a loaded full-suite run

  it('a second run with nothing changed costs one cheap manifest request and downloads no dataset', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    server.calls.length = 0;
    const again = await withKey(tenantId);
    expect(again.unchanged).toContain('products');
    expect(again.downloaded).toHaveLength(0);
    expect(server.calls.map((c) => c.path)).toEqual(['/offline/manifest']);
  });

  it('a change downloads only that dataset, as a delta of just the changed rows; deactivated rows are removed locally', async () => {
    const tenantId = freshTenant();
    server.bulk('products', 50, (i) => ({ id: `p${String(i).padStart(3, '0')}`, name: `P${i}`, stockQuantity: 10 }));
    server.put('customers', { id: 'c1', name: 'Ann' });
    await withKey(tenantId);
    server.calls.length = 0;

    server.put('products', { id: 'p007', stockQuantity: 3 });
    server.put('products', { id: 'p008', isActive: false });
    const res = await withKey(tenantId);
    expect(res.downloaded).toEqual(['products']);
    expect(server.datasetCalls('customers')).toHaveLength(0);
    expect(server.datasetCalls('products')[0].params.updatedSince).toBeTruthy();
    const products = await getCachedProducts(tenantId);
    expect(products).toHaveLength(49);
    expect(products.find((p) => p.id === 'p007').stockQuantity).toBe(3);
    expect(products.find((p) => p.id === 'p008')).toBeUndefined();
  });

  it('a dataset the role may not read, or one that fails, never blocks the others', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 5 });
    server.put('customers', { id: 'c1', name: 'Ann' });
    server.put('suppliers', { id: 's1', name: 'Sup' });
    server.forbidden.add('expenseCategories'); // e.g. a cashier
    server.failDatasets.add('suppliers');
    const res = await withKey(tenantId);
    expect(res.forbidden).toContain('expenseCategories');
    expect(res.errors.map((e) => e.name)).toEqual(['suppliers']);
    expect(res.downloaded).toEqual(expect.arrayContaining(['products', 'customers']));
    expect(await getCachedProducts(tenantId)).toHaveLength(1);
    expect(await getCachedCustomers(tenantId)).toHaveLength(1);
  });

  it('downloads per-warehouse stock and the accessible branches/warehouses', async () => {
    const tenantId = freshTenant();
    server.put('branches', { id: 'b1', name: 'Main' });
    server.put('warehouses', { id: 'w1', name: 'Shop', branchId: 'b1' });
    server.put('warehouseStock', { id: 'ws1', warehouseId: 'w1', productId: 'p1', quantity: 12 });
    await withKey(tenantId);
    expect(await getCachedBranches(tenantId)).toHaveLength(1);
    expect((await getCachedWarehouseStock(tenantId, 'w1'))[0].quantity).toBe(12);
  });
});

describe('Online -> offline -> online', () => {
  it('everything stays readable with no network, and no request is made offline', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    server.put('customers', { id: 'c1', name: 'Ann' });
    await withKey(tenantId);

    setOnline(false);
    apiClient.get.mockReset();
    apiClient.get.mockRejectedValue(new Error('Network Error'));
    const res = await withKey(tenantId);
    expect(res).toMatchObject({ ok: false, skipped: 'offline' });
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(await getCachedProducts(tenantId)).toHaveLength(1);
    expect(await getCachedCustomers(tenantId)).toHaveLength(1);
  });

  it('a manifest failure while nominally online resolves quietly and keeps serving the local copy', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    apiClient.get.mockReset();
    apiClient.get.mockRejectedValue(new Error('Network Error'));
    await expect(withKey(tenantId)).resolves.toMatchObject({ ok: false, skipped: 'manifest-unreachable' });
    expect(await getCachedProducts(tenantId)).toHaveLength(1);
  });

  it('going offline flags the stock copy as possibly stale; coming back online refreshes it', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    const stop = keeper(tenantId);
    await withKey(tenantId); // let the keeper's own start-up check finish first
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    await vi.waitFor(async () => expect((await getFreshness(tenantId)).stockStale).toBe(true));
    expect((await getCachedProducts(tenantId))[0].stockQuantity).toBe(10); // still served

    server.put('products', { id: 'p1', stockQuantity: 4 }); // changed elsewhere while this terminal was offline
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(async () => expect((await getCachedProducts(tenantId))[0].stockQuantity).toBe(4));
    expect((await getFreshness(tenantId)).stockStale).toBe(false);
    stop();
  });
});

describe('Online stock changes reach the local cache', () => {
  it('a stock-affecting request made from this app refreshes local stock immediately (debounced)', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    const stop = keeper(tenantId);
    server.put('products', { id: 'p1', stockQuantity: 7 }); // e.g. an adjustment just made online
    window.dispatchEvent(new CustomEvent(STOCK_MUTATED_EVENT));
    window.dispatchEvent(new CustomEvent(STOCK_MUTATED_EVENT)); // a burst collapses into one refresh
    await vi.waitFor(async () => expect((await getCachedProducts(tenantId))[0].stockQuantity).toBe(7), { timeout: 4000 });
    stop();
  });

  it('a change made by ANOTHER terminal is picked up by the periodic keep-fresh check', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    server.put('warehouseStock', { id: 'ws1', warehouseId: 'w1', productId: 'p1', quantity: 10 });
    await withKey(tenantId);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const stop = keeper(tenantId);
      server.put('products', { id: 'p1', stockQuantity: 2 });
      server.put('warehouseStock', { id: 'ws1', quantity: 2 });
      vi.advanceTimersByTime(60 * 1000);
      await vi.waitFor(async () => expect((await getCachedProducts(tenantId))[0].stockQuantity).toBe(2), { timeout: 4000 });
      expect((await getCachedWarehouseStock(tenantId, 'w1'))[0].quantity).toBe(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stock queued on THIS terminal stays deducted after a refresh that does not yet know about it', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p1', quantity: 3, unitPrice: 5 }] });
    expect((await getOfflineDb(tenantId).products.get('p1')).stockQuantity).toBe(7);

    server.put('products', { id: 'p2', name: 'Other', stockQuantity: 1 }); // forces a download
    await withKey(tenantId);
    expect((await getOfflineDb(tenantId).products.get('p1')).stockQuantity).toBe(7); // not reset to the server's 10

    // Re-applying is idempotent: repeated refreshes never double-deduct.
    server.put('products', { id: 'p3', name: 'Third', stockQuantity: 1 });
    await withKey(tenantId);
    server.put('products', { id: 'p1', stockQuantity: 10 });
    await withKey(tenantId);
    expect((await getOfflineDb(tenantId).products.get('p1')).stockQuantity).toBe(7);
  });

  it('once the queued sale is accepted the server number already includes it; a rejected sale never deducts', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    const ok = await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p1', quantity: 3, unitPrice: 5 }] });
    apiClient.post.mockResolvedValueOnce({ data: { item: { id: 's1' } } });
    await OUTBOXES.sales.sync(tenantId);
    expect((await getOfflineDb(tenantId).pendingSales.get(ok.clientId)).status).toBe('synced');

    server.put('products', { id: 'p1', stockQuantity: 7 }); // the server applied the sale
    await withKey(tenantId);
    expect((await getOfflineDb(tenantId).products.get('p1')).stockQuantity).toBe(7); // not 4

    const rejected = await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p1', quantity: 5, unitPrice: 5 }] });
    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Insufficient stock' } } });
    await OUTBOXES.sales.sync(tenantId);
    expect((await getOfflineDb(tenantId).pendingSales.get(rejected.clientId)).status).toBe('conflict');
    server.put('products', { id: 'p9', name: 'Trigger', stockQuantity: 1 });
    await withKey(tenantId);
    expect((await getOfflineDb(tenantId).products.get('p1')).stockQuantity).toBe(7); // the conflict took no stock
  });

  it('a queued warehouse move adjusts both the product figure and that warehouse\'s row, and survives a refresh', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    server.put('warehouseStock', { id: 'ws1', warehouseId: 'w1', productId: 'p1', quantity: 10 });
    await withKey(tenantId);
    await OUTBOXES.warehouseStockMoves.queue(tenantId, { warehouseId: 'w1', action: 'dispatch', productId: 'p1', quantity: 4 });
    server.put('customers', { id: 'c1', name: 'x' });
    server.put('warehouseStock', { id: 'ws1', quantity: 10 }); // forces a re-download of the stock rows
    await withKey(tenantId);
    expect((await getCachedWarehouseStock(tenantId, 'w1'))[0].quantity).toBe(6);
    expect((await getOfflineDb(tenantId).products.get('p1')).stockQuantity).toBe(6);
  });
});

describe('Freshness and stale detection', () => {
  it('is stale before the first download, fresh after it, stale again once the stock TTL passes', async () => {
    const tenantId = freshTenant();
    expect((await getFreshness(tenantId)).everSynced).toBe(false);
    expect((await getFreshness(tenantId)).stockStale).toBe(true);

    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    const now = Date.now();
    const fresh = await getFreshness(tenantId, now);
    expect(fresh.stockStale).toBe(false);
    expect(fresh.datasets.products.ageMs).toBeLessThan(5000);

    const later = await getFreshness(tenantId, now + 3 * 60 * 1000); // stock TTL is 2 minutes
    expect(later.stockStale).toBe(true);
    expect(later.datasets.customers.stale).toBe(false); // master data tolerates 15 minutes
    expect((await getFreshness(tenantId, now + 20 * 60 * 1000)).datasets.customers.stale).toBe(true);
  });

  it('markStockPossiblyStale flags the stock datasets without touching the data', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    await markStockPossiblyStale(tenantId);
    const f = await getFreshness(tenantId);
    expect(f.stockStale).toBe(true);
    expect(await getCachedProducts(tenantId)).toHaveLength(1);
    await withKey(tenantId); // a successful check clears it
    expect((await getFreshness(tenantId)).stockStale).toBe(false);
  });

  it('computeFreshness is a pure function of the stored records', () => {
    const rows = [{ key: 'dataset:products', value: { lastCheckedAt: 1000, count: 1 } }];
    expect(computeFreshness(rows, 1500).stockStale).toBe(false);
    expect(computeFreshness(rows, 1000 + 121000).stockStale).toBe(true);
  });
});

describe('Isolation in local storage', () => {
  it('two users of the same tenant on one device get separate local databases and never see each other\'s data', async () => {
    const tenantId = freshTenant();
    setOfflineScope({ tenantId, userId: 'cashier-branch-1' });
    server.scope = { ...server.scope, tenantId, userId: 'cashier-branch-1', branchIds: ['b1'] };
    server.put('products', { id: 'secret-b1', name: 'Branch 1 only', stockQuantity: 9 });
    await withKey(tenantId);
    await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'secret-b1', quantity: 1, unitPrice: 1 }] });
    const nameA = offlineDbName(tenantId);
    expect(nameA).toContain('__u_cashier-branch-1');

    setOfflineScope({ tenantId, userId: 'cashier-branch-2' });
    expect(offlineDbName(tenantId)).not.toBe(nameA);
    expect(await getCachedProducts(tenantId)).toHaveLength(0);
    expect(await getOfflineDb(tenantId).pendingSales.toArray()).toHaveLength(0);

    setOfflineScope({ tenantId, userId: 'cashier-branch-1' });
    expect(await getCachedProducts(tenantId)).toHaveLength(1);
    expect(await getOfflineDb(tenantId).pendingSales.toArray()).toHaveLength(1);
  });

  it('a different tenant never sees this tenant\'s cache, scoped or not', async () => {
    const a = freshTenant();
    const b = freshTenant();
    setOfflineScope({ tenantId: a, userId: 'u' });
    server.put('products', { id: 'p1', name: 'A only', stockQuantity: 1 });
    await withKey(a);
    expect(await getCachedProducts(b)).toHaveLength(0);
  });

  it('when the user\'s branch/warehouse access changes, location-dependent data is discarded and re-downloaded; the catalog is kept', async () => {
    const tenantId = freshTenant();
    server.scope = { ...server.scope, branchIds: ['b1', 'b2'], warehouseIds: ['w1', 'w2'] };
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    server.put('branches', { id: 'b1', name: 'One' });
    server.put('branches', { id: 'b2', name: 'Two' });
    server.put('warehouseStock', { id: 'ws1', warehouseId: 'w1', productId: 'p1', quantity: 5 });
    server.put('warehouseStock', { id: 'ws2', warehouseId: 'w2', productId: 'p1', quantity: 5 });
    await withKey(tenantId);
    expect(await getCachedBranches(tenantId)).toHaveLength(2);

    // Access to branch/warehouse two is revoked: the server now scopes everything to one.
    server.scope = { ...server.scope, branchIds: ['b1'], warehouseIds: ['w1'] };
    server.data.branches = server.data.branches.filter((b) => b.id === 'b1');
    server.data.warehouseStock = server.data.warehouseStock.filter((r) => r.warehouseId === 'w1');
    server.put('branches', { id: 'b1', name: 'One' }); // version moves so a download happens
    await withKey(tenantId);
    expect((await getCachedBranches(tenantId)).map((b) => b.id)).toEqual(['b1']);
    expect((await getCachedWarehouseStock(tenantId)).map((r) => r.warehouseId)).toEqual(['w1']);
    expect(await getCachedProducts(tenantId)).toHaveLength(1);
  });

  it('a change of identity or of the cache schema version discards every read copy but never the unsynced queue', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    await withKey(tenantId);
    const queued = await OUTBOXES.expenses.queue(tenantId, { categoryId: 'c', amount: 5 });

    server.schemaVersion = 2;
    server.data.products = [];
    server.put('customers', { id: 'c1', name: 'Ann' });
    await withKey(tenantId);
    expect(await getCachedProducts(tenantId)).toHaveLength(0); // the old shape is gone
    expect(await getCachedCustomers(tenantId)).toHaveLength(1);
    expect(await getOfflineDb(tenantId).pendingExpenses.get(queued.clientId)).toBeDefined();
  });

  it('sign-out purges the read copy of shop data but keeps the user\'s queued work', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    server.put('customers', { id: 'c1', name: 'Ann' });
    await withKey(tenantId);
    const queued = await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p1', quantity: 1, unitPrice: 1 }] });
    await purgeReadCaches(getOfflineDb(tenantId));
    expect(await getCachedProducts(tenantId)).toHaveLength(0);
    expect(await getCachedCustomers(tenantId)).toHaveLength(0);
    expect((await getFreshness(tenantId)).everSynced).toBe(false);
    expect((await getOfflineDb(tenantId).pendingSales.get(queued.clientId)).status).toBe('pending');
  });
});

describe('Browser / app restart', () => {
  it('the local copy, freshness records and queued work survive closing and reopening the database - with no network', async () => {
    const tenantId = freshTenant();
    setOfflineScope({ tenantId, userId: 'u1' });
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    server.put('customers', { id: 'c1', name: 'Ann' });
    await withKey(tenantId);
    const queued = await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p1', quantity: 2, unitPrice: 5 }] });

    closeOfflineDb(); // the browser process ends
    setOnline(false);
    apiClient.get.mockReset();
    apiClient.get.mockRejectedValue(new Error('Network Error'));
    setOfflineScope({ tenantId, userId: 'u1' }); // session restored from storage

    expect(await getCachedProducts(tenantId)).toHaveLength(1);
    expect((await getOfflineDb(tenantId).products.get('p1')).stockQuantity).toBe(8); // the queued sale is still reflected
    expect(await getCachedCustomers(tenantId)).toHaveLength(1);
    expect((await getOfflineDb(tenantId).pendingSales.get(queued.clientId)).status).toBe('pending');
    const f = await getFreshness(tenantId);
    expect(f.everSynced).toBe(true);
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('adopts work queued before per-user databases existed, once, without copying old read caches', async () => {
    const tenantId = freshTenant();
    // A database in the old, tenant-only layout.
    const legacyName = `akvf_offline_${tenantId}`;
    const legacy = new Dexie(legacyName);
    legacy.version(1).stores({ products: 'id', pendingSales: 'clientId, status, createdAt', meta: 'key' });
    await legacy.open();
    await legacy.table('products').put({ id: 'old', name: 'stale catalog' });
    await legacy.table('pendingSales').bulkPut([
      { clientId: 'q1', status: 'pending', createdAt: 1, payload: { items: [] } },
      { clientId: 'q2', status: 'synced', createdAt: 2, payload: { items: [] } },
      { clientId: 'q3', status: 'conflict', createdAt: 3, payload: { items: [] } },
    ]);
    legacy.close();

    setOfflineScope({ tenantId, userId: 'u1' });
    expect(await adoptLegacyDatabase(tenantId)).toBe(2);
    const rows = await getOfflineDb(tenantId).pendingSales.toArray();
    expect(rows.map((r) => r.clientId).sort()).toEqual(['q1', 'q3']);
    expect(await getCachedProducts(tenantId)).toHaveLength(0);
    expect(await Dexie.exists(legacyName)).toBe(false);
    expect(await adoptLegacyDatabase(tenantId)).toBe(0); // second call is a no-op
  });
});

describe('Never blocks the UI', () => {
  it('a burst of concurrent refreshes costs at most two runs (the running one plus ONE shared follow-up), and the follow-up sees changes made meanwhile', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    const first = withKey(tenantId);
    server.put('products', { id: 'p1', stockQuantity: 6 }); // changes while the first run is in flight
    await Promise.all([first, withKey(tenantId), withKey(tenantId), withKey(tenantId)]);
    expect(server.calls.filter((c) => c.path === '/offline/manifest').length).toBeLessThanOrEqual(2);
    expect((await getCachedProducts(tenantId))[0].stockQuantity).toBe(6);
  });

  it('the keeper triggers nothing while offline or hidden, and stop() removes every listener', async () => {
    const tenantId = freshTenant();
    server.put('products', { id: 'p1', name: 'Widget', stockQuantity: 10 });
    setOnline(false);
    const stop = keeper(tenantId);
    window.dispatchEvent(new CustomEvent(STOCK_MUTATED_EVENT));
    await new Promise((r) => setTimeout(r, 450));
    expect(apiClient.get).not.toHaveBeenCalled();
    stop();
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiClient.get).not.toHaveBeenCalled(); // listeners are gone
  });
});
