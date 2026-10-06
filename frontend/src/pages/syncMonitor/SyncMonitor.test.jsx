// Phase 3.3.4: the manager's overview across terminals.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SyncMonitor from './SyncMonitor';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const terminals = {
  summary: { terminals: 2, withUnsyncedWork: 1, silentWithWork: 1, pending: 4, conflicts: 1, failed: 0, openIssues: 1 },
  items: [
    { id: 't1', terminalId: 'term-aaaaaaaaaaaa', label: 'Front desk', userName: 'Amal', pendingCount: 4, conflictCount: 1, failedCount: 0, oldestPendingAt: new Date(Date.now() - 3600000).toISOString(), silent: true, silentForMs: 3 * 3600000 },
    { id: 't2', terminalId: 'term-bbbbbbbbbbbb', label: null, userName: 'Sam', pendingCount: 0, conflictCount: 0, failedCount: 0, oldestPendingAt: null, silent: false, silentForMs: 60000 },
  ],
};
const issue = { id: 'i1', clientId: 'c1', entity: 'Sales Return', kind: 'RETURN_EXCEEDS', code: 'RETURN_EXCEEDS', message: 'Only 1 remains', status: 'OPEN', lastReportedAt: new Date().toISOString(), terminal: { terminalId: 'term-aaaaaaaaaaaa', label: 'Front desk', userName: 'Amal' } };

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  apiClient.get.mockImplementation((path) => Promise.resolve({ data: path === '/sync/terminals' ? terminals : { items: [issue] } }));
  apiClient.post.mockResolvedValue({ data: { item: { ...issue, status: 'ACKNOWLEDGED' } } });
});

describe('Terminals & Sync (manager view)', { timeout: 20000 }, () => {
  it('shows every terminal, flags the quiet one holding unsent work, and lists the refused transaction with its reason', async () => {
    render(<SyncMonitor />);
    expect(await screen.findByText('Quiet with unsent work', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByTestId('sync-summary')).toHaveTextContent('Waiting to send4');
    expect(screen.getByText('More was returned than can still be returned')).toBeInTheDocument();
    expect(screen.getByText('Only 1 remains')).toBeInTheDocument();
  });

  it('a manager can acknowledge a refused transaction', async () => {
    render(<SyncMonitor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }, { timeout: 5000 }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/sync/issues/i1/acknowledge', {}));
  });
});
