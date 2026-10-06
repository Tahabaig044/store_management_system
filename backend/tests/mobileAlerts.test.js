// Integration tests for Phase 3's Owner Mobile Alert Center, notification
// preferences, push-token registration, and the alert-detection/push
// dispatch pipeline (extended into POST /api/automation/run-scheduled).
//
// Needs DATABASE_URL pointed at a real, throwaway Postgres database with
// migrations applied (see README "Testing"). Every tenant/user/product here
// is freshly created inside this file.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(30000);

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function registerTenantWithCreds(businessName) {
  const email = uniqueEmail('owner');
  const password = 'TestPass123';
  const res = await request(app)
    .post('/api/auth/register-tenant')
    .send({ businessName, adminName: 'Test Owner', email, password });
  if (res.status !== 201) throw new Error(`register-tenant failed: ${JSON.stringify(res.body)}`);
  return { webToken: res.body.token, tenantId: res.body.tenant.id, userId: res.body.user.id, email, password };
}

async function mobileLogin(email, password) {
  const res = await request(app).post('/api/mobile/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`mobile login failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function post(token, path, body) {
  const res = await request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
  if (res.status >= 400) throw new Error(`POST ${path} failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function refreshInsights(webToken) {
  const res = await request(app).post('/api/ai/insights/refresh').set('Authorization', `Bearer ${webToken}`);
  if (res.status !== 200) throw new Error(`refresh failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function runScheduled(webToken) {
  const res = await request(app).post('/api/automation/run-scheduled').set('Authorization', `Bearer ${webToken}`);
  if (res.status !== 200) throw new Error(`run-scheduled failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

function mobileHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

describe('Owner Mobile alerts, preferences, and push (Phase 3)', () => {
  let tenant;
  let mobileToken;
  let lowStockProductId;

  beforeAll(async () => {
    tenant = await registerTenantWithCreds(`Mobile Alerts Tenant ${Date.now()}`);
    mobileToken = await mobileLogin(tenant.email, tenant.password);

    const product = await post(tenant.webToken, '/api/products', {
      name: 'Critically Low Widget',
      purchasePrice: 10,
      sellingPrice: 20,
      openingStock: 2,
      lowStockThreshold: 10,
    });
    lowStockProductId = product.item.id;

    await refreshInsights(tenant.webToken);
  });

  describe('read-only + auth enforcement', () => {
    it('rejects requests with no token', async () => {
      const res = await request(app).get('/api/mobile/v1/alerts');
      expect(res.status).toBe(401);
    });

    it('rejects a staff web token', async () => {
      const res = await request(app).get('/api/mobile/v1/alerts').set(mobileHeaders(tenant.webToken));
      expect(res.status).toBe(401);
    });

    it('rejects an undefined write verb on the alerts collection (falls through to the read-only guard)', async () => {
      const res = await request(app).post('/api/mobile/v1/alerts').set(mobileHeaders(mobileToken));
      expect(res.status).toBe(403);
    });

    it('rejects PATCH on a specific alert', async () => {
      const list = await request(app).get('/api/mobile/v1/alerts').set(mobileHeaders(mobileToken));
      const id = list.body.items[0].id;
      const res = await request(app).patch(`/api/mobile/v1/alerts/${id}`).set(mobileHeaders(mobileToken));
      expect(res.status).toBe(403);
    });
  });

  describe('GET /alerts', () => {
    it('lists the low-stock condition mapped to INVENTORY / a valid priority', async () => {
      const res = await request(app).get('/api/mobile/v1/alerts').set(mobileHeaders(mobileToken));
      expect(res.status).toBe(200);
      const lowStockAlert = res.body.items.find((a) => a.evidence?.productId === lowStockProductId);
      expect(lowStockAlert).toBeTruthy();
      expect(lowStockAlert.category).toBe('INVENTORY');
      expect(['CRITICAL', 'IMPORTANT', 'INFORMATIONAL']).toContain(lowStockAlert.priority);
      expect(lowStockAlert.isRead).toBe(false);
    });

    it('filters by status=unread and status=read', async () => {
      const unread = await request(app).get('/api/mobile/v1/alerts?status=unread').set(mobileHeaders(mobileToken));
      const target = unread.body.items.find((a) => a.evidence?.productId === lowStockProductId);
      expect(target).toBeTruthy();

      await request(app).post(`/api/mobile/v1/alerts/${target.id}/read`).set(mobileHeaders(mobileToken));

      const unreadAfter = await request(app).get('/api/mobile/v1/alerts?status=unread').set(mobileHeaders(mobileToken));
      expect(unreadAfter.body.items.find((a) => a.id === target.id)).toBeUndefined();

      const readAfter = await request(app).get('/api/mobile/v1/alerts?status=read').set(mobileHeaders(mobileToken));
      expect(readAfter.body.items.find((a) => a.id === target.id)).toBeTruthy();
    });

    it('rejects an invalid priority filter', async () => {
      const res = await request(app).get('/api/mobile/v1/alerts?priority=NOT_A_PRIORITY').set(mobileHeaders(mobileToken));
      expect(res.status).toBe(422);
    });
  });

  describe('POST /alerts/:id/dismiss', () => {
    it('dismisses an alert without modifying the underlying business record', async () => {
      const list = await request(app).get('/api/mobile/v1/alerts').set(mobileHeaders(mobileToken));
      const target = list.body.items.find((a) => a.evidence?.productId === lowStockProductId);

      const before = await prisma.product.findUnique({ where: { id: lowStockProductId } });

      const res = await request(app).post(`/api/mobile/v1/alerts/${target.id}/dismiss`).set(mobileHeaders(mobileToken));
      expect(res.status).toBe(200);
      expect(res.body.item.isDismissed).toBe(true);

      const after = await prisma.product.findUnique({ where: { id: lowStockProductId } });
      expect(Number(after.stockQuantity)).toBe(Number(before.stockQuantity));
      expect(Number(after.lowStockThreshold)).toBe(Number(before.lowStockThreshold));

      // Dismissed but still retrievable (archived, not deleted).
      const detail = await request(app).get(`/api/mobile/v1/alerts/${target.id}`).set(mobileHeaders(mobileToken));
      expect(detail.status).toBe(200);
      expect(detail.body.item.isDismissed).toBe(true);
    });
  });

  describe('tenant isolation', () => {
    it('a second tenant cannot read or act on the first tenant\'s alert', async () => {
      const tenantB = await registerTenantWithCreds(`Mobile Alerts Tenant B ${Date.now()}`);
      const mobileTokenB = await mobileLogin(tenantB.email, tenantB.password);

      const list = await request(app).get('/api/mobile/v1/alerts').set(mobileHeaders(mobileToken));
      const anyAlertId = list.body.items[0].id;

      const getRes = await request(app).get(`/api/mobile/v1/alerts/${anyAlertId}`).set(mobileHeaders(mobileTokenB));
      expect(getRes.status).toBe(404);

      const readRes = await request(app).post(`/api/mobile/v1/alerts/${anyAlertId}/read`).set(mobileHeaders(mobileTokenB));
      expect(readRes.status).toBe(404);
    });
  });

  describe('notification preferences', () => {
    it('defaults to everything enabled, ALL priority', async () => {
      const res = await request(app).get('/api/mobile/v1/notification-preferences').set(mobileHeaders(mobileToken));
      expect(res.status).toBe(200);
      expect(res.body.item.minimumPriority).toBe('ALL');
      expect(res.body.item.inventoryAlertsEnabled).toBe(true);
      expect(res.body.item.dailySummaryEnabled).toBe(true);
    });

    it('persists an update', async () => {
      const put = await request(app)
        .put('/api/mobile/v1/notification-preferences')
        .set(mobileHeaders(mobileToken))
        .send({ inventoryAlertsEnabled: false, minimumPriority: 'CRITICAL_ONLY' });
      expect(put.status).toBe(200);

      const get = await request(app).get('/api/mobile/v1/notification-preferences').set(mobileHeaders(mobileToken));
      expect(get.body.item.inventoryAlertsEnabled).toBe(false);
      expect(get.body.item.minimumPriority).toBe('CRITICAL_ONLY');

      // restore for later tests in this file
      await request(app)
        .put('/api/mobile/v1/notification-preferences')
        .set(mobileHeaders(mobileToken))
        .send({ inventoryAlertsEnabled: true, minimumPriority: 'ALL' });
    });

    it('rejects an invalid dailySummaryTime', async () => {
      const res = await request(app)
        .put('/api/mobile/v1/notification-preferences')
        .set(mobileHeaders(mobileToken))
        .send({ dailySummaryTime: '9am' });
      expect(res.status).toBe(422);
    });

    it('rejects an empty update', async () => {
      const res = await request(app).put('/api/mobile/v1/notification-preferences').set(mobileHeaders(mobileToken)).send({});
      expect(res.status).toBe(422);
    });
  });

  describe('push device registration', () => {
    const token = `test-device-token-${Date.now()}`;

    it('registers a device', async () => {
      const res = await request(app).post('/api/mobile/v1/push/register-device').set(mobileHeaders(mobileToken)).send({ token });
      expect(res.status).toBe(200);
      expect(res.body.item.isActive).toBe(true);
    });

    it('re-registering the same token upserts rather than duplicating', async () => {
      const res = await request(app).post('/api/mobile/v1/push/register-device').set(mobileHeaders(mobileToken)).send({ token });
      expect(res.status).toBe(200);
      const count = await prisma.deviceToken.count({ where: { tenantId: tenant.tenantId, token } });
      expect(count).toBe(1);
    });

    it('unregisters a device', async () => {
      const res = await request(app).post('/api/mobile/v1/push/unregister-device').set(mobileHeaders(mobileToken)).send({ token });
      expect(res.status).toBe(200);
      const row = await prisma.deviceToken.findFirst({ where: { tenantId: tenant.tenantId, token } });
      expect(row.isActive).toBe(false);
    });
  });

  describe('alert push dispatch + duplicate suppression', () => {
    let pushTenant;
    let pushMobileToken;
    const deviceToken = `push-dispatch-token-${Date.now()}`;

    beforeAll(async () => {
      pushTenant = await registerTenantWithCreds(`Push Dispatch Tenant ${Date.now()}`);
      pushMobileToken = await mobileLogin(pushTenant.email, pushTenant.password);
      await post(pushMobileToken, '/api/mobile/v1/push/register-device', { token: deviceToken });

      await post(pushTenant.webToken, '/api/products', {
        name: 'Another Critically Low Widget',
        purchasePrice: 5,
        sellingPrice: 10,
        openingStock: 1,
        lowStockThreshold: 20,
      });
      await refreshInsights(pushTenant.webToken);
    });

    it('sends a push for a newly-detected condition', async () => {
      const result = await runScheduled(pushTenant.webToken);
      expect(result.alertPush.usersConsidered).toBe(1);
      expect(result.alertPush.sent).toBeGreaterThan(0);
    });

    it('does not re-send for the same unresolved condition on a second run', async () => {
      const result = await runScheduled(pushTenant.webToken);
      expect(result.alertPush.sent).toBe(0);
    });

    it('respects minimumPriority: CRITICAL_ONLY suppresses an IMPORTANT-priority push', async () => {
      // Force a fresh notify cycle by clearing notifiedAt on the existing insight.
      await prisma.aiInsight.updateMany({ where: { tenantId: pushTenant.tenantId }, data: { notifiedAt: null, notifiedSeverity: null } });
      await prisma.userNotificationPreference.updateMany({ where: { tenantId: pushTenant.tenantId }, data: { minimumPriority: 'CRITICAL_ONLY' } });

      const insight = await prisma.aiInsight.findFirst({ where: { tenantId: pushTenant.tenantId, category: 'inventory' } });
      // ATTENTION (not URGENT) maps to IMPORTANT, below CRITICAL_ONLY's bar.
      if (insight.severity === 'URGENT') {
        await prisma.aiInsight.update({ where: { id: insight.id }, data: { severity: 'ATTENTION' } });
      }

      const result = await runScheduled(pushTenant.webToken);
      expect(result.alertPush.sent).toBe(0);
    });

    it('disabling a category suppresses its push even at ALL priority', async () => {
      await prisma.aiInsight.updateMany({ where: { tenantId: pushTenant.tenantId }, data: { notifiedAt: null, notifiedSeverity: null } });
      await prisma.userNotificationPreference.updateMany({
        where: { tenantId: pushTenant.tenantId },
        data: { minimumPriority: 'ALL', inventoryAlertsEnabled: false },
      });

      const result = await runScheduled(pushTenant.webToken);
      expect(result.alertPush.sent).toBe(0);
    });
  });

  describe('daily summary once-per-day enforcement', () => {
    it('sends once, then suppresses a second run the same day', async () => {
      const summaryTenant = await registerTenantWithCreds(`Daily Summary Tenant ${Date.now()}`);
      const summaryMobileToken = await mobileLogin(summaryTenant.email, summaryTenant.password);
      const deviceToken = `daily-summary-token-${Date.now()}`;
      await post(summaryMobileToken, '/api/mobile/v1/push/register-device', { token: deviceToken });

      const currentUtcHour = new Date().getUTCHours();
      await prisma.userNotificationPreference.upsert({
        where: { userId: summaryTenant.userId },
        create: { tenantId: summaryTenant.tenantId, userId: summaryTenant.userId, dailySummaryTime: String(currentUtcHour).padStart(2, '0') + ':00' },
        update: { dailySummaryTime: String(currentUtcHour).padStart(2, '0') + ':00', dailySummaryEnabled: true, lastDailySummarySentAt: null },
      });

      const first = await runScheduled(summaryTenant.webToken);
      expect(first.dailySummary.sent).toBe(1);

      const second = await runScheduled(summaryTenant.webToken);
      expect(second.dailySummary.sent).toBe(0);
    });
  });
});
