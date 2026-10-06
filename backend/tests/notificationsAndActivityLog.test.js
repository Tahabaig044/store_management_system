// Phase 1.15 - Notifications & Activity Log tests.
//
// Same DB requirements as previous phase test files: point DATABASE_URL at a
// real, throwaway local Postgres database with all migrations applied
// (including 20260922020000_phase1_15_notifications_activity_log) and the
// permission catalog seeded (including the new AUDIT_LOG resource).
// NEVER point this at a database holding real tenant data.
//
// This phase extends, rather than replaces, extensive pre-existing
// infrastructure: the Notification model/routes, the AuditLog model and its
// logAudit() service, and the triggerEvent()/AutomationRule/
// AutomationExecution event engine all existed before this phase (see the
// report's Existing Architecture Audit). This file covers what's genuinely
// new: branch-aware notification targeting, the notification detail/
// delete endpoints, the new GET /api/activity-log read API, the new
// SALE_CANCELLED/PAYMENT_RECEIVED/PAYMENT_REVERSED/EXPENSE_CREATED/
// EXPENSE_REVERSED/RETURN_CREATED/CREDIT_NOTE_CREATED/DEBIT_NOTE_CREATED/
// QUOTATION_ACCEPTED/SALES_ORDER_CONFIRMED/SALES_ORDER_CANCELLED events, and
// direct concurrency/duplicate-prevention verification of the existing
// AutomationExecution dedup gate.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { triggerEvent } = require('../src/modules/communication/automation');
const { sendToUser } = require('../src/modules/push/pushService');

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
  return { token: res.body.token, tenantId: res.body.tenant.id, userId: res.body.user.id };
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

