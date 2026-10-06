// Phase 3.3.4 (client): a terminal reports its queue state and refusals, only reports, never loses anything
// when a report cannot be sent, and learns which refusals a manager has seen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient from '../api/client';
import { getOfflineDb } from './db';
import { OUTBOXES } from './syncEngine';
import { buildReport, reportTerminalState, getTerminalId } from './terminalReporting';

vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const tenant = () => `tr-${crypto.randomUUID()}`;
const conflictSale = (over = {}) => ({
  clientId: crypto.randomUUID(),
  status: 'conflict',
  createdAt: Date.now(),
  payload: { items: [{ productId: 'p1', quantity: 2, unitPrice: 5 }], amountPaid: 10, paymentMethod: 'cash', idempotencyKey: 'k' },
  attempts: 1,
  failure: { kind: 'STOCK_INSUFFICIENT', code: 'STOCK_INSUFFICIENT', status: 409, message: 'Insufficient stock (available: 1)', details: { productId: 'p1', available: 1 } },
  dependsOn: [],
  ...over,
});

beforeEach(() => {
  apiClient.post.mockReset();
  apiClient.get.mockReset();
  setOnline(true);
});
afterEach(() => setOnline(true));

describe('terminal reporting', () => {
  it('the terminal id is created once and stays the same', () => {
    expect(getTerminalId()).toBe(getTerminalId());
    expect(getTerminalId()).toMatch(/^term-/);
  });

  it('counts waiting / conflict / failed work and lists only the refused entries, with the servers facts', async () => {
    const t = tenant();
    const db = getOfflineDb(t);
    await db.pendingSales.add(conflictSale({ status: 'pending', failure: null, createdAt: 1000 }));
    await db.pendingSales.add(conflictSale({ status: 'blocked', failure: null, createdAt: 2000 }));
    const c = conflictSale();
    await db.pendingSales.add(c);
    await db.pendingExpenses.add(conflictSale({ status: 'failed', failure: { kind: 'REJECTED', message: 'nope' } }));
    await db.pendingSales.add(conflictSale({ status: 'synced', failure: null }));

    const { body } = await buildReport(t);
    expect(body.counts).toMatchObject({ pending: 2, conflict: 1, failed: 1 });
    expect(new Date(body.counts.oldestPendingAt).getTime()).toBe(1000);
    expect(body.issues).toHaveLength(2);
    expect(body.issues.find((i) => i.clientId === c.clientId)).toMatchObject({ kind: 'STOCK_INSUFFICIENT', details: { productId: 'p1', available: 1 }, entity: 'Sale' });
    expect(JSON.stringify(body)).not.toMatch(/idempotencyKey|unitPrice/); // no transaction content leaves in a report
  });

  it('sends once, skips an unchanged report, and reports what was fixed (synced) and what was discarded', async () => {
    const t = tenant();
    const db = getOfflineDb(t);
    apiClient.post.mockResolvedValue({ data: { ok: true, acknowledged: [] } });
    const fixed = conflictSale();
    const dropped = conflictSale();
    await db.pendingSales.add(fixed);
    await db.pendingSales.add(dropped);

    expect(await reportTerminalState(t)).toMatchObject({ sent: true });
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(await reportTerminalState(t)).toMatchObject({ sent: false, reason: 'unchanged' });

    await db.pendingSales.update(fixed.clientId, { status: 'synced', failure: null });
    await db.pendingSales.delete(dropped.clientId);
    expect(await reportTerminalState(t)).toMatchObject({ sent: true });
    const body = apiClient.post.mock.calls[1][1];
    expect(body.resolved).toEqual(expect.arrayContaining([{ clientId: fixed.clientId, resolution: 'synced' }, { clientId: dropped.clientId, resolution: 'discarded' }]));
    expect(body.counts).toMatchObject({ conflict: 0 });
  });

  it('a report that cannot be sent is not lost: nothing changes locally and the next attempt carries it', async () => {
    const t = tenant();
    const db = getOfflineDb(t);
    const c = conflictSale();
    await db.pendingSales.add(c);
    apiClient.post.mockRejectedValueOnce(new Error('Network Error'));
    expect(await reportTerminalState(t)).toMatchObject({ sent: false, reason: 'error' });
    expect((await db.pendingSales.get(c.clientId)).status).toBe('conflict'); // the queue is untouched
    apiClient.post.mockResolvedValue({ data: { ok: true, acknowledged: [] } });
    expect(await reportTerminalState(t)).toMatchObject({ sent: true });
    expect(apiClient.post.mock.calls[1][1].issues).toHaveLength(1);
  });

  it('offline it does not even try', async () => {
    setOnline(false);
    expect(await reportTerminalState(tenant())).toMatchObject({ sent: false, reason: 'offline' });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('learns which refusals a manager has seen and marks them on the entry (without touching its status or payload)', async () => {
    const t = tenant();
    const db = getOfflineDb(t);
    const c = conflictSale();
    await db.pendingSales.add(c);
    apiClient.post.mockResolvedValue({ data: { ok: true, acknowledged: [{ clientId: c.clientId, acknowledgeNote: 'looking into it' }] } });
    await reportTerminalState(t, { force: true });
    const row = await db.pendingSales.get(c.clientId);
    expect(row).toMatchObject({ status: 'conflict', managerNote: 'looking into it', payload: c.payload });
    expect(row.managerSeenAt).toBeTypeOf('number');
  });

  it('reporting never sends a transaction: only the terminal-report endpoint is used', async () => {
    const t = tenant();
    await OUTBOXES.expenses.queue(t, { amount: 5, description: 'x', method: 'cash' });
    apiClient.post.mockResolvedValue({ data: { ok: true, acknowledged: [] } });
    await reportTerminalState(t, { force: true });
    expect(apiClient.post.mock.calls.map((c) => c[0])).toEqual(['/sync/terminal-report']);
    expect((await OUTBOXES.expenses.listPending(t))[0].status).toBe('pending');
  });
});
