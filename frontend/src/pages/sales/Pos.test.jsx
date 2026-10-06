import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Pos from './Pos';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES, refreshCaches } from '../../offline/syncEngine';
import { useLiveProducts, useLiveCustomers } from '../../offline/useOfflineData';

vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));
vi.mock('../../offline/syncEngine', () => ({
  OUTBOXES: { sales: { submit: vi.fn() } },
  refreshCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../offline/useOfflineData', () => ({
  useLiveProducts: vi.fn(),
  useLiveCustomers: vi.fn(),
}));

const PRODUCTS = [{ id: 'p1', name: 'Cached Frame', sku: 'FRM-1', barcode: '', sellingPrice: 25, stockQuantity: 8, lowStockThreshold: 2 }];
const CUSTOMERS = [{ id: 'c1', name: 'Walk-in Regular' }];

beforeEach(() => {
  OUTBOXES.sales.submit.mockReset();
  refreshCaches.mockClear();
  useAuth.mockReturnValue({ user: { tenantId: 't1' } });
  useLiveProducts.mockReturnValue(PRODUCTS);
  useLiveCustomers.mockReturnValue(CUSTOMERS);
});

describe('Pos page (Phase 1.8)', () => {
  it('renders cached products (works offline, reads from local cache via the existing hooks)', async () => {
    render(<MemoryRouter><Pos /></MemoryRouter>);
    expect(await screen.findByText('Cached Frame')).toBeInTheDocument();
  });

  it('adds a product to the cart and completes checkout through the existing offline outbox', async () => {
    OUTBOXES.sales.submit.mockResolvedValue({
      status: 'synced',
      serverResult: { invoiceNumber: 'INV-000001', total: 25, items: [{ id: 'i1', quantity: 1, lineTotal: 25 }] },
    });
    render(<MemoryRouter><Pos /></MemoryRouter>);

    fireEvent.click(await screen.findByText('Cached Frame'));
    expect(screen.getByText('Complete Sale')).not.toBeDisabled();

    fireEvent.click(screen.getByText('Complete Sale'));

    await waitFor(() =>
      expect(OUTBOXES.sales.submit).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ items: [expect.objectContaining({ productId: 'p1', quantity: 1 })] })
      )
    );
    expect(await screen.findByText('Sale Completed')).toBeInTheDocument();
  });

  it('shows a queued (offline) receipt when the sale cannot sync immediately', async () => {
    OUTBOXES.sales.submit.mockResolvedValue({
      status: 'pending',
      payload: { items: [{ quantity: 1, unitPrice: 25, discount: 0 }] },
    });
    render(<MemoryRouter><Pos /></MemoryRouter>);

    fireEvent.click(await screen.findByText('Cached Frame'));
    fireEvent.click(screen.getByText('Complete Sale'));

    expect(await screen.findByText('Sale Queued')).toBeInTheDocument();
  });

  it('surfaces a conflict error without clearing the cart', async () => {
    OUTBOXES.sales.submit.mockResolvedValue({ status: 'conflict', lastError: 'Insufficient stock for Cached Frame (available: 0)' });
    render(<MemoryRouter><Pos /></MemoryRouter>);

    fireEvent.click(await screen.findByText('Cached Frame'));
    fireEvent.click(screen.getByText('Complete Sale'));

    expect(await screen.findByText(/Sale could not be completed/)).toBeInTheDocument();
  });

  it('Phase 5.2: arriving via a Bill Visit link pre-selects the customer and tags the sale with the appointment', async () => {
    OUTBOXES.sales.submit.mockResolvedValue({
      status: 'synced',
      serverResult: { invoiceNumber: 'INV-000002', total: 25, items: [{ id: 'i1', quantity: 1, lineTotal: 25 }] },
    });
    render(
      <MemoryRouter initialEntries={['/pos?appointmentId=appt1&customerId=c1']}>
        <Pos />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Billing clinical visit/)).toBeInTheDocument();

    fireEvent.click(await screen.findByText('Cached Frame'));
    fireEvent.click(screen.getByText('Complete Sale'));

    await waitFor(() =>
      expect(OUTBOXES.sales.submit).toHaveBeenCalledWith('t1', expect.objectContaining({ customerId: 'c1', appointmentId: 'appt1' }))
    );
  });
});
