import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Brands from './Brands';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  useAuth.mockReturnValue({ hasPermission: () => true });
});

describe('Brands page (Phase 1.5)', () => {
  it('lists brands with their product count', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [{ id: 'b1', name: 'Ray-Ban', isActive: true, productCount: 3 }], total: 1 } });
    render(<Brands />);
    expect(await screen.findByText('Ray-Ban')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('creates a new brand', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [], total: 0 } });
    apiClient.post.mockResolvedValue({ data: { item: { id: 'b2', name: 'New Brand' } } });
    render(<Brands />);
    await screen.findByText('No brands yet.');

    fireEvent.click(screen.getByText('+ New Brand'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Brand' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/brands', { name: 'New Brand' }));
  });
});
