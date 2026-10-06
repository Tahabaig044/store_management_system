import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AutomationRules from './AutomationRules';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const RULE = { id: 'r1', event: 'APPOINTMENT_BOOKED', name: 'Appointment confirmation', actionType: 'WHATSAPP_MESSAGE', template: { name: 'Default Appointment Confirmation' }, delayMinutes: 0, isEnabled: true };

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.patch.mockReset();
  useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' } });
});

describe('AutomationRules page', () => {
  it('lists automation rules', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [RULE] } });
    render(<AutomationRules />);
    expect(await screen.findByText('Appointment confirmation')).toBeInTheDocument();
    expect(screen.getByText('APPOINTMENT_BOOKED')).toBeInTheDocument();
  });

  it('toggling the switch calls the API to update isEnabled', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [RULE] } });
    apiClient.patch.mockResolvedValue({ data: { item: { ...RULE, isEnabled: false } } });
    render(<AutomationRules />);
    await screen.findByText('Appointment confirmation');

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/communication/automation-rules/r1', { isEnabled: false }));
  });

  it('disables editing controls for a non-MANAGEMENT role', async () => {
    useAuth.mockReturnValue({ user: { role: 'RECEPTIONIST' } });
    apiClient.get.mockResolvedValue({ data: { items: [RULE] } });
    render(<AutomationRules />);
    await screen.findByText('Appointment confirmation');
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});
