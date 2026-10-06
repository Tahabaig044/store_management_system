import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SyncStatusWidget from './SyncStatusWidget';
import { getOfflineDb } from '../offline/db';

vi.mock('../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('offline')), post: vi.fn().mockRejectedValue(new Error('Network Error')) } }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
afterEach(() => setOnline(true));

const sale = (over = {}) => ({
  clientId: crypto.randomUUID(),
  status: 'pending',
  createdAt: Date.now(),
  payload: { items: [{ productId: 'p1', quantity: 7, unitPrice: 10 }], amountPaid: 70, paymentMethod: 'cash', occurredAt: '2026-06-01T09:30:00.000Z', idempotencyKey: 'k-1' },
  attempts: 0,
  failure: null,
  lastError: null,
  serverResult: null,
  dependsOn: [],
  ...over,
});
const seed = async (tenantId, table, entry) => {
  await getOfflineDb(tenantId)[table].add(entry);
  return entry;
};
const openPanel = async () => fireEvent.click(await screen.findByTestId('sync-state'));

describe('Edit-and-retry UI (Phase 3.3)', () => {
  it('a stock conflict offers the server-derived fix; applying it and saving re-queues the edited sale with the change logged', async () => {
    const tenantId = crypto.randomUUID();
    await getOfflineDb(tenantId).products.put({ id: 'p1', name: 'Widget', stockQuantity: 10 });
    const entry = await seed(tenantId, 'pendingSales', sale({
      status: 'conflict',
      failure: { kind: 'STOCK_INSUFFICIENT', code: 'STOCK_INSUFFICIENT', status: 409, message: 'Insufficient stock for Widget (available: 4)', details: { productId: 'p1', name: 'Widget', available: 4, requested: 7 }, at: Date.now() },
    }));
    render(<SyncStatusWidget tenantId={tenantId} online />);
    await openPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(await screen.findByTestId('edit-conflict')).toHaveTextContent('Not enough stock on the server');
    expect(screen.getByTestId('edit-suggestion')).toHaveTextContent('Reduce Widget from 7 to 4');
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    expect(screen.getByLabelText('Qty 1')).toHaveValue(4);

    fireEvent.click(screen.getByRole('button', { name: 'Save and retry' }));
    await waitFor(async () => {
      const row = await getOfflineDb(tenantId).pendingSales.get(entry.clientId);
      expect(row.payload.items[0].quantity).toBe(4);
      expect(row.payload.amountPaid).toBe(40);
      expect(row.status).toBe('pending'); // the network is down in this test: re-queued, not lost
      expect(row.revisions[0].resolved.kind).toBe('STOCK_INSUFFICIENT');
      expect(row.payload.idempotencyKey).toBe('k-1');
    });
  });

  it('a manual edit is validated: an impossible quantity is refused with a reason and nothing is saved', async () => {
    const tenantId = crypto.randomUUID();
    const entry = await seed(tenantId, 'pendingSales', sale());
    render(<SyncStatusWidget tenantId={tenantId} online />);
    await openPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Qty 1'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and retry' }));
    expect(await screen.findByTestId('edit-error')).toHaveTextContent(/greater than zero/);
    expect((await getOfflineDb(tenantId).pendingSales.get(entry.clientId)).payload.items[0].quantity).toBe(7);
  });

  it('a transaction that may already be on the server must be checked first; it is not editable until then', async () => {
    const tenantId = crypto.randomUUID();
    await seed(tenantId, 'pendingSales', sale({ maybeApplied: true, lastError: 'Waiting for the network' }));
    render(<SyncStatusWidget tenantId={tenantId} online />);
    await openPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Check / Edit' }));
    expect(await screen.findByTestId('edit-blocked')).toHaveTextContent(/may already have it/);
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save and retry' })).not.toBeInTheDocument();
  });

  it('accepted transactions and reversals offer no Edit', async () => {
    const tenantId = crypto.randomUUID();
    await seed(tenantId, 'pendingSales', sale({ status: 'synced', syncedAt: Date.now(), serverResult: { id: 's' } }));
    await seed(tenantId, 'pendingReversals', sale({ payload: { saleId: 's1', invoiceNumber: 'INV-1' } }));
    render(<SyncStatusWidget tenantId={tenantId} online />);
    await openPanel();
    await screen.findAllByTestId(/queue-row-/);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows the edit history of a transaction that was edited', async () => {
    const tenantId = crypto.randomUUID();
    const entry = await seed(tenantId, 'pendingSales', sale({ editedAt: Date.now(), revisions: [{ at: Date.now(), changes: [{ path: 'items.0.quantity', from: 7, to: 4 }], resolved: { kind: 'STOCK_INSUFFICIENT', message: 'm' } }] }));
    render(<SyncStatusWidget tenantId={tenantId} online />);
    await openPanel();
    expect(await screen.findByTestId(`queue-row-${entry.clientId}`)).toHaveTextContent(/Edited/);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByTestId('edit-history')).toHaveTextContent('items.0.quantity: 7 -> 4');
  });
});
