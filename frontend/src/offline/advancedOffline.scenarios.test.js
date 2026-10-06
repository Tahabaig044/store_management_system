// Phase 3.3: end-to-end behavior of offline returns, credit/debit notes, applications and refunds, and of
// edit-and-retry, against an in-memory stand-in for the server. The stand-in mirrors the rules that matter
// (idempotency keys, returnedQuantity guard, note credit guard, document balance guard, the coded errors and
// their `details`); each is proven against the REAL server with real concurrent HTTP in
// backend/tests/offlineAdvanced.test.js. Everything on the client (IndexedDB, queue, coordinator, derived
// views, edit rules) is the real code on fake-indexeddb.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient from '../api/client';
import { getOfflineDb, setOfflineScope, closeOfflineDb } from './db';
import { OUTBOXES } from './syncEngine';
import { processQueue, retryEntry } from './syncCoordinator';
import { syncLocalData as realSync } from './localData';
import { refTo } from './syncCore';
import { secureState } from './secureStore';
import { unlockFor } from '../test/secure';
import { getReturnableSales, getOpenNotes, getOpenDocuments } from './derivedViews';
import { suggestEdit, updateQueuedEntry } from './editing';

vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const httpError = (status, code, error, details) => ({ response: { status, data: { code, error, ...(details ? { details } : {}) } } });
const netError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

class FakeServer {
  constructor() {
    this.clock = Date.parse('2026-06-01T10:00:00Z');
    this.seq = 0;
    this.products = new Map();
    this.sales = new Map(); // id -> { id, invoiceNumber, customerId, warehouseId, items:[{id,productId,name,quantity,returnedQuantity,unitPrice}], total, amountPaid }
    this.notes = new Map(); // id -> { id, side, partyId, amount, refunded, applied }
    this.customers = new Map();
    this.returns = [];
    this.applications = [];
    this.refunds = [];
    this.byKey = new Map();
    this.loseReply = 0;
  }

  id(p) { this.seq += 1; return `${p}-${this.seq}`; }
  tick() { this.clock += 1000; return new Date(this.clock).toISOString(); }
  addProduct(id, stock) { this.products.set(id, { id, name: id, stock, updatedAt: this.tick() }); }
  addCustomer(id) { this.customers.set(id, { id, name: id }); }
  addSale(id, customerId, lines, amountPaid = 0) {
    const items = lines.map((l, i) => ({ id: `${id}-i${i}`, productId: l.productId, name: l.productId, quantity: l.quantity, returnedQuantity: 0, unitPrice: 10 }));
    const total = items.reduce((s, i) => s + i.quantity * 10, 0);
    this.sales.set(id, { id, invoiceNumber: `INV-${id}`, customerId, warehouseId: null, items, total, amountPaid, status: 'COMPLETED', createdAt: this.tick() });
    return this.sales.get(id);
  }
  addNote(id, partyId, amount) { this.notes.set(id, { id, side: 'credit', partyId, amount, refunded: 0, applied: 0, number: `CN-${id}` }); }
  noteAvailable(n) { return Math.round((n.amount - n.refunded - n.applied) * 100) / 100; }

  install() {
    apiClient.post.mockImplementation((path, body) => this.post(path, body));
    apiClient.get.mockImplementation((path, config) => this.get(path, config));
    return this;
  }

  datasetRows(name) {
    if (name === 'products') return [...this.products.values()].map((p) => ({ id: p.id, name: p.name, stockQuantity: p.stock, isActive: true }));
    if (name === 'returnableSales') return [...this.sales.values()].filter((s) => s.items.some((i) => i.returnedQuantity < i.quantity)).map((s) => ({ id: s.id, invoiceNumber: s.invoiceNumber, customerId: s.customerId, customerName: s.customerId, warehouseId: s.warehouseId, createdAt: s.createdAt, total: s.total, items: s.items.map((i) => ({ ...i })), isActive: true }));
    if (name === 'arDocuments') return [...this.sales.values()].filter((s) => s.total - s.amountPaid > 0.005).map((s) => ({ id: s.id, number: s.invoiceNumber, partyId: s.customerId, partyName: s.customerId, total: s.total, amountPaid: s.amountPaid, balance: s.total - s.amountPaid, isActive: true }));
    if (name === 'arNotes') return [...this.notes.values()].filter((n) => this.noteAvailable(n) > 0.005).map((n) => ({ id: n.id, number: n.number, partyId: n.partyId, partyName: n.partyId, amount: n.amount, available: this.noteAvailable(n), isActive: true }));
    return [];
  }

