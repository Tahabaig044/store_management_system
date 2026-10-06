// Phase 3.4: recovery and data-integrity of the unsent queue - a damaged entry must never stop the rest of
// the queue, damage is reported not hidden, and the ability to open the database is checked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient from '../api/client';
import { getOfflineDb } from './db';
import { OUTBOXES } from './syncEngine';
import { processQueue } from './syncCoordinator';
import { auditLocalStore, checkOfflineDb, entryProblem } from './integrity';
import { describeFailure } from './syncCore';

vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const tenant = () => `int-${crypto.randomUUID()}`;
beforeEach(() => { apiClient.post.mockReset(); apiClient.get.mockReset(); setOnline(true); });
afterEach(() => { setOnline(true); vi.restoreAllMocks(); });

describe('a damaged entry cannot take the queue down', () => {
  it('an entry the outbox cannot turn into a request becomes a visible non-retryable failure; every other entry still syncs', async () => {
    const t = tenant();
    const db = getOfflineDb(t);
    const first = await OUTBOXES.expenses.queue(t, { amount: 1, description: 'a', method: 'cash' });
    // A reversal whose payload lost its content: building its URL throws.
    await db.pendingReversals.add({ clientId: 'bad-1', status: 'pending', createdAt: Date.now() + 1, payload: null, dependsOn: [], attempts: 0 });
    const last = await OUTBOXES.expenses.queue(t, { amount: 3, description: 'c', method: 'cash' });
    apiClient.post.mockResolvedValue({ data: { item: { id: 'srv' } } });

    const res = await processQueue(t, { force: true });
    expect(res).toMatchObject({ synced: 2, failed: 1 });
    expect((await db.pendingExpenses.get(first.clientId)).status).toBe('synced');
    expect((await db.pendingExpenses.get(last.clientId)).status).toBe('synced');
    const bad = await db.pendingReversals.get('bad-1');
    expect(bad).toMatchObject({ status: 'failed', failure: { kind: 'CORRUPT' } });
    expect(bad.failure.message).toMatch(/damaged/);
    expect(describeFailure(bad.failure)).toMatchObject({ retryable: false, editable: false });
    expect(apiClient.post).toHaveBeenCalledTimes(2); // nothing was sent for the damaged one

    // ...and it stays that way: no retry loop, no re-wedging on the next pass.
    apiClient.post.mockClear();
    await processQueue(t, { force: true });
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('audit of the local store', () => {
  it('recognises well-formed entries and each kind of damage', () => {
    const ok = { clientId: 'a', status: 'pending', createdAt: 1, payload: { x: 1 } };
    expect(entryProblem(ok)).toBeNull();
    expect(entryProblem({ ...ok, payload: null })).toMatch(/content/);
    expect(entryProblem({ ...ok, payload: [] })).toMatch(/content/);
    expect(entryProblem({ ...ok, status: 'weird' })).toMatch(/unknown status/);
    expect(entryProblem({ ...ok, createdAt: undefined })).toMatch(/creation time/);
    expect(entryProblem(null)).toBe('not an object');
  });

  it('marks damaged entries as visible failures (never deletes them), reports duplicate keys and dangling references, leaves good entries alone', async () => {
    const t = tenant();
    const db = getOfflineDb(t);
    const good = await OUTBOXES.expenses.queue(t, { amount: 1, description: 'ok', method: 'cash' });
    await db.pendingExpenses.add({ clientId: 'twin', status: 'pending', createdAt: 5, payload: { amount: 1, idempotencyKey: good.payload.idempotencyKey }, dependsOn: [] });
    await db.pendingExpenses.add({ clientId: 'orphan', status: 'pending', createdAt: 6, payload: { amount: 2, idempotencyKey: 'k-o' }, dependsOn: ['gone'] });
    await db.pendingExpenses.add({ clientId: 'broken', status: 'pending', createdAt: 7, payload: 'not an object' });
    await db.pendingSales.add({ clientId: 'no-time', status: 'pending', payload: { items: [] } });

    const report = await auditLocalStore(t);
    expect(report.entries).toBe(5);
    expect(report.damaged.map((d) => d.clientId).sort()).toEqual(['broken', 'no-time']);
    expect(report.duplicateKeys).toEqual([expect.objectContaining({ idempotencyKey: good.payload.idempotencyKey })]);
    expect(report.danglingReferences).toBe(1);
    expect((await db.pendingExpenses.get('broken'))).toMatchObject({ status: 'failed', failure: { kind: 'CORRUPT' }, payload: 'not an object' }); // kept, not deleted
    expect((await db.pendingSales.get('no-time')).status).toBe('failed');
    expect((await db.pendingExpenses.get(good.clientId)).status).toBe('pending');
    expect((await db.meta.get('integrityAudit')).value.entries).toBe(5);
  });
});

describe('the database can be opened - or the reason is reported', () => {
  it('healthy: ok', async () => {
    expect(await checkOfflineDb(tenant())).toEqual({ ok: true });
  });

  it('an unopenable database is reported with its reason, not thrown', async () => {
    const t = tenant();
    const db = getOfflineDb(t);
    vi.spyOn(db, 'open').mockRejectedValue(Object.assign(new Error('Internal error opening backing store'), { name: 'UnknownError' }));
    expect(await checkOfflineDb(t)).toEqual({ ok: false, name: 'UnknownError', message: 'Internal error opening backing store' });
  });
});
