import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ChartOfAccounts from './ChartOfAccounts';
import JournalEntries from './JournalEntries';
import OpeningBalances from './OpeningBalances';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));

const ACCOUNTS = [
  { id: 'a1', code: '1010', name: 'Cash', type: 'ASSET', isActive: true, isSystem: true, systemKey: 'CASH' },
  { id: 'a2', code: '3010', name: 'Opening Balance Equity', type: 'EQUITY', isActive: true, isSystem: true, systemKey: 'OPENING_BALANCE_EQUITY' },
  { id: 'a3', code: '2010', name: 'Accounts Payable', type: 'LIABILITY', isActive: true, isSystem: true, systemKey: 'ACCOUNTS_PAYABLE' },
];

const TREE = [
  {
    id: 'r1', code: '1000', name: 'Assets', type: 'ASSET', isActive: true, isSystem: true, balance: 0, rolledUpBalance: 100,
    children: [{ id: 'a1', code: '1010', name: 'Cash', type: 'ASSET', isActive: true, isSystem: true, balance: 100, rolledUpBalance: 100, children: [] }],
  },
];

function allow(perms) {
  useAuth.mockReturnValue({ user: { tenantId: 't1' }, hasPermission: (k) => perms === 'all' || perms.includes(k) });
}

beforeEach(() => {
  for (const fn of Object.values(apiClient)) fn.mockReset();
});

