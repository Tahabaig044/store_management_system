import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Categories from './Categories';
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

describe('Categories page (Phase 1.5 subcategory support)', () => {
  it('shows the parent category name in the list, and no hard-coded industry suggestions anywhere', async () => {
    apiClient.get.mockResolvedValue({
      data: { items: [{ id: 'c2', name: 'Sunglasses', parentId: 'c1', parent: { id: 'c1', name: 'Eyewear' }, isActive: true, productCount: 0 }], total: 1 },
    });
    render(<Categories />);
    expect(await screen.findByText('Sunglasses')).toBeInTheDocument();
    expect(screen.getByText('Eyewear')).toBeInTheDocument();
    // The old hard-coded Optical suggestion list must be gone from the universal page.
    expect(screen.queryByText('Prescription Lenses')).not.toBeInTheDocument();
  });

  it('lets a new category be created under a chosen parent', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [{ id: 'c1', name: 'Eyewear', isActive: true, productCount: 0 }], total: 1 } });
    apiClient.post.mockResolvedValue({ data: { item: {} } });
    render(<Categories />);
    await screen.findByText('Eyewear');

    fireEvent.click(screen.getByText('+ New Category'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Frames' } });
    fireEvent.change(screen.getByLabelText('Parent Category (optional)'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/categories', { name: 'Frames', parentId: 'c1' }));
  });
});
