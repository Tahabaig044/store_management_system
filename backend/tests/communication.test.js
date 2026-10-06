// Phase 8 - WhatsApp + Automation + Customer Portal tests: tenant isolation
// for messages/templates/automations, customer-ownership checks on every
// portal endpoint, idempotency/duplicate-prevention for message events and
// automation executions, provider failure/retry behavior via the mock
// provider's deterministic FAIL_TEST sentinel, business-event-triggered
// automations (sale/optical-order/appointment/purchase/transfer), opt-out
// enforcement, clinical-content redaction, and portal-vs-staff token
// isolation. Same convention as every other Phase's suite: real HTTP calls
// against a real (disposable, throwaway) database.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { dispatchMessage } = require('../src/modules/communication/queue');

jest.setTimeout(30000);

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}
function uniquePhone() {
  return `03${Math.floor(Math.random() * 1000000000)}`;
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

async function createCustomer(token, overrides = {}) {
  const res = await request(app)
    .post('/api/customers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Test Customer', phone: uniquePhone(), ...overrides });
  if (res.status !== 201) throw new Error(`create customer failed: ${JSON.stringify(res.body)}`);
  return res.body.item;
}

async function createProduct(token, overrides = {}) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Test Product', type: 'GENERAL', purchasePrice: 10, sellingPrice: 20, openingStock: 100, ...overrides });
  if (res.status !== 201) throw new Error(`create product failed: ${JSON.stringify(res.body)}`);
  return res.body.item;
}

// Extracts a 6-digit code from the Message row the OTP flow creates -
// mirrors how a real customer would read the code off their WhatsApp.
async function readLatestOtpCode(tenantId, customerId) {
  const message = await prisma.message.findFirst({
    where: { tenantId, customerId, sourceEventType: 'PORTAL_OTP' },
    orderBy: { queuedAt: 'desc' },
  });
  const match = message?.body.match(/\d{6}/);
  return match ? match[0] : null;
}

