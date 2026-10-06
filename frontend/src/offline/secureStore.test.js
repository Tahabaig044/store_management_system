// Phase 3.4: protected local storage - what is actually on disk, what a restart does, what a wrong or changed
// password does, and that nothing personal is ever written in the clear.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient from '../api/client';
import { getOfflineDb, setOfflineScope, closeOfflineDb } from './db';
import { unlock, lock, secureState, hasKeyring, sealRows, readSealed, SEALED_TABLES } from './secureStore';
import { syncLocalData, purgeReadCaches } from './localData';

vi.mock('../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const tenant = () => `sec-${crypto.randomUUID()}`;
const ann = { id: 'c1', name: 'Ann Example', phone: '0300-1234567', email: 'ann@example.test', address: '12 Rose Lane', isActive: true };

async function putRows(t, table, rows) {
  await getOfflineDb(t)[table].bulkPut(await sealRows(t, table, rows));
}
const rawDump = async (t, table) => JSON.stringify(await getOfflineDb(t)[table].toArray());

beforeEach(() => { apiClient.get.mockReset(); apiClient.post.mockReset(); setOnline(true); lock(); setOfflineScope(null); closeOfflineDb(); });
afterEach(() => { vi.restoreAllMocks(); lock(); setOnline(true); });

describe('sealed rows on disk', () => {
  it('nothing personal is readable in the stored rows, yet the app reads them back intact', async () => {
    const t = tenant();
    expect(await unlock(t, 'correct horse')).toMatchObject({ ok: true });
    await putRows(t, 'customers', [ann]);
    const dump = await rawDump(t, 'customers');
    for (const secret of ['Ann Example', '0300-1234567', 'ann@example.test', 'Rose Lane']) expect(dump).not.toContain(secret);
    expect(dump).toContain('"id":"c1"'); // only the record id stays visible
    expect(await readSealed(t, 'customers')).toEqual([ann]);
    // The key itself is stored only wrapped, never in the clear.
    const ring = JSON.stringify((await getOfflineDb(t).meta.get('keyring')).value);
    expect(ring).not.toContain('correct horse');
    expect(await hasKeyring(t)).toBe(true);
  });

  it('a sealed row cannot be moved onto another record, and a tampered row is rejected (and the copy re-downloaded)', async () => {
    const t = tenant();
    await unlock(t, 'pw');
    await putRows(t, 'customers', [ann, { ...ann, id: 'c2', name: 'Bob' }]);
    const db = getOfflineDb(t);
    await db.meta.put({ key: 'dataset:customers', value: { serverTime: 'x', count: 2 } });
    const [r1, r2] = await db.customers.toArray();
    await db.customers.put({ ...r1, _ct: r2._ct, _iv: r2._iv }); // Ann's id carrying Bob's ciphertext
    expect((await readSealed(t, 'customers')).map((r) => r.id)).toEqual(['c2']);
    await vi.waitFor(async () => expect(await db.customers.count()).toBe(0)); // dropped: unreadable data is not kept
    expect(await db.meta.get('dataset:customers')).toBeUndefined(); // so the next sync downloads it afresh

    await putRows(t, 'customers', [ann]);
    const [row] = await db.customers.toArray();
    await db.customers.put({ ...row, _ct: `${row._ct.slice(0, -4)}AAAA` }); // one flipped block
    expect(await readSealed(t, 'customers')).toEqual([]);
  });

  it('a plain row in a sealed table is never trusted', async () => {
    const t = tenant();
    await unlock(t, 'pw');
    await getOfflineDb(t).customers.put({ id: 'evil', name: 'Injected' });
    expect(await readSealed(t, 'customers')).toEqual([]);
  });
});

describe('keys, restart, wrong and changed passwords', () => {
  it('after a restart the data is locked until the password is typed; a wrong one changes nothing', async () => {
    const t = tenant();
    await unlock(t, 'right');
    await putRows(t, 'customers', [ann]);
    expect(secureState(t)).toBe('unlocked');

    lock(); // the page was closed: the key lived only in memory
    expect(secureState(t)).toBe('locked');
    expect(await readSealed(t, 'customers')).toEqual([]);
    expect(await unlock(t, 'wrong')).toMatchObject({ ok: false, reason: 'wrong-password' });
    expect(secureState(t)).toBe('locked');
    expect(await getOfflineDb(t).customers.count()).toBe(1); // a wrong guess destroys nothing

    expect(await unlock(t, 'right')).toMatchObject({ ok: true, reset: false });
    expect(await readSealed(t, 'customers')).toEqual([ann]); // works with no network at all
  });

  it('signing in with a password the old key no longer matches replaces the key and drops the unreadable copy - never a transaction', async () => {
    const t = tenant();
    await unlock(t, 'old');
    await putRows(t, 'customers', [ann]);
    lock();
    const res = await unlock(t, 'new', { authoritative: true });
    expect(res).toMatchObject({ ok: true, reset: true });
    expect(await getOfflineDb(t).customers.count()).toBe(0);
    await putRows(t, 'customers', [ann]);
    expect(await readSealed(t, 'customers')).toEqual([ann]);
  });

  it('one user\'s key never opens another user\'s database', async () => {
    const shop = `shop-${crypto.randomUUID()}`;
    setOfflineScope({ tenantId: shop, userId: 'alice' });
    await unlock(shop, 'alice-pw');
    await putRows(shop, 'customers', [ann]);
    expect(secureState(shop)).toBe('unlocked');
    setOfflineScope({ tenantId: shop, userId: 'bob' });
    expect(secureState(shop)).toBe('locked'); // bob has no key, and alice's is not his
    expect(await readSealed(shop, 'customers')).toEqual([]);
    setOfflineScope({ tenantId: shop, userId: 'alice' });
    expect(await readSealed(shop, 'customers')).toEqual([ann]);
  });
});

describe('the download path fails closed', () => {
  const serverWith = () => {
    apiClient.get.mockImplementation(async (path) => {
      if (path === '/offline/manifest') {
        return { data: { serverTime: new Date().toISOString(), schemaVersion: 1, scope: { tenantId: 't', userId: 'u', role: 'TENANT_ADMIN', branchIds: null, warehouseIds: null }, datasets: { products: { count: 1, maxUpdatedAt: 'a' }, customers: { count: 1, maxUpdatedAt: 'a' } } } };
      }
      const name = path.replace('/offline/datasets/', '');
      const items = name === 'products' ? [{ id: 'p1', name: 'Widget', stockQuantity: 3, isActive: true }] : [ann];
      return { data: { dataset: name, items, nextCursor: null, serverTime: new Date().toISOString(), delta: false } };
    });
  };

  it('locked: customer records are not downloaded at all, while products and stock still are', async () => {
    const t = tenant();
    serverWith();
    const res = await syncLocalData(t);
    expect(res.locked).toContain('customers');
    expect(res.downloaded).toContain('products');
    expect(await getOfflineDb(t).customers.count()).toBe(0);
    expect(await getOfflineDb(t).products.count()).toBe(1);
    expect(apiClient.get.mock.calls.some(([p]) => p === '/offline/datasets/customers')).toBe(false); // not even requested
  });

  it('unlocked: they are downloaded and stored sealed', async () => {
    const t = tenant();
    await unlock(t, 'pw');
    serverWith();
    await syncLocalData(t);
    expect(await rawDump(t, 'customers')).not.toContain('Ann Example');
    expect(await readSealed(t, 'customers')).toEqual([ann]);
  });

  it('no WebCrypto (an insecure context): reported unavailable, nothing personal is stored', async () => {
    const t = tenant();
    vi.spyOn(crypto, 'subtle', 'get').mockReturnValue(undefined);
    expect(secureState(t)).toBe('unavailable');
    expect(await unlock(t, 'pw')).toMatchObject({ ok: false, reason: 'unavailable' });
    serverWith();
    const res = await syncLocalData(t);
    expect(res.locked).toContain('customers');
    expect(await getOfflineDb(t).customers.count()).toBe(0);
  });
});

describe('sign-out', () => {
  it('purging the read copy removes every sealed table but never the unsent queue', async () => {
    const t = tenant();
    await unlock(t, 'pw');
    for (const table of SEALED_TABLES) await putRows(t, table, [{ id: 'x', v: 1 }]);
    const db = getOfflineDb(t);
    await db.pendingExpenses.add({ clientId: 'q1', status: 'pending', createdAt: 1, payload: { amount: 1 }, dependsOn: [] });
    await purgeReadCaches(db);
    for (const table of SEALED_TABLES) expect(await db[table].count()).toBe(0);
    expect(await db.pendingExpenses.count()).toBe(1);
    lock(t);
    expect(secureState(t)).toBe('locked');
  });
});
