import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import RolesPermissions from './RolesPermissions';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn() },
}));

beforeEach(() => {
  apiClient.get.mockReset();
});

describe('RolesPermissions page (Phase 1.2)', () => {
  it('renders the catalog as a resource/action x role matrix', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        items: [
          { id: '1', resource: 'PRODUCT', action: 'VIEW', key: 'PRODUCT:VIEW', roles: ['TENANT_ADMIN', 'MANAGER', 'CASHIER'] },
          { id: '2', resource: 'PRODUCT', action: 'CREATE', key: 'PRODUCT:CREATE', roles: ['TENANT_ADMIN', 'MANAGER'] },
          { id: '3', resource: 'TENANT', action: 'UPDATE', key: 'TENANT:UPDATE', roles: ['TENANT_ADMIN'] },
        ],
      },
    });
    render(<RolesPermissions />);
    expect(await screen.findByText('PRODUCT')).toBeInTheDocument();
    expect(screen.getByText('TENANT')).toBeInTheDocument();
    expect(screen.getAllByText('VIEW').length).toBeGreaterThan(0);
  });
});
