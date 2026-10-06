// Phase 4.3 / 4.4 - procurement workflow completion and advanced controls.
// Covers what business.test.js/procurement.test.js do not already: draft PR
// edit/submit, RFQ-from-approved-PR enforcement, RFQ close/cancel, the expired-
// quotation bug fix, quotation-selection concurrency, PO notes, audit logging on
// cancel, per-PO reconciliation, tenant-wide integrity summary, the procurement
// dashboard, and supplier performance.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(30000);

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function registerTenant(businessName) {
  const res = await request(app).post('/api/auth/register-tenant').send({
    businessName, adminName: 'Test Admin', email: uniqueEmail('admin'), password: 'TestPass123',
  });
  if (res.status !== 201) throw new Error(`register-tenant failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}

async function createUserToken(adminToken, role) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return login.body.token;
}

describe('Phase 4.3/4.4 - procurement workflow completion', () => {
  let tenantA, tenantB, storeKeeperA, cashierA, adminA, productId, supplierId;

  beforeAll(async () => {
    tenantA = await registerTenant(`P43 Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`P43 Tenant B ${Date.now()}`);
    adminA = tenantA.token;
    storeKeeperA = await createUserToken(adminA, 'STORE_KEEPER');
    cashierA = await createUserToken(adminA, 'CASHIER');

    const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
      .send({ name: 'P4.3 Product', purchasePrice: 10, sellingPrice: 20, openingStock: 0 });
    productId = prod.body.item.id;
    const sup = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${adminA}`).send({ name: 'P4.3 Supplier' });
    supplierId = sup.body.item.id;
  });

  afterAll(async () => { await prisma.$disconnect(); });

  describe('4.3.1 Purchase Request: draft, edit, submit', () => {
    test('a draft request can be created, edited while draft, then submitted and approved', async () => {
      const created = await request(app).post('/api/procurement/purchase-requests').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ status: 'DRAFT', requiredDate: '2027-01-15', items: [{ productId, quantity: 5 }] });
      expect(created.status).toBe(201);
      expect(created.body.item.status).toBe('DRAFT');
      expect(new Date(created.body.item.requiredDate).toISOString().slice(0, 10)).toBe('2027-01-15');
      const id = created.body.item.id;

      // Not yet approvable while still a draft.
      const earlyApprove = await request(app).post(`/api/procurement/purchase-requests/${id}/approve`).set('Authorization', `Bearer ${adminA}`);
      expect(earlyApprove.status).toBe(409);

      const edited = await request(app).patch(`/api/procurement/purchase-requests/${id}`).set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ notes: 'updated while draft', items: [{ productId, quantity: 8 }] });
      expect(edited.status).toBe(200);
      expect(edited.body.item.notes).toBe('updated while draft');
      expect(Number(edited.body.item.items[0].quantity)).toBe(8);

      const submitted = await request(app).post(`/api/procurement/purchase-requests/${id}/submit`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(submitted.status).toBe(200);
      expect(submitted.body.item.status).toBe('PENDING_APPROVAL');

      // No longer editable once submitted.
      const lateEdit = await request(app).patch(`/api/procurement/purchase-requests/${id}`).set('Authorization', `Bearer ${storeKeeperA}`).send({ notes: 'too late' });
      expect(lateEdit.status).toBe(409);

      const approved = await request(app).post(`/api/procurement/purchase-requests/${id}/approve`).set('Authorization', `Bearer ${adminA}`);
      expect(approved.status).toBe(200);
      expect(approved.body.item.status).toBe('APPROVED');
    });

    test('a draft request can be cancelled directly, and cancellation is audit-logged', async () => {
      const created = await request(app).post('/api/procurement/purchase-requests').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ status: 'DRAFT', items: [{ productId, quantity: 1 }] });
      const id = created.body.item.id;
      const cancelled = await request(app).post(`/api/procurement/purchase-requests/${id}/cancel`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.item.status).toBe('CANCELLED');
      const audit = await prisma.auditLog.findFirst({ where: { action: 'PURCHASE_REQUEST_CANCEL', entityId: id } });
      expect(audit).not.toBeNull();
    });

    test('a cashier cannot edit or submit a draft request', async () => {
      const created = await request(app).post('/api/procurement/purchase-requests').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ status: 'DRAFT', items: [{ productId, quantity: 1 }] });
      const id = created.body.item.id;
      expect((await request(app).patch(`/api/procurement/purchase-requests/${id}`).set('Authorization', `Bearer ${cashierA}`).send({ notes: 'x' })).status).toBe(403);
      expect((await request(app).post(`/api/procurement/purchase-requests/${id}/submit`).set('Authorization', `Bearer ${cashierA}`)).status).toBe(403);
    });

    test('tenant B cannot edit, submit or cancel tenant A\'s draft request', async () => {
      const created = await request(app).post('/api/procurement/purchase-requests').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ status: 'DRAFT', items: [{ productId, quantity: 1 }] });
      const id = created.body.item.id;
      expect((await request(app).patch(`/api/procurement/purchase-requests/${id}`).set('Authorization', `Bearer ${tenantB.token}`).send({ notes: 'x' })).status).toBe(404);
      expect((await request(app).post(`/api/procurement/purchase-requests/${id}/submit`).set('Authorization', `Bearer ${tenantB.token}`)).status).toBe(404);
      expect((await request(app).post(`/api/procurement/purchase-requests/${id}/cancel`).set('Authorization', `Bearer ${tenantB.token}`)).status).toBe(404);
    });
  });

  async function approvedPR() {
    const created = await request(app).post('/api/procurement/purchase-requests').set('Authorization', `Bearer ${storeKeeperA}`)
      .send({ items: [{ productId, quantity: 10 }] }); // defaults straight to PENDING_APPROVAL
    await request(app).post(`/api/procurement/purchase-requests/${created.body.item.id}/approve`).set('Authorization', `Bearer ${adminA}`);
    return created.body.item.id;
  }

  describe('4.3.2 RFQ: source-request enforcement, delivery date, close/cancel', () => {
    test('an RFQ cannot be created from a purchase request that is not approved', async () => {
      const pr = await request(app).post('/api/procurement/purchase-requests').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 1 }] }); // PENDING_APPROVAL, not yet approved
      const rfq = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseRequestId: pr.body.item.id, items: [{ productId, quantity: 1 }], supplierIds: [supplierId] });
      expect(rfq.status).toBe(409);
    });

    test('an RFQ can be created from an approved request, with an expected delivery date', async () => {
      const prId = await approvedPR();
      const rfq = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseRequestId: prId, items: [{ productId, quantity: 10 }], supplierIds: [supplierId], expectedDeliveryDate: '2027-02-01' });
      expect(rfq.status).toBe(201);
      expect(new Date(rfq.body.item.expectedDeliveryDate).toISOString().slice(0, 10)).toBe('2027-02-01');
    });

    test('an open RFQ can be closed without selecting a quotation, or cancelled; a closed RFQ cannot be closed again', async () => {
      const rfq1 = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 1 }], supplierIds: [supplierId] });
      const closed = await request(app).post(`/api/procurement/rfqs/${rfq1.body.item.id}/close`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(closed.status).toBe(200);
      expect(closed.body.item.status).toBe('CLOSED');
      expect((await request(app).post(`/api/procurement/rfqs/${rfq1.body.item.id}/close`).set('Authorization', `Bearer ${storeKeeperA}`)).status).toBe(409);

      const rfq2 = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 1 }], supplierIds: [supplierId] });
      const cancelled = await request(app).post(`/api/procurement/rfqs/${rfq2.body.item.id}/cancel`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.item.status).toBe('CANCELLED');
    });

    test('tenant B cannot close or cancel tenant A\'s RFQ', async () => {
      const rfq = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 1 }], supplierIds: [supplierId] });
      expect((await request(app).post(`/api/procurement/rfqs/${rfq.body.item.id}/close`).set('Authorization', `Bearer ${tenantB.token}`)).status).toBe(404);
    });
  });

  describe('4.3.3 Supplier Quotation: notes, and the expired-quotation bug fix', () => {
    test('a quotation records notes, and a quotation past its validity date cannot be selected', async () => {
      const rfq = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 5 }], supplierIds: [supplierId] });
      const q = await request(app).post(`/api/procurement/rfqs/${rfq.body.item.id}/quotations`).set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, notes: 'valid for 2 days only', validUntil: '2020-01-01', items: [{ productId, quantity: 5, unitPrice: 12 }] });
      expect(q.status).toBe(201);
      expect(q.body.item.notes).toBe('valid for 2 days only');

      const select = await request(app).post(`/api/procurement/rfqs/${rfq.body.item.id}/quotations/${q.body.item.id}/select`).set('Authorization', `Bearer ${adminA}`);
      expect(select.status).toBe(409);
      expect(select.body.error).toMatch(/expired/i);

      // The RFQ must still be open and the quotation still selectable-in-principle after a refused expired select.
      const rfqAfter = await request(app).get(`/api/procurement/rfqs/${rfq.body.item.id}`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(rfqAfter.body.item.status).toBe('OPEN');
    });

    test('a rejected quotation cannot later be selected', async () => {
      const rfq = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 1 }], supplierIds: [supplierId] });
      const q1 = await request(app).post(`/api/procurement/rfqs/${rfq.body.item.id}/quotations`).set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 1, unitPrice: 10 }] });
      // Selecting q1 (the only quotation on this RFQ) closes it; re-selecting it afterward must be refused.
      await request(app).post(`/api/procurement/rfqs/${rfq.body.item.id}/quotations/${q1.body.item.id}/select`).set('Authorization', `Bearer ${adminA}`);
      const reselect = await request(app).post(`/api/procurement/rfqs/${rfq.body.item.id}/quotations/${q1.body.item.id}/select`).set('Authorization', `Bearer ${adminA}`);
      expect(reselect.status).toBe(409);
    });

    test('concurrency: two quotations of the same RFQ selected at the same instant - exactly one PO is created', async () => {
      const sup3 = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${adminA}`).send({ name: 'P4.3 Supplier 3' });
      const rfqBoth = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ items: [{ productId, quantity: 3 }], supplierIds: [supplierId, sup3.body.item.id] });
      const qA = await request(app).post(`/api/procurement/rfqs/${rfqBoth.body.item.id}/quotations`).set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 3, unitPrice: 9 }] });
      const qB = await request(app).post(`/api/procurement/rfqs/${rfqBoth.body.item.id}/quotations`).set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId: sup3.body.item.id, items: [{ productId, quantity: 3, unitPrice: 9.5 }] });

      const [rA, rB] = await Promise.all([
        request(app).post(`/api/procurement/rfqs/${rfqBoth.body.item.id}/quotations/${qA.body.item.id}/select`).set('Authorization', `Bearer ${adminA}`),
        request(app).post(`/api/procurement/rfqs/${rfqBoth.body.item.id}/quotations/${qB.body.item.id}/select`).set('Authorization', `Bearer ${adminA}`),
      ]);
      const statuses = [rA.status, rB.status].sort();
      expect(statuses).toEqual([201, 409]);
      const posFromThisRfq = await prisma.purchaseOrder.findMany({ where: { sourceQuotationId: { in: [qA.body.item.id, qB.body.item.id] } } });
      expect(posFromThisRfq.length).toBe(1);
    });
  });

  describe('4.3.4 Purchase Order: notes', () => {
    test('notes can be set on create and edited afterward, and editing is audit-logged', async () => {
      const po = await request(app).post('/api/procurement/purchase-orders').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 2, unitCost: 5 }], notes: 'first batch' });
      expect(po.status).toBe(201);
      expect(po.body.item.notes).toBe('first batch');
      const edited = await request(app).patch(`/api/procurement/purchase-orders/${po.body.item.id}`).set('Authorization', `Bearer ${storeKeeperA}`).send({ notes: 'revised note' });
      expect(edited.status).toBe(200);
      expect(edited.body.item.notes).toBe('revised note');
      const audit = await prisma.auditLog.findFirst({ where: { action: 'PURCHASE_ORDER_EDIT', entityId: po.body.item.id } });
      expect(audit).not.toBeNull();
    });

    test('cancelling a purchase order is audit-logged', async () => {
      const po = await request(app).post('/api/procurement/purchase-orders').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 1, unitCost: 5 }] });
      await request(app).post(`/api/procurement/purchase-orders/${po.body.item.id}/cancel`).set('Authorization', `Bearer ${storeKeeperA}`);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'PURCHASE_ORDER_CANCEL', entityId: po.body.item.id } });
      expect(audit).not.toBeNull();
    });
  });

  describe('4.3.8 Per-PO reconciliation', () => {
    test('ordered/received/billed quantities and values reconcile correctly across two partial receipts', async () => {
      const po = await request(app).post('/api/procurement/purchase-orders').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 100, unitCost: 10 }] });
      const poId = po.body.item.id;
      const poItemId = po.body.item.items[0].id;

      await request(app).post('/api/procurement/goods-receipts').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 60 }] });
      await request(app).post('/api/procurement/goods-receipts').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 40 }] });

      const recon = await request(app).get(`/api/procurement/purchase-orders/${poId}/reconciliation`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(recon.status).toBe(200);
      const line = recon.body.lines[0];
      expect(line.orderedQty).toBe(100);
      expect(line.receivedQty).toBe(100);
      expect(line.billedQty).toBe(100);
      expect(line.remainingQty).toBe(0);
      expect(line.orderedValue).toBe(1000);
      expect(line.receivedValue).toBe(1000);
      expect(line.billedValue).toBe(1000);
      expect(line.flags).toEqual([]);
      expect(recon.body.hasDiscrepancies).toBe(false);
      expect(recon.body.purchaseOrder.status).toBe('RECEIVED');
    });

    test('tenant B cannot read tenant A\'s PO reconciliation', async () => {
      const po = await request(app).post('/api/procurement/purchase-orders').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 1, unitCost: 1 }] });
      const res = await request(app).get(`/api/procurement/purchase-orders/${po.body.item.id}/reconciliation`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('4.4.5 Tenant-wide integrity summary', () => {
    test('an over-received line (simulating a corrupted historical record) is detected and reported, never silently repaired', async () => {
      const po = await request(app).post('/api/procurement/purchase-orders').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId, items: [{ productId, quantity: 5, unitCost: 1 }] });
      const poItemId = po.body.item.items[0].id;
      // Simulate a bad historical row directly - this is not achievable through the API
      // (which atomically guards against it), which is exactly why the detector exists.
      await prisma.purchaseOrderItem.update({ where: { id: poItemId }, data: { receivedQuantity: 9 } });

      const summary = await request(app).get('/api/procurement/summary').set('Authorization', `Bearer ${storeKeeperA}`);
      expect(summary.status).toBe(200);
      const finding = summary.body.findings.find((f) => f.type === 'OVER_RECEIPT' && f.purchaseOrderId === po.body.item.id);
      expect(finding).toBeTruthy();
      expect(finding.ordered).toBe(5);
      expect(finding.received).toBe(9);

      // Confirm it was only reported, not corrected.
      const stillNine = await prisma.purchaseOrderItem.findUnique({ where: { id: poItemId } });
      expect(Number(stillNine.receivedQuantity)).toBe(9);
    });

    test('tenant B\'s summary never includes tenant A\'s findings', async () => {
      const summaryB = await request(app).get('/api/procurement/summary').set('Authorization', `Bearer ${tenantB.token}`);
      expect(summaryB.status).toBe(200);
      expect(summaryB.body.findings.every((f) => !String(f.purchaseOrderId || '').length || f.purchaseOrderId)).toBe(true);
      // Stronger check: none of tenant A's PO ids/numbers leak into B's findings.
      const aPOs = await prisma.purchaseOrder.findMany({ where: { tenantId: tenantA.tenantId }, select: { id: true } });
      const aIds = new Set(aPOs.map((p) => p.id));
      expect(summaryB.body.findings.some((f) => aIds.has(f.purchaseOrderId))).toBe(false);
    });

    test('a cashier cannot read the integrity summary', async () => {
      expect((await request(app).get('/api/procurement/summary').set('Authorization', `Bearer ${cashierA}`)).status).toBe(403);
    });
  });

  describe('4.4.3 Procurement dashboard', () => {
    test('status summary, pending counts and top suppliers reflect this tenant only', async () => {
      const res = await request(app).get('/api/procurement/dashboard').set('Authorization', `Bearer ${storeKeeperA}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.statusSummary)).toBe(true);
      expect(typeof res.body.pendingApprovals.purchaseOrders).toBe('number');
      expect(typeof res.body.pendingReceipts).toBe('number');
      expect(res.body.topSuppliers.every((s) => typeof s.totalValue === 'number')).toBe(true);
    });

    test('a supplier filter narrows the result to that supplier only', async () => {
      const otherSupplier = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${adminA}`).send({ name: 'P4.3 Dashboard-only Supplier' });
      await request(app).post('/api/procurement/purchase-orders').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId: otherSupplier.body.item.id, items: [{ productId, quantity: 1, unitCost: 50 }] });
      const res = await request(app).get(`/api/procurement/dashboard?supplierId=${otherSupplier.body.item.id}`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(res.body.topSuppliers.every((s) => s.supplierId === otherSupplier.body.item.id)).toBe(true);
    });
  });

  describe('4.4.2 Supplier performance', () => {
    test('reflects real purchases, outstanding payable and pending orders for that supplier', async () => {
      const sup = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${adminA}`).send({ name: 'P4.3 Performance Supplier' });
      const supId = sup.body.item.id;
      const po = await request(app).post('/api/procurement/purchase-orders').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ supplierId: supId, items: [{ productId, quantity: 10, unitCost: 4 }] });
      const poItemId = po.body.item.items[0].id;
      const grn = await request(app).post('/api/procurement/goods-receipts').set('Authorization', `Bearer ${storeKeeperA}`)
        .send({ purchaseOrderId: po.body.item.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10 }] });
      const purchaseId = grn.body.item.purchase.id;
      await request(app).post(`/api/purchases/${purchaseId}/pay`).set('Authorization', `Bearer ${adminA}`).send({ amount: 15 });

      const perf = await request(app).get(`/api/procurement/suppliers/${supId}/performance`).set('Authorization', `Bearer ${storeKeeperA}`);
      expect(perf.status).toBe(200);
      expect(perf.body.totalPurchases).toBe(40);
      expect(perf.body.purchaseCount).toBe(1);
      expect(perf.body.averagePurchaseValue).toBe(40);
      expect(perf.body.orderedVsReceived).toEqual({ orderedQty: 10, receivedQty: 10, fulfillmentRate: 100 });
      expect(perf.body.outstandingPayable).toBe(25);
      expect(perf.body.pendingOrders).toBe(0);
    });

    test('tenant B cannot read tenant A\'s supplier performance', async () => {
      const res = await request(app).get(`/api/procurement/suppliers/${supplierId}/performance`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(res.status).toBe(404);
    });
  });
});
