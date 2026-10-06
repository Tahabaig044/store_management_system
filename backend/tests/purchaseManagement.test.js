// Phase 1.9 - Purchase Management tests.
//
// Same DB requirements as business.test.js/salesManagement.test.js: point
// DATABASE_URL at a real, throwaway local Postgres database with all
// migrations applied (including 20260921020000_phase1_9_purchase_management)
// and the permission catalog seeded (including the new RFQ resource). NEVER
// point this at a database holding real tenant data.
//
// Base procurement CRUD/lifecycle (Purchase Request -> RFQ -> Quotations ->
// PO -> GRN) was already built and tested in Phase 5 (tests/procurement.test.js)
// and is not duplicated here. This file covers what's genuinely new/fixed in
// Phase 1.9: the RFQ permission-catalog migration, warehouseId/notes/variantId
// fields, new list filters, and - most importantly - the atomic, race-safe
// receiving/return/payment/status-transition fixes, verified with explicit
// concurrent scenarios mirroring Phase 1.8's methodology for Sales.
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

describe('Phase 1.9 - Purchase Management', () => {
  let tenantA;
  let tenantB;
  let supplierId;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase19 Tenant A');
    tenantB = await registerTenant('Phase19 Tenant B');
    const sup = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Phase19 Supplier' });
    supplierId = sup.body.item.id;
  });

  describe('RFQ RBAC migration to the centralized permission catalog (new in Phase 1.9)', () => {
    it('a STORE_KEEPER (INVENTORY_STAFF) can list/create RFQs via the RFQ permission, not a hardcoded role check', async () => {
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'RFQ Perm Product', sellingPrice: 10 });

      const list = await request(app).get('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeper.token}`);
      expect(list.status).toBe(200);

      const created = await request(app)
        .post('/api/procurement/rfqs')
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ items: [{ productId: product.body.item.id, quantity: 5 }], supplierIds: [supplierId] });
      expect(created.status).toBe(201);
    });

    it('a CASHIER (not INVENTORY_STAFF) is blocked from viewing/creating RFQs', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const list = await request(app).get('/api/procurement/rfqs').set('Authorization', `Bearer ${cashier.token}`);
      expect(list.status).toBe(403);

      const created = await request(app)
        .post('/api/procurement/rfqs')
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ items: [{ productId: '00000000-0000-0000-0000-000000000000', quantity: 1 }], supplierIds: [supplierId] });
      expect(created.status).toBe(403);
    });

    it('quotation selection remains restricted to MANAGEMENT (unchanged legacy gate)', async () => {
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'RFQ Select Product', sellingPrice: 10 });
      const rfq = await request(app)
        .post('/api/procurement/rfqs')
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ items: [{ productId: product.body.item.id, quantity: 5 }], supplierIds: [supplierId] });
      const quote = await request(app)
        .post(`/api/procurement/rfqs/${rfq.body.item.id}/quotations`)
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 5, unitPrice: 10 }] });

      const blocked = await request(app)
        .post(`/api/procurement/rfqs/${rfq.body.item.id}/quotations/${quote.body.item.id}/select`)
        .set('Authorization', `Bearer ${storeKeeper.token}`);
      expect(blocked.status).toBe(403);
    });
  });

  describe('warehouseId / notes / variantId (new in Phase 1.9)', () => {
    let branch;
    let warehouse;

    beforeAll(async () => {
      branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Purchase WH Branch' });
      warehouse = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Purchase Warehouse', branchId: branch.body.item.id });
    });

    it('a direct purchase can be created with a warehouseId the caller has access to', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'WH Purchase Product', sellingPrice: 20, purchasePrice: 10 });
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, warehouseId: warehouse.body.item.id, notes: 'Bulk restock', items: [{ productId: product.body.item.id, quantity: 5, unitCost: 10 }] });
      expect(purchase.status).toBe(201);
      expect(purchase.body.item.warehouseId).toBe(warehouse.body.item.id);
      expect(purchase.body.item.notes).toBe('Bulk restock');
    });

    it('a warehouseId belonging to another tenant is rejected on direct purchase create', async () => {
      const otherBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Branch' });
      const otherWarehouse = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Warehouse', branchId: otherBranch.body.item.id });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cross Tenant WH Purchase Product', sellingPrice: 10 });

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, warehouseId: otherWarehouse.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitCost: 5 }] });
      expect(purchase.status).toBe(404);
    });

    it('a STORE_KEEPER restricted to one branch cannot create a purchase attributed to a warehouse in another branch', async () => {
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Purchase Restricted Branch 2' });
      const warehouse2 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted Purchase WH 2', branchId: branch2.body.item.id });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted Purchase Product', sellingPrice: 10 });
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER', branch.body.item.id);

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ supplierId, warehouseId: warehouse2.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitCost: 5 }] });
      expect(purchase.status).toBe(403);
    });

    it('a purchase line can reference a specific ProductVariant', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Variant Purchase Product', sellingPrice: 10 });
      const variant = await request(app).post(`/api/products/${product.body.item.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Large' });

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, variantId: variant.body.item.id, quantity: 1, unitCost: 5 }] });
      expect(purchase.status).toBe(201);
      expect(purchase.body.item.items[0].variantId).toBe(variant.body.item.id);
    });

    it('a variantId that does not belong to the given product is rejected', async () => {
      const productA = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Purchase Product A', sellingPrice: 10 });
      const productB = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Purchase Product B', sellingPrice: 10 });
      const variantOfB = await request(app).post(`/api/products/${productB.body.item.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Belongs To B' });

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: productA.body.item.id, variantId: variantOfB.body.item.id, quantity: 1, unitCost: 5 }] });
      expect(purchase.status).toBe(404);
    });

    it('a GRN can carry a warehouseId, falling back to the linked PO\'s own warehouseId when omitted', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'GRN WH Product', sellingPrice: 10 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, warehouseId: warehouse.body.item.id, items: [{ productId: product.body.item.id, quantity: 5, unitCost: 10 }] });
      expect(po.body.item.warehouseId).toBe(warehouse.body.item.id);

      const grn = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: po.body.item.items[0].id, receivedQuantity: 5 }] });
      expect(grn.status).toBe(201);
      expect(grn.body.item.warehouseId).toBe(warehouse.body.item.id);
    });
  });

  describe('Search/filter (new query params in Phase 1.9)', () => {
    it('filters /api/purchases by supplierId and paymentStatus', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Filter Purchase Product', sellingPrice: 10 });
      await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 1, unitCost: 10 }], amountPaid: 5 });

      const res = await request(app).get('/api/purchases').set('Authorization', `Bearer ${tenantA.token}`).query({ supplierId, paymentStatus: 'PARTIAL' });
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((p) => p.supplierId === supplierId && p.paymentStatus === 'PARTIAL')).toBe(true);
    });
  });

  describe('Partial receiving: Ordered/Received/Remaining tracking (explicit Phase 1.9 requirement)', () => {
    it('PO qty=100: first GRN receives 40, second GRN receives 60 -> Ordered=100, Received=100, Remaining=0', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Partial Receive Product', sellingPrice: 10 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 100, unitCost: 10 }] });
      const poItemId = po.body.item.items[0].id;

      const grn1 = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 40 }] });
      expect(grn1.status).toBe(201);

      const mid = await request(app).get(`/api/procurement/purchase-orders/${po.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(mid.body.item.status).toBe('PARTIALLY_RECEIVED');
      expect(Number(mid.body.item.items[0].receivedQuantity)).toBe(40);
      expect(Number(mid.body.item.items[0].quantity) - Number(mid.body.item.items[0].receivedQuantity)).toBe(60); // Remaining

      const grn2 = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 60 }] });
      expect(grn2.status).toBe(201);

      const final = await request(app).get(`/api/procurement/purchase-orders/${po.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(final.body.item.status).toBe('RECEIVED');
      expect(Number(final.body.item.items[0].quantity)).toBe(100); // Ordered
      expect(Number(final.body.item.items[0].receivedQuantity)).toBe(100); // Received
      expect(Number(final.body.item.items[0].quantity) - Number(final.body.item.items[0].receivedQuantity)).toBe(0); // Remaining
    });

    it('cannot receive against a CANCELLED purchase order', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cancelled PO Product', sellingPrice: 10 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 10, unitCost: 10 }] });
      const cancel = await request(app).post(`/api/procurement/purchase-orders/${po.body.item.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(cancel.status).toBe(200);
      expect(cancel.body.item.status).toBe('CANCELLED');

      const grn = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: po.body.item.items[0].id, receivedQuantity: 1 }] });
      expect(grn.status).toBe(409);
    });
  });

  describe('Concurrency: atomic receiving under a real race (new in Phase 1.9)', () => {
    it('PO qty=100: Terminal A receives 70, Terminal B receives 50 simultaneously - exactly one succeeds, final received is never > 100', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Race GRN Product', sellingPrice: 10 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 100, unitCost: 10 }] });
      const poItemId = po.body.item.items[0].id;

      const [resultA, resultB] = await Promise.all([
        request(app).post('/api/procurement/goods-receipts').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 70 }] }),
        request(app).post('/api/procurement/goods-receipts').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 50 }] }),
      ]);

      const statuses = [resultA.status, resultB.status].sort();
      // Exactly one must succeed (201) and the other must be rejected (409) -
      // both succeeding would mean 70+50=120 was received against a 100-unit
      // order (a lost-update race), which must never happen.
      expect(statuses).toEqual([201, 409]);

      const finalItem = await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } });
      const finalReceived = Number(finalItem.receivedQuantity);
      expect([70, 50]).toContain(finalReceived);
      expect(finalReceived).toBeLessThanOrEqual(100);

      const finalProduct = await prisma.product.findUnique({ where: { id: product.body.item.id } });
      // Stock must reflect exactly the winning GRN's quantity - never both.
      expect(Number(finalProduct.stockQuantity)).toBe(finalReceived);
    });

    it('PO qty=100: two simultaneous GRNs for 40 and 60 (sum fits exactly): both succeed, final received is exactly 100', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Race GRN Product Fits', sellingPrice: 10 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 100, unitCost: 10 }] });
      const poItemId = po.body.item.items[0].id;

      const [resultA, resultB] = await Promise.all([
        request(app).post('/api/procurement/goods-receipts').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 40 }] }),
        request(app).post('/api/procurement/goods-receipts').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 60 }] }),
      ]);

      expect(resultA.status).toBe(201);
      expect(resultB.status).toBe(201);

      const finalItem = await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } });
      expect(Number(finalItem.receivedQuantity)).toBe(100);

      const finalPo = await prisma.purchaseOrder.findUnique({ where: { id: po.body.item.id } });
      expect(finalPo.status).toBe('RECEIVED');

      const finalProduct = await prisma.product.findUnique({ where: { id: product.body.item.id } });
      expect(Number(finalProduct.stockQuantity)).toBe(100); // both GRNs' stock increments landed, none lost
    });

    it('a concurrent double-approve of the SAME pending PO only approves once', async () => {
      await request(app).put('/api/settings/purchaseApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '1' });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Double Approve Product', sellingPrice: 10 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 10, unitCost: 10 }] }); // total 100 > threshold 1
      expect(po.body.item.status).toBe('PENDING_APPROVAL');

      const [approveA, approveB] = await Promise.all([
        request(app).post(`/api/procurement/purchase-orders/${po.body.item.id}/approve`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/procurement/purchase-orders/${po.body.item.id}/approve`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [approveA.status, approveB.status].sort();
      expect(statuses).toEqual([200, 409]);

      await request(app).put('/api/settings/purchaseApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '999999' });
    });

    it('a concurrent cancel racing a concurrent receive on the same PO never leaves it CANCELLED-with-stock-already-received silently corrupted', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cancel Vs Receive Product', sellingPrice: 10 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 10, unitCost: 10 }] });

      const [cancelResult, grnResult] = await Promise.all([
        request(app).post(`/api/procurement/purchase-orders/${po.body.item.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post('/api/procurement/goods-receipts').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: po.body.item.items[0].id, receivedQuantity: 10 }] }),
      ]);

      const finalPo = await prisma.purchaseOrder.findUnique({ where: { id: po.body.item.id } });
      const finalProduct = await prisma.product.findUnique({ where: { id: product.body.item.id } });

      if (finalPo.status === 'CANCELLED') {
        // Cancel won: the GRN must NOT have silently applied stock anyway.
        expect(grnResult.status).not.toBe(201);
        expect(Number(finalProduct.stockQuantity)).toBe(0);
      } else {
        // GRN won: it must be fully, consistently applied (RECEIVED, stock in).
        expect(grnResult.status).toBe(201);
        expect(finalPo.status).toBe('RECEIVED');
        expect(Number(finalProduct.stockQuantity)).toBe(10);
        expect(cancelResult.status).not.toBe(200);
      }
    });
  });

  describe('Concurrency: Purchase return and payment (new in Phase 1.9)', () => {
    async function createReceivedPurchase(stock) {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `Return Product ${Date.now()}-${Math.random()}`, sellingPrice: 10, purchasePrice: 5 });
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, receiveImmediately: true, items: [{ productId: product.body.item.id, quantity: stock, unitCost: 5 }] });
      return { productId: product.body.item.id, purchaseId: purchase.body.item.id };
    }

    it('a concurrent double-return of the SAME purchase only reverses stock once', async () => {
      const { productId, purchaseId } = await createReceivedPurchase(10);

      const [returnA, returnB] = await Promise.all([
        request(app).post(`/api/purchases/${purchaseId}/return`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/purchases/${purchaseId}/return`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [returnA.status, returnB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const finalProduct = await prisma.product.findUnique({ where: { id: productId } });
      // Started with 10 received; exactly one return of 10 must have applied
      // (-> 0), never both (-10) and never neither (still 10).
      expect(Number(finalProduct.stockQuantity)).toBe(0);
    });

    it('two concurrent payments on the same purchase never together exceed its total', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Payment Race Product', sellingPrice: 10 });
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 10, unitCost: 10 }] }); // total 100
      expect(purchase.status).toBe(201);

      const [payA, payB] = await Promise.all([
        request(app).post(`/api/purchases/${purchase.body.item.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 70 }),
        request(app).post(`/api/purchases/${purchase.body.item.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 60 }),
      ]);
      const statuses = [payA.status, payB.status].sort();
      // 70+60=130 > 100 total, so exactly one payment must be rejected -
      // a lost-update race could otherwise let both through.
      expect(statuses).toEqual([200, 422]);

      const finalPurchase = await prisma.purchase.findUnique({ where: { id: purchase.body.item.id } });
      expect(Number(finalPurchase.amountPaid)).toBeLessThanOrEqual(100);
      expect([70, 60]).toContain(Number(finalPurchase.amountPaid));
    });

    it('two concurrent payments that together fit within the total both succeed and sum correctly', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Payment Fits Product', sellingPrice: 10 });
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 10, unitCost: 10 }] }); // total 100

      const [payA, payB] = await Promise.all([
        request(app).post(`/api/purchases/${purchase.body.item.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 40 }),
        request(app).post(`/api/purchases/${purchase.body.item.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 60 }),
      ]);
      expect(payA.status).toBe(200);
      expect(payB.status).toBe(200);

      const finalPurchase = await prisma.purchase.findUnique({ where: { id: purchase.body.item.id } });
      expect(Number(finalPurchase.amountPaid)).toBe(100);
      expect(finalPurchase.paymentStatus).toBe('PAID');
    });
  });

  describe('Purchase numbering under concurrency (audited per the Phase 1.8 precedent)', () => {
    it('creating many purchases concurrently for the same tenant never produces a 500 or a silently dropped purchase', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Numbering Race Product', sellingPrice: 10 });

      const results = await Promise.all(
        Array.from({ length: 8 }).map(() =>
          request(app)
            .post('/api/purchases')
            .set('Authorization', `Bearer ${tenantA.token}`)
            .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 1, unitCost: 5 }] })
        )
      );

      // Every concurrent create must either succeed outright, or fail with a
      // clean, well-formed error - never an unhandled 500. This directly
      // audits for the Phase 1.8-class invoiceNumber/purchaseNumber
      // collision under concurrent creates using the same shared
      // nextSequenceNumber utility (Phase 0.6).
      for (const res of results) {
        expect(res.status).not.toBe(500);
      }
      const succeeded = results.filter((r) => r.status === 201);
      const purchaseNumbers = succeeded.map((r) => r.body.item.purchaseNumber);
      expect(new Set(purchaseNumbers).size).toBe(purchaseNumbers.length); // no duplicate numbers among successes
    });
  });

  describe('Optical/Medical regression (Universal Purchase stays industry-neutral)', () => {
    it('creating a purchase never accepts or requires any Optical/Medical-specific field', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Neutral Purchase Product', sellingPrice: 10 });
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          supplierId,
          items: [{ productId: product.body.item.id, quantity: 1, unitCost: 10, frameBrand: 'Ray-Ban', lensType: 'Bifocal' }],
          prescriptionId: 'not-a-real-field',
        });
      expect(purchase.status).toBe(201);
      expect(purchase.body.item.frameBrand).toBeUndefined();
      expect(purchase.body.item.prescriptionId).toBeUndefined();
      expect(purchase.body.item.items[0].frameBrand).toBeUndefined();
    });
  });

  describe('Tenant/branch isolation (re-verified for the new fields)', () => {
    it('Tenant B cannot view Tenant A\'s purchase, including its new warehouseId/notes fields', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation Purchase Product', sellingPrice: 10 });
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 1, unitCost: 10 }], notes: 'secret' });

      const get = await request(app).get(`/api/purchases/${purchase.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);
    });

    it('Tenant B cannot view Tenant A\'s GRN', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation GRN Product', sellingPrice: 10 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: product.body.item.id, quantity: 5, unitCost: 10 }] });
      const grn = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: po.body.item.items[0].id, receivedQuantity: 5 }] });

      const get = await request(app).get(`/api/procurement/goods-receipts/${grn.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);
    });
  });
});
