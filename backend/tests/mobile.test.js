// Integration tests for the Owner Mobile (Android app) API surface
// (/api/mobile/v1) added in Phase 1 - auth, RBAC (owner-only access),
// tenant isolation, and read-only enforcement at the API level.
//
// Like business.test.js, this needs DATABASE_URL pointed at a real,
// throwaway Postgres database with migrations applied - see README
// "Testing" section. Every tenant/user here is freshly created inside this
// file, so it is safe to run repeatedly, but never point it at a database
// holding real tenant data.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

jest.setTimeout(30000);

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function registerTenantWithCreds(businessName) {
  const email = uniqueEmail('owner');
  const password = 'TestPass123';
  const res = await request(app)
    .post('/api/auth/register-tenant')
    .send({ businessName, adminName: 'Test Owner', email, password });
  if (res.status !== 201) throw new Error(`register-tenant failed: ${JSON.stringify(res.body)}`);
  return { webToken: res.body.token, tenantId: res.body.tenant.id, userId: res.body.user.id, email, password };
}

async function createUser(adminToken, role) {
  const email = uniqueEmail(role.toLowerCase());
  const password = 'TestPass123';
  const res = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password, role });
  if (res.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(res.body)}`);
  return { userId: res.body.item.id, email, password };
}

async function mobileLogin(email, password) {
  return request(app).post('/api/mobile/v1/auth/login').send({ email, password });
}

describe('Owner Mobile API (/api/mobile/v1)', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenantWithCreds(`Mobile Test Tenant A ${Date.now()}`);
    tenantB = await registerTenantWithCreds(`Mobile Test Tenant B ${Date.now()}`);
  });

  describe('health', () => {
    it('is public and reports the versioned mobile API', async () => {
      const res = await request(app).get('/api/mobile/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.api).toBe('mobile');
      expect(res.body.version).toBe('v1');
    });
  });

  describe('login', () => {
    it('logs the tenant owner (TENANT_ADMIN) in and returns a read-only mobile token', async () => {
      const res = await mobileLogin(tenantA.email, tenantA.password);
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user.role).toBe('TENANT_ADMIN');
      expect(res.body.permissions).toEqual({ readOnly: true, role: 'OWNER_MOBILE' });

      const decoded = jwt.decode(res.body.token);
      expect(decoded.typ).toBe('mobile');
      expect(decoded.tenantId).toBe(tenantA.tenantId);
    });

    it('rejects a non-owner staff account (e.g. CASHIER) even with the correct password', async () => {
      const cashier = await createUser(tenantA.webToken, 'CASHIER');
      const res = await mobileLogin(cashier.email, cashier.password);
      expect(res.status).toBe(401);
    });

    it('rejects a wrong password for a real owner account', async () => {
      const res = await mobileLogin(tenantA.email, 'WrongPassword1');
      expect(res.status).toBe(401);
    });

    it('rejects an unknown email', async () => {
      const res = await mobileLogin('does-not-exist@test.local', 'whatever123');
      expect(res.status).toBe(401);
    });

    it('rejects malformed login payloads before touching the database', async () => {
      const res = await request(app).post('/api/mobile/v1/auth/login').send({ email: 'not-an-email', password: '' });
      expect(res.status).toBe(422);
    });
  });

  describe('profile', () => {
    it('rejects requests with no token', async () => {
      const res = await request(app).get('/api/mobile/v1/profile');
      expect(res.status).toBe(401);
    });

    it('rejects a malformed authorization header', async () => {
      const res = await request(app).get('/api/mobile/v1/profile').set('Authorization', 'NotBearer abc');
      expect(res.status).toBe(401);
    });

    it('returns the owner and tenant profile for a valid mobile token', async () => {
      const login = await mobileLogin(tenantA.email, tenantA.password);
      const res = await request(app).get('/api/mobile/v1/profile').set('Authorization', `Bearer ${login.body.token}`);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(tenantA.email);
      expect(res.body.tenant.id).toBe(tenantA.tenantId);
      expect(res.body.permissions.readOnly).toBe(true);
    });

    it('scopes strictly to the caller\'s own tenant (tenant isolation)', async () => {
      const loginA = await mobileLogin(tenantA.email, tenantA.password);
      const loginB = await mobileLogin(tenantB.email, tenantB.password);
      const resA = await request(app).get('/api/mobile/v1/profile').set('Authorization', `Bearer ${loginA.body.token}`);
      const resB = await request(app).get('/api/mobile/v1/profile').set('Authorization', `Bearer ${loginB.body.token}`);
      expect(resA.body.tenant.id).toBe(tenantA.tenantId);
      expect(resB.body.tenant.id).toBe(tenantB.tenantId);
      expect(resA.body.tenant.id).not.toBe(resB.body.tenant.id);
    });

    it('rejects an expired mobile token', async () => {
      const expired = jwt.sign(
        { sub: tenantA.userId, tenantId: tenantA.tenantId, role: 'TENANT_ADMIN', typ: 'mobile' },
        process.env.JWT_SECRET,
        { expiresIn: '-10s' }
      );
      const res = await request(app).get('/api/mobile/v1/profile').set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
    });

    it('immediately loses access once the underlying account is deactivated', async () => {
      const secondOwner = await createUser(tenantA.webToken, 'TENANT_ADMIN');
      const login = await mobileLogin(secondOwner.email, secondOwner.password);
      expect(login.status).toBe(200);

      const deactivate = await request(app)
        .patch(`/api/users/${secondOwner.userId}`)
        .set('Authorization', `Bearer ${tenantA.webToken}`)
        .send({ isActive: false });
      expect(deactivate.status).toBe(200);

      const res = await request(app)
        .get('/api/mobile/v1/profile')
        .set('Authorization', `Bearer ${login.body.token}`);
      expect(res.status).toBe(401);
    });
  });

  describe('cross-surface token isolation', () => {
    it('rejects a staff web token on a mobile route', async () => {
      const webLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: tenantA.email, password: tenantA.password });
      const res = await request(app)
        .get('/api/mobile/v1/profile')
        .set('Authorization', `Bearer ${webLogin.body.token}`);
      expect(res.status).toBe(401);
    });

    it('rejects a mobile token on a staff web read route', async () => {
      const login = await mobileLogin(tenantA.email, tenantA.password);
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
      expect(res.status).toBe(401);
    });

    it('rejects a mobile token on a staff web write route (unauthorized write attempt)', async () => {
      const login = await mobileLogin(tenantA.email, tenantA.password);
      const res = await request(app)
        .post('/api/customers')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ name: 'Should Not Be Created' });
      expect(res.status).toBe(401);
    });
  });

  describe('read-only enforcement inside the mobile namespace', () => {
    it('rejects a write attempt (POST) to a mobile route with a valid token', async () => {
      const login = await mobileLogin(tenantA.email, tenantA.password);
      const res = await request(app)
        .post('/api/mobile/v1/profile')
        .set('Authorization', `Bearer ${login.body.token}`);
      expect(res.status).toBe(403);
    });

    it('rejects a write attempt (PATCH) to a mobile route with a valid token', async () => {
      const login = await mobileLogin(tenantA.email, tenantA.password);
      const res = await request(app)
        .patch('/api/mobile/v1/profile')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ name: 'Hacked' });
      expect(res.status).toBe(403);
    });

    it('checks authentication before the read-only guard (no token -> 401, not 403)', async () => {
      const res = await request(app).post('/api/mobile/v1/profile');
      expect(res.status).toBe(401);
    });
  });

  describe('logout', () => {
    it('requires a valid token', async () => {
      const res = await request(app).post('/api/mobile/v1/auth/logout');
      expect(res.status).toBe(401);
    });

    it('succeeds for a valid mobile token', async () => {
      const login = await mobileLogin(tenantA.email, tenantA.password);
      const res = await request(app)
        .post('/api/mobile/v1/auth/logout')
        .set('Authorization', `Bearer ${login.body.token}`);
      expect(res.status).toBe(200);
    });
  });
});
