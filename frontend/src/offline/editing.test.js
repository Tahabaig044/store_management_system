import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient from '../api/client';
import { getOfflineDb, setOfflineScope } from './db';
import { OUTBOXES } from './syncEngine';
import { processQueue, retryEntry, discardEntry, getDiscardLog } from './syncCoordinator';
import { editability, updateQueuedEntry, suggestEdit, validateEdit, diffPayload, isEditableTable } from './editing';

vi.mock('../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('offline')), post: vi.fn() } }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const httpError = (status, code, error, details) => ({ response: { status, data: { code, error, details } } });
const netError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

let n = 0;
const terminal = () => {
  const userId = `edit-${crypto.randomUUID()}-${(n += 1)}`;
  setOfflineScope({ tenantId: 'edit-shop', userId });
  return 'edit-shop';
};
const saleBody = (productId, quantity, extra = {}) => ({ items: [{ productId, quantity, unitPrice: 10 }], amountPaid: quantity * 10, paymentMethod: 'cash', ...extra });

beforeEach(() => {
  apiClient.post.mockReset();
  setOnline(true);
});
afterEach(() => {
  setOnline(true);
  setOfflineScope(null);
});

describe('what may be edited, and when', () => {
  it('pending, conflicted, failed and blocked work is editable; synced and in-flight work never is', async () => {
    const A = terminal();
    setOnline(false);
    const e = await OUTBOXES.expenses.queue(A, { categoryId: 'c', amount: 5 });
    const db = getOfflineDb(A);
    for (const status of ['pending', 'conflict', 'failed', 'blocked']) {
      await db.pendingExpenses.update(e.clientId, { status });
      expect(editability('pendingExpenses', await db.pendingExpenses.get(e.clientId)).ok).toBe(true);
    }
    await db.pendingExpenses.update(e.clientId, { status: 'synced' });
    expect(editability('pendingExpenses', await db.pendingExpenses.get(e.clientId))).toMatchObject({ ok: false, reason: expect.stringMatching(/already accepted/) });
    await db.pendingExpenses.update(e.clientId, { status: 'syncing' });
    expect(editability('pendingExpenses', await db.pendingExpenses.get(e.clientId)).ok).toBe(false);
  });

  it('a transaction whose last attempt got NO answer cannot be edited until the server has answered definitively', () => {
    const entry = { status: 'pending', maybeApplied: true, payload: {} };
    expect(editability('pendingSales', entry)).toMatchObject({ ok: false, needsCheck: true });
    expect(editability('pendingSales', { ...entry, maybeApplied: false }).ok).toBe(true);
  });

  it('reversals, optical orders and quotations are not editable (discard and re-enter); every money/stock outbox is', () => {
    for (const t of ['pendingReversals', 'pendingOpticalOrders', 'pendingQuotations']) expect(isEditableTable(t)).toBe(false);
    for (const t of ['pendingSales', 'pendingPurchases', 'pendingExpenses', 'pendingPayments', 'pendingCustomers', 'pendingSuppliers', 'pendingWarehouseStockMoves', 'pendingSalesReturns', 'pendingPurchaseReturns', 'pendingCreditNotes', 'pendingDebitNotes', 'pendingCreditRefunds', 'pendingDebitRefunds', 'pendingCreditApplications', 'pendingDebitApplications']) expect(isEditableTable(t)).toBe(true);
  });
});

describe('validation', () => {
  it('rejects nonsense before it can be queued again', () => {
    const base = saleBody('p1', 2);
    expect(validateEdit('pendingSales', base)).toEqual([]);
    expect(validateEdit('pendingSales', { ...base, items: [{ productId: 'p1', quantity: 0, unitPrice: 10 }] }).join()).toMatch(/greater than zero/);
    expect(validateEdit('pendingSales', { ...base, items: [] }).join()).toMatch(/at least 1/);
    expect(validateEdit('pendingSales', { ...base, amountPaid: 999 }).join()).toMatch(/cannot exceed the sale total/);
    expect(validateEdit('pendingSales', { ...base, discount: -1 }).join()).toMatch(/less than 0/);
    expect(validateEdit('pendingExpenses', { amount: 'abc' }).join()).toMatch(/must be a number/);
    expect(validateEdit('pendingCustomers', { name: '' }).join()).toMatch(/required/);
    expect(validateEdit('pendingExpenses', { amount: 5, method: 'gold-bars' }).join()).toMatch(/valid choice/);
  });

  it('diffPayload reports exactly which leaves changed', () => {
    const d = diffPayload({ a: 1, items: [{ q: 1 }, { q: 2 }] }, { a: 1, items: [{ q: 1 }, { q: 5 }], extra: true });
    expect(d).toEqual([{ path: 'items.1.q', from: 2, to: 5 }, { path: 'extra', from: null, to: true }]);
  });
});

describe('editing a queued transaction', () => {
  it('changes what will be sent, keeps its identity, logs the edit, and recomputes local stock exactly from the base', async () => {
    const A = terminal();
    const db = getOfflineDb(A);
    await db.products.put({ id: 'p1', name: 'Widget', stockQuantity: 10 });
    setOnline(false);
    const e = await OUTBOXES.sales.queue(A, saleBody('p1', 3));
    expect((await db.products.get('p1')).stockQuantity).toBe(7);

    const next = { ...e.payload, items: [{ productId: 'p1', quantity: 2, unitPrice: 10 }], amountPaid: 20 };
    const edited = await updateQueuedEntry(A, 'pendingSales', e.clientId, next);
    expect(edited.payload.items[0].quantity).toBe(2);
    expect(edited.payload.idempotencyKey).toBe(e.payload.idempotencyKey);
    expect(edited.payload.occurredAt).toBe(e.payload.occurredAt);
    expect(edited.status).toBe('pending');
    expect(edited.revisions).toHaveLength(1);
    expect(edited.revisions[0].changes.map((c) => c.path).sort()).toEqual(['amountPaid', 'items.0.quantity']);
    expect((await db.products.get('p1')).stockQuantity).toBe(8); // base 10 - 2: not 9, not 6

    // Editing again never drifts.
    await updateQueuedEntry(A, 'pendingSales', e.clientId, { ...edited.payload, items: [{ productId: 'p1', quantity: 4, unitPrice: 10 }], amountPaid: 40 });
    expect((await db.products.get('p1')).stockQuantity).toBe(6);
  });

  it('cannot change the operation\'s identity or original event time through an edit', async () => {
    const A = terminal();
    setOnline(false);
    const e = await OUTBOXES.expenses.queue(A, { categoryId: 'c', amount: 5 });
    const edited = await updateQueuedEntry(A, 'pendingExpenses', e.clientId, { ...e.payload, amount: 6, idempotencyKey: 'attacker-key', occurredAt: '2020-01-01T00:00:00.000Z' });
    expect(edited.payload.idempotencyKey).toBe(e.payload.idempotencyKey);
    expect(edited.payload.occurredAt).toBe(e.payload.occurredAt);
    expect(edited.payload.amount).toBe(6);
  });

  it('refuses invalid edits, no-op edits and edits of accepted work - and changes nothing', async () => {
    const A = terminal();
    const db = getOfflineDb(A);
    setOnline(false);
    const e = await OUTBOXES.expenses.queue(A, { categoryId: 'c', amount: 5 });
    await expect(updateQueuedEntry(A, 'pendingExpenses', e.clientId, { ...e.payload, amount: -1 })).rejects.toThrow(/greater than zero/);
    await expect(updateQueuedEntry(A, 'pendingExpenses', e.clientId, { ...e.payload })).rejects.toThrow(/Nothing was changed/);
    await db.pendingExpenses.update(e.clientId, { status: 'synced' });
    await expect(updateQueuedEntry(A, 'pendingExpenses', e.clientId, { ...e.payload, amount: 9 })).rejects.toThrow(/already accepted/);
    expect((await db.pendingExpenses.get(e.clientId)).payload.amount).toBe(5);
    expect((await db.pendingExpenses.get(e.clientId)).revisions).toBeUndefined();
  });

  it('a payment\'s total is derived from its allocations, never typed twice', async () => {
    const A = terminal();
    setOnline(false);
    const e = await OUTBOXES.payments.queue(A, { direction: 'IN', customerId: 'c', amount: 100, allocations: [{ saleId: 's1', amount: 60 }, { saleId: 's2', amount: 40 }] });
    const edited = await updateQueuedEntry(A, 'pendingPayments', e.clientId, { ...e.payload, allocations: [{ saleId: 's1', amount: 60 }, { saleId: 's2', amount: 25 }] });
    expect(edited.payload.amount).toBe(85);
  });

  it('editing a dependent\'s references keeps ordering honest', async () => {
    const A = terminal();
    setOnline(false);
    const customer = await OUTBOXES.customers.queue(A, { name: 'Ann' });
    const sale = await OUTBOXES.sales.queue(A, { ...saleBody('p1', 1), customerId: `$ref:${customer.clientId}` });
    expect(sale.dependsOn).toEqual([customer.clientId]);
    const edited = await updateQueuedEntry(A, 'pendingSales', sale.clientId, { ...sale.payload, customerId: undefined });
    expect(edited.dependsOn).toEqual([]); // no longer waits for the customer
  });

  it('a discarded transaction keeps its edit history in the log', async () => {
    const A = terminal();
    setOnline(false);
    const e = await OUTBOXES.expenses.queue(A, { categoryId: 'c', amount: 5 });
    await updateQueuedEntry(A, 'pendingExpenses', e.clientId, { ...e.payload, amount: 7 });
    await discardEntry(A, 'pendingExpenses', e.clientId);
    const log = await getDiscardLog(A);
    expect(log[0].revisions[0].changes[0]).toMatchObject({ path: 'amount', from: 5, to: 7 });
  });
});

describe('a reply that never came: edit only after the server has answered', () => {
  it('a lost reply makes the entry uneditable; "Check" (a replay) resolves it - accepted => synced, rejected => editable', async () => {
    const A = terminal();
    const db = getOfflineDb(A);
    const applied = new Map();
    apiClient.post.mockImplementation(async (path, body) => {
      if (applied.has(body.idempotencyKey)) return { data: { item: applied.get(body.idempotencyKey), deduplicated: true } };
      throw netError();
    });
    const e = await OUTBOXES.expenses.queue(A, { categoryId: 'c', amount: 5 });
    await processQueue(A, { force: true });
    expect((await db.pendingExpenses.get(e.clientId)).maybeApplied).toBe(true);
    await expect(updateQueuedEntry(A, 'pendingExpenses', e.clientId, { ...e.payload, amount: 6 })).rejects.toThrow(/may already have it/);

    // Case 1: the server had applied it after all.
    applied.set(e.payload.idempotencyKey, { id: 'srv-exp' });
    await retryEntry(A, 'pendingExpenses', e.clientId);
    expect((await db.pendingExpenses.get(e.clientId)).status).toBe('synced');
    expect((await db.pendingExpenses.get(e.clientId)).maybeApplied).toBe(false);
    await expect(updateQueuedEntry(A, 'pendingExpenses', e.clientId, { ...e.payload, amount: 6 })).rejects.toThrow(/already accepted/);
  });

  it('a definitive rejection after an ambiguous attempt clears the flag, so it can be edited and then accepted exactly once', async () => {
    const A = terminal();
    const db = getOfflineDb(A);
    let mode = 'lost';
    const accepted = [];
    apiClient.post.mockImplementation(async (path, body) => {
      if (mode === 'lost') throw netError();
      if (mode === 'reject') throw httpError(409, 'PERIOD_CLOSED', 'closed');
      accepted.push(body);
      return { data: { item: { id: 'srv-1' } } };
    });
    const e = await OUTBOXES.expenses.queue(A, { categoryId: 'c', amount: 5 });
    await processQueue(A, { force: true });
    expect((await db.pendingExpenses.get(e.clientId)).maybeApplied).toBe(true);
    mode = 'reject';
    await retryEntry(A, 'pendingExpenses', e.clientId);
    const row = await db.pendingExpenses.get(e.clientId);
    expect(row).toMatchObject({ status: 'conflict', maybeApplied: false });
    expect(editability('pendingExpenses', row).ok).toBe(true);

    mode = 'ok';
    await updateQueuedEntry(A, 'pendingExpenses', e.clientId, { ...row.payload, amount: 6 });
    await processQueue(A, { force: true });
    expect((await db.pendingExpenses.get(e.clientId)).status).toBe('synced');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].amount).toBe(6);
  });

  it('an entry interrupted mid-request by a crash is treated as possibly applied', async () => {
    const A = terminal();
    const db = getOfflineDb(A);
    setOnline(false);
    const e = await OUTBOXES.expenses.queue(A, { categoryId: 'c', amount: 5 });
    await db.pendingExpenses.update(e.clientId, { status: 'syncing' });
    setOnline(true);
    apiClient.post.mockRejectedValue(netError());
    await processQueue(A, { force: true });
    expect((await db.pendingExpenses.get(e.clientId)).maybeApplied).toBe(true);
  });
});

