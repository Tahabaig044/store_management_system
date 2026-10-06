import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StockTransfers from './StockTransfers';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' }, hasPermission: () => true });
});

describe('StockTransfers page', () => {
  it('lists transfers and offers a Dispatch action for an approved one', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/stock-transfers') {
        return Promise.resolve({
          data: {
            items: [{
              id: 't1',
              transferNumber: 'TRF-000001',
              sourceWarehouse: { name: 'Warehouse A' },
              destinationWarehouse: { name: 'Warehouse B' },
              items: [{ productId: 'p1', quantity: 5, product: { name: 'Frame A' } }],
              status: 'APPROVED',
            }],
          },
        });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    render(<StockTransfers />);
    expect(await screen.findByText('TRF-000001')).toBeInTheDocument();
    expect(screen.getByText('Dispatch')).toBeInTheDocument();
  });

  it('dispatching calls the dispatch endpoint', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/stock-transfers') {
        return Promise.resolve({
          data: {
            items: [{
              id: 't1',
              transferNumber: 'TRF-000001',
              sourceWarehouse: { name: 'Warehouse A' },
              destinationWarehouse: { name: 'Warehouse B' },
              items: [{ productId: 'p1', quantity: 5, product: { name: 'Frame A' } }],
              status: 'APPROVED',
            }],
          },
        });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    apiClient.post.mockResolvedValue({ data: { item: {} } });
    render(<StockTransfers />);
    fireEvent.click(await screen.findByText('Dispatch'));
    expect(apiClient.post).toHaveBeenCalledWith('/stock-transfers/t1/dispatch', {});
  });
});
