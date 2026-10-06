import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import apiClient from '../api/client';
import { AuthProvider, useAuth } from './AuthContext';
import { offlineDbName, getOfflineDb, setOfflineScope } from '../offline/db';
import { OUTBOXES } from '../offline/syncEngine';

vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
});

let auth;
function Probe() {
  auth = useAuth();
  return null;
}
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);
const loginAs = (user) => {
  apiClient.post.mockResolvedValueOnce({ data: { token: `tok-${user.id}`, user, tenant: { id: user.tenantId }, permissions: [] } });
  return act(() => auth.login('x@y.z', 'pw'));
};

beforeEach(() => {
  store.clear();
  apiClient.post.mockReset();
  setOfflineScope(null);
});

describe('Offline scope follows the signed-in user (Phase 3.1)', () => {
  it('a session restored from storage (browser restart, possibly offline) opens that user\'s own database immediately', () => {
    const tenantId = crypto.randomUUID();
    store.set('akvf_user', JSON.stringify({ id: 'u-restored', tenantId }));
    store.set('akvf_token', 't');
    mount();
    expect(offlineDbName(tenantId)).toContain('__u_u-restored');
  });

  it('sign-in scopes the database to the user; a different user on the same device gets a different one', async () => {
    const tenantId = crypto.randomUUID();
    mount();
    await loginAs({ id: 'cashier-1', tenantId });
    const first = offlineDbName(tenantId);
    expect(first).toContain('__u_cashier-1');
    await act(async () => auth.logout());
    await loginAs({ id: 'cashier-2', tenantId });
    expect(offlineDbName(tenantId)).not.toBe(first);
    expect(offlineDbName(tenantId)).toContain('__u_cashier-2');
  });

  it('sign-out removes the user\'s read copy of shop data from the device but keeps their unsynced work', async () => {
    const tenantId = crypto.randomUUID();
    mount();
    await loginAs({ id: 'u1', tenantId });
    const db = getOfflineDb(tenantId);
    await db.products.put({ id: 'p1', name: 'Widget', stockQuantity: 5 });
    await db.customers.put({ id: 'c1', name: 'Ann' });
    const queued = await OUTBOXES.expenses.queue(tenantId, { categoryId: 'c', amount: 9 });

    await act(async () => auth.logout());
    await waitFor(async () => {
      // Re-open as the same user (what signing back in does) and inspect what remained.
      setOfflineScope({ tenantId, userId: 'u1' });
      const again = getOfflineDb(tenantId);
      expect(await again.products.count()).toBe(0);
      expect(await again.customers.count()).toBe(0);
      expect((await again.pendingExpenses.get(queued.clientId)).status).toBe('pending');
    });
  });
});

// Phase 3.4: the protected offline data follows the session.
describe('Protected offline storage follows the session (Phase 3.4)', () => {
  it('signing in with the password opens the key; a restored session (browser restart) starts locked; signing out forgets the key and removes the sealed copy', async () => {
    const { secureState, readSealed, sealRows, lock } = await import('../offline/secureStore');
    const tenantId = crypto.randomUUID();
    mount();
    await loginAs({ id: 'u-sec', tenantId });
    await waitFor(() => expect(secureState(tenantId)).toBe('unlocked'));

    const db = getOfflineDb(tenantId);
    await db.customers.bulkPut(await sealRows(tenantId, 'customers', [{ id: 'c1', name: 'Private Person', phone: '0300' }]));
    expect(await readSealed(tenantId, 'customers')).toHaveLength(1);
    const queued = await OUTBOXES.expenses.queue(tenantId, { categoryId: 'c', amount: 9 });
    // Nothing personal is kept in localStorage: only the session itself.
    expect(JSON.stringify([...store.entries()])).not.toContain('Private Person');

    // A browser restart: the page is gone, so is the in-memory key; the session is restored from storage.
    lock();
    expect(secureState(tenantId)).toBe('locked');
    expect(await readSealed(tenantId, 'customers')).toEqual([]);

    await act(async () => auth.logout());
    await waitFor(async () => {
      setOfflineScope({ tenantId, userId: 'u-sec' });
      expect(await getOfflineDb(tenantId).customers.count()).toBe(0);
      expect((await getOfflineDb(tenantId).pendingExpenses.get(queued.clientId)).status).toBe('pending'); // unsent work is never purged
    });
    expect(store.has('akvf_token')).toBe(false);
    expect(secureState(tenantId)).toBe('locked');
  });

  it('another user on the same device never inherits the key or the sealed data', async () => {
    const { secureState } = await import('../offline/secureStore');
    const tenantId = crypto.randomUUID();
    mount();
    await loginAs({ id: 'alice', tenantId });
    await waitFor(() => expect(secureState(tenantId)).toBe('unlocked'));
    await act(async () => auth.logout());
    await loginAs({ id: 'bob', tenantId });
    await waitFor(() => expect(secureState(tenantId)).toBe('unlocked')); // bob's own key, from bob's own sign-in
    setOfflineScope({ tenantId, userId: 'alice' });
    expect(secureState(tenantId)).toBe('locked'); // alice's database is not open to bob's session
  });
});
