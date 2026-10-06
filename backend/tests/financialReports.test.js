// Phase 2.3 - Financial Reporting & Reconciliation.
//
// Needs DATABASE_URL pointed at a real, throwaway Postgres database with all
// migrations applied and the permission catalog seeded. Ledger posting is covered
// by accounting.test.js / chartOfAccountsGeneralLedger.test.js (Phase 2.1) and the
// AR/AP subledger by receivablesPayables.test.js (Phase 2.2); this file covers the
// shared financial reporting service: statements with date/branch/company filters,
// cash & bank reporting, ledger-to-subledger reconciliation, dashboard KPIs, and the
// isolation / permission / concurrency behavior of all of it.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(90000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});
const R = '/api/accounting/reports';

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: `${uniq('a')}@test.local`, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}
async function userToken(adminToken, role, branchId) {
  const email = `${uniq(role.toLowerCase())}@test.local`;
  const created = await post(adminToken, '/api/users', { name: role, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`user create failed ${JSON.stringify(created.body)}`);
  return (await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' })).body.token;
}
const makeCustomer = async (t) => (await post(t, '/api/customers', { name: uniq('Cust') })).body.item.id;
const makeSupplier = async (t) => (await post(t, '/api/suppliers', { name: uniq('Supp') })).body.item.id;
async function makeProduct(t) {
  return (await post(t, '/api/products', { name: uniq('Prod'), sellingPrice: 10, purchasePrice: 5, openingStock: 100000 })).body.item.id;
}
async function makeSale(t, productId, customerId, total, amountPaid = 0, branchId) {
  const res = await post(t, '/api/sales', { customerId, branchId, items: [{ productId, quantity: total / 10, unitPrice: 10 }], paymentMethod: 'cash', amountPaid });
  if (res.status !== 201) throw new Error(`sale failed ${JSON.stringify(res.body)}`);
  return res.body.item;
}
async function makePurchase(t, productId, supplierId, total, branchId) {
  const res = await post(t, '/api/purchases', { supplierId, branchId, receiveImmediately: true, amountPaid: 0, items: [{ productId, quantity: total / 5, unitCost: 5 }] });
  if (res.status !== 201) throw new Error(`purchase failed ${JSON.stringify(res.body)}`);
  return res.body.item;
}
const line = (rows, code) => rows.find((r) => r.code === code);
const today = () => new Date().toISOString().slice(0, 10);

describe('Phase 2.3 - Financial Reporting & Reconciliation', () => {
  let T; // main tenant with known data
  let U; // second tenant
  let productId;
  let customerId;
  let mainBranch;
  let branch2;
  let company2;
  let sale2;

  beforeAll(async () => {
    T = await registerTenant(uniq('Fin Tenant'));
    U = await registerTenant(uniq('Fin Tenant Other'));
    productId = await makeProduct(T.token);
    customerId = await makeCustomer(T.token);
    mainBranch = (await get(T.token, '/api/branches')).body.items[0].id;
    company2 = (await post(T.token, '/api/companies', { name: uniq('Company Two') })).body.item.id;
    branch2 = (await post(T.token, '/api/branches', { name: uniq('Branch Two'), code: 'B2', companyId: company2 })).body.item.id;

    await makeSale(T.token, productId, customerId, 100, 100, mainBranch); // revenue 100, COGS 50, cash 100
    sale2 = await makeSale(T.token, productId, customerId, 200, 50, branch2); // revenue 200, COGS 100, cash 50, AR 150
    await makePurchase(T.token, productId, await makeSupplier(T.token), 100, mainBranch); // inventory 100, AP 100
    const cat = (await post(T.token, '/api/expense-categories', { name: uniq('Rent') })).body.item.id;
    const exp = await post(T.token, '/api/expenses', { categoryId: cat, amount: 30, branchId: mainBranch, method: 'cash' });
    if (exp.status !== 201) throw new Error(`expense failed ${JSON.stringify(exp.body)}`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  describe('Trial Balance', () => {
    it('balances, and a bare date as asOf means the END of that day (today\'s entries are included)', async () => {
      const dated = await get(T.token, `${R}/trial-balance`, { asOf: today() });
      const now = await get(T.token, `${R}/trial-balance`);
      expect(dated.status).toBe(200);
      expect(dated.body.balanced).toBe(true);
      expect(dated.body.totalDebit).toBe(now.body.totalDebit);
      expect(dated.body.totalDebit).toBeGreaterThan(0);
      const yesterday = await get(T.token, `${R}/trial-balance`, { asOf: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) });
      expect(yesterday.body.rows).toHaveLength(0);
    });

    it('the period view gives opening + movement = closing for every account', async () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const res = await get(T.token, `${R}/trial-balance`, { from: yesterday, asOf: today() });
      expect(res.body.rows.length).toBeGreaterThan(0);
      for (const r of res.body.rows) {
        expect(r.openingBalance + r.periodDebit - r.periodCredit).toBeCloseTo(r.closingBalance, 2);
      }
      expect(res.body.balanced).toBe(true);
    });

    it('branch and company filters partition the ledger: branches sum to the whole and each subset balances', async () => {
      const all = await get(T.token, `${R}/trial-balance`);
      const main = await get(T.token, `${R}/trial-balance`, { branchId: mainBranch });
      const b2 = await get(T.token, `${R}/trial-balance`, { branchId: branch2 });
      const co = await get(T.token, `${R}/trial-balance`, { companyId: company2 });
      expect(main.body.balanced).toBe(true);
      expect(b2.body.balanced).toBe(true);
      expect(co.body.totalDebit).toBe(b2.body.totalDebit);
      const cash = (b) => line(b.rows, '1010');
      expect(cash(main.body).debit + cash(b2.body).debit).toBeCloseTo(cash(all.body).debit, 2);
    });
  });

  // -------------------------------------------------------------------------
  describe('Profit & Loss', () => {
    it('is ledger-derived with gross profit, operating expense and net profit', async () => {
      const res = await get(T.token, `${R}/profit-loss`, { from: today(), to: today() });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ totalRevenue: 300, costOfGoodsSold: 150, grossProfit: 150, operatingExpense: 30, totalExpense: 180, netProfit: 120 });
    });

    it('filters by branch and by company; branch results add up to the tenant total', async () => {
      const main = await get(T.token, `${R}/profit-loss`, { from: today(), to: today(), branchId: mainBranch });
      const b2 = await get(T.token, `${R}/profit-loss`, { from: today(), to: today(), branchId: branch2 });
      const co = await get(T.token, `${R}/profit-loss`, { from: today(), to: today(), companyId: company2 });
      expect(main.body).toMatchObject({ totalRevenue: 100, costOfGoodsSold: 50, operatingExpense: 30, netProfit: 20 });
      expect(b2.body).toMatchObject({ totalRevenue: 200, costOfGoodsSold: 100, netProfit: 100 });
      expect(co.body.netProfit).toBe(b2.body.netProfit);
      expect(main.body.netProfit + b2.body.netProfit).toBe(120);
      const both = await get(T.token, `${R}/profit-loss`, { from: today(), to: today(), companyId: company2, branchId: mainBranch });
      expect(both.body.totalRevenue).toBe(0); // main is not in company two: filters intersect, never widen
    });

    it('a period with no activity is zero, and invalid or inverted ranges are rejected', async () => {
      const empty = await get(T.token, `${R}/profit-loss`, { from: '2001-01-01', to: '2001-12-31' });
      expect(empty.body).toMatchObject({ totalRevenue: 0, netProfit: 0 });
      expect((await get(T.token, `${R}/profit-loss`, { from: 'nope' })).status).toBe(422);
      expect((await get(T.token, `${R}/profit-loss`, { from: '2026-02-01', to: '2026-01-01' })).status).toBe(422);
    });
  });

  // -------------------------------------------------------------------------
  describe('Balance Sheet', () => {
    it('balances at tenant, branch and company level and agrees with the P&L', async () => {
      const all = await get(T.token, `${R}/balance-sheet`);
      expect(all.body.balanced).toBe(true);
      expect(all.body.totalAssets).toBeCloseTo(all.body.totalLiabilities + all.body.totalEquity, 2);
      const retained = all.body.equity.find((e) => e.code === null);
      expect(retained.amount).toBe(120);
      for (const filter of [{ branchId: mainBranch }, { branchId: branch2 }, { companyId: company2 }]) {
        expect((await get(T.token, `${R}/balance-sheet`, filter)).body.balanced).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('Cash & Bank', () => {
    it('reports opening, receipts, payments and closing per account, consistent with the balance sheet and KPIs', async () => {
      const res = await get(T.token, `${R}/cash-bank`, { from: today(), to: today() });
      expect(res.status).toBe(200);
      const cash = res.body.accounts.find((a) => a.key === 'CASH');
      expect(cash).toMatchObject({ openingBalance: 0, receipts: 150, payments: 30, closingBalance: 120 });
      expect(res.body.totals.closingBalance).toBe(res.body.totals.openingBalance + res.body.totals.receipts - res.body.totals.payments);
      const sheet = await get(T.token, `${R}/balance-sheet`);
      expect(line(sheet.body.assets, '1010').amount).toBe(cash.closingBalance);
      const k = await get(T.token, `${R}/kpis`, { from: today(), to: today() });
      expect(k.body.cashBalance).toBe(cash.closingBalance);
      expect(res.body.bySource).toMatchObject({ SALE: 150 });
    });

    it('the cash book running balance starts from the balance BEFORE the period', async () => {
      const W = await registerTenant(uniq('Cash Book'));
      const accounts = (await get(W.token, '/api/accounting/accounts')).body.items;
      const cashId = accounts.find((a) => a.systemKey === 'CASH').id;
      const equityId = accounts.find((a) => a.systemKey === 'OPENING_BALANCE_EQUITY').id;
      const old = new Date(Date.now() - 30 * 86400000).toISOString();
      const mk = (date, amount) => post(W.token, '/api/accounting/journal', { date, memo: 'seed', lines: [{ accountId: cashId, debit: amount }, { accountId: equityId, credit: amount }] });
      expect((await mk(old, 500)).status).toBe(201);
      expect((await mk(new Date().toISOString(), 40)).status).toBe(201);

      const from = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
      const book = await get(W.token, `${R}/cash-book`, { from, to: today() });
      expect(book.body.openingBalance).toBe(500);
      expect(book.body.rows).toHaveLength(1);
      expect(book.body.rows[0].runningBalance).toBe(540);
      expect(book.body.closingBalance).toBe(540);
      const cb = await get(W.token, `${R}/cash-bank`, { from, to: today() });
      expect(cb.body.totals).toMatchObject({ openingBalance: 500, receipts: 40, closingBalance: 540 });
      const flow = await get(W.token, `${R}/cash-flow`, { from, to: today() });
      expect(flow.body).toMatchObject({ openingBalance: 500, closingBalance: 540, netChange: 40 });
    });
  });

  // -------------------------------------------------------------------------
  describe('Reversals flow through every statement', () => {
    it('reversing a sale removes its revenue, COGS and cash from P&L / cash and keeps everything balanced and reconciled', async () => {
      const W = await registerTenant(uniq('Reversal'));
      const prod = await makeProduct(W.token);
      const cust = await makeCustomer(W.token);
      const sale = await makeSale(W.token, prod, cust, 100, 40);
      const before = await get(W.token, `${R}/profit-loss`, { from: today(), to: today() });
      expect(before.body.totalRevenue).toBe(100);

      expect((await post(W.token, `/api/sales/${sale.id}/reverse`)).status).toBe(200);
      const after = await get(W.token, `${R}/profit-loss`, { from: today(), to: today() });
      expect(after.body).toMatchObject({ totalRevenue: 0, costOfGoodsSold: 0, netProfit: 0 });
      expect((await get(W.token, `${R}/trial-balance`)).body.balanced).toBe(true);
      expect((await get(W.token, `${R}/balance-sheet`)).body.balanced).toBe(true);
      // The 40 the customer had paid stays in Cash and is owed back to them (Phase 2.4).
      const cb = await get(W.token, `${R}/cash-bank`, { from: today(), to: today() });
      expect(cb.body.totals.closingBalance).toBe(40);
      const rec = await get(W.token, `${R}/reconciliation`);
      expect(rec.body.allChecksPassed).toBe(true);
      expect(rec.body.receivables).toMatchObject({ ledgerBalance: -40, subledgerBalance: -40, unexplainedDifference: 0 });
    });
  });

  // -------------------------------------------------------------------------
  describe('Reconciliation', () => {
    it('standard flows reconcile: trial balance, no unbalanced entries, AR, AP and cash-to-payment-records', async () => {
      const res = await get(T.token, `${R}/reconciliation`);
      expect(res.status).toBe(200);
      expect(res.body.checks.map((c) => c.key)).toEqual(expect.arrayContaining(['TRIAL_BALANCE_BALANCED', 'NO_UNBALANCED_ENTRIES', 'RECEIVABLES_RECONCILED', 'PAYABLES_RECONCILED', 'CASH_RECONCILED']));
      expect(res.body.allChecksPassed).toBe(true);
      expect(res.body.receivables).toMatchObject({ ledgerBalance: 150, subledgerBalance: 150, difference: 0, unexplainedDifference: 0, reconciled: true });
      expect(res.body.payables).toMatchObject({ ledgerBalance: 100, subledgerBalance: 100, reconciled: true });
      expect(res.body.cash).toMatchObject({ available: true, ledgerBalance: 120, paymentRecordsNet: 120, residual: 0, reconciled: true });
    });

    it('a manual entry against a customer is an explained difference, and a payment on a reversed sale reconciles through its credit note', async () => {
      const W = await registerTenant(uniq('Rec Explained'));
      const prod = await makeProduct(W.token);
      const cust = await makeCustomer(W.token);
      const accounts = (await get(W.token, '/api/accounting/accounts')).body.items;
      const arId = accounts.find((a) => a.systemKey === 'ACCOUNTS_RECEIVABLE').id;
      const eqId = accounts.find((a) => a.systemKey === 'OPENING_BALANCE_EQUITY').id;
      expect((await post(W.token, '/api/accounting/journal', { memo: 'legacy balance', lines: [{ accountId: arId, debit: 40, customerId: cust }, { accountId: eqId, credit: 40 }] })).status).toBe(201);

      const cust2 = await makeCustomer(W.token);
      const s = await makeSale(W.token, prod, cust2, 100);
      await post(W.token, `/api/sales/${s.id}/pay`, { amount: 30 });
      await post(W.token, `/api/sales/${s.id}/reverse`);

      const res = await get(W.token, `${R}/reconciliation`);
      const byReason = Object.fromEntries(res.body.receivables.partiesWithDifferences.map((p) => [p.partyId, p.reason]));
      expect(byReason[cust]).toBe('MANUAL_OR_OPENING_ENTRIES');
      // Since Phase 2.4 the 30 paid on the reversed sale is a credit note, so it matches the ledger exactly.
      expect(byReason[cust2]).toBeUndefined();
      expect(res.body.receivables).toMatchObject({ ledgerBalance: 10, subledgerBalance: -30, difference: 40, explainedDifference: 40, unexplainedDifference: 0, reconciled: true });
      expect(res.body.allChecksPassed).toBe(true);
    });

    it('ledger activity that no document explains is detected and flagged', async () => {
      const W = await registerTenant(uniq('Rec Unexplained'));
      const cust = await makeCustomer(W.token);
      const accounts = (await get(W.token, '/api/accounting/accounts')).body.items;
      const arId = accounts.find((a) => a.systemKey === 'ACCOUNTS_RECEIVABLE').id;
      const eqId = accounts.find((a) => a.systemKey === 'OPENING_BALANCE_EQUITY').id;
      // A posting that claims to come from a sale that does not exist (bypasses every
      // business flow on purpose - this is the drift the reconciliation must catch).
      const entry = await prisma.journalEntry.create({
        data: { tenantId: W.tenantId, entryNumber: uniq('JE-X'), date: new Date(), memo: 'orphan', sourceType: 'SALE', sourceId: '00000000-0000-4000-8000-000000000000', status: 'POSTED' },
      });
      await prisma.journalLine.createMany({ data: [{ journalEntryId: entry.id, accountId: arId, debit: 75, credit: 0, customerId: cust }, { journalEntryId: entry.id, accountId: eqId, debit: 0, credit: 75 }] });

      const res = await get(W.token, `${R}/reconciliation`);
      expect(res.body.receivables.reconciled).toBe(false);
      expect(res.body.receivables.unexplainedDifference).toBe(75);
      expect(res.body.receivables.partiesWithDifferences[0]).toMatchObject({ partyId: cust, reason: 'UNEXPLAINED', difference: 75 });
      expect(res.body.allChecksPassed).toBe(false);
    });

    it('an unbalanced entry (written around the API) is detected', async () => {
      const W = await registerTenant(uniq('Rec Unbalanced'));
      const accounts = (await get(W.token, '/api/accounting/accounts')).body.items;
      const cashId = accounts.find((a) => a.systemKey === 'CASH').id;
      const entry = await prisma.journalEntry.create({ data: { tenantId: W.tenantId, entryNumber: uniq('JE-U'), date: new Date(), memo: 'bad', sourceType: 'MANUAL', status: 'POSTED' } });
      await prisma.journalLine.create({ data: { journalEntryId: entry.id, accountId: cashId, debit: 10, credit: 0 } });
      const res = await get(W.token, `${R}/reconciliation`);
      const check = res.body.checks.find((c) => c.key === 'NO_UNBALANCED_ENTRIES');
      expect(check.ok).toBe(false);
      expect(res.body.checks.find((c) => c.key === 'TRIAL_BALANCE_BALANCED').ok).toBe(false);
      expect(res.body.allChecksPassed).toBe(false);
    });

    it('a branch-filtered reconciliation is scoped, and the cash-to-records check is honestly unavailable', async () => {
      const res = await get(T.token, `${R}/reconciliation`, { branchId: branch2 });
      expect(res.body.scoped).toBe(true);
      expect(res.body.receivables).toMatchObject({ ledgerBalance: 150, subledgerBalance: 150, reconciled: true });
      expect(res.body.payables).toMatchObject({ ledgerBalance: 0, subledgerBalance: 0 });
      expect(res.body.cash.available).toBe(false);
      const co = await get(T.token, `${R}/reconciliation`, { companyId: company2 });
      expect(co.body.receivables.ledgerBalance).toBe(150);
    });
  });

  // -------------------------------------------------------------------------
  describe('AR/AP aging honors branch and company filters', () => {
    it('narrows the documents to the requested branch / company', async () => {
      const all = await get(T.token, '/api/receivables/aging');
      const b2 = await get(T.token, '/api/receivables/aging', { branchId: branch2 });
      const main = await get(T.token, '/api/receivables/aging', { branchId: mainBranch });
      const co = await get(T.token, '/api/receivables/aging', { companyId: company2 });
      expect(all.body.total).toBe(150);
      expect(b2.body.total).toBe(150);
      expect(main.body.total).toBe(0);
      expect(co.body.total).toBe(150);
      expect((await get(T.token, '/api/receivables/summary', { branchId: mainBranch })).body.items).toHaveLength(0);
      expect((await get(T.token, '/api/payables/summary', { branchId: mainBranch })).body.totals.documentsDue).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  describe('Dashboard KPI integration', () => {
    it('the command-center exposes the same ledger KPIs, and cash/bank now honor the branch filter', async () => {
      const dash = await get(T.token, '/api/dashboard/command-center', { range: 'today' });
      expect(dash.status).toBe(200);
      const ledger = dash.body.accounting.ledger;
      expect(ledger).toMatchObject({ revenue: 300, costOfGoodsSold: 150, grossProfit: 150, netProfit: 120, cashBalance: 120, receivables: 150, payables: 100 });
      const k = await get(T.token, `${R}/kpis`, { from: today(), to: today() });
      expect(k.body).toMatchObject({ revenue: ledger.revenue, netProfit: ledger.netProfit, cashBalance: ledger.cashBalance, receivables: ledger.receivables, payables: ledger.payables });
      expect(dash.body.accounting.cashBalance).toBe(120);

      const b2 = await get(T.token, '/api/dashboard/command-center', { range: 'today', branchId: branch2 });
      expect(b2.body.accounting.cashBalance).toBe(50);
      expect(b2.body.accounting.ledger).toMatchObject({ revenue: 200, netProfit: 100 });
    });
  });

  // -------------------------------------------------------------------------
  describe('Tenant, branch and permission isolation', () => {
    it('another tenant sees none of this data and cannot use this tenant\'s branch or company ids', async () => {
      const tb = await get(U.token, `${R}/trial-balance`);
      expect(tb.body.rows).toHaveLength(0);
      expect((await get(U.token, `${R}/profit-loss`, { from: today(), to: today() })).body.totalRevenue).toBe(0);
      for (const path of ['profit-loss', 'balance-sheet', 'trial-balance', 'cash-bank', 'reconciliation', 'kpis']) {
        expect((await get(U.token, `${R}/${path}`, { branchId: mainBranch })).status).toBe(404);
        expect((await get(U.token, `${R}/${path}`, { companyId: company2 })).status).toBe(404);
      }
      expect((await get(U.token, '/api/receivables/aging', { branchId: mainBranch })).status).toBe(404);
    });

    it('a branch-restricted user sees only their branch and cannot request another', async () => {
      const cashier = await userToken(T.token, 'ACCOUNTANT', mainBranch);
      const own = await get(cashier, `${R}/profit-loss`, { from: today(), to: today() });
      expect(own.body).toMatchObject({ totalRevenue: 100, netProfit: 20 });
      expect((await get(cashier, `${R}/profit-loss`, { from: today(), to: today(), branchId: branch2 })).status).toBe(403);
      expect((await get(cashier, `${R}/trial-balance`, { branchId: branch2 })).status).toBe(403);
      const cross = await get(cashier, `${R}/profit-loss`, { from: today(), to: today(), companyId: company2 });
      expect(cross.body.totalRevenue).toBe(0); // narrows, never widens
      const rec = await get(cashier, `${R}/reconciliation`);
      expect(rec.body.scoped).toBe(true);
      expect(rec.body.receivables.ledgerBalance).toBe(0);
      expect((await get(cashier, '/api/receivables/aging', { branchId: branch2 })).status).toBe(403);
    });

    it('only finance roles can read the new reports', async () => {
      const doctor = await userToken(T.token, 'DOCTOR');
      const accountant = await userToken(T.token, 'ACCOUNTANT');
      for (const path of ['cash-bank', 'kpis', 'reconciliation', 'profit-loss', 'trial-balance', 'balance-sheet', 'cash-book']) {
        expect((await get(doctor, `${R}/${path}`)).status).toBe(403);
        expect((await get(accountant, `${R}/${path}`)).status).toBe(200);
      }
      expect((await request(app).get(`${R}/reconciliation`)).status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('Concurrent access', () => {
    it('reports run while sales are being posted stay internally consistent (snapshot reads)', async () => {
      const W = await registerTenant(uniq('Concurrent'));
      const prod = await makeProduct(W.token);
      const cust = await makeCustomer(W.token);
      // Raw requests (not makeSale): a sale that loses the known sale-number race (Phase 1.8 residual)
      // is acceptable here - this test is about what the READS see while writes are in flight.
      const writes = [1, 2, 3, 4, 5, 6].map((i) => post(W.token, '/api/sales', { customerId: cust, items: [{ productId: prod, quantity: i, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: i % 2 ? 10 * i : 0 }));
      const reads = [];
      for (let i = 0; i < 4; i += 1) {
        reads.push(get(W.token, `${R}/reconciliation`));
        reads.push(get(W.token, `${R}/trial-balance`));
        reads.push(get(W.token, `${R}/balance-sheet`));
        reads.push(get(W.token, `${R}/kpis`));
      }
      const results = await Promise.all([...writes, ...reads]);
      const responses = results.slice(writes.length);
      expect(responses.filter((r) => r.status !== 200)).toHaveLength(0);
      for (const r of responses) {
        if (r.body.checks) expect(r.body.allChecksPassed).toBe(true); // reconciliation snapshot
        else if ('balanced' in r.body) expect(r.body.balanced).toBe(true);
      }
      expect(results.slice(0, writes.length).filter((r) => r.status >= 500)).toHaveLength(0);
      const final = await get(W.token, `${R}/reconciliation`);
      expect(final.body.allChecksPassed).toBe(true);
      expect(final.body.receivables.ledgerBalance).toBe(final.body.receivables.subledgerBalance);
    });
  });

  // -------------------------------------------------------------------------
  describe('Existing behavior is unchanged', () => {
    it('legacy response shapes still hold and the general ledger accepts the new filters', async () => {
      const tb = await get(T.token, `${R}/trial-balance`);
      expect(Object.keys(tb.body)).toEqual(expect.arrayContaining(['asOf', 'rows', 'totalDebit', 'totalCredit', 'balanced']));
      const pl = await get(T.token, `${R}/profit-loss`);
      expect(Object.keys(pl.body)).toEqual(expect.arrayContaining(['revenueLines', 'expenseLines', 'totalRevenue', 'totalExpense', 'netProfit']));
      const bs = await get(T.token, `${R}/balance-sheet`);
      expect(Object.keys(bs.body)).toEqual(expect.arrayContaining(['assets', 'liabilities', 'equity', 'totalAssets', 'totalLiabilities', 'totalEquity', 'balanced']));
      const gl = await get(T.token, `${R}/general-ledger`, { from: today(), to: today(), branchId: branch2 });
      expect(gl.status).toBe(200);
      expect(gl.body.rows.length).toBeGreaterThan(0);
      expect((await get(T.token, `${R}/ar-aging`)).status).toBe(200);
      expect(sale2.id).toBeTruthy();
    });
  });
});
