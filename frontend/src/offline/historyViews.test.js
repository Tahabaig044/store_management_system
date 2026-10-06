// Phase 3.4: offline history, statements, summary and aging computed from the local read models plus the
// terminal's own queued work - with no network at any point.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOfflineDb } from './db';
import { lock } from './secureStore';
import { OUTBOXES } from './syncEngine';
import { getSalesHistory, getPurchasesHistory, getPartyStatement, getSalesSummary, getAging } from './historyViews';
import { unlockFor, putSealed } from '../test/secure';

vi.mock('../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('offline')), post: vi.fn().mockRejectedValue(new Error('Network Error')) } }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const sale = (id, over = {}) => ({ id, number: `INV-${id}`, partyId: 'c1', partyName: 'Hana', branchId: null, date: daysAgo(1), status: 'COMPLETED', paymentStatus: 'PAID', paymentMethod: 'cash', total: 100, amountPaid: 100, itemCount: 1, isActive: true, ...over });

let t;
beforeEach(async () => { setOnline(false); lock(); t = `hv-${crypto.randomUUID()}`; await unlockFor(t); });
afterEach(() => { setOnline(true); lock(); });

describe('offline history and statements', () => {
  it('lists recent sales from the device and shows this terminal\'s unsynced sale marked as such, newest first', async () => {
    await putSealed(t, 'customers', [{ id: 'c1', name: 'Hana', isActive: true }]);
    await putSealed(t, 'salesHistory', [sale('s1', { date: daysAgo(3) }), sale('s2', { date: daysAgo(2), total: 40, amountPaid: 0, paymentStatus: 'UNPAID' })]);
    const queued = await OUTBOXES.sales.queue(t, { customerId: 'c1', items: [{ productId: 'p', quantity: 2, unitPrice: 15, discount: 5 }], discount: 2, tax: 1, amountPaid: 10, paymentMethod: 'card' });

    const { rows, queuedCount } = await getSalesHistory(t);
    expect(queuedCount).toBe(1);
    expect(rows.map((r) => r.number)).toEqual(['Not synced yet', 'INV-s2', 'INV-s1']);
    expect(rows[0]).toMatchObject({ id: `$ref:${queued.clientId}`, total: 24, amountPaid: 10, queued: true, partyName: 'Hana', paymentMethod: 'card' }); // 2*15-5-2+1
    expect((await getSalesHistory(t, { search: 'hana' })).rows).toHaveLength(3);
    expect((await getSalesHistory(t, { search: 'INV-s1' })).rows).toHaveLength(1);
    const day = daysAgo(2).slice(0, 10);
    expect((await getSalesHistory(t, { from: day, to: day })).rows.map((r) => r.id)).toEqual(['s2']);
  });

  it('a refused (conflicted) sale is visible as refused, not silently counted as a sale', async () => {
    const e = await OUTBOXES.sales.queue(t, { items: [{ productId: 'p', quantity: 1, unitPrice: 10 }], amountPaid: 10, paymentMethod: 'cash' });
    await getOfflineDb(t).pendingSales.update(e.clientId, { status: 'conflict', failure: { kind: 'STOCK_INSUFFICIENT', message: 'x' } });
    const { rows } = await getSalesHistory(t);
    expect(rows[0]).toMatchObject({ status: 'REFUSED', queueStatus: 'conflict' });
    const summary = await getSalesSummary(t);
    expect(summary.queued.count).toBe(0);
    expect(summary.accepted.count).toBe(0);
  });

  it('purchase history reads the same way', async () => {
    await putSealed(t, 'purchasesHistory', [{ ...sale('p1'), number: 'PUR-1', partyId: 's9', partyName: 'Sami', status: 'RECEIVED', total: 50, amountPaid: 20 }]);
    const { rows } = await getPurchasesHistory(t);
    expect(rows).toEqual([expect.objectContaining({ number: 'PUR-1', partyName: 'Sami', total: 50 })]);
  });

  it('a customer statement: what they owe on open invoices, the credit they hold, the balance - and it follows what is queued', async () => {
    await putSealed(t, 'salesHistory', [sale('s1', { total: 100, amountPaid: 100 }), sale('s2', { total: 80, amountPaid: 20, paymentStatus: 'PARTIAL' }), sale('other', { partyId: 'c2', partyName: 'Other' })]);
    await putSealed(t, 'arDocuments', [{ id: 's2', number: 'INV-s2', partyId: 'c1', partyName: 'Hana', date: daysAgo(10), total: 80, amountPaid: 20, balance: 60, isActive: true }]);
    await putSealed(t, 'arNotes', [{ id: 'n1', number: 'CN-1', partyId: 'c1', partyName: 'Hana', amount: 25, available: 25, isActive: true }]);
    await getOfflineDb(t).meta.put({ key: 'dataset:arDocuments', value: { lastCheckedAt: Date.now() - 60000, serverTime: 'x' } });

    let st = await getPartyStatement(t, 'credit', 'c1');
    expect(st).toMatchObject({ owed: 60, credit: 25, balance: 35 });
    expect(st.lines.map((l) => l.number).sort()).toEqual(['INV-s1', 'INV-s2']); // only this customer's
    expect(st.lines.find((l) => l.number === 'INV-s2').outstanding).toBe(60);
    expect(st.asOf).toBeGreaterThan(0);

    // This terminal applies the note to the invoice (queued): the statement shows it at once.
    await OUTBOXES.creditApplications.queue(t, { noteId: 'n1', allocations: [{ documentId: 's2', amount: 25 }] });
    st = await getPartyStatement(t, 'credit', 'c1');
    expect(st).toMatchObject({ owed: 35, credit: 0, balance: 35 }); // debt and credit both fall by the applied amount
  });

  it('sales summary: excludes reversed sales, splits server-accepted from still-on-terminal, totals per day and payment method', async () => {
    await putSealed(t, 'salesHistory', [
      sale('a', { date: daysAgo(1), total: 100, amountPaid: 100, paymentMethod: 'cash' }),
      sale('b', { date: daysAgo(1), total: 50, amountPaid: 50, paymentMethod: 'card' }),
      sale('c', { date: daysAgo(2), total: 70, amountPaid: 70, status: 'REVERSED' }),
    ]);
    await OUTBOXES.sales.queue(t, { items: [{ productId: 'p', quantity: 1, unitPrice: 30 }], amountPaid: 30, paymentMethod: 'cash' });
    const s = await getSalesSummary(t);
    expect(s.accepted).toEqual({ count: 2, total: 150, paid: 150 });
    expect(s.queued).toEqual({ count: 1, total: 30, paid: 30 });
    expect(s.byMethod).toEqual([{ method: 'card', paid: 50 }, { method: 'cash', paid: 130 }]);
    expect(s.byDay.reduce((x, d) => x + d.total, 0)).toBe(180);
  });

  it('aging buckets open invoices by age and totals by party', async () => {
    const doc = (id, age, balance, partyId = 'c1') => ({ id, number: id, partyId, partyName: partyId, date: daysAgo(age), total: balance, amountPaid: 0, balance, isActive: true });
    await putSealed(t, 'arDocuments', [doc('d1', 5, 10), doc('d2', 45, 20), doc('d3', 75, 30), doc('d4', 200, 40, 'c2')]);
    const a = await getAging(t, 'credit');
    expect(a.buckets.map((b) => [b.label, b.total])).toEqual([['0-30', 10], ['31-60', 20], ['61-90', 30], ['90+', 40]]);
    expect(a.total).toBe(100);
    expect(a.parties.map((p) => [p.partyId, p.total])).toEqual([['c1', 60], ['c2', 40]]);
  });

  it('locked: the sealed views are empty rather than wrong, and the unsent sale is still visible', async () => {
    await putSealed(t, 'salesHistory', [sale('s1')]);
    await OUTBOXES.sales.queue(t, { items: [{ productId: 'p', quantity: 1, unitPrice: 10 }], amountPaid: 10, paymentMethod: 'cash' });
    lock(t);
    const { rows } = await getSalesHistory(t);
    expect(rows).toHaveLength(1); // only the queued one; the sealed history cannot be read
    expect(rows[0].queued).toBe(true);
  });
});