  async get(path) {
    if (this.down) throw netError();
    if (path === '/offline/manifest') {
      const datasets = {};
      for (const n of ['products', 'customers', 'suppliers', 'expenseCategories', 'branches', 'warehouses', 'warehouseStock', 'returnableSales', 'arDocuments', 'arNotes']) {
        const rows = this.datasetRows(n);
        // a "version" that changes whenever the content does
        datasets[n] = { count: rows.length, maxUpdatedAt: JSON.stringify(rows).length };
      }
      return { data: { serverTime: new Date(this.clock).toISOString(), schemaVersion: 1, scope: { tenantId: 't', userId: 'u', role: 'TENANT_ADMIN', branchIds: null, warehouseIds: null }, datasets } };
    }
    const name = path.replace('/offline/datasets/', '');
    return { data: { dataset: name, items: this.datasetRows(name), nextCursor: null, serverTime: new Date(this.clock).toISOString(), delta: false } };
  }

  async post(path, body) {
    if (this.down) throw netError();
    const result = this.apply(path, body);
    if (this.loseReply > 0) {
      this.loseReply -= 1;
      throw netError();
    }
    return { data: result };
  }

  dedupe(path, body, create) {
    const key = body?.idempotencyKey;
    if (key && this.byKey.has(`${path}:${key}`)) return { item: this.byKey.get(`${path}:${key}`), deduplicated: true };
    const item = create();
    if (key) this.byKey.set(`${path}:${key}`, item);
    return { item };
  }

  apply(path, body) {
    if (path === '/sales-returns') {
      return this.dedupe(path, body, () => {
        const sale = this.sales.get(body.saleId);
        if (!sale) throw httpError(404, 'NOT_FOUND', 'Sale not found');
        for (const l of body.items) {
          const item = sale.items.find((i) => i.id === l.saleItemId);
          const remaining = item.quantity - item.returnedQuantity;
          if (l.quantity > remaining + 0.0001) throw httpError(422, 'RETURN_EXCEEDS', `Cannot return ${l.quantity}; only ${remaining} remain`, { saleItemId: item.id, remaining });
        }
        for (const l of body.items) {
          const item = sale.items.find((i) => i.id === l.saleItemId);
          item.returnedQuantity += l.quantity;
          this.products.get(item.productId).stock += l.quantity;
          this.products.get(item.productId).updatedAt = this.tick();
        }
        const r = { id: this.id('ret'), saleId: sale.id, items: body.items, createdAt: body.occurredAt || this.tick() };
        this.returns.push(r);
        return r;
      });
    }
    if (path === '/customers') return this.dedupe(path, body, () => { const c = { id: this.id('cust'), name: body.name }; this.customers.set(c.id, c); return c; });
    if (path === '/credit-notes') {
      return this.dedupe(path, body, () => {
        if (!this.customers.has(body.customerId)) throw httpError(404, 'NOT_FOUND', 'Customer not found');
        const n = { id: this.id('cn'), side: 'credit', partyId: body.customerId, amount: body.amount + (body.tax || 0), refunded: 0, applied: 0, createdAt: body.occurredAt || this.tick(), number: `CN-${this.seq}` };
        this.notes.set(n.id, n);
        return n;
      });
    }
    const refund = /^\/credit-notes\/([^/]+)\/refund$/.exec(path);
    if (refund) {
      return this.dedupe(path, body, () => {
        const n = this.notes.get(refund[1]);
        if (!n) throw httpError(404, 'NOT_FOUND', 'Note not found');
        if (body.amount > this.noteAvailable(n) + 0.005) throw httpError(422, 'BALANCE_CHANGED', 'Refund would exceed the credit still available', { available: this.noteAvailable(n) });
        n.refunded += body.amount;
        const r = { id: this.id('ref'), amount: body.amount, paidAt: body.occurredAt || this.tick() };
        this.refunds.push(r);
        return r;
      });
    }
    if (path === '/receivables/note-applications') {
      return this.dedupe(path, body, () => {
        const n = this.notes.get(body.noteId);
        if (!n) throw httpError(404, 'NOT_FOUND', 'Note not found');
        const total = body.allocations.reduce((s, a) => s + a.amount, 0);
        if (total > this.noteAvailable(n) + 0.005) throw httpError(422, 'BALANCE_CHANGED', 'Allocation exceeds the credit still available', { available: this.noteAvailable(n) });
        for (const a of body.allocations) {
          const s = this.sales.get(a.documentId);
          if (!s) throw httpError(404, 'NOT_FOUND', 'Invoice not found');
          const balance = s.total - s.amountPaid;
          if (a.amount > balance + 0.005) throw httpError(422, 'BALANCE_CHANGED', 'Amount would exceed the invoice balance', { documentId: s.id, balance });
        }
        n.applied += total;
        for (const a of body.allocations) this.sales.get(a.documentId).amountPaid += a.amount;
        const app = { id: this.id('app'), amount: total, createdAt: body.occurredAt || this.tick() };
        this.applications.push(app);
        return app;
      });
    }
    throw httpError(404, 'NOT_FOUND', `no route ${path}`);
  }
}

