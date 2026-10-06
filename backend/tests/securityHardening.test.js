// V1 Phase 3 - production security checks found by the independent audit.
const supertest = require('supertest');
const app = require('../src/app');

jest.setTimeout(30000);

const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const req = (m, p) => supertest(app)[m](p).set('X-Forwarded-For', ip());

describe('request-body errors are client errors, not server errors', () => {
  test('malformed JSON -> 400 with a generic message', async () => {
    const res = await req('post', '/api/auth/login').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_JSON');
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected|position|SyntaxError|at /);
  });

  test('oversized body -> 413', async () => {
    const res = await req('post', '/api/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(3 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  test('neither raises an operator alert', async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = jest.fn(async (...a) => { calls.push(a); return { ok: true }; });
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/x';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await req('post', '/api/auth/login').set('Content-Type', 'application/json').send('{bad');
      expect(calls).toHaveLength(0);
    } finally {
      global.fetch = realFetch;
      delete process.env.ALERT_WEBHOOK_URL;
      jest.restoreAllMocks();
    }
  });
});

describe('transport and token hardening', () => {
  test('a foreign origin gets no CORS permission', async () => {
    const res = await req('options', '/api/products').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('security headers are present and the framework is not advertised', async () => {
    const res = await req('get', '/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test.each([
    ['alg:none token', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.'],
    ['garbage token', 'not.a.jwt'],
  ])('%s is rejected', async (_n, token) => {
    const res = await req('get', '/api/products').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test('a staff request without credentials never reaches business data', async () => {
    for (const p of ['/api/products', '/api/sales', '/api/users', '/api/accounting/reports/trial-balance', '/api/offline/manifest']) {
      expect((await req('get', p)).status).toBe(401);
    }
  });
});

describe('production configuration guards', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    process.env.JWT_SECRET = saved.JWT_SECRET;
    jest.resetModules();
  });
  const load = () => { jest.isolateModules(() => { require('../src/config/env'); }); };

  test('production refuses the placeholder JWT secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'change-this-to-a-long-random-string';
    expect(load).toThrow(/placeholder/);
  });

  test('production refuses a short JWT secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'short-secret';
    expect(load).toThrow(/too short/);
  });

  test('production accepts a strong secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'x'.repeat(48);
    expect(load).not.toThrow();
  });
});
