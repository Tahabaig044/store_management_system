// Phase 1.11 - Payments & Receipts tests.
//
// Same DB requirements as previous phase test files: point DATABASE_URL at a
// real, throwaway local Postgres database with all migrations applied
// (including 20260921040000_phase1_11_payments_receipts) and the permission
// catalog seeded (including the new PAYMENT:CREATE/REVERSE actions). NEVER
// point this at a database holding real tenant data.
//
// Base Payment creation as a side effect of Sale/Purchase/Expense creation
// pre-dates this phase and is not duplicated here (covered by
// salesManagement.test.js/accounting.test.js). This file covers what's
// genuinely new in Phase 1.11: Sale's new :id/pay endpoint, idempotency on
// both :id/pay endpoints, the standalone POST /payments endpoint (explicit
// and auto allocation, overpayment rejection), receipt numbering and its
// concurrency safety, payment reversal and double-reversal protection, and
// tenant/branch isolation - each verified with real concurrent HTTP requests
// where relevant, mirroring the methodology established in Phase 1.8/1.9/1.10.
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

describe('Phase 1.11 - Payments & Receipts', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase111 Tenant A');
    tenantB = await registerTenant('Phase111 Tenant B');
  });

  async function makeCustomer(token, name) {
    const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.item.id;
  }
  async function makeSupplier(token, name) {
    const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.item.id;
  }
  async function makeProduct(token, name) {
    const res = await request(app).post('/api/products').set('Authorization', `Bearer ${token}`).send({ name, sellingPrice: 10, purchasePrice: 5, openingStock: 1000 });
    return res.body.item.id;
  }
  async function makePartialSale(token, customerId, productId, total, amountPaid) {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, items: [{ productId, quantity: total / 10, unitPrice: 10 }], paymentMethod: 'cash', amountPaid });
    return res.body.item;
  }
  async function makePartialPurchase(token, supplierId, productId, total, amountPaid) {
    const res = await request(app)
      .post('/api/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({ supplierId, items: [{ productId, quantity: total / 5, unitCost: 5 }], amountPaid });
    return res.body.item;
  }

  describe('Sale :id/pay (new in Phase 1.11 - a genuine, previously-missing gap)', () => {
    it('records a later payment against a PARTIAL sale and updates amountPaid/paymentStatus', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Pay Later Customer');
      const productId = await makeProduct(tenantA.token, 'Pay Later Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 40);
      expect(sale.paymentStatus).toBe('PARTIAL');

      const paid = await request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 60 });
      expect(paid.status).toBe(200);
      expect(Number(paid.body.item.amountPaid)).toBe(100);
      expect(paid.body.item.paymentStatus).toBe('PAID');
    });

    it('rejects a payment that would exceed the sale total', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Overpay Customer');
      const productId = await makeProduct(tenantA.token, 'Overpay Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 40);

      const res = await request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 70 });
      expect(res.status).toBe(422);
    });

    it('rejects a payment against a REVERSED sale', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Reversed Sale Customer');
      const productId = await makeProduct(tenantA.token, 'Reversed Sale Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 40);
      await request(app).post(`/api/sales/${sale.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);

      const res = await request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 10 });
      expect(res.status).toBe(409);
    });

    it('a retried :id/pay with the same idempotencyKey is deduplicated, not double-applied', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Idempotent Pay Customer');
      const productId = await makeProduct(tenantA.token, 'Idempotent Pay Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 40);
      const idempotencyKey = `sale-pay-${Date.now()}`;

      const first = await request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 30, idempotencyKey });
      expect(first.status).toBe(200);
      const retry = await request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 30, idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const finalSale = await prisma.sale.findUnique({ where: { id: sale.id } });
      expect(Number(finalSale.amountPaid)).toBe(70); // 40 + 30, not 40 + 30 + 30
    });

    it('a CASHIER (SALES_STAFF) can pay a sale; a STORE_KEEPER cannot', async () => {
      const customerId = await makeCustomer(tenantA.token, 'RBAC Pay Customer');
      const productId = await makeProduct(tenantA.token, 'RBAC Pay Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 40);

      const cashierEmail = uniqueEmail('cashier');
      await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Test Cashier', email: cashierEmail, password: 'TestPass123', role: 'CASHIER' });
      const cashierToken = (await request(app).post('/api/auth/login').send({ email: cashierEmail, password: 'TestPass123' })).body.token;

      const storeKeeperEmail = uniqueEmail('storekeeper');
      await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Test StoreKeeper', email: storeKeeperEmail, password: 'TestPass123', role: 'STORE_KEEPER' });
      const storeKeeperToken = (await request(app).post('/api/auth/login').send({ email: storeKeeperEmail, password: 'TestPass123' })).body.token;

      const blocked = await request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${storeKeeperToken}`).send({ amount: 10 });
      expect(blocked.status).toBe(403);

      const allowed = await request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${cashierToken}`).send({ amount: 10 });
      expect(allowed.status).toBe(200);
    });
  });

  describe('Concurrency: Sale/Purchase :id/pay (Case: concurrent customer/supplier payments)', () => {
    it('two concurrent payments on the same sale never together exceed its total', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Concurrent Sale Pay Customer');
      const productId = await makeProduct(tenantA.token, 'Concurrent Sale Pay Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);

      const [payA, payB] = await Promise.all([
        request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 70 }),
        request(app).post(`/api/sales/${sale.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 60 }),
      ]);
      const statuses = [payA.status, payB.status].sort();
      // 70+60=130 > 100 total, so exactly one payment must be rejected.
      expect(statuses).toEqual([200, 422]);

      const finalSale = await prisma.sale.findUnique({ where: { id: sale.id } });
      expect(Number(finalSale.amountPaid)).toBeLessThanOrEqual(100);
      expect([70, 60]).toContain(Number(finalSale.amountPaid));
    });

    it('two concurrent payments on the same purchase that together fit both succeed and sum correctly', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Concurrent Purchase Pay Supplier');
      const productId = await makeProduct(tenantA.token, 'Concurrent Purchase Pay Product');
      const purchase = await makePartialPurchase(tenantA.token, supplierId, productId, 100, 0);

      const [payA, payB] = await Promise.all([
        request(app).post(`/api/purchases/${purchase.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 40 }),
        request(app).post(`/api/purchases/${purchase.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 60 }),
      ]);
      expect(payA.status).toBe(200);
      expect(payB.status).toBe(200);

      const finalPurchase = await prisma.purchase.findUnique({ where: { id: purchase.id } });
      expect(Number(finalPurchase.amountPaid)).toBe(100);
      expect(finalPurchase.paymentStatus).toBe('PAID');
    });

    it('a retried Purchase :id/pay with the same idempotencyKey is deduplicated', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Idempotent Purchase Pay Supplier');
      const productId = await makeProduct(tenantA.token, 'Idempotent Purchase Pay Product');
      const purchase = await makePartialPurchase(tenantA.token, supplierId, productId, 100, 0);
      const idempotencyKey = `purchase-pay-${Date.now()}`;

      const first = await request(app).post(`/api/purchases/${purchase.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 25, idempotencyKey });
      expect(first.status).toBe(200);
      const retry = await request(app).post(`/api/purchases/${purchase.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 25, idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const finalPurchase = await prisma.purchase.findUnique({ where: { id: purchase.id } });
      expect(Number(finalPurchase.amountPaid)).toBe(25);
    });
  });

  describe('Standalone POST /payments - explicit allocation (new in Phase 1.11)', () => {
    it('a customer payment split explicitly across two open sales pays both down correctly and issues one receipt', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Split Allocation Customer');
      const productId = await makeProduct(tenantA.token, 'Split Allocation Product');
      const saleA = await makePartialSale(tenantA.token, customerId, productId, 100, 0);
      const saleB = await makePartialSale(tenantA.token, customerId, productId, 50, 0);

      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          direction: 'IN',
          customerId,
          amount: 120,
          method: 'cash',
          allocations: [{ saleId: saleA.id, amount: 100 }, { saleId: saleB.id, amount: 20 }],
        });
      expect(res.status).toBe(201);
      expect(res.body.item.receiptNumber).toMatch(/^RCT-/);
      expect(res.body.item.allocations).toHaveLength(2);

      const finalSaleA = await prisma.sale.findUnique({ where: { id: saleA.id } });
      const finalSaleB = await prisma.sale.findUnique({ where: { id: saleB.id } });
      expect(Number(finalSaleA.amountPaid)).toBe(100);
      expect(finalSaleA.paymentStatus).toBe('PAID');
      expect(Number(finalSaleB.amountPaid)).toBe(20);
      expect(finalSaleB.paymentStatus).toBe('PARTIAL');
    });

    it('rejects an allocation whose amounts do not sum to the total payment amount', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Mismatch Sum Customer');
      const productId = await makeProduct(tenantA.token, 'Mismatch Sum Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);

      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 50 }] });
      expect(res.status).toBe(422);
    });

    it('rejects allocating to a sale that belongs to a different customer', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Correct Owner Customer');
      const otherCustomerId = await makeCustomer(tenantA.token, 'Wrong Owner Customer');
      const productId = await makeProduct(tenantA.token, 'Wrong Owner Product');
      const sale = await makePartialSale(tenantA.token, otherCustomerId, productId, 100, 0);

      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });
      expect(res.status).toBe(422);
    });

    it('a supplier payment split explicitly across two open purchases pays both down correctly', async () => {
      const supplierId = await makeSupplier(tenantA.token, 'Split Supplier');
      const productId = await makeProduct(tenantA.token, 'Split Supplier Product');
      const purchaseA = await makePartialPurchase(tenantA.token, supplierId, productId, 100, 0);
      const purchaseB = await makePartialPurchase(tenantA.token, supplierId, productId, 50, 0);

      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          direction: 'OUT',
          supplierId,
          amount: 150,
          allocations: [{ purchaseId: purchaseA.id, amount: 100 }, { purchaseId: purchaseB.id, amount: 50 }],
        });
      expect(res.status).toBe(201);

      const finalA = await prisma.purchase.findUnique({ where: { id: purchaseA.id } });
      const finalB = await prisma.purchase.findUnique({ where: { id: purchaseB.id } });
      expect(finalA.paymentStatus).toBe('PAID');
      expect(finalB.paymentStatus).toBe('PAID');
    });
  });

  describe('Standalone POST /payments - autoAllocate (new in Phase 1.11)', () => {
    it('applies the payment to the oldest open sale first, then the next, until exhausted', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Auto Allocate Customer');
      const productId = await makeProduct(tenantA.token, 'Auto Allocate Product');
      const saleOld = await makePartialSale(tenantA.token, customerId, productId, 60, 0);
      await new Promise((r) => setTimeout(r, 10));
      const saleNew = await makePartialSale(tenantA.token, customerId, productId, 80, 0);

      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, autoAllocate: true });
      expect(res.status).toBe(201);

      const finalOld = await prisma.sale.findUnique({ where: { id: saleOld.id } });
      const finalNew = await prisma.sale.findUnique({ where: { id: saleNew.id } });
      expect(Number(finalOld.amountPaid)).toBe(60); // fully paid first (oldest)
      expect(Number(finalNew.amountPaid)).toBe(40); // remainder applied here
    });

    it('overpayment handling: a payment exceeding total outstanding across all open invoices is rejected, not silently converted to credit', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Overpay Auto Customer');
      const productId = await makeProduct(tenantA.token, 'Overpay Auto Product');
      await makePartialSale(tenantA.token, customerId, productId, 50, 0);

      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 200, autoAllocate: true });
      expect(res.status).toBe(422);

      // No partial/phantom effect - the sale is untouched.
      const sales = await prisma.sale.findMany({ where: { customerId } });
      expect(Number(sales[0].amountPaid)).toBe(0);
    });

    it('rejects autoAllocate when there are no outstanding invoices at all', async () => {
      const customerId = await makeCustomer(tenantA.token, 'No Outstanding Customer');
      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 50, autoAllocate: true });
      expect(res.status).toBe(422);
    });
  });

  describe('Payment reversal and double-reversal protection (new in Phase 1.11)', () => {
    it('reversing a standalone payment restores each allocated sale\'s amountPaid/paymentStatus', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Reverse Payment Customer');
      const productId = await makeProduct(tenantA.token, 'Reverse Payment Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);

      const payment = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });

      const reversed = await request(app).post(`/api/payments/${payment.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(reversed.status).toBe(200);
      expect(reversed.body.item.status).toBe('REVERSED');

      const finalSale = await prisma.sale.findUnique({ where: { id: sale.id } });
      expect(Number(finalSale.amountPaid)).toBe(0);
      expect(finalSale.paymentStatus).toBe('UNPAID');
    });

    it('a concurrent double-reversal of the SAME payment only restores the allocation once', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Double Reverse Customer');
      const productId = await makeProduct(tenantA.token, 'Double Reverse Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);
      const payment = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 40, allocations: [{ saleId: sale.id, amount: 40 }] });

      const [reverseA, reverseB] = await Promise.all([
        request(app).post(`/api/payments/${payment.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/payments/${payment.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [reverseA.status, reverseB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const finalSale = await prisma.sale.findUnique({ where: { id: sale.id } });
      // Started at 0, paid 40 (-> 40), reversed exactly once (-> 0) - a
      // double-restore bug would show -40 instead.
      expect(Number(finalSale.amountPaid)).toBe(0);
    });

    it('an inline (Sale/Purchase-creation-time) payment cannot be reversed via POST /payments/:id/reverse', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Inline Payment Customer');
      const productId = await makeProduct(tenantA.token, 'Inline Payment Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 100);
      const inlinePayment = await prisma.payment.findFirst({ where: { saleId: sale.id } });

      const res = await request(app).post(`/api/payments/${inlinePayment.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(422);
    });

    it('reversal is restricted to MANAGEMENT roles', async () => {
      const customerId = await makeCustomer(tenantA.token, 'RBAC Reverse Customer');
      const productId = await makeProduct(tenantA.token, 'RBAC Reverse Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);
      const payment = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });

      const cashierEmail = uniqueEmail('cashier2');
      await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Test Cashier', email: cashierEmail, password: 'TestPass123', role: 'CASHIER' });
      const cashierToken = (await request(app).post('/api/auth/login').send({ email: cashierEmail, password: 'TestPass123' })).body.token;

      const res = await request(app).post(`/api/payments/${payment.body.item.id}/reverse`).set('Authorization', `Bearer ${cashierToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Receipt numbering under concurrency', () => {
    it('creating many standalone payments concurrently for the same tenant never produces a 500, and no two share a receipt number', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Receipt Numbering Customer');
      const productId = await makeProduct(tenantA.token, 'Receipt Numbering Product');
      const sales = [];
      for (let i = 0; i < 8; i++) {
        sales.push(await makePartialSale(tenantA.token, customerId, productId, 50, 0));
      }

      const results = await Promise.all(
        sales.map((sale) =>
          request(app)
            .post('/api/payments')
            .set('Authorization', `Bearer ${tenantA.token}`)
            .send({ direction: 'IN', customerId, amount: 50, allocations: [{ saleId: sale.id, amount: 50 }] })
        )
      );

      for (const res of results) {
        expect(res.status).not.toBe(500);
      }
      const succeeded = results.filter((r) => r.status === 201);
      const receiptNumbers = succeeded.map((r) => r.body.item.receiptNumber);
      expect(new Set(receiptNumbers).size).toBe(receiptNumbers.length); // no duplicates among successes
    });
  });

  describe('RBAC: PAYMENT:CREATE', () => {
    it('a RECEPTIONIST (CONTACTS_STAFF) can create a standalone payment; a DOCTOR cannot', async () => {
      const customerId = await makeCustomer(tenantA.token, 'RBAC Create Customer');
      const productId = await makeProduct(tenantA.token, 'RBAC Create Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);

      const receptionistEmail = uniqueEmail('receptionist');
      await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Test Receptionist', email: receptionistEmail, password: 'TestPass123', role: 'RECEPTIONIST' });
      const receptionistToken = (await request(app).post('/api/auth/login').send({ email: receptionistEmail, password: 'TestPass123' })).body.token;

      const allowed = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${receptionistToken}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });
      expect(allowed.status).toBe(201);

      const doctorEmail = uniqueEmail('doctor');
      await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Test Doctor', email: doctorEmail, password: 'TestPass123', role: 'DOCTOR' });
      const doctorToken = (await request(app).post('/api/auth/login').send({ email: doctorEmail, password: 'TestPass123' })).body.token;

      const blocked = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ direction: 'IN', customerId, amount: 10, autoAllocate: true });
      expect(blocked.status).toBe(403);
    });
  });

  describe('Search/filter/pagination', () => {
    it('filters /api/payments by customerId and direction', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Filter Payment Customer');
      const productId = await makeProduct(tenantA.token, 'Filter Payment Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);
      await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });

      const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${tenantA.token}`).query({ customerId, direction: 'IN' });
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((p) => p.customerId === customerId && p.direction === 'IN')).toBe(true);
    });
  });

  describe('Tenant/branch isolation (mandatory)', () => {
    it('Tenant B cannot view or reverse Tenant A\'s payment', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Isolation Payment Customer');
      const productId = await makeProduct(tenantA.token, 'Isolation Payment Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);
      const payment = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });

      const get = await request(app).get(`/api/payments/${payment.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);

      const reverse = await request(app).post(`/api/payments/${payment.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(reverse.status).toBe(404);
    });

    it('a customer payment cannot be allocated to another tenant\'s sale', async () => {
      const customerB = await makeCustomer(tenantB.token, 'Cross Tenant Customer B');
      const productB = await makeProduct(tenantB.token, 'Cross Tenant Product B');
      const saleB = await makePartialSale(tenantB.token, customerB, productB, 100, 0);
      const customerA = await makeCustomer(tenantA.token, 'Cross Tenant Customer A');

      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId: customerA, amount: 100, allocations: [{ saleId: saleB.id, amount: 100 }] });
      expect(res.status).toBe(404);
    });
  });

  describe('Sale/Purchase integration and Optical/Medical regression', () => {
    it('creating a standalone payment never accepts or requires any Optical/Medical-specific field', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Neutral Payment Customer');
      const productId = await makeProduct(tenantA.token, 'Neutral Payment Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);

      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }], prescriptionId: 'not-a-real-field' });
      expect(res.status).toBe(201);
      expect(res.body.item.prescriptionId).toBeUndefined();
    });

    it('a fully-paid-via-standalone-payment sale is reflected in the customer history balanceDue', async () => {
      const customerId = await makeCustomer(tenantA.token, 'History Balance Customer');
      const productId = await makeProduct(tenantA.token, 'History Balance Product');
      const sale = await makePartialSale(tenantA.token, customerId, productId, 100, 0);
      await request(app)
        .post('/api/payments')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });

      const history = await request(app).get(`/api/customers/${customerId}/history`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(history.body.balanceDue).toBe(0);
    });
  });
});
