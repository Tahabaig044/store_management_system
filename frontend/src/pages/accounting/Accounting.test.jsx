import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Accounting from './Accounting';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn() },
}));

beforeEach(() => {
  apiClient.get.mockReset();
});

describe('Accounting page', () => {
  it('renders the Chart of Accounts by default', async () => {
    apiClient.get.mockResolvedValue({ data: { items: [{ id: 'a1', code: '1010', name: 'Cash', type: 'ASSET', isSystem: true }] } });
    render(<Accounting />);
    expect(await screen.findByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('1010')).toBeInTheDocument();
  });

  it('switches to the Trial Balance tab and shows whether it balances', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/accounting/reports/trial-balance') {
        return Promise.resolve({
          data: { rows: [{ accountId: 'a1', code: '1010', name: 'Cash', debit: 100, credit: 0 }], totalDebit: 100, totalCredit: 100, balanced: true },
        });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    render(<Accounting />);
    fireEvent.click(screen.getByText('Trial Balance'));
    expect(await screen.findByText('Total (balanced)')).toBeInTheDocument();
  });

  it('a stale response from a tab switched away from does not overwrite the current tab with a mismatched shape', async () => {
    // Reproduces a real production crash: Balance Sheet's request resolves AFTER
    // Journal's (ordinary out-of-order network timing), and its {assets,...}
    // shape must not land while `tab` has already moved to 'journal', since
    // JournalTable would then read a .lines that isn't there on an {items}-less object.
    let resolveBalanceSheet;
    apiClient.get.mockImplementation((path) => {
      if (path === '/accounting/reports/balance-sheet') {
        return new Promise((resolve) => { resolveBalanceSheet = resolve; });
      }
      if (path === '/accounting/journal') {
        return Promise.resolve({ data: { items: [{ id: 'j1', entryNumber: 'JE-0001', date: '2026-01-01', sourceType: 'SALE', memo: 'Sale', lines: [{ id: 'l1', account: { name: 'Cash' }, debit: 100, credit: 0 }], status: 'POSTED' }] } });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    render(<Accounting />);

    fireEvent.click(screen.getByText('Balance Sheet')); // request starts, left pending
    fireEvent.click(screen.getByText('Journal')); // switches away before it resolves
    expect(await screen.findByText('JE-0001')).toBeInTheDocument();

    resolveBalanceSheet({ data: { assets: [], liabilities: [], equity: [], totalAssets: 0, totalLiabilities: 0, totalEquity: 0, balanced: true } });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText('JE-0001')).toBeInTheDocument(); // still showing Journal, not crashed
  });
});

describe('switching tabs after the Chart of Accounts has loaded (the real user sequence)', () => {
  // Each tab reads its own payload shape unconditionally. Clicking a tab used to render it once with
  // the PREVIOUS tab's data (still in state until the effect ran), which threw (e.g. reading 'map').
  const RESPONSES = {
    '/accounting/accounts': { items: [{ id: 'a1', code: '1010', name: 'Cash', type: 'ASSET', isSystem: true }] },
    '/accounting/journal': { items: [{ id: 'j1', entryNumber: 'JE-0001', date: '2026-01-01', sourceType: 'SALE', memo: 'Sale', status: 'POSTED', lines: [{ id: 'l1', account: { name: 'Cash' }, debit: 100, credit: 0 }] }] },
    '/accounting/reports/trial-balance': { rows: [{ accountId: 'a1', code: '1010', name: 'Cash', debit: 100, credit: 0 }], totalDebit: 100, totalCredit: 100, balanced: true },
    '/accounting/reports/profit-loss': { revenueLines: [{ accountId: 'r1', name: 'Sales Revenue', amount: 500 }], expenseLines: [], totalRevenue: 500, totalExpense: 0, netProfit: 500 },
    '/accounting/reports/balance-sheet': { assets: [{ accountId: 'a1', name: 'Cash on hand', amount: 100 }], liabilities: [], equity: [], totalAssets: 100, totalLiabilities: 0, totalEquity: 0, balanced: true },
    '/accounting/reports/ar-aging': { rows: [{ id: 'i1', invoiceNumber: 'INV-1', customerName: 'Acme Customer', amountDue: 50, ageDays: 10, bucket: '0-30' }], totals: { '0-30': 50 }, total: 50 },
    '/accounting/reports/ap-aging': { rows: [{ id: 'p1', purchaseNumber: 'PO-1', supplierName: 'Acme Supplier', amountDue: 70, ageDays: 40, bucket: '31-60' }], totals: { '31-60': 70 }, total: 70 },
  };

  beforeEach(() => {
    apiClient.get.mockImplementation((path) => Promise.resolve({ data: RESPONSES[path] }));
  });

  it.each([
    ['Journal', 'JE-0001'],
    ['Trial Balance', 'Total (balanced)'],
    ['Profit & Loss', 'Sales Revenue'],
    ['Balance Sheet', 'Cash on hand'],
    ['Receivables Aging', 'Acme Customer'],
    ['Payables Aging', 'Acme Supplier'],
  ])('%s: no render exception, and it shows its own content once its response arrives', async (label, ownContent) => {
    render(<Accounting />);
    expect(await screen.findByText('Cash')).toBeInTheDocument(); // Chart of Accounts finished loading

    expect(() => fireEvent.click(screen.getByRole('button', { name: label }))).not.toThrow();

    expect(await screen.findByText(ownContent)).toBeInTheDocument();
  });

  it('survives moving between report tabs whose payload shapes differ', async () => {
    render(<Accounting />);
    await screen.findByText('Cash');
    for (const [label, ownContent] of [['Trial Balance', 'Total (balanced)'], ['Profit & Loss', 'Sales Revenue'], ['Balance Sheet', 'Cash on hand'], ['Journal', 'JE-0001'], ['Receivables Aging', 'Acme Customer']]) {
      expect(() => fireEvent.click(screen.getByRole('button', { name: label }))).not.toThrow();
      expect(await screen.findByText(ownContent)).toBeInTheDocument();
    }
  });
});
