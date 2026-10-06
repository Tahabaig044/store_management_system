import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotificationBell from './NotificationBell';
import apiClient from '../api/client';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}));

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.patch.mockReset();
  apiClient.post.mockReset();
});

// Phase 1.15: the bell now links to a full /notifications history page,
// so rendering it needs a Router in context - MemoryRouter changes nothing
// about the assertions below, only provides that context.
function renderBell() {
  return render(<MemoryRouter><NotificationBell /></MemoryRouter>);
}

describe('NotificationBell', () => {
  it('shows the unread count badge and lists notifications on click', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/notifications/unread-count') return Promise.resolve({ data: { count: 2 } });
      if (path === '/notifications') return Promise.resolve({ data: { items: [{ id: 'n1', title: 'Order ready', body: 'Order OO-1 is ready', isRead: false, createdAt: new Date().toISOString() }] } });
      return Promise.resolve({ data: {} });
    });
    renderBell();

    expect(await screen.findByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Order ready')).toBeInTheDocument();
  });

  it('marking a notification as read calls the API', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/notifications/unread-count') return Promise.resolve({ data: { count: 1 } });
      if (path === '/notifications') return Promise.resolve({ data: { items: [{ id: 'n1', title: 'Order ready', isRead: false, createdAt: new Date().toISOString() }] } });
      return Promise.resolve({ data: {} });
    });
    apiClient.patch.mockResolvedValue({});
    renderBell();
    await screen.findByText('1');
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(await screen.findByText('Order ready'));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/notifications/n1/read'));
  });
});
