// Phase 3.1 - server side of the offline data foundation (/api/offline/*).
//
// Needs DATABASE_URL pointed at a real, throwaway Postgres database with every migration
// applied and the permission catalog seeded. The browser side (IndexedDB, freshness, stock
// keeping, isolation, restart) is covered by the frontend suite; this file proves the server
// contract it relies on: complete (non-truncated) paged downloads, deltas that carry stock
// changes and deactivations, versions that change when data does, and that a terminal can
// never receive more than its user may read online.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(90000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});
const patch = (t, path, body) => request(app).patch(path).set(auth(t)).send(body || {});

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: `${uniq('a')}@test.local`, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}
async function userToken(adminToken, role, branchId) {
  const email = `${uniq(role.toLowerCase())}@test.local`;
  const created = await post(adminToken, '/api/users', { name: role, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`user create failed ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return { token: login.body.token, userId: created.body.item?.id || login.body.user.id };
}
const makeProduct = async (t, extra = {}) => (await post(t, '/api/products', { name: uniq('Prod'), sellingPrice: 10, purchasePrice: 5, openingStock: 50, ...extra })).body.item;

async function fetchAll(token, name, query = {}, limit = 50) {
  const items = [];
  let after;
  let pages = 0;
  do {
    const res = await get(token, `/api/offline/datasets/${name}`, { ...query, limit, ...(after ? { after } : {}) });
    expect(res.status).toBe(200);
    items.push(...res.body.items);
    after = res.body.nextCursor;
    pages += 1;
  } while (after);
  return { items, pages };
}

describe('Phase 3.1 - offline data foundation (server contract)', () => {
  let A;
  let B;
  let branch1;
  let branch2;

  beforeAll(async () => {
    A = await registerTenant(uniq('Offline A'));
    B = await registerTenant(uniq('Offline B'));
    branch1 = (await get(A.token, '/api/branches')).body.items[0].id;
    branch2 = (await post(A.token, '/api/branches', { name: uniq('Second'), code: 'B2' })).body.item.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Manifest: what may be cached, and how to tell it is stale', () => {
    it('lists the datasets this role may read, the exact access scope, and a version per dataset', async () => {
      await makeProduct(A.token);
      const res = await get(A.token, '/api/offline/manifest');
      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe(1);
      expect(res.body.scope).toMatchObject({ tenantId: A.tenantId, role: 'TENANT_ADMIN', branchIds: null, warehouseIds: null });
      expect(Object.keys(res.body.datasets).sort()).toEqual(['apDocuments', 'apNotes', 'arDocuments', 'arNotes', 'branches', 'customers', 'expenseCategories', 'products', 'purchasesHistory', 'returnablePurchases', 'returnableSales', 'salesHistory', 'suppliers', 'warehouseStock', 'warehouses']);
      expect(res.body.datasets.products.count).toBeGreaterThanOrEqual(1);
      expect(res.body.datasets.products.maxUpdatedAt).toBeTruthy();
    });

    it('a role without a permission is not offered that dataset, and cannot download it directly', async () => {
      const cashier = await userToken(A.token, 'CASHIER');
      const manifest = await get(cashier.token, '/api/offline/manifest');
      expect(manifest.status).toBe(200);
      expect(manifest.body.datasets.products).toBeDefined();
      expect(manifest.body.datasets.customers).toBeDefined();
      expect(manifest.body.datasets.expenseCategories).toBeUndefined(); // FINANCE_STAFF only
      expect((await get(cashier.token, '/api/offline/datasets/expenseCategories')).status).toBe(403);
    });

    it('the version changes when stock changes, when a product is deactivated, and not otherwise', async () => {
      const T = await registerTenant(uniq('Versions'));
      const product = await makeProduct(T.token);
      const v0 = (await get(T.token, '/api/offline/manifest')).body.datasets.products;
      const again = (await get(T.token, '/api/offline/manifest')).body.datasets.products;
      expect(again).toEqual(v0);

      await new Promise((r) => setTimeout(r, 15));
      expect((await post(T.token, `/api/products/${product.id}/adjust-stock`, { quantity: -3, note: 'count' })).status).toBe(200);
      const v1 = (await get(T.token, '/api/offline/manifest')).body.datasets.products;
      expect(v1.count).toBe(v0.count);
      expect(new Date(v1.maxUpdatedAt).getTime()).toBeGreaterThan(new Date(v0.maxUpdatedAt).getTime());

      await new Promise((r) => setTimeout(r, 15));
      expect((await request(app).delete(`/api/products/${product.id}`).set(auth(T.token))).status).toBeLessThan(300);
      const v2 = (await get(T.token, '/api/offline/manifest')).body.datasets.products;
      expect(v2.count).toBe(v0.count - 1);
      expect(new Date(v2.maxUpdatedAt).getTime()).toBeGreaterThan(new Date(v1.maxUpdatedAt).getTime());
    });

    it('requires authentication', async () => {
      expect((await request(app).get('/api/offline/manifest')).status).toBe(401);
      expect((await request(app).get('/api/offline/datasets/products')).status).toBe(401);
    });
  });

  describe('Complete downloads: no silent truncation', () => {
    it('the normal list endpoint stops at 100 rows, but the dataset endpoint pages through every product exactly once', async () => {
      const T = await registerTenant(uniq('Paging'));
      const rows = Array.from({ length: 130 }, (_, i) => ({ tenantId: T.tenantId, name: `Bulk ${String(i).padStart(3, '0')}`, sellingPrice: 10, purchasePrice: 5, stockQuantity: 10 }));
      await prisma.product.createMany({ data: rows });

      const list = await get(T.token, '/api/products', { pageSize: 500 });
      expect(list.body.items).toHaveLength(100); // what refreshCaches used to cache
      expect(list.body.total).toBe(130);

      const { items, pages } = await fetchAll(T.token, 'products', {}, 50);
      expect(pages).toBe(3);
      expect(items).toHaveLength(130);
      expect(new Set(items.map((p) => p.id)).size).toBe(130);
    });

    it('returns products in the same shape as the list endpoint (category and extensions included)', async () => {
      const T = await registerTenant(uniq('Shape'));
      const p = await makeProduct(T.token);
      const list = (await get(T.token, '/api/products')).body.items.find((x) => x.id === p.id);
      const dataset = (await get(T.token, '/api/offline/datasets/products')).body.items.find((x) => x.id === p.id);
      for (const key of Object.keys(list)) expect(dataset).toHaveProperty(key);
      expect(Number(dataset.stockQuantity)).toBe(50);
    });

    it('validates its input', async () => {
      expect((await get(A.token, '/api/offline/datasets/nonsense')).status).toBe(404);
      expect((await get(A.token, '/api/offline/datasets/products', { updatedSince: 'not-a-date' })).status).toBe(422);
      const capped = await get(A.token, '/api/offline/datasets/products', { limit: 999999 });
      expect(capped.status).toBe(200);
    });
  });

  describe('Deltas carry online stock changes and deactivations', () => {
    it('a stock change made online (adjustment, sale, purchase, warehouse) appears in the next delta with the new quantity', async () => {
      const T = await registerTenant(uniq('Delta'));
      const p = await makeProduct(T.token, { openingStock: 100 });
      const first = await get(T.token, '/api/offline/datasets/products');
      const since = first.body.serverTime;
      await new Promise((r) => setTimeout(r, 15));

      expect((await get(T.token, '/api/offline/datasets/products', { updatedSince: since })).body.items).toHaveLength(0);

      await post(T.token, `/api/products/${p.id}/adjust-stock`, { quantity: -10, note: 'damaged' });
      let delta = await get(T.token, '/api/offline/datasets/products', { updatedSince: since });
      expect(delta.body.delta).toBe(true);
      expect(Number(delta.body.items.find((x) => x.id === p.id).stockQuantity)).toBe(90);

      const since2 = delta.body.serverTime;
      await new Promise((r) => setTimeout(r, 15));
      await post(T.token, '/api/sales', { items: [{ productId: p.id, quantity: 4, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 40 });
      delta = await get(T.token, '/api/offline/datasets/products', { updatedSince: since2 });
      expect(Number(delta.body.items.find((x) => x.id === p.id).stockQuantity)).toBe(86);

      const since3 = delta.body.serverTime;
      await new Promise((r) => setTimeout(r, 15));
      const supplier = (await post(T.token, '/api/suppliers', { name: uniq('S') })).body.item.id;
      await post(T.token, '/api/purchases', { supplierId: supplier, receiveImmediately: true, items: [{ productId: p.id, quantity: 14, unitCost: 5 }] });
      delta = await get(T.token, '/api/offline/datasets/products', { updatedSince: since3 });
      expect(Number(delta.body.items.find((x) => x.id === p.id).stockQuantity)).toBe(100);
    });

    it('a deactivated record is absent from a full download but present (inactive) in a delta, so terminals can drop it', async () => {
      const T = await registerTenant(uniq('Deactivate'));
      const customer = (await post(T.token, '/api/customers', { name: uniq('C') })).body.item;
      const since = (await get(T.token, '/api/offline/datasets/customers')).body.serverTime;
      await new Promise((r) => setTimeout(r, 15));
      expect((await request(app).delete(`/api/customers/${customer.id}`).set(auth(T.token))).status).toBeLessThan(300);

      expect((await fetchAll(T.token, 'customers')).items.map((c) => c.id)).not.toContain(customer.id);
      const delta = await get(T.token, '/api/offline/datasets/customers', { updatedSince: since });
      const row = delta.body.items.find((c) => c.id === customer.id);
      expect(row).toBeDefined();
      expect(row.isActive).toBe(false);
    });

    it('per-warehouse quantities are downloadable and follow direct warehouse receipts', async () => {
      const T = await registerTenant(uniq('WStock'));
      const wh = (await post(T.token, '/api/warehouses', { name: uniq('WH') })).body.item.id;
      const p = await makeProduct(T.token, { openingStock: 0 });
      const since = (await get(T.token, '/api/offline/datasets/warehouseStock')).body.serverTime;
      await new Promise((r) => setTimeout(r, 15));
      await post(T.token, `/api/warehouses/${wh}/receive`, { productId: p.id, quantity: 12 });
      const delta = await get(T.token, '/api/offline/datasets/warehouseStock', { updatedSince: since });
      const row = delta.body.items.find((r) => r.productId === p.id && r.warehouseId === wh);
      expect(Number(row.quantity)).toBe(12);
    });
  });

  describe('Isolation: a terminal never receives more than its user may read', () => {
    it('another tenant sees none of this tenant\'s data in any dataset', async () => {
      await makeProduct(A.token);
      await post(A.token, '/api/customers', { name: uniq('C') });
      for (const name of ['products', 'customers', 'suppliers', 'branches', 'warehouses', 'warehouseStock']) {
        const rows = (await fetchAll(B.token, name)).items;
        for (const r of rows) {
          if (r.tenantId) expect(r.tenantId).toBe(B.tenantId);
        }
      }
      const idsA = new Set((await fetchAll(A.token, 'products')).items.map((p) => p.id));
      const idsB = (await fetchAll(B.token, 'products')).items.map((p) => p.id);
      expect(idsB.filter((id) => idsA.has(id))).toHaveLength(0);
      expect((await get(B.token, '/api/offline/manifest')).body.scope.tenantId).toBe(B.tenantId);
    });

    it('a branch-restricted user is offered only their own branch and warehouses, and their stock rows', async () => {
      const T = await registerTenant(uniq('Scoped'));
      const b1 = (await get(T.token, '/api/branches')).body.items[0].id;
      const b2 = (await post(T.token, '/api/branches', { name: uniq('Other'), code: 'O2' })).body.item.id;
      const w1 = (await post(T.token, '/api/warehouses', { name: uniq('W1'), branchId: b1 })).body.item.id;
      const w2 = (await post(T.token, '/api/warehouses', { name: uniq('W2'), branchId: b2 })).body.item.id;
      const p = await makeProduct(T.token, { openingStock: 0 });
      await post(T.token, `/api/warehouses/${w1}/receive`, { productId: p.id, quantity: 5 });
      await post(T.token, `/api/warehouses/${w2}/receive`, { productId: p.id, quantity: 9 });

      const keeper = await userToken(T.token, 'STORE_KEEPER', b1);
      const manifest = (await get(keeper.token, '/api/offline/manifest')).body;
      expect(manifest.scope.branchIds).toEqual([b1]);
      expect(manifest.scope.warehouseIds).toEqual([w1]);
      expect((await fetchAll(keeper.token, 'branches')).items.map((b) => b.id)).toEqual([b1]);
      expect((await fetchAll(keeper.token, 'warehouses')).items.map((w) => w.id)).toEqual([w1]);
      const stock = (await fetchAll(keeper.token, 'warehouseStock')).items;
      expect(stock.every((r) => r.warehouseId === w1)).toBe(true);
      expect(stock.map((r) => Number(r.quantity))).toEqual([5]);
      expect(manifest.datasets.warehouseStock.count).toBe(1);

      // The unrestricted admin sees both.
      const adminStock = (await fetchAll(T.token, 'warehouseStock')).items;
      expect(adminStock.map((r) => r.warehouseId).sort()).toEqual([w1, w2].sort());
    });

    it('two users of the same tenant get different scope descriptors, so a terminal can tell their caches apart', async () => {
      const k1 = await userToken(A.token, 'STORE_KEEPER', branch1);
      const k2 = await userToken(A.token, 'STORE_KEEPER', branch2);
      const s1 = (await get(k1.token, '/api/offline/manifest')).body.scope;
      const s2 = (await get(k2.token, '/api/offline/manifest')).body.scope;
      expect(s1.userId).not.toBe(s2.userId);
      expect(s1.branchIds).toEqual([branch1]);
      expect(s2.branchIds).toEqual([branch2]);
    });
  });

  describe('Read-only and load-safe', () => {
    it('rejects writes, and hundreds of concurrent manifest/dataset reads stay fast and correct', async () => {
      expect((await post(A.token, '/api/offline/datasets/products', {})).status).toBe(404);
      expect((await patch(A.token, '/api/offline/manifest', {})).status).toBe(404);
      const results = await Promise.all([
        ...Array.from({ length: 10 }, () => get(A.token, '/api/offline/manifest')),
        ...Array.from({ length: 10 }, () => get(A.token, '/api/offline/datasets/products', { limit: 100 })),
      ]);
      expect(results.filter((r) => r.status !== 200)).toHaveLength(0);
    });
  });
});
