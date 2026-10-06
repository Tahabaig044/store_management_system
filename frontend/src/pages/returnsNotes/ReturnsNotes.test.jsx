// Phase 3.3: the Returns & Notes screen works from the local lists with no network, refuses what cannot be
// returned, and queues what can.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReturnsNotes from './ReturnsNotes';
import { useAuth } from '../../context/AuthContext';
import { getOfflineDb } from '../../offline/db';
import { unlockFor, putSealed } from '../../test/secure';

vi.mock('../../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('offline')), post: vi.fn().mockRejectedValue(new Error('Network Error')) } }));
vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const SLOW = { timeout: 5000 };
let tenantId;
beforeEach(() => {
  setOnline(false);
  tenantId = `rn-${crypto.randomUUID()}`;
  useAuth.mockReturnValue({ user: { tenantId, role: 'TENANT_ADMIN' }, hasPermission: () => true });
});
afterEach(() => setOnline(true));

const seedSale = async () => {
  const db = getOfflineDb(tenantId);
  await db.products.put({ id: 'p1', name: 'Frame', stockQuantity: 5, _baseStock: 5 });
  await unlockFor(tenantId);
  await putSealed(tenantId, 'returnableSales', [{ id: 's1', invoiceNumber: 'INV-1', customerId: null, customerName: null, warehouseId: null, createdAt: '2026-06-01T10:00:00Z', total: 30, items: [{ id: 'i1', productId: 'p1', name: 'Frame', quantity: 3, returnedQuantity: 0, unitPrice: 10 }], isActive: true }]);
};

describe('Returns & Notes (offline)', () => {
  it('records a sales return with no connection: saved on the device, stock goes back on the shelf, and what is left to return shrinks', async () => {
    await seedSale();
    render(<ReturnsNotes />);
    await screen.findByRole('option', { name: /INV-1/ }, SLOW); // first open of a fresh IndexedDB can take a moment under load
    fireEvent.change(screen.getByLabelText('Sale'), { target: { value: 's1' } });
    fireEvent.change(await screen.findByLabelText('Return Frame', {}, SLOW), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record return' }));

    expect(await screen.findByTestId('submit-result', {}, SLOW)).toHaveTextContent(/saved on this device/);
    const rows = await getOfflineDb(tenantId).pendingSalesReturns.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.items).toEqual([{ saleItemId: 'i1', quantity: 2 }]);
    expect(rows[0].display.products).toEqual({ i1: 'p1' });
    await waitFor(async () => expect((await getOfflineDb(tenantId).products.get('p1')).stockQuantity).toBe(7));
  });

  it('refuses a quantity above what can still be returned, and stores nothing', async () => {
    await seedSale();
    render(<ReturnsNotes />);
    await screen.findByRole('option', { name: /INV-1/ }, SLOW); // first open of a fresh IndexedDB can take a moment under load
    fireEvent.change(screen.getByLabelText('Sale'), { target: { value: 's1' } });
    fireEvent.change(await screen.findByLabelText('Return Frame', {}, SLOW), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record return' }));
    expect(await screen.findByTestId('submit-result', {}, SLOW)).toHaveTextContent(/Only 3 of Frame can still be returned/);
    expect(await getOfflineDb(tenantId).pendingSalesReturns.count()).toBe(0);
  });

  it('a role that may not record returns or notes sees no forms', () => {
    useAuth.mockReturnValue({ user: { tenantId, role: 'DOCTOR' }, hasPermission: () => false });
    render(<ReturnsNotes />);
    expect(screen.getByText(/cannot record returns or notes/)).toBeInTheDocument();
  });
});
