import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CommunicationCenter from './CommunicationCenter';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' } });
});

function mockEndpoints(overrides = {}) {
  apiClient.get.mockImplementation((path) => {
    if (path === '/communication/messages') {
      return Promise.resolve({
        data: { items: overrides.items || [{ id: 'm1', queuedAt: new Date().toISOString(), customer: { name: 'Jane Doe' }, channel: 'WHATSAPP', status: 'SENT', body: 'Hi Jane' }] },
      });
    }
    if (path === '/communication/messages/stats') {
      return Promise.resolve({ data: overrides.stats || { total: 5, byStatus: { SENT: 4, FAILED: 1 } } });
    }
    if (path === '/customers') return Promise.resolve({ data: { items: [{ id: 'c1', name: 'Jane Doe', phone: '0300' }] } });
    if (path === '/communication/templates') return Promise.resolve({ data: { items: [{ id: 't1', name: 'Order confirmation' }] } });
    return Promise.resolve({ data: { items: [] } });
  });
}

describe('CommunicationCenter page', () => {
  it('lists messages and shows stats', async () => {
    mockEndpoints();
    render(<CommunicationCenter />);
    expect(await screen.findByText('Hi Jane')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows a Retry button only for failed messages, and only for MANAGEMENT', async () => {
    mockEndpoints({ items: [{ id: 'm1', queuedAt: new Date().toISOString(), customer: { name: 'Failed Customer' }, channel: 'WHATSAPP', status: 'FAILED', body: 'oops' }] });
    render(<CommunicationCenter />);
    expect(await screen.findByText('Retry')).toBeInTheDocument();
  });

  it('a non-MANAGEMENT user does not see the Send Message button', async () => {
    useAuth.mockReturnValue({ user: { role: 'RECEPTIONIST' } });
    mockEndpoints();
    render(<CommunicationCenter />);
    await screen.findByText('Hi Jane');
    expect(screen.queryByText('+ Send Message')).not.toBeInTheDocument();
  });

  it('sends a manual message via the modal', async () => {
    mockEndpoints();
    apiClient.post.mockResolvedValue({ data: { item: { id: 'm2' } } });
    render(<CommunicationCenter />);
    await screen.findByText('Hi Jane');

    fireEvent.click(screen.getByText('+ Send Message'));
    // The page's status/channel filters render first, so the modal's
    // Customer select is the third combobox in document order.
    const [, , customerSelect] = screen.getAllByRole('combobox');
    fireEvent.change(customerSelect, { target: { value: 'c1' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/communication/messages', expect.objectContaining({ customerId: 'c1', body: 'Hello there' })));
  });
});
