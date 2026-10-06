import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FinancialReports from './FinancialReports';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import * as csv from '../../utils/csv';

vi.mock('../../api/client', () => ({ default: { get: vi.fn() } }));
vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));

const TB = { asOf: '2026-09-24', from: null, rows: [{ accountId: 'a1', code: '1010', name: 'Cash', type: 'ASSET', debit: 120, credit: 0 }, { accountId: 'a2', code: '4010', name: 'Sales Revenue', type: 'REVENUE', debit: 0, credit: 120 }], totalDebit: 120, totalCredit: 120, balanced: true };
const PL = { revenueLines: [{ accountId: 'r', code: '4010', name: 'Sales Revenue', amount: 300 }], expenseLines: [{ accountId: 'e', code: '5010', name: 'Cost of Goods Sold', amount: 150 }], totalRevenue: 300, totalExpense: 150, grossProfit: 150, netProfit: 150 };
const BS = { assets: [{ code: '1010', name: 'Cash', amount: 120 }], liabilities: [], equity: [{ code: null, name: 'Retained Earnings (current, unclosed)', amount: 120 }], totalAssets: 120, totalLiabilities: 0, totalEquity: 120, balanced: true };
const CB = { accounts: [{ accountId: 'c', key: 'CASH', name: 'Cash', openingBalance: 0, receipts: 150, payments: 30, closingBalance: 120 }], totals: { openingBalance: 0, receipts: 150, payments: 30, closingBalance: 120 }, bySource: { SALE: 150, EXPENSE: -30 } };
const REC = {
  scoped: false, allChecksPassed: false,
  checks: [{ key: 'TRIAL_BALANCE_BALANCED', ok: true, detail: 'ok' }, { key: 'RECEIVABLES_RECONCILED', ok: false, detail: 'Unexplained 75' }],
  receivables: { ledgerBalance: 150, subledgerBalance: 75, explainedDifference: 0, unexplainedDifference: 75, reconciled: false, truncated: false, partiesWithDifferences: [{ partyId: 'c1', partyName: 'Acme', documentsNet: 0, ledgerBalance: 75, difference: 75, reason: 'UNEXPLAINED' }] },
  payables: { ledgerBalance: 0, subledgerBalance: 0, explainedDifference: 0, unexplainedDifference: 0, reconciled: true, truncated: false, partiesWithDifferences: [] },
  cash: { available: false, reason: 'Payment records are not attributed to a branch on every row, so this check runs tenant-wide only' },
  inventory: { available: true, ledgerBalance: 185, stockValuation: 197, difference: -12, reconciled: false },
};

function allow(perms = 'all') {
  useAuth.mockReturnValue({ user: { tenantId: 't1' }, hasPermission: (k) => perms === 'all' || perms.includes(k) });
}
function mockApi() {
  apiClient.get.mockImplementation((path) => {
    if (path === '/branches') return Promise.resolve({ data: { items: [{ id: 'b1', name: 'Main' }, { id: 'b2', name: 'Second' }] } });
    if (path === '/companies') return Promise.resolve({ data: { items: [{ id: 'co1', name: 'Company One' }] } });
    const map = { 'trial-balance': TB, 'profit-loss': PL, 'balance-sheet': BS, 'cash-bank': CB, reconciliation: REC };
    const key = path.split('/').pop();
    return Promise.resolve({ data: map[key] });
  });
}

beforeEach(() => {
  apiClient.get.mockReset();
  vi.restoreAllMocks();
});

describe('FinancialReports', () => {
  it('runs the trial balance on load with the date range and shows the balanced status', async () => {
    allow();
    mockApi();
    render(<FinancialReports />);
    expect(await screen.findByText('Sales Revenue')).toBeInTheDocument();
    expect(screen.getByText('Debits equal credits.')).toBeInTheDocument();
    const call = apiClient.get.mock.calls.find(([p]) => p === '/accounting/reports/trial-balance');
    expect(call[1].params).toMatchObject({ from: expect.stringMatching(/^\d{4}-\d{2}-01$/), asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('passes the branch and company filters to the report', async () => {
    allow();
    mockApi();
    render(<FinancialReports />);
    await screen.findByText('Sales Revenue');
    fireEvent.change(await screen.findByLabelText('Branch'), { target: { value: 'b2' } });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await waitFor(() => {
      const last = apiClient.get.mock.calls.filter(([p]) => p === '/accounting/reports/trial-balance').pop();
      expect(last[1].params).toMatchObject({ branchId: 'b2', companyId: 'co1' });
    });
  });

  it('renders Profit & Loss, Balance Sheet and Cash & Bank from their endpoints', async () => {
    allow();
    mockApi();
    render(<FinancialReports />);
    await screen.findByText('Sales Revenue');
    fireEvent.click(screen.getByRole('button', { name: 'Profit & Loss' }));
    expect(await screen.findByText('Net profit')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Balance Sheet' }));
    expect(await screen.findByText('Assets equal liabilities plus equity.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cash & Bank' }));
    expect(await screen.findByText('Net movement by transaction type')).toBeInTheDocument();
    expect(screen.getByText('SALE')).toBeInTheDocument();
  });

  it('the reconciliation tab flags unexplained differences and explains why cash is unavailable when scoped', async () => {
    allow();
    mockApi();
    render(<FinancialReports />);
    await screen.findByText('Sales Revenue');
    fireEvent.click(screen.getByRole('button', { name: 'Reconciliation' }));
    expect(await screen.findByText('One or more integrity checks need review.')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('Reconciled')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getAllByText('Unexplained').length).toBeGreaterThan(0);
    expect(screen.getByText(/runs tenant-wide only/)).toBeInTheDocument();
    // Phase 2.4: the inventory check is informational and explains itself.
    expect(screen.getByText('Inventory ledger vs stock on hand')).toBeInTheDocument();
    expect(screen.getByText(/difference Rs. -12.00|difference -Rs. 12.00/)).toBeInTheDocument();
    expect(screen.getByText(/For review \(informational\)/)).toBeInTheDocument();
  });

  it('exports the current report as CSV only with REPORT:EXPORT, and offers print either way', async () => {
    allow(['REPORT:VIEW']);
    mockApi();
    const { unmount } = render(<FinancialReports />);
    await screen.findByText('Sales Revenue');
    expect(screen.queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Print/ })).toBeEnabled();
    unmount();

    allow('all');
    const spy = vi.spyOn(csv, 'downloadCsv').mockImplementation(() => {});
    render(<FinancialReports />);
    await screen.findByText('Sales Revenue');
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(spy).toHaveBeenCalledTimes(1);
    const [filename, rows] = spy.mock.calls[0];
    expect(filename).toMatch(/^trial-balance-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(rows[0]).toEqual(['Code', 'Account', 'Type', 'Debit', 'Credit']);
    expect(rows[1]).toEqual(['1010', 'Cash', 'ASSET', 120, 0]);
  });

  it('shows a backend error (for example a branch the user cannot access)', async () => {
    allow();
    apiClient.get.mockImplementation((path) => {
      if (path === '/branches' || path === '/companies') return Promise.resolve({ data: { items: [] } });
      return Promise.reject({ response: { data: { error: 'You do not have access to this branch' } } });
    });
    render(<FinancialReports />);
    expect(await screen.findByText('You do not have access to this branch')).toBeInTheDocument();
  });
});
