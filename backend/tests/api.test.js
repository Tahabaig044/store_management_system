// These tests exercise the app without a live database - they verify routing,
// auth/RBAC gating, and error shaping, which do not require Postgres.
// Full CRUD/transaction integration tests need DATABASE_URL pointed at a real
// (throwaway) Postgres instance - see README "Testing" section.
const request = require('supertest');
const app = require('../src/app');

describe('health check', () => {
  it('responds ok without requiring auth or a database', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('authentication is required on protected routes', () => {
  const protectedRoutes = [
    ['/api/products', 'get'],
    ['/api/customers', 'get'],
    ['/api/suppliers', 'get'],
    ['/api/sales', 'get'],
    ['/api/purchases', 'get'],
    ['/api/optical-orders', 'get'],
    ['/api/expenses', 'get'],
    ['/api/dashboard', 'get'],
    ['/api/reports/inventory', 'get'],
    ['/api/users', 'get'],
  ];

  it.each(protectedRoutes)('%s %s rejects requests with no token', async (path, method) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed authorization header', async () => {
    const res = await request(app).get('/api/products').set('Authorization', 'NotBearer abc');
    expect(res.status).toBe(401);
  });
});

describe('validation', () => {
  it('rejects login with an invalid email shape before touching the database', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: 'x' });
    expect(res.status).toBe(422);
  });

  it('rejects tenant registration missing required fields', async () => {
    const res = await request(app).post('/api/auth/register-tenant').send({});
    expect(res.status).toBe(422);
  });
});

describe('error handler', () => {
  it('returns 404 with no internal details for unknown routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
