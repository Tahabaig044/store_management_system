import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import apiClient from './client';

// The interceptor must announce writes that can change stock (so the offline layer refreshes its
// local stock copy at once) and nothing else, without ever touching the response.
function stubAdapter(status = 200) {
  apiClient.defaults.adapter = async (config) => ({ data: { ok: true }, status, statusText: 'OK', headers: {}, config });
}

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

let events;
let listener;
beforeEach(() => {
  events = [];
  listener = (e) => events.push(e.detail);
  window.addEventListener('akvf:stock-mutated', listener);
  stubAdapter();
});
afterEach(() => window.removeEventListener('akvf:stock-mutated', listener));

describe('stock-mutation announcements (Phase 3.1)', () => {
  it.each([
    ['post', '/products/p1/adjust-stock'],
    ['post', '/sales'],
    ['post', '/sales/s1/reverse'],
    ['post', '/purchases'],
    ['post', '/purchases/x/receive'],
    ['post', '/warehouses/w1/receive'],
    ['post', '/stock-transfers/t1/dispatch'],
    ['post', '/sales-returns'],
    ['post', '/purchase-returns'],
    ['post', '/goods-receipts'],
    ['patch', '/products/p1'],
    ['delete', '/products/p1'],
  ])('announces a successful %s %s', async (method, url) => {
    await apiClient[method](url, method === 'delete' ? undefined : {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ url, method });
  });

  it.each([
    ['get', '/products'],
    ['get', '/offline/manifest'],
    ['post', '/customers'],
    ['post', '/expenses'],
    ['post', '/payments'],
    ['post', '/auth/login'],
  ])('does not announce %s %s', async (method, url) => {
    await apiClient[method](url, method === 'get' ? undefined : {});
    expect(events).toHaveLength(0);
  });

  it('does not announce a failed write, and passes the failure through untouched', async () => {
    apiClient.defaults.adapter = async (config) => {
      const error = new Error('Request failed');
      error.config = config;
      error.response = { status: 409, data: { error: 'Insufficient stock' }, config };
      throw error;
    };
    await expect(apiClient.post('/sales', {})).rejects.toMatchObject({ response: { status: 409 } });
    expect(events).toHaveLength(0);
  });
});
