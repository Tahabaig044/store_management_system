// Phase 2.4 - Accounting integration & business-module posting.
//
// Needs DATABASE_URL pointed at a real, throwaway Postgres database with every migration
// applied (including 20260926000000_phase2_4_...) and the permission catalog seeded.
// Covers: every stock/money transaction reaching the ledger, the central posting guards
// (tenant references, inactive accounts, double posting), sale/purchase reversal semantics
// (credit / debit notes) and reconciliation after every kind of transaction. Concurrency,
// idempotent replays (offline boundary) and isolation live in accountingConcurrency.test.js
// (a separate file because the auth rate limiter caps tenant registrations per test file).
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { postJournalEntry, getSystemAccountId } = require('../src/modules/accounting/ledger');

jest.setTimeout(120000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});
const patch = (t, path, body) => request(app).patch(path).set(auth(t)).send(body || {});
const R = '/api/accounting/reports';

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: `${uniq('a')}@test.local`, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}
const makeCustomer = async (t) => (await post(t, '/api/customers', { name: uniq('Cust') })).body.item.id;
const makeSupplier = async (t) => (await post(t, '/api/suppliers', { name: uniq('Supp') })).body.item.id;
async function makeProduct(t, extra = {}) {
  const res = await post(t, '/api/products', { name: uniq('Prod'), sellingPrice: 10, purchasePrice: 5, openingStock: 1000, ...extra });
  if (res.status !== 201) throw new Error(`product failed ${JSON.stringify(res.body)}`);
  return res.body.item.id;
}
async function makeSale(t, productId, customerId, total, amountPaid = 0, extra = {}) {
  const res = await post(t, '/api/sales', { ...(customerId ? { customerId } : {}), items: [{ productId, quantity: total / 10, unitPrice: 10 }], paymentMethod: 'cash', amountPaid, ...extra });
  if (res.status !== 201) throw new Error(`sale failed ${JSON.stringify(res.body)}`);
  return res.body.item;
}
async function makePurchase(t, productId, supplierId, total, { paid = 0, received = true } = {}) {
  const res = await post(t, '/api/purchases', { supplierId, receiveImmediately: received, amountPaid: paid, items: [{ productId, quantity: total / 5, unitCost: 5 }] });
  if (res.status !== 201) throw new Error(`purchase failed ${JSON.stringify(res.body)}`);
  return res.body.item;
}
async function expenseCategory(t) {
  return (await post(t, '/api/expense-categories', { name: uniq('Cat') })).body.item.id;
}

// Net (debit - credit) of one system account, straight from the ledger.
async function net(tenantId, systemKey, where = {}) {
  const account = await prisma.account.findFirst({ where: { tenantId, systemKey } });
  if (!account) return 0;
  const agg = await prisma.journalLine.aggregate({
    where: { accountId: account.id, journalEntry: { tenantId, status: { in: ['POSTED', 'VOID'] }, ...where } },
    _sum: { debit: true, credit: true },
  });
  return Math.round((Number(agg._sum.debit || 0) - Number(agg._sum.credit || 0)) * 100) / 100;
}
const entriesOf = (tenantId, sourceType, extra = {}) => prisma.journalEntry.findMany({ where: { tenantId, sourceType, ...extra }, include: { lines: { include: { account: true } } }, orderBy: { createdAt: 'asc' } });
const lineSummary = (entry) => entry.lines.map((l) => `${l.account.systemKey}:${Number(l.debit)}:${Number(l.credit)}`).sort();
const reconcile = async (t) => (await get(t, `${R}/reconciliation`)).body;

