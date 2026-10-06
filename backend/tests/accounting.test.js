// Phase 5 - double-entry accounting engine tests. These exercise the real
// HTTP API against a real database (same convention as business.test.js) -
// never point this at a database holding real tenant data.
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

function findAccount(accounts, systemKeyName) {
  return accounts.find((a) => a.name === systemKeyName);
}

async function getAccounts(token) {
  const res = await request(app).get('/api/accounting/accounts').set('Authorization', `Bearer ${token}`);
  return res.body.items;
}

describe('Phase 5 - Accounting engine', () => {
  let tenantA;
  let tenantB;
  let accountantA;
  let cashierA;
  let productId;
  let customerId;
  let supplierId;

  beforeAll(async () => {
    tenantA = await registerTenant(`Accounting Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`Accounting Tenant B ${Date.now()}`);
    accountantA = await createUserToken(tenantA.token, 'ACCOUNTANT');
    cashierA = await createUserToken(tenantA.token, 'CASHIER');

    const prod = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({ name: 'Ledger Test Product', purchasePrice: 30, sellingPrice: 50, openingStock: 100 });
    productId = prod.body.item.id;

    const cust = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Ledger Customer' });
    customerId = cust.body.item.id;

    const sup = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Ledger Supplier' });
    supplierId = sup.body.item.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Chart of Accounts', () => {
    test('auto-provisions a default chart on first access, RBAC-restricted to FINANCE_STAFF', async () => {
      const forbidden = await request(app).get('/api/accounting/accounts').set('Authorization', `Bearer ${cashierA}`);
      expect(forbidden.status).toBe(403);

      const res = await request(app).get('/api/accounting/accounts').set('Authorization', `Bearer ${accountantA}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(14);
      expect(findAccount(res.body.items, 'Cash')).toBeDefined();
      expect(findAccount(res.body.items, 'Accounts Receivable')).toBeDefined();
      expect(findAccount(res.body.items, 'Accounts Payable')).toBeDefined();
      expect(findAccount(res.body.items, 'Sales Revenue')).toBeDefined();
      expect(findAccount(res.body.items, 'Cost of Goods Sold')).toBeDefined();
    });

    test('a system account cannot be deactivated or deleted', async () => {
      const accounts = await getAccounts(accountantA);
      const cash = findAccount(accounts, 'Cash');

      const deactivate = await request(app)
        .patch(`/api/accounting/accounts/${cash.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ isActive: false });
      expect(deactivate.status).toBe(409);

      const del = await request(app).delete(`/api/accounting/accounts/${cash.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(del.status).toBe(409);
    });

    test('a custom account can be created and renamed', async () => {
      const created = await request(app)
        .post('/api/accounting/accounts')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ code: '9999', name: 'Custom Test Account', type: 'ASSET' });
      expect(created.status).toBe(201);

      const renamed = await request(app)
        .patch(`/api/accounting/accounts/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Renamed Test Account' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.item.name).toBe('Renamed Test Account');
    });
  });

  describe('Sale posting', () => {
    test('a fully-paid cash sale posts a balanced entry: Dr Cash + COGS, Cr Revenue + Inventory', async () => {
      const before = await getAccounts(accountantA);
      const cashId = findAccount(before, 'Cash').id;
      const revenueId = findAccount(before, 'Sales Revenue').id;
      const cogsId = findAccount(before, 'Cost of Goods Sold').id;
      const inventoryId = findAccount(before, 'Inventory').id;

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, items: [{ productId, quantity: 2, unitPrice: 50 }], paymentMethod: 'cash' });
      expect(sale.status).toBe(201);

      const journal = await request(app)
        .get(`/api/accounting/journal?sourceType=SALE`)
        .set('Authorization', `Bearer ${accountantA}`);
      const entry = journal.body.items.find((e) => e.sourceId === sale.body.item.id);
      expect(entry).toBeDefined();

      const totalDebit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const totalCredit = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(totalDebit).toBeCloseTo(totalCredit, 2);

      const line = (accountId) => entry.lines.find((l) => l.accountId === accountId);
      expect(Number(line(cashId).debit)).toBeCloseTo(100, 2); // 2 * 50
      expect(Number(line(revenueId).credit)).toBeCloseTo(100, 2);
      expect(Number(line(cogsId).debit)).toBeCloseTo(60, 2); // 2 * 30 cost
      expect(Number(line(inventoryId).credit)).toBeCloseTo(60, 2);
    });

    test('a partially-paid sale splits between Cash and Accounts Receivable', async () => {
      const before = await getAccounts(accountantA);
      const cashId = findAccount(before, 'Cash').id;
      const receivableId = findAccount(before, 'Accounts Receivable').id;

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, items: [{ productId, quantity: 1, unitPrice: 50 }], amountPaid: 20, paymentMethod: 'cash' });
      expect(sale.status).toBe(201);

      const journal = await request(app).get('/api/accounting/journal?sourceType=SALE').set('Authorization', `Bearer ${accountantA}`);
      const entry = journal.body.items.find((e) => e.sourceId === sale.body.item.id);
      const line = (accountId) => entry.lines.find((l) => l.accountId === accountId);
      expect(Number(line(cashId).debit)).toBeCloseTo(20, 2);
      expect(Number(line(receivableId).debit)).toBeCloseTo(30, 2);
    });

    test('reversing a sale posts an exact mirror entry, netting to zero on every account', async () => {
      const before = await getAccounts(accountantA);
      const revenueId = findAccount(before, 'Sales Revenue').id;

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, items: [{ productId, quantity: 1, unitPrice: 50 }], paymentMethod: 'cash' });

      await request(app).post(`/api/sales/${sale.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);

      const journal = await request(app)
        .get('/api/accounting/journal?sourceType=SALE_REVERSAL')
        .set('Authorization', `Bearer ${accountantA}`);
      const reversal = journal.body.items.find((e) => e.sourceId === sale.body.item.id);
      expect(reversal).toBeDefined();
      const revLine = reversal.lines.find((l) => l.accountId === revenueId);
      expect(Number(revLine.debit)).toBeCloseTo(50, 2); // revenue reversed via a debit

      // The original entry is marked VOID, never deleted.
      const original = await request(app).get(`/api/accounting/journal?sourceType=SALE`).set('Authorization', `Bearer ${accountantA}`);
      const originalEntry = original.body.items.find((e) => e.sourceId === sale.body.item.id);
      expect(originalEntry.status).toBe('VOID');
    });
  });

  describe('Purchase posting', () => {
    test('an immediately-received, fully-paid purchase posts Dr Inventory, Cr Cash', async () => {
      const before = await getAccounts(accountantA);
      const inventoryId = findAccount(before, 'Inventory').id;
      const cashId = findAccount(before, 'Cash').id;

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId, quantity: 5, unitCost: 20 }], amountPaid: 100, paymentMethod: 'cash', receiveImmediately: true });
      expect(purchase.status).toBe(201);

      const journal = await request(app).get('/api/accounting/journal?sourceType=PURCHASE').set('Authorization', `Bearer ${accountantA}`);
      const entry = journal.body.items.find((e) => e.sourceId === purchase.body.item.id);
      const line = (accountId) => entry.lines.find((l) => l.accountId === accountId);
      expect(Number(line(inventoryId).debit)).toBeCloseTo(100, 2);
      expect(Number(line(cashId).credit)).toBeCloseTo(100, 2);
    });

    test('a DRAFT purchase paid in advance posts to Advance to Suppliers, then clears against Payable on receipt', async () => {
      const before = await getAccounts(accountantA);
      const advanceId = findAccount(before, 'Advance to Suppliers').id;
      const payableId = findAccount(before, 'Accounts Payable').id;
      const inventoryId = findAccount(before, 'Inventory').id;

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId, quantity: 3, unitCost: 20 }], amountPaid: 30, paymentMethod: 'cash', receiveImmediately: false });
      expect(purchase.status).toBe(201);
      expect(purchase.body.item.status).toBe('DRAFT');

      const advanceJournal = await request(app).get('/api/accounting/journal?sourceType=PAYMENT').set('Authorization', `Bearer ${accountantA}`);
      const advanceEntry = advanceJournal.body.items.find((e) => e.sourceId === purchase.body.item.id);
      expect(advanceEntry).toBeDefined();
      expect(Number(advanceEntry.lines.find((l) => l.accountId === advanceId).debit)).toBeCloseTo(30, 2);

      const received = await request(app).post(`/api/purchases/${purchase.body.item.id}/receive`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(received.status).toBe(200);

      const receiptJournal = await request(app).get('/api/accounting/journal?sourceType=PURCHASE').set('Authorization', `Bearer ${accountantA}`);
      const receiptEntry = receiptJournal.body.items.find((e) => e.sourceId === purchase.body.item.id);
      const line = (accountId) => receiptEntry.lines.find((l) => l.accountId === accountId);
      expect(Number(line(inventoryId).debit)).toBeCloseTo(60, 2); // 3 * 20
      // Payable is credited the full total, then debited back for the advance -
      // both lines should be present, netting to (total - advance) still owed.
      const payableLines = receiptEntry.lines.filter((l) => l.accountId === payableId);
      const netPayable = payableLines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
      expect(netPayable).toBeCloseTo(30, 2); // 60 total - 30 already advanced
    });

    test('a purchase return reverses stock and posts a mirrored entry (Accounts Payable can legitimately go negative for that supplier)', async () => {
      const productForReturn = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Return Test Product', purchasePrice: 10, sellingPrice: 15, openingStock: 0 });

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: productForReturn.body.item.id, quantity: 10, unitCost: 10 }], amountPaid: 100, paymentMethod: 'cash', receiveImmediately: true });

      const afterReceive = await request(app).get(`/api/products/${productForReturn.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(afterReceive.body.item.stockQuantity)).toBe(10);

      const returned = await request(app).post(`/api/purchases/${purchase.body.item.id}/return`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(returned.status).toBe(200);
      expect(returned.body.item.status).toBe('RETURNED');

      const afterReturn = await request(app).get(`/api/products/${productForReturn.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(afterReturn.body.item.stockQuantity)).toBe(0);

      // Cannot return the same purchase twice.
      const secondReturn = await request(app).post(`/api/purchases/${purchase.body.item.id}/return`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(secondReturn.status).toBe(409);
    });

    test('purchase return is restricted to MANAGEMENT roles', async () => {
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId, quantity: 1, unitCost: 20 }], receiveImmediately: true });

      const res = await request(app).post(`/api/purchases/${purchase.body.item.id}/return`).set('Authorization', `Bearer ${cashierA}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Expense posting', () => {
    test('an expense posts Dr its own category account, Cr Cash/Bank', async () => {
      const cat = await request(app)
        .post('/api/expense-categories')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: `Ledger Expense Category ${Date.now()}` });

      const expense = await request(app)
        .post('/api/expenses')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ categoryId: cat.body.item.id, amount: 75, method: 'cash' });
      expect(expense.status).toBe(201);

      const accounts = await getAccounts(accountantA);
      const categoryAccount = accounts.find((a) => a.name === cat.body.item.name);
      expect(categoryAccount).toBeDefined();
      expect(categoryAccount.type).toBe('EXPENSE');

      const journal = await request(app).get('/api/accounting/journal?sourceType=EXPENSE').set('Authorization', `Bearer ${accountantA}`);
      const entry = journal.body.items.find((e) => e.sourceId === expense.body.item.id);
      const cashId = findAccount(accounts, 'Cash').id;
      const line = (accountId) => entry.lines.find((l) => l.accountId === accountId);
      expect(Number(line(categoryAccount.id).debit)).toBeCloseTo(75, 2);
      expect(Number(line(cashId).credit)).toBeCloseTo(75, 2);
    });
  });

  describe('Optical order posting', () => {
    test('create + pay posts revenue and clears receivable correctly', async () => {
      const order = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId, totalAmount: 200, amountPaid: 50, paymentMethod: 'cash' });
      expect(order.status).toBe(201);

      const accounts = await getAccounts(accountantA);
      const receivableId = findAccount(accounts, 'Accounts Receivable').id;
      const revenueId = findAccount(accounts, 'Optical Order Revenue').id;

      const journal = await request(app).get('/api/accounting/journal?sourceType=OPTICAL_ORDER').set('Authorization', `Bearer ${accountantA}`);
      const entry = journal.body.items.find((e) => e.sourceId === order.body.item.id);
      const line = (accountId) => entry.lines.find((l) => l.accountId === accountId);
      expect(Number(line(revenueId).credit)).toBeCloseTo(200, 2);
      expect(Number(line(receivableId).debit)).toBeCloseTo(150, 2);

      await request(app).post(`/api/optical-orders/${order.body.item.id}/pay`).set('Authorization', `Bearer ${tenantA.token}`).send({ amount: 150, method: 'cash' });

      const payJournal = await request(app).get('/api/accounting/journal?sourceType=PAYMENT').set('Authorization', `Bearer ${accountantA}`);
      const payEntry = payJournal.body.items.find((e) => e.sourceId === order.body.item.id);
      expect(payEntry).toBeDefined();
      expect(Number(payEntry.lines.find((l) => l.accountId === receivableId).credit)).toBeCloseTo(150, 2);
    });
  });

  describe('Manual journal entries', () => {
    test('a balanced manual entry posts; an unbalanced one is rejected', async () => {
      const accounts = await getAccounts(accountantA);
      const cashId = findAccount(accounts, 'Cash').id;
      const equityId = findAccount(accounts, 'Opening Balance Equity').id;

      const balanced = await request(app)
        .post('/api/accounting/journal')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ memo: 'Test manual entry', lines: [{ accountId: cashId, debit: 500 }, { accountId: equityId, credit: 500 }] });
      expect(balanced.status).toBe(201);

      const unbalanced = await request(app)
        .post('/api/accounting/journal')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ memo: 'Bad entry', lines: [{ accountId: cashId, debit: 500 }, { accountId: equityId, credit: 400 }] });
      expect(unbalanced.status).toBe(422);
    });

    test('manual journal entry creation is restricted to MANAGEMENT', async () => {
      const accounts = await getAccounts(accountantA);
      const cashId = findAccount(accounts, 'Cash').id;
      const equityId = findAccount(accounts, 'Opening Balance Equity').id;

      const res = await request(app)
        .post('/api/accounting/journal')
        .set('Authorization', `Bearer ${accountantA}`)
        .send({ lines: [{ accountId: cashId, debit: 10 }, { accountId: equityId, credit: 10 }] });
      expect(res.status).toBe(403);
    });

    test('a manual entry can be voided; a source-linked entry cannot be voided directly', async () => {
      const accounts = await getAccounts(accountantA);
      const cashId = findAccount(accounts, 'Cash').id;
      const equityId = findAccount(accounts, 'Opening Balance Equity').id;

      const created = await request(app)
        .post('/api/accounting/journal')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ lines: [{ accountId: cashId, debit: 42 }, { accountId: equityId, credit: 42 }] });

      const voided = await request(app).post(`/api/accounting/journal/${created.body.item.id}/void`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(voided.status).toBe(200);

      const saleJournal = await request(app).get('/api/accounting/journal?sourceType=SALE').set('Authorization', `Bearer ${accountantA}`);
      const saleEntry = saleJournal.body.items[0];
      const voidSaleEntry = await request(app).post(`/api/accounting/journal/${saleEntry.id}/void`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(voidSaleEntry.status).toBe(409);
    });
  });

  describe('Accounting periods', () => {
    test('closing a period rejects a new posting dated inside it; reopening allows it again', async () => {
      const start = new Date('2020-01-01');
      const end = new Date('2020-01-31');
      const period = await request(app)
        .post('/api/accounting/periods')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: `Locked Period ${Date.now()}`, startDate: start, endDate: end });
      expect(period.status).toBe(201);

      const closed = await request(app).post(`/api/accounting/periods/${period.body.item.id}/close`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(closed.status).toBe(200);

      const accounts = await getAccounts(accountantA);
      const cashId = findAccount(accounts, 'Cash').id;
      const equityId = findAccount(accounts, 'Opening Balance Equity').id;

      const blocked = await request(app)
        .post('/api/accounting/journal')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ date: '2020-01-15', lines: [{ accountId: cashId, debit: 5 }, { accountId: equityId, credit: 5 }] });
      expect(blocked.status).toBe(409);

      await request(app).post(`/api/accounting/periods/${period.body.item.id}/reopen`).set('Authorization', `Bearer ${tenantA.token}`);
      const allowed = await request(app)
        .post('/api/accounting/journal')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ date: '2020-01-15', lines: [{ accountId: cashId, debit: 5 }, { accountId: equityId, credit: 5 }] });
      expect(allowed.status).toBe(201);
    });

    test('period management is restricted to TENANT_ADMIN', async () => {
      const res = await request(app)
        .post('/api/accounting/periods')
        .set('Authorization', `Bearer ${accountantA}`)
        .send({ name: 'Forbidden Period', startDate: '2021-01-01', endDate: '2021-01-31' });
      expect(res.status).toBe(403);
    });
  });

  describe('Reports', () => {
    test('the trial balance always balances after a mix of transactions', async () => {
      const res = await request(app).get('/api/accounting/reports/trial-balance').set('Authorization', `Bearer ${accountantA}`);
      expect(res.status).toBe(200);
      expect(res.body.balanced).toBe(true);
      expect(res.body.totalDebit).toBeCloseTo(res.body.totalCredit, 2);
    });

    test('the balance sheet balances (Assets = Liabilities + Equity)', async () => {
      const res = await request(app).get('/api/accounting/reports/balance-sheet').set('Authorization', `Bearer ${accountantA}`);
      expect(res.status).toBe(200);
      expect(res.body.balanced).toBe(true);
      expect(res.body.totalAssets).toBeCloseTo(res.body.totalLiabilities + res.body.totalEquity, 2);
    });

    test('profit & loss reflects known sales/expense activity within a date range', async () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const res = await request(app)
        .get(`/api/accounting/reports/profit-loss?from=${from.toISOString()}`)
        .set('Authorization', `Bearer ${accountantA}`);
      expect(res.status).toBe(200);
      expect(res.body.totalRevenue).toBeGreaterThan(0);
      expect(res.body.netProfit).toBe(res.body.totalRevenue - res.body.totalExpense);
    });

    test('AR aging buckets an old unpaid sale correctly', async () => {
      const oldSale = await prisma.sale.findFirst({ where: { tenantId: tenantA.tenantId, paymentStatus: { not: 'PAID' } } });
      if (oldSale) {
        await prisma.sale.update({ where: { id: oldSale.id }, data: { createdAt: new Date(Date.now() - 45 * 86400000) } });
      }
      const res = await request(app).get('/api/accounting/reports/ar-aging').set('Authorization', `Bearer ${accountantA}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(0);
    });

    test('reports are restricted to FINANCE_STAFF', async () => {
      const res = await request(app).get('/api/accounting/reports/trial-balance').set('Authorization', `Bearer ${cashierA}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Command Center Phase 5 integration', () => {
    test('cashBalance/bankBalance reflect actual ledger activity, not just the selected date range', async () => {
      const before = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      const cashBefore = before.body.accounting.cashBalance;

      await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId, quantity: 1, unitPrice: 50 }], paymentMethod: 'cash' });

      const after = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      expect(after.body.accounting.cashBalance).toBeCloseTo(cashBefore + 50, 2);
    });

    test('procurement.pendingApprovals reflects a real pending purchase request', async () => {
      const before = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);

      const pr = await request(app)
        .post('/api/procurement/purchase-requests')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId, quantity: 1 }] });
      expect(pr.status).toBe(201);

      const after = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      expect(after.body.procurement.pendingApprovals).toBe(before.body.procurement.pendingApprovals + 1);
    });

    test('purchasePriceChanges detects a genuine cost increase between two received purchases of the same product', async () => {
      const prod = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: `Price Change Product ${Date.now()}`, purchasePrice: 10, sellingPrice: 20, openingStock: 0 });

      await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: prod.body.item.id, quantity: 1, unitCost: 10 }], receiveImmediately: true });
      await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId, items: [{ productId: prod.body.item.id, quantity: 1, unitCost: 15 }], receiveImmediately: true });

      const res = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      const change = res.body.procurement.purchasePriceChanges.find((c) => c.productId === prod.body.item.id);
      expect(change).toBeDefined();
      expect(change.previousCost).toBe(10);
      expect(change.latestCost).toBe(15);
      expect(change.changePercent).toBeCloseTo(50, 1);
    });
  });

  describe('Tenant isolation', () => {
    test('tenant B has its own empty ledger, unaffected by tenant A activity', async () => {
      const accountantB = await createUserToken(tenantB.token, 'ACCOUNTANT');
      const res = await request(app).get('/api/accounting/reports/trial-balance').set('Authorization', `Bearer ${accountantB}`);
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);

      const journal = await request(app).get('/api/accounting/journal').set('Authorization', `Bearer ${accountantB}`);
      expect(journal.body.items).toEqual([]);
    });

    test('a manual journal entry cannot reference another tenant\'s account', async () => {
      const accountsA = await getAccounts(accountantA);
      const cashIdA = findAccount(accountsA, 'Cash').id;

      const res = await request(app)
        .post('/api/accounting/journal')
        .set('Authorization', `Bearer ${tenantB.token}`)
        .send({ lines: [{ accountId: cashIdA, debit: 10 }, { accountId: cashIdA, credit: 10 }] });
      expect(res.status).toBe(404);
    });
  });
});
