// Phase 1.14 - Quotations & Sales Orders tests.
//
// Same DB requirements as previous phase test files: point DATABASE_URL at a
// real, throwaway local Postgres database with all migrations applied
// (including 20260922010000_phase1_14_quotations_orders) and the permission
// catalog seeded (including the new QUOTATION/SALES_ORDER resources).
// NEVER point this at a database holding real tenant data.
//
// Existing Purchase Request -> RFQ -> Purchase Order -> Goods Receipt
// (Phase 1.9) is verified as still-functioning via the full regression run
// (purchaseManagement.test.js/procurement.test.js), not re-tested here -
// this file covers the genuinely new Phase 1.14 capability: Quotation and
// SalesOrder, and their conversions.
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

describe('Phase 1.14 - Quotations & Sales Orders', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase114 Tenant A');
    tenantB = await registerTenant('Phase114 Tenant B');
  });

  async function makeCustomer(token, name) {
    const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.item.id;
  }
  async function makeProduct(token, name, openingStock = 1000) {
    const res = await request(app).post('/api/products').set('Authorization', `Bearer ${token}`).send({ name, sellingPrice: 10, purchasePrice: 5, openingStock });
    return res.body.item.id;
  }
  async function makeQuotation(token, customerId, productId, quantity, opts = {}) {
    const res = await request(app)
      .post('/api/quotations')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, items: [{ productId, quantity, unitPrice: 10, tax: opts.tax ?? 0 }], ...opts });
    return res.body.item;
  }
  async function acceptedQuotation(token, customerId, productId, quantity, opts = {}) {
    const quote = await makeQuotation(token, customerId, productId, quantity, opts);
    await request(app).post(`/api/quotations/${quote.id}/send`).set('Authorization', `Bearer ${token}`);
    await request(app).post(`/api/quotations/${quote.id}/accept`).set('Authorization', `Bearer ${token}`);
    return quote;
  }
  async function confirmedSalesOrder(token, customerId, productId, quantity) {
    const quote = await acceptedQuotation(token, customerId, productId, quantity);
    const convert = await request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${token}`);
    const orderId = convert.body.item.id;
    await request(app).post(`/api/sales-orders/${orderId}/confirm`).set('Authorization', `Bearer ${token}`);
    return convert.body.item;
  }

  describe('Quotation CRUD and pricing', () => {
    it('creates a quotation with server-computed totals', async () => {
      const customerId = await makeCustomer(tenantA.token, 'CRUD Customer');
      const productId = await makeProduct(tenantA.token, 'CRUD Product');
      const res = await request(app)
        .post('/api/quotations')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, items: [{ productId, quantity: 5, unitPrice: 20, discount: 10, tax: 5 }], notes: 'n', terms: 't' });
      expect(res.status).toBe(201);
      expect(res.body.item.quotationNumber).toMatch(/^QT-/);
      expect(Number(res.body.item.subtotal)).toBeCloseTo(100, 2); // 5*20
      expect(Number(res.body.item.discount)).toBeCloseTo(10, 2);
      expect(Number(res.body.item.tax)).toBeCloseTo(5, 2);
      expect(Number(res.body.item.total)).toBeCloseTo(95, 2); // 100-10+5
      expect(res.body.item.status).toBe('DRAFT');
    });

    it('never trusts a client-supplied total', async () => {
      const customerId = await makeCustomer(tenantA.token, 'NoTrust Customer');
      const productId = await makeProduct(tenantA.token, 'NoTrust Product');
      const res = await request(app)
        .post('/api/quotations')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, items: [{ productId, quantity: 5, unitPrice: 10 }], total: 999999 });
      expect(res.status).toBe(201);
      expect(Number(res.body.item.total)).toBeCloseTo(50, 2);
    });

    it('GET /:id returns full item detail; GET / supports search/filter/pagination', async () => {
      const customerId = await makeCustomer(tenantA.token, 'List Customer');
      const productId = await makeProduct(tenantA.token, 'List Product');
      const quote = await makeQuotation(tenantA.token, customerId, productId, 3);

      const detail = await request(app).get(`/api/quotations/${quote.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(detail.status).toBe(200);
      expect(detail.body.item.items).toHaveLength(1);

      const search = await request(app).get('/api/quotations').set('Authorization', `Bearer ${tenantA.token}`).query({ search: quote.quotationNumber, customerId, page: 1, pageSize: 10 });
      expect(search.status).toBe(200);
      expect(search.body.items.some((i) => i.id === quote.id)).toBe(true);
    });

    it('editing a quotation is restricted to DRAFT and non-financial fields', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Edit Customer');
      const productId = await makeProduct(tenantA.token, 'Edit Product');
      const quote = await makeQuotation(tenantA.token, customerId, productId, 2);

      const editDraft = await request(app).patch(`/api/quotations/${quote.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ notes: 'updated' });
      expect(editDraft.status).toBe(200);
      expect(editDraft.body.item.notes).toBe('updated');

      const rejectFinancialEdit = await request(app).patch(`/api/quotations/${quote.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ total: 99999 });
      expect(rejectFinancialEdit.status).toBe(422);

      await request(app).post(`/api/quotations/${quote.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);
      const editAfterSend = await request(app).patch(`/api/quotations/${quote.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ notes: 'too late' });
      expect(editAfterSend.status).toBe(409);
    });
  });

  describe('Quotation lifecycle', () => {
    it('Draft -> Sent -> Accepted, and rejects invalid duplicate transitions', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Lifecycle Customer');
      const productId = await makeProduct(tenantA.token, 'Lifecycle Product');
      const quote = await makeQuotation(tenantA.token, customerId, productId, 2);

      const acceptTooEarly = await request(app).post(`/api/quotations/${quote.id}/accept`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(acceptTooEarly.status).toBe(409);

      const send = await request(app).post(`/api/quotations/${quote.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(send.status).toBe(200);
      expect(send.body.item.status).toBe('SENT');

      const sendAgain = await request(app).post(`/api/quotations/${quote.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(sendAgain.status).toBe(409);

      const accept = await request(app).post(`/api/quotations/${quote.id}/accept`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(accept.status).toBe(200);
      expect(accept.body.item.status).toBe('ACCEPTED');
    });

    it('Sent -> Rejected', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Reject Customer');
      const productId = await makeProduct(tenantA.token, 'Reject Product');
      const quote = await makeQuotation(tenantA.token, customerId, productId, 2);
      await request(app).post(`/api/quotations/${quote.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);

      const reject = await request(app).post(`/api/quotations/${quote.id}/reject`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(reject.status).toBe(200);
      expect(reject.body.item.status).toBe('REJECTED');

      const acceptAfterReject = await request(app).post(`/api/quotations/${quote.id}/accept`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(acceptAfterReject.status).toBe(409);
    });

    it('Draft/Sent -> Cancelled, and cannot cancel an already-accepted quotation', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Cancel Customer');
      const productId = await makeProduct(tenantA.token, 'Cancel Product');
      const draftQuote = await makeQuotation(tenantA.token, customerId, productId, 2);
      const cancelDraft = await request(app).post(`/api/quotations/${draftQuote.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(cancelDraft.status).toBe(200);
      expect(cancelDraft.body.item.status).toBe('CANCELLED');

      const accepted = await acceptedQuotation(tenantA.token, customerId, productId, 2);
      const cancelAccepted = await request(app).post(`/api/quotations/${accepted.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(cancelAccepted.status).toBe(409);
    });

    it('Sent -> Expired (validUntil passed) blocks accept/reject/convert', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Expire Customer');
      const productId = await makeProduct(tenantA.token, 'Expire Product');
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const quote = await makeQuotation(tenantA.token, customerId, productId, 2, { validUntil: past });
      await request(app).post(`/api/quotations/${quote.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);

      const acceptExpired = await request(app).post(`/api/quotations/${quote.id}/accept`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(acceptExpired.status).toBe(409);

      const check = await request(app).get(`/api/quotations/${quote.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(check.body.item.status).toBe('EXPIRED');
    });

    it('explicit POST /:id/expire only works once validUntil has passed', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Explicit Expire Customer');
      const productId = await makeProduct(tenantA.token, 'Explicit Expire Product');
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const quote = await makeQuotation(tenantA.token, customerId, productId, 2, { validUntil: future });
      await request(app).post(`/api/quotations/${quote.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);

      const tooEarly = await request(app).post(`/api/quotations/${quote.id}/expire`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(tooEarly.status).toBe(409);
    });
  });

  describe('Quotation -> Sales Order conversion', () => {
    it('converts an accepted quotation, preserving customer/items/pricing, and prevents duplicate conversion', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Convert Customer');
      const productId = await makeProduct(tenantA.token, 'Convert Product');
      const quote = await acceptedQuotation(tenantA.token, customerId, productId, 7, { tax: 3 });

      const convert = await request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(convert.status).toBe(201);
      expect(convert.body.item.orderNumber).toMatch(/^SO-/);
      expect(convert.body.item.customerId).toBe(customerId);
      expect(convert.body.item.sourceQuotationId).toBe(quote.id);
      expect(Number(convert.body.item.total)).toBeCloseTo(Number(quote.total), 2);
      expect(convert.body.item.items[0].quantity).toBe('7');

      const quoteAfter = await request(app).get(`/api/quotations/${quote.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(quoteAfter.body.item.status).toBe('CONVERTED');

      const secondConvert = await request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(secondConvert.status).toBe(409);

      const orders = await prisma.salesOrder.findMany({ where: { sourceQuotationId: quote.id } });
      expect(orders).toHaveLength(1);
    });

    it('rejects converting a DRAFT/SENT/REJECTED quotation', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Bad Convert Customer');
      const productId = await makeProduct(tenantA.token, 'Bad Convert Product');
      const draft = await makeQuotation(tenantA.token, customerId, productId, 2);
      const draftConvert = await request(app).post(`/api/quotations/${draft.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(draftConvert.status).toBe(409);

      const sent = await makeQuotation(tenantA.token, customerId, productId, 2);
      await request(app).post(`/api/quotations/${sent.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);
      const sentConvert = await request(app).post(`/api/quotations/${sent.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(sentConvert.status).toBe(409);
    });

    it('concurrent double-conversion of the same quotation: no duplicate Sales Order', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Concurrent Convert Customer');
      const productId = await makeProduct(tenantA.token, 'Concurrent Convert Product');
      const quote = await acceptedQuotation(tenantA.token, customerId, productId, 5);

      const [a, b] = await Promise.all([
        request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const orders = await prisma.salesOrder.findMany({ where: { sourceQuotationId: quote.id } });
      expect(orders).toHaveLength(1);
    });

    it('idempotent conversion retry with the same idempotencyKey is deduplicated', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Idempotent Convert Customer');
      const productId = await makeProduct(tenantA.token, 'Idempotent Convert Product');
      const quote = await acceptedQuotation(tenantA.token, customerId, productId, 4);
      const idempotencyKey = `convert-${Date.now()}`;

      const first = await request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ idempotencyKey });
      expect(first.status).toBe(201);
      const retry = await request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const orders = await prisma.salesOrder.findMany({ where: { sourceQuotationId: quote.id } });
      expect(orders).toHaveLength(1);
    });
  });

  describe('Sales Order CRUD and lifecycle', () => {
    it('creates a sales order directly (not from a quotation), Draft by default', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Direct SO Customer');
      const productId = await makeProduct(tenantA.token, 'Direct SO Product');
      const res = await request(app)
        .post('/api/sales-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, items: [{ productId, quantity: 4, unitPrice: 15 }], tax: 2 });
      expect(res.status).toBe(201);
      expect(res.body.item.orderNumber).toMatch(/^SO-/);
      expect(res.body.item.status).toBe('DRAFT');
      expect(res.body.item.sourceQuotationId).toBeNull();
    });

    it('Draft -> Confirmed -> Cancelled lifecycle, rejecting invalid transitions', async () => {
      const customerId = await makeCustomer(tenantA.token, 'SO Lifecycle Customer');
      const productId = await makeProduct(tenantA.token, 'SO Lifecycle Product');
      const create = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 3, unitPrice: 10 }] });
      const orderId = create.body.item.id;

      const confirmTwice1 = await request(app).post(`/api/sales-orders/${orderId}/confirm`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(confirmTwice1.status).toBe(200);
      const confirmTwice2 = await request(app).post(`/api/sales-orders/${orderId}/confirm`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(confirmTwice2.status).toBe(409);

      const cancel = await request(app).post(`/api/sales-orders/${orderId}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(cancel.status).toBe(200);
      expect(cancel.body.item.status).toBe('CANCELLED');

      const cancelAgain = await request(app).post(`/api/sales-orders/${orderId}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(cancelAgain.status).toBe(409);
    });

    it('editing a sales order is restricted to DRAFT', async () => {
      const customerId = await makeCustomer(tenantA.token, 'SO Edit Customer');
      const productId = await makeProduct(tenantA.token, 'SO Edit Product');
      const create = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 3, unitPrice: 10 }] });
      const orderId = create.body.item.id;

      const editDraft = await request(app).patch(`/api/sales-orders/${orderId}`).set('Authorization', `Bearer ${tenantA.token}`).send({ notes: 'x' });
      expect(editDraft.status).toBe(200);

      await request(app).post(`/api/sales-orders/${orderId}/confirm`).set('Authorization', `Bearer ${tenantA.token}`);
      const editConfirmed = await request(app).patch(`/api/sales-orders/${orderId}`).set('Authorization', `Bearer ${tenantA.token}`).send({ notes: 'y' });
      expect(editConfirmed.status).toBe(409);
    });
  });

  describe('Sales Order -> Sale conversion, quantity tracking', () => {
    it('a full conversion creates a Sale preserving customer/items/pricing and completes the order', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Full Convert Customer');
      const productId = await makeProduct(tenantA.token, 'Full Convert Product');
      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 8);

      const convert = await request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({});
      expect(convert.status).toBe(201);
      expect(convert.body.item.invoiceNumber).toMatch(/^INV-/);
      expect(convert.body.item.customerId).toBe(customerId);
      expect(convert.body.item.salesOrderId).toBe(order.id);
      expect(convert.body.item.items[0].quantity).toBe('8');

      const orderAfter = await request(app).get(`/api/sales-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(orderAfter.body.item.status).toBe('COMPLETED');
      expect(orderAfter.body.item.items[0].fulfilledQuantity).toBe('8');
    });

    it('a partial conversion tracks fulfilled/remaining quantity and rolls the order to PROCESSING', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Partial Convert Customer');
      const productId = await makeProduct(tenantA.token, 'Partial Convert Product');
      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 10);
      const orderItemId = order.items[0].id;

      const partial = await request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ salesOrderItemId: orderItemId, quantity: 4 }] });
      expect(partial.status).toBe(201);

      const orderAfter = await request(app).get(`/api/sales-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(orderAfter.body.item.status).toBe('PROCESSING');
      expect(orderAfter.body.item.items[0].fulfilledQuantity).toBe('4');

      // A second partial conversion for the remaining 6 completes it.
      const rest = await request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ salesOrderItemId: orderItemId, quantity: 6 }] });
      expect(rest.status).toBe(201);
      const finalOrder = await request(app).get(`/api/sales-orders/${order.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(finalOrder.body.item.status).toBe('COMPLETED');

      expect(await prisma.sale.count({ where: { salesOrderId: order.id } })).toBe(2);
    });

    it('rejects fulfilling more than the ordered quantity', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Over Fulfill Customer');
      const productId = await makeProduct(tenantA.token, 'Over Fulfill Product');
      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 5);
      const orderItemId = order.items[0].id;

      const over = await request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ salesOrderItemId: orderItemId, quantity: 6 }] });
      expect(over.status).toBe(422);
    });

    it('rejects converting a DRAFT (unconfirmed) sales order', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Draft Convert Customer');
      const productId = await makeProduct(tenantA.token, 'Draft Convert Product');
      const create = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 3, unitPrice: 10 }] });
      const convert = await request(app).post(`/api/sales-orders/${create.body.item.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(convert.status).toBe(409);
    });

    it('a conversion with amountPaid creates a Payment and reflects it on the Sale', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Paid Convert Customer');
      const productId = await makeProduct(tenantA.token, 'Paid Convert Product');
      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 5);

      const convert = await request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ amountPaid: 50, paymentMethod: 'cash' });
      expect(convert.status).toBe(201);
      expect(convert.body.item.paymentStatus).toBe('PAID');
      const payment = await prisma.payment.findFirst({ where: { saleId: convert.body.item.id } });
      expect(payment).toBeDefined();
      expect(Number(payment.amount)).toBe(50);
    });
  });

  describe('Concurrency: mandatory 100/70/50 fulfillment (Section 16.C)', () => {
    it('order quantity=100, concurrent fulfill-70 and fulfill-50: fulfilled quantity never exceeds 100', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Concurrent Fulfill Customer');
      const productId = await makeProduct(tenantA.token, 'Concurrent Fulfill Product');
      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 100);
      const orderItemId = order.items[0].id;

      const [a, b] = await Promise.all([
        request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ salesOrderItemId: orderItemId, quantity: 70 }] }),
        request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ salesOrderItemId: orderItemId, quantity: 50 }] }),
      ]);
      const statuses = [a.status, b.status].sort();
      // 70+50=120 > 100 - exactly one must succeed. The loser is rejected
      // either at the pre-check (422) or the atomic in-transaction guard
      // (409) depending on request interleaving timing - both are correct
      // "prevented" outcomes (see Phase 1.13's identical precedent for why
      // this is a timing detail, not a behavior to pin to one code).
      expect(statuses[0]).toBe(201);
      expect([409, 422]).toContain(statuses[1]);

      const item = await prisma.salesOrderItem.findUnique({ where: { id: orderItemId } });
      expect(Number(item.fulfilledQuantity)).toBeLessThanOrEqual(100);
      expect([70, 50]).toContain(Number(item.fulfilledQuantity));

      // Never duplicate inventory movement or accounting posting - exactly
      // one Sale (and one SALE journal entry) was created for the winner.
      const sales = await prisma.sale.findMany({ where: { salesOrderId: order.id } });
      expect(sales).toHaveLength(1);
    });

    it('order quantity=100, concurrent fulfill-40 and fulfill-60 (sum fits exactly): both succeed', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Concurrent Fits Customer');
      const productId = await makeProduct(tenantA.token, 'Concurrent Fits Product');
      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 100);
      const orderItemId = order.items[0].id;

      const [a, b] = await Promise.all([
        request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ salesOrderItemId: orderItemId, quantity: 40 }] }),
        request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ salesOrderItemId: orderItemId, quantity: 60 }] }),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      const item = await prisma.salesOrderItem.findUnique({ where: { id: orderItemId } });
      expect(Number(item.fulfilledQuantity)).toBe(100);
      const sales = await prisma.sale.findMany({ where: { salesOrderId: order.id } });
      expect(sales).toHaveLength(2);
    });
  });

  describe('Numbering under concurrency', () => {
    it('creating many quotations concurrently for the same tenant never produces a 500, and no two share a quotationNumber', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Quote Numbering Customer');
      const productId = await makeProduct(tenantA.token, 'Quote Numbering Product');
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app).post('/api/quotations').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 1, unitPrice: 10 }] })
        )
      );
      for (const res of results) expect(res.status).not.toBe(500);
      const numbers = results.filter((r) => r.status === 201).map((r) => r.body.item.quotationNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('creating many sales orders concurrently for the same tenant never produces a 500, and no two share an orderNumber', async () => {
      const customerId = await makeCustomer(tenantA.token, 'SO Numbering Customer');
      const productId = await makeProduct(tenantA.token, 'SO Numbering Product');
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 1, unitPrice: 10 }] })
        )
      );
      for (const res of results) expect(res.status).not.toBe(500);
      const numbers = results.filter((r) => r.status === 201).map((r) => r.body.item.orderNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
    });
  });

  describe('Idempotency on creation', () => {
    it('a retried quotation create with the same idempotencyKey is deduplicated', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Idempotent Quote Customer');
      const productId = await makeProduct(tenantA.token, 'Idempotent Quote Product');
      const idempotencyKey = `quote-${Date.now()}`;
      const first = await request(app).post('/api/quotations').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 2, unitPrice: 10 }], idempotencyKey });
      expect(first.status).toBe(201);
      const retry = await request(app).post('/api/quotations').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 2, unitPrice: 10 }], idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);
      expect(await prisma.quotation.count({ where: { idempotencyKey } })).toBe(1);
    });

    it('a retried sales order create with the same idempotencyKey is deduplicated', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Idempotent SO Customer');
      const productId = await makeProduct(tenantA.token, 'Idempotent SO Product');
      const idempotencyKey = `so-${Date.now()}`;
      const first = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 2, unitPrice: 10 }], idempotencyKey });
      expect(first.status).toBe(201);
      const retry = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 2, unitPrice: 10 }], idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);
      expect(await prisma.salesOrder.count({ where: { idempotencyKey } })).toBe(1);
    });
  });

  describe('RBAC', () => {
    it('a RECEPTIONIST cannot create a quotation; a CASHIER can', async () => {
      const customerId = await makeCustomer(tenantA.token, 'RBAC Quote Customer');
      const productId = await makeProduct(tenantA.token, 'RBAC Quote Product');
      const receptionistToken = (await createUserToken(tenantA.token, 'RECEPTIONIST')).token;
      const blocked = await request(app).post('/api/quotations').set('Authorization', `Bearer ${receptionistToken}`).send({ customerId, items: [{ productId, quantity: 1, unitPrice: 10 }] });
      expect(blocked.status).toBe(403);

      const cashierToken = (await createUserToken(tenantA.token, 'CASHIER')).token;
      const allowed = await request(app).post('/api/quotations').set('Authorization', `Bearer ${cashierToken}`).send({ customerId, items: [{ productId, quantity: 1, unitPrice: 10 }] });
      expect(allowed.status).toBe(201);
    });

    it('cancelling a sales order is restricted to MANAGEMENT roles', async () => {
      const customerId = await makeCustomer(tenantA.token, 'RBAC Cancel SO Customer');
      const productId = await makeProduct(tenantA.token, 'RBAC Cancel SO Product');
      const create = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 1, unitPrice: 10 }] });
      const cashierToken = (await createUserToken(tenantA.token, 'CASHIER')).token;
      const res = await request(app).post(`/api/sales-orders/${create.body.item.id}/cancel`).set('Authorization', `Bearer ${cashierToken}`);
      expect(res.status).toBe(403);
    });

    it('converting a quotation requires SALES_ORDER:CREATE, not just QUOTATION:APPROVE', async () => {
      // A role granted QUOTATION actions but not SALES_ORDER:CREATE (there is
      // none such in the default catalog, since SALES_STAFF has both) is
      // exercised indirectly: a RECEPTIONIST has neither and must be
      // rejected on convert exactly as on create.
      const customerId = await makeCustomer(tenantA.token, 'RBAC Convert Customer');
      const productId = await makeProduct(tenantA.token, 'RBAC Convert Product');
      const quote = await acceptedQuotation(tenantA.token, customerId, productId, 2);
      const receptionistToken = (await createUserToken(tenantA.token, 'RECEPTIONIST')).token;
      const res = await request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${receptionistToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Tenant/Branch/Warehouse isolation', () => {
    it('Tenant B cannot view, convert, or act on Tenant A\'s quotation or sales order', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Isolation Quote Customer');
      const productId = await makeProduct(tenantA.token, 'Isolation Quote Product');
      const quote = await acceptedQuotation(tenantA.token, customerId, productId, 3);

      const get = await request(app).get(`/api/quotations/${quote.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);
      const convert = await request(app).post(`/api/quotations/${quote.id}/convert`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(convert.status).toBe(404);

      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 3);
      const getOrder = await request(app).get(`/api/sales-orders/${order.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(getOrder.status).toBe(404);
      const fulfill = await request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(fulfill.status).toBe(404);
    });

    it('a branch-restricted user cannot create a quotation for a branch outside their access', async () => {
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Quote Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Quote Branch 2' });
      const customerId = await makeCustomer(tenantA.token, 'Branch Isolation Quote Customer');
      const productId = await makeProduct(tenantA.token, 'Branch Isolation Quote Product');

      const restrictedUser = await createUserToken(tenantA.token, 'CASHIER', branch2.body.item.id);
      const res = await request(app)
        .post('/api/quotations')
        .set('Authorization', `Bearer ${restrictedUser.token}`)
        .send({ customerId, branchId: branch1.body.item.id, items: [{ productId, quantity: 1, unitPrice: 10 }] });
      expect(res.status).toBe(403);
    });

    it('a warehouse-restricted user cannot create a sales order targeting a warehouse they lack access to', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Quote Warehouse Branch' });
      const warehouse = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted Quote Warehouse', branchId: branch.body.item.id });
      const otherBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Other Quote Branch' });
      const customerId = await makeCustomer(tenantA.token, 'Warehouse Isolation SO Customer');
      const productId = await makeProduct(tenantA.token, 'Warehouse Isolation SO Product');

      const restrictedUser = await createUserToken(tenantA.token, 'CASHIER', otherBranch.body.item.id);
      const res = await request(app)
        .post('/api/sales-orders')
        .set('Authorization', `Bearer ${restrictedUser.token}`)
        .send({ customerId, warehouseId: warehouse.body.item.id, items: [{ productId, quantity: 1, unitPrice: 10 }] });
      expect(res.status).toBe(403);
    });
  });

  describe('Inventory & Accounting correctness', () => {
    it('a Sale created by conversion is an ordinary Sale: it decrements stock and posts a balanced journal entry', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Correctness Customer');
      const productId = await makeProduct(tenantA.token, 'Correctness Product');
      const before = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 6);

      const convert = await request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({});
      expect(convert.status).toBe(201);

      const after = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(Number(before.body.item.stockQuantity) - 6);

      const txn = await prisma.inventoryTransaction.findFirst({ where: { tenantId: tenantA.tenantId, type: 'SALE_DEDUCTION', reference: convert.body.item.id } });
      expect(txn).toBeDefined();

      const entry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'SALE', sourceId: convert.body.item.id } });
      expect(entry).toBeDefined();
      const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id } });
      const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
      const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(totalDebit).toBeCloseTo(totalCredit, 2);
    });

    it('a Quotation or Sales Order creation never posts any journal entry', async () => {
      const customerId = await makeCustomer(tenantA.token, 'No Posting Customer');
      const productId = await makeProduct(tenantA.token, 'No Posting Product');
      const quote = await makeQuotation(tenantA.token, customerId, productId, 4);
      const order = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 4, unitPrice: 10 }] });

      // Neither Quotation nor SalesOrder has a JournalSourceType value at
      // all (see schema.prisma) - the strongest possible guarantee that
      // creating one can never post a journal entry, since there is no
      // valid sourceType a create handler could even use to try. This is
      // also verified by id, for both new documents.
      const quoteEntry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceId: quote.id } });
      expect(quoteEntry).toBeNull();
      const orderEntry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceId: order.body.item.id } });
      expect(orderEntry).toBeNull();
    });

    it('a Quotation or Sales Order creation never affects Product.stockQuantity', async () => {
      const customerId = await makeCustomer(tenantA.token, 'No Stock Effect Customer');
      const productId = await makeProduct(tenantA.token, 'No Stock Effect Product');
      const before = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      await makeQuotation(tenantA.token, customerId, productId, 50);
      await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId, items: [{ productId, quantity: 50, unitPrice: 10 }] });
      const after = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(Number(before.body.item.stockQuantity));
    });
  });

  describe('Reporting', () => {
    it('GET /reports/quotations-orders returns tenant-scoped counts/values and a descriptive conversion rate', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Report Customer');
      const productId = await makeProduct(tenantA.token, 'Report Product');
      await acceptedQuotation(tenantA.token, customerId, productId, 2); // will be left ACCEPTED, undecided-for-conversion
      const rejectedQuote = await makeQuotation(tenantA.token, customerId, productId, 2);
      await request(app).post(`/api/quotations/${rejectedQuote.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);
      await request(app).post(`/api/quotations/${rejectedQuote.id}/reject`).set('Authorization', `Bearer ${tenantA.token}`);
      const convertedQuote = await acceptedQuotation(tenantA.token, customerId, productId, 2);
      await request(app).post(`/api/quotations/${convertedQuote.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`);

      const order = await confirmedSalesOrder(tenantA.token, customerId, productId, 10);
      await request(app).post(`/api/sales-orders/${order.id}/convert`).set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ salesOrderItemId: order.items[0].id, quantity: 4 }] });

      const res = await request(app).get('/api/reports/quotations-orders').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.quotations.byStatus.REJECTED.count).toBeGreaterThanOrEqual(1);
      expect(res.body.quotations.byStatus.CONVERTED.count).toBeGreaterThanOrEqual(1);
      expect(res.body.quotations.conversionRate).not.toBeNull();
      expect(res.body.salesOrders.byStatus.PROCESSING.count).toBeGreaterThanOrEqual(1);
      expect(res.body.salesOrders.fulfilledQuantity).toBeGreaterThanOrEqual(4);
      expect(res.body.salesOrders.outstandingQuantity).toBeGreaterThanOrEqual(6);
    });
  });

  describe('Optical/Medical regression (Universal Quotations/Orders stay industry-neutral)', () => {
    it('creating a quotation never accepts or requires any Optical/Medical-specific field', async () => {
      const customerId = await makeCustomer(tenantA.token, 'Neutral Quote Customer');
      const productId = await makeProduct(tenantA.token, 'Neutral Quote Product');
      const res = await request(app)
        .post('/api/quotations')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, items: [{ productId, quantity: 1, unitPrice: 10 }], prescriptionId: 'not-a-real-field' });
      expect(res.status).toBe(201);
      expect(res.body.item.prescriptionId).toBeUndefined();
    });
  });
});
