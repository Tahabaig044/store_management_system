import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import SyncStatusWidget from './SyncStatusWidget';
import { getOfflineDb } from '../offline/db';
import { getDiscardLog } from '../offline/syncCoordinator';

vi.mock('../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('offline')), post: vi.fn().mockRejectedValue(new Error('Network Error')) } }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
afterEach(() => setOnline(true));

const sale = (over = {}) => ({
  clientId: crypto.randomUUID(),
  status: 'pending',
  createdAt: Date.now(),
  payload: { items: [{ productId: 'p1', quantity: 3, unitPrice: 10 }], occurredAt: '2026-06-01T09:30:00.000Z' },
  attempts: 0,
  failure: null,
  lastError: null,
  serverResult: null,
  ...over,
});
const seed = async (tenantId, table, entry) => {
  await getOfflineDb(tenantId)[table].add(entry);
  return entry;
};

describe('Sync status UI (Phase 3.2)', () => {
  it('shows "All synced" only when nothing needs sending', async () => {
    const tenantId = crypto.randomUUID();
    await seed(tenantId, 'pendingSales', sale({ status: 'synced', syncedAt: Date.now(), serverResult: { id: 's1' } }));
    render(<SyncStatusWidget tenantId={tenantId} online />);
    expect(await screen.findByTestId('sync-state')).toHaveTextContent('All synced');
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('shows the pending count, and marks pending work as waiting on the network while offline', async () => {
    const tenantId = crypto.randomUUID();
    await seed(tenantId, 'pendingSales', sale());
    await seed(tenantId, 'pendingExpenses', sale({ payload: { amount: 5 } }));
    setOnline(false);
    render(<SyncStatusWidget tenantId={tenantId} online={false} />);
    const badge = await screen.findByTestId('sync-state');
    expect(badge).toHaveTextContent('2 pending');
    expect(badge).toHaveAttribute('data-state', 'offline-pending');
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('shows Syncing while a pass is running', async () => {
    const tenantId = crypto.randomUUID();
    await seed(tenantId, 'pendingSales', sale());
    await getOfflineDb(tenantId).meta.put({ key: 'syncActive', value: true });
    render(<SyncStatusWidget tenantId={tenantId} online />);
    await waitFor(() => expect(screen.getByTestId('sync-state')).toHaveTextContent('Syncing...'));
    expect(screen.getByTestId('sync-state')).toHaveAttribute('data-state', 'syncing');
  });

  it('says WHICH transaction has a conflict, why, what the server said, what can be done - and that it was not applied', async () => {
    const tenantId = crypto.randomUUID();
    const conflict = await seed(
      tenantId,
      'pendingSales',
      sale({
        status: 'conflict',
        failure: { kind: 'STOCK_INSUFFICIENT', code: 'STOCK_INSUFFICIENT', status: 409, message: 'Insufficient stock for Widget (available: 1)', at: Date.now() },
        lastError: 'Insufficient stock for Widget (available: 1)',
      })
    );
    render(<SyncStatusWidget tenantId={tenantId} online />);
    const badge = await screen.findByTestId('sync-state');
    expect(badge).toHaveTextContent('1 conflict');
    expect(badge).toHaveAttribute('data-state', 'conflict');
    fireEvent.click(badge);

    const row = await screen.findByTestId(`queue-row-${conflict.clientId}`);
    expect(row).toHaveTextContent('Sale');
    expect(row).toHaveTextContent('1 item(s), Rs. 30.00');
    expect(row).toHaveTextContent('Conflict');
    const detail = screen.getByTestId('conflict-detail');
    expect(detail).toHaveTextContent('Not enough stock on the server');
    expect(detail).toHaveTextContent('Insufficient stock for Widget (available: 1)');
    expect(detail).toHaveTextContent(/Retry once stock is available|record the sale again/);
    expect(screen.getByRole('alert')).toHaveTextContent(/NOT been applied on the server/);
  });

  it('Retry puts the item back in the queue; Discard needs a confirmation and is logged', async () => {
    const tenantId = crypto.randomUUID();
    const conflict = await seed(
      tenantId,
      'pendingSales',
      sale({
        status: 'conflict',
        attempts: 2,
        failure: { kind: 'STOCK_INSUFFICIENT', code: 'STOCK_INSUFFICIENT', status: 409, message: 'Insufficient stock (available: 1)', at: Date.now() },
      })
    );
    render(<SyncStatusWidget tenantId={tenantId} online />);
    fireEvent.click(await screen.findByTestId('sync-state'));

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(async () => {
      const row = await getOfflineDb(tenantId).pendingSales.get(conflict.clientId);
      expect(row.status).toBe('pending'); // the network is down in this test, so it waits - retried, not lost
      expect(row.attempts).toBe(0);
      expect(row.failure).toBeNull();
    });

    await act(async () => {
      await getOfflineDb(tenantId).pendingSales.update(conflict.clientId, { status: 'conflict', failure: { kind: 'STOCK_INSUFFICIENT', message: 'm', at: 1 } });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await getOfflineDb(tenantId).pendingSales.get(conflict.clientId)).toBeDefined(); // first click only asks
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, discard' }));
    await waitFor(async () => expect(await getOfflineDb(tenantId).pendingSales.get(conflict.clientId)).toBeUndefined());
    expect((await getDiscardLog(tenantId))[0]).toMatchObject({ clientId: conflict.clientId, reason: 'user' });
  });

  it('a dependent shows it is waiting, and for what; a retrying item shows when it will be tried again', async () => {
    const tenantId = crypto.randomUUID();
    const customer = await seed(tenantId, 'pendingCustomers', sale({ status: 'conflict', payload: { name: 'Dan' }, failure: { kind: 'DUPLICATE', message: 'exists', at: 1 } }));
    const blocked = await seed(tenantId, 'pendingSales', sale({ status: 'blocked', blockedBy: customer.clientId, failure: { kind: 'DEPENDENCY', message: 'Waiting', at: 1 } }));
    const retrying = await seed(
      tenantId,
      'pendingExpenses',
      sale({ payload: { amount: 3 }, attempts: 2, nextAttemptAt: Date.now() + 60000, failure: { kind: 'SERVER_ERROR', message: 'boom', at: 1 } })
    );
    render(<SyncStatusWidget tenantId={tenantId} online />);
    fireEvent.click(await screen.findByTestId('sync-state'));
    const blockedRow = await screen.findByTestId(`queue-row-${blocked.clientId}`);
    expect(blockedRow).toHaveTextContent('Waiting');
    expect(screen.getByTestId('blocked-detail')).toHaveTextContent(/Waiting for Customer Dan/);
    const retryRow = await screen.findByTestId(`queue-row-${retrying.clientId}`);
    expect(retryRow).toHaveTextContent(/Retrying at/);
    expect(retryRow).toHaveTextContent(/retrying automatically/);
  });

  it('a failed (not conflicting) transaction is counted and explained separately', async () => {
    const tenantId = crypto.randomUUID();
    await seed(tenantId, 'pendingExpenses', sale({ status: 'failed', payload: { amount: 3 }, failure: { kind: 'VALIDATION', status: 422, message: 'Invalid expense data', at: 1 } }));
    render(<SyncStatusWidget tenantId={tenantId} online />);
    const badge = await screen.findByTestId('sync-state');
    expect(badge).toHaveTextContent('1 failed');
    expect(badge).toHaveAttribute('data-state', 'failed');
  });

  it('the panel shows when the transaction actually HAPPENED, not when it was synced', async () => {
    const tenantId = crypto.randomUUID();
    const e = await seed(tenantId, 'pendingSales', sale({ payload: { items: [{ productId: 'p', quantity: 1, unitPrice: 1 }], occurredAt: '2026-06-01T09:30:00.000Z' } }));
    render(<SyncStatusWidget tenantId={tenantId} online />);
    fireEvent.click(await screen.findByTestId('sync-state'));
    const row = await screen.findByTestId(`queue-row-${e.clientId}`);
    expect(row).toHaveTextContent(new Date('2026-06-01T09:30:00.000Z').toLocaleTimeString());
  });
});