describe('edit-and-retry: fixing a conflict from the server\'s own facts', () => {
  it('an oversell conflict suggests exactly what is available, the edit is applied, and the sale is accepted once - server stock never negative', async () => {
    const A = terminal();
    const db = getOfflineDb(A);
    await db.products.put({ id: 'p1', name: 'Widget', stockQuantity: 10 });
    let stock = 4; // the server's real stock
    const sales = [];
    apiClient.post.mockImplementation(async (path, body) => {
      const need = body.items.reduce((s, l) => s + l.quantity, 0);
      if (need > stock) throw httpError(409, 'STOCK_INSUFFICIENT', `Insufficient stock for Widget (available: ${stock})`, { productId: 'p1', name: 'Widget', available: stock, requested: need });
      stock -= need;
      sales.push(body);
      return { data: { item: { id: `sale-${sales.length}` } } };
    });
    const e = await OUTBOXES.sales.queue(A, saleBody('p1', 7));
    await processQueue(A, { force: true });
    const conflict = await db.pendingSales.get(e.clientId);
    expect(conflict.failure).toMatchObject({ kind: 'STOCK_INSUFFICIENT', details: { productId: 'p1', available: 4 } });

    const s = suggestEdit('pendingSales', conflict);
    expect(s.summary).toBe('Reduce Widget from 7 to 4');
    expect(s.payload.items[0].quantity).toBe(4);
    expect(s.payload.amountPaid).toBe(40); // paid in full stays paid in full

    await updateQueuedEntry(A, 'pendingSales', e.clientId, s.payload, { note: s.summary });
    await processQueue(A, { force: true });
    const done = await db.pendingSales.get(e.clientId);
    expect(done.status).toBe('synced');
    expect(done.revisions[0]).toMatchObject({ note: 'Reduce Widget from 7 to 4', resolved: { kind: 'STOCK_INSUFFICIENT' } });
    expect(sales).toHaveLength(1);
    expect(stock).toBe(0);
  });

  it('when nothing is available the suggestion is to discard, never to send an empty sale', () => {
    const entry = { payload: saleBody('p1', 3), failure: { kind: 'STOCK_INSUFFICIENT', details: { productId: 'p1', name: 'Widget', available: 0 } } };
    expect(suggestEdit('pendingSales', entry)).toMatchObject({ discard: true, payload: null });
  });

  it('with several lines only the line the server named is reduced; a partially paid sale keeps its paid amount', () => {
    const payload = { items: [{ productId: 'p1', quantity: 5, unitPrice: 10 }, { productId: 'p2', quantity: 2, unitPrice: 10 }], amountPaid: 30, paymentMethod: 'cash' };
    const s = suggestEdit('pendingSales', { payload, failure: { kind: 'STOCK_INSUFFICIENT', details: { productId: 'p1', name: 'A', available: 3 } } });
    expect(s.payload.items.map((l) => l.quantity)).toEqual([3, 2]);
    expect(s.payload.amountPaid).toBe(30);
  });

  it('a warehouse dispatch is reduced to what is available', () => {
    const s = suggestEdit('pendingWarehouseStockMoves', { payload: { action: 'dispatch', quantity: 9 }, failure: { kind: 'STOCK_INSUFFICIENT', details: { available: 3 } } });
    expect(s.payload.quantity).toBe(3);
  });

  it('a return that no longer fits is reduced to what is still returnable, and dropped when nothing is', () => {
    const payload = { saleId: 's', items: [{ saleItemId: 'i1', quantity: 3 }, { saleItemId: 'i2', quantity: 1 }] };
    const s = suggestEdit('pendingSalesReturns', { payload, failure: { kind: 'RETURN_EXCEEDS', details: { saleItemId: 'i1', remaining: 1 } } });
    expect(s.payload.items).toEqual([{ saleItemId: 'i1', quantity: 1 }, { saleItemId: 'i2', quantity: 1 }]);
    const none = suggestEdit('pendingSalesReturns', { payload: { items: [{ saleItemId: 'i1', quantity: 1 }] }, failure: { kind: 'RETURN_EXCEEDS', details: { saleItemId: 'i1', remaining: 0 } } });
    expect(none.discard).toBe(true);
  });

  it('a closed-period conflict can be re-dated only by an explicit, logged correction of the event time', async () => {
    const A = terminal();
    const db = getOfflineDb(A);
    setOnline(false);
    const e = await OUTBOXES.expenses.queue(A, { categoryId: 'c', amount: 5, occurredAt: '2026-01-05T10:00:00.000Z' });
    await db.pendingExpenses.update(e.clientId, { status: 'conflict', failure: { kind: 'PERIOD_CLOSED', message: 'closed', at: 1 } });
    const row = await db.pendingExpenses.get(e.clientId);
    const s = suggestEdit('pendingExpenses', row);
    expect(s.changesEventTime).toBe(true);

    await expect(updateQueuedEntry(A, 'pendingExpenses', e.clientId, s.payload)).rejects.toThrow(/Nothing was changed/);
    const unchanged = await db.pendingExpenses.get(e.clientId);
    expect(unchanged.payload.occurredAt).toBe('2026-01-05T10:00:00.000Z'); // without the explicit flag the time is protected

    const fixed = await updateQueuedEntry(A, 'pendingExpenses', e.clientId, s.payload, { allowEventTimeChange: true, note: s.summary });
    expect(fixed.payload.occurredAt).not.toBe('2026-01-05T10:00:00.000Z');
    expect(fixed.revisions[0].eventTimeChanged).toBe(true);
  });
});