// A signed-in terminal has the key that seals personal data.
const syncLocalData = async (tenantId, opts) => {
  if (secureState(tenantId) !== 'unlocked') await unlockFor(tenantId);
  return realSync(tenantId, opts);
};
const TENANT = 'adv-tenant';
const as = (name) => { setOfflineScope({ tenantId: TENANT, userId: name }); return TENANT; };
let server;
let n = 0;
const newTerminal = () => `t-${crypto.randomUUID()}-${(n += 1)}`;

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  setOnline(true);
  closeOfflineDb();
  setOfflineScope(null);
  server = new FakeServer().install();
});
afterEach(() => { setOnline(true); setOfflineScope(null); });

const returnFor = (sale, qty, extra = {}) => ({
  saleId: sale.id,
  items: [{ saleItemId: sale.items[0].id, quantity: qty }],
  _display: { products: { [sale.items[0].id]: sale.items[0].productId }, lines: { [sale.items[0].id]: sale.items[0].productId } },
  ...extra,
});

describe('Offline returns', () => {
  it('a return made offline restocks locally at once, cannot exceed what can be returned (queued ones count), and is accepted once with its original time on reconnect', async () => {
    server.addProduct('p1', 7);
    const sale = server.addSale('s1', null, [{ productId: 'p1', quantity: 3 }]);
    const A = as(newTerminal());
    await syncLocalData(A);
    expect((await getReturnableSales(A))[0].items[0].remaining).toBe(3);

    setOnline(false);
    const first = await OUTBOXES.salesReturns.submit(A, returnFor(sale, 2));
    expect(first.status).toBe('pending');
    expect((await getOfflineDb(A).products.get('p1')).stockQuantity).toBe(9); // goods are back on the shelf, locally
    expect((await getReturnableSales(A))[0].items[0]).toMatchObject({ remaining: 1, queuedQuantity: 2 });
    await expect(OUTBOXES.salesReturns.queue(A, returnFor(sale, 2))).rejects.toThrow(/Only 1 of p1 can still be returned/);
    expect(await OUTBOXES.salesReturns.listPending(A)).toHaveLength(1); // the refused one was never stored

    setOnline(true);
    expect(await processQueue(A, { force: true })).toMatchObject({ synced: 1 });
    expect(server.returns).toHaveLength(1);
    expect(server.returns[0].createdAt).toBe(first.payload.occurredAt); // the time it was made, not the sync time
    expect(server.sales.get('s1').items[0].returnedQuantity).toBe(2);
    await syncLocalData(A);
    expect((await getOfflineDb(A).products.get('p1')).stockQuantity).toBe(9); // server 9, nothing double counted
  });

  it('a reply lost after the server applied the return is replayed with the same key and applied exactly once', async () => {
    server.addProduct('p1', 5);
    const sale = server.addSale('s1', null, [{ productId: 'p1', quantity: 3 }]);
    const A = as(newTerminal());
    await syncLocalData(A);
    const entry = await OUTBOXES.salesReturns.queue(A, returnFor(sale, 3));
    server.loseReply = 1;
    await processQueue(A, { force: true });
    expect((await getOfflineDb(A).pendingSalesReturns.get(entry.clientId)).maybeApplied).toBe(true);
    await retryEntry(A, 'pendingSalesReturns', entry.clientId);
    expect((await getOfflineDb(A).pendingSalesReturns.get(entry.clientId)).status).toBe('synced');
    expect(server.returns).toHaveLength(1);
    expect(server.sales.get('s1').items[0].returnedQuantity).toBe(3);
  });
});

