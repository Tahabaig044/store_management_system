// V1 Phase 3 - no fake "delivered": in production the mock messaging/push providers must not pretend to send,
// and features that need delivery must say they are unavailable.
const supertest = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { queueAndDispatch } = require('../src/modules/communication/queue');
const { sendToUser } = require('../src/modules/push/pushService');

jest.setTimeout(60000);

const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const api = { get: (p) => supertest(app).get(p).set('X-Forwarded-For', ip()), post: (p) => supertest(app).post(p).set('X-Forwarded-For', ip()) };

const saved = { ...process.env };
function production(on = true, allowMock = false) {
  if (on) process.env.NODE_ENV = 'production'; else process.env.NODE_ENV = saved.NODE_ENV;
  if (allowMock) process.env.ALLOW_MOCK_PROVIDERS = 'true'; else delete process.env.ALLOW_MOCK_PROVIDERS;
}
afterEach(() => production(false));

let tenantId; let userId; let customer;
beforeAll(async () => {
  const res = await api.post('/api/auth/register-tenant').send({
    businessName: `Msg ${Date.now()}`, adminName: 'Msg Admin', email: `msg-${Date.now()}@test.local`, password: 'GoodPass123',
  });
  tenantId = res.body.tenant.id;
  userId = res.body.user.id;
  customer = await prisma.customer.create({ data: { tenantId, name: 'Portal Customer', phone: `03${Date.now()}`.slice(0, 11) } });
});

describe('capability flags', () => {
  test('development/test: available (mock)', async () => {
    const cfg = (await api.get('/api/auth/config')).body;
    expect(cfg).toMatchObject({ whatsappAvailable: true, portalLoginAvailable: true, pushAvailable: true });
  });
  test('production: nothing claims to deliver', async () => {
    production();
    const cfg = (await api.get('/api/auth/config')).body;
    expect(cfg).toMatchObject({ whatsappAvailable: false, portalLoginAvailable: false, pushAvailable: false });
  });
  test('production with the explicit staging override: mock allowed', async () => {
    production(true, true);
    expect((await api.get('/api/auth/config')).body.whatsappAvailable).toBe(true);
  });
});

describe('customer portal OTP', () => {
  test('production: request-otp is refused and creates no code', async () => {
    production();
    const before = await prisma.customerPortalOtp.count();
    const res = await api.post('/api/portal/auth/request-otp').send({ tenantId, phone: customer.phone });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PORTAL_UNAVAILABLE');
    expect(await prisma.customerPortalOtp.count()).toBe(before);
  });
  test('development: still works', async () => {
    const res = await api.post('/api/portal/auth/request-otp').send({ tenantId, phone: customer.phone });
    expect(res.status).toBe(200);
  });
});

describe('WhatsApp queue', () => {
  test('production: the message is FAILED once with an honest reason, never SENT, and is not retried', async () => {
    production();
    const { message } = await queueAndDispatch(prisma, {
      tenantId, channel: 'WHATSAPP', customerId: customer.id, recipientPhone: customer.phone, body: 'hello', sourceEventType: 'TEST',
    });
    expect(message.status).toBe('FAILED');
    expect(message.failureReason).toMatch(/no WhatsApp provider is configured/i);
    expect(message.providerMessageId).toBeNull();
    expect(message.nextRetryAt).toBeNull();
    expect(message.retryCount).toBe(0);
  });
  test('development: still SENT by the mock', async () => {
    const { message } = await queueAndDispatch(prisma, {
      tenantId, channel: 'WHATSAPP', customerId: customer.id, recipientPhone: customer.phone, body: 'hello', sourceEventType: 'TEST',
    });
    expect(message.status).toBe('SENT');
  });
});

describe('owner push', () => {
  test('production: reports FAILED and keeps the device registered (it is not the device that is at fault)', async () => {
    const dev = await prisma.deviceToken.create({ data: { tenantId, userId, token: `tok-${Date.now()}` } });
    production();
    const results = await sendToUser(tenantId, userId, { title: 't', body: 'b' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.status === 'FAILED' && r.notConfigured)).toBe(true);
    expect((await prisma.deviceToken.findUnique({ where: { id: dev.id } })).isActive).toBe(true);
  });
});
