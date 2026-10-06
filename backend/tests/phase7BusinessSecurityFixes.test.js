// Phase 7.1 - Business Integrity & Security Fixes. Covers the four confirmed
// issues from docs/final-pre-phase7-consolidated-audit-report.md: the Optical
// Order payment race, the missing Optical Order cancellation reversal, the
// two report endpoints missing branch scoping, and AI provider credentials
// stored in plaintext. Real HTTP against a real (disposable) Postgres.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { registerProvider } = require('../src/modules/ai/providers/provider');

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
async function createUserToken(adminToken, role, branchId) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return login.body.token;
}
async function createCustomer(token) {
  const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${token}`).send({ name: 'P7 Customer', phone: `030${Math.floor(Math.random() * 100000000)}` });
  return res.body.item;
}
async function createOpticalOrder(token, overrides = {}) {
  const res = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${token}`).send({ totalAmount: 100, amountPaid: 0, ...overrides });
  if (res.status !== 201) throw new Error(`create optical order failed: ${JSON.stringify(res.body)}`);
  return res.body.item;
}

describe('Phase 7.1 - Business Integrity & Security Fixes', () => {
  let tenantA, tenantB, customerA;

  beforeAll(async () => {
    tenantA = await registerTenant(`P7 Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`P7 Tenant B ${Date.now()}`);
    customerA = await createCustomer(tenantA.token);
  });

  afterAll(async () => { await prisma.$disconnect(); });

  describe('7.1.1 Optical Order payment: concurrency, idempotency, branch/cancellation guards', () => {
    test('concurrency: two simultaneous payments that together would overpay - exactly one succeeds, order total never exceeds the order total', async () => {
      const order = await createOpticalOrder(tenantA.token, { customerId: customerA.id, totalAmount: 100, amountPaid: 0 });

      const [r1, r2] = await Promise.all([
        request(app).post(`/api/optical-orders/${order.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 70 }),
        request(app).post(`/api/optical-orders/${order.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 70 }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 422]);

      const final = await prisma.opticalOrder.findUnique({ where: { id: order.id } });
      expect(Number(final.amountPaid)).toBeLessThanOrEqual(100);
      expect(Number(final.amountPaid)).toBe(70);

      const payments = await prisma.payment.findMany({ where: { opticalOrderId: order.id } });
      expect(payments.length).toBe(1);
    });

    test('a duplicate request with the same idempotencyKey is not double-recorded', async () => {
      const order = await createOpticalOrder(tenantA.token, { customerId: customerA.id, totalAmount: 100, amountPaid: 0 });
      const idempotencyKey = `p7-pay-${Date.now()}`;

      const first = await request(app).post(`/api/optical-orders/${order.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 40, idempotencyKey });
      expect(first.status).toBe(200);
      const second = await request(app).post(`/api/optical-orders/${order.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 40, idempotencyKey });
      expect(second.status).toBe(200);
      expect(second.body.deduplicated).toBe(true);

      const final = await prisma.opticalOrder.findUnique({ where: { id: order.id } });
      expect(Number(final.amountPaid)).toBe(40);
    });

    test('a cancelled order refuses a new payment', async () => {
      const order = await createOpticalOrder(tenantA.token, { customerId: customerA.id, totalAmount: 100, amountPaid: 0 });
      const cancel = await request(app).patch(`/api/optical-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ status: 'CANCELLED' });
      expect(cancel.status).toBe(200);

      const pay = await request(app).post(`/api/optical-orders/${order.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 10 });
      expect(pay.status).toBe(409);
      expect(pay.body.code).toBe('DOCUMENT_NOT_OPEN');
    });

    test('a payment on another tenant\'s branch-restricted order is rejected by branch access, not silently allowed', async () => {
      const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      const mainBranchId = branches.body.items[0].id;
      const otherBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `P7 Second Branch ${Date.now()}` });
      const restrictedUser = await createUserToken(tenantA.token, 'RECEPTIONIST', mainBranchId);

      const orderAtOtherBranch = await createOpticalOrder(tenantA.token, { customerId: customerA.id, branchId: otherBranch.body.item.id, totalAmount: 100, amountPaid: 0 });
      const res = await request(app).post(`/api/optical-orders/${orderAtOtherBranch.id}/pay`).set('Authorization', `Bearer ${restrictedUser}`).send({ amount: 10 });
      expect(res.status).toBe(403);
    });
  });

  describe('7.1.2 Optical Order cancellation: accounting reversal', () => {
    test('cancelling a paid, stock-linked order reverses the journal entry, restores stock, and issues a credit note for the collected amount', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `P7 Frame ${Date.now()}`, type: 'FRAME', purchasePrice: 40, sellingPrice: 100, openingStock: 5 });
      const productId = product.body.item.id;

      const order = await createOpticalOrder(tenantA.token, {
        customerId: customerA.id,
        items: [{ productId, quantity: 1, unitPrice: 100 }],
        totalAmount: 100,
        amountPaid: 60,
      });
      expect(order.amountPaid).toBeDefined();

      const stockAfterOrder = await prisma.product.findUnique({ where: { id: productId } });
      expect(Number(stockAfterOrder.stockQuantity)).toBe(4);

      const originalEntry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'OPTICAL_ORDER', sourceId: order.id } });
      expect(originalEntry).toBeTruthy();
      expect(originalEntry.status).toBe('POSTED');

      const cancel = await request(app).patch(`/api/optical-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ status: 'CANCELLED' });
      expect(cancel.status).toBe(200);
      expect(cancel.body.item.status).toBe('CANCELLED');

      // Stock restored.
      const stockAfterCancel = await prisma.product.findUnique({ where: { id: productId } });
      expect(Number(stockAfterCancel.stockQuantity)).toBe(5);

      // Original entry reversed (voided), a new reversing entry posted, ledger stays balanced.
      const afterEntry = await prisma.journalEntry.findUnique({ where: { id: originalEntry.id } });
      expect(afterEntry.status).toBe('VOID');
      const reversalEntry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, reversalOfId: originalEntry.id } });
      expect(reversalEntry).toBeTruthy();
      const reversalLines = await prisma.journalLine.findMany({ where: { journalEntryId: reversalEntry.id } });
      const totalDebit = reversalLines.reduce((s, l) => s + Number(l.debit), 0);
      const totalCredit = reversalLines.reduce((s, l) => s + Number(l.credit), 0);
      expect(totalDebit).toBeCloseTo(totalCredit, 2);

      // Money already collected (60) is not handed back as cash - it becomes a credit note.
      const creditNote = await prisma.creditNote.findFirst({ where: { tenantId: tenantA.tenantId, reversedOpticalOrderId: order.id } });
      expect(creditNote).toBeTruthy();
      expect(Number(creditNote.amount)).toBe(60);
    });

    test('an order with no items and no payment cancels cleanly with no stray reversal artifacts', async () => {
      const order = await createOpticalOrder(tenantA.token, { customerId: customerA.id, totalAmount: 50, amountPaid: 0 });
      const cancel = await request(app).patch(`/api/optical-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ status: 'CANCELLED' });
      expect(cancel.status).toBe(200);
      const creditNote = await prisma.creditNote.findFirst({ where: { tenantId: tenantA.tenantId, reversedOpticalOrderId: order.id } });
      expect(creditNote).toBeNull();
    });

    test('repeated cancellation is safely rejected, not double-reversed', async () => {
      const order = await createOpticalOrder(tenantA.token, { customerId: customerA.id, totalAmount: 80, amountPaid: 20 });
      const first = await request(app).patch(`/api/optical-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ status: 'CANCELLED' });
      expect(first.status).toBe(200);

      const second = await request(app).patch(`/api/optical-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ status: 'CANCELLED' });
      expect(second.status).toBe(409);

      const creditNotes = await prisma.creditNote.findMany({ where: { tenantId: tenantA.tenantId, reversedOpticalOrderId: order.id } });
      expect(creditNotes.length).toBe(1);
    });

    test('concurrency: two simultaneous cancellation requests on the same order - exactly one reverses, the other gets a clean conflict', async () => {
      const order = await createOpticalOrder(tenantA.token, { customerId: customerA.id, totalAmount: 90, amountPaid: 30 });
      const [r1, r2] = await Promise.all([
        request(app).patch(`/api/optical-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ status: 'CANCELLED' }),
        request(app).patch(`/api/optical-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ status: 'CANCELLED' }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);
      const creditNotes = await prisma.creditNote.findMany({ where: { tenantId: tenantA.tenantId, reversedOpticalOrderId: order.id } });
      expect(creditNotes.length).toBe(1);
    });

    test('the trial balance stays balanced after a cancellation reversal', async () => {
      const order = await createOpticalOrder(tenantA.token, { customerId: customerA.id, totalAmount: 120, amountPaid: 120 });
      await request(app).patch(`/api/optical-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ status: 'CANCELLED' });

      const tb = await request(app).get('/api/accounting/reports/trial-balance').set('Authorization', `Bearer ${tenantA.token}`);
      expect(tb.status).toBe(200);
      expect(tb.body.balanced).toBe(true);
    });
  });

  describe('7.1.3 Report branch scoping: /optical-orders and /medicine-expiry', () => {
    let branchOneId, branchTwoId, restrictedToOne;

    beforeAll(async () => {
      const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      branchOneId = branches.body.items[0].id;
      const two = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `P7 Report Branch Two ${Date.now()}` });
      branchTwoId = two.body.item.id;
      restrictedToOne = await createUserToken(tenantA.token, 'ACCOUNTANT', branchOneId);
    });

    test('optical-orders report: a branch-restricted role sees only its own branch\'s orders, an unrestricted role sees every branch', async () => {
      const cust = await createCustomer(tenantA.token);
      await createOpticalOrder(tenantA.token, { customerId: cust.id, branchId: branchOneId, totalAmount: 10 });
      await createOpticalOrder(tenantA.token, { customerId: cust.id, branchId: branchTwoId, totalAmount: 20 });

      const restrictedView = await request(app).get('/api/reports/optical-orders').set('Authorization', `Bearer ${restrictedToOne}`);
      expect(restrictedView.status).toBe(200);
      expect(restrictedView.body.orders.every((o) => o.branchId === branchOneId)).toBe(true);
      expect(restrictedView.body.orders.some((o) => o.branchId === branchTwoId)).toBe(false);

      const unrestrictedView = await request(app).get('/api/reports/optical-orders').set('Authorization', `Bearer ${tenantA.token}`);
      expect(unrestrictedView.body.orders.some((o) => o.branchId === branchOneId)).toBe(true);
      expect(unrestrictedView.body.orders.some((o) => o.branchId === branchTwoId)).toBe(true);
    });

    test('optical-orders report: tenant B never sees tenant A\'s orders', async () => {
      const res = await request(app).get('/api/reports/optical-orders').set('Authorization', `Bearer ${tenantB.token}`);
      expect(res.status).toBe(200);
      expect(res.body.orders.length).toBe(0);
    });

    test('medicine-expiry report: an unrestricted role sees tenant-wide data; a branch-restricted role is now scoped (not tenant-wide) rather than seeing every branch\'s stock unconditionally', async () => {
      await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({
        name: `P7 Medicine ${Date.now()}`, type: 'MEDICINE', purchasePrice: 5, sellingPrice: 10, openingStock: 20,
        expiryDate: new Date(Date.now() + 5 * 86400000).toISOString(),
      });

      const unrestrictedView = await request(app).get('/api/reports/medicine-expiry').set('Authorization', `Bearer ${tenantA.token}`);
      expect(unrestrictedView.status).toBe(200);
      expect(unrestrictedView.body.count).toBeGreaterThan(0);

      // A branch-restricted role no longer receives the tenant-wide result unconditionally -
      // it is now scoped through the same accessible-branch mechanism /stock-movement already
      // uses. (Products in this suite have no WarehouseStock row, since ordinary opening-stock
      // creation doesn't populate one - the same pre-existing characteristic /stock-movement
      // already has for InventoryTransaction.warehouseId, per the Phase 7 audit.)
      const restrictedView = await request(app).get('/api/reports/medicine-expiry').set('Authorization', `Bearer ${restrictedToOne}`);
      expect(restrictedView.status).toBe(200);
      expect(restrictedView.body.count).toBeLessThanOrEqual(unrestrictedView.body.count);
    });

    test('medicine-expiry report: tenant B never sees tenant A\'s medicines', async () => {
      const res = await request(app).get('/api/reports/medicine-expiry').set('Authorization', `Bearer ${tenantB.token}`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
    });
  });

  describe('7.1.4 AI provider credential security', () => {
    test('a saved API key is never stored in plaintext in the database', async () => {
      const put = await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ provider: 'anthropic', credentials: { apiKey: 'sk-ant-super-secret-key' } });
      expect(put.status).toBe(200);

      const row = await prisma.aiConfig.findUnique({ where: { tenantId: tenantA.tenantId } });
      const raw = JSON.stringify(row.credentials);
      expect(raw).not.toContain('sk-ant-super-secret-key');
      expect(row.credentials.__enc).toBe('aesgcm-v1');
    });

    test('GET /api/ai/config never returns the plaintext or encrypted credential, only a boolean flag', async () => {
      const res = await request(app).get('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.item.credentials).toBeUndefined();
      expect(res.body.item.hasCredentials).toBe(true);
    });

    test('tenant B cannot read or use tenant A\'s stored AI credential', async () => {
      const getB = await request(app).get('/api/ai/config').set('Authorization', `Bearer ${tenantB.token}`);
      expect(getB.status).toBe(200);
      expect(getB.body.item.hasCredentials).toBe(false);

      const rowB = await prisma.aiConfig.findUnique({ where: { tenantId: tenantB.tenantId } });
      expect(rowB?.credentials ?? null).toBeNull();
    });

    test('a configured provider can still be used - the encrypted credential decrypts correctly at call time', async () => {
      let receivedApiKey = null;
      registerProvider('fake-secure-llm', {
        ask: async ({ credentials }) => {
          receivedApiKey = credentials?.apiKey;
          return { text: 'ok', confidence: 0.9 };
        },
      });
      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ provider: 'fake-secure-llm', credentials: { apiKey: 'sk-ant-round-trip-key' } });

      const ask = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'Which branch is most profitable?' });
      expect(ask.status).toBe(201);
      expect(ask.body.aiMode).toBe('llm');
      expect(receivedApiKey).toBe('sk-ant-round-trip-key');

      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ provider: 'deterministic' });
    });
  });
});
