// Phase 3.4: the unlock prompt and the storage-broken notice.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import OfflineUnlockBanner from './OfflineUnlockBanner';
import { unlock, lock, secureState, readSealed, sealRows } from '../offline/secureStore';
import { getOfflineDb } from '../offline/db';
import { STORAGE_BROKEN_EVENT } from '../offline/reliability';

vi.mock('../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('offline')), post: vi.fn() } }));

beforeEach(() => lock());
afterEach(() => { lock(); vi.restoreAllMocks(); });

describe('OfflineUnlockBanner', () => {
  it('shows nothing while unlocked; after a restart it asks for the password, refuses a wrong one and unlocks with the right one - offline', async () => {
    const t = `ub-${crypto.randomUUID()}`;
    await unlock(t, 'secret-pw');
    await getOfflineDb(t).customers.bulkPut(await sealRows(t, 'customers', [{ id: 'c1', name: 'Ann' }]));
    const { container } = render(<OfflineUnlockBanner tenantId={t} />);
    expect(container).toBeEmptyDOMElement();

    act(() => lock(t)); // the page was reloaded: the key is gone
    const box = await screen.findByLabelText('Password to unlock offline data');
    fireEvent.change(box, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not open/);
    expect(secureState(t)).toBe('locked');

    fireEvent.change(screen.getByLabelText('Password to unlock offline data'), { target: { value: 'secret-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(secureState(t)).toBe('unlocked'));
    expect(await readSealed(t, 'customers')).toEqual([{ id: 'c1', name: 'Ann' }]);
    await waitFor(() => expect(screen.queryByTestId('secure-locked')).not.toBeInTheDocument());
  });

  it('says plainly that nothing personal is kept when the browser cannot protect it', async () => {
    vi.spyOn(crypto, 'subtle', 'get').mockReturnValue(undefined);
    render(<OfflineUnlockBanner tenantId={`ub-${crypto.randomUUID()}`} />);
    expect(await screen.findByTestId('secure-unavailable')).toHaveTextContent(/secure connection is required/);
  });

  it('reports an unopenable device database with what to do, and warns about clearing site data', async () => {
    render(<OfflineUnlockBanner tenantId="t" />);
    act(() => { window.dispatchEvent(new CustomEvent(STORAGE_BROKEN_EVENT, { detail: { name: 'UnknownError', message: 'backing store' } })); });
    expect(await screen.findByTestId('storage-broken')).toHaveTextContent(/backing store.*not yet sent from this device would be lost/s);
  });
});