describe('Two terminals returning the same goods: conflict and edit-and-retry', () => {
  it('the slower terminal gets a visible RETURN_EXCEEDS with the facts, applies the suggested edit and is accepted - together they never return more than was sold', async () => {
    server.addProduct('p1', 0);
    const sale = server.addSale('s1', null, [{ productId: 'p1', quantity: 3 }]);
    const A = as('terminal-A');
    await syncLocalData(A);
    const B = as('terminal-B');
    await syncLocalData(B);

    setOnline(false);
    as('terminal-A');
    const a = await OUTBOXES.salesReturns.submit(A, returnFor(sale, 2));
    as('terminal-B');
    const b = await OUTBOXES.salesReturns.submit(B, returnFor(sale, 2));
    setOnline(true);

    as('terminal-B');
    expect(await processQueue(B, { force: true })).toMatchObject({ synced: 1 }); // B gets there first
    as('terminal-A');
    expect(await processQueue(A, { force: true })).toMatchObject({ conflicts: 1 });
    const conflict = await getOfflineDb(A).pendingSalesReturns.get(a.clientId);
    expect(conflict.status).toBe('conflict');
    expect(conflict.failure).toMatchObject({ kind: 'RETURN_EXCEEDS', details: { remaining: 1 } });
    // Convergence: the refused return took no effect, so after the next download A shows the server's stock (B's 2 restocked).
    await syncLocalData(A);
    expect((await getOfflineDb(A).products.get('p1')).stockQuantity).toBe(2);
    void b;

    const suggestion = suggestEdit('pendingSalesReturns', conflict);
    expect(suggestion.summary).toMatch(/Reduce the returned quantity to the 1 still returnable/);
    await updateQueuedEntry(A, 'pendingSalesReturns', a.clientId, suggestion.payload, { note: suggestion.summary });
    const edited = await getOfflineDb(A).pendingSalesReturns.get(a.clientId);
    expect(edited.payload.idempotencyKey).toBe(a.payload.idempotencyKey); // same identity
    expect(edited.payload.occurredAt).toBe(a.payload.occurredAt); // same event time
    expect(edited.revisions[0].resolved.kind).toBe('RETURN_EXCEEDS');

    expect(await processQueue(A, { force: true })).toMatchObject({ synced: 1 });
    expect(server.sales.get('s1').items[0].returnedQuantity).toBe(3);
    expect(server.returns).toHaveLength(2);
  });

  it('when nothing is left to return, the suggestion says to discard rather than inventing a quantity', async () => {
    server.addProduct('p1', 0);
    const sale = server.addSale('s1', null, [{ productId: 'p1', quantity: 2 }]);
    const A = as('terminal-A');
    await syncLocalData(A);
    setOnline(false);
    const a = await OUTBOXES.salesReturns.submit(A, returnFor(sale, 2));
    setOnline(true);
    server.apply('/sales-returns', { saleId: 's1', items: [{ saleItemId: sale.items[0].id, quantity: 2 }] }); // another terminal took it all
    await processQueue(A, { force: true });
    const conflict = await getOfflineDb(A).pendingSalesReturns.get(a.clientId);
    expect(suggestEdit('pendingSalesReturns', conflict)).toMatchObject({ discard: true });
  });
});