describe('ChartOfAccounts', () => {
  it('renders the hierarchy indented with balances and system badges', async () => {
    allow('all');
    apiClient.get.mockResolvedValue({ data: { items: TREE } });
    render(<ChartOfAccounts />);
    expect(await screen.findByText('Assets')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getAllByText('System').length).toBe(2);
    expect(apiClient.get).toHaveBeenCalledWith('/accounting/accounts/tree', expect.objectContaining({ params: expect.objectContaining({ withBalances: 'true' }) }));
  });

  it('shows create/edit controls only with ACCOUNT permissions', async () => {
    allow(['ACCOUNT:VIEW']);
    apiClient.get.mockResolvedValue({ data: { items: TREE } });
    render(<ChartOfAccounts />);
    await screen.findByText('Assets');
    expect(screen.queryByText('+ New Account')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('creates an account and surfaces a backend error (duplicate code) in the form', async () => {
    allow('all');
    apiClient.get.mockResolvedValue({ data: { items: TREE } });
    apiClient.post.mockRejectedValueOnce({ response: { data: { error: 'Account code 1100 is already in use' } } });
    render(<ChartOfAccounts />);
    await screen.findByText('Assets');
    fireEvent.click(screen.getByText('+ New Account'));
    const dialog = await screen.findByRole('dialog');
    const inputs = within(dialog).getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '1100' } });
    fireEvent.change(inputs[1], { target: { value: 'Fixed Assets' } });
    fireEvent.click(within(dialog).getByText('Save'));
    expect(await within(dialog).findByText('Account code 1100 is already in use')).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith('/accounting/accounts', expect.objectContaining({ code: '1100', name: 'Fixed Assets', type: 'ASSET' }));
  });

  it('a system account detail offers no deactivate/delete', async () => {
    allow('all');
    apiClient.get.mockImplementation((path) => {
      if (path === '/accounting/accounts/tree') return Promise.resolve({ data: { items: TREE } });
      return Promise.resolve({ data: { item: { ...TREE[0].children[0], totalDebit: 100, totalCredit: 0, balance: 100, lineCount: 1, parent: null, children: [] } } });
    });
    render(<ChartOfAccounts />);
    fireEvent.click(await screen.findByText('Cash'));
    expect(await screen.findByText('Total debits')).toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});

describe('JournalEntries', () => {
  const ENTRY = {
    id: 'j1', entryNumber: 'JE-000001', date: new Date().toISOString(), memo: 'Owner injection', reference: null, sourceType: 'MANUAL', status: 'POSTED',
    lines: [{ id: 'l1', accountId: 'a1', debit: 100, credit: 0, account: ACCOUNTS[0] }, { id: 'l2', accountId: 'a2', debit: 0, credit: 100, account: ACCOUNTS[1] }],
  };

  function mockApi(entry = ENTRY) {
    apiClient.get.mockImplementation((path) => {
      if (path === '/accounting/journal') return Promise.resolve({ data: { items: [entry], total: 1 } });
      if (path === '/accounting/accounts') return Promise.resolve({ data: { items: ACCOUNTS } });
      return Promise.resolve({ data: { item: entry, sourceEntity: null } });
    });
  }

  it('lists entries with status and offers Reverse only for a posted manual entry (with permission)', async () => {
    allow('all');
    mockApi();
    render(<MemoryRouter><JournalEntries /></MemoryRouter>);
    fireEvent.click(await screen.findByText('JE-000001'));
    expect(await screen.findByText('Reverse')).toBeInTheDocument();
    expect(screen.queryByText('Post')).not.toBeInTheDocument();
  });

  it('hides Reverse without JOURNAL:REVERSE and for source-linked entries', async () => {
    allow(['JOURNAL:VIEW']);
    mockApi();
    const { unmount } = render(<MemoryRouter><JournalEntries /></MemoryRouter>);
    fireEvent.click(await screen.findByText('JE-000001'));
    await screen.findByText('Status');
    expect(screen.queryByText('Reverse')).not.toBeInTheDocument();
    unmount();

    allow('all');
    mockApi({ ...ENTRY, sourceType: 'SALE' });
    render(<MemoryRouter><JournalEntries /></MemoryRouter>);
    fireEvent.click(await screen.findByText('JE-000001'));
    await screen.findByText(/created by a business transaction/);
    expect(screen.queryByText('Reverse')).not.toBeInTheDocument();
  });

  it('a draft shows Post / Edit / Cancel Draft; posting calls the post endpoint', async () => {
    allow('all');
    mockApi({ ...ENTRY, status: 'DRAFT' });
    apiClient.post.mockResolvedValue({ data: {} });
    render(<MemoryRouter><JournalEntries /></MemoryRouter>);
    fireEvent.click(await screen.findByText('JE-000001'));
    fireEvent.click(await screen.findByText('Post'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/accounting/journal/j1/post'));
  });

  it('the create form blocks posting until debits equal credits, and can still save a draft', async () => {
    allow('all');
    mockApi();
    apiClient.post.mockResolvedValue({ data: {} });
    render(<MemoryRouter><JournalEntries /></MemoryRouter>);
    await screen.findByText('JE-000001');
    fireEvent.click(screen.getByText('+ New Journal Entry'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Account 1'), { target: { value: 'a1' } });
    fireEvent.change(within(dialog).getByLabelText('Debit 1'), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByLabelText('Account 2'), { target: { value: 'a2' } });
    fireEvent.change(within(dialog).getByLabelText('Credit 2'), { target: { value: '60' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent(/Out of balance by/);
    expect(within(dialog).getByText('Post Entry')).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Credit 2'), { target: { value: '100' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Balanced');
    expect(within(dialog).getByText('Post Entry')).not.toBeDisabled();
    fireEvent.click(within(dialog).getByText('Post Entry'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/accounting/journal', expect.objectContaining({ lines: [{ accountId: 'a1', debit: 100 }, { accountId: 'a2', credit: 100 }] })));
  });
});

describe('OpeningBalances', () => {
  it('previews the automatic equity offset and posts the entered lines', async () => {
    allow('all');
    apiClient.get.mockImplementation((path) => {
      if (path === '/accounting/opening-balances') return Promise.resolve({ data: { posted: false, active: null, history: [] } });
      return Promise.resolve({ data: { items: ACCOUNTS } });
    });
    apiClient.post.mockResolvedValue({ data: {} });
    render(<MemoryRouter><OpeningBalances /></MemoryRouter>);
    await screen.findByText('Opening Balances');
    // The equity account is calculated, so it is not selectable.
    expect(screen.queryByRole('option', { name: /Opening Balance Equity/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Account 1'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('Debit 1'), { target: { value: '1000' } });
    expect(screen.getByRole('status')).toHaveTextContent(/will be credited/);
    fireEvent.click(screen.getByText('Post Opening Balances'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/accounting/opening-balances', expect.objectContaining({ lines: [{ accountId: 'a1', debit: 1000 }] })));
  });

  it('once posted it shows the entry and no form', async () => {
    allow('all');
    apiClient.get.mockImplementation((path) => {
      if (path === '/accounting/opening-balances') {
        return Promise.resolve({ data: { posted: true, active: { id: 'j9', entryNumber: 'JE-000009', date: new Date().toISOString(), lines: [{ id: 'l', debit: 5, credit: 0, account: { code: '1010', name: 'Cash' } }] }, history: [] } });
      }
      return Promise.resolve({ data: { items: ACCOUNTS } });
    });
    render(<MemoryRouter><OpeningBalances /></MemoryRouter>);
    expect(await screen.findByText('JE-000009')).toBeInTheDocument();
    expect(screen.queryByText('Post Opening Balances')).not.toBeInTheDocument();
  });

  it('without OPENING_BALANCE:CREATE the form is not offered', async () => {
    allow(['OPENING_BALANCE:VIEW']);
    apiClient.get.mockImplementation((path) => {
      if (path === '/accounting/opening-balances') return Promise.resolve({ data: { posted: false, active: null, history: [] } });
      return Promise.resolve({ data: { items: ACCOUNTS } });
    });
    render(<MemoryRouter><OpeningBalances /></MemoryRouter>);
    expect(await screen.findByText(/Only a tenant administrator can post them/)).toBeInTheDocument();
    expect(screen.queryByText('Post Opening Balances')).not.toBeInTheDocument();
  });
});
