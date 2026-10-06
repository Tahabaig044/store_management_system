import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Units from './Units';
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

describe('Units page (Phase 1.5)', () => {
  it('lists units and shows the conversion relationship when one exists', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        items: [
          { id: 'u1', name: 'Pieces', code: 'pcs', baseUnitId: null, baseUnit: null, conversionFactor: null, isActive: true, productCount: 5 },
          { id: 'u2', name: 'Box', code: 'box', baseUnitId: 'u1', baseUnit: { id: 'u1', name: 'Pieces' }, conversionFactor: 12, isActive: true, productCount: 1 },
        ],
        total: 2,
      },
    });
    render(<Units />);
    expect(await screen.findByText('Pieces')).toBeInTheDocument();
    expect(screen.getByText('1 Box = 12 Pieces')).toBeInTheDocument();
  });

  it('only shows the conversion factor field once a base unit is chosen, and submits both together', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [{ id: 'u1', name: 'Pieces', code: 'pcs', isActive: true }], total: 1 } });
    apiClient.post.mockResolvedValue({ data: { item: {} } });
    render(<Units />);
    await screen.findByText('Pieces');

    fireEvent.click(screen.getByText('+ New Unit'));
    expect(screen.queryByLabelText(/Conversion Factor/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Box' } });
    fireEvent.change(screen.getByLabelText('Base Unit (optional, for conversion)'), { target: { value: 'u1' } });
    expect(await screen.findByLabelText(/Conversion Factor/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Conversion Factor/), { target: { value: '12' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/units', { name: 'Box', code: undefined, baseUnitId: 'u1', conversionFactor: 12 })
    );
  });
});
