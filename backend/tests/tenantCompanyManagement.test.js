// Phase 1.1 - Company & Tenant Management tests.
//
// Same DB requirements as companyArchitecture.test.js: point DATABASE_URL at
// a real, throwaway local Postgres database with migrations applied
// (including 20260919064158_phase1_1_company_tenant_management) and the
// permission catalog seeded (npm run seed:permissions - the new TENANT
// resource must be present). NEVER point this at a database holding real
// tenant data.
const request = require('supertest');
const app = require('../src/app');

jest.setTimeout(30000);

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function registerTenant(businessName) {
  const res = await request(app).post('/api/auth/register-tenant').send({
    businessName,
    adminName: 'Test Admin',
    email: uniqueEmail('admin'),
    password: 'TestPass123',
  });
  if (res.status !== 201) throw new Error(`register-tenant failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}

async function createUserToken(adminToken, role, branchId) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return { token: login.body.token, userId: created.body.item.id };
}

describe('Phase 1.1 - Company & Tenant Management', () => {
  let tenantA;
  let tenantB;
  let staffA; // non-admin, created once and reused across assertions to avoid the auth rate limiter

  beforeAll(async () => {
    tenantA = await registerTenant('Phase11 Tenant A');
    tenantB = await registerTenant('Phase11 Tenant B');
    staffA = await createUserToken(tenantA.token, 'STORE_KEEPER');
  });

  describe('Tenant profile - GET /api/tenant', () => {
    it('a TENANT_ADMIN can view its own tenant profile', async () => {
      const res = await request(app).get('/api/tenant').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.tenant.id).toBe(tenantA.tenantId);
      expect(res.body.tenant.businessName).toBe('Phase11 Tenant A');
    });

    it('a non-admin staff member can also view the tenant profile (VIEW is ALL_ROLES)', async () => {
      const res = await request(app).get('/api/tenant').set('Authorization', `Bearer ${staffA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.tenant.id).toBe(tenantA.tenantId);
    });

    it('a request with no auth token is rejected', async () => {
      const res = await request(app).get('/api/tenant');
      expect(res.status).toBe(401);
    });
  });

  describe('Tenant profile - PATCH /api/tenant', () => {
    it('a TENANT_ADMIN can update its own tenant profile', async () => {
      const res = await request(app)
        .patch('/api/tenant')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ phone: '0300-1234567', currency: 'PKR', timezone: 'Asia/Karachi', ntn: 'NTN-001' });
      expect(res.status).toBe(200);
      expect(res.body.tenant.phone).toBe('0300-1234567');
      expect(res.body.tenant.currency).toBe('PKR');
      expect(res.body.tenant.ntn).toBe('NTN-001');
    });

    it('a non-admin staff member cannot update the tenant profile', async () => {
      const res = await request(app)
        .patch('/api/tenant')
        .set('Authorization', `Bearer ${staffA.token}`)
        .send({ phone: '0300-0000000' });
      expect(res.status).toBe(403);
    });

    it('enabledIndustryPacks cannot be changed via this endpoint (owned by the module-activation system)', async () => {
      const res = await request(app)
        .patch('/api/tenant')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ enabledIndustryPacks: ['MEDICINE'] });
      expect(res.status).toBe(200);
      // Unknown/disallowed field is silently stripped by the zod schema, not applied.
      const check = await request(app).get('/api/tenant').set('Authorization', `Bearer ${tenantA.token}`);
      expect(check.body.tenant.enabledIndustryPacks).not.toEqual(['MEDICINE']);
    });

    it('Tenant B updating its profile does not affect Tenant A\'s profile (tenant isolation)', async () => {
      await request(app).patch('/api/tenant').set('Authorization', `Bearer ${tenantB.token}`).send({ phone: '0300-9999999' });
      const checkA = await request(app).get('/api/tenant').set('Authorization', `Bearer ${tenantA.token}`);
      expect(checkA.body.tenant.phone).toBe('0300-1234567');
    });
  });

  describe('Company identity fields - create/update', () => {
    it('a company can be created with the new identity fields', async () => {
      const res = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          name: 'Identity Co',
          code: 'IDC',
          address: '123 Main St',
          phone: '021-1111111',
          email: 'identity@test.local',
          ntn: 'NTN-IDC',
          strn: 'STRN-IDC',
        });
      expect(res.status).toBe(201);
      expect(res.body.item.address).toBe('123 Main St');
      expect(res.body.item.email).toBe('identity@test.local');
      expect(res.body.item.ntn).toBe('NTN-IDC');
      expect(res.body.item.isDefault).toBe(false);
    });

    it('a company\'s identity fields can be updated', async () => {
      const created = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Updatable Co' });
      const res = await request(app)
        .patch(`/api/companies/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ phone: '021-2222222', logoUrl: 'https://example.test/logo.png' });
      expect(res.status).toBe(200);
      expect(res.body.item.phone).toBe('021-2222222');
      expect(res.body.item.logoUrl).toBe('https://example.test/logo.png');
    });
  });

  describe('Company isDefault exclusivity', () => {
    let excTenant;
    let companyOne;
    let companyTwo;

    beforeAll(async () => {
      excTenant = await registerTenant('Phase11 Exclusivity Tenant');
      // Registering a tenant does not itself create a company - the first
      // branch/product action does, lazily, via ensureDefaultCompany.
      const b = await request(app).post('/api/branches').set('Authorization', `Bearer ${excTenant.token}`).send({ name: 'Exc Branch' });
      expect(b.status).toBe(201);
      companyOne = await request(app)
        .get(`/api/companies/${b.body.item.companyId}`)
        .set('Authorization', `Bearer ${excTenant.token}`)
        .then((r) => r.body.item);
      expect(companyOne.isDefault).toBe(true); // the lazily-created default company

      const c2 = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${excTenant.token}`)
        .send({ name: 'Second Company' });
      companyTwo = c2.body.item;
      expect(companyTwo.isDefault).toBe(false);
    });

    it('marking a second company as default clears the flag on the first', async () => {
      const res = await request(app)
        .patch(`/api/companies/${companyTwo.id}`)
        .set('Authorization', `Bearer ${excTenant.token}`)
        .send({ isDefault: true });
      expect(res.status).toBe(200);
      expect(res.body.item.isDefault).toBe(true);

      const checkOne = await request(app).get(`/api/companies/${companyOne.id}`).set('Authorization', `Bearer ${excTenant.token}`);
      expect(checkOne.body.item.isDefault).toBe(false);
    });

    it('exactly one company remains marked default after the switch (never zero, never two)', async () => {
      const list = await request(app).get('/api/companies').set('Authorization', `Bearer ${excTenant.token}`);
      const defaults = list.body.items.filter((c) => c.isDefault);
      expect(defaults.length).toBe(1);
      expect(defaults[0].id).toBe(companyTwo.id);
    });

    it('a newly created company with isDefault: true immediately becomes the sole default', async () => {
      const c3 = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${excTenant.token}`)
        .send({ name: 'Third Company', isDefault: true });
      expect(c3.status).toBe(201);
      expect(c3.body.item.isDefault).toBe(true);

      const list = await request(app).get('/api/companies').set('Authorization', `Bearer ${excTenant.token}`);
      const defaults = list.body.items.filter((c) => c.isDefault);
      expect(defaults.length).toBe(1);
      expect(defaults[0].id).toBe(c3.body.item.id);
    });
  });

  describe('Branch creation still resolves to the (now possibly explicit) default company', () => {
    it('a new branch with no companyId is assigned to whichever company is currently marked isDefault', async () => {
      const t = await registerTenant('Phase11 Branch Regression Tenant');
      const first = await request(app).post('/api/branches').set('Authorization', `Bearer ${t.token}`).send({ name: 'First Branch' });
      const defaultCompanyId = first.body.item.companyId;

      const secondCompany = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${t.token}`)
        .send({ name: 'Explicit Default Co', isDefault: true });
      expect(secondCompany.body.item.isDefault).toBe(true);

      const second = await request(app).post('/api/branches').set('Authorization', `Bearer ${t.token}`).send({ name: 'Second Branch' });
      expect(second.body.item.companyId).toBe(secondCompany.body.item.id);
      expect(second.body.item.companyId).not.toBe(defaultCompanyId);
    });
  });

  describe('Tenant and company isolation (cross-tenant)', () => {
    it('Tenant B cannot view Tenant A\'s tenant profile (there is no :id, so this is enforced entirely by JWT-derived tenantId)', async () => {
      const resA = await request(app).get('/api/tenant').set('Authorization', `Bearer ${tenantA.token}`);
      const resB = await request(app).get('/api/tenant').set('Authorization', `Bearer ${tenantB.token}`);
      expect(resA.body.tenant.id).not.toBe(resB.body.tenant.id);
    });

    it('Tenant B cannot set isDefault on a Tenant A company it doesn\'t own', async () => {
      const companyA = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'A Isolation Co' });
      const res = await request(app)
        .patch(`/api/companies/${companyA.body.item.id}`)
        .set('Authorization', `Bearer ${tenantB.token}`)
        .send({ isDefault: true });
      expect(res.status).toBe(404);
    });
  });
});
