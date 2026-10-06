import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PartyBalances from './PartyBalances';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));

const SUMMARY = {
  items: [{ partyId: 'c1', partyName: 'Acme Optics', openDocuments: 2, documentsDue: 150, availableCredit: 30, netOutstanding: 120, glBalance: 120 }],
  totals: { documentsDue: 150, availableCredit: 30, netOutstanding: 120, glControlBalance: 120, reconciliationDifference: 0 },
};
const OUTSTANDING = {
  party: { id: 'c1', name: 'Acme Optics' },
  documents: [
    { id: 's1', number: 'INV-1', date: '2026-01-01', total: 100, amountPaid: 0, balance: 100, ageDays: 40 },
    { id: 's2', number: 'INV-2', date: '2026-02-01', total: 80, amountPaid: 30, balance: 50, ageDays: 10 },
  ],
  notes: [{ id: 'n1', number: 'CN-1', date: '2026-02-05', amount: 30, available: 30, reason: 'Goodwill' }],
  documentsDue: 150, availableCredit: 30, netOutstanding: 120, glBalance: 120,
};
const STATEMENT = {
  openingBalance: 0, totalIncrease: 180, totalDecrease: 60, closingBalance: 120, currentBalance: 120, glBalance: 120,
  rows: [
    { date: '2026-01-01', type: 'INVOICE', reference: 'INV-1', sourceType: 'SALE', sourceId: 's1', increase: 100, decrease: 0, balance: 100 },
    { date: '2026-02-02', type: 'PAYMENT', reference: 'RCT-1', sourceType: 'PAYMENT', sourceId: 'p1', increase: 0, decrease: 30, balance: 70 },
  ],
};
const AGING = {
  buckets: ['0-30', '31-60', '61-90', '90+'],
  items: [{ partyId: 'c1', partyName: 'Acme Optics', buckets: { '0-30': 50, '31-60': 100, '61-90': 0, '90+': 0 }, total: 150, availableCredit: 30, net: 120 }],
  totals: { '0-30': 50, '31-60': 100, '61-90': 0, '90+': 0 }, total: 150, availableCredit: 30, net: 120,
};

