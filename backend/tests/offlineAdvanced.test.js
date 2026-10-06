// Phase 3.3 - server side of advanced offline transactions: returns, credit/debit notes, refunds and
// note applications queued on a terminal and replayed later.
//
// Proven here with real concurrent HTTP against a real Postgres:
//   - the selection datasets a terminal downloads (returnable sales/purchases, open documents, notes with
//     credit left) are correct, scoped, paged completely and change their version when data changes;
//   - the original event time is kept on every one of these operations (record + ledger date);
//   - two terminals racing to return the same goods / refund or apply the same credit can never take
//     back more than was sold or spend more than was issued; every loser is a coded conflict; every
//     duplicate replay resolves to the original; the books still reconcile afterwards.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(120000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
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
const makeProduct = async (t, extra = {}) => (await post(t, '/api/products', { name: uniq('Prod'), sellingPrice: 10, purchasePrice: 5, openingStock: 50, ...extra })).body.item;
const makeCustomer = async (t) => (await post(t, '/api/customers', { name: uniq('Cust') })).body.item.id;
const makeSupplier = async (t) => (await post(t, '/api/suppliers', { name: uniq('Supp') })).body.item.id;
const makeSale = async (t, productId, quantity, extra = {}) => {
  const res = await post(t, '/api/sales', { items: [{ productId, quantity, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: quantity * 10, ...extra });
  if (res.status !== 201) throw new Error(`sale failed ${JSON.stringify(res.body)}`);
  return res.body.item;
};
const makePurchase = async (t, supplierId, productId, quantity, extra = {}) => {
  const res = await post(t, '/api/purchases', { supplierId, receiveImmediately: true, amountPaid: 0, items: [{ productId, quantity, unitCost: 5 }], ...extra });
  if (res.status !== 201) throw new Error(`purchase failed ${JSON.stringify(res.body)}`);
  return res.body.item;
};
async function download(token, name, query = {}, limit = 500) {
  const items = [];
  let after;
  let pages = 0;
  do {
    const res = await get(token, `/api/offline/datasets/${name}`, { ...query, limit, ...(after ? { after } : {}) });
    expect(res.status).toBe(200);
    items.push(...res.body.items);
    after = res.body.nextCursor;
    pages += 1;
  } while (after);
  return { items, pages };
}
const version = async (token, name) => (await get(token, '/api/offline/manifest')).body.datasets[name];
const stockOf = async (id) => Number((await prisma.product.findUnique({ where: { id } })).stockQuantity);
const near = (d, when) => Math.abs(new Date(d).getTime() - new Date(when).getTime()) < 1000;

describe('Phase 3.3 - server side of advanced offline transactions', () => {
  let T;

  beforeAll(async () => {
    T = await registerTenant(uniq('Advanced Offline'));
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------------------------------
  describe('Selection datasets', () => {
    it('returnableSales lists recent completed sales with what can still be returned, and follows partial returns, reversals and the 60-day window', async () => {
      const p = await makeProduct(T.token);
      const sale = await makeSale(T.token, p.id, 5);
      const v0 = await version(T.token, 'returnableSales');
      let rows = (await download(T.token, 'returnableSales')).items;
      const row = rows.find((r) => r.id === sale.id);
      expect(row).toMatchObject({ invoiceNumber: sale.invoiceNumber, total: 50 });
      expect(row.items[0]).toMatchObject({ productId: p.id, name: p.name, quantity: 5, returnedQuantity: 0 });

      await new Promise((r) => setTimeout(r, 15));
      expect((await post(T.token, '/api/sales-returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 2 }] })).status).toBe(201);
      const v1 = await version(T.token, 'returnableSales');
      expect(v1.count).not.toBe(v0.count); // a return is a change a terminal must notice
      rows = (await download(T.token, 'returnableSales')).items;
      expect(rows.find((r) => r.id === sale.id).items[0].returnedQuantity).toBe(2);

      // Fully returned => no longer offered.
      await post(T.token, '/api/sales-returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 3 }] });
      expect((await download(T.token, 'returnableSales')).items.find((r) => r.id === sale.id)).toBeUndefined();

      // Reversed sale => not offered; old sale => outside the window.
      const s2 = await makeSale(T.token, p.id, 1);
      await post(T.token, `/api/sales/${s2.id}/reverse`);
      const s3 = await makeSale(T.token, p.id, 1);
      await prisma.sale.update({ where: { id: s3.id }, data: { createdAt: daysAgo(90) } });
      const ids = (await download(T.token, 'returnableSales')).items.map((r) => r.id);
      expect(ids).not.toContain(s2.id);
      expect(ids).not.toContain(s3.id);
    });

    it('pages by the raw window, so a filtered-out row never truncates the download', async () => {
      const U = await registerTenant(uniq('Paging'));
      const p = await makeProduct(U.token, { openingStock: 500 });
      const sales = [];
      for (let i = 0; i < 14; i += 1) sales.push(await makeSale(U.token, p.id, 1));
      for (const s of sales.filter((_, i) => i % 3 === 0)) await post(U.token, '/api/sales-returns', { saleId: s.id, items: [{ saleItemId: s.items[0].id, quantity: 1 }] });
      const expected = sales.filter((_, i) => i % 3 !== 0).map((s) => s.id).sort();
      const { items, pages } = await download(U.token, 'returnableSales', {}, 4);
      expect(pages).toBeGreaterThan(1);
      expect(items.map((r) => r.id).sort()).toEqual(expected);
    });

    it('returnablePurchases, arDocuments and apDocuments carry balances; arNotes/apNotes carry the credit left', async () => {
      const U = await registerTenant(uniq('Open'));
      const p = await makeProduct(U.token, { openingStock: 0 });
      const cust = await makeCustomer(U.token);
      const supp = await makeSupplier(U.token);
      const sale = await makeSale(U.token, (await makeProduct(U.token)).id, 4, { customerId: cust, amountPaid: 10 });
      const purchase = await makePurchase(U.token, supp, p.id, 10, { amountPaid: 20 });
      const note = (await post(U.token, '/api/credit-notes', { customerId: cust, amount: 30, reason: 'x' })).body.item;
      const dnote = (await post(U.token, '/api/debit-notes', { supplierId: supp, amount: 15, reason: 'y' })).body.item;

      expect((await download(U.token, 'returnablePurchases')).items.find((r) => r.id === purchase.id).items[0]).toMatchObject({ quantity: 10, returnedQuantity: 0 });
      expect((await download(U.token, 'arDocuments')).items.find((d) => d.id === sale.id)).toMatchObject({ number: sale.invoiceNumber, partyId: cust, total: 40, amountPaid: 10, balance: 30 });
      expect((await download(U.token, 'apDocuments')).items.find((d) => d.id === purchase.id)).toMatchObject({ partyId: supp, total: 50, balance: 30 });
      expect((await download(U.token, 'arNotes')).items.find((n) => n.id === note.id)).toMatchObject({ partyId: cust, amount: 30, available: 30 });
      expect((await download(U.token, 'apNotes')).items.find((n) => n.id === dnote.id)).toMatchObject({ available: 15 });

      const before = await version(U.token, 'arNotes');
      await new Promise((r) => setTimeout(r, 15));
      await post(U.token, `/api/credit-notes/${note.id}/refund`, { amount: 10 });
      expect((await download(U.token, 'arNotes')).items.find((n) => n.id === note.id).available).toBe(20);
      expect(new Date((await version(U.token, 'arNotes')).maxUpdatedAt).getTime()).toBeGreaterThan(new Date(before.maxUpdatedAt).getTime());

      await post(U.token, `/api/sales/${sale.id}/pay`, { amount: 30 }); // now fully paid
      expect((await download(U.token, 'arDocuments')).items.find((d) => d.id === sale.id)).toBeUndefined();
    });

    it('permission and scope: a role without the permission cannot download; a branch-restricted user sees only their branch; another tenant sees nothing of ours', async () => {
      const V = await registerTenant(uniq('Scope'));
      const b1 = (await get(V.token, '/api/branches')).body.items[0].id;
      const b2 = (await post(V.token, '/api/branches', { name: uniq('B2'), code: 'B2' })).body.item.id;
      const p = await makeProduct(V.token);
      const s1 = await makeSale(V.token, p.id, 1, { branchId: b1 });
      const s2 = await makeSale(V.token, p.id, 1, { branchId: b2 });
      const doctor = await userToken(V.token, 'DOCTOR');
      expect((await get(doctor, '/api/offline/datasets/returnableSales')).status).toBe(403);
      expect((await get(doctor, '/api/offline/datasets/arNotes')).status).toBe(403);

      const manager = await userToken(V.token, 'ACCOUNTANT', b1);
      const manifest = (await get(manager, '/api/offline/manifest')).body;
      if (manifest.datasets.arDocuments) {
        const ids = (await download(manager, 'arDocuments')).items.map((d) => d.id);
        expect(ids).not.toContain(s2.id);
      }
      const all = (await download(V.token, 'returnableSales')).items.map((r) => r.id);
      expect(all).toEqual(expect.arrayContaining([s1.id, s2.id]));
      const other = await registerTenant(uniq('Other'));
      expect((await download(other.token, 'returnableSales')).items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('Original event time on returns, notes, refunds and applications', () => {
    it('each keeps the time it was actually made: the record AND its ledger entry', async () => {
      const U = await registerTenant(uniq('Event Time'));
      const when = daysAgo(2).toISOString();
      const p = await makeProduct(U.token);
      const cust = await makeCustomer(U.token);
      const supp = await makeSupplier(U.token);
      const sale = await makeSale(U.token, p.id, 5, { customerId: cust, amountPaid: 0 });
      const purchase = await makePurchase(U.token, supp, p.id, 4);

      const sr = (await post(U.token, '/api/sales-returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], occurredAt: when })).body.item;
      expect(near((await prisma.salesReturn.findUnique({ where: { id: sr.id } })).createdAt, when)).toBe(true);
      expect(near((await prisma.creditNote.findFirst({ where: { salesReturnId: sr.id } })).createdAt, when)).toBe(true);
      expect(near((await prisma.journalEntry.findFirst({ where: { sourceType: 'SALES_RETURN', sourceId: sr.id } })).date, when)).toBe(true);

      const pr = (await post(U.token, '/api/purchase-returns', { purchaseId: purchase.id, items: [{ purchaseItemId: purchase.items[0].id, quantity: 1 }], occurredAt: when })).body.item;
      expect(near((await prisma.purchaseReturn.findUnique({ where: { id: pr.id } })).createdAt, when)).toBe(true);
      expect(near((await prisma.journalEntry.findFirst({ where: { sourceType: 'PURCHASE_RETURN', sourceId: pr.id, reversalOfId: null } })).date, when)).toBe(true);

      const cn = (await post(U.token, '/api/credit-notes', { customerId: cust, amount: 20, reason: 'x', occurredAt: when })).body.item;
      const dn = (await post(U.token, '/api/debit-notes', { supplierId: supp, amount: 20, reason: 'y', occurredAt: when })).body.item;
      expect(near((await prisma.creditNote.findUnique({ where: { id: cn.id } })).createdAt, when)).toBe(true);
      expect(near((await prisma.journalEntry.findFirst({ where: { sourceType: 'CREDIT_NOTE', sourceId: cn.id } })).date, when)).toBe(true);
      expect(near((await prisma.debitNote.findUnique({ where: { id: dn.id } })).createdAt, when)).toBe(true);

      expect((await post(U.token, `/api/credit-notes/${cn.id}/refund`, { amount: 5, occurredAt: when })).status).toBe(200);
      const refundPayment = await prisma.payment.findFirst({ where: { creditNoteId: cn.id } });
      expect(near(refundPayment.paidAt, when)).toBe(true);
      expect(near((await prisma.journalEntry.findFirst({ where: { sourceType: 'CREDIT_NOTE_REFUND', sourceId: cn.id } })).date, when)).toBe(true);
      expect((await post(U.token, `/api/debit-notes/${dn.id}/refund`, { amount: 5, occurredAt: when })).status).toBe(200);
      expect(near((await prisma.payment.findFirst({ where: { debitNoteId: dn.id } })).paidAt, when)).toBe(true);

      const app1 = await post(U.token, '/api/receivables/note-applications', { noteId: cn.id, allocations: [{ documentId: sale.id, amount: 10 }], occurredAt: when });
      expect(app1.status).toBe(201);
      expect(near(app1.body.item.createdAt, when)).toBe(true);
      expect((await get(U.token, `${R}/reconciliation`)).body.allChecksPassed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('Two terminals returning the same goods', () => {
    it('concurrent partial returns can never take back more than was sold: exactly the sold quantity is accepted, every loser is a coded conflict, stock is restocked once per unit', async () => {
      const U = await registerTenant(uniq('Return Race'));
      const p = await makeProduct(U.token, { openingStock: 20 });
      const cust = await makeCustomer(U.token);
      const sale = await makeSale(U.token, p.id, 3, { customerId: cust });
      expect(await stockOf(p.id)).toBe(17);
      const jobs = Array.from({ length: 8 }, (_, i) => post(U.token, '/api/sales-returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], idempotencyKey: `race-${sale.id}-${i}` }));
      const results = await Promise.all(jobs);
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      const losers = results.filter((r) => r.status !== 201);
      expect(losers).toHaveLength(5);
      for (const r of losers) expect(r.body.code).toBe('RETURN_EXCEEDS');
      expect(await stockOf(p.id)).toBe(20); // 3 units back, once each
      expect(Number((await prisma.saleItem.findUnique({ where: { id: sale.items[0].id } })).returnedQuantity)).toBe(3);
      expect(await prisma.creditNote.count({ where: { tenantId: U.tenantId, salesReturnId: { not: null } } })).toBe(3);
      expect((await get(U.token, `${R}/reconciliation`)).body.allChecksPassed).toBe(true);
    });

    it('a whole-quantity return raced by two terminals: one wins, the other is RETURN_EXCEEDS with the facts needed to fix it', async () => {
      const U = await registerTenant(uniq('Return Whole'));
      const p = await makeProduct(U.token);
      const sale = await makeSale(U.token, p.id, 4);
      const [a, b] = await Promise.all([
        post(U.token, '/api/sales-returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 4 }], idempotencyKey: uniq('A') }),
        post(U.token, '/api/sales-returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 4 }], idempotencyKey: uniq('B') }),
      ]);
      expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
      const loser = a.status === 201 ? b : a;
      expect([409, 422]).toContain(loser.status);
      expect(loser.body.code).toBe('RETURN_EXCEEDS');
      // Once known (a later friendly check) the server states exactly what remains.
      const later = await post(U.token, '/api/sales-returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], idempotencyKey: uniq('C') });
      expect(later.body.details).toMatchObject({ saleItemId: sale.items[0].id, remaining: 0 });
    });

    it('duplicate replays of ONE return (same idempotency key) resolve to the original - one return, one credit note, one stock effect', async () => {
      const U = await registerTenant(uniq('Return Dup'));
      const p = await makeProduct(U.token);
      const sale = await makeSale(U.token, p.id, 5);
      const key = uniq('rk');
      const results = await Promise.all(Array.from({ length: 6 }, () => post(U.token, '/api/sales-returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, quantity: 2 }], idempotencyKey: key })));
      expect(results.filter((r) => r.status >= 400)).toHaveLength(0);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.item.id)).size).toBe(1);
      expect(await prisma.salesReturn.count({ where: { tenantId: U.tenantId } })).toBe(1);
      expect(Number((await prisma.saleItem.findUnique({ where: { id: sale.items[0].id } })).returnedQuantity)).toBe(2);
      expect(await stockOf(p.id)).toBe(47);
    });

    it('a purchase return cannot take back more than was bought, nor more than is in stock - both coded conflicts, stock never negative', async () => {
      const U = await registerTenant(uniq('Purchase Return Race'));
      const p = await makeProduct(U.token, { openingStock: 0 });
      const supp = await makeSupplier(U.token);
      const purchase = await makePurchase(U.token, supp, p.id, 5);
      expect(await stockOf(p.id)).toBe(5);
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => post(U.token, '/api/purchase-returns', { purchaseId: purchase.id, items: [{ purchaseItemId: purchase.items[0].id, quantity: 2 }], idempotencyKey: `pr-${i}-${purchase.id}` })));
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(results.filter((r) => r.status === 201)).toHaveLength(2); // 2 + 2 of 5; the third would leave only 1
      for (const r of results.filter((x) => x.status !== 201)) expect(r.body.code).toBe('RETURN_EXCEEDS');
      expect(await stockOf(p.id)).toBe(1);

      // Goods already sold on: the return is refused against the ACTUAL stock.
      await makeSale(U.token, p.id, 1);
      const noStock = await post(U.token, '/api/purchase-returns', { purchaseId: purchase.id, items: [{ purchaseItemId: purchase.items[0].id, quantity: 1 }], idempotencyKey: uniq('ns') });
      expect(noStock.status).toBe(409);
      expect(noStock.body.code).toBe('STOCK_INSUFFICIENT');
      expect(await stockOf(p.id)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('Notes, refunds and applications replayed from several terminals', () => {
    it('one credit note issued by a replayed request is created once, with one ledger entry, however many replays race', async () => {
      const U = await registerTenant(uniq('Note Dup'));
      const cust = await makeCustomer(U.token);
      const key = uniq('nk');
      const results = await Promise.all(Array.from({ length: 6 }, () => post(U.token, '/api/credit-notes', { customerId: cust, amount: 25, reason: 'goodwill', idempotencyKey: key })));
      expect(results.filter((r) => r.status >= 400)).toHaveLength(0);
      expect(new Set(results.map((r) => r.body.item.id)).size).toBe(1);
      expect(await prisma.creditNote.count({ where: { tenantId: U.tenantId } })).toBe(1);
      expect(await prisma.journalEntry.count({ where: { tenantId: U.tenantId, sourceType: 'CREDIT_NOTE' } })).toBe(1);
      const dkey = uniq('dk');
      const supp = await makeSupplier(U.token);
      const d = await Promise.all(Array.from({ length: 5 }, () => post(U.token, '/api/debit-notes', { supplierId: supp, amount: 9, reason: 'r', idempotencyKey: dkey })));
      expect(d.filter((r) => r.status >= 400)).toHaveLength(0);
      expect(await prisma.debitNote.count({ where: { tenantId: U.tenantId } })).toBe(1);
    });

    it('a refund replayed concurrently pays out once; refunds and applications racing for one note never spend more than it holds', async () => {
      const U = await registerTenant(uniq('Note Race'));
      const p = await makeProduct(U.token);
      const cust = await makeCustomer(U.token);
      const s1 = await makeSale(U.token, p.id, 10, { customerId: cust, amountPaid: 0 });
      const s2 = await makeSale(U.token, p.id, 10, { customerId: cust, amountPaid: 0 });
      const note = (await post(U.token, '/api/credit-notes', { customerId: cust, amount: 100, reason: 'x' })).body.item;

      const rkey = uniq('rf');
      const dupRefunds = await Promise.all(Array.from({ length: 5 }, () => post(U.token, `/api/credit-notes/${note.id}/refund`, { amount: 30, method: 'cash', idempotencyKey: rkey })));
      expect(dupRefunds.filter((r) => r.status >= 400)).toHaveLength(0);
      expect(await prisma.payment.count({ where: { creditNoteId: note.id } })).toBe(1);
      expect(Number((await prisma.creditNote.findUnique({ where: { id: note.id } })).refundedAmount)).toBe(30);

      // 70 left: a 50 refund, a 50 application and a 40 application race - at most 70 can be spent.
      const results = await Promise.all([
        post(U.token, `/api/credit-notes/${note.id}/refund`, { amount: 50, idempotencyKey: uniq('r50') }),
        post(U.token, '/api/receivables/note-applications', { noteId: note.id, allocations: [{ documentId: s1.id, amount: 50 }], idempotencyKey: uniq('a50') }),
        post(U.token, '/api/receivables/note-applications', { noteId: note.id, allocations: [{ documentId: s2.id, amount: 40 }], idempotencyKey: uniq('a40') }),
      ]);
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      const n = await prisma.creditNote.findUnique({ where: { id: note.id } });
      expect(Number(n.refundedAmount) + Number(n.appliedAmount)).toBeLessThanOrEqual(100);
      for (const r of results.filter((x) => x.status >= 400)) expect(['BALANCE_CHANGED', 'DOCUMENT_NOT_OPEN']).toContain(r.body.code);
      expect(results.filter((r) => r.status < 300).length).toBeGreaterThanOrEqual(1);
      expect((await get(U.token, `${R}/reconciliation`)).body.allChecksPassed).toBe(true);
    });

    it('an application against a document that was paid meanwhile is a coded conflict and changes nothing', async () => {
      const U = await registerTenant(uniq('Stale App'));
      const p = await makeProduct(U.token);
      const cust = await makeCustomer(U.token);
      const sale = await makeSale(U.token, p.id, 4, { customerId: cust, amountPaid: 0 });
      const note = (await post(U.token, '/api/credit-notes', { customerId: cust, amount: 40, reason: 'x' })).body.item;
      await post(U.token, `/api/sales/${sale.id}/pay`, { amount: 40 }); // paid at another terminal
      const res = await post(U.token, '/api/receivables/note-applications', { noteId: note.id, allocations: [{ documentId: sale.id, amount: 40 }], idempotencyKey: uniq('st') });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('BALANCE_CHANGED');
      expect(Number((await prisma.creditNote.findUnique({ where: { id: note.id } })).appliedAmount)).toBe(0);
    });

    it('a debit-note refund and application race the same way on the payable side', async () => {
      const U = await registerTenant(uniq('Debit Race'));
      const supp = await makeSupplier(U.token);
      const p = await makeProduct(U.token, { openingStock: 0 });
      const purchase = await makePurchase(U.token, supp, p.id, 20);
      const note = (await post(U.token, '/api/debit-notes', { supplierId: supp, amount: 60, reason: 'x' })).body.item;
      const results = await Promise.all([
        post(U.token, `/api/debit-notes/${note.id}/refund`, { amount: 40, idempotencyKey: uniq('d1') }),
        post(U.token, '/api/payables/note-applications', { noteId: note.id, allocations: [{ documentId: purchase.id, amount: 40 }], idempotencyKey: uniq('d2') }),
      ]);
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      const n = await prisma.debitNote.findUnique({ where: { id: note.id } });
      expect(Number(n.refundedAmount) + Number(n.appliedAmount)).toBeLessThanOrEqual(60);
      expect(results.filter((r) => r.status < 300)).toHaveLength(1); // 40 + 40 > 60: exactly one fits
    });
  });
});
