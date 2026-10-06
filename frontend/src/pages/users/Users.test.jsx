import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Users from './Users';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const USERS = [
  { id: 'u1', name: 'Alice Admin', email: 'alice@test.local', role: 'TENANT_ADMIN', branchId: null, isActive: true },
  { id: 'u2', name: 'Bob Cashier', email: 'bob@test.local', role: 'CASHIER', branchId: 'b1', isActive: true },
];
const BRANCHES = [{ id: 'b1', name: 'Main Branch' }];

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  apiClient.patch.mockReset();
  apiClient.delete.mockReset();
  useAuth.mockReturnValue({ user: { id: 'u1', role: 'TENANT_ADMIN' } });

  apiClient.get.mockImplementation((path) => {
    if (path === '/users') return Promise.resolve({ data: { items: USERS } });
    if (path === '/branches') return Promise.resolve({ data: { items: BRANCHES } });
    if (path === '/companies') return Promise.resolve({ data: { items: [] } });
    if (path === '/warehouses') return Promise.resolve({ data: { items: [] } });
    if (path === '/users/u2/access') {
      return Promise.resolve({ data: { primaryBranchId: 'b1', companyAccess: [], branchAccess: [], warehouseAccess: [] } });
    }
    return Promise.resolve({ data: { items: [] } });
  });
});

describe('Users page (Phase 1.2)', () => {
  it('lists users with their role and branch', async () => {
    render(<Users />);
    expect(await screen.findByText('Alice Admin')).toBeInTheDocument();
    expect(screen.getByText('Bob Cashier')).toBeInTheDocument();
    expect(screen.getByText('Main Branch')).toBeInTheDocument();
  });

  it('opens the edit modal pre-filled and disables the role field when editing your own account', async () => {
    render(<Users />);
    await screen.findByText('Alice Admin');
    const editButtons = screen.getAllByText('Edit');
    fireEvent.click(editButtons[0]); // Alice = current user (u1)

    const roleSelect = await screen.findByDisplayValue('TENANT_ADMIN');
    expect(roleSelect).toBeDisabled();
    expect(screen.getByText('You cannot change your own role.')).toBeInTheDocument();
  });

  it('editing a different user leaves the role field enabled and saves changes', async () => {
    apiClient.patch.mockResolvedValue({ data: { item: { ...USERS[1], role: 'MANAGER' } } });
    render(<Users />);
    await screen.findByText('Bob Cashier');
    const editButtons = screen.getAllByText('Edit');
    fireEvent.click(editButtons[1]); // Bob = not current user

    const roleSelect = await screen.findByDisplayValue('CASHIER');
    expect(roleSelect).not.toBeDisabled();
    fireEvent.change(roleSelect, { target: { value: 'MANAGER' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/users/u2', expect.objectContaining({ role: 'MANAGER' })));
  });

  it('opens the Manage Access panel and grants a warehouse via the existing per-resource endpoint', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/users') return Promise.resolve({ data: { items: USERS } });
      if (path === '/branches') return Promise.resolve({ data: { items: BRANCHES } });
      if (path === '/companies') return Promise.resolve({ data: { items: [] } });
      if (path === '/warehouses') return Promise.resolve({ data: { items: [{ id: 'w1', name: 'Main Warehouse' }] } });
      if (path === '/users/u2/access') {
        return Promise.resolve({ data: { primaryBranchId: 'b1', companyAccess: [], branchAccess: [], warehouseAccess: [] } });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    apiClient.post.mockResolvedValue({ data: { item: {} } });

    render(<Users />);
    await screen.findByText('Bob Cashier');
    const accessButtons = screen.getAllByText('Access');
    fireEvent.click(accessButtons[1]);

    await screen.findByText('Manage Access - Bob Cashier');
    const warehouseSelect = await screen.findByText('+ Grant access to a warehouse...');
    fireEvent.change(warehouseSelect.closest('select'), { target: { value: 'w1' } });

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/warehouses/w1/access', { userId: 'u2' }));
  });
});
