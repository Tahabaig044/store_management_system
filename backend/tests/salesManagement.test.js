// Phase 1.8 - Sales Management tests.
//
// Same DB requirements as business.test.js: point DATABASE_URL at a real,
// throwaway local Postgres database with all migrations applied (including
// 20260921010000_phase1_8_sales_management) and the permission catalog
// seeded. NEVER point this at a database holding real tenant data.
//
// Sales CRUD, reversal, tenant isolation, branch isolation, insufficient
// stock, negative-stock config, and the sales/customer/supplier history
// views were already built and tested in earlier phases (business.test.js,
// multiBranch.test.js, permissionsArchitecture.test.js) - not duplicated
// here. This file covers what's genuinely new/fixed in Phase 1.8: Service
// item support, warehouseId/variantId/notes fields, new list filters, and -
// most importantly - the atomic, race-safe stock deduction and reversal
// fix, verified with an explicit concurrent-stock scenario.
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

async function createUserToken(adminToken, role, branchId) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return { token: login.body.token, userId: created.body.item.id };
}

describe('Phase 1.8 - Sales Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase18 Tenant A');
    tenantB = await registerTenant('Phase18 Tenant B');
  });

  describe('Universal Product/Service integration (new in Phase 1.8)', () => {
    it('a SERVICE-kind product can be sold with no stock check and no inventory transaction', async () => {
      const service = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Eye Exam Service', productKind: 'SERVICE', sellingPrice: 50 });
      expect(Number(service.body.item.stockQuantity)).toBe(0);

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId: service.body.item.id, quantity: 2, unitPrice: 50 }], paymentMethod: 'cash', amountPaid: 100 });
      expect(sale.status).toBe(201);
      expect(sale.body.item.total).toBe('100');

      // Never treated as insufficient stock, and no phantom deduction either.
      const after = await request(app).get(`/api/products/${service.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(0);

      const txns = await prisma.inventoryTransaction.findMany({ where: { productId: service.body.item.id } });
      expect(txns.length).toBe(0);
    });

    it('a sale mixing a SERVICE item and a PHYSICAL_GOOD item deducts stock only for the physical good', async () => {
      const service = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Fitting Service', productKind: 'SERVICE', sellingPrice: 20 });
      const good = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Physical Frame', sellingPrice: 30, purchasePrice: 15, openingStock: 10 });

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          items: [
            { productId: service.body.item.id, quantity: 1, unitPrice: 20 },
            { productId: good.body.item.id, quantity: 3, unitPrice: 30 },
          ],
          paymentMethod: 'cash',
          amountPaid: 110,
        });
      expect(sale.status).toBe(201);

      const goodAfter = await request(app).get(`/api/products/${good.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(goodAfter.body.item.stockQuantity)).toBe(7);
    });

    it('reversing a sale with a SERVICE line never "restores" phantom stock to it', async () => {
      const service = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Reversible Service', productKind: 'SERVICE', sellingPrice: 10 });
      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId: service.body.item.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 });

      const reversed = await request(app).post(`/api/sales/${sale.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(reversed.status).toBe(200);

      const after = await request(app).get(`/api/products/${service.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(0);
    });
  });

  describe('warehouseId / variantId / notes (new in Phase 1.8)', () => {
    it('a sale can be created with a warehouseId the caller has access to', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Sale WH Branch' });
      const warehouse = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Sale Warehouse', branchId: branch.body.item.id });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'WH Sale Product', sellingPrice: 10, purchasePrice: 5, openingStock: 5 });

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ warehouseId: warehouse.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 });
      expect(sale.status).toBe(201);
      expect(sale.body.item.warehouseId).toBe(warehouse.body.item.id);
    });

    it('a warehouseId belonging to another tenant is rejected', async () => {
      const otherWarehouseBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Branch' });
      const otherWarehouse = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Warehouse', branchId: otherWarehouseBranch.body.item.id });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cross Tenant WH Product', sellingPrice: 10 });

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ warehouseId: otherWarehouse.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10 }] });
      expect(sale.status).toBe(404);
    });

    it('a STORE_KEEPER restricted to one branch/warehouse cannot create a sale attributed to a warehouse they lack access to', async () => {
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted Branch 2' });
      const warehouse2 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted WH 2', branchId: branch2.body.item.id });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted Product', sellingPrice: 10 });
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER', branch1.body.item.id);

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ warehouseId: warehouse2.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10 }] });
      expect(sale.status).toBe(403);
    });

    it('a sale line can reference a specific ProductVariant', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Variant Sale Product', sellingPrice: 10, openingStock: 20 });
      const variant = await request(app).post(`/api/products/${product.body.item.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Large' });

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId: product.body.item.id, variantId: variant.body.item.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 });
      expect(sale.status).toBe(201);
      expect(sale.body.item.items[0].variantId).toBe(variant.body.item.id);
    });

    it('a variantId that does not belong to the given product is rejected', async () => {
      const productA = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Product A For Variant Mismatch', sellingPrice: 10 });
      const productB = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Product B For Variant Mismatch', sellingPrice: 10 });
      const variantOfB = await request(app).post(`/api/products/${productB.body.item.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Belongs To B' });

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId: productA.body.item.id, variantId: variantOfB.body.item.id, quantity: 1, unitPrice: 10 }] });
      expect(sale.status).toBe(404);
    });

    it('a sale can carry a notes field', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Noted Sale Product', sellingPrice: 10, openingStock: 5 });
      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10 }], notes: 'Customer requested gift wrap.', paymentMethod: 'cash', amountPaid: 10 });
      expect(sale.body.item.notes).toBe('Customer requested gift wrap.');
    });
  });

  describe('Search/filter (new query params in Phase 1.8)', () => {
    let filterCustomer;

    beforeAll(async () => {
      filterCustomer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Filter Test Customer' });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Filter Product', sellingPrice: 10, openingStock: 10 });
      await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: filterCustomer.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 5 });
    });

    it('filters by customerId', async () => {
      const res = await request(app).get('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).query({ customerId: filterCustomer.body.item.id });
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((s) => s.customerId === filterCustomer.body.item.id)).toBe(true);
    });

    it('filters by paymentStatus', async () => {
      const res = await request(app).get('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).query({ paymentStatus: 'PARTIAL' });
      expect(res.status).toBe(200);
      expect(res.body.items.every((s) => s.paymentStatus === 'PARTIAL')).toBe(true);
    });

    it('filters by status', async () => {
      const res = await request(app).get('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).query({ status: 'COMPLETED' });
      expect(res.status).toBe(200);
      expect(res.body.items.every((s) => s.status === 'COMPLETED')).toBe(true);
    });
  });

  describe('Transaction rollback / atomicity', () => {
    it('a sale with one valid and one nonexistent product creates ZERO sale record and ZERO stock changes', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Rollback Product', sellingPrice: 10, openingStock: 10 });
      const before = await request(app).get(`/api/products/${product.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);

      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          items: [
            { productId: product.body.item.id, quantity: 2, unitPrice: 10 },
            { productId: '00000000-0000-0000-0000-000000000000', quantity: 1, unitPrice: 10 },
          ],
        });
      expect(res.status).toBe(404);

      const after = await request(app).get(`/api/products/${product.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(Number(before.body.item.stockQuantity));
    });

    it('a sale where the SECOND line has insufficient stock rolls back the FIRST line\'s deduction too', async () => {
      const product1 = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Rollback Product 1', sellingPrice: 10, openingStock: 10 });
      const product2 = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Rollback Product 2', sellingPrice: 10, openingStock: 1 });

      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          items: [
            { productId: product1.body.item.id, quantity: 5, unitPrice: 10 },
            { productId: product2.body.item.id, quantity: 5, unitPrice: 10 }, // only 1 in stock
          ],
        });
      expect(res.status).toBe(409);

      const p1After = await request(app).get(`/api/products/${product1.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(p1After.body.item.stockQuantity)).toBe(10); // untouched, not partially deducted
    });
  });

  describe('Concurrency: atomic stock deduction under a real race (new in Phase 1.8)', () => {
    it('stock=5, two simultaneous sales for 4 and 3: exactly one succeeds, final stock is mathematically correct, never negative', async () => {
      const product = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Race Condition Product', sellingPrice: 10, purchasePrice: 5, openingStock: 5 });
      const productId = product.body.item.id;

      const [resultA, resultB] = await Promise.all([
        request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ productId, quantity: 4, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 40 }),
        request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ productId, quantity: 3, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 30 }),
      ]);

      const statuses = [resultA.status, resultB.status].sort();
      // Exactly one must succeed (201) and the other must be rejected for
      // insufficient stock (409) - both succeeding would mean 4+3=7 was sold
      // against only 5 in stock (a lost-update race); both failing would
      // mean a false rejection of a request that should have succeeded.
      expect(statuses).toEqual([201, 409]);

      const finalProduct = await prisma.product.findUnique({ where: { id: productId } });
      const finalStock = Number(finalProduct.stockQuantity);
      // Whichever one won, the final stock must reflect EXACTLY that one
      // deduction - never both (which would be -2), never neither (which
      // would still be 5).
      expect([1, 2]).toContain(finalStock);
      expect(finalStock).toBeGreaterThanOrEqual(0);

      // Cross-check: the winning sale's own line total matches the delta
      // actually applied to stock - no phantom or double deduction.
      const winner = resultA.status === 201 ? resultA : resultB;
      const soldQty = Number(winner.body.item.items[0].quantity);
      expect(5 - soldQty).toBe(finalStock);

      const txns = await prisma.inventoryTransaction.findMany({ where: { productId, type: 'SALE_DEDUCTION' } });
      expect(txns.length).toBe(1); // only the winner recorded a deduction
    });

    it('stock=10, two simultaneous sales for 4 and 3 (sum within stock): both succeed, final stock is exactly 3', async () => {
      const product = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Race Condition Product 2', sellingPrice: 10, purchasePrice: 5, openingStock: 10 });
      const productId = product.body.item.id;

      const [resultA, resultB] = await Promise.all([
        request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ productId, quantity: 4, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 40 }),
        request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ productId, quantity: 3, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 30 }),
      ]);

      expect(resultA.status).toBe(201);
      expect(resultB.status).toBe(201);

      const finalProduct = await prisma.product.findUnique({ where: { id: productId } });
      expect(Number(finalProduct.stockQuantity)).toBe(3);
    });

    it('a concurrent double-reversal of the SAME sale only restores stock once', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Double Reversal Product', sellingPrice: 10, purchasePrice: 5, openingStock: 10 });
      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId: product.body.item.id, quantity: 4, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 40 });
      expect(sale.status).toBe(201);

      const [reverseA, reverseB] = await Promise.all([
        request(app).post(`/api/sales/${sale.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/sales/${sale.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);

      const statuses = [reverseA.status, reverseB.status].sort();
      expect(statuses).toEqual([200, 409]); // exactly one reversal wins

      const finalProduct = await prisma.product.findUnique({ where: { id: product.body.item.id } });
      // Started at 10, sold 4 (-> 6), reversed exactly once (+4 -> 10) - a
      // double-restore bug would show 14 instead.
      expect(Number(finalProduct.stockQuantity)).toBe(10);
    });
  });

  describe('Optical/Medical regression (Universal Sale stays industry-neutral)', () => {
    it('creating a sale never accepts or requires any Optical/Medical-specific field', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Neutral Sale Product', sellingPrice: 10, openingStock: 5 });
      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10, frameBrand: 'Ray-Ban', lensType: 'Bifocal' }],
          prescriptionId: 'not-a-real-field',
          paymentMethod: 'cash',
          amountPaid: 10,
        });
      expect(sale.status).toBe(201);
      expect(sale.body.item.frameBrand).toBeUndefined();
      expect(sale.body.item.prescriptionId).toBeUndefined();
      expect(sale.body.item.items[0].frameBrand).toBeUndefined();
    });
  });

  describe('Tenant/branch/warehouse isolation (re-verified for the new fields)', () => {
    it('Tenant B cannot view Tenant A\'s sale, including its new warehouseId/notes fields', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation Sale Product', sellingPrice: 10, openingStock: 5 });
      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10 }], notes: 'secret', paymentMethod: 'cash', amountPaid: 10 });

      const get = await request(app).get(`/api/sales/${sale.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);
    });
  });
});
