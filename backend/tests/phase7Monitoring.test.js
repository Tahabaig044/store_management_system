// Phase 7.3: the new frontend error-reporting endpoint. Reuses the existing,
// already-tested captureException()/ALERT_WEBHOOK_URL mechanism
// (tests/errorTracking.test.js covers that mechanism itself in depth) - this
// file only proves the new endpoint wires into it correctly and safely.
const request = require('supertest');
const app = require('../src/app');
const { _resetForTests } = require('../src/utils/errorTracking');

describe('POST /api/client-errors - frontend error reporting', () => {
  const realFetch = global.fetch;
  let calls;
  beforeEach(() => {
    _resetForTests();
    calls = [];
    global.fetch = jest.fn(async (url, opts) => { calls.push({ url, opts }); return { ok: true }; });
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/x';
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.ALERT_WEBHOOK_URL;
    jest.restoreAllMocks();
  });

  test('is reachable with no authentication at all - a crash before login must still be reportable', async () => {
    const res = await request(app).post('/api/client-errors').send({ message: 'Something broke', source: 'react-error-boundary' });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].opts.body);
    expect(payload.text).toContain('Something broke');
    expect(payload.text).toContain('frontend:react-error-boundary');
  });

  test('a stack trace and URL are passed through to the same reporting mechanism', async () => {
    const stack = 'Error: Deep crash\n  at Component.render (App.jsx:42:10)';
    const res = await request(app).post('/api/client-errors').send({ message: 'Deep crash', stack, url: 'https://app.example/dashboard' });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
  });

  test('a stack trace longer than the accepted cap is rejected (silently dropped), not truncated and forwarded', async () => {
    const res = await request(app).post('/api/client-errors').send({ message: 'Deep crash', stack: 'x'.repeat(10000) });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  test('a malformed report is silently dropped, not a server error', async () => {
    const res = await request(app).post('/api/client-errors').send({ notMessage: 'oops' });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  test('an overly long message is rejected by validation without crashing', async () => {
    const res = await request(app).post('/api/client-errors').send({ message: 'x'.repeat(10000) });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  test('never returns any business or request data back to the caller - just 204', async () => {
    const res = await request(app).post('/api/client-errors').send({ message: 'leak test', source: 'window-error' });
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });
});