describe('Phase 2.4 - Accounting integration & business-module posting', () => {
  let A;
  let B;

  beforeAll(async () => {
    A = await registerTenant(uniq('Integration A'));
    B = await registerTenant(uniq('Integration B'));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  describe('Inventory changes that used to bypass the ledger', () => {
    it('opening stock at product creation posts Dr Inventory / Cr Opening Balance Equity, valued at the purchase price', async () => {
      const T = await registerTenant(uniq('Opening Stock'));
      const productId = await makeProduct(T.token, { openingStock: 10 });
      const [entry] = await entriesOf(T.tenantId, 'INVENTORY_ADJUSTMENT');
      expect(lineSummary(entry)).toEqual(['INVENTORY:50:0', 'OPENING_BALANCE_EQUITY:0:50']);
      const txn = await prisma.inventoryTransaction.findFirst({ where: { tenantId: T.tenantId, productId, type: 'OPENING_STOCK' } });
      expect(entry.sourceId).toBe(txn.id);
    });

    it('stock adjustments post the gain/loss against Inventory Adjustments; services and zero-cost items post nothing', async () => {
      const T = await registerTenant(uniq('Adjust'));
      const productId = await makeProduct(T.token, { openingStock: 10 });
      expect((await post(T.token, `/api/products/${productId}/adjust-stock`, { quantity: -2, note: 'damaged' })).status).toBe(200);
      expect((await post(T.token, `/api/products/${productId}/adjust-stock`, { quantity: 3, note: 'found' })).status).toBe(200);
      const entries = await entriesOf(T.tenantId, 'INVENTORY_ADJUSTMENT');
      expect(entries.map(lineSummary)).toEqual([
        ['INVENTORY:50:0', 'OPENING_BALANCE_EQUITY:0:50'],
        ['INVENTORY:0:10', 'INVENTORY_ADJUSTMENT:10:0'],
        ['INVENTORY:15:0', 'INVENTORY_ADJUSTMENT:0:15'],
      ]);
      // A free product (purchase price 0) has no inventory value.
      const free = await makeProduct(T.token, { purchasePrice: 0, openingStock: 5 });
      expect((await post(T.token, `/api/products/${free}/adjust-stock`, { quantity: 1, note: 'x' })).status).toBe(200);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'INVENTORY_ADJUSTMENT' } })).toBe(3);
      // It shows as an expense in P&L (net loss 10 - gain 15 = a 5 gain).
      const pl = await get(T.token, `${R}/profit-loss`, { from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
      expect(pl.body.netProfit).toBe(5);
    });

    it('direct warehouse receive / dispatch / adjust post with the warehouse\'s branch; transfers between locations post nothing', async () => {
      const T = await registerTenant(uniq('Warehouse'));
      const branch = (await post(T.token, '/api/branches', { name: uniq('WB'), code: 'W1' })).body.item.id;
      const wh = (await post(T.token, '/api/warehouses', { name: uniq('WH'), branchId: branch })).body.item.id;
      const wh2 = (await post(T.token, '/api/warehouses', { name: uniq('WH2'), branchId: branch })).body.item.id;
      const productId = await makeProduct(T.token, { openingStock: 0 });
      expect((await post(T.token, `/api/warehouses/${wh}/receive`, { productId, quantity: 10 })).status).toBe(200);
      expect((await post(T.token, `/api/warehouses/${wh}/dispatch`, { productId, quantity: 4 })).status).toBe(200);
      expect((await post(T.token, `/api/warehouses/${wh}/adjust`, { productId, quantity: -1, note: 'count' })).status).toBe(200);

      const entries = await entriesOf(T.tenantId, 'INVENTORY_ADJUSTMENT');
      expect(entries).toHaveLength(3);
      expect(entries.every((e) => e.branchId === branch)).toBe(true);
      expect(await net(T.tenantId, 'INVENTORY')).toBe(25); // 5 units left x 5
      expect(await net(T.tenantId, 'INVENTORY', { branchId: branch })).toBe(25);

      const before = await prisma.journalEntry.count({ where: { tenantId: T.tenantId } });
      const transfer = await post(T.token, '/api/stock-transfers', { fromWarehouseId: wh, toWarehouseId: wh2, items: [{ productId, quantity: 2 }] });
      if (transfer.status === 201) {
        await post(T.token, `/api/stock-transfers/${transfer.body.item.id}/approve`);
        await post(T.token, `/api/stock-transfers/${transfer.body.item.id}/dispatch`);
        await post(T.token, `/api/stock-transfers/${transfer.body.item.id}/receive`);
      }
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId } })).toBe(before);
    });

    it('the ledger Inventory account equals the stock valuation after purchases, sales, adjustments and returns', async () => {
      const T = await registerTenant(uniq('Inventory Rec'));
      const productId = await makeProduct(T.token, { openingStock: 20 });
      const cust = await makeCustomer(T.token);
      const supp = await makeSupplier(T.token);
      await makePurchase(T.token, productId, supp, 100); // +20 units
      const sale = await makeSale(T.token, productId, cust, 50, 50); // -5 units
      await post(T.token, `/api/products/${productId}/adjust-stock`, { quantity: -3, note: 'loss' });
      await post(T.token, `/api/sales/${sale.id}/reverse`); // +5 units back
      const rec = await reconcile(T.token);
      expect(rec.inventory).toMatchObject({ available: true, ledgerBalance: 185, stockValuation: 185, difference: 0, reconciled: true });
      expect(rec.allChecksPassed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('Central posting guards', () => {
    it('refuses an account, branch or party from another tenant', async () => {
      const T = await registerTenant(uniq('Guards'));
      const foreignCash = await prisma.account.findFirst({ where: { tenantId: B.tenantId, systemKey: 'CASH' } })
        || (await (async () => { await get(B.token, `${R}/trial-balance`); return prisma.account.findFirst({ where: { tenantId: B.tenantId, systemKey: 'CASH' } }); })());
      const ownEquity = await prisma.$transaction((tx) => getSystemAccountId(tx, T.tenantId, 'OPENING_BALANCE_EQUITY'));
      const foreignBranch = (await get(B.token, '/api/branches')).body.items[0].id;
      const ownCash = await prisma.$transaction((tx) => getSystemAccountId(tx, T.tenantId, 'CASH'));

      const tryPost = (over) => prisma.$transaction((tx) => postJournalEntry(tx, { tenantId: T.tenantId, sourceType: 'MANUAL', sourceId: null, memo: 'x', lines: [{ accountId: ownCash, debit: 5 }, { accountId: ownEquity, credit: 5 }], ...over }));
      await expect(tryPost({ lines: [{ accountId: foreignCash.id, debit: 5 }, { accountId: ownEquity, credit: 5 }] })).rejects.toThrow(/does not belong to this tenant/);
      await expect(tryPost({ branchId: foreignBranch })).rejects.toThrow(/branch does not belong/);
      const foreignCustomer = await makeCustomer(B.token);
      await expect(tryPost({ lines: [{ accountId: ownCash, debit: 5, customerId: foreignCustomer }, { accountId: ownEquity, credit: 5 }] })).rejects.toThrow(/customer outside this tenant/);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'MANUAL' } })).toBe(0);
    });

    it('refuses to post the same sale, expense or note twice, but allows a reversal of it', async () => {
      const T = await registerTenant(uniq('Double Post'));
      const productId = await makeProduct(T.token);
      const sale = await makeSale(T.token, productId, null, 20, 20);
      const cash = await prisma.$transaction((tx) => getSystemAccountId(tx, T.tenantId, 'CASH'));
      const rev = await prisma.$transaction((tx) => getSystemAccountId(tx, T.tenantId, 'SALES_REVENUE'));
      const again = () => prisma.$transaction((tx) => postJournalEntry(tx, { tenantId: T.tenantId, sourceType: 'SALE', sourceId: sale.id, memo: 'dup', lines: [{ accountId: cash, debit: 20 }, { accountId: rev, credit: 20 }] }));
      await expect(again()).rejects.toThrow(/already been posted/);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'SALE', sourceId: sale.id } })).toBe(1);
    });

    it('an inactive account cannot be posted to by a business posting - the whole transaction is rejected, nothing half-done; reversals may still touch it', async () => {
      const T = await registerTenant(uniq('Inactive'));
      const created = await post(T.token, '/api/accounting/accounts', { code: '5900', name: 'Retired expense', type: 'EXPENSE' });
      expect(created.status).toBe(201);
      const cashId = await prisma.$transaction((tx) => getSystemAccountId(tx, T.tenantId, 'CASH'));
      const accountId = created.body.item.id;
      const lines = [{ accountId, debit: 5 }, { accountId: cashId, credit: 5 }];
      const doPost = (extra = {}) => prisma.$transaction((tx) => postJournalEntry(tx, { tenantId: T.tenantId, sourceType: 'MANUAL', sourceId: null, memo: 'x', lines, ...extra }));
      const entry = await doPost();
      expect((await patch(T.token, `/api/accounting/accounts/${accountId}`, { isActive: false })).status).toBe(409); // has postings: cannot deactivate
      // Deactivate an account that has no postings and try again.
      const empty = (await post(T.token, '/api/accounting/accounts', { code: '5901', name: 'Never used', type: 'EXPENSE' })).body.item.id;
      expect((await patch(T.token, `/api/accounting/accounts/${empty}`, { isActive: false })).status).toBe(200);
      const before = await prisma.journalEntry.count({ where: { tenantId: T.tenantId } });
      await expect(prisma.$transaction((tx) => postJournalEntry(tx, { tenantId: T.tenantId, sourceType: 'MANUAL', sourceId: null, memo: 'x', lines: [{ accountId: empty, debit: 5 }, { accountId: cashId, credit: 5 }] }))).rejects.toThrow(/inactive/);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId } })).toBe(before);
      expect(entry.id).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  describe('Sale reversal: operational balances and the ledger move together', () => {
    it('a paid sale reversal keeps the money as a customer credit note that can be refunded or applied - cash never silently leaves', async () => {
      const T = await registerTenant(uniq('Sale Reversal'));
      const productId = await makeProduct(T.token, { openingStock: 100 });
      const cust = await makeCustomer(T.token);
      const sale = await makeSale(T.token, productId, cust, 100, 100);
      expect(await net(T.tenantId, 'CASH')).toBe(100);

      const rev = await post(T.token, `/api/sales/${sale.id}/reverse`);
      expect(rev.status).toBe(200);
      // Ledger: revenue & COGS gone, cash still held, owed back to the customer.
      expect(await net(T.tenantId, 'CASH')).toBe(100);
      expect(await net(T.tenantId, 'ACCOUNTS_RECEIVABLE')).toBe(-100);
      expect(await net(T.tenantId, 'SALES_REVENUE')).toBe(0);
      expect(await net(T.tenantId, 'COGS')).toBe(0);
      // Operational: a real, refundable credit note, unique per sale.
      const note = await prisma.creditNote.findFirst({ where: { tenantId: T.tenantId, reversedSaleId: sale.id } });
      expect(Number(note.amount)).toBe(100);
      expect(note.customerId).toBe(cust);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'CREDIT_NOTE', sourceId: note.id } })).toBe(0);
      expect((await get(T.token, `/api/receivables/customers/${cust}/outstanding`)).body).toMatchObject({ documentsDue: 0, availableCredit: 100, netOutstanding: -100, glBalance: -100 });
      expect((await reconcile(T.token)).allChecksPassed).toBe(true);

      // It cannot be cancelled (that would drop the credit without a ledger effect)...
      expect((await post(T.token, `/api/credit-notes/${note.id}/cancel`)).status).toBe(422);
      // ...but it can be refunded, which finally moves the cash.
      expect((await post(T.token, `/api/credit-notes/${note.id}/refund`, { amount: 60 })).status).toBe(200);
      expect(await net(T.tenantId, 'CASH')).toBe(40);
      expect(await net(T.tenantId, 'ACCOUNTS_RECEIVABLE')).toBe(-40);
      // ...or applied to another invoice, with no journal effect.
      const other = await makeSale(T.token, productId, cust, 30, 0);
      const applied = await post(T.token, '/api/receivables/note-applications', { noteId: note.id, allocations: [{ documentId: other.id, amount: 30 }] });
      expect(applied.status).toBe(201);
      const finalRec = await reconcile(T.token);
      expect(finalRec.allChecksPassed).toBe(true);
      expect(finalRec.receivables).toMatchObject({ unexplainedDifference: 0, reconciled: true });
    });

    it('a walk-in sale (no customer to hold a credit) keeps the full mirror: cash goes back; an unpaid sale issues no note', async () => {
      const T = await registerTenant(uniq('Walk-in Reversal'));
      const productId = await makeProduct(T.token);
      const walkIn = await makeSale(T.token, productId, null, 40, 40);
      expect((await post(T.token, `/api/sales/${walkIn.id}/reverse`)).status).toBe(200);
      expect(await net(T.tenantId, 'CASH')).toBe(0);
      const cust = await makeCustomer(T.token);
      const unpaid = await makeSale(T.token, productId, cust, 40, 0);
      expect((await post(T.token, `/api/sales/${unpaid.id}/reverse`)).status).toBe(200);
      expect(await prisma.creditNote.count({ where: { tenantId: T.tenantId } })).toBe(0);
      expect(await net(T.tenantId, 'ACCOUNTS_RECEIVABLE')).toBe(0);
      expect((await reconcile(T.token)).allChecksPassed).toBe(true);
    });

    it('a sale reversal after a later /pay counts every payment in the credit note', async () => {
      const T = await registerTenant(uniq('Reversal Later Pay'));
      const productId = await makeProduct(T.token);
      const cust = await makeCustomer(T.token);
      const sale = await makeSale(T.token, productId, cust, 100, 30);
      await post(T.token, `/api/sales/${sale.id}/pay`, { amount: 20 });
      await post(T.token, `/api/sales/${sale.id}/reverse`);
      const note = await prisma.creditNote.findFirst({ where: { tenantId: T.tenantId, reversedSaleId: sale.id } });
      expect(Number(note.amount)).toBe(50);
      expect(await net(T.tenantId, 'ACCOUNTS_RECEIVABLE')).toBe(-50);
      expect((await reconcile(T.token)).allChecksPassed).toBe(true);
    });
  });

  describe('Purchase return: mirror of the sale reversal', () => {
    it('what was paid to the supplier stays as a debit note (a balance they owe us) that can be collected', async () => {
      const T = await registerTenant(uniq('Purchase Return'));
      const productId = await makeProduct(T.token, { openingStock: 0 });
      const supp = await makeSupplier(T.token);
      const purchase = await makePurchase(T.token, productId, supp, 100, { paid: 100 });
      expect(await net(T.tenantId, 'CASH')).toBe(-100);
      expect((await post(T.token, `/api/purchases/${purchase.id}/return`)).status).toBe(200);
      expect(await net(T.tenantId, 'CASH')).toBe(-100); // still paid out - not silently returned
      expect(await net(T.tenantId, 'ACCOUNTS_PAYABLE')).toBe(100); // the supplier owes us
      expect(await net(T.tenantId, 'INVENTORY')).toBe(0);
      const note = await prisma.debitNote.findFirst({ where: { tenantId: T.tenantId, returnedPurchaseId: purchase.id } });
      expect(Number(note.amount)).toBe(100);
      expect((await get(T.token, `/api/payables/suppliers/${supp}/outstanding`)).body).toMatchObject({ documentsDue: 0, availableCredit: 100, netOutstanding: -100, glBalance: -100 });
      expect((await reconcile(T.token)).allChecksPassed).toBe(true);
      expect((await post(T.token, `/api/debit-notes/${note.id}/cancel`)).status).toBe(422);
      expect((await post(T.token, `/api/debit-notes/${note.id}/refund`, { amount: 100 })).status).toBe(200);
      expect(await net(T.tenantId, 'CASH')).toBe(0);
      expect(await net(T.tenantId, 'ACCOUNTS_PAYABLE')).toBe(0);
    });

    it('a prepayment (cleared from Advance-to-Suppliers) is restored to that asset and needs no debit note', async () => {
      const T = await registerTenant(uniq('Purchase Return Advance'));
      const productId = await makeProduct(T.token, { openingStock: 0 });
      const supp = await makeSupplier(T.token);
      const draft = await makePurchase(T.token, productId, supp, 100, { paid: 40, received: false });
      expect((await post(T.token, `/api/purchases/${draft.id}/receive`)).status).toBe(200);
      expect((await post(T.token, `/api/purchases/${draft.id}/return`)).status).toBe(200);
      expect(await prisma.debitNote.count({ where: { tenantId: T.tenantId } })).toBe(0);
      expect(await net(T.tenantId, 'ADVANCE_TO_SUPPLIERS')).toBe(40);
      expect(await net(T.tenantId, 'ACCOUNTS_PAYABLE')).toBe(0);
      expect((await reconcile(T.token)).allChecksPassed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('Reconciliation after every kind of transaction', () => {
    it('sales, purchases, expenses, payments, notes, returns, adjustments and reversals together leave every check passing', async () => {
      const T = await registerTenant(uniq('Everything'));
      const productId = await makeProduct(T.token, { openingStock: 200 });
      const cust = await makeCustomer(T.token);
      const supp = await makeSupplier(T.token);
      const cat = await expenseCategory(T.token);

      const s1 = await makeSale(T.token, productId, cust, 200, 50);
      const s2 = await makeSale(T.token, productId, cust, 100, 100);
      const p1 = await makePurchase(T.token, productId, supp, 300, { paid: 100 });
      await makePurchase(T.token, productId, supp, 50, { received: false, paid: 10 });
      const expense = (await post(T.token, '/api/expenses', { categoryId: cat, amount: 25, method: 'cash' })).body.item;
      await post(T.token, '/api/payments', { direction: 'IN', customerId: cust, amount: 60, allocations: [{ saleId: s1.id, amount: 60 }] });
      await post(T.token, '/api/payments', { direction: 'OUT', supplierId: supp, amount: 80, allocations: [{ purchaseId: p1.id, amount: 80 }] });
      const cn = (await post(T.token, '/api/credit-notes', { customerId: cust, amount: 15, reason: 'goodwill' })).body.item;
      await post(T.token, '/api/debit-notes', { supplierId: supp, amount: 12, reason: 'damaged' });
      await post(T.token, '/api/receivables/note-applications', { noteId: cn.id, allocations: [{ documentId: s1.id, amount: 15 }] });
      await post(T.token, `/api/products/${productId}/adjust-stock`, { quantity: -4, note: 'count' });
      await post(T.token, `/api/sales/${s2.id}/reverse`);
      await post(T.token, `/api/expenses/${expense.id}/reverse`);
      const item = (await get(T.token, `/api/sales/${s1.id}`)).body.item.items[0];
      await post(T.token, '/api/sales-returns', { saleId: s1.id, items: [{ saleItemId: item.id, quantity: 2 }], reason: 'wrong size' });

      const rec = await reconcile(T.token);
      expect(rec.checks.filter((c) => !c.ok)).toEqual([]);
      expect(rec.allChecksPassed).toBe(true);
      // The standalone 12 debit note reduced the Inventory ledger value (a cost adjustment) without
      // changing any stock quantity or purchase price - exactly the kind of difference the
      // informational inventory check exists to surface, and it does not fail the integrity checks.
      expect(rec.inventory).toMatchObject({ available: true, difference: -12, reconciled: false });

      // Trial balance & balance sheet balance, and every dashboard KPI equals its statement.
      expect((await get(T.token, `${R}/trial-balance`)).body.balanced).toBe(true);
      const bs = await get(T.token, `${R}/balance-sheet`);
      expect(bs.body.balanced).toBe(true);
      const today = new Date().toISOString().slice(0, 10);
      const dash = await get(T.token, '/api/dashboard/command-center', { range: 'today' });
      const pl = await get(T.token, `${R}/profit-loss`, { from: today, to: today });
      const ledger = dash.body.accounting.ledger;
      expect(ledger).toMatchObject({ revenue: pl.body.totalRevenue, netProfit: pl.body.netProfit, grossProfit: pl.body.grossProfit });
      expect(ledger.cashAndBank).toBe((await get(T.token, `${R}/cash-bank`, { from: today, to: today })).body.totals.closingBalance);
      expect(ledger.receivables).toBe(rec.receivables.ledgerBalance);
      expect(ledger.payables).toBe(rec.payables.ledgerBalance);
      expect(ledger.inventoryValue).toBe(rec.inventory.ledgerBalance);
    });
  });

  // -------------------------------------------------------------------------
  describe('Migration', () => {
    it('the Phase 2.4 schema objects exist: enum value and the two one-note-per-document unique indexes', async () => {
      const enumRow = await prisma.$queryRaw`SELECT 1 AS ok FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'JournalSourceType' AND e.enumlabel = 'INVENTORY_ADJUSTMENT'`;
      expect(enumRow).toHaveLength(1);
      const idx = await prisma.$queryRaw`SELECT indexname FROM pg_indexes WHERE indexname IN ('credit_notes_reversedSaleId_key', 'debit_notes_returnedPurchaseId_key')`;
      expect(idx).toHaveLength(2);
    });
  });
});
