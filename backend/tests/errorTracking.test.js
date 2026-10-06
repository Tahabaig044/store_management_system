// Production monitoring hook: alerts go to ALERT_WEBHOOK_URL, are throttled, carry no sensitive data, and can
// never throw into the request that failed.
const request = require('supertest');
const { captureException, _resetForTests } = require('../src/utils/errorTracking');

describe('error tracking / alert webhook', () => {
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

  test('posts one alert with message, method and path, and no other request data', async () => {
    await captureException(new Error('boom'), { requestId: 'r-1', method: 'POST', path: '/sales', body: { password: 'secret' }, authorization: 'Bearer abc' });
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].opts.body);
    expect(payload.text).toContain('boom');
    expect(payload.text).toContain('POST /sales');
    expect(payload.text).toContain('r-1');
    expect(calls[0].opts.body).not.toMatch(/secret|Bearer|abc/);
  });

  test('identical alerts are throttled; a different error still goes out', async () => {
    await captureException(new Error('same'), { method: 'GET', path: '/a' });
    await captureException(new Error('same'), { method: 'GET', path: '/a' });
    await captureException(new Error('other'), { method: 'GET', path: '/a' });
    expect(calls).toHaveLength(2);
  });

  test('total alerts are capped per hour', async () => {
    for (let i = 0; i < 50; i += 1) await captureException(new Error(`e${i}`), { path: '/x' });
    expect(calls).toHaveLength(30);
  });

  test('no webhook configured: logs only, never calls out', async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    await captureException(new Error('quiet'));
    expect(calls).toHaveLength(0);
  });

  test('a failing webhook never throws', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network down'); });
    await expect(captureException(new Error('x'), { path: '/y' })).resolves.toBeUndefined();
  });

  test('the health endpoint stays generic (no internals) while a DB failure is reported', async () => {
    const prisma = require('../src/config/prisma');
    const app = require('../src/app');
    jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('db password=hunter2 unreachable'));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|unreachable/);
    expect(calls.length).toBe(1);
  });
});