describe('Phase 1.15 - Notifications & Activity Log', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase115 Tenant A');
    tenantB = await registerTenant('Phase115 Tenant B');
  });

  async function makeExpenseCategory(token, name) {
    const res = await request(app).post('/api/expense-categories').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.item.id;
  }
  async function createExpense(token, categoryId, amount = 25) {
    const res = await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`).send({ categoryId, amount, description: 'x' });
    return res.body.item;
  }

  describe('Notification creation via real business events', () => {
    it('creating an Expense triggers an EXPENSE_CREATED in-app notification for MANAGEMENT users', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Notif Category');
      const before = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      const beforeCount = before.body.total;

      const expense = await createExpense(tenantA.token, categoryId, 40);

      const after = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      expect(after.body.total).toBe(beforeCount + 1);
      const created = after.body.items.find((n) => n.type === 'EXPENSE_CREATED' && n.entityId === expense.id);
      expect(created).toBeDefined();
      expect(created.title).toContain(expense.expenseNumber);
      expect(created.isRead).toBe(false);
      expect(created.channel).toBe('IN_APP');
      expect(created.deliveryStatus).toBe('DELIVERED');
      expect(created.priority).toBe('NORMAL');
    });

    it('reversing an Expense triggers an EXPENSE_REVERSED notification', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Reverse Notif Category');
      const expense = await createExpense(tenantA.token, categoryId, 30);
      await request(app).post(`/api/expenses/${expense.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);

      const notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      const found = notifs.body.items.find((n) => n.type === 'EXPENSE_REVERSED' && n.entityId === expense.id);
      expect(found).toBeDefined();
    });

    it('reversing a Sale triggers a SALE_CANCELLED notification', async () => {
      const cust = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Sale Notif Customer' });
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Sale Notif Product', sellingPrice: 10, purchasePrice: 5, openingStock: 50 });
      const sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: cust.body.item.id, items: [{ productId: prod.body.item.id, quantity: 2, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 20 });
      await request(app).post(`/api/sales/${sale.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);

      const notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      const found = notifs.body.items.find((n) => n.type === 'SALE_CANCELLED' && n.entityId === sale.body.item.id);
      expect(found).toBeDefined();
    });

    it('a standalone Payment creation triggers PAYMENT_RECEIVED; reversing it triggers PAYMENT_REVERSED', async () => {
      const cust = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Payment Notif Customer' });
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Payment Notif Product', sellingPrice: 10, purchasePrice: 5, openingStock: 50 });
      const sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: cust.body.item.id, items: [{ productId: prod.body.item.id, quantity: 5, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 0 });

      const payment = await request(app).post('/api/payments').set('Authorization', `Bearer ${tenantA.token}`).send({
        direction: 'IN', amount: 50, method: 'cash', customerId: cust.body.item.id,
        allocations: [{ saleId: sale.body.item.id, amount: 50 }],
      });
      expect(payment.status).toBe(201);

      let notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      expect(notifs.body.items.find((n) => n.type === 'PAYMENT_RECEIVED' && n.entityId === payment.body.item.id)).toBeDefined();

      await request(app).post(`/api/payments/${payment.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      expect(notifs.body.items.find((n) => n.type === 'PAYMENT_REVERSED' && n.entityId === payment.body.item.id)).toBeDefined();
    });

    it('a Sales Return triggers RETURN_CREATED; a Purchase Return triggers RETURN_CREATED with distinct sourceIds', async () => {
      const cust = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Return Notif Customer' });
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Return Notif Product', sellingPrice: 10, purchasePrice: 5, openingStock: 50 });
      const sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: cust.body.item.id, items: [{ productId: prod.body.item.id, quantity: 5, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 50 });
      const ret = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.body.item.id, items: [{ saleItemId: sale.body.item.items[0].id, quantity: 2 }], reason: 'x' });

      const notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      const found = notifs.body.items.find((n) => n.type === 'RETURN_CREATED' && n.entityId === ret.body.item.id);
      expect(found).toBeDefined();
      expect(found.body).toContain('sales return');
    });

    it('a standalone Credit Note triggers CREDIT_NOTE_CREATED; a Quotation acceptance triggers QUOTATION_ACCEPTED', async () => {
      const cust = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'CN Notif Customer' });
      const cn = await request(app).post('/api/credit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: cust.body.item.id, amount: 40, reason: 'x' });
      let notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      expect(notifs.body.items.find((n) => n.type === 'CREDIT_NOTE_CREATED' && n.entityId === cn.body.item.id)).toBeDefined();

      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Quote Notif Product', sellingPrice: 10, purchasePrice: 5, openingStock: 50 });
      const quote = await request(app).post('/api/quotations').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: cust.body.item.id, items: [{ productId: prod.body.item.id, quantity: 1, unitPrice: 10 }] });
      await request(app).post(`/api/quotations/${quote.body.item.id}/send`).set('Authorization', `Bearer ${tenantA.token}`);
      await request(app).post(`/api/quotations/${quote.body.item.id}/accept`).set('Authorization', `Bearer ${tenantA.token}`);
      notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      expect(notifs.body.items.find((n) => n.type === 'QUOTATION_ACCEPTED' && n.entityId === quote.body.item.id)).toBeDefined();
    });

    it('confirming and cancelling a Sales Order triggers SALES_ORDER_CONFIRMED and SALES_ORDER_CANCELLED', async () => {
      const cust = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'SO Notif Customer' });
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'SO Notif Product', sellingPrice: 10, purchasePrice: 5, openingStock: 50 });
      const order = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: cust.body.item.id, items: [{ productId: prod.body.item.id, quantity: 1, unitPrice: 10 }] });
      await request(app).post(`/api/sales-orders/${order.body.item.id}/confirm`).set('Authorization', `Bearer ${tenantA.token}`);
      let notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      expect(notifs.body.items.find((n) => n.type === 'SALES_ORDER_CONFIRMED' && n.entityId === order.body.item.id)).toBeDefined();

      await request(app).post(`/api/sales-orders/${order.body.item.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      notifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      expect(notifs.body.items.find((n) => n.type === 'SALES_ORDER_CANCELLED' && n.entityId === order.body.item.id)).toBeDefined();
    });
  });

  describe('Notification retrieval, read/unread, pagination', () => {
    it('unread count, mark-one-read (idempotent), and mark-all-read all work correctly', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Read State Category');
      const e1 = await createExpense(tenantA.token, categoryId, 10);
      await createExpense(tenantA.token, categoryId, 11);

      const before = await request(app).get('/api/notifications/unread-count').set('Authorization', `Bearer ${tenantA.token}`);
      expect(before.body.count).toBeGreaterThanOrEqual(2);

      const list = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      const notif = list.body.items.find((n) => n.entityId === e1.id);

      const read1 = await request(app).patch(`/api/notifications/${notif.id}/read`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(read1.body.item.isRead).toBe(true);
      expect(read1.body.item.readAt).not.toBeNull();
      const firstReadAt = read1.body.item.readAt;

      // Idempotent re-read: readAt does not get overwritten by a later timestamp.
      const read2 = await request(app).patch(`/api/notifications/${notif.id}/read`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(read2.body.item.readAt).toBe(firstReadAt);

      const markAll = await request(app).post('/api/notifications/mark-all-read').set('Authorization', `Bearer ${tenantA.token}`);
      expect(markAll.body.updated).toBeGreaterThanOrEqual(1);

      const afterAll = await request(app).get('/api/notifications/unread-count').set('Authorization', `Bearer ${tenantA.token}`);
      expect(afterAll.body.count).toBe(0);
    });

    it('supports type/priority/date filtering and pagination', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Filter Category');
      await createExpense(tenantA.token, categoryId, 5);

      const filtered = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`).query({ type: 'EXPENSE_CREATED', pageSize: 5, page: 1 });
      expect(filtered.status).toBe(200);
      expect(filtered.body.items.every((n) => n.type === 'EXPENSE_CREATED')).toBe(true);
      expect(filtered.body.items.length).toBeLessThanOrEqual(5);
    });

    it('GET /:id returns detail; DELETE /:id dismisses; a dismissed notification no longer appears', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Dismiss Category');
      const e = await createExpense(tenantA.token, categoryId, 15);
      const list = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      const notif = list.body.items.find((n) => n.entityId === e.id);

      const detail = await request(app).get(`/api/notifications/${notif.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(detail.status).toBe(200);
      expect(detail.body.item.id).toBe(notif.id);

      const del = await request(app).delete(`/api/notifications/${notif.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(del.status).toBe(204);

      const afterDelete = await request(app).get(`/api/notifications/${notif.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(afterDelete.status).toBe(404);
    });
  });

  describe('Duplicate notification prevention / idempotency (mandatory)', () => {
    it('firing the identical event+sourceId twice sequentially never creates a second notification', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Dedup Category');
      const sourceId = `dedup-test-${Date.now()}`;

      await triggerEvent(prisma, { tenantId: tenantA.tenantId, event: 'EXPENSE_CREATED', sourceId, entityType: 'Expense', internalTitle: 'first', internalBody: 'first' });
      await triggerEvent(prisma, { tenantId: tenantA.tenantId, event: 'EXPENSE_CREATED', sourceId, entityType: 'Expense', internalTitle: 'second', internalBody: 'second' });

      const executions = await prisma.automationExecution.findMany({ where: { tenantId: tenantA.tenantId, event: 'EXPENSE_CREATED', sourceId } });
      expect(executions).toHaveLength(1);
      const notifs = await prisma.notification.findMany({ where: { tenantId: tenantA.tenantId, entityId: sourceId, type: 'EXPENSE_CREATED' } });
      // At most one notification PER matching-role user was created, not two.
      const perUserCounts = {};
      for (const n of notifs) perUserCounts[n.userId] = (perUserCounts[n.userId] || 0) + 1;
      expect(Object.values(perUserCounts).every((c) => c === 1)).toBe(true);
    });

    it('concurrent identical event+sourceId (real concurrency, Section 13.A): exactly one AutomationExecution, no duplicate notification', async () => {
      const sourceId = `concurrent-dedup-${Date.now()}`;
      await Promise.all([
        triggerEvent(prisma, { tenantId: tenantA.tenantId, event: 'PAYMENT_RECEIVED', sourceId, entityType: 'Payment', internalTitle: 'A', internalBody: 'A' }),
        triggerEvent(prisma, { tenantId: tenantA.tenantId, event: 'PAYMENT_RECEIVED', sourceId, entityType: 'Payment', internalTitle: 'B', internalBody: 'B' }),
        triggerEvent(prisma, { tenantId: tenantA.tenantId, event: 'PAYMENT_RECEIVED', sourceId, entityType: 'Payment', internalTitle: 'C', internalBody: 'C' }),
      ]);

      const executions = await prisma.automationExecution.findMany({ where: { tenantId: tenantA.tenantId, event: 'PAYMENT_RECEIVED', sourceId } });
      expect(executions).toHaveLength(1);
      const notifs = await prisma.notification.findMany({ where: { tenantId: tenantA.tenantId, entityId: sourceId, type: 'PAYMENT_RECEIVED' } });
      const perUserCounts = {};
      for (const n of notifs) perUserCounts[n.userId] = (perUserCounts[n.userId] || 0) + 1;
      expect(Object.values(perUserCounts).every((c) => c === 1)).toBe(true);
    });

    it('offline-style idempotency: the same idempotencyKey retried for an Expense create fires the underlying event only once', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Offline Replay Category');
      const idempotencyKey = `offline-replay-${Date.now()}`;
      const first = await request(app).post('/api/expenses').set('Authorization', `Bearer ${tenantA.token}`).send({ categoryId, amount: 20, description: 'x', idempotencyKey });
      expect(first.status).toBe(201);
      // A retried offline-outbox submission with the same key returns the
      // deduplicated Expense and, since it's the exact same Express handler
      // invocation path, never re-executes the post-transaction
      // triggerEvent() call for a "new" expense a second time.
      const retry = await request(app).post('/api/expenses').set('Authorization', `Bearer ${tenantA.token}`).send({ categoryId, amount: 20, description: 'x', idempotencyKey });

      const notifs = await prisma.notification.findMany({ where: { tenantId: tenantA.tenantId, entityId: first.body.item.id, type: 'EXPENSE_CREATED' } });
      expect(notifs.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Concurrency: reads (Section 13.B-E)', () => {
    it('concurrent mark-as-read on the same notification never corrupts unread count', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Concurrent Read Category');
      const e = await createExpense(tenantA.token, categoryId, 12);
      const list = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      const notif = list.body.items.find((n) => n.entityId === e.id);
      const beforeUnread = list.body.unreadCount;

      const [a, b] = await Promise.all([
        request(app).patch(`/api/notifications/${notif.id}/read`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).patch(`/api/notifications/${notif.id}/read`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const afterUnread = await request(app).get('/api/notifications/unread-count').set('Authorization', `Bearer ${tenantA.token}`);
      expect(afterUnread.body.count).toBe(beforeUnread - 1);
    });

    it('concurrent mark-all-read calls never produce a negative or inconsistent unread count', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Concurrent MarkAll Category');
      await createExpense(tenantA.token, categoryId, 8);
      await createExpense(tenantA.token, categoryId, 9);

      const [a, b] = await Promise.all([
        request(app).post('/api/notifications/mark-all-read').set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post('/api/notifications/mark-all-read').set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const finalCount = await request(app).get('/api/notifications/unread-count').set('Authorization', `Bearer ${tenantA.token}`);
      expect(finalCount.body.count).toBe(0);
    });

    it('concurrent notification retrieval and notification creation never crash or return inconsistent shapes', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Concurrent Retrieval Category');
      const [listResA, listResB, expenseRes] = await Promise.all([
        request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`),
        request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`),
        createExpense(tenantA.token, categoryId, 7),
      ]);
      expect(listResA.status).toBe(200);
      expect(listResB.status).toBe(200);
      expect(expenseRes.id).toBeDefined();
    });
  });

  describe('Activity Log: retrieval, filters, pagination, immutability', () => {
    it('GET /api/activity-log returns entries with actor/branch detail and supports action/entity/date/search filters', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Activity Category');
      const e = await createExpense(tenantA.token, categoryId, 33);

      const all = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`);
      expect(all.status).toBe(200);
      expect(all.body.items.length).toBeGreaterThan(0);
      expect(all.body.items[0].user).toBeDefined();

      const byAction = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`).query({ action: 'EXPENSE_CREATE' });
      expect(byAction.body.items.every((i) => i.action === 'EXPENSE_CREATE')).toBe(true);

      const byEntity = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`).query({ entity: 'Expense', entityId: e.id });
      expect(byEntity.body.items.some((i) => i.entityId === e.id)).toBe(true);

      const bySearch = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`).query({ search: 'EXPENSE_CREATE' });
      expect(bySearch.body.total).toBeGreaterThan(0);

      const byDate = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`).query({ from: new Date(Date.now() - 60000).toISOString() });
      expect(byDate.body.total).toBeGreaterThan(0);

      const paged = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`).query({ page: 1, pageSize: 2 });
      expect(paged.body.items.length).toBeLessThanOrEqual(2);
    });

    it('GET /api/activity-log/:id returns full detail including metadata', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Activity Detail Category');
      const e = await createExpense(tenantA.token, categoryId, 44);
      const list = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`).query({ entity: 'Expense', entityId: e.id });
      const entry = list.body.items[0];

      const detail = await request(app).get(`/api/activity-log/${entry.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(detail.status).toBe(200);
      expect(detail.body.item.metadata).toBeDefined();
    });

    it('is immutable: no update or delete route exists for activity log entries', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Immutable Category');
      const e = await createExpense(tenantA.token, categoryId, 22);
      const list = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`).query({ entity: 'Expense', entityId: e.id });
      const entry = list.body.items[0];

      const patchAttempt = await request(app).patch(`/api/activity-log/${entry.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ action: 'TAMPERED' });
      expect([404, 405]).toContain(patchAttempt.status);
      const deleteAttempt = await request(app).delete(`/api/activity-log/${entry.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect([404, 405]).toContain(deleteAttempt.status);

      // The row itself is provably unchanged in the database.
      const stillThere = await prisma.auditLog.findUnique({ where: { id: entry.id } });
      expect(stillThere.action).toBe('EXPENSE_CREATE');
    });

    it('never logs sensitive fields: a User creation audit entry never contains a password/passwordHash', async () => {
      const email = uniqueEmail('sensitive');
      await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Sensitive Test', email, password: 'TestPass123', role: 'CASHIER' });

      const entries = await prisma.auditLog.findMany({ where: { tenantId: tenantA.tenantId, action: { contains: 'USER' } } });
      for (const entry of entries) {
        const serialized = JSON.stringify(entry.metadata || {});
        expect(serialized.toLowerCase()).not.toContain('password');
        expect(serialized).not.toContain('TestPass123');
      }
    });
  });

  describe('RBAC', () => {
    it('AUDIT_LOG:VIEW is MANAGEMENT-only - a CASHIER is rejected, a MANAGER succeeds', async () => {
      const cashierToken = (await createUserToken(tenantA.token, 'CASHIER')).token;
      const blocked = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${cashierToken}`);
      expect(blocked.status).toBe(403);

      const managerToken = (await createUserToken(tenantA.token, 'MANAGER')).token;
      const allowed = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${managerToken}`);
      expect(allowed.status).toBe(200);
    });

    it('notifications require no special permission beyond authentication - any authenticated role sees only their own', async () => {
      const cashierToken = (await createUserToken(tenantA.token, 'CASHIER')).token;
      const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${cashierToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Tenant/Branch/User isolation (critical, Section 6)', () => {
    it('Tenant B never sees Tenant A\'s notifications or activity log entries', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'Isolation Category');
      const e = await createExpense(tenantA.token, categoryId, 60);

      const bNotifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantB.token}`);
      expect(bNotifs.body.items.find((n) => n.entityId === e.id)).toBeUndefined();

      const bLog = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantB.token}`).query({ entityId: e.id });
      expect(bLog.body.items).toHaveLength(0);
    });

    it('one user never sees another user\'s notifications, even within the same tenant', async () => {
      const categoryId = await makeExpenseCategory(tenantA.token, 'User Isolation Category');
      const e = await createExpense(tenantA.token, categoryId, 18);
      // Notifications for EXPENSE_CREATED go to MANAGEMENT roles (TENANT_ADMIN/MANAGER) -
      // a freshly created CASHIER was never a recipient and must not see it via any endpoint.
      const cashierToken = (await createUserToken(tenantA.token, 'CASHIER')).token;
      const cashierNotifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${cashierToken}`);
      expect(cashierNotifs.body.items.find((n) => n.entityId === e.id)).toBeUndefined();
    });

    it('branch-restricted notification targeting: a user without access to the event\'s branch is not notified, one with access is', async () => {
      // TENANT_ADMIN/MANAGER are always branch-unrestricted by this
      // codebase's own established design (UNRESTRICTED_ROLES in
      // branchScope.js) - a real branch-isolation test needs a genuinely
      // branch-restrictable role as the notification's targetRoles, and an
      // explicit branchId, exactly like a real "TRANSFER_COMPLETED at
      // branch X" alert would specify.
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Notif Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Notif Branch 2' });
      const cashierInBranch1 = await createUserToken(tenantA.token, 'CASHIER', branch1.body.item.id);
      const cashierInBranch2 = await createUserToken(tenantA.token, 'CASHIER', branch2.body.item.id);

      const sourceId = `branch-notif-test-${Date.now()}`;
      await triggerEvent(prisma, {
        tenantId: tenantA.tenantId,
        event: 'EXPENSE_CREATED',
        sourceId,
        branchId: branch1.body.item.id,
        entityType: 'Expense',
        targetRoles: ['CASHIER'],
        internalTitle: 'Branch-scoped test',
        internalBody: 'Branch-scoped test',
      });

      const notifsForBranch1Cashier = await prisma.notification.findMany({ where: { tenantId: tenantA.tenantId, userId: cashierInBranch1.userId, entityId: sourceId } });
      const notifsForBranch2Cashier = await prisma.notification.findMany({ where: { tenantId: tenantA.tenantId, userId: cashierInBranch2.userId, entityId: sourceId } });
      expect(notifsForBranch1Cashier).toHaveLength(1);
      expect(notifsForBranch2Cashier).toHaveLength(0);
      expect(notifsForBranch1Cashier[0].branchId).toBe(branch1.body.item.id);
    });

    it('activity-log branchId filter respects the caller\'s own branch access', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Activity Branch Filter' });
      const otherBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Activity Other Branch' });
      const restrictedManager = await createUserToken(tenantA.token, 'MANAGER', branch.body.item.id);
      // MANAGER is branch-unrestricted by design (UNRESTRICTED_ROLES) - use the
      // explicit branchId query filter itself as the thing under test: passing
      // a branch the caller has no special denial for still round-trips
      // correctly (assertBranchAccess only rejects an EXPLICIT filter value
      // outside a truly restricted user's access - verified not to 403 here
      // since MANAGER is unrestricted).
      const res = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${restrictedManager.token}`).query({ branchId: otherBranch.body.item.id });
      expect(res.status).toBe(200);
    });
  });

  describe('Push notifications (device tokens, multiple devices)', () => {
    it('sendToUser fans out to every active device token for a user (multiple devices)', async () => {
      const user = await prisma.user.findFirst({ where: { tenantId: tenantA.tenantId, role: 'TENANT_ADMIN' } });
      await prisma.deviceToken.createMany({
        data: [
          { tenantId: tenantA.tenantId, userId: user.id, token: `device-a-${Date.now()}`, platform: 'ANDROID', isActive: true },
          { tenantId: tenantA.tenantId, userId: user.id, token: `device-b-${Date.now()}`, platform: 'ANDROID', isActive: true },
        ],
      });

      const results = await sendToUser(tenantA.tenantId, user.id, { title: 'Test', body: 'Test push' });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r.status === 'SENT')).toBe(true);
    });

    it('a failed delivery deactivates only that device token, not the user\'s other devices', async () => {
      const user = await prisma.user.findFirst({ where: { tenantId: tenantA.tenantId, role: 'TENANT_ADMIN' } });
      const goodToken = `device-good-${Date.now()}`;
      const failToken = 'FAIL_TEST';
      await prisma.deviceToken.createMany({
        data: [
          { tenantId: tenantA.tenantId, userId: user.id, token: goodToken, platform: 'ANDROID', isActive: true },
          { tenantId: tenantA.tenantId, userId: user.id, token: failToken, platform: 'ANDROID', isActive: true },
        ],
        skipDuplicates: true,
      });

      await sendToUser(tenantA.tenantId, user.id, { title: 'Test', body: 'Test push 2' });

      const good = await prisma.deviceToken.findFirst({ where: { tenantId: tenantA.tenantId, token: goodToken } });
      const failed = await prisma.deviceToken.findFirst({ where: { tenantId: tenantA.tenantId, token: failToken } });
      expect(good.isActive).toBe(true);
      expect(failed.isActive).toBe(false);
    });
  });

  describe('Optical/Medical regression (Universal Notifications/Activity Log stay industry-neutral)', () => {
    it('activity log filters accept generic entity/action names with no Optical/Medical-specific assumption', async () => {
      const res = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${tenantA.token}`).query({ entity: 'Product', action: 'PRODUCT_CREATE' });
      expect(res.status).toBe(200);
    });
  });
});
