import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DeliveryUnavailableBanner from './DeliveryUnavailableBanner';
import apiClient from '../api/client';

vi.mock('../api/client', () => ({ default: { get: vi.fn() } }));

describe('DeliveryUnavailableBanner', () => {
  it('warns that messages are not delivered when no provider is connected', async () => {
    apiClient.get.mockResolvedValue({ data: { whatsappAvailable: false } });
    render(<DeliveryUnavailableBanner />);
    expect(await screen.findByTestId('delivery-unavailable')).toHaveTextContent(/not delivered/i);
  });

  it('shows nothing when delivery is available', async () => {
    apiClient.get.mockResolvedValue({ data: { whatsappAvailable: true } });
    render(<DeliveryUnavailableBanner />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(screen.queryByTestId('delivery-unavailable')).not.toBeInTheDocument();
  });
});
