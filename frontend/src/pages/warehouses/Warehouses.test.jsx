import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Warehouses from './Warehouses';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES } from '../../offline/syncEngine';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));
vi.mock('../../offline/syncEngine', () => ({
  OUTBOXES: { warehouseStockMoves: { submit: vi.fn() } },
}));

beforeEach(() => {
  apiClient.get.mockReset();
  OUTBOXES.warehouseStockMoves.submit.mockReset();
  useAuth.mockReturnValue({ user: { tenantId: 't1', role: 'TENANT_ADMIN' }, hasPermission: () => true });
});

describe('Warehouses page', () => {
  it('lists warehouses and shows stock when one is selected', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/warehouses') {
        return Promise.resolve({ data: { items: [{ id: 'w1', name: 'Main Warehouse', code: 'WH-1', branch: { name: 'Main Branch' } }] } });
      }
      if (path === '/warehouses/w1/stock') {
        return Promise.resolve({ data: { warehouse: { id: 'w1' }, items: [{ productId: 'p1', name: 'Frame A', quantity: 12, lowStock: false }], totalValue: 240 } });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    render(<Warehouses />);
    const listItem = await screen.findByText(/Main Warehouse/);

    fireEvent.click(listItem);
    expect((await screen.findAllByText('Frame A')).length).toBeGreaterThan(0);
    expect(screen.getByText('Rs. 240.00')).toBeInTheDocument();
  });

  it('shows a Default badge and lets a manager set a non-default warehouse as default (Phase 1.3)', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/warehouses') {
        return Promise.resolve({
          data: {
            items: [
              { id: 'w1', name: 'Main Warehouse', code: 'WH-1', branch: { name: 'Main Branch' }, isDefault: true },
              { id: 'w2', name: 'Second Warehouse', code: 'WH-2', branch: { name: 'Second Branch' }, isDefault: false },
            ],
          },
        });
      }
      if (path === '/branches') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: { items: [] } });
    });
    apiClient.patch.mockResolvedValue({ data: { item: {} } });

    render(<Warehouses />);
    await screen.findByText('Main Warehouse');
    expect(screen.getByText('Default')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Set Default'));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/warehouses/w2', { isDefault: true }));
  });

  it('opens the Edit modal pre-filled for an existing warehouse', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/warehouses') {
        return Promise.resolve({ data: { items: [{ id: 'w1', name: 'Main Warehouse', code: 'WH-1', branch: { name: 'Main Branch' }, isDefault: false }] } });
      }
      if (path === '/branches') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: { items: [] } });
    });

    render(<Warehouses />);
    await screen.findByText('Main Warehouse');
    fireEvent.click(screen.getByText('Edit'));

    expect(await screen.findByText('Edit Warehouse')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Main Warehouse')).toBeInTheDocument();
  });

  describe('Receive/Dispatch through the offline outbox (Phase 1.10)', () => {
    beforeEach(() => {
      apiClient.get.mockImplementation((path) => {
        if (path === '/warehouses') {
          return Promise.resolve({ data: { items: [{ id: 'w1', name: 'Main Warehouse', code: 'WH-1', branch: { name: 'Main Branch' } }] } });
        }
        if (path === '/warehouses/w1/stock') {
          return Promise.resolve({ data: { warehouse: { id: 'w1' }, items: [{ productId: 'p1', name: 'Frame A', quantity: 12, lowStock: false }], totalValue: 240 } });
        }
        return Promise.resolve({ data: { items: [] } });
      });
    });

    it('a receive that syncs immediately submits through the outbox and refreshes the stock list', async () => {
      OUTBOXES.warehouseStockMoves.submit.mockResolvedValue({ status: 'synced' });
      render(<Warehouses />);
      fireEvent.click(await screen.findByText(/Main Warehouse/));
      await screen.findAllByText('Frame A');

      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'p1' } });
      const numberInput = document.querySelector('input[type="number"]');
      fireEvent.change(numberInput, { target: { value: '5' } });

      fireEvent.click(screen.getByText('Receive'));

      await waitFor(() =>
        expect(OUTBOXES.warehouseStockMoves.submit).toHaveBeenCalledWith(
          't1',
          expect.objectContaining({ warehouseId: 'w1', action: 'receive', productId: 'p1', quantity: 5 })
        )
      );
    });

    it('a dispatch made while offline is queued and shown as pending, without erroring', async () => {
      OUTBOXES.warehouseStockMoves.submit.mockResolvedValue({ status: 'pending' });
      render(<Warehouses />);
      fireEvent.click(await screen.findByText(/Main Warehouse/));
      await screen.findAllByText('Frame A');

      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'p1' } });
      const numberInput = document.querySelector('input[type="number"]');
      fireEvent.change(numberInput, { target: { value: '3' } });

      fireEvent.click(screen.getByText('Dispatch'));

      await waitFor(() =>
        expect(OUTBOXES.warehouseStockMoves.submit).toHaveBeenCalledWith(
          't1',
          expect.objectContaining({ warehouseId: 'w1', action: 'dispatch', productId: 'p1', quantity: 3 })
        )
      );
      expect(await screen.findByText(/will appear in the warehouse stock list once it's synced/)).toBeInTheDocument();
    });

    it('a conflict at sync time (e.g. insufficient stock) surfaces an error without crashing', async () => {
      OUTBOXES.warehouseStockMoves.submit.mockResolvedValue({ status: 'conflict', lastError: 'Insufficient stock for Frame A at this warehouse (available: 2)' });
      render(<Warehouses />);
      fireEvent.click(await screen.findByText(/Main Warehouse/));
      await screen.findAllByText('Frame A');

      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'p1' } });
      const numberInput = document.querySelector('input[type="number"]');
      fireEvent.change(numberInput, { target: { value: '50' } });

      fireEvent.click(screen.getByText('Dispatch'));

      expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
    });
  });
});