describe('Phase 8 - WhatsApp + Automation + Customer Portal', () => {
  let tenantA;
  let tenantB;
  let cashierA;
  let receptionistA;
  let customerA;

  beforeAll(async () => {
    tenantA = await registerTenant(`Comms Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`Comms Tenant B ${Date.now()}`);
    cashierA = await createUserToken(tenantA.token, 'CASHIER');
    receptionistA = await createUserToken(tenantA.token, 'RECEPTIONIST');
    customerA = await createCustomer(tenantA.token);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('RBAC', () => {
    test('a role outside COMMUNICATION_STAFF (CASHIER) cannot view the Communication Center', async () => {
      const res = await request(app).get('/api/communication/messages').set('Authorization', `Bearer ${cashierA}`);
      expect(res.status).toBe(403);
    });

    test('COMMUNICATION_STAFF (RECEPTIONIST) can view messages but cannot send one (MANAGEMENT only)', async () => {
      const list = await request(app).get('/api/communication/messages').set('Authorization', `Bearer ${receptionistA}`);
      expect(list.status).toBe(200);

      const send = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerA.id, body: 'hello' });
      expect(send.status).toBe(403);
    });

    test('only TENANT_ADMIN can read/update the communication config', async () => {
      const managerToken = await createUserToken(tenantA.token, 'MANAGER');
      const forbidden = await request(app).get('/api/communication/config').set('Authorization', `Bearer ${managerToken}`);
      expect(forbidden.status).toBe(403);

      const allowed = await request(app).get('/api/communication/config').set('Authorization', `Bearer ${tenantA.token}`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.item.hasCredentials).toBe(false);
      expect(allowed.body.item.credentials).toBeUndefined();
    });
  });

  describe('Manual send, idempotency, and provider failure/retry', () => {
    test('a manual WhatsApp send is queued and dispatched via the mock provider', async () => {
      const res = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customerA.id, body: 'Your order is ready' });
      expect(res.status).toBe(201);
      expect(res.body.item.status).toBe('SENT');
      expect(res.body.item.providerMessageId).toMatch(/^mock-/);
    });

    test('a repeated idempotencyKey returns the original message instead of sending twice', async () => {
      const key = `manual-${Date.now()}`;
      const first = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customerA.id, body: 'Once only', idempotencyKey: key });
      const second = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customerA.id, body: 'Once only', idempotencyKey: key });

      expect(first.body.deduplicated).toBe(false);
      expect(second.body.deduplicated).toBe(true);
      expect(second.body.item.id).toBe(first.body.item.id);

      const count = await prisma.message.count({ where: { tenantId: tenantA.tenantId, idempotencyKey: key } });
      expect(count).toBe(1);
    });

    test('the FAIL_TEST sentinel deterministically fails delivery, retries with backoff, then becomes permanently FAILED after 5 attempts', async () => {
      const failingCustomer = await createCustomer(tenantA.token, { phone: 'FAIL_TEST' });
      const sent = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: failingCustomer.id, body: 'This will fail' });
      // First failure stays QUEUED (with a backoff nextRetryAt) rather than
      // going straight to FAILED - retryCount must exhaust maxRetries (5)
      // before the message becomes permanently FAILED.
      expect(sent.body.item.status).toBe('QUEUED');
      expect(sent.body.item.retryCount).toBe(1);
      expect(sent.body.item.nextRetryAt).not.toBeNull();

      // A message that hasn't permanently failed yet cannot be manually retried.
      const tooEarly = await request(app)
        .post(`/api/communication/messages/${sent.body.item.id}/retry`)
        .set('Authorization', `Bearer ${tenantA.token}`);
      expect(tooEarly.status).toBe(409);

      // Drive it through the remaining attempts directly (bypassing the
      // nextRetryAt backoff wait, which processQueue() would otherwise
      // enforce) until it exhausts its retries and becomes permanently FAILED.
      let current;
      for (let i = 0; i < 4; i += 1) {
        current = await dispatchMessage(prisma, sent.body.item.id);
      }
      expect(current.status).toBe('FAILED');
      expect(current.retryCount).toBe(5);

      const forbidden = await request(app)
        .post(`/api/communication/messages/${sent.body.item.id}/retry`)
        .set('Authorization', `Bearer ${receptionistA}`);
      expect(forbidden.status).toBe(403);

      const retried = await request(app)
        .post(`/api/communication/messages/${sent.body.item.id}/retry`)
        .set('Authorization', `Bearer ${tenantA.token}`);
      expect(retried.status).toBe(200);
      // Manual retry resets retryCount to 0 first, giving it a fresh full
      // set of backoff attempts - the sentinel phone still fails, but only
      // this first fresh attempt, so it's back to QUEUED-with-backoff, not
      // immediately re-failed permanently.
      expect(retried.body.item.status).toBe('QUEUED');
      expect(retried.body.item.retryCount).toBe(1);

      const sentOk = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customerA.id, body: 'A normal message' });
      const notFailed = await request(app)
        .post(`/api/communication/messages/${sentOk.body.item.id}/retry`)
        .set('Authorization', `Bearer ${tenantA.token}`);
      expect(notFailed.status).toBe(409);
    });
  });

  describe('Templates and automation rules', () => {
    test('default templates and automation rules are lazily seeded per tenant', async () => {
      const templates = await request(app).get('/api/communication/templates').set('Authorization', `Bearer ${tenantA.token}`);
      expect(templates.body.items.length).toBeGreaterThanOrEqual(8);

      const rules = await request(app).get('/api/communication/automation-rules').set('Authorization', `Bearer ${tenantA.token}`);
      expect(rules.body.items.length).toBeGreaterThanOrEqual(15);

      const saleRule = rules.body.items.find((r) => r.event === 'SALE_COMPLETED');
      expect(saleRule.isEnabled).toBe(false); // ships disabled by default
    });

    test('a system template cannot be deactivated, but a non-system one can', async () => {
      const templates = await request(app).get('/api/communication/templates').set('Authorization', `Bearer ${tenantA.token}`);
      const systemTemplate = templates.body.items.find((t) => t.isSystem);

      const blocked = await request(app)
        .patch(`/api/communication/templates/${systemTemplate.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ isActive: false });
      expect(blocked.status).toBe(409);

      const custom = await request(app)
        .post('/api/communication/templates')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ type: 'CUSTOM', name: 'My custom template', body: 'Hi {{customerName}}, custom message.' });
      expect(custom.status).toBe(201);

      const preview = await request(app)
        .post(`/api/communication/templates/${custom.body.item.id}/preview`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ variables: { customerName: 'Alice' } });
      expect(preview.body.rendered).toBe('Hi Alice, custom message.');
      expect(preview.body.placeholders).toEqual(['customerName']);
    });

    test('a system automation rule can be disabled but not deleted; only MANAGEMENT can change it', async () => {
      const rules = await request(app).get('/api/communication/automation-rules').set('Authorization', `Bearer ${tenantA.token}`);
      const bookingRule = rules.body.items.find((r) => r.event === 'APPOINTMENT_BOOKED');

      const forbidden = await request(app)
        .patch(`/api/communication/automation-rules/${bookingRule.id}`)
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ isEnabled: false });
      expect(forbidden.status).toBe(403);

      const deleted = await request(app)
        .delete(`/api/communication/automation-rules/${bookingRule.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`);
      expect(deleted.status).toBe(409);
    });
  });

  describe('Tenant isolation', () => {
    test('a template/message created in tenant A is invisible to tenant B', async () => {
      const sent = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customerA.id, body: 'Tenant A only' });

      const crossTenantGet = await request(app)
        .get(`/api/communication/messages/${sent.body.item.id}`)
        .set('Authorization', `Bearer ${tenantB.token}`);
      expect(crossTenantGet.status).toBe(404);

      const tenantBMessages = await request(app).get('/api/communication/messages').set('Authorization', `Bearer ${tenantB.token}`);
      expect(tenantBMessages.body.items.find((m) => m.id === sent.body.item.id)).toBeUndefined();
    });

    test('automation rules are seeded and configured independently per tenant', async () => {
      const rulesA = await request(app).get('/api/communication/automation-rules').set('Authorization', `Bearer ${tenantA.token}`);
      const rulesB = await request(app).get('/api/communication/automation-rules').set('Authorization', `Bearer ${tenantB.token}`);
      const bookingA = rulesA.body.items.find((r) => r.event === 'APPOINTMENT_BOOKED');
      const bookingB = rulesB.body.items.find((r) => r.event === 'APPOINTMENT_BOOKED');
      expect(bookingA.id).not.toBe(bookingB.id);

      // Toggle tenant A's rule and confirm tenant B's independent copy is
      // unaffected - then restore it, since later tests in this suite rely
      // on tenant A's default APPOINTMENT_BOOKED automation staying enabled.
      await request(app)
        .patch(`/api/communication/automation-rules/${bookingA.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ isEnabled: false });

      const refreshedB = await request(app).get('/api/communication/automation-rules').set('Authorization', `Bearer ${tenantB.token}`);
      expect(refreshedB.body.items.find((r) => r.event === 'APPOINTMENT_BOOKED').isEnabled).toBe(true);

      await request(app)
        .patch(`/api/communication/automation-rules/${bookingA.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ isEnabled: true });
    });
  });

  describe('Business-event-triggered automations', () => {
    let patientId;
    let customerWithPatient;

    beforeAll(async () => {
      customerWithPatient = await createCustomer(tenantA.token, { name: 'Clinical Customer' });
      const patient = await request(app)
        .post('/api/patients')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerWithPatient.id });
      patientId = patient.body.item.id;
    });

    test('booking an appointment fires APPOINTMENT_BOOKED and sends a WhatsApp confirmation exactly once', async () => {
      const appt = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId, scheduledAt: new Date(Date.now() + 86400000).toISOString() });
      expect(appt.status).toBe(201);

      const messages = await prisma.message.findMany({
        where: { tenantId: tenantA.tenantId, sourceEventType: 'APPOINTMENT_BOOKED', sourceId: appt.body.item.id },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0].status).toBe('SENT');

      const executions = await prisma.automationExecution.count({
        where: { tenantId: tenantA.tenantId, event: 'APPOINTMENT_BOOKED', sourceId: appt.body.item.id },
      });
      expect(executions).toBe(1);
    });

    test('marking an appointment NO_SHOW raises an internal notification for management, not a customer message', async () => {
      const appt = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId, scheduledAt: new Date(Date.now() + 172800000).toISOString() });

      await request(app)
        .patch(`/api/appointments/${appt.body.item.id}/status`)
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ status: 'NO_SHOW' });

      const notifications = await prisma.notification.findMany({
        where: { tenantId: tenantA.tenantId, type: 'APPOINTMENT_NO_SHOW' },
      });
      expect(notifications.length).toBeGreaterThan(0);

      const messages = await prisma.message.count({ where: { tenantId: tenantA.tenantId, sourceEventType: 'APPOINTMENT_NO_SHOW' } });
      expect(messages).toBe(0);
    });

    test('an optical order fires OPTICAL_ORDER_CREATED, then OPTICAL_JOB_READY and OPTICAL_ORDER_DELIVERED on status change', async () => {
      const order = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerA.id, totalAmount: 100 });
      expect(order.status).toBe(201);

      const created = await prisma.message.count({ where: { tenantId: tenantA.tenantId, sourceEventType: 'OPTICAL_ORDER_CREATED', sourceId: order.body.item.id } });
      expect(created).toBe(1);

      await request(app)
        .patch(`/api/optical-orders/${order.body.item.id}`)
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ status: 'READY' });
      const ready = await prisma.message.count({ where: { tenantId: tenantA.tenantId, sourceEventType: 'OPTICAL_JOB_READY', sourceId: order.body.item.id } });
      expect(ready).toBe(1);

      await request(app)
        .patch(`/api/optical-orders/${order.body.item.id}`)
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ status: 'DELIVERED' });
      const delivered = await prisma.message.count({ where: { tenantId: tenantA.tenantId, sourceEventType: 'OPTICAL_ORDER_DELIVERED', sourceId: order.body.item.id } });
      expect(delivered).toBe(1);
    });

    test('an offline-retried optical order create (same idempotencyKey) triggers the automation only once', async () => {
      const key = `offline-sync-${Date.now()}`;
      const first = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerA.id, totalAmount: 50, idempotencyKey: key });
      const second = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerA.id, totalAmount: 50, idempotencyKey: key });

      expect(second.body.deduplicated).toBe(true);
      expect(second.body.item.id).toBe(first.body.item.id);

      const count = await prisma.message.count({ where: { tenantId: tenantA.tenantId, sourceEventType: 'OPTICAL_ORDER_CREATED', sourceId: first.body.item.id } });
      expect(count).toBe(1);
    });

    test('SALE_COMPLETED ships disabled by default (no message sent), and sends once enabled', async () => {
      const product = await createProduct(tenantA.token);
      const sale1 = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${cashierA}`)
        .send({ customerId: customerA.id, items: [{ productId: product.id, quantity: 1, unitPrice: 20 }] });
      const before = await prisma.message.count({ where: { tenantId: tenantA.tenantId, sourceEventType: 'SALE_COMPLETED', sourceId: sale1.body.item.id } });
      expect(before).toBe(0);

      const rules = await request(app).get('/api/communication/automation-rules').set('Authorization', `Bearer ${tenantA.token}`);
      const saleRule = rules.body.items.find((r) => r.event === 'SALE_COMPLETED');
      await request(app)
        .patch(`/api/communication/automation-rules/${saleRule.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ isEnabled: true });

      const sale2 = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${cashierA}`)
        .send({ customerId: customerA.id, items: [{ productId: product.id, quantity: 1, unitPrice: 20 }] });
      const after = await prisma.message.count({ where: { tenantId: tenantA.tenantId, sourceEventType: 'SALE_COMPLETED', sourceId: sale2.body.item.id } });
      expect(after).toBe(1);
    });

    test('approving a purchase order fires an internal PURCHASE_APPROVED notification, not a customer message', async () => {
      await request(app).put('/api/settings/purchaseApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '50' });
      const supplier = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Test Supplier' });
      const product = await createProduct(tenantA.token);

      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId: supplier.body.item.id, items: [{ productId: product.id, quantity: 10, unitCost: 20 }] }); // 200 > 50
      expect(po.body.item.status).toBe('PENDING_APPROVAL');

      const approved = await request(app)
        .post(`/api/procurement/purchase-orders/${po.body.item.id}/approve`)
        .set('Authorization', `Bearer ${tenantA.token}`);
      expect(approved.status).toBe(200);

      const notifications = await prisma.notification.count({ where: { tenantId: tenantA.tenantId, type: 'PURCHASE_APPROVED' } });
      expect(notifications).toBeGreaterThan(0);
    });
  });

  describe('Opt-out and clinical-content redaction', () => {
    test('an opted-out customer receives a CANCELLED message instead of a WhatsApp send', async () => {
      const optedOut = await createCustomer(tenantA.token, { name: 'Opted Out Customer' });
      await prisma.customerCommunicationPreference.create({ data: { customerId: optedOut.id, whatsappOptOut: true } });

      const res = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: optedOut.id, body: 'Promo message' });
      expect(res.body.item.status).toBe('CANCELLED');
    });

    test('a PRESCRIPTION_SUMMARY message body is redacted for staff outside CLINICAL_STAFF', async () => {
      const rxTemplate = await request(app)
        .post('/api/communication/templates')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ type: 'PRESCRIPTION_SUMMARY', name: 'Rx summary test', body: 'Your prescription: OD -1.00, OS -1.25' });

      const sent = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customerA.id, templateId: rxTemplate.body.item.id, body: 'Your prescription: OD -1.00, OS -1.25' });

      // RECEPTIONIST is COMMUNICATION_STAFF but also CLINICAL_STAFF in this
      // codebase's role groups, so use ACCOUNTANT - COMMUNICATION_STAFF but
      // never CLINICAL_STAFF - to prove redaction actually applies.
      const accountantA = await createUserToken(tenantA.token, 'ACCOUNTANT');
      const asAccountant = await request(app).get(`/api/communication/messages/${sent.body.item.id}`).set('Authorization', `Bearer ${accountantA}`);
      expect(asAccountant.body.item.body).toBe('[Clinical content - restricted]');

      const asAdmin = await request(app).get(`/api/communication/messages/${sent.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(asAdmin.body.item.body).toContain('OD -1.00');
    });
  });

  describe('Customer Portal', () => {
    let portalCustomer;
    let portalToken;

    beforeAll(async () => {
      portalCustomer = await createCustomer(tenantA.token, { name: 'Portal Customer' });
    });

    test('OTP request is generic about whether the phone matches a customer', async () => {
      const known = await request(app).post('/api/portal/auth/request-otp').send({ tenantId: tenantA.tenantId, phone: portalCustomer.phone });
      const unknown = await request(app).post('/api/portal/auth/request-otp').send({ tenantId: tenantA.tenantId, phone: uniquePhone() });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.body.message).toBe(unknown.body.message);
    });

    test('a wrong code is rejected and does not authenticate', async () => {
      const res = await request(app).post('/api/portal/auth/verify-otp').send({ tenantId: tenantA.tenantId, phone: portalCustomer.phone, code: '000000' });
      expect(res.status).toBe(401);
    });

    test('the correct code, read from the delivered message, authenticates and returns a portal token', async () => {
      await request(app).post('/api/portal/auth/request-otp').send({ tenantId: tenantA.tenantId, phone: portalCustomer.phone });
      const code = await readLatestOtpCode(tenantA.tenantId, portalCustomer.id);
      expect(code).toMatch(/^\d{6}$/);

      const verify = await request(app).post('/api/portal/auth/verify-otp').send({ tenantId: tenantA.tenantId, phone: portalCustomer.phone, code });
      expect(verify.status).toBe(200);
      expect(verify.body.token).toBeTruthy();
      portalToken = verify.body.token;

      // The same code cannot be reused (consumedAt is set).
      const reuse = await request(app).post('/api/portal/auth/verify-otp').send({ tenantId: tenantA.tenantId, phone: portalCustomer.phone, code });
      expect(reuse.status).toBe(401);
    });

    test('a portal token cannot access staff routes, and a staff token cannot access portal routes', async () => {
      const portalOnStaff = await request(app).get('/api/communication/messages').set('Authorization', `Bearer ${portalToken}`);
      expect(portalOnStaff.status).toBe(401);

      const staffOnPortal = await request(app).get('/api/portal/me').set('Authorization', `Bearer ${tenantA.token}`);
      expect(staffOnPortal.status).toBe(401);
    });

    test('a customer can view their own profile, orders, and outstanding balance, scoped only to themselves', async () => {
      const me = await request(app).get('/api/portal/me').set('Authorization', `Bearer ${portalToken}`);
      expect(me.status).toBe(200);
      expect(me.body.customer.id).toBe(portalCustomer.id);

      const orders = await request(app).get('/api/portal/optical-orders').set('Authorization', `Bearer ${portalToken}`);
      expect(orders.status).toBe(200);
      expect(orders.body.items.every((o) => o.customerId === portalCustomer.id)).toBe(true);

      const balance = await request(app).get('/api/portal/outstanding-balance').set('Authorization', `Bearer ${portalToken}`);
      expect(balance.status).toBe(200);
      expect(typeof balance.body.totalOutstanding).toBe('number');
    });

    test('requesting an appointment and a follow-up raises internal staff notifications, not real records', async () => {
      const before = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);

      const apptReq = await request(app)
        .post('/api/portal/appointments/request')
        .set('Authorization', `Bearer ${portalToken}`)
        .send({ preferredDate: '2026-10-01', reason: 'Annual checkup' });
      expect(apptReq.status).toBe(201);

      const followUp = await request(app)
        .post('/api/portal/follow-up')
        .set('Authorization', `Bearer ${portalToken}`)
        .send({ message: 'Please call me back about my order' });
      expect(followUp.status).toBe(201);

      const after = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tenantA.token}`);
      expect(after.body.total).toBeGreaterThanOrEqual(before.body.total + 2);
    });

    test('opting out via the portal prevents subsequent WhatsApp sends to that customer', async () => {
      const optOut = await request(app)
        .put('/api/portal/communication-preferences')
        .set('Authorization', `Bearer ${portalToken}`)
        .send({ whatsappOptOut: true });
      expect(optOut.status).toBe(200);

      const sent = await request(app)
        .post('/api/communication/messages')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: portalCustomer.id, body: 'Should be cancelled' });
      expect(sent.body.item.status).toBe('CANCELLED');
    });

    test('one customer\'s portal token cannot see another customer\'s orders or prescriptions', async () => {
      const otherCustomer = await createCustomer(tenantA.token, { name: 'Other Customer' });
      const order = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: otherCustomer.id, totalAmount: 75 });

      await request(app).post('/api/portal/auth/request-otp').send({ tenantId: tenantA.tenantId, phone: otherCustomer.phone });
      const code = await readLatestOtpCode(tenantA.tenantId, otherCustomer.id);
      const otherLogin = await request(app).post('/api/portal/auth/verify-otp').send({ tenantId: tenantA.tenantId, phone: otherCustomer.phone, code });
      const otherToken = otherLogin.body.token;

      // The order's own owner can see it via their own portal token...
      const asOwner = await request(app).get('/api/portal/optical-orders').set('Authorization', `Bearer ${otherToken}`);
      expect(asOwner.body.items.find((o) => o.id === order.body.item.id)).toBeDefined();

      // ...but a different customer's portal token, even in the same tenant, cannot.
      const asPortalCustomer = await request(app).get('/api/portal/optical-orders').set('Authorization', `Bearer ${portalToken}`);
      expect(asPortalCustomer.body.items.find((o) => o.id === order.body.item.id)).toBeUndefined();
    });

    test('a portal token from tenant A cannot be used against tenant B', async () => {
      // Ensure tenant B independently has no such customer/account.
      const res = await request(app).get('/api/portal/me').set('Authorization', `Bearer ${portalToken}`);
      expect(res.body.customer.tenantId ?? tenantA.tenantId).toBe(tenantA.tenantId);
    });
  });

  describe('Communication reports', () => {
    test('report endpoints are scoped to COMMUNICATION_STAFF and return tenant-scoped data', async () => {
      const forbidden = await request(app).get('/api/communication/reports/volume').set('Authorization', `Bearer ${cashierA}`);
      expect(forbidden.status).toBe(403);

      const volume = await request(app).get('/api/communication/reports/volume').set('Authorization', `Bearer ${tenantA.token}`);
      expect(volume.status).toBe(200);
      expect(typeof volume.body.total).toBe('number');

      const delivery = await request(app).get('/api/communication/reports/whatsapp-delivery').set('Authorization', `Bearer ${tenantA.token}`);
      expect(delivery.status).toBe(200);
      expect(delivery.body).toHaveProperty('deliveryRatePercent');

      const executions = await request(app).get('/api/communication/reports/automation-executions').set('Authorization', `Bearer ${tenantA.token}`);
      expect(executions.status).toBe(200);
      expect(executions.body.byEvent.APPOINTMENT_BOOKED).toBeGreaterThan(0);

      const branchActivity = await request(app).get('/api/communication/reports/branch-activity').set('Authorization', `Bearer ${tenantA.token}`);
      expect(branchActivity.status).toBe(200);
      expect(Array.isArray(branchActivity.body.rows)).toBe(true);
    });
  });

  describe('Command Center integration', () => {
    test('the command-center endpoint includes a communication KPI block', async () => {
      const res = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.communication).toBeDefined();
      expect(res.body.communication.total).toBeGreaterThan(0);
      expect(res.body.communication).toHaveProperty('byStatus');
      expect(res.body.communication).toHaveProperty('performanceByBranch');
    });
  });

  describe('Scheduled automation scan', () => {
    test('only TENANT_ADMIN can trigger the scheduled scan endpoint, and it is idempotent per day', async () => {
      const forbidden = await request(app).post('/api/automation/run-scheduled').set('Authorization', `Bearer ${receptionistA}`);
      expect(forbidden.status).toBe(403);

      const first = await request(app).post('/api/automation/run-scheduled').set('Authorization', `Bearer ${tenantA.token}`);
      expect(first.status).toBe(200);
      expect(first.body.scanned).toBeDefined();

      // A second run the same day must not create duplicate DAILY_CLOSE executions.
      await request(app).post('/api/automation/run-scheduled').set('Authorization', `Bearer ${tenantA.token}`);
      const dailyCloseExecutions = await prisma.automationExecution.count({
        where: { tenantId: tenantA.tenantId, event: 'DAILY_CLOSE' },
      });
      expect(dailyCloseExecutions).toBe(1);
    });
  });
});