describe('Offline notes, applications and refunds', () => {
  it('a credit note for a customer created offline, applied to an invoice and partly refunded - all queued, all sent in dependency order with the real ids', async () => {
    server.addProduct('p1', 5);
    server.addCustomer('cust-real');
    const invoice = server.addSale('inv1', 'cust-real', [{ productId: 'p1', quantity: 5 }], 0); // owes 50
    const A = as(newTerminal());
    await syncLocalData(A);

    setOnline(false);
    const customer = await OUTBOXES.customers.queue(A, { name: 'Walk-in Wendy' });
    const note = await OUTBOXES.creditNotes.submit(A, { customerId: refTo(customer.clientId), amount: 60, reason: 'Goodwill', _display: { partyName: 'Walk-in Wendy' } });
    const notes = await getOpenNotes(A, 'credit');
    const local = notes.find((x) => x.queued);
    expect(local).toMatchObject({ available: 60, number: 'Not synced yet' });

    // The note is usable straight away: refund part of it, before anything has synced.
    const refund = await OUTBOXES.creditRefunds.submit(A, { noteId: local.id, amount: 20, method: 'cash', _display: { noteNumber: 'queued' } });
    expect((await getOpenNotes(A, 'credit')).find((x) => x.queued).available).toBe(40);
    await expect(OUTBOXES.creditRefunds.queue(A, { noteId: local.id, amount: 41, method: 'cash' })).rejects.toThrow(/Only 40.00 of credit is left/);

    setOnline(true);
    const result = await processQueue(A, { force: true });
    expect(result).toMatchObject({ synced: 3, conflicts: 0, failed: 0 });
    const syncedNote = await getOfflineDb(A).pendingCreditNotes.get(note.clientId);
    expect(server.notes.get(syncedNote.serverResult.id)).toMatchObject({ refunded: 20 });
    expect(server.notes.get(syncedNote.serverResult.id).partyId).toMatch(/^cust-/); // the REAL id of the offline customer, substituted
    expect(server.refunds).toHaveLength(1);
    void refund;
    void invoice;
  });

  it('an application to open invoices is checked locally against the note and the invoice, sent with its original time, and cannot be applied twice', async () => {
    server.addProduct('p1', 5);
    server.addCustomer('c1');
    const inv = server.addSale('inv1', 'c1', [{ productId: 'p1', quantity: 5 }], 0); // 50 owed
    server.addNote('n1', 'c1', 30);
    const A = as(newTerminal());
    await syncLocalData(A);
    setOnline(false);

    const a = await OUTBOXES.creditApplications.submit(A, { noteId: 'n1', allocations: [{ documentId: inv.id, amount: 30 }], _display: { noteNumber: 'CN-n1' } });
    expect(await getOpenNotes(A, 'credit')).toHaveLength(0); // all promised
    expect((await getOpenDocuments(A, 'credit'))[0].balance).toBe(20);
    await expect(OUTBOXES.creditApplications.queue(A, { noteId: 'n1', allocations: [{ documentId: inv.id, amount: 1 }] })).rejects.toThrow(/no credit left/);
    await expect(OUTBOXES.creditApplications.queue(A, { noteId: 'n1', allocations: [{ documentId: inv.id, amount: 60 }] })).rejects.toThrow();

    setOnline(true);
    server.loseReply = 1;
    await processQueue(A, { force: true }); // applied, reply lost
    await retryEntry(A, 'pendingCreditApplications', a.clientId);
    expect((await getOfflineDb(A).pendingCreditApplications.get(a.clientId)).status).toBe('synced');
    expect(server.applications).toHaveLength(1);
    expect(server.sales.get('inv1').amountPaid).toBe(30);
    expect(server.applications[0].createdAt).toBe(a.payload.occurredAt);
  });

  it('two terminals spend the same credit: the first is accepted, the second is a visible BALANCE_CHANGED whose suggestion is what is really left', async () => {
    server.addProduct('p1', 5);
    server.addCustomer('c1');
    const inv = server.addSale('inv1', 'c1', [{ productId: 'p1', quantity: 5 }], 0);
    server.addNote('n1', 'c1', 30);
    const A = as('terminal-A');
    await syncLocalData(A);
    const B = as('terminal-B');
    await syncLocalData(B);
    setOnline(false);
    as('terminal-A');
    const refund = await OUTBOXES.creditRefunds.submit(A, { noteId: 'n1', amount: 20, method: 'cash' });
    as('terminal-B');
    const app = await OUTBOXES.creditApplications.submit(B, { noteId: 'n1', allocations: [{ documentId: inv.id, amount: 30 }] });
    setOnline(true);

    as('terminal-A');
    expect(await processQueue(A, { force: true })).toMatchObject({ synced: 1 }); // refund 20 first
    as('terminal-B');
    expect(await processQueue(B, { force: true })).toMatchObject({ conflicts: 1 });
    const conflict = await getOfflineDb(B).pendingCreditApplications.get(app.clientId);
    expect(conflict.failure).toMatchObject({ kind: 'BALANCE_CHANGED', details: { available: 10 } });
    const suggestion = suggestEdit('pendingCreditApplications', conflict);
    expect(suggestion.summary).toMatch(/Apply only the 10/);
    await updateQueuedEntry(B, 'pendingCreditApplications', app.clientId, suggestion.payload, { note: suggestion.summary });
    expect(await processQueue(B, { force: true })).toMatchObject({ synced: 1 });
    expect(server.noteAvailable(server.notes.get('n1'))).toBe(0); // 20 refunded + 10 applied = 30; never more
    expect(server.refunds).toHaveLength(1);
    void refund;
  });

  it('an application to an invoice that was paid meanwhile is a conflict whose suggestion is the balance that is really owed', async () => {
    server.addProduct('p1', 5);
    server.addCustomer('c1');
    const inv = server.addSale('inv1', 'c1', [{ productId: 'p1', quantity: 5 }], 0);
    server.addNote('n1', 'c1', 50);
    const A = as(newTerminal());
    await syncLocalData(A);
    setOnline(false);
    const app = await OUTBOXES.creditApplications.submit(A, { noteId: 'n1', allocations: [{ documentId: inv.id, amount: 50 }] });
    setOnline(true);
    server.sales.get('inv1').amountPaid = 40; // paid elsewhere
    await processQueue(A, { force: true });
    const conflict = await getOfflineDb(A).pendingCreditApplications.get(app.clientId);
    expect(conflict.failure.details).toMatchObject({ documentId: 'inv1', balance: 10 });
    expect(suggestEdit('pendingCreditApplications', conflict).summary).toMatch(/Apply only the 10 that is still owed/);
  });
});
