// Integration tests for Phase 4's Owner Mobile AI Advisor
// (/api/mobile/v1/ai/*) - daily brief caching, the 6-type insight mapping,
// Needs Attention ranking, history, evidence presence, tenant isolation,
// and read-only enforcement.
//
// Needs DATABASE_URL pointed at a real, throwaway Postgres database with
// migrations applied (see README "Testing"). Every tenant/user/product/sale
// here is freshly created inside this file.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { getOrGenerateDailyBrief } = require('../src/modules/ai/dailyBrief');

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

function mobileHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}
function aiGet(token, path, query = {}) {
  return request(app).get(`/api/mobile/v1/ai${path}`).set(mobileHeaders(token)).query(query);
}

describe('Owner Mobile AI Advisor (/api/mobile/v1/ai) - Phase 4', () => {
  let tenant;
  let mobileToken;

  beforeAll(async () => {
    tenant = await registerTenantWithCreds(`AI Advisor Tenant ${Date.now()}`);
    mobileToken = await mobileLogin(tenant.email, tenant.password);

    const product = await post(tenant.webToken, '/api/products', {
      name: 'AI Advisor Test Widget', purchasePrice: 20, sellingPrice: 50, openingStock: 30, lowStockThreshold: 5,
    });
    await post(tenant.webToken, '/api/sales', {
      items: [{ productId: product.item.id, quantity: 2, unitPrice: 50 }],
      paymentMethod: 'cash',
      amountPaid: 100,
    });
  });

  describe('read-only + auth enforcement', () => {
    it('rejects requests with no token', async () => {
      const res = await request(app).get('/api/mobile/v1/ai/home');
      expect(res.status).toBe(401);
    });

    it('rejects a staff web token', async () => {
      const res = await aiGet(tenant.webToken, '/home');
      expect(res.status).toBe(401);
    });

    it('rejects a write attempt on any AI advisor route', async () => {
      const res = await request(app).post('/api/mobile/v1/ai/briefing').set(mobileHeaders(mobileToken));
      expect(res.status).toBe(403);
    });
  });

  describe('GET /home', () => {
    it('returns daily advice, needs-attention, and counts, grounded in real data', async () => {
      const res = await aiGet(mobileToken, '/home');
      expect(res.status).toBe(200);
      expect(res.body.dailyAdvice.title).toBe("Today's Business Advice");
      expect(res.body.dailyAdvice.insightType).toBe('PERFORMANCE');
      expect(res.body.dailyAdvice.summary).toContain('100.00');
      expect(res.body.dailyAdvice.evidence.salesPerformance.current.revenue).toBeCloseTo(100, 2);
      expect(Array.isArray(res.body.needsAttention)).toBe(true);
      expect(typeof res.body.counts.total).toBe('number');
    });

    it('caches the daily advice - a second call the same day does not regenerate', async () => {
      // A fresh tenant, so this is genuinely the first-ever brief request
      // today (the outer `tenant` was already warmed by the previous test).
      const cacheTenant = await registerTenantWithCreds(`Cache Test Tenant ${Date.now()}`);
      const cacheMobileToken = await mobileLogin(cacheTenant.email, cacheTenant.password);

      const first = await aiGet(cacheMobileToken, '/home');
      const second = await aiGet(cacheMobileToken, '/home');
      expect(first.body.dailyAdvice.cached).toBe(false);
      expect(second.body.dailyAdvice.cached).toBe(true);
      expect(second.body.dailyAdvice.id).toBe(first.body.dailyAdvice.id);
    });
  });

  describe('GET /briefing', () => {
    it('matches the cached home daily advice by default', async () => {
      const home = await aiGet(mobileToken, '/home');
      const briefing = await aiGet(mobileToken, '/briefing');
      expect(briefing.body.item.id).toBe(home.body.dailyAdvice.id);
      expect(briefing.body.item.cached).toBe(true);
    });

    it('forceRegenerate bypasses the cache but keeps the same dedupe row', async () => {
      const before = await aiGet(mobileToken, '/briefing');
      const regenerated = await aiGet(mobileToken, '/briefing', { forceRegenerate: 'true' });
      expect(regenerated.body.item.cached).toBe(false);
      expect(regenerated.body.item.id).toBe(before.body.item.id);
    });

    it('rejects a branchId from another tenant', async () => {
      const res = await aiGet(mobileToken, '/briefing', { branchId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(422);
    });
  });

  describe('GET /needs-attention', () => {
    it('ranks items starting at 1, ordered by severity', async () => {
      const res = await aiGet(mobileToken, '/needs-attention');
      expect(res.status).toBe(200);
      if (res.body.items.length > 1) {
        expect(res.body.items[0].rank).toBe(1);
        expect(res.body.items[1].rank).toBe(2);
      }
      for (const item of res.body.items) {
        expect(['ANOMALY', 'RISK', 'OPPORTUNITY', 'RECOMMENDATION']).toContain(item.insightType);
      }
    });

    it('never includes the daily brief itself (PERFORMANCE is a summary, not an actionable item)', async () => {
      await aiGet(mobileToken, '/home');
      const res = await aiGet(mobileToken, '/needs-attention');
      expect(res.body.items.every((i) => i.insightType !== 'PERFORMANCE')).toBe(true);
    });
  });

  describe('GET /history', () => {
    it('includes the daily brief and supports filtering by insightType', async () => {
      await aiGet(mobileToken, '/home');
      const all = await aiGet(mobileToken, '/history');
      expect(all.body.items.some((i) => i.insightType === 'PERFORMANCE')).toBe(true);

      const performanceOnly = await aiGet(mobileToken, '/history', { insightType: 'PERFORMANCE' });
      expect(performanceOnly.body.items.every((i) => i.insightType === 'PERFORMANCE')).toBe(true);
    });
  });

  describe('GET /insights/:id', () => {
    it('returns full evidence for a real insight', async () => {
      const history = await aiGet(mobileToken, '/history');
      const id = history.body.items[0].id;
      const res = await aiGet(mobileToken, `/insights/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.item.id).toBe(id);
      expect(res.body.item.evidence).toBeTruthy();
    });

    it('404s for an unknown id', async () => {
      const res = await aiGet(mobileToken, '/insights/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  describe('reuses the Phase 3 Alert Center read/dismiss endpoints for AI insights', () => {
    it('dismissing an AI insight via /alerts/:id/dismiss is reflected in AI history, without touching business data', async () => {
      const history = await aiGet(mobileToken, '/history');
      const target = history.body.items.find((i) => !i.isDismissed);
      expect(target).toBeTruthy();

      const beforeProductCount = await prisma.product.count({ where: { tenantId: tenant.tenantId } });
      const dismissRes = await request(app).post(`/api/mobile/v1/alerts/${target.id}/dismiss`).set(mobileHeaders(mobileToken));
      expect(dismissRes.status).toBe(200);
      const afterProductCount = await prisma.product.count({ where: { tenantId: tenant.tenantId } });
      expect(afterProductCount).toBe(beforeProductCount);

      const historyAfter = await aiGet(mobileToken, '/history');
      const updated = historyAfter.body.items.find((i) => i.id === target.id);
      expect(updated.isDismissed).toBe(true);
    });
  });

  describe('tenant isolation', () => {
    it('a second tenant sees none of the first tenant\'s AI insights', async () => {
      const tenantB = await registerTenantWithCreds(`AI Advisor Tenant B ${Date.now()}`);
      const mobileTokenB = await mobileLogin(tenantB.email, tenantB.password);

      const home = await aiGet(mobileTokenB, '/home');
      expect(home.status).toBe(200);
      expect(home.body.dailyAdvice.evidence.salesPerformance.current.revenue).toBe(0);
      expect(home.body.needsAttention.every((i) => i.id !== undefined)).toBe(true);

      const history = await aiGet(mobileTokenB, '/history');
      const leaked = history.body.items.some((i) => i.evidence?.salesPerformance?.current?.revenue === 100);
      expect(leaked).toBe(false);
    });
  });

  describe('getOrGenerateDailyBrief (direct module test)', () => {
    it('generates a fresh brief for a tenant with no prior brief today', async () => {
      const fresh = await registerTenantWithCreds(`Fresh Brief Tenant ${Date.now()}`);
      const { insight, cached } = await getOrGenerateDailyBrief(fresh.tenantId, {});
      expect(cached).toBe(false);
      expect(insight.type).toBe('BRIEF');
      expect(insight.dedupeKey).toMatch(/^daily_brief:\d{4}-\d{2}-\d{2}$/);
    });
  });
});
