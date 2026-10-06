import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OpticalOrders from './OpticalOrders';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES, refreshCaches } from '../../offline/syncEngine';
import { useLiveCustomers } from '../../offline/useOfflineData';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));
vi.mock('../../offline/syncEngine', () => ({
  OUTBOXES: { opticalOrders: { submit: vi.fn() } },
  refreshCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../offline/useOfflineData', () => ({
  useLiveCustomers: vi.fn(),
}));

const FRAME = { id: 'frm1', name: 'Ray Classic', sku: 'FRM-1', sellingPrice: 100, stockQuantity: 5 };
const LENS = { id: 'lns1', name: 'Anti-Glare Lens', sku: 'LNS-1', sellingPrice: 50, stockQuantity: 10 };

beforeEach(() => {
  apiClient.get.mockReset();
  OUTBOXES.opticalOrders.submit.mockReset();
  refreshCaches.mockClear();
  useAuth.mockReturnValue({ user: { tenantId: 't1' } });
  useLiveCustomers.mockReturnValue([{ id: 'c1', name: 'Jane Doe' }]);
  apiClient.get.mockImplementation((path, config) => {
    if (path === '/optical-orders') return Promise.resolve({ data: { items: [], total: 0 } });
    if (path === '/products' && config?.params?.type === 'FRAME') return Promise.resolve({ data: { items: [FRAME] } });
    if (path === '/products' && config?.params?.type === 'LENS') return Promise.resolve({ data: { items: [LENS] } });
    return Promise.resolve({ data: { items: [] } });
  });
});

describe('OpticalOrders page - Phase 5.1 frame/lens inventory picker', () => {
  it('lists frame and lens products from inventory in the New Order form', async () => {
    render(<MemoryRouter><OpticalOrders /></MemoryRouter>);
    fireEvent.click(screen.getByText('+ New Order'));
    expect(await screen.findByText(/Ray Classic/)).toBeInTheDocument();
    expect(screen.getByText(/Anti-Glare Lens/)).toBeInTheDocument();
  });

  it('submits picked frame/lens as stock-linked order items', async () => {
    OUTBOXES.opticalOrders.submit.mockResolvedValue({ status: 'synced' });
    render(<MemoryRouter><OpticalOrders /></MemoryRouter>);
    fireEvent.click(screen.getByText('+ New Order'));

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Frame (from inventory, optional)'), { target: { value: 'frm1' } });
    fireEvent.change(screen.getByLabelText('Lens (from inventory, optional)'), { target: { value: 'lns1' } });
    expect(screen.getByText(/will deduct real stock/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(OUTBOXES.opticalOrders.submit).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          items: [
            { productId: 'frm1', quantity: 1, unitPrice: 100 },
            { productId: 'lns1', quantity: 1, unitPrice: 50 },
          ],
        })
      )
    );
  });

  it('omits items entirely when no frame/lens is picked (backward compatible free-text order)', async () => {
    OUTBOXES.opticalOrders.submit.mockResolvedValue({ status: 'synced' });
    render(<MemoryRouter><OpticalOrders /></MemoryRouter>);
    fireEvent.click(screen.getByText('+ New Order'));

    fireEvent.change(await screen.findByLabelText('Customer'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(OUTBOXES.opticalOrders.submit).toHaveBeenCalledWith('t1', expect.objectContaining({ items: undefined }))
    );
  });
});
