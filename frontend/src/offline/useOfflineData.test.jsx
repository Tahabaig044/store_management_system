import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import apiClient from '../api/client';
import { getOfflineDb } from './db';
import { OUTBOXES } from './syncEngine';
import { processQueue } from './syncCoordinator';
import { useLiveCustomers, useLiveSuppliers } from './useOfflineData';
import { extractRefs } from './syncCore';
import { unlockFor, putSealed } from '../test/secure';

vi.mock('../api/client', () => ({ default: { get: vi.fn().mockRejectedValue(new Error('offline')), post: vi.fn() } }));

describe('offline-created customers and suppliers are usable immediately (Phase 3.2)', () => {
  it('a customer created offline is selectable right away under a reference id, a sale can use it, and after sync it appears under its real id', async () => {
    const tenantId = crypto.randomUUID();
    await unlockFor(tenantId);
    await putSealed(tenantId, 'customers', [{ id: 'cust-existing', name: 'Existing' }]);

    const { result } = renderHook(() => useLiveCustomers(tenantId));
    await waitFor(() => expect(result.current).toHaveLength(1));

    const queued = await OUTBOXES.customers.queue(tenantId, { name: 'Offline Ola', phone: '0300' });
    await waitFor(() => expect(result.current).toHaveLength(2));
    const listed = result.current.find((c) => c.name === 'Offline Ola');
    expect(listed.id).toBe(`$ref:${queued.clientId}`);
    expect(listed._pendingSync).toBe(true);

    // The POS puts that id in the sale; the engine understands it as a dependency.
    const sale = await OUTBOXES.sales.queue(tenantId, { customerId: listed.id, items: [{ productId: 'p', quantity: 1, unitPrice: 5 }] });
    expect([...extractRefs(sale.payload)]).toEqual([queued.clientId]);
    expect(sale.dependsOn).toEqual([queued.clientId]);

    apiClient.post.mockImplementation(async (path) => (path === '/customers' ? { data: { item: { id: 'server-cust', name: 'Offline Ola' } } } : { data: { item: { id: 'server-sale' } } }));
    await processQueue(tenantId, { force: true });
    await waitFor(() => expect(result.current.find((c) => c.name === 'Offline Ola').id).toBe('server-cust'));
    expect(result.current.find((c) => c.name === 'Offline Ola')._pendingSync).toBe(false);
    expect(apiClient.post.mock.calls.find(([p]) => p === '/sales')[1].customerId).toBe('server-cust');
  });

  it('an offline-created supplier is listed the same way, and a rejected one stays listed as pending so nothing the user relies on vanishes', async () => {
    const tenantId = crypto.randomUUID();
    const { result } = renderHook(() => useLiveSuppliers(tenantId));
    const queued = await OUTBOXES.suppliers.queue(tenantId, { name: 'Offline Supply' });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].id).toBe(`$ref:${queued.clientId}`);

    apiClient.post.mockRejectedValueOnce({ response: { status: 409, data: { code: 'DUPLICATE', error: 'exists' } } });
    await processQueue(tenantId, { force: true });
    expect((await getOfflineDb(tenantId).pendingSuppliers.get(queued.clientId)).status).toBe('conflict');
    expect(result.current).toHaveLength(1);
    expect(result.current[0]._pendingSync).toBe(true);
  });
});
