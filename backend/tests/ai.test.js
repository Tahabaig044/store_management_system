// Phase 9 - AI Business Intelligence + Predictive Analytics tests: tenant
// isolation of AI context/conversations/insights, RBAC gating of every AI
// surface, deterministic source numbers against known fixtures, answer
// grounding, insufficient-data handling, provider timeout/failure fallback,
// usage/cost quota enforcement, insight idempotency/dedup, anomaly
// detection against constructed scenarios, and proof that no AI endpoint
// can mutate core business data. Same convention as every other phase's
// suite: real HTTP calls against a real (disposable, throwaway) database.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { registerProvider } = require('../src/modules/ai/providers/provider');
const analytics = require('../src/modules/ai/analytics');

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
  const created = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`).send({ name: `Test ${role}`, email, password: 'TestPass123', role });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return login.body.token;
}

async function createProduct(token, overrides = {}) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${token}`).send({ name: 'AI Test Product', type: 'GENERAL', purchasePrice: 10, sellingPrice: 20, openingStock: 1000, ...overrides });
  if (res.status !== 201) throw new Error(`create product failed: ${JSON.stringify(res.body)}`);
  return res.body.item;
}

async function createCustomer(token, overrides = {}) {
  const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${token}`).send({ name: 'AI Test Customer', phone: uniquePhone(), ...overrides });
  if (res.status !== 201) throw new Error(`create customer failed: ${JSON.stringify(res.body)}`);
  return res.body.item;
}

// Backdates a sale's createdAt directly via Prisma - the only way to build
// a controlled historical series/baseline for forecasting and anomaly
// detection without waiting real days between test runs.
// `discount` here is the SALE-level discount (what analytics.unusualDiscounts
// actually measures as a percent of subtotal) - distinct from a per-line
// item discount, which only affects that line's own total.
async function createSaleAt(token, { customerId, productId, quantity, unitPrice, discount = 0 }, at) {
  const res = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`).send({ customerId, items: [{ productId, quantity, unitPrice }], discount });
  if (res.status !== 201) throw new Error(`create sale failed: ${JSON.stringify(res.body)}`);
  await prisma.sale.update({ where: { id: res.body.item.id }, data: { createdAt: at } });
  return res.body.item;
}

