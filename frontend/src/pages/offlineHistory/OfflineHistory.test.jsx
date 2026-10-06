// Phase 3.4: the History & Statements screen works from the device with no connection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OfflineHistory from './OfflineHistory';
import { useAuth } from '../../context/AuthContext';
import { lock } from '../../offline/secureStore';
import { getOfflineDb } from '../../offline/db';
import { OUTBOXES } from '../../offline/syncEngine';
import { unlockFor, putSealed } from '../../test/secure';

vi.mock('../../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('offline')), post: vi.fn().mockRejectedValue(new Error('Network Error')) } }));
vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));

const SLOW = { timeout: 8000 };
const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
let tenantId;
beforeEach(async () => {
  setOnline(false);
  lock();
  tenantId = `oh-${crypto.randomUUID()}`;
  await unlockFor(tenantId);
  useAuth.mockReturnValue({ user: { tenantId }, hasPermission: () => true });
});
afterEach(() => { setOnline(true); lock(); });

const sale = (id, over = {}) => ({ id, number: `INV-${id}`, partyId: 'c1', partyName: 'Hana', date: new Date().toISOString(), status: 'COMPLETED', paymentMethod: 'cash', total: 100, amountPaid: 100, isActive: true, ...over });

describe('History & Statements (offline)', { timeout: 30000 }, () => {
  it('lists sales from the device, including this terminal\'s unsynced one, and says how fresh the copy is', async () => {
    await putSealed(tenantId, 'salesHistory', [sale('s1')]);
    await getOfflineDb(tenantId).meta.put({ key: 'dataset:salesHistory', value: { lastCheckedAt: Date.now() - 120000, serverTime: 'x' } });
    await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p', quantity: 1, unitPrice: 12 }], amountPaid: 12, paymentMethod: 'cash' });
    render(<OfflineHistory />);
    expect(await screen.findByText('INV-s1', {}, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('Not synced yet', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByTestId('asof')).toHaveTextContent(/As of the last download/);
  });

  it('a view that was never downloaded says so instead of showing an empty table as if it were the truth', async () => {
    render(<OfflineHistory />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Purchase history' }, SLOW));
    expect(await screen.findByTestId('asof', {}, SLOW)).toHaveTextContent(/Nothing has been downloaded/);
  });

  it('the summary separates what the server accepted from what is still on this terminal', async () => {
    await putSealed(tenantId, 'salesHistory', [sale('a', { total: 100 }), sale('b', { total: 40, amountPaid: 40 })]);
    await OUTBOXES.sales.queue(tenantId, { items: [{ productId: 'p', quantity: 1, unitPrice: 25 }], amountPaid: 25, paymentMethod: 'cash' });
    render(<OfflineHistory />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Sales summary' }, SLOW));
    const box = await screen.findByTestId('summary', {}, SLOW);
    expect(await screen.findByText(/Accepted by the server \(2\)/, {}, SLOW)).toBeInTheDocument();
    expect(box).toHaveTextContent(/Still on this terminal \(1\)/);
  });

  it('a role that cannot view anything sees no history', () => {
    useAuth.mockReturnValue({ user: { tenantId }, hasPermission: () => false });
    render(<OfflineHistory />);
    expect(screen.getByText(/cannot view history/)).toBeInTheDocument();
  });
});
