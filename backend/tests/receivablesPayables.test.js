// Phase 2.2 - Receivables, Payables & Financial Transactions.
//
// Needs DATABASE_URL pointed at a real, throwaway Postgres database with every
// migration applied (including 20260925000000_phase2_2_...) and the permission
// catalog seeded. Payments/allocation/reversal themselves are covered by
// paymentsReceipts.test.js (Phase 1.11) and the ledger by
// chartOfAccountsGeneralLedger.test.js / accounting.test.js (Phase 2.1); this
// file covers what Phase 2.2 added or fixed: balances, statements, aging,
// credit/debit note application, the DRAFT-purchase prepayment fix, branch
// checks on the pay endpoints, and the concurrency behavior of all of it.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(60000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: `${uniq('a')}@test.local`, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}

async function userToken(adminToken, role, branchId) {
  const email = `${uniq(role.toLowerCase())}@test.local`;
  const created = await post(adminToken, '/api/users', { name: role, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`user create failed ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return login.body.token;
}

const makeCustomer = async (t, name = uniq('Cust')) => (await post(t, '/api/customers', { name })).body.item.id;
const makeSupplier = async (t, name = uniq('Supp')) => (await post(t, '/api/suppliers', { name })).body.item.id;
async function makeProduct(t) {
  const res = await post(t, '/api/products', { name: uniq('Prod'), sellingPrice: 10, purchasePrice: 5, openingStock: 100000 });
  return res.body.item.id;
}
async function makeSale(t, productId, customerId, total, amountPaid = 0, branchId) {
  const res = await post(t, '/api/sales', { customerId, branchId, items: [{ productId, quantity: total / 10, unitPrice: 10 }], paymentMethod: 'cash', amountPaid });
  if (res.status !== 201) throw new Error(`sale failed ${JSON.stringify(res.body)}`);
  return res.body.item;
}
async function makePurchase(t, productId, supplierId, total, { paid = 0, received = true, branchId } = {}) {
  const res = await post(t, '/api/purchases', { supplierId, branchId, receiveImmediately: received, amountPaid: paid, items: [{ productId, quantity: total / 5, unitCost: 5 }] });
  if (res.status !== 201) throw new Error(`purchase failed ${JSON.stringify(res.body)}`);
  return res.body.item;
}
async function makeCreditNote(t, customerId, amount, extra = {}) {
  const res = await post(t, '/api/credit-notes', { customerId, amount, reason: 'Goodwill', ...extra });
  if (res.status !== 201) throw new Error(`credit note failed ${JSON.stringify(res.body)}`);
  return res.body.item;
}
async function makeDebitNote(t, supplierId, amount, extra = {}) {
  const res = await post(t, '/api/debit-notes', { supplierId, amount, reason: 'Damaged', ...extra });
  if (res.status !== 201) throw new Error(`debit note failed ${JSON.stringify(res.body)}`);
  return res.body.item;
}
const applyCredit = (t, noteId, allocations, extra) => post(t, '/api/receivables/note-applications', { noteId, allocations, ...extra });
const applyDebit = (t, noteId, allocations, extra) => post(t, '/api/payables/note-applications', { noteId, allocations, ...extra });
const ageBy = async (model, id, days) => prisma[model].update({ where: { id }, data: { createdAt: new Date(Date.now() - days * 86400000) } });

describe('Phase 2.2 - Receivables, Payables & Financial Transactions', () => {
  let A;
  let B;
  let productA;
  let mainBranch;
  let branch2;

  beforeAll(async () => {
    A = await registerTenant(uniq('AR-AP Tenant A'));
    B = await registerTenant(uniq('AR-AP Tenant B'));
    productA = await makeProduct(A.token);
    const branches = await get(A.token, '/api/branches');
    mainBranch = branches.body.items[0].id;
    branch2 = (await post(A.token, '/api/branches', { name: uniq('Second'), code: 'B2' })).body.item.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  describe('Accounts Receivable - balances, partial payments, settlement', () => {
    it('reports invoice-level and customer outstanding, reconciled to the GL control account', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100, 40);

      const out = await get(A.token, `/api/receivables/customers/${customerId}/outstanding`);
      expect(out.status).toBe(200);
      expect(out.body.documents).toHaveLength(1);
      expect(out.body.documents[0]).toMatchObject({ id: sale.id, total: 100, amountPaid: 40, balance: 60 });
      expect(out.body.documentsDue).toBe(60);
      expect(out.body.netOutstanding).toBe(60);
      expect(out.body.glBalance).toBe(60);

      const summary = await get(A.token, '/api/receivables/summary');
      const row = summary.body.items.find((r) => r.partyId === customerId);
      expect(row).toMatchObject({ documentsDue: 60, availableCredit: 0, netOutstanding: 60, glBalance: 60, openDocuments: 1 });
    });

    it('partial payments then full settlement move the invoice UNPAID -> PARTIAL -> PAID and clear it from outstanding', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100, 0);

      expect((await post(A.token, `/api/sales/${sale.id}/pay`, { amount: 30 })).body.item.paymentStatus).toBe('PARTIAL');
      const split = await post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 70, allocations: [{ saleId: sale.id, amount: 70 }] });
      expect(split.status).toBe(201);

      const final = await prisma.sale.findUnique({ where: { id: sale.id } });
      expect(final.paymentStatus).toBe('PAID');
      expect(Number(final.amountPaid)).toBe(100);
      const out = await get(A.token, `/api/receivables/customers/${customerId}/outstanding`);
      expect(out.body.documents).toHaveLength(0);
      expect(out.body.glBalance).toBe(0);
    });

    it('one payment can be split across several invoices, and rejects duplicate or excessive allocations without touching anything', async () => {
      const customerId = await makeCustomer(A.token);
      const s1 = await makeSale(A.token, productA, customerId, 100);
      const s2 = await makeSale(A.token, productA, customerId, 50);

      const ok = await post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 120, allocations: [{ saleId: s1.id, amount: 100 }, { saleId: s2.id, amount: 20 }] });
      expect(ok.status).toBe(201);
      expect(ok.body.item.allocations).toHaveLength(2);

      const dup = await post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 20, allocations: [{ saleId: s2.id, amount: 10 }, { saleId: s2.id, amount: 10 }] });
      expect(dup.status).toBe(422);

      const tooMuch = await post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 40, allocations: [{ saleId: s2.id, amount: 40 }] });
      expect(tooMuch.status).toBe(422);
      const after = await prisma.sale.findUnique({ where: { id: s2.id } });
      expect(Number(after.amountPaid)).toBe(20);
    });

    it('rejects an allocation to another customer\'s invoice and to a reversed invoice', async () => {
      const c1 = await makeCustomer(A.token);
      const c2 = await makeCustomer(A.token);
      const other = await makeSale(A.token, productA, c2, 50);
      const wrong = await post(A.token, '/api/payments', { direction: 'IN', customerId: c1, amount: 10, allocations: [{ saleId: other.id, amount: 10 }] });
      expect(wrong.status).toBe(422);

      const reversed = await makeSale(A.token, productA, c1, 50);
      await post(A.token, `/api/sales/${reversed.id}/reverse`);
      const onReversed = await post(A.token, '/api/payments', { direction: 'IN', customerId: c1, amount: 10, allocations: [{ saleId: reversed.id, amount: 10 }] });
      expect(onReversed.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  describe('Credit notes applied to invoices (AR)', () => {
    it('applies a credit note to an invoice with no journal impact and keeps every balance consistent', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100, 40);
      const note = await makeCredit(customerId, 30);

      const before = await get(A.token, `/api/receivables/customers/${customerId}/outstanding`);
      expect(before.body).toMatchObject({ documentsDue: 60, availableCredit: 30, netOutstanding: 30, glBalance: 30 });
      const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } });

      const res = await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 30 }]);
      expect(res.status).toBe(201);
      expect(Number(res.body.item.amount)).toBe(30);

      expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(entriesBefore);
      const after = await get(A.token, `/api/receivables/customers/${customerId}/outstanding`);
      expect(after.body).toMatchObject({ documentsDue: 30, availableCredit: 0, netOutstanding: 30, glBalance: 30 });
      const refreshedNote = await prisma.creditNote.findUnique({ where: { id: note.id } });
      expect(Number(refreshedNote.appliedAmount)).toBe(30);
      expect((await prisma.sale.findUnique({ where: { id: sale.id } })).paymentStatus).toBe('PARTIAL');
    });

    async function makeCredit(customerId, amount) {
      return makeCreditNote(A.token, customerId, amount);
    }

    it('rejects over-application, foreign-customer documents, duplicate documents and a second application beyond the credit', async () => {
      const c1 = await makeCustomer(A.token);
      const c2 = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, c1, 100);
      const foreign = await makeSale(A.token, productA, c2, 100);
      const note = await makeCredit(c1, 40);

      expect((await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 50 }])).status).toBe(422);
      expect((await applyCredit(A.token, note.id, [{ documentId: foreign.id, amount: 10 }])).status).toBe(422);
      expect((await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 10 }, { documentId: sale.id, amount: 10 }])).status).toBe(422);
      expect((await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 30 }])).status).toBe(201);
      expect((await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 20 }])).status).toBe(422);

      const small = await makeSale(A.token, productA, c1, 10);
      const note2 = await makeCredit(c1, 50);
      const bigger = await applyCredit(A.token, note2.id, [{ documentId: small.id, amount: 11 }]);
      expect(bigger.status).toBe(422);
      expect(Number((await prisma.sale.findUnique({ where: { id: small.id } })).amountPaid)).toBe(0);
    });

    it('a note can be split across several invoices and its remaining credit is what a refund may take', async () => {
      const customerId = await makeCustomer(A.token);
      const s1 = await makeSale(A.token, productA, customerId, 20);
      const s2 = await makeSale(A.token, productA, customerId, 20);
      const note = await makeCredit(customerId, 50);
      expect((await applyCredit(A.token, note.id, [{ documentId: s1.id, amount: 20 }, { documentId: s2.id, amount: 20 }])).status).toBe(201);

      const tooMuch = await post(A.token, `/api/credit-notes/${note.id}/refund`, { amount: 11 });
      expect(tooMuch.status).toBe(422);
      const ok = await post(A.token, `/api/credit-notes/${note.id}/refund`, { amount: 10 });
      expect(ok.status).toBe(200);
      const n = await prisma.creditNote.findUnique({ where: { id: note.id } });
      expect(Number(n.refundedAmount) + Number(n.appliedAmount)).toBe(50);
    });

    it('reversing an application restores the invoice and the credit; cancel/reverse guards protect applied notes and invoices', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const note = await makeCredit(customerId, 25);
      const applied = await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 25 }]);

      expect((await post(A.token, `/api/credit-notes/${note.id}/cancel`)).status).toBe(409);
      expect((await post(A.token, `/api/sales/${sale.id}/reverse`)).status).toBe(409);

      const rev = await post(A.token, `/api/receivables/note-applications/${applied.body.item.id}/reverse`);
      expect(rev.status).toBe(200);
      expect(rev.body.item.status).toBe('REVERSED');
      expect(Number((await prisma.sale.findUnique({ where: { id: sale.id } })).amountPaid)).toBe(0);
      expect(Number((await prisma.creditNote.findUnique({ where: { id: note.id } })).appliedAmount)).toBe(0);
      expect((await post(A.token, `/api/receivables/note-applications/${applied.body.item.id}/reverse`)).status).toBe(409);
      expect((await post(A.token, `/api/credit-notes/${note.id}/cancel`)).status).toBe(200);
    });

    it('a cancelled note can no longer be applied', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const note = await makeCredit(customerId, 25);
      await post(A.token, `/api/credit-notes/${note.id}/cancel`);
      expect((await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 10 }])).status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  describe('Accounts Payable - balances, payments, debit notes', () => {
    it('reports purchase-level and supplier outstanding, reconciled to the GL control account', async () => {
      const supplierId = await makeSupplier(A.token);
      const purchase = await makePurchase(A.token, productA, supplierId, 200, { paid: 50 });
      const out = await get(A.token, `/api/payables/suppliers/${supplierId}/outstanding`);
      expect(out.status).toBe(200);
      expect(out.body.documents[0]).toMatchObject({ id: purchase.id, total: 200, amountPaid: 50, balance: 150 });
      expect(out.body).toMatchObject({ documentsDue: 150, netOutstanding: 150, glBalance: 150 });
      const summary = await get(A.token, '/api/payables/summary');
      expect(summary.body.items.find((r) => r.partyId === supplierId)).toMatchObject({ documentsDue: 150, glBalance: 150 });
    });

    it('partial and full supplier payments, including one payment across several purchases', async () => {
      const supplierId = await makeSupplier(A.token);
      const p1 = await makePurchase(A.token, productA, supplierId, 100);
      const p2 = await makePurchase(A.token, productA, supplierId, 50);
      expect((await post(A.token, `/api/purchases/${p1.id}/pay`, { amount: 40 })).body.item.paymentStatus).toBe('PARTIAL');
      const split = await post(A.token, '/api/payments', { direction: 'OUT', supplierId, amount: 110, allocations: [{ purchaseId: p1.id, amount: 60 }, { purchaseId: p2.id, amount: 50 }] });
      expect(split.status).toBe(201);
      expect((await prisma.purchase.findUnique({ where: { id: p1.id } })).paymentStatus).toBe('PAID');
      expect((await prisma.purchase.findUnique({ where: { id: p2.id } })).paymentStatus).toBe('PAID');
      expect((await get(A.token, `/api/payables/suppliers/${supplierId}/outstanding`)).body.glBalance).toBe(0);
      expect((await post(A.token, '/api/payments', { direction: 'OUT', supplierId, amount: 10, allocations: [{ purchaseId: p1.id, amount: 10 }] })).status).toBe(422);
    });

    it('applies a debit note to a purchase (no journal impact) and enforces the same guards as credit notes', async () => {
      const supplierId = await makeSupplier(A.token);
      const other = await makeSupplier(A.token);
      const purchase = await makePurchase(A.token, productA, supplierId, 100);
      const foreign = await makePurchase(A.token, productA, other, 100);
      const note = await makeDebitNote(A.token, supplierId, 30);
      const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } });

      expect((await applyDebit(A.token, note.id, [{ documentId: foreign.id, amount: 10 }])).status).toBe(422);
      expect((await applyDebit(A.token, note.id, [{ documentId: purchase.id, amount: 40 }])).status).toBe(422);
      const res = await applyDebit(A.token, note.id, [{ documentId: purchase.id, amount: 30 }]);
      expect(res.status).toBe(201);
      expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(entriesBefore);

      const out = await get(A.token, `/api/payables/suppliers/${supplierId}/outstanding`);
      expect(out.body).toMatchObject({ documentsDue: 70, availableCredit: 0, netOutstanding: 70, glBalance: 70 });
      expect((await post(A.token, `/api/debit-notes/${note.id}/cancel`)).status).toBe(409);
      expect((await post(A.token, `/api/purchases/${purchase.id}/return`)).status).toBe(409);
      expect((await post(A.token, `/api/payables/note-applications/${res.body.item.id}/reverse`)).status).toBe(200);
      expect(Number((await prisma.purchase.findUnique({ where: { id: purchase.id } })).amountPaid)).toBe(0);
    });

    it('a payment to a DRAFT purchase is posted to Advance-to-Suppliers (not Payable), so receiving the purchase does not double-clear it', async () => {
      const supplierId = await makeSupplier(A.token);
      const draft = await makePurchase(A.token, productA, supplierId, 100, { received: false });
      const res = await post(A.token, '/api/payments', { direction: 'OUT', supplierId, amount: 40, allocations: [{ purchaseId: draft.id, amount: 40 }] });
      expect(res.status).toBe(201);

      const entry = await prisma.journalEntry.findFirst({ where: { tenantId: A.tenantId, sourceType: 'PAYMENT', sourceId: res.body.item.id }, include: { lines: { include: { account: true } } } });
      const keys = entry.lines.map((l) => `${l.account.systemKey}:${Number(l.debit)}:${Number(l.credit)}`).sort();
      expect(keys).toEqual(['ADVANCE_TO_SUPPLIERS:40:0', 'CASH:0:40'].sort());

      // Receive it: Payable ends at 60 and the Advance asset nets to zero.
      expect((await post(A.token, `/api/purchases/${draft.id}/receive`)).status).toBe(200);
      const out = await get(A.token, `/api/payables/suppliers/${supplierId}/outstanding`);
      expect(out.body.documentsDue).toBe(60);
      expect(out.body.glBalance).toBe(60);
      const advance = await prisma.journalLine.aggregate({
        where: { account: { tenantId: A.tenantId, systemKey: 'ADVANCE_TO_SUPPLIERS' }, supplierId },
        _sum: { debit: true, credit: true },
      });
      expect(Number(advance._sum.debit) - Number(advance._sum.credit)).toBe(0);

      // The prepayment can no longer be reversed independently (would credit the advance twice).
      expect((await post(A.token, `/api/payments/${res.body.item.id}/reverse`)).status).toBe(409);
    });

    it('a DRAFT-purchase prepayment can still be reversed while the purchase is a draft', async () => {
      const supplierId = await makeSupplier(A.token);
      const draft = await makePurchase(A.token, productA, supplierId, 100, { received: false });
      const res = await post(A.token, '/api/payments', { direction: 'OUT', supplierId, amount: 40, allocations: [{ purchaseId: draft.id, amount: 40 }] });
      expect((await post(A.token, `/api/payments/${res.body.item.id}/reverse`)).status).toBe(200);
      expect(Number((await prisma.purchase.findUnique({ where: { id: draft.id } })).amountPaid)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('Payment reversal and its accounting effect', () => {
    it('reversing a customer payment reopens the invoice and reverses the ledger; the statement shows both rows and still ties to the GL', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const pay = await post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });
      expect((await get(A.token, `/api/receivables/customers/${customerId}/outstanding`)).body.glBalance).toBe(0);

      expect((await post(A.token, `/api/payments/${pay.body.item.id}/reverse`)).status).toBe(200);
      const out = await get(A.token, `/api/receivables/customers/${customerId}/outstanding`);
      expect(out.body.documentsDue).toBe(100);
      expect(out.body.glBalance).toBe(100);

      const st = await get(A.token, `/api/receivables/customers/${customerId}/statement`);
      expect(st.body.rows.map((r) => r.type)).toEqual(['INVOICE', 'PAYMENT', 'PAYMENT_REVERSAL']);
      expect(st.body.closingBalance).toBe(100);
      expect(st.body.glBalance).toBe(100);
    });

    it('a concurrent double reversal of a payment restores the invoice exactly once', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const pay = await post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 100, allocations: [{ saleId: sale.id, amount: 100 }] });
      const results = await Promise.all([1, 2, 3].map(() => post(A.token, `/api/payments/${pay.body.item.id}/reverse`)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(Number((await prisma.sale.findUnique({ where: { id: sale.id } })).amountPaid)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('Statements', () => {
    it('customer statement: invoice, inline payment, later payment and credit note with a running balance that ties to the GL', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100, 40);
      await post(A.token, `/api/sales/${sale.id}/pay`, { amount: 20 });
      await makeCreditNote(A.token, customerId, 10);

      const st = await get(A.token, `/api/receivables/customers/${customerId}/statement`);
      expect(st.status).toBe(200);
      expect(st.body.rows.map((r) => r.type)).toEqual(['INVOICE', 'PAYMENT', 'PAYMENT', 'CREDIT_NOTE']);
      expect(st.body.rows.map((r) => r.balance)).toEqual([100, 60, 40, 30]);
      expect(st.body).toMatchObject({ openingBalance: 0, totalIncrease: 100, totalDecrease: 70, closingBalance: 30, currentBalance: 30, glBalance: 30 });
    });

    it('date range: rows before "from" roll into the opening balance', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      await prisma.sale.update({ where: { id: sale.id }, data: { createdAt: new Date('2020-01-15') } });
      await post(A.token, `/api/sales/${sale.id}/pay`, { amount: 25 });

      const st = await get(A.token, `/api/receivables/customers/${customerId}/statement`, { from: '2021-01-01' });
      expect(st.body.openingBalance).toBe(100);
      expect(st.body.rows.map((r) => r.type)).toEqual(['PAYMENT']);
      expect(st.body.closingBalance).toBe(75);
      expect((await get(A.token, `/api/receivables/customers/${customerId}/statement`, { from: 'not-a-date' })).status).toBe(422);
    });

    it('a reversed invoice shows its reversal; the money already paid stays as a customer credit (and a credit note), whether paid at creation or later; both tie to the GL', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100, 30);
      await post(A.token, `/api/sales/${sale.id}/reverse`);
      const st = await get(A.token, `/api/receivables/customers/${customerId}/statement`);
      expect(st.body.rows.map((r) => r.type)).toEqual(['INVOICE', 'PAYMENT', 'INVOICE_REVERSAL']);
      expect(st.body.closingBalance).toBe(-30);
      expect(st.body.glBalance).toBe(-30);
      const held = await get(A.token, `/api/receivables/customers/${customerId}/outstanding`);
      expect(held.body).toMatchObject({ documentsDue: 0, availableCredit: 30, netOutstanding: -30, glBalance: -30 });

      // A payment made AFTER creation (its own journal entry) behaves identically.
      const c2 = await makeCustomer(A.token);
      const s2 = await makeSale(A.token, productA, c2, 100);
      await post(A.token, `/api/sales/${s2.id}/pay`, { amount: 30 });
      await post(A.token, `/api/sales/${s2.id}/reverse`);
      const st2 = await get(A.token, `/api/receivables/customers/${c2}/statement`);
      expect(st2.body.rows.map((r) => r.type)).toEqual(['INVOICE', 'PAYMENT', 'INVOICE_REVERSAL']);
      expect(st2.body.closingBalance).toBe(-30);
      expect(st2.body.glBalance).toBe(-30);
    });

    it('supplier statement: purchase, payments and a debit note, tied to the GL; a DRAFT purchase prepayment is excluded until received', async () => {
      const supplierId = await makeSupplier(A.token);
      const purchase = await makePurchase(A.token, productA, supplierId, 200, { paid: 50 });
      await post(A.token, `/api/purchases/${purchase.id}/pay`, { amount: 20 });
      await makeDebitNote(A.token, supplierId, 10);
      const st = await get(A.token, `/api/payables/suppliers/${supplierId}/statement`);
      expect(st.body.rows.map((r) => r.type)).toEqual(['PURCHASE', 'PAYMENT', 'PAYMENT', 'DEBIT_NOTE']);
      expect(st.body.rows.map((r) => r.balance)).toEqual([200, 150, 130, 120]);
      expect(st.body).toMatchObject({ closingBalance: 120, glBalance: 120 });

      const draft = await makePurchase(A.token, productA, supplierId, 100, { received: false });
      await post(A.token, `/api/purchases/${draft.id}/pay`, { amount: 40 });
      const st2 = await get(A.token, `/api/payables/suppliers/${supplierId}/statement`);
      expect(st2.body.closingBalance).toBe(120);
      expect(st2.body.glBalance).toBe(120);
    });

    it('a supplier-refunded debit note and a customer-refunded credit note show as balance-increasing refund rows', async () => {
      const customerId = await makeCustomer(A.token);
      const note = await makeCreditNote(A.token, customerId, 40);
      await post(A.token, `/api/credit-notes/${note.id}/refund`, { amount: 40 });
      const st = await get(A.token, `/api/receivables/customers/${customerId}/statement`);
      expect(st.body.rows.map((r) => r.type)).toEqual(['CREDIT_NOTE', 'CREDIT_REFUND']);
      expect(st.body.closingBalance).toBe(0);
      expect(st.body.glBalance).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('Aging', () => {
    it('AR aging uses default buckets, nets available credit separately and totals correctly', async () => {
      const T = await registerTenant(uniq('Aging AR'));
      const prod = await makeProduct(T.token);
      const cust = await makeCustomer(T.token, 'Aged Customer');
      const s1 = await makeSale(T.token, prod, cust, 100);
      const s2 = await makeSale(T.token, prod, cust, 200);
      const s3 = await makeSale(T.token, prod, cust, 50);
      const s4 = await makeSale(T.token, prod, cust, 40, 40);
      await ageBy('sale', s1.id, 5);
      await ageBy('sale', s2.id, 45);
      await ageBy('sale', s3.id, 120);
      await ageBy('sale', s4.id, 200);
      await makeCreditNote(T.token, cust, 15);

      const res = await get(T.token, '/api/receivables/aging');
      expect(res.status).toBe(200);
      expect(res.body.buckets).toEqual(['0-30', '31-60', '61-90', '90+']);
      expect(res.body.totals).toEqual({ '0-30': 100, '31-60': 200, '61-90': 0, '90+': 50 });
      expect(res.body).toMatchObject({ total: 350, availableCredit: 15, net: 335 });
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ partyName: 'Aged Customer', total: 350, availableCredit: 15, net: 335 });
    });

    it('custom buckets, asOf, per-customer filter and invoice detail', async () => {
      const T = await registerTenant(uniq('Aging AR 2'));
      const prod = await makeProduct(T.token);
      const c1 = await makeCustomer(T.token, 'C1');
      const c2 = await makeCustomer(T.token, 'C2');
      const s1 = await makeSale(T.token, prod, c1, 100);
      const s2 = await makeSale(T.token, prod, c2, 60);
      await ageBy('sale', s1.id, 8);
      await ageBy('sale', s2.id, 25);

      const res = await get(T.token, '/api/receivables/aging', { buckets: '7,14,21', detail: 'true' });
      expect(res.body.buckets).toEqual(['0-7', '8-14', '15-21', '21+']);
      expect(res.body.totals).toEqual({ '0-7': 0, '8-14': 100, '15-21': 0, '21+': 60 });
      expect(res.body.items.find((r) => r.partyName === 'C1').documents[0]).toMatchObject({ number: s1.invoiceNumber, bucket: '8-14', ageDays: 8 });

      const only = await get(T.token, '/api/receivables/aging', { partyId: c2 });
      expect(only.body.items).toHaveLength(1);
      expect(only.body.total).toBe(60);

      const later = await get(T.token, '/api/receivables/aging', { asOf: new Date(Date.now() + 40 * 86400000).toISOString() });
      expect(later.body.totals['31-60']).toBe(100);
      expect(later.body.totals['61-90']).toBe(60);
      const earlier = await get(T.token, '/api/receivables/aging', { asOf: new Date(Date.now() - 20 * 86400000).toISOString() });
      expect(earlier.body.total).toBe(60); // s1 (8 days old) was created after this asOf and is excluded
      expect(earlier.body.items.map((r) => r.partyName)).toEqual(['C2']);

      for (const bad of ['0,10', '10,5', 'a,b', '30,30', '1,2,3,4,5,6,7,8,9']) {
        expect((await get(T.token, '/api/receivables/aging', { buckets: bad })).status).toBe(422);
      }
    });

    it('AP aging buckets received purchases only, netting debit-note credit', async () => {
      const T = await registerTenant(uniq('Aging AP'));
      const prod = await makeProduct(T.token);
      const sup = await makeSupplier(T.token, 'Aged Supplier');
      const p1 = await makePurchase(T.token, prod, sup, 100);
      const p2 = await makePurchase(T.token, prod, sup, 50);
      await makePurchase(T.token, prod, sup, 500, { received: false });
      await prisma.purchase.update({ where: { id: p1.id }, data: { receivedAt: new Date(Date.now() - 10 * 86400000) } });
      await prisma.purchase.update({ where: { id: p2.id }, data: { receivedAt: new Date(Date.now() - 70 * 86400000) } });
      await makeDebitNote(T.token, sup, 20);

      const res = await get(T.token, '/api/payables/aging');
      expect(res.body.totals).toEqual({ '0-30': 100, '31-60': 0, '61-90': 50, '90+': 0 });
      expect(res.body).toMatchObject({ total: 150, availableCredit: 20, net: 130 });
    });

    it('the existing /accounting/ar-aging report is unchanged', async () => {
      const res = await get(A.token, '/api/accounting/reports/ar-aging');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.totals)).toEqual(['0-30', '31-60', '61-90', '90+']);
    });
  });

  // -------------------------------------------------------------------------
  describe('Concurrency (real concurrent HTTP requests)', () => {
    it('two payments against the same invoice can never exceed its balance', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const results = await Promise.all([
        post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 70, allocations: [{ saleId: sale.id, amount: 70 }] }),
        post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 60, allocations: [{ saleId: sale.id, amount: 60 }] }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      const paid = Number((await prisma.sale.findUnique({ where: { id: sale.id } })).amountPaid);
      expect([70, 60]).toContain(paid);
      const out = await get(A.token, `/api/receivables/customers/${customerId}/outstanding`);
      expect(out.body.glBalance).toBe(100 - paid);
    });

    it('a payment, a sale /pay and a note application racing for the same remaining balance: total settled never exceeds the invoice', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const note = await makeCreditNote(A.token, customerId, 100);
      const results = await Promise.all([
        post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 60, allocations: [{ saleId: sale.id, amount: 60 }] }),
        post(A.token, `/api/sales/${sale.id}/pay`, { amount: 60 }),
        applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 60 }]),
      ]);
      const ok = results.filter((r) => [200, 201].includes(r.status));
      expect(ok).toHaveLength(1);
      expect(results.filter((r) => r.status === 422)).toHaveLength(2);
      const s = await prisma.sale.findUnique({ where: { id: sale.id } });
      expect(Number(s.amountPaid)).toBe(60);
      expect(s.paymentStatus).toBe('PARTIAL');
    });

    it('two applications of the same note cannot together exceed the credit', async () => {
      const customerId = await makeCustomer(A.token);
      const s1 = await makeSale(A.token, productA, customerId, 100);
      const s2 = await makeSale(A.token, productA, customerId, 100);
      const note = await makeCreditNote(A.token, customerId, 100);
      const results = await Promise.all([
        applyCredit(A.token, note.id, [{ documentId: s1.id, amount: 60 }]),
        applyCredit(A.token, note.id, [{ documentId: s2.id, amount: 60 }]),
        applyCredit(A.token, note.id, [{ documentId: s1.id, amount: 60 }, { documentId: s2.id, amount: 0.01 }]),
      ]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const n = await prisma.creditNote.findUnique({ where: { id: note.id } });
      expect(Number(n.appliedAmount)).toBeLessThanOrEqual(100);
      const applications = await prisma.noteApplication.findMany({ where: { creditNoteId: note.id, status: 'ACTIVE' } });
      expect(applications.reduce((s, a) => s + Number(a.amount), 0)).toBe(Number(n.appliedAmount));
    });

    it('a refund and an application racing for the same note: exactly one wins and the note is never over-consumed', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const note = await makeCreditNote(A.token, customerId, 100);
      const results = await Promise.all([
        post(A.token, `/api/credit-notes/${note.id}/refund`, { amount: 70 }),
        applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 70 }]),
      ]);
      expect(results.filter((r) => [200, 201].includes(r.status))).toHaveLength(1);
      const n = await prisma.creditNote.findUnique({ where: { id: note.id } });
      expect(Number(n.refundedAmount) + Number(n.appliedAmount)).toBe(70);
    });

    it('a concurrent double reversal of an application releases the invoice and the note exactly once', async () => {
      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const note = await makeCreditNote(A.token, customerId, 40);
      const applied = await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 40 }]);
      const results = await Promise.all([1, 2, 3].map(() => post(A.token, `/api/receivables/note-applications/${applied.body.item.id}/reverse`)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(Number((await prisma.sale.findUnique({ where: { id: sale.id } })).amountPaid)).toBe(0);
      expect(Number((await prisma.creditNote.findUnique({ where: { id: note.id } })).appliedAmount)).toBe(0);
    });

    it('duplicate requests with one idempotency key (payment, sale pay, purchase pay, note application) apply exactly once', async () => {
      const customerId = await makeCustomer(A.token);
      const supplierId = await makeSupplier(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const sale2 = await makeSale(A.token, productA, customerId, 100);
      const purchase = await makePurchase(A.token, productA, supplierId, 100);
      const note = await makeCreditNote(A.token, customerId, 50);

      const key = uniq('idem');
      const runs = await Promise.all([
        ...[1, 2, 3, 4].map(() => post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 25, allocations: [{ saleId: sale.id, amount: 25 }], idempotencyKey: `${key}-pay` })),
        ...[1, 2, 3, 4].map(() => post(A.token, `/api/sales/${sale2.id}/pay`, { amount: 25, idempotencyKey: `${key}-sale` })),
        ...[1, 2, 3, 4].map(() => post(A.token, `/api/purchases/${purchase.id}/pay`, { amount: 25, idempotencyKey: `${key}-purchase` })),
        ...[1, 2, 3, 4].map(() => applyCredit(A.token, note.id, [{ documentId: sale2.id, amount: 20 }], { idempotencyKey: `${key}-note` })),
      ]);
      expect(runs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(runs.filter((r) => r.status === 409 || r.status === 422)).toHaveLength(0);

      expect(Number((await prisma.sale.findUnique({ where: { id: sale.id } })).amountPaid)).toBe(25);
      expect(Number((await prisma.sale.findUnique({ where: { id: sale2.id } })).amountPaid)).toBe(45);
      expect(Number((await prisma.purchase.findUnique({ where: { id: purchase.id } })).amountPaid)).toBe(25);
      expect(Number((await prisma.creditNote.findUnique({ where: { id: note.id } })).appliedAmount)).toBe(20);
      expect(await prisma.payment.count({ where: { tenantId: A.tenantId, idempotencyKey: { startsWith: key } } })).toBe(3);
    });

    it('parallel payments to different documents (receipt-number contention across /payments, sale pay and purchase pay) all succeed with unique receipts', async () => {
      const customerId = await makeCustomer(A.token);
      const supplierId = await makeSupplier(A.token);
      const sales = await Promise.all([1, 2, 3].map(() => makeSale(A.token, productA, customerId, 50)));
      const purchases = await Promise.all([1, 2, 3].map(() => makePurchase(A.token, productA, supplierId, 50)));
      const paySales = await Promise.all([1, 2, 3, 4].map(() => makeSale(A.token, productA, customerId, 50)));
      const payPurchases = await Promise.all([1, 2, 3, 4].map(() => makePurchase(A.token, productA, supplierId, 50)));
      const results = await Promise.all([
        ...sales.map((s) => post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 50, allocations: [{ saleId: s.id, amount: 50 }] })),
        ...purchases.map((p) => post(A.token, '/api/payments', { direction: 'OUT', supplierId, amount: 50, allocations: [{ purchaseId: p.id, amount: 50 }] })),
        ...paySales.map((s) => post(A.token, `/api/sales/${s.id}/pay`, { amount: 50 })),
        ...payPurchases.map((p) => post(A.token, `/api/purchases/${p.id}/pay`, { amount: 50 })),
      ]);
      // Every request is legitimate and independent: none may fail, including on a receipt-number collision.
      expect(results.filter((r) => r.status !== 200 && r.status !== 201)).toHaveLength(0);
      const created = results.filter((r) => r.status === 201);
      expect(new Set(created.map((r) => r.body.item.receiptNumber)).size).toBe(created.length);
      for (const r of created) expect(r.body.item.receiptNumber).toBeTruthy();
      const receipts = await prisma.payment.findMany({ where: { tenantId: A.tenantId, customerId }, select: { receiptNumber: true } });
      expect(new Set(receipts.map((p) => p.receiptNumber)).size).toBe(receipts.length);
    });

    it('no document ever ends with a negative or over-total amountPaid', async () => {
      const sales = await prisma.sale.findMany({ where: { tenantId: A.tenantId } });
      const purchases = await prisma.purchase.findMany({ where: { tenantId: A.tenantId } });
      for (const d of [...sales, ...purchases]) {
        expect(Number(d.amountPaid)).toBeGreaterThanOrEqual(0);
        expect(Number(d.amountPaid)).toBeLessThanOrEqual(Number(d.total) + 0.0001);
      }
      const notes = [...(await prisma.creditNote.findMany({ where: { tenantId: A.tenantId } })), ...(await prisma.debitNote.findMany({ where: { tenantId: A.tenantId } }))];
      for (const n of notes) expect(Number(n.refundedAmount) + Number(n.appliedAmount)).toBeLessThanOrEqual(Number(n.amount) + 0.0001);
    });
  });

  // -------------------------------------------------------------------------
  describe('RBAC', () => {
    it('finance roles read aging/summary; a doctor cannot; a cashier may apply credit but not reverse an application', async () => {
      const doctor = await userToken(A.token, 'DOCTOR');
      const cashier = await userToken(A.token, 'CASHIER');
      const accountant = await userToken(A.token, 'ACCOUNTANT');

      expect((await get(doctor, '/api/receivables/aging')).status).toBe(403);
      expect((await get(doctor, '/api/payables/summary')).status).toBe(403);
      expect((await get(accountant, '/api/receivables/aging')).status).toBe(200);
      expect((await get(accountant, '/api/payables/aging')).status).toBe(200);

      const customerId = await makeCustomer(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const note = await makeCreditNote(A.token, customerId, 20);
      expect((await applyCredit(doctor, note.id, [{ documentId: sale.id, amount: 20 }])).status).toBe(403);
      const applied = await applyCredit(cashier, note.id, [{ documentId: sale.id, amount: 20 }]);
      expect(applied.status).toBe(201);
      expect((await post(cashier, `/api/receivables/note-applications/${applied.body.item.id}/reverse`)).status).toBe(403);
      expect((await get(doctor, `/api/receivables/customers/${customerId}/statement`)).status).toBe(403);
      expect((await get(cashier, `/api/receivables/customers/${customerId}/statement`)).status).toBe(200);
    });

    it('rejects unauthenticated access and unknown fields', async () => {
      expect((await request(app).get('/api/receivables/summary')).status).toBe(401);
      const customerId = await makeCustomer(A.token);
      const bad = await post(A.token, '/api/receivables/note-applications', { noteId: '00000000-0000-4000-8000-000000000000', allocations: [{ documentId: '00000000-0000-4000-8000-000000000000', amount: 1, extra: true }] });
      expect(bad.status).toBe(422);
      expect(customerId).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  describe('Tenant isolation', () => {
    it('another tenant cannot read statements/outstanding, apply notes, pay or reverse', async () => {
      const customerId = await makeCustomer(A.token);
      const supplierId = await makeSupplier(A.token);
      const sale = await makeSale(A.token, productA, customerId, 100);
      const purchase = await makePurchase(A.token, productA, supplierId, 100);
      const note = await makeCreditNote(A.token, customerId, 20);
      const pay = await post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 10, allocations: [{ saleId: sale.id, amount: 10 }] });

      expect((await get(B.token, `/api/receivables/customers/${customerId}/statement`)).status).toBe(404);
      expect((await get(B.token, `/api/receivables/customers/${customerId}/outstanding`)).status).toBe(404);
      expect((await get(B.token, `/api/payables/suppliers/${supplierId}/statement`)).status).toBe(404);
      expect((await applyCredit(B.token, note.id, [{ documentId: sale.id, amount: 5 }])).status).toBe(404);
      expect((await post(B.token, `/api/payments/${pay.body.item.id}/reverse`)).status).toBe(404);
      expect((await post(B.token, `/api/purchases/${purchase.id}/pay`, { amount: 5 })).status).toBe(404);
      const summary = await get(B.token, '/api/receivables/summary');
      expect(summary.body.items.find((r) => r.partyId === customerId)).toBeUndefined();
      expect((await get(B.token, '/api/receivables/aging', { partyId: customerId })).body.items).toHaveLength(0);

      // A's application is invisible to B.
      const applied = await applyCredit(A.token, note.id, [{ documentId: sale.id, amount: 5 }]);
      expect((await get(B.token, `/api/receivables/note-applications/${applied.body.item.id}`)).status).toBe(404);
      expect((await post(B.token, `/api/receivables/note-applications/${applied.body.item.id}/reverse`)).status).toBe(404);
      expect((await get(B.token, '/api/receivables/note-applications')).body.items).toHaveLength(0);
    });

    it('the same idempotency key in two tenants does not cross-deduplicate', async () => {
      const key = uniq('shared-key');
      const ca = await makeCustomer(A.token);
      const cb = await makeCustomer(B.token);
      const prodB = await makeProduct(B.token);
      const sa = await makeSale(A.token, productA, ca, 50);
      const sb = await makeSale(B.token, prodB, cb, 50);
      const na = await makeCreditNote(A.token, ca, 10);
      const nb = await makeCreditNote(B.token, cb, 10);
      const ra = await applyCredit(A.token, na.id, [{ documentId: sa.id, amount: 10 }], { idempotencyKey: key });
      const rb = await applyCredit(B.token, nb.id, [{ documentId: sb.id, amount: 10 }], { idempotencyKey: key });
      expect(ra.status).toBe(201);
      expect(rb.status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  describe('Branch isolation', () => {
    it('a branch-restricted user cannot see, pay, apply credit to or reverse another branch\'s documents', async () => {
      const cashier1 = await userToken(A.token, 'CASHIER', mainBranch);
      const customerId = await makeCustomer(A.token);
      const supplierId = await makeSupplier(A.token);
      const mainSale = await makeSale(A.token, productA, customerId, 100, 0, mainBranch);
      const otherSale = await makeSale(A.token, productA, customerId, 70, 0, branch2);
      const otherPurchase = await makePurchase(A.token, productA, supplierId, 70, { branchId: branch2 });
      const otherNote = await makeCreditNote(A.token, customerId, 20, { branchId: branch2 });
      const mainNote = await makeCreditNote(A.token, customerId, 20, { branchId: mainBranch });

      // Reads are scoped.
      const out = await get(cashier1, `/api/receivables/customers/${customerId}/outstanding`);
      expect(out.body.documents.map((d) => d.id)).toEqual([mainSale.id]);
      expect(out.body.notes.map((n) => n.id)).toEqual([mainNote.id]);
      const aging = await get(A.token, '/api/receivables/aging', { detail: 'true' });
      expect(aging.status).toBe(200);

      // Writes across the boundary are refused.
      expect((await post(cashier1, `/api/sales/${otherSale.id}/pay`, { amount: 10 })).status).toBe(403);
      expect((await post(cashier1, `/api/purchases/${otherPurchase.id}/pay`, { amount: 10 })).status).toBe(403);
      expect((await post(cashier1, '/api/payments', { direction: 'IN', customerId, amount: 10, allocations: [{ saleId: otherSale.id, amount: 10 }] })).status).toBe(403);
      expect((await applyCredit(cashier1, otherNote.id, [{ documentId: mainSale.id, amount: 10 }])).status).toBe(403);
      expect((await applyCredit(cashier1, mainNote.id, [{ documentId: otherSale.id, amount: 10 }])).status).toBe(403);
      expect(Number((await prisma.sale.findUnique({ where: { id: otherSale.id } })).amountPaid)).toBe(0);

      // ...while the same actions inside the user's own branch work.
      expect((await post(cashier1, `/api/sales/${mainSale.id}/pay`, { amount: 10 })).status).toBe(200);
      expect((await applyCredit(cashier1, mainNote.id, [{ documentId: mainSale.id, amount: 10 }])).status).toBe(201);

      // A payment attributed to the other branch is neither readable nor reversible by id.
      const payOther = await post(A.token, '/api/payments', { direction: 'IN', customerId, amount: 10, allocations: [{ saleId: otherSale.id, amount: 10 }] });
      expect((await get(cashier1, `/api/payments/${payOther.body.item.id}`)).status).toBe(403);
      const mgr = await userToken(A.token, 'MANAGER');
      expect((await get(mgr, `/api/payments/${payOther.body.item.id}`)).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('Existing behavior is unchanged', () => {
    it('customer history and supplier ledger balances still agree with the new outstanding view', async () => {
      const customerId = await makeCustomer(A.token);
      const supplierId = await makeSupplier(A.token);
      await makeSale(A.token, productA, customerId, 100, 40);
      await makePurchase(A.token, productA, supplierId, 80, { paid: 30 });
      const hist = await get(A.token, `/api/customers/${customerId}/history`);
      const led = await get(A.token, `/api/suppliers/${supplierId}/ledger`);
      expect(hist.body.balanceDue).toBe(60);
      expect(led.body.balanceDue).toBe(50);
      expect((await get(A.token, `/api/receivables/customers/${customerId}/outstanding`)).body.documentsDue).toBe(hist.body.balanceDue);
      expect((await get(A.token, `/api/payables/suppliers/${supplierId}/outstanding`)).body.documentsDue).toBe(led.body.balanceDue);
    });

    it('trial balance still balances after all of the above', async () => {
      const tb = await get(A.token, '/api/accounting/reports/trial-balance');
      expect(tb.status).toBe(200);
      expect(Math.round(tb.body.totalDebit * 100)).toBe(Math.round(tb.body.totalCredit * 100));
    });
  });
});
