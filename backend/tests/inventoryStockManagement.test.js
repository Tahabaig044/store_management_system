// Phase 1.10 - Inventory & Stock Management tests.
//
// Same DB requirements as previous phase test files: point DATABASE_URL at a
// real, throwaway local Postgres database with all migrations applied
// (including 20260921030000_phase1_10_inventory_stock_management) and the
// permission catalog seeded. NEVER point this at a database holding real
// tenant data.
//
// Base Warehouse/StockTransfer CRUD, lifecycle, approval-threshold, and
// idempotent-create behavior was already built and tested in earlier phases
// (multiBranch.test.js) and is not duplicated here. This file covers what's
// genuinely new/fixed in Phase 1.10: the atomic, race-safe WarehouseStock
// mutation fix (adjustWarehouseStock), the atomic StockTransfer status
// transitions, idempotency on the direct stock-movement endpoints, and the
// documented Sale/Purchase <-> WarehouseStock integration gap - each verified
// with real concurrent HTTP requests against a real Express app and Postgres
// transaction, mirroring the methodology established in Phase 1.8/1.9.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(30000);

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function registerTenant(businessName) {
  const res = await request(app).post('/api/auth/register-tenant').send({
    businessName,
    adminName: 'Test Admin',
    email: uniqueEmail('admin'),
    password: 'TestPass123',
  });
  if (res.status !== 201) throw new Error(`register-tenant failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}

describe('Phase 1.10 - Inventory & Stock Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase110 Tenant A');
    tenantB = await registerTenant('Phase110 Tenant B');
  });

  async function makeWarehouse(token, name) {
    const res = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.item.id;
  }
  async function makeProduct(token, name, opts = {}) {
    const res = await request(app).post('/api/products').set('Authorization', `Bearer ${token}`).send({ name, sellingPrice: 10, purchasePrice: 5, ...opts });
    return res.body.item.id;
  }
  async function receiveInto(token, warehouseId, productId, quantity) {
    return request(app).post(`/api/warehouses/${warehouseId}/receive`).set('Authorization', `Bearer ${token}`).send({ productId, quantity });
  }

  describe('Atomic WarehouseStock mutation (Case C: concurrent stock adjustment)', () => {
    it('warehouse stock=10, two simultaneous dispatches of 7 and 6: exactly one succeeds, final stock never negative', async () => {
      const warehouseId = await makeWarehouse(tenantA.token, 'Adjust Race WH');
      const productId = await makeProduct(tenantA.token, 'Adjust Race Product');
      await receiveInto(tenantA.token, warehouseId, productId, 10);

      const [resultA, resultB] = await Promise.all([
        request(app).post(`/api/warehouses/${warehouseId}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: 7 }),
        request(app).post(`/api/warehouses/${warehouseId}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: 6 }),
      ]);

      const statuses = [resultA.status, resultB.status].sort();
      // Exactly one must succeed (200) and the other must be rejected for
      // insufficient stock (409) - both succeeding would mean 7+6=13 was
      // dispatched from only 10 in stock (a lost-update race).
      expect(statuses).toEqual([200, 409]);

      const finalStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
      expect(Number(finalStock.quantity)).toBeGreaterThanOrEqual(0);
      expect([3, 4]).toContain(Number(finalStock.quantity));

      const finalProduct = await prisma.product.findUnique({ where: { id: productId } });
      // Product.stockQuantity must reflect exactly the same single winning
      // dispatch - proving the two numbers never diverge under the race.
      expect(Number(finalProduct.stockQuantity)).toBe(Number(finalStock.quantity));
    });

    it('warehouse stock=10, two simultaneous adjustments of -4 and -6 (sum fits exactly): both succeed, final stock is 0', async () => {
      const warehouseId = await makeWarehouse(tenantA.token, 'Adjust Fits WH');
      const productId = await makeProduct(tenantA.token, 'Adjust Fits Product');
      await receiveInto(tenantA.token, warehouseId, productId, 10);

      const [resultA, resultB] = await Promise.all([
        request(app).post(`/api/warehouses/${warehouseId}/adjust`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: -4, note: 'A' }),
        request(app).post(`/api/warehouses/${warehouseId}/adjust`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: -6, note: 'B' }),
      ]);
      expect(resultA.status).toBe(200);
      expect(resultB.status).toBe(200);

      const finalStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
      expect(Number(finalStock.quantity)).toBe(0);
    });

    it('tenant-wide /products/:id/adjust-stock is also race-safe (same bug class, separate code path)', async () => {
      const productId = await makeProduct(tenantA.token, 'Direct Adjust Race Product', { openingStock: 10 });

      const [resultA, resultB] = await Promise.all([
        request(app).post(`/api/products/${productId}/adjust-stock`).set('Authorization', `Bearer ${tenantA.token}`).send({ quantity: -7 }),
        request(app).post(`/api/products/${productId}/adjust-stock`).set('Authorization', `Bearer ${tenantA.token}`).send({ quantity: -6 }),
      ]);
      const statuses = [resultA.status, resultB.status].sort();
      expect(statuses).toEqual([200, 422]);

      const finalProduct = await prisma.product.findUnique({ where: { id: productId } });
      expect(Number(finalProduct.stockQuantity)).toBeGreaterThanOrEqual(0);
      expect([3, 4]).toContain(Number(finalProduct.stockQuantity));
    });
  });

  describe('Idempotency on direct stock-movement endpoints (new in Phase 1.10)', () => {
    it('a retried /warehouses/:id/adjust with the same idempotencyKey is deduplicated, not double-applied', async () => {
      const warehouseId = await makeWarehouse(tenantA.token, 'Idempotent Adjust WH');
      const productId = await makeProduct(tenantA.token, 'Idempotent Adjust Product');
      await receiveInto(tenantA.token, warehouseId, productId, 10);

      const idempotencyKey = `adjust-test-${Date.now()}`;
      const first = await request(app).post(`/api/warehouses/${warehouseId}/adjust`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: -5, note: 'x', idempotencyKey });
      expect(first.status).toBe(200);

      const retry = await request(app).post(`/api/warehouses/${warehouseId}/adjust`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: -5, note: 'x', idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const finalStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
      expect(Number(finalStock.quantity)).toBe(5); // not 0 - the retry did not apply a second -5
    });

    it('a retried /warehouses/:id/receive with the same idempotencyKey is deduplicated', async () => {
      const warehouseId = await makeWarehouse(tenantA.token, 'Idempotent Receive WH');
      const productId = await makeProduct(tenantA.token, 'Idempotent Receive Product');

      const idempotencyKey = `receive-test-${Date.now()}`;
      const first = await request(app).post(`/api/warehouses/${warehouseId}/receive`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: 8, idempotencyKey });
      expect(first.status).toBe(200);

      const retry = await request(app).post(`/api/warehouses/${warehouseId}/receive`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: 8, idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const finalStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
      expect(Number(finalStock.quantity)).toBe(8); // one keyed receive applied, the retry did not add a second
    });

    it('a retried /products/:id/adjust-stock with the same idempotencyKey is deduplicated', async () => {
      const productId = await makeProduct(tenantA.token, 'Idempotent Direct Adjust Product', { openingStock: 10 });
      const idempotencyKey = `direct-adjust-test-${Date.now()}`;

      const first = await request(app).post(`/api/products/${productId}/adjust-stock`).set('Authorization', `Bearer ${tenantA.token}`).send({ quantity: -3, idempotencyKey });
      expect(first.status).toBe(200);

      const retry = await request(app).post(`/api/products/${productId}/adjust-stock`).set('Authorization', `Bearer ${tenantA.token}`).send({ quantity: -3, idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const finalProduct = await prisma.product.findUnique({ where: { id: productId } });
      expect(Number(finalProduct.stockQuantity)).toBe(7); // not 4
    });
  });

  describe('Stock Transfer concurrency (Case D: concurrent transfer, Case E: concurrent reversal-equivalent)', () => {
    async function makeApprovedTransfer(sourceWarehouseId, destinationWarehouseId, productId, quantity) {
      const created = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId, destinationWarehouseId, items: [{ productId, quantity }] });
      return created.body.item.id;
    }

    it('two DIFFERENT transfers dispatching from the same source warehouse+product concurrently never together overdraw it', async () => {
      const source = await makeWarehouse(tenantA.token, 'Transfer Race Source');
      const dest1 = await makeWarehouse(tenantA.token, 'Transfer Race Dest 1');
      const dest2 = await makeWarehouse(tenantA.token, 'Transfer Race Dest 2');
      const productId = await makeProduct(tenantA.token, 'Transfer Race Product');
      await receiveInto(tenantA.token, source, productId, 10);

      const transfer1Id = await makeApprovedTransfer(source, dest1, productId, 7);
      const transfer2Id = await makeApprovedTransfer(source, dest2, productId, 6);

      const [dispatch1, dispatch2] = await Promise.all([
        request(app).post(`/api/stock-transfers/${transfer1Id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/stock-transfers/${transfer2Id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [dispatch1.status, dispatch2.status].sort();
      // 7+6=13 > 10 available - exactly one dispatch must succeed.
      expect(statuses).toEqual([200, 409]);

      const finalSourceStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: source, productId } } });
      expect(Number(finalSourceStock.quantity)).toBeGreaterThanOrEqual(0);
      expect([3, 4]).toContain(Number(finalSourceStock.quantity));
    });

    it('a concurrent double-dispatch of the SAME transfer only decrements source stock once', async () => {
      const source = await makeWarehouse(tenantA.token, 'Double Dispatch Source');
      const dest = await makeWarehouse(tenantA.token, 'Double Dispatch Dest');
      const productId = await makeProduct(tenantA.token, 'Double Dispatch Product');
      await receiveInto(tenantA.token, source, productId, 10);
      const transferId = await makeApprovedTransfer(source, dest, productId, 4);

      const [dispatchA, dispatchB] = await Promise.all([
        request(app).post(`/api/stock-transfers/${transferId}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/stock-transfers/${transferId}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [dispatchA.status, dispatchB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const finalSourceStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: source, productId } } });
      // Started at 10, dispatched exactly once (-4 -> 6), never twice (-> 2).
      expect(Number(finalSourceStock.quantity)).toBe(6);
    });

    it('a concurrent double-receive of the SAME in-transit transfer only credits destination stock once', async () => {
      const source = await makeWarehouse(tenantA.token, 'Double Receive Source');
      const dest = await makeWarehouse(tenantA.token, 'Double Receive Dest');
      const productId = await makeProduct(tenantA.token, 'Double Receive Product');
      await receiveInto(tenantA.token, source, productId, 10);
      const transferId = await makeApprovedTransfer(source, dest, productId, 5);
      await request(app).post(`/api/stock-transfers/${transferId}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);

      const [receiveA, receiveB] = await Promise.all([
        request(app).post(`/api/stock-transfers/${transferId}/receive`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ productId, receivedQuantity: 5 }] }),
        request(app).post(`/api/stock-transfers/${transferId}/receive`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ productId, receivedQuantity: 5 }] }),
      ]);
      const statuses = [receiveA.status, receiveB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const finalDestStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId: dest, productId } } });
      expect(Number(finalDestStock.quantity)).toBe(5); // credited exactly once, not 10
    });

    it('a concurrent double-approve of the SAME pending transfer only approves once', async () => {
      await request(app).put('/api/settings/transferApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '1' });
      const source = await makeWarehouse(tenantA.token, 'Double Approve Source');
      const dest = await makeWarehouse(tenantA.token, 'Double Approve Dest');
      const productId = await makeProduct(tenantA.token, 'Double Approve Product');
      const transferId = await makeApprovedTransfer(source, dest, productId, 5); // total value 25 > threshold 1

      const [approveA, approveB] = await Promise.all([
        request(app).post(`/api/stock-transfers/${transferId}/approve`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/stock-transfers/${transferId}/approve`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [approveA.status, approveB.status].sort();
      expect(statuses).toEqual([200, 409]);

      await request(app).put('/api/settings/transferApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '999999' });
    });
  });

  describe('Sale/Purchase <-> WarehouseStock integration (documents a real, pre-existing architectural gap)', () => {
    it('a Sale deducts Product.stockQuantity but does NOT touch WarehouseStock, even when a warehouseId is supplied', async () => {
      const warehouseId = await makeWarehouse(tenantA.token, 'Sale Integration WH');
      const productId = await makeProduct(tenantA.token, 'Sale Integration Product');
      // receiveInto also feeds Product.stockQuantity (by design - receiving
      // IS the one direction WarehouseStock and Product.stockQuantity stay
      // in sync, via adjustWarehouseStock) - so Product.stockQuantity is 20
      // after this, not the WarehouseStock row's own 20.
      await receiveInto(tenantA.token, warehouseId, productId, 20);

      const beforeWhStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ warehouseId, items: [{ productId, quantity: 5, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 50 });
      expect(sale.status).toBe(201);

      const afterProduct = await prisma.product.findUnique({ where: { id: productId } });
      expect(Number(afterProduct.stockQuantity)).toBe(15); // 20 - 5

      const afterWhStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
      // This is the documented gap (Section 32/Known Limitations): Sale's
      // warehouseId is attribution-only (Phase 1.8 design) and does not yet
      // drive per-warehouse WarehouseStock adjustment.
      expect(Number(afterWhStock.quantity)).toBe(Number(beforeWhStock.quantity));
    });

    it('a Purchase (receiveImmediately) increments Product.stockQuantity but does NOT touch WarehouseStock', async () => {
      const warehouseId = await makeWarehouse(tenantA.token, 'Purchase Integration WH');
      const productId = await makeProduct(tenantA.token, 'Purchase Integration Product');
      await receiveInto(tenantA.token, warehouseId, productId, 5);
      const sup = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Integration Supplier' });

      const beforeWhStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId: sup.body.item.id, warehouseId, receiveImmediately: true, items: [{ productId, quantity: 10, unitCost: 5 }] });
      expect(purchase.status).toBe(201);

      const afterWhStock = await prisma.warehouseStock.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
      expect(Number(afterWhStock.quantity)).toBe(Number(beforeWhStock.quantity)); // unchanged - same documented gap
    });
  });

  describe('Negative stock policy (documents actual current behavior)', () => {
    it('warehouse-level /adjust always hard-blocks negative stock, regardless of the tenant allowNegativeStock setting', async () => {
      await request(app).put('/api/settings/allowNegativeStock').set('Authorization', `Bearer ${tenantA.token}`).send({ value: 'true' });
      const warehouseId = await makeWarehouse(tenantA.token, 'Negative Policy WH');
      const productId = await makeProduct(tenantA.token, 'Negative Policy Product');
      await receiveInto(tenantA.token, warehouseId, productId, 3);

      const res = await request(app).post(`/api/warehouses/${warehouseId}/adjust`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: -10, note: 'over' });
      expect(res.status).toBe(409); // NOT allowed even though allowNegativeStock=true tenant-wide

      await request(app).put('/api/settings/allowNegativeStock').set('Authorization', `Bearer ${tenantA.token}`).send({ value: 'false' });
    });
  });

  describe('Tenant isolation (re-verified for the new idempotency fields)', () => {
    it('an idempotencyKey used by Tenant A does not dedupe a request from Tenant B', async () => {
      const warehouseA = await makeWarehouse(tenantA.token, 'Isolation WH A');
      const productA = await makeProduct(tenantA.token, 'Isolation Product A');
      const warehouseB = await makeWarehouse(tenantB.token, 'Isolation WH B');
      const productB = await makeProduct(tenantB.token, 'Isolation Product B');

      const idempotencyKey = `cross-tenant-key-${Date.now()}`;
      const resA = await request(app).post(`/api/warehouses/${warehouseA}/receive`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId: productA, quantity: 5, idempotencyKey });
      expect(resA.status).toBe(200);
      expect(resA.body.deduplicated).toBeUndefined();

      const resB = await request(app).post(`/api/warehouses/${warehouseB}/receive`).set('Authorization', `Bearer ${tenantB.token}`).send({ productId: productB, quantity: 5, idempotencyKey });
      expect(resB.status).toBe(200);
      expect(resB.body.deduplicated).toBeUndefined(); // not a false-positive dedup across tenants
    });
  });
});
