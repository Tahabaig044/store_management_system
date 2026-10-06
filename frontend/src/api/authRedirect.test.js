import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import apiClient from './client';
import portalApi from '../portal/portalApi';

// An expired or rejected token must send the browser to the login page INSIDE the app's base path
// (/BizOS/login). A bare '/login' is outside the router's basename and rendered a blank page.
const store = new Map();
let loc;

function failWith(client, status) {
  client.defaults.adapter = async (config) => {
    const error = new Error('Request failed');
    error.config = config;
    error.response = { status, data: { error: 'x' }, config };
    throw error;
  };
}

beforeEach(() => {
  store.clear();
  loc = { pathname: '/BizOS/pos', href: 'https://example.test/BizOS/pos' };
  vi.stubEnv('BASE_URL', '/BizOS/');
  vi.stubGlobal('location', loc);
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('staff API client', () => {
  it('on 401 clears the session and redirects to /BizOS/login', async () => {
    store.set('akvf_token', 't');
    store.set('akvf_user', '{}');
    failWith(apiClient, 401);
    await expect(apiClient.get('/sales')).rejects.toMatchObject({ response: { status: 401 } });
    expect(loc.href).toBe('/BizOS/login');
    expect(store.has('akvf_token')).toBe(false);
    expect(store.has('akvf_user')).toBe(false);
  });

  it('does not redirect when already on the in-app login page', async () => {
    loc.pathname = '/BizOS/login';
    loc.href = 'https://example.test/BizOS/login';
    failWith(apiClient, 401);
    await expect(apiClient.post('/auth/login', {})).rejects.toBeDefined();
    expect(loc.href).toBe('https://example.test/BizOS/login');
  });

  it.each([400, 403, 404, 409, 500])('a %i is passed through with no redirect and the session kept', async (status) => {
    store.set('akvf_token', 't');
    failWith(apiClient, status);
    await expect(apiClient.get('/sales')).rejects.toMatchObject({ response: { status } });
    expect(loc.href).toBe('https://example.test/BizOS/pos');
    expect(store.get('akvf_token')).toBe('t');
  });

  it('a successful response is untouched', async () => {
    apiClient.defaults.adapter = async (config) => ({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config });
    const res = await apiClient.get('/sales');
    expect(res.data).toEqual({ ok: true });
    expect(loc.href).toBe('https://example.test/BizOS/pos');
  });

  it('follows the configured base path instead of a hardcoded /BizOS/', async () => {
    vi.stubEnv('BASE_URL', '/Other/');
    failWith(apiClient, 401);
    await expect(apiClient.get('/sales')).rejects.toBeDefined();
    expect(loc.href).toBe('/Other/login');
  });
});

describe('customer portal API client', () => {
  it('on 401 clears the portal session and redirects to /BizOS/portal/login (never the staff login)', async () => {
    loc.pathname = '/BizOS/portal';
    store.set('akvf_portal_token', 't');
    store.set('akvf_portal_customer', '{}');
    failWith(portalApi, 401);
    await expect(portalApi.get('/portal/me')).rejects.toMatchObject({ response: { status: 401 } });
    expect(loc.href).toBe('/BizOS/portal/login');
    expect(store.has('akvf_portal_token')).toBe(false);
    expect(store.has('akvf_portal_customer')).toBe(false);
  });

  it('does not redirect when already on the portal login page', async () => {
    loc.pathname = '/BizOS/portal/login';
    loc.href = 'https://example.test/BizOS/portal/login';
    failWith(portalApi, 401);
    await expect(portalApi.post('/portal/auth/verify-otp', {})).rejects.toBeDefined();
    expect(loc.href).toBe('https://example.test/BizOS/portal/login');
  });

  it('a non-401 error does not redirect', async () => {
    failWith(portalApi, 500);
    await expect(portalApi.get('/portal/me')).rejects.toMatchObject({ response: { status: 500 } });
    expect(loc.href).toBe('https://example.test/BizOS/pos');
  });
});