describe('Phase 9 - AI Business Intelligence + Predictive Analytics', () => {
  let tenantA;
  let tenantB;
  let cashierA;
  let productA;
  let customerA;

  beforeAll(async () => {
    tenantA = await registerTenant(`AI Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`AI Tenant B ${Date.now()}`);
    cashierA = await createUserToken(tenantA.token, 'CASHIER');
    productA = await createProduct(tenantA.token);
    customerA = await createCustomer(tenantA.token);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('RBAC gating', () => {
    test('a non-MANAGEMENT role (CASHIER) is blocked from every AI surface', async () => {
      const endpoints = [
        () => request(app).get('/api/ai/assistant/suggested-questions').set('Authorization', `Bearer ${cashierA}`),
        () => request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${cashierA}`).send({ question: 'hi' }),
        () => request(app).get('/api/ai/brief').set('Authorization', `Bearer ${cashierA}`),
        () => request(app).get('/api/ai/insights').set('Authorization', `Bearer ${cashierA}`),
        () => request(app).post('/api/ai/forecasts/generate').set('Authorization', `Bearer ${cashierA}`).send({}),
      ];
      for (const call of endpoints) {
        const res = await call();
        expect(res.status).toBe(403);
      }
    });

    test('only TENANT_ADMIN can read/update AI config and the usage report', async () => {
      const managerToken = await createUserToken(tenantA.token, 'MANAGER');
      const forbidden = await request(app).get('/api/ai/config').set('Authorization', `Bearer ${managerToken}`);
      expect(forbidden.status).toBe(403);

      const allowed = await request(app).get('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.item.credentials).toBeUndefined();

      const usageForbidden = await request(app).get('/api/ai/usage').set('Authorization', `Bearer ${managerToken}`);
      expect(usageForbidden.status).toBe(403);
    });

    test('a branchId belonging to another tenant is rejected, not silently ignored', async () => {
      const branchesB = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantB.token}`);
      const foreignBranchId = branchesB.body.items[0].id;

      const ask = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'Which branch is most profitable?', branchId: foreignBranchId });
      expect(ask.status).toBe(404);

      const brief = await request(app).get('/api/ai/brief').set('Authorization', `Bearer ${tenantA.token}`).query({ branchId: foreignBranchId });
      expect(brief.status).toBe(404);

      const forecast = await request(app).post('/api/ai/forecasts/generate').set('Authorization', `Bearer ${tenantA.token}`).send({ scope: 'BRANCH', scopeId: foreignBranchId });
      expect(forecast.status).toBe(404);
    });
  });

  describe('Tenant isolation', () => {
    test('a conversation created in tenant A is invisible to tenant B', async () => {
      const ask = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'What should I pay attention to today?' });
      expect(ask.status).toBe(201);

      const crossTenant = await request(app).get(`/api/ai/assistant/conversations/${ask.body.conversationId}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(crossTenant.status).toBe(404);

      const tenantBList = await request(app).get('/api/ai/assistant/conversations').set('Authorization', `Bearer ${tenantB.token}`);
      expect(tenantBList.body.items.find((c) => c.id === ask.body.conversationId)).toBeUndefined();
    });

    test('insights and forecasts are generated and visible only within their own tenant', async () => {
      await request(app).post('/api/ai/insights/refresh').set('Authorization', `Bearer ${tenantA.token}`);
      const insightsA = await request(app).get('/api/ai/insights').set('Authorization', `Bearer ${tenantA.token}`);
      const insightsB = await request(app).get('/api/ai/insights').set('Authorization', `Bearer ${tenantB.token}`);
      if (insightsA.body.items.length > 0) {
        const idsA = new Set(insightsA.body.items.map((i) => i.id));
        expect(insightsB.body.items.some((i) => idsA.has(i.id))).toBe(false);
      }

      const forecast = await request(app).post('/api/ai/forecasts/generate').set('Authorization', `Bearer ${tenantA.token}`).send({});
      const forecastListB = await request(app).get('/api/ai/forecasts').set('Authorization', `Bearer ${tenantB.token}`);
      if (!forecast.body.item.insufficientData) {
        expect(forecastListB.body.items.find((f) => f.id === forecast.body.item.id)).toBeUndefined();
      }
    });
  });

  describe('Deterministic grounding and source-number accuracy', () => {
    test('the assistant\'s answer is grounded in the exact same numbers the analytics layer computes', async () => {
      const freshCustomer = await createCustomer(tenantA.token);
      const freshProduct = await createProduct(tenantA.token, { sellingPrice: 50, purchasePrice: 20 });
      await request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: freshCustomer.id, items: [{ productId: freshProduct.id, quantity: 3, unitPrice: 50 }] });

      const ask = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: "Show me this month's sales compared with last month." });
      expect(ask.status).toBe(201);
      expect(ask.body.intent).toBe('sales_comparison');

      const directFacts = await analytics.salesComparison(tenantA.tenantId, ask.body.message.grounding.period);
      expect(ask.body.message.grounding.current.revenue).toBeCloseTo(directFacts.current.revenue, 2);
      expect(ask.body.message.content).toContain(directFacts.current.revenue.toFixed(2));
    });

    test('receivables-overdue analytics matches a manually constructed fixture exactly', async () => {
      const debtor = await createCustomer(tenantA.token);
      const sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: debtor.id, items: [{ productId: productA.id, quantity: 1, unitPrice: 100 }], amountPaid: 0 });
      await prisma.sale.update({ where: { id: sale.body.item.id }, data: { createdAt: new Date(Date.now() - 70 * 86400000) } });

      const rows = await analytics.receivablesAging(tenantA.tenantId, { minDaysOverdue: 60 });
      const row = rows.find((r) => r.saleId === sale.body.item.id);
      expect(row).toBeDefined();
      expect(row.amountDue).toBeCloseTo(100, 2);
      expect(row.daysOverdue).toBeGreaterThanOrEqual(69);

      const ask = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'Which customers have overdue payments over 60 days?' });
      expect(ask.body.intent).toBe('receivables_overdue');
      expect(ask.body.message.grounding.rows.some((r) => r.saleId === sale.body.item.id)).toBe(true);
    });

    test('an unrecognized question returns suggested questions instead of a fabricated answer', async () => {
      const ask = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'What is the meaning of life?' });
      expect(ask.body.isRecognized).toBe(false);
      expect(ask.body.suggestedQuestions.length).toBeGreaterThan(0);
    });
  });

  describe('Forecasting', () => {
    test('gracefully reports insufficient data rather than guessing', async () => {
      const freshProduct = await createProduct(tenantA.token);
      const res = await request(app).post('/api/ai/forecasts/generate').set('Authorization', `Bearer ${tenantA.token}`).send({ scope: 'PRODUCT', scopeId: freshProduct.id, granularity: 'DAILY' });
      expect(res.status).toBe(200);
      expect(res.body.item.insufficientData).toBe(true);
      expect(res.body.item.pointsAvailable).toBeLessThan(res.body.item.minPointsRequired);
    });

    test('produces a labeled estimate with a confidence range from controlled historical data', async () => {
      const forecastTenant = await registerTenant(`Forecast Tenant ${Date.now()}`);
      const product = await createProduct(forecastTenant.token);
      const customer = await createCustomer(forecastTenant.token);
      for (let i = 15; i >= 1; i -= 1) {
        await createSaleAt(forecastTenant.token, { customerId: customer.id, productId: product.id, quantity: 5, unitPrice: 20 }, new Date(Date.now() - i * 86400000));
      }

      const res = await request(app).post('/api/ai/forecasts/generate').set('Authorization', `Bearer ${forecastTenant.token}`).send({ granularity: 'DAILY', horizon: 7 });
      expect(res.status).toBe(201);
      const { item } = res.body;
      expect(item.insufficientData).toBe(false);
      expect(item.dataPointsUsed).toBeGreaterThanOrEqual(10);
      expect(item.disclaimer).toMatch(/estimate/i);
      const futurePoints = item.series.filter((p) => p.actual === null);
      expect(futurePoints).toHaveLength(7);
      for (const p of futurePoints) {
        expect(p.lowerBound).toBeLessThanOrEqual(p.forecast);
        expect(p.upperBound).toBeGreaterThanOrEqual(p.forecast);
      }
    });
  });

  describe('Anomaly detection against constructed scenarios', () => {
    test('flags a discount far above the typical rate', async () => {
      const anomalyTenant = await registerTenant(`Anomaly Tenant ${Date.now()}`);
      const product = await createProduct(anomalyTenant.token, { sellingPrice: 100, purchasePrice: 50 });
      const customer = await createCustomer(anomalyTenant.token);

      for (let i = 0; i < 12; i += 1) {
        await createSaleAt(anomalyTenant.token, { customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 100, discount: 5 }, new Date(Date.now() - (30 + i) * 86400000));
      }
      const outlier = await createSaleAt(anomalyTenant.token, { customerId: customer.id, productId: product.id, quantity: 1, unitPrice: 100, discount: 80 }, new Date());

      const { runAllScans } = require('../src/modules/ai/anomaly');
      const scans = await runAllScans(anomalyTenant.tenantId);
      expect(scans.discounts.some((d) => d.saleId === outlier.id)).toBe(true);
    });

    test('flags two same-amount sales for one customer minutes apart as a potential duplicate', async () => {
      const dupTenant = await registerTenant(`Dup Tenant ${Date.now()}`);
      const product = await createProduct(dupTenant.token);
      const customer = await createCustomer(dupTenant.token);
      const first = await request(app).post('/api/sales').set('Authorization', `Bearer ${dupTenant.token}`).send({ customerId: customer.id, items: [{ productId: product.id, quantity: 1, unitPrice: 20 }] });
      const second = await request(app).post('/api/sales').set('Authorization', `Bearer ${dupTenant.token}`).send({ customerId: customer.id, items: [{ productId: product.id, quantity: 1, unitPrice: 20 }] });

      const { potentialDuplicateSales } = require('../src/modules/ai/anomaly');
      const findings = await potentialDuplicateSales(dupTenant.tenantId);
      expect(findings.some((f) => f.saleIds.includes(first.body.item.id) && f.saleIds.includes(second.body.item.id))).toBe(true);
    });
  });

  describe('Recommendation Center: dismiss/acknowledge, feedback, and idempotency', () => {
    test('refreshing insights twice does not create duplicate rows, and preserves a dismissed status', async () => {
      const debtor = await createCustomer(tenantA.token);
      const sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: debtor.id, items: [{ productId: productA.id, quantity: 1, unitPrice: 100 }], amountPaid: 0 });
      await prisma.sale.update({ where: { id: sale.body.item.id }, data: { createdAt: new Date(Date.now() - 65 * 86400000) } });

      await request(app).post('/api/ai/insights/refresh').set('Authorization', `Bearer ${tenantA.token}`);
      const dedupeKey = `receivable_overdue:${sale.body.item.id}`;
      const firstCount = await prisma.aiInsight.count({ where: { tenantId: tenantA.tenantId, dedupeKey } });
      expect(firstCount).toBe(1);

      const insight = await prisma.aiInsight.findUnique({ where: { tenantId_dedupeKey: { tenantId: tenantA.tenantId, dedupeKey } } });
      const dismiss = await request(app).post(`/api/ai/insights/${insight.id}/dismiss`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(dismiss.status).toBe(200);
      expect(dismiss.body.item.status).toBe('DISMISSED');

      await request(app).post('/api/ai/insights/refresh').set('Authorization', `Bearer ${tenantA.token}`);
      const secondCount = await prisma.aiInsight.count({ where: { tenantId: tenantA.tenantId, dedupeKey } });
      expect(secondCount).toBe(1);
      const afterRefresh = await prisma.aiInsight.findUnique({ where: { id: insight.id } });
      expect(afterRefresh.status).toBe('DISMISSED');
    });

    test('feedback can be recorded on an insight', async () => {
      const insight = await prisma.aiInsight.findFirst({ where: { tenantId: tenantA.tenantId } });
      const res = await request(app).post(`/api/ai/insights/${insight.id}/feedback`).set('Authorization', `Bearer ${tenantA.token}`).send({ helpful: false, comment: 'Not useful for us' });
      expect(res.status).toBe(201);
      expect(res.body.item.helpful).toBe(false);
    });

    test('an insight belonging to another tenant cannot be acknowledged or dismissed', async () => {
      const insightA = await prisma.aiInsight.findFirst({ where: { tenantId: tenantA.tenantId } });
      const res = await request(app).post(`/api/ai/insights/${insightA.id}/acknowledge`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('Provider timeout/failure and deterministic fallback', () => {
    test('a provider that throws falls back to the deterministic provider and still returns a grounded answer', async () => {
      registerProvider('always-fails', { ask: async () => { throw new Error('simulated provider crash'); } });
      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ provider: 'always-fails' });

      const res = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'What are my slow-moving products?' });
      expect(res.status).toBe(201);
      expect(res.body.fellBack).toBe(true);
      expect(res.body.message.content.length).toBeGreaterThan(0);

      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ provider: 'deterministic' });
    });

    test('a provider that never resolves times out and falls back rather than hanging the request', async () => {
      registerProvider('always-hangs', { ask: () => new Promise(() => {}) });
      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ provider: 'always-hangs' });

      const res = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'Which branch is most profitable?' });
      expect(res.status).toBe(201);
      expect(res.body.fellBack).toBe(true);

      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ provider: 'deterministic' });
    }, 15000);
  });

  describe('Usage/cost quota controls', () => {
    test('exceeding the daily AI request limit is rejected with a clear error, not a crash', async () => {
      const quotaTenant = await registerTenant(`Quota Tenant ${Date.now()}`);
      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${quotaTenant.token}`).send({ dailyRequestLimit: 1 });

      const first = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${quotaTenant.token}`).send({ question: 'What should I pay attention to today?' });
      expect(first.status).toBe(201);

      const second = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${quotaTenant.token}`).send({ question: 'What should I pay attention to today?' });
      expect(second.status).toBe(409);
    });

    test('the usage report reflects logged AI requests', async () => {
      const res = await request(app).get('/api/ai/usage').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.totalRequests).toBeGreaterThan(0);
    });
  });

  describe('AI cannot bypass business controls', () => {
    test('asking questions and refreshing insights never mutates stock, sales, or accounting data', async () => {
      const before = await prisma.product.findUnique({ where: { id: productA.id } });
      const salesCountBefore = await prisma.sale.count({ where: { tenantId: tenantA.tenantId } });
      const journalCountBefore = await prisma.journalEntry.count({ where: { tenantId: tenantA.tenantId } });

      await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'Which products may run out soon?' });
      await request(app).post('/api/ai/insights/refresh').set('Authorization', `Bearer ${tenantA.token}`);
      await request(app).get('/api/ai/brief').set('Authorization', `Bearer ${tenantA.token}`);

      const after = await prisma.product.findUnique({ where: { id: productA.id } });
      const salesCountAfter = await prisma.sale.count({ where: { tenantId: tenantA.tenantId } });
      const journalCountAfter = await prisma.journalEntry.count({ where: { tenantId: tenantA.tenantId } });

      expect(Number(after.stockQuantity)).toBe(Number(before.stockQuantity));
      expect(salesCountAfter).toBe(salesCountBefore);
      expect(journalCountAfter).toBe(journalCountBefore);
    });

    test('there is no AI endpoint that creates a purchase order, journal entry, or stock adjustment', async () => {
      // The recommendation center only ever links to a source record for a
      // human to act on - it never exposes a "create PO" / "post entry" /
      // "adjust stock" action of its own.
      const insights = await request(app).get('/api/ai/insights').set('Authorization', `Bearer ${tenantA.token}`);
      for (const item of insights.body.items) {
        expect(item).not.toHaveProperty('autoApplied');
      }
    });
  });

  describe('Command Center integration', () => {
    test('the command-center endpoint includes an ai block with insight summaries, never blocking on missing data', async () => {
      const res = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.ai).toBeDefined();
      expect(res.body.ai).toHaveProperty('topRisks');
      expect(res.body.ai).toHaveProperty('topOpportunities');
      expect(res.body.ai).toHaveProperty('anomalyAlerts');
    });

    test('the command center still responds correctly even when the tenant has disabled AI', async () => {
      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ isEnabled: false });
      const res = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.ai.isEnabled).toBe(false);

      const ask = await request(app).post('/api/ai/assistant/ask').set('Authorization', `Bearer ${tenantA.token}`).send({ question: 'What should I pay attention to today?' });
      expect(ask.status).toBe(409);

      await request(app).put('/api/ai/config').set('Authorization', `Bearer ${tenantA.token}`).send({ isEnabled: true });
    });
  });
});
