import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Branches from './Branches';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const BRANCHES = [
  { id: 'b1', name: 'Main Branch', companyId: 'c1', code: '', phone: '', address: '', isOpen: true, isActive: true, isMain: true },
  { id: 'b2', name: 'Second Branch', companyId: 'c1', code: '', phone: '', address: '', isOpen: true, isActive: true, isMain: false },
];

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.patch.mockReset();
  useAuth.mockReturnValue({ hasPermission: () => true });

  apiClient.get.mockImplementation((path) => {
    if (path === '/branches') return Promise.resolve({ data: { items: BRANCHES, total: BRANCHES.length } });
    if (path === '/companies') return Promise.resolve({ data: { items: [{ id: 'c1', name: 'Main Company' }] } });
    return Promise.resolve({ data: { items: [] } });
  });
});

describe('Branches page (Phase 1.3)', () => {
  it('shows a Main badge on the main branch and a "Set as Main" action on others', async () => {
    render(<Branches />);
    await screen.findByText('Main Branch');
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('Set as Main')).toBeInTheDocument();
  });

  it('promotes a different branch to Main via the existing PATCH endpoint', async () => {
    apiClient.patch.mockResolvedValue({ data: { item: { ...BRANCHES[1], isMain: true } } });
    render(<Branches />);
    await screen.findByText('Second Branch');
    fireEvent.click(screen.getByText('Set as Main'));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/branches/b2', { isMain: true }));
  });
});
