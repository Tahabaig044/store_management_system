import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Expenses from './Expenses';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES, refreshCaches } from '../../offline/syncEngine';
import { useLiveExpenseCategories, useLiveSuppliers } from '../../offline/useOfflineData';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));
vi.mock('../../offline/syncEngine', () => ({
  OUTBOXES: { expenses: { submit: vi.fn() } },
  refreshCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../offline/useOfflineData', () => ({
  useLiveExpenseCategories: vi.fn(),
  useLiveSuppliers: vi.fn(),
}));

const CATEGORIES = [{ id: 'c1', name: 'Rent' }];
const EXPENSES = [
  {
    id: 'e1',
    expenseNumber: 'EXP-000001',
    category: { name: 'Rent' },
    description: 'Office rent',
    notes: '',
    status: 'PAID',
    amount: 500,
    expenseDate: new Date().toISOString(),
  },
];

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.patch.mockReset();
  OUTBOXES.expenses.submit.mockReset();
  refreshCaches.mockClear();
  useAuth.mockReturnValue({ user: { tenantId: 't1' }, hasPermission: () => true });
  useLiveExpenseCategories.mockReturnValue(CATEGORIES);
  useLiveSuppliers.mockReturnValue([]);
  apiClient.get.mockImplementation((path) => {
    if (path === '/expenses') return Promise.resolve({ data: { items: EXPENSES, total: 1 } });
    return Promise.resolve({ data: { items: [] } });
  });
});

describe('Expenses page (Phase 1.12)', () => {
  it('lists expenses with number, status, and amount', async () => {
    render(<MemoryRouter><Expenses /></MemoryRouter>);
    expect(await screen.findByText('EXP-000001')).toBeInTheDocument();
    expect(screen.getByText('Office rent')).toBeInTheDocument();
    expect(screen.getByText('PAID')).toBeInTheDocument();
  });

  it('creates an expense with a payment method through the offline outbox', async () => {
    OUTBOXES.expenses.submit.mockResolvedValue({ status: 'synced' });
    render(<MemoryRouter><Expenses /></MemoryRouter>);
    await screen.findByText('EXP-000001');

    fireEvent.click(screen.getByText('+ New Expense'));
    fireEvent.change(screen.getByDisplayValue('Select category...'), { target: { value: 'c1' } });
    const amountInput = document.querySelector('input[type="number"]');
    fireEvent.change(amountInput, { target: { value: '75' } });
    fireEvent.change(screen.getByDisplayValue('Cash'), { target: { value: 'card' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(OUTBOXES.expenses.submit).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ categoryId: 'c1', amount: 75, method: 'card' })
      )
    );
  });

  it('shows a queued (offline) notice when the expense cannot sync immediately', async () => {
    OUTBOXES.expenses.submit.mockResolvedValue({ status: 'pending' });
    render(<MemoryRouter><Expenses /></MemoryRouter>);
    await screen.findByText('EXP-000001');

    fireEvent.click(screen.getByText('+ New Expense'));
    fireEvent.change(screen.getByDisplayValue('Select category...'), { target: { value: 'c1' } });
    fireEvent.change(document.querySelector('input[type="number"]'), { target: { value: '20' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText(/will appear in the list once it's synced/)).toBeInTheDocument();
  });

  it('shows a Reverse button when the user has EXPENSE:REVERSE, and calls the reverse endpoint', async () => {
    apiClient.post = vi.fn().mockResolvedValue({ data: { item: { ...EXPENSES[0], status: 'REVERSED' } } });
    window.confirm = vi.fn().mockReturnValue(true);
    render(<MemoryRouter><Expenses /></MemoryRouter>);
    await screen.findByText('EXP-000001');

    fireEvent.click(screen.getByText('Reverse'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/expenses/e1/reverse'));
  });

  it('does not show a Reverse button without EXPENSE:REVERSE permission', async () => {
    useAuth.mockReturnValue({ user: { tenantId: 't1' }, hasPermission: (key) => key !== 'EXPENSE:REVERSE' });
    render(<MemoryRouter><Expenses /></MemoryRouter>);
    await screen.findByText('EXP-000001');
    expect(screen.queryByText('Reverse')).not.toBeInTheDocument();
  });

  it('filters by status and re-fetches', async () => {
    render(<MemoryRouter><Expenses /></MemoryRouter>);
    await screen.findByText('EXP-000001');

    fireEvent.change(screen.getByDisplayValue('All Statuses'), { target: { value: 'REVERSED' } });

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith('/expenses', expect.objectContaining({ params: expect.objectContaining({ status: 'REVERSED' }) }))
    );
  });
});
