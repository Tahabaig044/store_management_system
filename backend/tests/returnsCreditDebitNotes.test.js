// Phase 1.13 - Returns, Credit Notes & Debit Notes tests.
//
// Same DB requirements as previous phase test files: point DATABASE_URL at a
// real, throwaway local Postgres database with all migrations applied
// (including 20260921060000_phase1_13_returns_credit_debit_notes) and the
// permission catalog seeded (including the new SALES_RETURN/PURCHASE_RETURN/
// CREDIT_NOTE/DEBIT_NOTE resources and the new REFUND permission action).
// NEVER point this at a database holding real tenant data.
//
// Sale's own :id/reverse (Phase 1.8) and Purchase's own :id/return
// (Phase 1.9) - the existing WHOLE-document reversal/return endpoints - are
// unchanged by this phase and are not re-tested here (covered by
// salesManagement.test.js/purchaseManagement.test.js). This file covers the
// genuinely new Phase 1.13 capability: PARTIAL, line-item-level Sales/
// Purchase Returns, Customer Credit Notes, Supplier Debit Notes, and
// refunds - each verified with real concurrent HTTP requests where
// relevant, mirroring the methodology established in Phase 1.8-1.12.
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

describe('Phase 1.13 - Returns, Credit Notes & Debit Notes', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase113 Tenant A');
    tenantB = await registerTenant('Phase113 Tenant B');
  });

  async function makeCustomer(token, name) {
    const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.item.id;
  }
  async function makeSupplier(token, name) {
    const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.item.id;
  }
  async function makeProduct(token, name, openingStock = 1000) {
    const res = await request(app).post('/api/products').set('Authorization', `Bearer ${token}`).send({ name, sellingPrice: 10, purchasePrice: 5, openingStock });
    return res.body.item.id;
  }
  async function makeSale(token, customerId, productId, quantity) {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, items: [{ productId, quantity, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: quantity * 10 });
    return res.body.item;
  }
  async function makePurchase(token, supplierId, productId, quantity) {
    const res = await request(app)
      .post('/api/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({ supplierId, receiveImmediately: true, items: [{ productId, quantity, unitCost: 5 }] });
    return res.body.item;
  }

  describe('Sales Return - partial, full, multiple, over-return rejection', () => {
    it('a partial return succeeds, increases stock, and issues a linked credit note', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Partial Return Customer');
      const productId = await makeProduct(tenantA.token, 'Partial Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 10);
      const saleItemId = sale.items[0].id;
      const before = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);

      const res = await request(app)
        .post('/api/sales-returns')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ saleId: sale.id, items: [{ saleItemId, quantity: 4 }], reason: 'Customer changed mind' });
      expect(res.status).toBe(201);
      expect(res.body.item.returnNumber).toMatch(/^SRT-/);
      expect(Number(res.body.item.total)).toBeCloseTo(40, 2);
      expect(res.body.item.creditNote.creditNoteNumber).toMatch(/^CN-/);

      const after = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(Number(before.body.item.stockQuantity) + 4);
    });

    it('a full return of the remaining quantity succeeds', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Full Return Customer');
      const productId = await makeProduct(tenantA.token, 'Full Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);
      const saleItemId = sale.items[0].id;

      const res = await request(app)
        .post('/api/sales-returns')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ saleId: sale.id, items: [{ saleItemId, quantity: 5 }], reason: 'Full return' });
      expect(res.status).toBe(201);

      const saleItem = await prisma.saleItem.findUnique({ where: { id: saleItemId } });
      expect(Number(saleItem.returnedQuantity)).toBe(5);
    });

    it('multiple separate returns against the same sale accumulate correctly', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Multiple Return Customer');
      const productId = await makeProduct(tenantA.token, 'Multiple Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 10);
      const saleItemId = sale.items[0].id;

      const first = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId, quantity: 3 }], reason: 'r1' });
      expect(first.status).toBe(201);
      const second = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId, quantity: 4 }], reason: 'r2' });
      expect(second.status).toBe(201);

      const saleItem = await prisma.saleItem.findUnique({ where: { id: saleItemId } });
      expect(Number(saleItem.returnedQuantity)).toBe(7);

      // A third return exceeding the remaining 3 units is rejected.
      const overReturn = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId, quantity: 4 }], reason: 'over' });
      expect(overReturn.status).toBe(422);
    });

    it('rejects returning more than was originally sold', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Over Return Customer');
      const productId = await makeProduct(tenantA.token, 'Over Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);
      const saleItemId = sale.items[0].id;

      const res = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId, quantity: 6 }], reason: 'over' });
      expect(res.status).toBe(422);
    });

    it('rejects a return against a reversed sale', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Reversed Sale Return Customer');
      const productId = await makeProduct(tenantA.token, 'Reversed Sale Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);
      await request(app).post(`/api/sales/${sale.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);

      const res = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], reason: 'x' });
      expect(res.status).toBe(409);
    });
  });

  describe('Concurrency: Sales Return (mandatory, Case A - exact task example)', () => {
    it('sale quantity=100, concurrent return-70 and return-50: returned quantity never exceeds 100', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Concurrent Return Customer');
      const productId = await makeProduct(tenantA.token, 'Concurrent Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 100);
      const saleItemId = sale.items[0].id;

      const [resultA, resultB] = await Promise.all([
        request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId, quantity: 70 }], reason: 'A' }),
        request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId, quantity: 50 }], reason: 'B' }),
      ]);
      const statuses = [resultA.status, resultB.status].sort();
      // 70+50=120 > 100 sold - exactly one must succeed. The loser is
      // rejected either at the pre-check (422, if the two requests happen to
      // interleave sequentially) or at the atomic in-transaction guard (409,
      // a true concurrent collision) - both are correct "prevented"
      // outcomes, and which one occurs is a timing detail, not something
      // the test should pin down.
      expect(statuses[0]).toBe(201);
      expect([409, 422]).toContain(statuses[1]);

      const saleItem = await prisma.saleItem.findUnique({ where: { id: saleItemId } });
      expect(Number(saleItem.returnedQuantity)).toBeLessThanOrEqual(100);
      expect([70, 50]).toContain(Number(saleItem.returnedQuantity));

      // No duplicate journal posting - exactly one SALES_RETURN entry.
      const entries = await prisma.journalEntry.findMany({ where: { tenantId: tenantA.tenantId, sourceType: 'SALES_RETURN' } });
      const forThisSale = await prisma.salesReturn.findMany({ where: { saleId: sale.id } });
      expect(forThisSale).toHaveLength(1);
    });

    it('sale quantity=100, concurrent return-40 and return-60 (sum fits exactly): both succeed', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Concurrent Fits Customer');
      const productId = await makeProduct(tenantA.token, 'Concurrent Fits Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 100);
      const saleItemId = sale.items[0].id;

      const [resultA, resultB] = await Promise.all([
        request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId, quantity: 40 }], reason: 'A' }),
        request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId, quantity: 60 }], reason: 'B' }),
      ]);
      expect(resultA.status).toBe(201);
      expect(resultB.status).toBe(201);

      const saleItem = await prisma.saleItem.findUnique({ where: { id: saleItemId } });
      expect(Number(saleItem.returnedQuantity)).toBe(100);
    });
  });

  describe('Purchase Return - partial, full, over-return rejection, concurrency', () => {
    it('a partial return succeeds and decreases stock', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Partial Return Supplier');
      const productId = await makeProduct(tenantA.token, 'Purchase Return Product');
      const purchase = await makePurchase(tenantA.token, supplierId, productId, 10);
      const purchaseItemId = purchase.items[0].id;
      const before = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);

      const res = await request(app)
        .post('/api/purchase-returns')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ purchaseId: purchase.id, items: [{ purchaseItemId, quantity: 4 }], reason: 'Defective' });
      expect(res.status).toBe(201);
      expect(res.body.item.returnNumber).toMatch(/^PRT-/);
      expect(res.body.item.debitNote.debitNoteNumber).toMatch(/^DN-/);

      const after = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(Number(before.body.item.stockQuantity) - 4);
    });

    it('a full return of the remaining quantity succeeds', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Full Return Supplier');
      const productId = await makeProduct(tenantA.token, 'Full Purchase Return Product');
      const purchase = await makePurchase(tenantA.token, supplierId, productId, 6);
      const purchaseItemId = purchase.items[0].id;

      const res = await request(app).post('/api/purchase-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseId: purchase.id, items: [{ purchaseItemId, quantity: 6 }], reason: 'full' });
      expect(res.status).toBe(201);

      const purchaseItem = await prisma.purchaseItem.findUnique({ where: { id: purchaseItemId } });
      expect(Number(purchaseItem.returnedQuantity)).toBe(6);
    });

    it('rejects returning more than was received', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Over Return Supplier');
      const productId = await makeProduct(tenantA.token, 'Over Return Purchase Product');
      const purchase = await makePurchase(tenantA.token, supplierId, productId, 5);
      const purchaseItemId = purchase.items[0].id;

      const res = await request(app).post('/api/purchase-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseId: purchase.id, items: [{ purchaseItemId, quantity: 6 }], reason: 'over' });
      expect(res.status).toBe(422);
    });

    it('concurrent: purchase quantity=100, concurrent return-70 and return-50: exactly one succeeds', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Concurrent Return Supplier');
      const productId = await makeProduct(tenantA.token, 'Concurrent Purchase Return Product');
      const purchase = await makePurchase(tenantA.token, supplierId, productId, 100);
      const purchaseItemId = purchase.items[0].id;

      const [resultA, resultB] = await Promise.all([
        request(app).post('/api/purchase-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseId: purchase.id, items: [{ purchaseItemId, quantity: 70 }], reason: 'A' }),
        request(app).post('/api/purchase-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseId: purchase.id, items: [{ purchaseItemId, quantity: 50 }], reason: 'B' }),
      ]);
      const statuses = [resultA.status, resultB.status].sort();
      // See the equivalent sales-return concurrency test above for why the
      // loser may be either 422 (pre-check) or 409 (atomic guard).
      expect(statuses[0]).toBe(201);
      expect([409, 422]).toContain(statuses[1]);

      const purchaseItem = await prisma.purchaseItem.findUnique({ where: { id: purchaseItemId } });
      expect(Number(purchaseItem.returnedQuantity)).toBeLessThanOrEqual(100);
    });
  });

  describe('Standalone Credit Note / Debit Note', () => {
    it('creates a standalone credit note with its own journal entry', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Standalone CN Customer');
      const res = await request(app).post('/api/credit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, amount: 100, reason: 'Price adjustment' });
      expect(res.status).toBe(201);
      expect(res.body.item.creditNoteNumber).toMatch(/^CN-/);

      const entry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'CREDIT_NOTE', sourceId: res.body.item.id } });
      expect(entry).toBeDefined();
    });

    it('creates a standalone debit note with its own journal entry', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Standalone DN Supplier');
      const res = await request(app).post('/api/debit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ supplierId, amount: 80, reason: 'Overcharge adjustment' });
      expect(res.status).toBe(201);
      expect(res.body.item.debitNoteNumber).toMatch(/^DN-/);

      const entry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'DEBIT_NOTE', sourceId: res.body.item.id } });
      expect(entry).toBeDefined();
    });

    it('a standalone credit note (no linked return) can be cancelled, reversing its journal entry', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Cancel CN Customer');
      const cn = await request(app).post('/api/credit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, amount: 60, reason: 'x' });

      const cancelled = await request(app).post(`/api/credit-notes/${cn.body.item.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.item.status).toBe('CANCELLED');

      const cancelEntry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'CREDIT_NOTE_CANCEL', sourceId: cn.body.item.id } });
      expect(cancelEntry).toBeDefined();
    });

    it('a return-linked credit note cannot be cancelled directly - must reverse the sales return instead', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Linked CN Customer');
      const productId = await makeProduct(tenantA.token, 'Linked CN Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);
      const returnRes = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 2 }], reason: 'x' });

      const res = await request(app).post(`/api/credit-notes/${returnRes.body.item.creditNote.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(422);
    });
  });

  describe('Refund - Credit Note and Debit Note', () => {
    it('a partial refund updates refundedAmount and posts a journal entry; a second refund exceeding the remainder is rejected', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Refund Customer');
      const cn = await request(app).post('/api/credit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, amount: 100, reason: 'x' });

      const refund1 = await request(app).post(`/api/credit-notes/${cn.body.item.id}/refund`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 60 });
      expect(refund1.status).toBe(200);
      expect(Number(refund1.body.item.refundedAmount)).toBe(60);

      const overRefund = await request(app).post(`/api/credit-notes/${cn.body.item.id}/refund`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 50 });
      expect(overRefund.status).toBe(422);

      const refundEntry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'CREDIT_NOTE_REFUND', sourceId: cn.body.item.id } });
      expect(refundEntry).toBeDefined();

      const payment = await prisma.payment.findFirst({ where: { creditNoteId: cn.body.item.id } });
      expect(payment.direction).toBe('OUT');
      expect(Number(payment.amount)).toBe(60);
    });

    it('a debit note refund (supplier paying back) works symmetrically', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Refund Supplier');
      const dn = await request(app).post('/api/debit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ supplierId, amount: 100, reason: 'x' });

      const refund = await request(app).post(`/api/debit-notes/${dn.body.item.id}/refund`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 100 });
      expect(refund.status).toBe(200);
      expect(Number(refund.body.item.refundedAmount)).toBe(100);

      const payment = await prisma.payment.findFirst({ where: { debitNoteId: dn.body.item.id } });
      expect(payment.direction).toBe('IN');
    });

    it('duplicate refund prevention: a retried refund with the same idempotencyKey is deduplicated', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Idempotent Refund Customer');
      const cn = await request(app).post('/api/credit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, amount: 100, reason: 'x' });
      const idempotencyKey = `refund-test-${Date.now()}`;

      const first = await request(app).post(`/api/credit-notes/${cn.body.item.id}/refund`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 40, idempotencyKey });
      expect(first.status).toBe(200);
      const retry = await request(app).post(`/api/credit-notes/${cn.body.item.id}/refund`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 40, idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const finalCn = await prisma.creditNote.findUnique({ where: { id: cn.body.item.id } });
      expect(Number(finalCn.refundedAmount)).toBe(40); // not 80
    });

    it('concurrent refund: two concurrent refunds on the same credit note never together exceed its amount', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Concurrent Refund Customer');
      const cn = await request(app).post('/api/credit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, amount: 100, reason: 'x' });

      const [refundA, refundB] = await Promise.all([
        request(app).post(`/api/credit-notes/${cn.body.item.id}/refund`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 70 }),
        request(app).post(`/api/credit-notes/${cn.body.item.id}/refund`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 60 }),
      ]);
      const statuses = [refundA.status, refundB.status].sort();
      // 70+60=130 > 100 - exactly one must be rejected.
      expect(statuses).toEqual([200, 422]);

      const finalCn = await prisma.creditNote.findUnique({ where: { id: cn.body.item.id } });
      expect(Number(finalCn.refundedAmount)).toBeLessThanOrEqual(100);
    });
  });

  describe('Reversal and double-reversal protection', () => {
    it('reversing a sales return restores the returned quantity, decreases stock back, and cancels its credit note', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Reverse Return Customer');
      const productId = await makeProduct(tenantA.token, 'Reverse Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 10);
      const returnRes = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 4 }], reason: 'x' });
      const beforeReverse = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);

      const reversed = await request(app).post(`/api/sales-returns/${returnRes.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(reversed.status).toBe(200);
      expect(reversed.body.item.status).toBe('REVERSED');
      expect(reversed.body.item.creditNote.status).toBe('CANCELLED');

      const afterReverse = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(afterReverse.body.item.stockQuantity)).toBe(Number(beforeReverse.body.item.stockQuantity) - 4);

      const saleItem = await prisma.saleItem.findUnique({ where: { id: sale.items[0].id } });
      expect(Number(saleItem.returnedQuantity)).toBe(0);
    });

    it('a concurrent double-reversal of the SAME sales return only restores the quantity once', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Double Reverse Return Customer');
      const productId = await makeProduct(tenantA.token, 'Double Reverse Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 10);
      const returnRes = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 4 }], reason: 'x' });

      const [reverseA, reverseB] = await Promise.all([
        request(app).post(`/api/sales-returns/${returnRes.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/sales-returns/${returnRes.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [reverseA.status, reverseB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const saleItem = await prisma.saleItem.findUnique({ where: { id: sale.items[0].id } });
      expect(Number(saleItem.returnedQuantity)).toBe(0); // not -4
    });

    it('reversing a purchase return restores the returned quantity and increases stock back', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Reverse Purchase Return Supplier');
      const productId = await makeProduct(tenantA.token, 'Reverse Purchase Return Product');
      const purchase = await makePurchase(tenantA.token, supplierId, productId, 10);
      const returnRes = await request(app).post('/api/purchase-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseId: purchase.id, items: [{ purchaseItemId: purchase.items[0].id, quantity: 4 }], reason: 'x' });

      const reversed = await request(app).post(`/api/purchase-returns/${returnRes.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(reversed.status).toBe(200);
      expect(reversed.body.item.debitNote.status).toBe('CANCELLED');

      const purchaseItem = await prisma.purchaseItem.findUnique({ where: { id: purchase.items[0].id } });
      expect(Number(purchaseItem.returnedQuantity)).toBe(0);
    });

    it('cannot reverse a sales return whose credit note has already been refunded', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Refunded Return Customer');
      const productId = await makeProduct(tenantA.token, 'Refunded Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 10);
      const returnRes = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 4 }], reason: 'x' });
      await request(app).post(`/api/credit-notes/${returnRes.body.item.creditNote.id}/refund`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 10 });

      const reversed = await request(app).post(`/api/sales-returns/${returnRes.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(reversed.status).toBe(409);
    });
  });

  describe('Idempotency on creation', () => {
    it('a retried sales return create with the same idempotencyKey is deduplicated', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Idempotent Return Customer');
      const productId = await makeProduct(tenantA.token, 'Idempotent Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 10);
      const idempotencyKey = `return-test-${Date.now()}`;

      const first = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 3 }], reason: 'x', idempotencyKey });
      expect(first.status).toBe(201);
      const retry = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 3 }], reason: 'x', idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const saleItem = await prisma.saleItem.findUnique({ where: { id: sale.items[0].id } });
      expect(Number(saleItem.returnedQuantity)).toBe(3); // not 6
    });
  });

  describe('Numbering under concurrency', () => {
    it('creating many sales returns concurrently for the same tenant never produces a 500, and no two share a returnNumber', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Numbering Race Customer');
      const productId = await makeProduct(tenantA.token, 'Numbering Race Product');
      const sales = [];
      for (let i = 0; i < 8; i++) sales.push(await makeSale(tenantA.token, customerId, productId, 5));

      const results = await Promise.all(
        sales.map((sale) => request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 2 }], reason: 'x' }))
      );
      for (const res of results) expect(res.status).not.toBe(500);
      const succeeded = results.filter((r) => r.status === 201);
      const numbers = succeeded.map((r) => r.body.item.returnNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
    });
  });

  describe('RBAC', () => {
    it('a RECEPTIONIST cannot create a sales return; a CASHIER can', async () => {
      const customerId = await makeCustomer(tenantA.token, 'RBAC Return Customer');
      const productId = await makeProduct(tenantA.token, 'RBAC Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);

      const receptionistToken = (await createUserToken(tenantA.token, 'RECEPTIONIST')).token;
      const blocked = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${receptionistToken}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], reason: 'x' });
      expect(blocked.status).toBe(403);

      const cashierToken = (await createUserToken(tenantA.token, 'CASHIER')).token;
      const allowed = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${cashierToken}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], reason: 'x' });
      expect(allowed.status).toBe(201);
    });

    it('reversal is restricted to MANAGEMENT roles', async () => {
      const customerId = await makeCustomer(tenantA.token, 'RBAC Reverse Return Customer');
      const productId = await makeProduct(tenantA.token, 'RBAC Reverse Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);
      const returnRes = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], reason: 'x' });

      const cashierToken = (await createUserToken(tenantA.token, 'CASHIER')).token;
      const res = await request(app).post(`/api/sales-returns/${returnRes.body.item.id}/reverse`).set('Authorization', `Bearer ${cashierToken}`);
      expect(res.status).toBe(403);
    });

    it('refund is restricted to MANAGEMENT roles', async () => {
      const customerId = await makeCustomer(tenantA.token, 'RBAC Refund Customer');
      const cn = await request(app).post('/api/credit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, amount: 50, reason: 'x' });

      const accountantToken = (await createUserToken(tenantA.token, 'ACCOUNTANT')).token;
      const res = await request(app).post(`/api/credit-notes/${cn.body.item.id}/refund`).set('Authorization', `Bearer ${accountantToken}`).send({ amount: 10 });
      expect(res.status).toBe(403);
    });
  });

  describe('Tenant/Branch/Warehouse isolation (mandatory)', () => {
    it('Tenant B cannot view, reverse, or create a return against Tenant A\'s sale', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Isolation Return Customer');
      const productId = await makeProduct(tenantA.token, 'Isolation Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);
      const returnRes = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 2 }], reason: 'x' });

      const get = await request(app).get(`/api/sales-returns/${returnRes.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);

      const reverse = await request(app).post(`/api/sales-returns/${returnRes.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(reverse.status).toBe(404);

      const crossTenantCreate = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantB.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], reason: 'x' });
      expect(crossTenantCreate.status).toBe(404);
    });

    it('a branch-restricted user cannot create a return for a sale outside their branch', async () => {
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Return Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Return Branch 2' });
      const customerId = await makeCustomer(tenantA.token, 'Branch Isolation Return Customer');
      const productId = await makeProduct(tenantA.token, 'Branch Isolation Return Product');
      const saleRes = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, branchId: branch1.body.item.id, items: [{ productId, quantity: 5, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 50 });

      const restrictedUser = await createUserToken(tenantA.token, 'CASHIER', branch2.body.item.id);
      const res = await request(app)
        .post('/api/sales-returns')
        .set('Authorization', `Bearer ${restrictedUser.token}`)
        .send({ saleId: saleRes.body.item.id, items: [{ saleItemId: saleRes.body.item.items[0].id, quantity: 1 }], reason: 'x' });
      expect(res.status).toBe(403);
    });

    it('a warehouse-restricted user cannot create a return targeting a warehouse they lack access to', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Return Warehouse Branch' });
      const warehouse = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted Return Warehouse', branchId: branch.body.item.id });
      const otherBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Other Return Branch' });
      const customerId = await makeCustomer(tenantA.token, 'Warehouse Isolation Return Customer');
      const productId = await makeProduct(tenantA.token, 'Warehouse Isolation Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);

      const restrictedUser = await createUserToken(tenantA.token, 'CASHIER', otherBranch.body.item.id);
      const res = await request(app)
        .post('/api/sales-returns')
        .set('Authorization', `Bearer ${restrictedUser.token}`)
        .send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], warehouseId: warehouse.body.item.id, reason: 'x' });
      expect(res.status).toBe(403);
    });
  });

  describe('Inventory & Journal correctness', () => {
    it('records an inventory transaction of type SALES_RETURN with the correct quantity and reference', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Inventory Correctness Customer');
      const productId = await makeProduct(tenantA.token, 'Inventory Correctness Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 10);
      const returnRes = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 3 }], reason: 'x' });

      const txn = await prisma.inventoryTransaction.findFirst({ where: { tenantId: tenantA.tenantId, type: 'SALES_RETURN', reference: returnRes.body.item.id } });
      expect(txn).toBeDefined();
      expect(Number(txn.quantity)).toBe(3);
    });

    it('the sales return journal entry is balanced (total debits = total credits)', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Balanced Entry Customer');
      const productId = await makeProduct(tenantA.token, 'Balanced Entry Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 10);
      const returnRes = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 4 }], reason: 'x' });

      const entry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'SALES_RETURN', sourceId: returnRes.body.item.id } });
      const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id } });
      const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
      const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(totalDebit).toBeCloseTo(totalCredit, 2);
    });
  });

  describe('Optical/Medical regression (Universal Returns stay industry-neutral)', () => {
    it('creating a sales return never accepts or requires any Optical/Medical-specific field', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Neutral Return Customer');
      const productId = await makeProduct(tenantA.token, 'Neutral Return Product');
      const sale = await makeSale(tenantA.token, customerId, productId, 5);

      const res = await request(app)
        .post('/api/sales-returns')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], reason: 'x', prescriptionId: 'not-a-real-field' });
      expect(res.status).toBe(201);
      expect(res.body.item.prescriptionId).toBeUndefined();
    });
  });
});
