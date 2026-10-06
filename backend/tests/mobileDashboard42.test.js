// Phase 4.2 - the owner dashboard's purchases, payables, cash & bank, company filter and important alerts, plus
// the accuracy bugs found while auditing the existing figures (reversed expenses, reversed payments, payables
// that were never received). Real HTTP against a real Postgres; every figure is compared with an independently
// computed number or with the web's own report.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const analytics = require('../src/modules/ai/analytics');

jest.setTimeout(120000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const D = '/api/mobile/v1/dashboard';

async function post(token, path, body) {
  const res = await request(app).post(path).set(auth(token)).send(body);
  if (res.status >= 400) throw new Error(`POST ${path}: ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('Phase 4.2 - owner dashboard', () => {
  let web;
  let tenantId;
  let mobile;
  let coA;
  let coB;
  let bA1;
  let bA2;
  let bB1;
  let customerId;
  let reversedExpenseId;
  const dash = (path, query = {}) => request(app).get(`${D}${path}`).set(auth(mobile)).query({ range: 'today', ...query });

  beforeAll(async () => {
    const email = `${uniq('owner')}@test.local`;
    const reg = await request(app).post('/api/auth/register-tenant').send({ businessName: uniq('Dash42'), adminName: 'Owner', email, password: 'TestPass123' });
    web = reg.body.token;
    tenantId = reg.body.tenant.id;
    mobile = (await request(app).post('/api/mobile/v1/auth/login').send({ email, password: 'TestPass123' })).body.token;

    coA = (await post(web, '/api/companies', { name: uniq('Alpha Co') })).item;
    coB = (await post(web, '/api/companies', { name: uniq('Beta Co') })).item;
    const mk = async (name, companyId) => (await post(web, '/api/branches', { name: uniq(name), companyId })).item;
    bA1 = await mk('A1', coA.id);
    bA2 = await mk('A2', coA.id);
    bB1 = await mk('B1', coB.id);

    const product = (await post(web, '/api/products', { name: uniq('Prod'), purchasePrice: 20, sellingPrice: 100, openingStock: 500 })).item;
    customerId = (await post(web, '/api/customers', { name: 'Debtor' })).item.id;
    const supplierId = (await post(web, '/api/suppliers', { name: 'Supplier One' })).item.id;

    // Sales today: A1 cash 200; A2 credit 100 (40 paid); B1 cash 100.
    await post(web, '/api/sales', { branchId: bA1.id, items: [{ productId: product.id, quantity: 2, unitPrice: 100 }], paymentMethod: 'cash', amountPaid: 200 });
    const sale2 = (await post(web, '/api/sales', { branchId: bA2.id, customerId, items: [{ productId: product.id, quantity: 1, unitPrice: 100 }], paymentMethod: 'card', amountPaid: 40 })).item;
    await post(web, '/api/sales', { branchId: bB1.id, items: [{ productId: product.id, quantity: 1, unitPrice: 100 }], paymentMethod: 'cash', amountPaid: 100 });

    // Purchases: A1 received 300 unpaid; B1 received 150 paid; a DRAFT of 500 that never arrived.
    await post(web, '/api/purchases', { supplierId, branchId: bA1.id, receiveImmediately: true, amountPaid: 0, items: [{ productId: product.id, quantity: 10, unitCost: 30 }] });
    await post(web, '/api/purchases', { supplierId, branchId: bB1.id, receiveImmediately: true, amountPaid: 150, paymentMethod: 'cash', items: [{ productId: product.id, quantity: 5, unitCost: 30 }] });
    await post(web, '/api/purchases', { supplierId, branchId: bA1.id, receiveImmediately: false, amountPaid: 0, items: [{ productId: product.id, quantity: 25, unitCost: 20 }] });

    // Expenses: 500 (A1), 200 (A1, then reversed), 100 (B1).
    const cat = (await post(web, '/api/expense-categories', { name: uniq('Rent') })).item.id;
    await post(web, '/api/expenses', { categoryId: cat, amount: 500, branchId: bA1.id });
    reversedExpenseId = (await post(web, '/api/expenses', { categoryId: cat, amount: 200, branchId: bA1.id })).item.id;
    await post(web, '/api/expenses', { categoryId: cat, amount: 100, branchId: bB1.id });
    await post(web, `/api/expenses/${reversedExpenseId}/reverse`, {});

    // Collections against the credit sale: 30 kept, 20 reversed.
    await post(web, '/api/payments', { direction: 'IN', customerId, amount: 30, allocations: [{ saleId: sale2.id, amount: 30 }] });
    const p2 = (await post(web, '/api/payments', { direction: 'IN', customerId, amount: 20, allocations: [{ saleId: sale2.id, amount: 20 }] })).item;
    await post(web, `/api/payments/${p2.id}/reverse`, {});
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('accuracy: a reversed expense is not an expense - summary, expenses and profit all agree', async () => {
    const summary = (await dash('/summary', { range: 'month' })).body;
    expect(summary.expenses.month.total).toBe(600); // 500 + 100; the reversed 200 is out
    const exp = (await dash('/expenses')).body;
    expect(exp.today.total).toBe(600);
    expect(exp.byCategory.reduce((s, c) => s + c.total, 0)).toBe(600);
    const profit = (await dash('/profit')).body;
    expect(profit.current.expenses).toBe(600);
    expect(profit.current.netProfit).toBe(profit.current.grossProfit - 600);
  });

  it('accuracy: collections count completed payments only (the reversed 20 is not collected)', async () => {
    const rec = (await dash('/receivables')).body;
    // 40 taken at the sale + 30 collected later = 70; the reversed 20 is not collected
    expect(rec.recentCollections).toBe(70);
    expect(rec.collectionsTrend.reduce((s, d) => s + d.total, 0)).toBe(70);
    expect(rec.totalOutstanding).toBe(30); // 100 - 40 - 30: the reversal gave the 20 back to the invoice
    // ...and the branch filter now applies to collections as it always did to the invoices
    expect((await dash('/receivables', { branchId: bA1.id })).body.recentCollections).toBe(0);
  });

  it('accuracy: payables are purchases actually received - a draft that never arrived owes nothing (mobile and AI analytics agree)', async () => {
    const p = (await dash('/purchases')).body;
    expect(p.payables.totalOutstanding).toBe(300);
    expect(p.payables.agingBuckets['0-30']).toBe(300);
    expect(p.payables.topCreditors).toEqual([expect.objectContaining({ supplierName: 'Supplier One', amountDue: 300 })]);
    const ai = await analytics.payablesSummary(tenantId, {});
    expect(ai.reduce((s, r) => s + r.amountDue, 0)).toBe(300);
  });

  it('purchases: totals, count, top suppliers and the comparison with the previous period', async () => {
    const p = (await dash('/purchases')).body;
    expect(p.totals).toEqual({ total: 450, count: 2 });
    expect(p.topSuppliers[0]).toMatchObject({ supplierName: 'Supplier One', total: 450, count: 2 });
    expect(p.trend.reduce((s, d) => s + d.total, 0)).toBe(450);
    expect(p.previous.total).toBe(0);
    expect(p.changePercent).toBeNull(); // nothing to compare with - no invented percentage
    const s = (await dash('/summary')).body;
    expect(s.purchases.today).toEqual({ total: 450, count: 2 });
    expect(s.payables).toEqual({ totalOutstanding: 300, overdueAmount: 0 });
  });

  it('company and branch filters narrow every figure to that scope, and only that scope', async () => {
    const a = (await dash('/summary', { companyId: coA.id })).body;
    const b = (await dash('/summary', { companyId: coB.id })).body;
    expect(a.sales.today.total).toBe(300);
    expect(b.sales.today.total).toBe(100);
    expect(a.purchases.today.total).toBe(300);
    expect(b.purchases.today.total).toBe(150);
    expect(a.expenses.today.total).toBe(500);
    expect(b.expenses.today.total).toBe(100);
    expect(a.payables.totalOutstanding).toBe(300);
    expect(b.payables.totalOutstanding).toBe(0);
    expect(a.receivables.totalOutstanding).toBe(30); // the credit sale: 100 - 40 at the sale - 30 collected
    // one branch of a company, and a branch outside the chosen company (nothing - never widened)
    expect((await dash('/summary', { companyId: coA.id, branchId: bA2.id })).body.sales.today.total).toBe(100);
    expect((await dash('/summary', { companyId: coA.id, branchId: bB1.id })).body.sales.today.total).toBe(0);
    // the whole business = the two companies together
    const all = (await dash('/summary')).body;
    expect(all.sales.today.total).toBe(400);
    expect(all.purchases.today.total).toBe(450);
  });

  it('stock is honest about its scope: it is the whole business, and says so when a filter is active', async () => {
    const s = (await dash('/summary', { companyId: coA.id })).body;
    expect(s.inventory.scope).toBe('ALL_BRANCHES');
  });

  it('cash & bank come from the same ledger report the web uses: identical balances, per scope', async () => {
    const mobile = (await dash('/cash')).body;
    const now = new Date();
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    const web1 = (await request(app).get('/api/accounting/reports/cash-bank').set(auth(web)).query({ from: from.toISOString(), to: new Date(now.getTime() + 60000).toISOString() })).body;
    const webCash = web1.accounts.find((a) => a.key === 'CASH');
    expect(mobile.cash.closingBalance).toBe(webCash.closingBalance);
    expect(mobile.totals.closingBalance).toBe(web1.totals.closingBalance);
    // (this fixture spends more than it takes in, so the balance is negative - the point is that it is the books' number)
    expect(mobile.cash.receipts).toBeGreaterThan(0);
    expect(mobile.bySource.length).toBeGreaterThan(0);

    const summaryCash = (await dash('/summary')).body.cash;
    expect(summaryCash.total).toBe(mobile.totals.closingBalance);

    const byCompany = (await dash('/cash', { companyId: coB.id })).body;
    const webB = (await request(app).get('/api/accounting/reports/cash-bank').set(auth(web)).query({ from: from.toISOString(), to: new Date(now.getTime() + 60000).toISOString(), companyId: coB.id })).body;
    expect(byCompany.totals.closingBalance).toBe(webB.totals.closingBalance);
  });

  it('rejected scopes: a company of another shop is refused; the permission and read-only rules still hold', async () => {
    const other = await request(app).post('/api/auth/register-tenant').send({ businessName: uniq('Elsewhere'), adminName: 'Other', email: `${uniq('o')}@test.local`, password: 'TestPass123' });
    const foreign = (await post(other.body.token, '/api/companies', { name: uniq('Far Co') })).item;
    expect((await dash('/summary', { companyId: foreign.id })).status).toBe(422);
    expect((await dash('/purchases', { companyId: foreign.id })).status).toBe(422);
    expect((await dash('/cash', { branchId: foreign.id })).status).toBe(422);
    expect((await request(app).post(`${D}/purchases`).set(auth(mobile)).send({})).status).toBe(403);
    expect((await request(app).get(`${D}/cash`)).status).toBe(401);
  });

  // Not a check: with DUMP_CONTRACT_DIR set, saves the REAL responses so the Android app's tests can parse exactly
  // what this server sends (see android/app/src/test/resources/contract).
  it('contract fixtures for the Android tests (only when DUMP_CONTRACT_DIR is set)', async () => {
    const dir = process.env.DUMP_CONTRACT_DIR;
    if (!dir) return;
    const fs = require('fs');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, path, query] of [['summary', '/summary', { range: 'month' }], ['purchases', '/purchases', {}], ['cash', '/cash', {}], ['filters', '/filters', {}]]) {
      fs.writeFileSync(`${dir}/dashboard-${name}.json`, JSON.stringify((await dash(path, query)).body, null, 2));
    }
  });

  it('important alerts: the list can be limited to critical + important, unread first-class', async () => {
    await prisma.aiInsight.createMany({
      data: [
        { tenantId, type: 'ALERT', category: 'inventory', severity: 'URGENT', title: 'Critical one', summary: 's', evidence: {}, status: 'NEW' },
        { tenantId, type: 'ALERT', category: 'expense_anomaly', severity: 'ATTENTION', title: 'Important one', summary: 's', evidence: {}, status: 'NEW' },
        { tenantId, type: 'ALERT', category: 'sales_decline', severity: 'INFORMATION', title: 'Just info', summary: 's', evidence: {}, status: 'NEW' },
      ],
    }).catch(() => null);
    const res = await request(app).get('/api/mobile/v1/alerts').set(auth(mobile)).query({ status: 'unread', important: 'true' });
    expect(res.status).toBe(200);
    const priorities = res.body.items.map((a) => a.priority);
    expect(priorities.every((p) => p === 'CRITICAL' || p === 'IMPORTANT')).toBe(true);
    const all = await request(app).get('/api/mobile/v1/alerts').set(auth(mobile)).query({ status: 'unread' });
    expect(all.body.total).toBeGreaterThanOrEqual(res.body.total);
  });
});
