import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Suppliers from './Suppliers';
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
  OUTBOXES: { suppliers: { submit: vi.fn() } },
}));

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.patch.mockReset();
  OUTBOXES.suppliers.submit.mockReset();
  useAuth.mockReturnValue({ user: { tenantId: 't1' } });
});

describe('Suppliers page (Phase 1.7)', () => {
  it('shows the Code column and a supplier\'s code in the list', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [{ id: 's1', name: 'Coded Supplier', code: 'SUP-001', isActive: true }], total: 1 } });
    render(<Suppliers />);
    expect(await screen.findByText('Coded Supplier')).toBeInTheDocument();
    expect(screen.getByText('SUP-001')).toBeInTheDocument();
    expect(screen.getByText('Code')).toBeInTheDocument();
  });

  it('creates a new supplier with code and notes via the existing offline outbox', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [], total: 0 } });
    OUTBOXES.suppliers.submit.mockResolvedValue({ status: 'synced', serverResult: { id: 's2' } });
    render(<Suppliers />);
    await screen.findByText('No suppliers yet.');

    fireEvent.click(screen.getByText('+ New Supplier'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Supplier' } });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'SUP-999' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Reliable vendor' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(OUTBOXES.suppliers.submit).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ name: 'New Supplier', code: 'SUP-999', notes: 'Reliable vendor' })
      )
    );
  });

  it('editing a supplier sends code/notes through the direct PATCH endpoint', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [{ id: 's3', name: 'Editable', code: 'OLD-CODE', isActive: true }], total: 1 } });
    apiClient.patch.mockResolvedValue({ data: { item: {} } });
    render(<Suppliers />);
    await screen.findByText('Editable');

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'NEW-CODE' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/suppliers/s3', expect.objectContaining({ code: 'NEW-CODE' })));
  });
});
