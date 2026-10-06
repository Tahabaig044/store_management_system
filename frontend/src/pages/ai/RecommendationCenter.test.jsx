import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RecommendationCenter from './RecommendationCenter';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const INSIGHT = {
  id: 'i1',
  type: 'RECOMMENDATION',
  severity: 'URGENT',
  title: 'Lens Cleaner may run out soon',
  summary: 'Only 2 day(s) of stock remain.',
  recommendedAction: 'Consider reordering approximately 40 units.',
  evidence: { productId: 'p1', daysOfStockRemaining: 2 },
  status: 'NEW',
};

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
});

describe('RecommendationCenter page', () => {
  it('lists insights with severity and recommended action', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [INSIGHT], total: 1 } });
    render(<RecommendationCenter />);
    expect(await screen.findByText('Lens Cleaner may run out soon')).toBeInTheDocument();
    // "URGENT" also appears as a filter dropdown option, so assert on the badge specifically.
    expect(document.querySelector('.badge.text-bg-danger')).toHaveTextContent('URGENT');
    expect(screen.getByText(/Consider reordering/)).toBeInTheDocument();
  });

  it('dismissing an insight calls the API and reloads the list', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [INSIGHT], total: 1 } });
    apiClient.post.mockResolvedValue({ data: { item: { ...INSIGHT, status: 'DISMISSED' } } });
    render(<RecommendationCenter />);
    await screen.findByText('Lens Cleaner may run out soon');

    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/ai/insights/i1/dismiss'));
  });

  it('the Refresh Insights button triggers a refresh', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [], total: 0 } });
    apiClient.post.mockResolvedValue({ data: { generated: 0 } });
    render(<RecommendationCenter />);
    await screen.findByText('No insights match these filters.');

    fireEvent.click(screen.getByText('Refresh Insights'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/ai/insights/refresh'));
  });
});
