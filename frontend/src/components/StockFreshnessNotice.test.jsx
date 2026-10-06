import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import StockFreshnessNotice from './StockFreshnessNotice';
import SyncStatusWidget from './SyncStatusWidget';
import { getOfflineDb } from '../offline/db';

vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const setOnline = (value) => Object.defineProperty(navigator, 'onLine', { value, configurable: true });
const putChecked = (tenantId, name, ageMs) =>
  getOfflineDb(tenantId).meta.put({ key: `dataset:${name}`, value: { lastCheckedAt: Date.now() - ageMs, lastChangedAt: Date.now() - ageMs, count: 1, stale: false } });

afterEach(() => setOnline(true));

describe('stock freshness UI (Phase 3.1)', () => {
  it('says nothing before the first download and while the stock copy is current', async () => {
    const tenantId = crypto.randomUUID();
    const { container } = render(<StockFreshnessNotice tenantId={tenantId} />);
    expect(container).toBeEmptyDOMElement();

    await act(async () => { await putChecked(tenantId, 'products', 5000); });
    expect(await screen.queryByTestId('stock-stale-notice')).not.toBeInTheDocument();
  });

  it('warns when the local stock copy is old, and explains the consequence differently offline', async () => {
    const tenantId = crypto.randomUUID();
    await putChecked(tenantId, 'products', 10 * 60 * 1000);
    render(<StockFreshnessNotice tenantId={tenantId} />);
    expect(await screen.findByTestId('stock-stale-notice')).toHaveTextContent(/being refreshed/);

    const offlineTenant = crypto.randomUUID();
    await putChecked(offlineTenant, 'products', 10 * 60 * 1000);
    setOnline(false);
    render(<StockFreshnessNotice tenantId={offlineTenant} />);
    expect(await screen.findByText(/You are offline.*checked against the server when you reconnect/)).toBeInTheDocument();
  });

  it('the sync status widget shows how old the stock copy is and flags it when it may be out of date', async () => {
    const fresh = crypto.randomUUID();
    await putChecked(fresh, 'products', 3000);
    const { unmount } = render(<SyncStatusWidget tenantId={fresh} online />);
    expect(await screen.findByTestId('stock-freshness')).toHaveTextContent(/^Stock - /);
    unmount();

    const old = crypto.randomUUID();
    await putChecked(old, 'products', 30 * 60 * 1000);
    render(<SyncStatusWidget tenantId={old} online={false} />);
    expect(await screen.findByTestId('stock-freshness')).toHaveTextContent(/Stock may be out of date/);
  });
});
