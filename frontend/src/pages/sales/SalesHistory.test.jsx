import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SalesHistory from './SalesHistory';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const SALES = [
  {
    id: 's1',
    invoiceNumber: 'INV-000001',
    createdAt: new Date().toISOString(),
    customer: { name: 'Jane Doe' },
    cashier: { name: 'Cashier One' },
    total: 100,
    amountPaid: 100,
    paymentStatus: 'PAID',
    status: 'COMPLETED',
    items: [],
  },
];
const CUSTOMERS = [{ id: 'c1', name: 'Jane Doe' }];

beforeEach(() => {
  apiClient.get.mockReset();
  useAuth.mockReturnValue({ user: { tenantId: 't1' }, hasPermission: () => true });
  apiClient.get.mockImplementation((path) => {
    if (path === '/sales') return Promise.resolve({ data: { items: SALES, total: 1 } });
    if (path === '/customers') return Promise.resolve({ data: { items: CUSTOMERS } });
    return Promise.resolve({ data: { items: [] } });
  });
});

describe('SalesHistory page (Phase 1.8)', () => {
  it('lists sales and renders the new customer/status/paymentStatus filters', async () => {
    render(<MemoryRouter><SalesHistory /></MemoryRouter>);
    expect(await screen.findByText('INV-000001')).toBeInTheDocument();
    expect(screen.getByText('All Customers')).toBeInTheDocument();
    expect(screen.getByText('All Statuses')).toBeInTheDocument();
    expect(screen.getByText('All Payment Statuses')).toBeInTheDocument();
  });

  it('filtering by customer calls the API with the customerId param', async () => {
    render(<MemoryRouter><SalesHistory /></MemoryRouter>);
    await screen.findByText('INV-000001');

    fireEvent.change(screen.getByDisplayValue('All Customers'), { target: { value: 'c1' } });

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith('/sales', expect.objectContaining({ params: expect.objectContaining({ customerId: 'c1' }) }))
    );
  });

  it('filtering by status calls the API with the status param', async () => {
    render(<MemoryRouter><SalesHistory /></MemoryRouter>);
    await screen.findByText('INV-000001');

    fireEvent.change(screen.getByDisplayValue('All Statuses'), { target: { value: 'REVERSED' } });

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith('/sales', expect.objectContaining({ params: expect.objectContaining({ status: 'REVERSED' }) }))
    );
  });

  it('shows notes in the sale detail view when present', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/sales') return Promise.resolve({ data: { items: [{ ...SALES[0], notes: 'Gift wrap requested', subtotal: 100, discount: 0, tax: 0 }], total: 1 } });
      if (path === '/customers') return Promise.resolve({ data: { items: CUSTOMERS } });
      return Promise.resolve({ data: { items: [] } });
    });
    render(<MemoryRouter><SalesHistory /></MemoryRouter>);
    fireEvent.click(await screen.findByText('INV-000001'));
    expect(await screen.findByText('Gift wrap requested')).toBeInTheDocument();
  });
});
