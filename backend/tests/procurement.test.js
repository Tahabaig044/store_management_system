// Phase 5 - professional procurement lifecycle tests:
// Purchase Request -> RFQ -> Supplier Quotations -> Comparison -> Approval
// -> Purchase Order -> Goods Receipt -> Inventory -> (existing) Purchase/Payment.
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

async function createUserToken(adminToken, role) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return login.body.token;
}

describe('Phase 5 - Procurement lifecycle', () => {
  let tenantA;
  let tenantB;
  let storeKeeperA;
  let cashierA;
  let productId;
  let supplierId;
  let supplier2Id;

  beforeAll(async () => {
    tenantA = await registerTenant(`Procurement Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`Procurement Tenant B ${Date.now()}`);
    storeKeeperA = await createUserToken(tenantA.token, 'STORE_KEEPER');
    cashierA = await createUserToken(tenantA.token, 'CASHIER');

    const prod = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({ name: 'Procurement Test Product', purchasePrice: 20, sellingPrice: 35, openingStock: 0 });
    productId = prod.body.item.id;

    const sup1 = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Procurement Supplier 1' });
    supplierId = sup1.body.item.id;
    const sup2 = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Procurement Supplier 2' });
    supplier2Id = sup2.body.item.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Purchase Request', () => {
    test('a store keeper can create a request; a cashier cannot', async () => {
      const forbidden = await request(app)
        .post('/api/procurement/purchase-requests')
        .set('Authorization', `Bearer ${cashierA}`)
        .send({ items: [{ productId, quantity: 10 }] });
      expect(forbidden.status).toBe(403);

      const res = await request(app)
        .post('/api/procurement/purchase-requests')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 10 }] });
      expect(res.status).toBe(201);
      expect(res.body.item.status).toBe('PENDING_APPROVAL');
    });

    test('only MANAGEMENT can approve/reject a request', async () => {
      const pr = await request(app)
        .post('/api/procurement/purchase-requests')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 5 }] });

      const forbidden = await request(app).post(`/api/procurement/purchase-requests/${pr.body.item.id}/approve`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(forbidden.status).toBe(403);

      const approved = await request(app).post(`/api/procurement/purchase-requests/${pr.body.item.id}/approve`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(approved.status).toBe(200);
      expect(approved.body.item.status).toBe('APPROVED');

      // Cannot approve twice.
      const secondApprove = await request(app).post(`/api/procurement/purchase-requests/${pr.body.item.id}/approve`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(secondApprove.status).toBe(409);
    });

    test('rejecting requires a reason', async () => {
      const pr = await request(app)
        .post('/api/procurement/purchase-requests')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 5 }] });

      const noReason = await request(app).post(`/api/procurement/purchase-requests/${pr.body.item.id}/reject`).set('Authorization', `Bearer ${tenantA.token}`).send({});
      expect(noReason.status).toBe(422);

      const rejected = await request(app)
        .post(`/api/procurement/purchase-requests/${pr.body.item.id}/reject`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ reason: 'Not needed right now' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.item.status).toBe('REJECTED');
    });
  });

  describe('RFQ and Supplier Quotations', () => {
    let rfqId;

    test('an RFQ can be created inviting specific suppliers', async () => {
      const res = await request(app)
        .post('/api/procurement/rfqs')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 20 }], supplierIds: [supplierId, supplier2Id] });
      expect(res.status).toBe(201);
      expect(res.body.item.suppliers).toHaveLength(2);
      rfqId = res.body.item.id;
    });

    test('a supplier not invited to the RFQ cannot submit a quotation', async () => {
      const uninvited = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Uninvited Supplier' });
      const res = await request(app)
        .post(`/api/procurement/rfqs/${rfqId}/quotations`)
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId: uninvited.body.item.id, items: [{ productId, quantity: 20, unitPrice: 15 }] });
      expect(res.status).toBe(422);
    });

    test('invited suppliers can submit quotations, and comparison recommends the lowest total', async () => {
      const q1 = await request(app)
        .post(`/api/procurement/rfqs/${rfqId}/quotations`)
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, deliveryDays: 5, items: [{ productId, quantity: 20, unitPrice: 18 }] });
      expect(q1.status).toBe(201);

      const q2 = await request(app)
        .post(`/api/procurement/rfqs/${rfqId}/quotations`)
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId: supplier2Id, deliveryDays: 2, items: [{ productId, quantity: 20, unitPrice: 15 }] });
      expect(q2.status).toBe(201);

      const compare = await request(app).get(`/api/procurement/rfqs/${rfqId}/compare`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(compare.status).toBe(200);
      expect(compare.body.quotations).toHaveLength(2);
      expect(compare.body.recommendation.lowestTotalId).toBe(q2.body.item.id); // 15/unit is cheaper than 18/unit
      expect(compare.body.recommendation.fastestDeliveryId).toBe(q2.body.item.id); // also faster (2 days vs 5)
    });

    test('selecting a quotation closes the RFQ, rejects the other, and creates an approved PO', async () => {
      const compare = await request(app).get(`/api/procurement/rfqs/${rfqId}/compare`).set('Authorization', `Bearer ${storeKeeperA}`);
      const winningQuotation = compare.body.quotations.find((q) => q.id === compare.body.recommendation.lowestTotalId);

      const selected = await request(app)
        .post(`/api/procurement/rfqs/${rfqId}/quotations/${winningQuotation.id}/select`)
        .set('Authorization', `Bearer ${tenantA.token}`);
      expect(selected.status).toBe(201);
      expect(selected.body.item.status).toBe('APPROVED'); // no threshold configured => auto-approved
      expect(Number(selected.body.item.total)).toBeCloseTo(20 * 15, 2);

      const rfq = await request(app).get(`/api/procurement/rfqs/${rfqId}`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(rfq.body.item.status).toBe('CLOSED');
      const loser = rfq.body.item.quotations.find((q) => q.id !== winningQuotation.id);
      expect(loser.status).toBe('REJECTED');
    });

    test('selecting a quotation is restricted to MANAGEMENT', async () => {
      const rfq2 = await request(app)
        .post('/api/procurement/rfqs')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 5 }], supplierIds: [supplierId] });
      const q = await request(app)
        .post(`/api/procurement/rfqs/${rfq2.body.item.id}/quotations`)
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 5, unitPrice: 10 }] });

      const res = await request(app)
        .post(`/api/procurement/rfqs/${rfq2.body.item.id}/quotations/${q.body.item.id}/select`)
        .set('Authorization', `Bearer ${storeKeeperA}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Purchase Order approval thresholds', () => {
    test('with no threshold configured, a PO auto-approves', async () => {
      const res = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 5, unitCost: 20 }] });
      expect(res.status).toBe(201);
      expect(res.body.item.status).toBe('APPROVED');
    });

    test('once a threshold is configured, a PO above it requires approval', async () => {
      await request(app)
        .put('/api/settings/purchaseApprovalThreshold')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ value: '50' });

      const belowThreshold = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 2, unitCost: 20 }] }); // total 40 < 50
      expect(belowThreshold.body.item.status).toBe('APPROVED');

      const aboveThreshold = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 10, unitCost: 20 }] }); // total 200 > 50
      expect(aboveThreshold.body.item.status).toBe('PENDING_APPROVAL');

      // Cannot receive against a PO still pending approval.
      const grnAttempt = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: aboveThreshold.body.item.id, items: [{ purchaseOrderItemId: aboveThreshold.body.item.items[0].id, receivedQuantity: 1 }] });
      expect(grnAttempt.status).toBe(409);

      const approved = await request(app).post(`/api/procurement/purchase-orders/${aboveThreshold.body.item.id}/approve`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(approved.body.item.status).toBe('APPROVED');

      // Reset threshold so later tests in this file aren't affected.
      await request(app).put('/api/settings/purchaseApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '999999' });
    });
  });

  describe('Goods Receipt (GRN)', () => {
    let poId;
    let poItemId;

    beforeEach(async () => {
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 10, unitCost: 20 }] });
      poId = po.body.item.id;
      poItemId = po.body.item.items[0].id;
    });

    test('a full receipt increases stock, creates a Purchase, and marks the PO RECEIVED', async () => {
      const before = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      const beforeStock = Number(before.body.item.stockQuantity);

      const grn = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10 }] });
      expect(grn.status).toBe(201);
      expect(grn.body.item.purchase).toBeDefined();
      expect(Number(grn.body.item.purchase.total)).toBeCloseTo(200, 2);

      const after = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(beforeStock + 10);

      const po = await request(app).get(`/api/procurement/purchase-orders/${poId}`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(po.body.item.status).toBe('RECEIVED');
    });

    test('a partial receipt marks the PO PARTIALLY_RECEIVED, and a second GRN completes it', async () => {
      const grn1 = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 6 }] });
      expect(grn1.status).toBe(201);

      const midPo = await request(app).get(`/api/procurement/purchase-orders/${poId}`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(midPo.body.item.status).toBe('PARTIALLY_RECEIVED');
      expect(Number(midPo.body.item.items[0].receivedQuantity)).toBe(6);

      const grn2 = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 4 }] });
      expect(grn2.status).toBe(201);

      const finalPo = await request(app).get(`/api/procurement/purchase-orders/${poId}`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(finalPo.body.item.status).toBe('RECEIVED');
    });

    test('rejected/damaged quantities do not enter stock or cost', async () => {
      const before = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      const beforeStock = Number(before.body.item.stockQuantity);

      const grn = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 6, rejectedQuantity: 3, damagedQuantity: 1 }] });
      expect(grn.status).toBe(201);
      expect(Number(grn.body.item.purchase.total)).toBeCloseTo(6 * 20, 2); // only accepted qty costed

      const after = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(beforeStock + 6); // not +10

      const po = await request(app).get(`/api/procurement/purchase-orders/${poId}`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(po.body.item.status).toBe('RECEIVED'); // 6+3+1 = 10, fully accounted for even though only 6 accepted
    });

    test('cannot receive more than the remaining ordered quantity', async () => {
      const res = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 999 }] });
      expect(res.status).toBe(422);
    });

    test('a retried GRN submission with the same idempotencyKey is deduplicated, not double-counted', async () => {
      const idempotencyKey = `grn-test-${Date.now()}`;
      const first = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 5 }], idempotencyKey });
      expect(first.status).toBe(201);

      const beforeRetryStock = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);

      const retry = await request(app)
        .post('/api/procurement/goods-receipts')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 5 }], idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const afterRetryStock = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(afterRetryStock.body.item.stockQuantity)).toBe(Number(beforeRetryStock.body.item.stockQuantity)); // unchanged
    });
  });

  describe('Tenant isolation across the procurement pipeline', () => {
    test('tenant B cannot see or act on tenant A\'s purchase requests, RFQs, or POs', async () => {
      const storeKeeperB = await createUserToken(tenantB.token, 'STORE_KEEPER');

      const pr = await request(app)
        .post('/api/procurement/purchase-requests')
        .set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 1 }] });

      const crossTenantGet = await request(app).get(`/api/procurement/purchase-requests/${pr.body.item.id}`).set('Authorization', `Bearer ${storeKeeperB}`);
      expect(crossTenantGet.status).toBe(404);

      const list = await request(app).get('/api/procurement/purchase-requests').set('Authorization', `Bearer ${storeKeeperB}`);
      expect(list.body.items.find((i) => i.id === pr.body.item.id)).toBeUndefined();
    });

    test('a PO cannot be created against another tenant\'s supplier', async () => {
      const storeKeeperB = await createUserToken(tenantB.token, 'STORE_KEEPER');
      const res = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${storeKeeperB}`)
        .send({ supplierId, items: [{ productId, quantity: 1, unitCost: 10 }] }); // supplierId/productId belong to tenant A
      expect(res.status).toBe(404);
    });
  });
});
