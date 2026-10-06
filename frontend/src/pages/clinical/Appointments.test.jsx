import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Appointments from './Appointments';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

beforeEach(() => {
  apiClient.get.mockReset();
});

describe('Appointments page - Phase 5.2 Bill Visit link', () => {
  it('shows a Bill Visit link for a completed appointment, linking to POS with the appointment and customer', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/appointments') {
        return Promise.resolve({
          data: {
            items: [
              {
                id: 'appt1',
                tokenNumber: 1,
                scheduledAt: new Date().toISOString(),
                status: 'COMPLETED',
                patient: { customer: { id: 'c1', name: 'Jane Doe' } },
              },
            ],
          },
        });
      }
      if (path === '/patients') return Promise.resolve({ data: { items: [] } });
      if (path === '/doctors') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: { items: [] } });
    });

    render(
      <MemoryRouter>
        <Appointments />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('All Appointments'));

    const billLink = await screen.findByText('Bill Visit');
    expect(billLink).toBeInTheDocument();
    expect(billLink.getAttribute('href')).toBe('/pos?appointmentId=appt1&customerId=c1');
  });

  it('does not show a Bill Visit link for an appointment that has not been completed', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/appointments') {
        return Promise.resolve({
          data: {
            items: [
              {
                id: 'appt2',
                tokenNumber: 2,
                scheduledAt: new Date().toISOString(),
                status: 'SCHEDULED',
                patient: { customer: { id: 'c2', name: 'John Roe' } },
              },
            ],
          },
        });
      }
      if (path === '/patients') return Promise.resolve({ data: { items: [] } });
      if (path === '/doctors') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: { items: [] } });
    });

    render(
      <MemoryRouter>
        <Appointments />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('All Appointments'));

    await screen.findByText('John Roe');
    expect(screen.queryByText('Bill Visit')).not.toBeInTheDocument();
  });
});
