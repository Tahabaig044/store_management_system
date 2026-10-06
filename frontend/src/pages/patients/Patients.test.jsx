import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Patients from './Patients';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const PATIENT_360 = {
  patient: { id: 'p1', patientNumber: 'PT-000001', customerId: 'c1', customer: { name: 'Jane Doe', phone: '0300', }, gender: 'F' },
  appointments: [],
  examinations: [],
  prescriptions: [],
  opticalOrders: [],
  sales: [],
  payments: [],
  outstandingBalance: 25,
};

function mockEndpoints() {
  apiClient.get.mockImplementation((path) => {
    if (path === '/patients') return Promise.resolve({ data: { items: [{ id: 'p1', patientNumber: 'PT-000001', customer: { name: 'Jane Doe', phone: '0300' } }], total: 1 } });
    if (path === '/patients/p1/360') return Promise.resolve({ data: PATIENT_360 });
    return Promise.resolve({ data: { items: [] } });
  });
}

function renderPatients() {
  return render(
    <MemoryRouter>
      <Patients />
    </MemoryRouter>
  );
}

beforeEach(() => {
  apiClient.get.mockReset();
});

describe('Patients page', () => {
  it('lists patients and opens the 360 view showing the outstanding balance', async () => {
    mockEndpoints();
    renderPatients();

    const row = await screen.findByText('Jane Doe');
    fireEvent.click(row);

    expect(await screen.findByText('Balance: Rs. 25.00')).toBeInTheDocument();
  });

  it('shows an empty state when no patients exist', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [], total: 0 } });
    renderPatients();
    expect(await screen.findByText('No patients yet.')).toBeInTheDocument();
  });
});