function allow(perms = 'all') {
  useAuth.mockReturnValue({ user: { tenantId: 't1' }, hasPermission: (k) => perms === 'all' || perms.includes(k) });
}
function mockApi() {
  apiClient.get.mockImplementation((path) => {
    if (path.endsWith('/summary')) return Promise.resolve({ data: SUMMARY });
    if (path.endsWith('/aging')) return Promise.resolve({ data: AGING });
    if (path.endsWith('/outstanding')) return Promise.resolve({ data: OUTSTANDING });
    if (path.endsWith('/statement')) return Promise.resolve({ data: STATEMENT });
    if (path.startsWith('/payments/')) return Promise.resolve({ data: { item: { id: 'p1', receiptNumber: 'RCT-1', status: 'COMPLETED', amount: 30, method: 'cash', paidAt: '2026-02-02', allocations: [{ id: 'a1', amount: 30, sale: { invoiceNumber: 'INV-1' } }] } } });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
});

describe('PartyBalances (Receivables / Payables)', () => {
  it('lists outstanding balances with totals and the ledger control balance', async () => {
    allow();
    mockApi();
    render(<PartyBalances side="AR" />);
    expect(await screen.findByText('Acme Optics')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Receivables' })).toBeInTheDocument();
    expect(screen.getAllByText('Rs. 120.00').length).toBeGreaterThan(0);
    expect(apiClient.get).toHaveBeenCalledWith('/receivables/summary', expect.anything());
  });

  it('shows a reconciliation notice only when the documents and the ledger disagree', async () => {
    allow();
    mockApi();
    apiClient.get.mockImplementation((path) =>
      Promise.resolve({ data: path.endsWith('/summary') ? { ...SUMMARY, totals: { ...SUMMARY.totals, reconciliationDifference: 25 } } : {} }));
    render(<PartyBalances side="AR" />);
    expect(await screen.findByText(/differs from the documents above by Rs. 25.00/)).toBeInTheDocument();
  });

  it('the payables side uses the supplier endpoints and wording', async () => {
    allow();
    mockApi();
    render(<PartyBalances side="AP" />);
    expect(await screen.findByRole('heading', { name: 'Payables' })).toBeInTheDocument();
    expect(await screen.findByText('Supplier')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/payables/summary', expect.anything());
  });

  it('the aging tab shows the configured buckets and passes them to the API', async () => {
    allow();
    mockApi();
    render(<PartyBalances side="AR" />);
    await screen.findByText('Acme Optics');
    fireEvent.click(screen.getByRole('button', { name: 'Aging' }));
    expect(await screen.findByText('31-60')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Buckets (days)'), { target: { value: '7,14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/receivables/aging', { params: { buckets: '7,14' } }));
  });

  it('allocating across several invoices records one payment with explicit allocations and an idempotency key', async () => {
    allow();
    mockApi();
    apiClient.post.mockResolvedValue({ data: { item: {} } });
    render(<PartyBalances side="AR" />);
    fireEvent.click(await screen.findByText('Acme Optics'));
    fireEvent.click(await screen.findByLabelText('Select INV-1'));
    fireEvent.click(screen.getByLabelText('Select INV-2'));
    fireEvent.change(screen.getByLabelText('Amount for INV-1'), { target: { value: '60' } });
    expect(screen.getByTestId('alloc-total')).toHaveTextContent('Rs. 110.00');

    fireEvent.click(screen.getByRole('button', { name: 'Record customer payment' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiClient.post.mock.calls[0];
    expect(url).toBe('/payments');
    expect(body).toMatchObject({ direction: 'IN', customerId: 'c1', amount: 110, method: 'cash' });
    expect(body.allocations).toEqual([{ saleId: 's1', amount: 60 }, { saleId: 's2', amount: 50 }]);
    expect(body.idempotencyKey).toBeTruthy();
  });

  it('blocks an allocation larger than the invoice balance and one larger than the credit note', async () => {
    allow();
    mockApi();
    render(<PartyBalances side="AR" />);
    fireEvent.click(await screen.findByText('Acme Optics'));
    fireEvent.click(await screen.findByLabelText('Select INV-1'));
    fireEvent.change(screen.getByLabelText('Amount for INV-1'), { target: { value: '100.01' } });
    expect(screen.getByRole('button', { name: 'Record customer payment' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Amount for INV-1'), { target: { value: '40' } });
    expect(screen.getByRole('button', { name: 'Record customer payment' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Credit note'), { target: { value: 'n1' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/exceeds the credit available/);
    expect(screen.getByRole('button', { name: 'Apply credit note' })).toBeDisabled();
  });

  it('applies a credit note to the selected invoices', async () => {
    allow();
    mockApi();
    apiClient.post.mockResolvedValue({ data: { item: {} } });
    render(<PartyBalances side="AR" />);
    fireEvent.click(await screen.findByText('Acme Optics'));
    fireEvent.click(await screen.findByLabelText('Select INV-2'));
    fireEvent.change(screen.getByLabelText('Amount for INV-2'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Credit note'), { target: { value: 'n1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply credit note' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/receivables/note-applications', expect.objectContaining({ noteId: 'n1', allocations: [{ documentId: 's2', amount: 30 }] })));
  });

  it('users without PAYMENT:CREATE see the balances but no allocation controls', async () => {
    allow(['REPORT:VIEW']);
    mockApi();
    render(<PartyBalances side="AR" />);
    fireEvent.click(await screen.findByText('Acme Optics'));
    expect(await screen.findByText('INV-1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Select INV-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record customer payment' })).not.toBeInTheDocument();
  });

  it('the statement shows running balances and opens a payment for reversal only with PAYMENT:REVERSE', async () => {
    allow();
    mockApi();
    apiClient.post.mockResolvedValue({ data: { item: {} } });
    render(<PartyBalances side="AR" />);
    fireEvent.click(await screen.findByText('Acme Optics'));
    fireEvent.click(await screen.findByRole('button', { name: 'Statement' }));
    expect(await screen.findByText('Closing balance')).toBeInTheDocument();
    fireEvent.click(screen.getByText('RCT-1'));
    const dialog = (await screen.findByText('Payment RCT-1')).closest('[role="dialog"]');
    expect(await within(dialog).findByText('INV-1')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverse payment' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/payments/p1/reverse'));
  });

  it('hides Reverse payment without PAYMENT:REVERSE', async () => {
    allow(['REPORT:VIEW', 'PAYMENT:CREATE']);
    mockApi();
    render(<PartyBalances side="AR" />);
    fireEvent.click(await screen.findByText('Acme Optics'));
    fireEvent.click(await screen.findByRole('button', { name: 'Statement' }));
    fireEvent.click(await screen.findByText('RCT-1'));
    const dialog = (await screen.findByText('Payment RCT-1')).closest('[role="dialog"]');
    await within(dialog).findByText('INV-1');
    expect(within(dialog).queryByRole('button', { name: 'Reverse payment' })).not.toBeInTheDocument();
  });

  it('surfaces a backend rejection in the panel', async () => {
    allow();
    mockApi();
    apiClient.post.mockRejectedValueOnce({ response: { data: { error: 'Payment would exceed the sale total' } } });
    render(<PartyBalances side="AR" />);
    fireEvent.click(await screen.findByText('Acme Optics'));
    fireEvent.click(await screen.findByLabelText('Select INV-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Record customer payment' }));
    expect(await screen.findByText('Payment would exceed the sale total')).toBeInTheDocument();
  });
});
