import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Customers from './Customers';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES } from '../../offline/syncEngine';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../offline/syncEngine', () => ({
  OUTBOXES: { customers: { submit: vi.fn() } },
}));

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.patch.mockReset();
  OUTBOXES.customers.submit.mockReset();
  useAuth.mockReturnValue({ user: { tenantId: 't1' } });
});

describe('Customers page (Phase 1.6)', () => {
  it('shows the Code column and a customer\'s code in the list', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [{ id: 'c1', name: 'Coded Customer', code: 'CUST-001', isActive: true }], total: 1 } });
    render(<Customers />);
    expect(await screen.findByText('Coded Customer')).toBeInTheDocument();
    expect(screen.getByText('CUST-001')).toBeInTheDocument();
    expect(screen.getByText('Code')).toBeInTheDocument();
  });

  it('creates a new customer with code and notes via the existing offline outbox', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [], total: 0 } });
    OUTBOXES.customers.submit.mockResolvedValue({ status: 'synced', serverResult: { id: 'c2' } });
    render(<Customers />);
    await screen.findByText('No customers yet.');

    fireEvent.click(screen.getByText('+ New Customer'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Customer' } });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'CUST-999' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'VIP client' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(OUTBOXES.customers.submit).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ name: 'New Customer', code: 'CUST-999', notes: 'VIP client' })
      )
    );
  });

  it('editing a customer sends code/notes through the direct PATCH endpoint', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [{ id: 'c3', name: 'Editable', code: 'OLD-CODE', isActive: true }], total: 1 } });
    apiClient.patch.mockResolvedValue({ data: { item: {} } });
    render(<Customers />);
    await screen.findByText('Editable');

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'NEW-CODE' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/customers/c3', expect.objectContaining({ code: 'NEW-CODE' })));
  });
});
