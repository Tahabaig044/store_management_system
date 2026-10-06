import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalSearch from './GlobalSearch';
import apiClient from '../api/client';

vi.mock('../api/client', () => ({ default: { get: vi.fn() } }));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

function renderSearch() {
  return render(<MemoryRouter><GlobalSearch /></MemoryRouter>);
}

beforeEach(() => {
  apiClient.get.mockReset();
  navigateMock.mockReset();
});

describe('GlobalSearch (Phase 1.16)', () => {
  it('debounces, calls /search once, and shows grouped results with entity headings', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        groups: [
          { entity: 'CUSTOMER', items: [{ entityType: 'CUSTOMER', entityId: 'c1', title: 'Ali Khan', subtitle: '0300', status: 'ACTIVE', route: '/customers', reference: null }] },
          { entity: 'RFQ', items: [{ entityType: 'RFQ', entityId: 'r1', title: 'RFQ-000001', route: null }] },
        ],
      },
    });
    renderSearch();
    const input = screen.getByLabelText('Universal search');
    fireEvent.change(input, { target: { value: 'Al' } });
    fireEvent.change(input, { target: { value: 'Ali' } });
    expect(await screen.findByText('Ali Khan')).toBeInTheDocument();
    expect(screen.getByText('Customers')).toBeInTheDocument();
    expect(screen.getByText('RFQs')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith('/search', { params: { q: 'Ali' } });
  });

  it('navigates to the result route with a search param; a null-route result is not clickable', async () => {
    apiClient.get.mockResolvedValue({
      data: { groups: [{ entity: 'CUSTOMER', items: [{ entityType: 'CUSTOMER', entityId: 'c1', title: 'Ali Khan', route: '/customers', reference: 'CUST-1' }] }, { entity: 'RFQ', items: [{ entityType: 'RFQ', entityId: 'r1', title: 'RFQ-000001', route: null }] }] },
    });
    renderSearch();
    fireEvent.change(screen.getByLabelText('Universal search'), { target: { value: 'Ali' } });
    fireEvent.click(await screen.findByText('Ali Khan'));
    expect(navigateMock).toHaveBeenCalledWith('/customers?search=CUST-1');
    expect(screen.queryByText('RFQ-000001')).not.toBeInTheDocument();
  });

  it('shows an empty state and an error state', async () => {
    apiClient.get.mockResolvedValueOnce({ data: { groups: [] } });
    renderSearch();
    const input = screen.getByLabelText('Universal search');
    fireEvent.change(input, { target: { value: 'nothing' } });
    expect(await screen.findByText(/No results for/)).toBeInTheDocument();

    apiClient.get.mockRejectedValueOnce({ response: { data: { error: 'Boom' } } });
    fireEvent.change(input, { target: { value: 'fail' } });
    await waitFor(() => expect(screen.getByText('Boom')).toBeInTheDocument());
  });

  it('clear button empties the input', async () => {
    apiClient.get.mockResolvedValue({ data: { groups: [] } });
    renderSearch();
    const input = screen.getByLabelText('Universal search');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(screen.getByLabelText('Clear search'));
    expect(input.value).toBe('');
  });
});
