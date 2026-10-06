// Phase 2.4 - concurrency, idempotent replay (offline boundary at the API level) and isolation
// for the accounting integration. See accountingIntegration.test.js for the posting semantics.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(120000);

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

describe('Phase 2.4 - accounting integration: concurrency, replay & isolation', () => {
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
  describe('Concurrency (real concurrent HTTP requests)', () => {
    it('many simultaneous business postings never collide: unique entry/receipt numbers, one entry per document, ledger balanced', async () => {
      const T = await registerTenant(uniq('Concurrent Posting'));
      const productId = await makeProduct(T.token, { openingStock: 10000 });
      const cust = await makeCustomer(T.token);
      const supp = await makeSupplier(T.token);
      const cat = await expenseCategory(T.token);

      const jobs = [
        ...Array.from({ length: 8 }, () => post(T.token, '/api/sales', { customerId: cust, items: [{ productId, quantity: 2, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 20 })),
        ...Array.from({ length: 4 }, () => post(T.token, '/api/purchases', { supplierId: supp, receiveImmediately: true, amountPaid: 10, items: [{ productId, quantity: 2, unitCost: 5 }] })),
        ...Array.from({ length: 4 }, () => post(T.token, '/api/expenses', { categoryId: cat, amount: 7, method: 'cash' })),
        ...Array.from({ length: 3 }, () => post(T.token, `/api/products/${productId}/adjust-stock`, { quantity: -1, note: 'shrink' })),
        ...Array.from({ length: 3 }, () => post(T.token, '/api/credit-notes', { customerId: cust, amount: 5, reason: 'x' })),
      ];
      const results = await Promise.all(jobs);
      expect(results.filter((r) => r.status >= 400)).toEqual([]);

      const entries = await prisma.journalEntry.findMany({ where: { tenantId: T.tenantId }, select: { entryNumber: true, sourceType: true, sourceId: true } });
      expect(new Set(entries.map((e) => e.entryNumber)).size).toBe(entries.length);
      const receipts = await prisma.payment.findMany({ where: { tenantId: T.tenantId }, select: { receiptNumber: true } });
      const numbered = receipts.map((p) => p.receiptNumber).filter(Boolean); // expense payments carry no receipt number
      expect(new Set(numbered).size).toBe(numbered.length);
      const single = entries.filter((e) => ['SALE', 'EXPENSE', 'CREDIT_NOTE', 'INVENTORY_ADJUSTMENT'].includes(e.sourceType));
      const keys = single.map((e) => `${e.sourceType}:${e.sourceId}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect((await reconcile(T.token)).allChecksPassed).toBe(true);
    });

    it('duplicate requests with one idempotency key (sale, expense, stock adjustment, purchase) have exactly one effect', async () => {
      const T = await registerTenant(uniq('Idempotent'));
      const productId = await makeProduct(T.token, { openingStock: 100 });
      const cust = await makeCustomer(T.token);
      const supp = await makeSupplier(T.token);
      const cat = await expenseCategory(T.token);
      const key = uniq('k');
      const runs = await Promise.all([
        ...Array.from({ length: 5 }, () => post(T.token, '/api/sales', { customerId: cust, items: [{ productId, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10, idempotencyKey: `${key}-sale` })),
        ...Array.from({ length: 5 }, () => post(T.token, '/api/expenses', { categoryId: cat, amount: 9, method: 'cash', idempotencyKey: `${key}-exp` })),
        ...Array.from({ length: 5 }, () => post(T.token, `/api/products/${productId}/adjust-stock`, { quantity: -2, note: 'dup', idempotencyKey: `${key}-adj` })),
        ...Array.from({ length: 5 }, () => post(T.token, '/api/purchases', { supplierId: supp, receiveImmediately: true, items: [{ productId, quantity: 1, unitCost: 5 }], idempotencyKey: `${key}-po` })),
      ]);
      expect(runs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(runs.filter((r) => r.status === 409 || r.status === 422)).toHaveLength(0);
      expect(await prisma.sale.count({ where: { tenantId: T.tenantId } })).toBe(1);
      expect(await prisma.expense.count({ where: { tenantId: T.tenantId } })).toBe(1);
      expect(await prisma.purchase.count({ where: { tenantId: T.tenantId } })).toBe(1);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'SALE' } })).toBe(1);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'EXPENSE' } })).toBe(1);
      expect(await prisma.inventoryTransaction.count({ where: { tenantId: T.tenantId, idempotencyKey: `${key}-adj` } })).toBe(1);
      // 100 opening - 1 sold + 1 purchased - 2 adjusted = 98, once.
      expect(Number((await prisma.product.findUnique({ where: { id: productId } })).stockQuantity)).toBe(98);
      expect((await reconcile(T.token)).allChecksPassed).toBe(true);
    });

    it('concurrent reversals of one sale / purchase / expense take effect once: one ledger reversal, one note, no double stock', async () => {
      const T = await registerTenant(uniq('Concurrent Reversal'));
      const productId = await makeProduct(T.token, { openingStock: 100 });
      const cust = await makeCustomer(T.token);
      const supp = await makeSupplier(T.token);
      const cat = await expenseCategory(T.token);
      const sale = await makeSale(T.token, productId, cust, 100, 100);
      const purchase = await makePurchase(T.token, productId, supp, 100, { paid: 100 });
      const expense = (await post(T.token, '/api/expenses', { categoryId: cat, amount: 20, method: 'cash' })).body.item;
      const stockBefore = Number((await prisma.product.findUnique({ where: { id: productId } })).stockQuantity);

      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => post(T.token, `/api/sales/${sale.id}/reverse`)),
        ...Array.from({ length: 4 }, () => post(T.token, `/api/purchases/${purchase.id}/return`)),
        ...Array.from({ length: 4 }, () => post(T.token, `/api/expenses/${expense.id}/reverse`)),
      ]);
      const by = (from, n) => results.slice(from, from + n).map((r) => r.status).sort();
      expect(by(0, 4)).toEqual([200, 409, 409, 409]);
      expect(by(4, 4)).toEqual([200, 409, 409, 409]);
      expect(by(8, 4)).toEqual([200, 409, 409, 409]);
      expect(await prisma.creditNote.count({ where: { tenantId: T.tenantId, reversedSaleId: sale.id } })).toBe(1);
      expect(await prisma.debitNote.count({ where: { tenantId: T.tenantId, returnedPurchaseId: purchase.id } })).toBe(1);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'SALE_REVERSAL' } })).toBe(1);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'EXPENSE_REVERSAL' } })).toBe(1);
      // +100 sold back, -100 purchased away = net zero change; exactly once each.
      expect(Number((await prisma.product.findUnique({ where: { id: productId } })).stockQuantity)).toBe(stockBefore + 10 - 20);
      expect((await reconcile(T.token)).allChecksPassed).toBe(true);
    });

    it('a payment racing a sale reversal ends in one consistent state, never a stranded or double-counted amount', async () => {
      const T = await registerTenant(uniq('Pay vs Reverse'));
      const productId = await makeProduct(T.token);
      const cust = await makeCustomer(T.token);
      const sale = await makeSale(T.token, productId, cust, 100, 20);
      const results = await Promise.all([
        post(T.token, `/api/sales/${sale.id}/pay`, { amount: 30 }),
        post(T.token, `/api/sales/${sale.id}/reverse`),
        post(T.token, '/api/payments', { direction: 'IN', customerId: cust, amount: 10, allocations: [{ saleId: sale.id, amount: 10 }] }),
      ]);
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      const rec = await reconcile(T.token);
      expect(rec.allChecksPassed).toBe(true);
      const paid = Number((await prisma.sale.findUnique({ where: { id: sale.id } })).amountPaid);
      const note = await prisma.creditNote.findFirst({ where: { tenantId: T.tenantId, reversedSaleId: sale.id } });
      // Whatever the interleaving, the credit note equals what was collected AT reversal time,
      // and every payment that landed after it was refused (the sale is no longer payable).
      expect(Number(note.amount)).toBe(paid);
      expect(await net(T.tenantId, 'ACCOUNTS_RECEIVABLE')).toBe(-paid);
    });
  });

  // -------------------------------------------------------------------------
  describe('Offline boundary at the API level (replayed queued operations)', () => {
    it('replaying every queueable operation with its original idempotency key changes nothing the second time', async () => {
      const T = await registerTenant(uniq('Replay'));
      const productId = await makeProduct(T.token, { openingStock: 100 });
      const cust = await makeCustomer(T.token);
      const supp = await makeSupplier(T.token);
      const cat = await expenseCategory(T.token);
      const wh = (await post(T.token, '/api/warehouses', { name: uniq('WH') })).body.item.id;
      const sale = await makeSale(T.token, productId, cust, 100, 0);
      const k = uniq('rp');

      const ops = [
        () => post(T.token, '/api/sales', { customerId: cust, items: [{ productId, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10, idempotencyKey: `${k}-s` }),
        () => post(T.token, '/api/purchases', { supplierId: supp, receiveImmediately: true, items: [{ productId, quantity: 2, unitCost: 5 }], idempotencyKey: `${k}-p` }),
        () => post(T.token, '/api/expenses', { categoryId: cat, amount: 11, method: 'cash', idempotencyKey: `${k}-e` }),
        () => post(T.token, '/api/payments', { direction: 'IN', customerId: cust, amount: 40, allocations: [{ saleId: sale.id, amount: 40 }], idempotencyKey: `${k}-pay` }),
        () => post(T.token, `/api/warehouses/${wh}/receive`, { productId, quantity: 3, idempotencyKey: `${k}-w` }),
      ];
      for (const op of ops) expect([200, 201]).toContain((await op()).status);
      const snapshot = async () => ({
        entries: await prisma.journalEntry.count({ where: { tenantId: T.tenantId } }),
        payments: await prisma.payment.count({ where: { tenantId: T.tenantId } }),
        cash: await net(T.tenantId, 'CASH'),
        inventory: await net(T.tenantId, 'INVENTORY'),
        stock: Number((await prisma.product.findUnique({ where: { id: productId } })).stockQuantity),
      });
      const afterFirst = await snapshot();
      for (const op of ops) {
        const again = await op();
        expect([200, 201]).toContain(again.status);
        expect(again.body.deduplicated).toBe(true);
      }
      expect(await snapshot()).toEqual(afterFirst);

      // A queued sale reversal replays as a conflict, never as a second reversal.
      const reversalsBefore = await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'SALE_REVERSAL' } });
      const paid = (await post(T.token, `/api/sales/${sale.id}/reverse`)).status;
      expect(paid).toBe(200);
      expect((await post(T.token, `/api/sales/${sale.id}/reverse`)).status).toBe(409);
      expect(await prisma.journalEntry.count({ where: { tenantId: T.tenantId, sourceType: 'SALE_REVERSAL' } })).toBe(reversalsBefore + 1);
    });
  });

  // -------------------------------------------------------------------------
  describe('Tenant and branch isolation', () => {
    it('another tenant cannot reverse, refund or see this tenant\'s reversal notes, and its own ledger is untouched', async () => {
      const T = await registerTenant(uniq('Isolation'));
      const productId = await makeProduct(T.token);
      const cust = await makeCustomer(T.token);
      const sale = await makeSale(T.token, productId, cust, 50, 50);
      await post(T.token, `/api/sales/${sale.id}/reverse`);
      const note = await prisma.creditNote.findFirst({ where: { tenantId: T.tenantId, reversedSaleId: sale.id } });

      expect((await post(B.token, `/api/sales/${sale.id}/reverse`)).status).toBe(404);
      expect((await post(B.token, `/api/credit-notes/${note.id}/refund`, { amount: 10 })).status).toBe(404);
      expect((await get(B.token, `/api/credit-notes/${note.id}`)).status).toBe(404);
      const tb = await get(B.token, `${R}/trial-balance`);
      expect(tb.body.rows.filter((r) => r.code === '1030' || r.code === '4010')).toHaveLength(0);
    });

    it('warehouse adjustments are attributed to the warehouse branch, so branch-filtered statements and reconciliation see them', async () => {
      const T = await registerTenant(uniq('Branch Adjust'));
      const b1 = (await post(T.token, '/api/branches', { name: uniq('B1'), code: 'B1' })).body.item.id;
      const b2 = (await post(T.token, '/api/branches', { name: uniq('B2'), code: 'B2' })).body.item.id;
      const w1 = (await post(T.token, '/api/warehouses', { name: uniq('W1'), branchId: b1 })).body.item.id;
      const w2 = (await post(T.token, '/api/warehouses', { name: uniq('W2'), branchId: b2 })).body.item.id;
      const productId = await makeProduct(T.token, { openingStock: 0 });
      await post(T.token, `/api/warehouses/${w1}/receive`, { productId, quantity: 10 });
      await post(T.token, `/api/warehouses/${w2}/receive`, { productId, quantity: 4 });
      const bs1 = await get(T.token, `${R}/balance-sheet`, { branchId: b1 });
      const bs2 = await get(T.token, `${R}/balance-sheet`, { branchId: b2 });
      const inv = (bs) => bs.body.assets.find((a) => a.code === '1040')?.amount;
      expect(inv(bs1)).toBe(50);
      expect(inv(bs2)).toBe(20);
      expect(bs1.body.balanced && bs2.body.balanced).toBe(true);
    });
  });

});
