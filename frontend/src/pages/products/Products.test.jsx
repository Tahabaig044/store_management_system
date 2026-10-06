// Phase 0.2 Universal Product Architecture - frontend coverage.
//
// Closes the pre-existing gap flagged in docs/phase0-1-test-coverage-matrix.md
// (Products.jsx previously had zero frontend tests) and verifies the new
// industry-pack-aware conditional rendering from
// docs/phase0-2-frontend-ui-architecture.md.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Products from './Products';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams()],
}));

function mockListEndpoints() {
  apiClient.get.mockImplementation((path) => {
    if (path === '/products') return Promise.resolve({ data: { items: [], total: 0 } });
    if (path === '/categories') return Promise.resolve({ data: { items: [] } });
    return Promise.resolve({ data: { items: [] } });
  });
}

beforeEach(() => {
  apiClient.get.mockReset();
  mockListEndpoints();
});

describe('Products page - Phase 0.2 industry-pack-aware rendering', () => {
  it('hides Medicine/Frame/Lens options when the tenant has no industry packs enabled', async () => {
    useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' }, tenant: { enabledIndustryPacks: [] }, hasPermission: () => true });
    render(<Products />);

    fireEvent.click(await screen.findByText('+ New Product'));

    // Universal fields are always present.
    expect(screen.getByLabelText('Kind')).toBeInTheDocument();
    expect(screen.getByLabelText('Brand')).toBeInTheDocument();
    // No "Industry Type" field at all when neither pack is enabled.
    expect(screen.queryByLabelText('Industry Type')).not.toBeInTheDocument();
    expect(screen.queryByText('Medicine')).not.toBeInTheDocument();
    expect(screen.queryByText('Frame')).not.toBeInTheDocument();
    expect(screen.queryByText('Lens')).not.toBeInTheDocument();
  });

  it('shows the Industry Type selector with Optical options when OPTICAL is enabled', async () => {
    useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' }, tenant: { enabledIndustryPacks: ['OPTICAL'] }, hasPermission: () => true });
    render(<Products />);

    fireEvent.click(await screen.findByText('+ New Product'));

    // "Frame"/"Lens" appear both in the always-visible list-filter dropdown
    // and the modal's Industry Type dropdown, so there are 2 matches each.
    expect(screen.getByLabelText('Industry Type')).toBeInTheDocument();
    expect(screen.getAllByText('Frame').length).toBe(2);
    expect(screen.getAllByText('Lens').length).toBe(2);
    expect(screen.queryByText('Medicine')).not.toBeInTheDocument();
  });

  it('defaults to both industry packs enabled when tenant data is absent (backward compatibility for pre-Phase-0.2 sessions)', async () => {
    useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' }, tenant: null, hasPermission: () => true });
    render(<Products />);

    fireEvent.click(await screen.findByText('+ New Product'));

    expect(screen.getByLabelText('Industry Type')).toBeInTheDocument();
    expect(screen.getAllByText('Frame').length).toBe(2);
    expect(screen.getAllByText('Medicine').length).toBe(2);
  });

  it('hides stock fields when Kind is set to Service', async () => {
    useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' }, tenant: { enabledIndustryPacks: ['OPTICAL', 'MEDICINE'] }, hasPermission: () => true });
    render(<Products />);

    fireEvent.click(await screen.findByText('+ New Product'));
    expect(screen.getByLabelText('Opening Stock')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'SERVICE' } });
    expect(screen.queryByLabelText('Opening Stock')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Low Stock Threshold')).not.toBeInTheDocument();
  });
});

describe('Products page - Phase 1.4 Product Variants', () => {
  it('opens the Variants panel, lists existing variants, and adds a new one', async () => {
    useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' }, tenant: { enabledIndustryPacks: [] }, hasPermission: () => true });
    apiClient.get.mockImplementation((path) => {
      if (path === '/products') {
        return Promise.resolve({ data: { items: [{ id: 'p1', name: 'Variant Product', productKind: 'PHYSICAL_GOOD', isActive: true, stockQuantity: 5, lowStockThreshold: 1, purchasePrice: 5, sellingPrice: 10 }], total: 1 } });
      }
      if (path === '/categories') return Promise.resolve({ data: { items: [] } });
      if (path === '/products/p1/variants') return Promise.resolve({ data: { items: [{ id: 'v1', name: 'Small', sku: 'V-S', priceOverride: 9, stockQuantity: 3, isActive: true }] } });
      return Promise.resolve({ data: { items: [] } });
    });
    apiClient.post.mockResolvedValue({ data: { item: {} } });

    render(<Products />);
    fireEvent.click(await screen.findByText('Variants'));

    expect(await screen.findByText('Variants - Variant Product')).toBeInTheDocument();
    expect(await screen.findByText('Small')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Large' } });
    fireEvent.click(screen.getByText('+ Add'));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/products/p1/variants', expect.objectContaining({ name: 'Large' })));
  });

  it('filters the product list by productKind', async () => {
    useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' }, tenant: { enabledIndustryPacks: [] }, hasPermission: () => true });
    mockListEndpoints();
    render(<Products />);
    await screen.findByText('No products found.');

    fireEvent.change(screen.getByDisplayValue('All Kinds'), { target: { value: 'SERVICE' } });
    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith('/products', expect.objectContaining({ params: expect.objectContaining({ productKind: 'SERVICE' }) }))
    );
  });
});
