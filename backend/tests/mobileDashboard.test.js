// Integration tests for the Owner Mobile executive dashboard
// (/api/mobile/v1/dashboard/*) added in Phase 2 - KPI correctness, RBAC,
// tenant isolation, and read-only enforcement.
//
// Needs DATABASE_URL pointed at a real, throwaway Postgres database with
// migrations applied (see README "Testing"). Every tenant/user/sale here is
// freshly created inside this file. One sale's createdAt is deliberately
// backdated via a direct Prisma update (a real, validly-created sale - only
// its timestamp is adjusted) to deterministically exercise the receivables
// aging-bucket boundaries, which cannot otherwise be tested without waiting
// 45 real days.
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
  return { webToken: res.body.token, tenantId: res.body.tenant.id, email, password };
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

function dashboardGet(mobileToken, path, query = {}) {
  return request(app).get(`/api/mobile/v1/dashboard${path}`).set('Authorization', `Bearer ${mobileToken}`).query(query);
}

describe('Owner Mobile dashboard (/api/mobile/v1/dashboard)', () => {
  let tenantA;
  let mobileTokenA;
  let branchMainId;
  let branch2Id;
  let category1Id;
  let category2Id;
  let customerId;

  beforeAll(async () => {
    tenantA = await registerTenantWithCreds(`Mobile Dashboard Tenant A ${Date.now()}`);
    mobileTokenA = await mobileLogin(tenantA.email, tenantA.password);

    const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.webToken}`);
    branchMainId = branches.body.items[0].id;

    const branch2 = await post(tenantA.webToken, '/api/branches', { name: 'Branch Two' });
    branch2Id = branch2.item.id;

    const cat1 = await post(tenantA.webToken, '/api/categories', { name: `Category One ${Date.now()}` });
    category1Id = cat1.item.id;
    const cat2 = await post(tenantA.webToken, '/api/categories', { name: `Category Two ${Date.now()}` });
    category2Id = cat2.item.id;

    const customer = await post(tenantA.webToken, '/api/customers', { name: 'Test Debtor' });
    customerId = customer.item.id;

    // Inventory fixtures: product1 -> low stock, product2 -> out of stock,
    // product3/product4 -> sold in the sales fixtures below.
    const product1 = await post(tenantA.webToken, '/api/products', {
      categoryId: category1Id, name: 'Low Stock Widget', purchasePrice: 50, sellingPrice: 80, openingStock: 3, lowStockThreshold: 5,
    });
    const product2 = await post(tenantA.webToken, '/api/products', {
      categoryId: category2Id, name: 'Out Of Stock Frame', type: 'FRAME', purchasePrice: 100, sellingPrice: 150, openingStock: 0, lowStockThreshold: 5,
    });
    const product3 = await post(tenantA.webToken, '/api/products', {
      categoryId: category1Id, name: 'Sold Product Cat1', purchasePrice: 20, sellingPrice: 100, openingStock: 50, lowStockThreshold: 5,
    });
    const product4 = await post(tenantA.webToken, '/api/products', {
      categoryId: category2Id, name: 'Sold Product Cat2', purchasePrice: 10, sellingPrice: 30, openingStock: 50, lowStockThreshold: 5,
    });

    // Expenses: 500 + 200 = 700 today/this-month, no prior-period expenses.
    const rentCategory = await post(tenantA.webToken, '/api/expense-categories', { name: `Rent ${Date.now()}` });
    const utilitiesCategory = await post(tenantA.webToken, '/api/expense-categories', { name: `Utilities ${Date.now()}` });
    await post(tenantA.webToken, '/api/expenses', { categoryId: rentCategory.item.id, amount: 500 });
    await post(tenantA.webToken, '/api/expenses', { categoryId: utilitiesCategory.item.id, amount: 200 });

    // Sale 1: Main branch, cash, fully paid, category1 product -> revenue 200, cogs 40.
    await post(tenantA.webToken, '/api/sales', {
      branchId: branchMainId,
      items: [{ productId: product3.item.id, quantity: 2, unitPrice: 100 }],
      paymentMethod: 'cash',
      amountPaid: 200,
    });

    // Sale 2: Branch Two, card, PARTIAL (50 of 100 paid) -> receivable 50, age 0 days (bucket 0-30).
    await post(tenantA.webToken, '/api/sales', {
      customerId,
      branchId: branch2Id,
      items: [{ productId: product3.item.id, quantity: 1, unitPrice: 100 }],
      paymentMethod: 'card',
      amountPaid: 50,
    });

    // Sale 3: fully UNPAID, backdated 45 days -> receivable 100, age 45 days (bucket 31-60), excluded from today/week/month.
    const sale3 = await post(tenantA.webToken, '/api/sales', {
      customerId,
      branchId: branchMainId,
      items: [{ productId: product3.item.id, quantity: 1, unitPrice: 100 }],
      paymentMethod: 'cash',
      amountPaid: 0,
    });
    const fortyFiveDaysAgo = new Date();
    fortyFiveDaysAgo.setDate(fortyFiveDaysAgo.getDate() - 45);
    await prisma.sale.update({ where: { id: sale3.item.id }, data: { createdAt: fortyFiveDaysAgo } });

    // Sale 4: Main branch, cash, fully paid, category2 product -> revenue 150, cogs 50.
    await post(tenantA.webToken, '/api/sales', {
      branchId: branchMainId,
      items: [{ productId: product4.item.id, quantity: 5, unitPrice: 30 }],
      paymentMethod: 'cash',
      amountPaid: 150,
    });
  });

  describe('read-only + auth enforcement (shared across every dashboard route)', () => {
    it('rejects requests with no token', async () => {
      const res = await request(app).get('/api/mobile/v1/dashboard/summary');
      expect(res.status).toBe(401);
    });

    it('rejects a staff web token', async () => {
      const res = await dashboardGet(tenantA.webToken, '/summary');
      expect(res.status).toBe(401);
    });

    it('rejects a write attempt even with a valid mobile token', async () => {
      const res = await request(app).post('/api/mobile/v1/dashboard/summary').set('Authorization', `Bearer ${mobileTokenA}`);
      expect(res.status).toBe(403);
    });

    it('rejects filters referencing another tenant\'s branch/category', async () => {
      const res = await dashboardGet(mobileTokenA, '/summary', { branchId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(422);
    });
  });

  describe('GET /summary', () => {
    it('reports today\'s sales, profit, expenses, receivables, orders, and inventory KPIs', async () => {
      const res = await dashboardGet(mobileTokenA, '/summary');
      expect(res.status).toBe(200);
      const body = res.body;

      expect(body.sales.today.total).toBeCloseTo(450, 2);
      expect(body.sales.today.count).toBe(3);
      expect(body.sales.today.changePercent).toBeNull();

      expect(body.orders.today.transactionCount).toBe(3);
      expect(body.orders.today.averageTransactionValue).toBeCloseTo(150, 2);

      expect(body.profit.grossProfit).toBeCloseTo(340, 2);
      expect(body.profit.netProfit).toBeCloseTo(-360, 2);
      expect(body.profit.grossMarginPercent).toBeCloseTo((340 / 450) * 100, 2);

      expect(body.expenses.month.total).toBeCloseTo(700, 2);

      expect(body.receivables.totalOutstanding).toBeCloseTo(150, 2);
      expect(body.receivables.overdueAmount).toBeCloseTo(100, 2);
      expect(body.receivables.recentCollections).toBeCloseTo(50, 2);

      expect(body.inventory.inventoryValue).toBeCloseTo(150 + 0 + 46 * 20 + 45 * 10, 2);
      expect(body.inventory.lowStockCount).toBe(1);
      expect(body.inventory.outOfStockCount).toBe(1);
    });

    it('is consistent between /summary and the dedicated /profit and /expenses endpoints (this month)', async () => {
      const [summary, profit, expenses] = await Promise.all([
        dashboardGet(mobileTokenA, '/summary'),
        dashboardGet(mobileTokenA, '/profit', { range: 'month' }),
        dashboardGet(mobileTokenA, '/expenses'),
      ]);
      expect(summary.body.profit.netProfit).toBeCloseTo(profit.body.current.netProfit, 2);
      expect(summary.body.expenses.month.total).toBeCloseTo(expenses.body.month.total, 2);
    });
  });

  describe('GET /sales', () => {
    it('breaks sales down by branch, category, and payment method for today', async () => {
      const res = await dashboardGet(mobileTokenA, '/sales', { range: 'today' });
      expect(res.status).toBe(200);
      const body = res.body;

      expect(body.totals.revenue).toBeCloseTo(450, 2);
      expect(body.totals.saleCount).toBe(3);
      expect(body.comparison.changePercent).toBeNull();

      const byBranch = Object.fromEntries(body.byBranch.map((b) => [b.branchId, b.total]));
      expect(byBranch[branchMainId]).toBeCloseTo(350, 2);
      expect(byBranch[branch2Id]).toBeCloseTo(100, 2);

      const byMethod = Object.fromEntries(body.byPaymentMethod.map((m) => [m.method, m.total]));
      expect(byMethod.cash).toBeCloseTo(350, 2);
      expect(byMethod.card).toBeCloseTo(100, 2);

      const byCategory = Object.fromEntries(body.byCategory.map((c) => [c.categoryId, c.total]));
      expect(byCategory[category1Id]).toBeCloseTo(300, 2);
      expect(byCategory[category2Id]).toBeCloseTo(150, 2);
    });

    it('filters by branch', async () => {
      const res = await dashboardGet(mobileTokenA, '/sales', { range: 'today', branchId: branch2Id });
      expect(res.status).toBe(200);
      expect(res.body.totals.revenue).toBeCloseTo(100, 2);
    });
  });

  describe('GET /receivables', () => {
    it('buckets outstanding receivables by age and lists top debtors', async () => {
      const res = await dashboardGet(mobileTokenA, '/receivables');
      expect(res.status).toBe(200);
      const body = res.body;

      expect(body.agingBuckets['0-30']).toBeCloseTo(50, 2);
      expect(body.agingBuckets['31-60']).toBeCloseTo(100, 2);
      expect(body.agingBuckets['61-90']).toBeCloseTo(0, 2);
      expect(body.agingBuckets['90+']).toBeCloseTo(0, 2);
      expect(body.totalOutstanding).toBeCloseTo(150, 2);

      const debtor = body.topDebtors.find((d) => d.customerId === customerId);
      expect(debtor.amountDue).toBeCloseTo(150, 2);

      const todayKey = new Date().toISOString().slice(0, 10);
      const todaysCollections = body.collectionsTrend.find((t) => t.date === todayKey);
      expect(todaysCollections.total).toBeCloseTo(50, 2);
    });
  });

  describe('GET /inventory', () => {
    it('reports low-stock and out-of-stock counts distinctly', async () => {
      const res = await dashboardGet(mobileTokenA, '/inventory');
      expect(res.status).toBe(200);
      expect(res.body.lowStockCount).toBe(1);
      expect(res.body.outOfStockCount).toBe(1);
      expect(res.body.recentMovements.length).toBeGreaterThan(0);
    });
  });

  describe('GET /filters', () => {
    it('lists this tenant\'s branches and categories plus the static business areas', async () => {
      const res = await dashboardGet(mobileTokenA, '/filters');
      expect(res.status).toBe(200);
      const branchIds = res.body.branches.map((b) => b.id);
      expect(branchIds).toEqual(expect.arrayContaining([branchMainId, branch2Id]));
      const categoryIds = res.body.categories.map((c) => c.id);
      expect(categoryIds).toEqual(expect.arrayContaining([category1Id, category2Id]));
      expect(res.body.businessAreas).toEqual(['GENERAL', 'MEDICINE', 'FRAME', 'LENS']);
    });
  });

  describe('tenant isolation', () => {
    it('a second tenant sees none of tenant A\'s sales/expenses/receivables', async () => {
      const tenantB = await registerTenantWithCreds(`Mobile Dashboard Tenant B ${Date.now()}`);
      const mobileTokenB = await mobileLogin(tenantB.email, tenantB.password);

      const res = await dashboardGet(mobileTokenB, '/summary');
      expect(res.status).toBe(200);
      expect(res.body.sales.today.total).toBe(0);
      expect(res.body.receivables.totalOutstanding).toBe(0);
      expect(res.body.inventory.inventoryValue).toBe(0);
    });
  });
});
