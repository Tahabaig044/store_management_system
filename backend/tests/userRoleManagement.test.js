// Phase 1.2 - User, Role & Permission Management tests.
//
// Same DB requirements as the other Phase 0/1 test files: point DATABASE_URL
// at a real, throwaway local Postgres database with all migrations applied
// and the permission catalog seeded (npm run seed:permissions). NEVER point
// this at a database holding real tenant data.
//
// This phase's genuine new surface is small (GET /api/users/:id/access, plus
// explicit structural verification of already-existing behavior), since the
// bulk of User/Role/Permission management (user CRUD, self-escalation
// guards, the /api/permissions catalog viewer, and the three per-resource
// access-grant endpoints) was already built and tested in Phase 0.3/0.4 - see
// tests/permissionsArchitecture.test.js and tests/companyArchitecture.test.js
// for that existing coverage, which this file does not duplicate.
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
  return { token: res.body.token, tenantId: res.body.tenant.id, adminId: res.body.user.id };
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

describe('Phase 1.2 - User, Role & Permission Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase12 Tenant A');
    tenantB = await registerTenant('Phase12 Tenant B');
  });

  describe('GET /api/users/:id/access - aggregated access view', () => {
    let branch;
    let company;
    let warehouse;
    let staff;

    beforeAll(async () => {
      const b = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Access Branch' });
      branch = b.body.item;
      company = await request(app).get(`/api/companies/${branch.companyId}`).set('Authorization', `Bearer ${tenantA.token}`).then((r) => r.body.item);
      const wh = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Access Warehouse', branchId: branch.id });
      warehouse = wh.body.item;
      staff = await createUserToken(tenantA.token, 'STORE_KEEPER', branch.id);
    });

    it('a brand-new user with no extra grants shows their primary branch but empty access arrays', async () => {
      const res = await request(app).get(`/api/users/${staff.userId}/access`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.primaryBranchId).toBe(branch.id);
      expect(res.body.companyAccess).toEqual([]);
      expect(res.body.branchAccess).toEqual([]);
      expect(res.body.warehouseAccess).toEqual([]);
    });

    it('reflects a company-wide grant made via the existing POST /api/companies/:id/access endpoint', async () => {
      await request(app).post(`/api/companies/${company.id}/access`).set('Authorization', `Bearer ${tenantA.token}`).send({ userId: staff.userId });
      const res = await request(app).get(`/api/users/${staff.userId}/access`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.body.companyAccess).toEqual([{ companyId: company.id, name: company.name }]);
    });

    it('reflects a warehouse grant made via the existing POST /api/warehouses/:id/access endpoint', async () => {
      await request(app).post(`/api/warehouses/${warehouse.id}/access`).set('Authorization', `Bearer ${tenantA.token}`).send({ userId: staff.userId });
      const res = await request(app).get(`/api/users/${staff.userId}/access`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.body.warehouseAccess).toEqual([{ warehouseId: warehouse.id, name: warehouse.name }]);
    });

    it('reflects revocation immediately', async () => {
      await request(app).delete(`/api/warehouses/${warehouse.id}/access/${staff.userId}`).set('Authorization', `Bearer ${tenantA.token}`);
      const res = await request(app).get(`/api/users/${staff.userId}/access`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.body.warehouseAccess).toEqual([]);
    });

    it('a non-admin cannot view another user\'s access grants', async () => {
      const res = await request(app).get(`/api/users/${staff.userId}/access`).set('Authorization', `Bearer ${staff.token}`);
      expect(res.status).toBe(403);
    });

    it('Tenant B cannot view Tenant A\'s user access (tenant isolation)', async () => {
      const res = await request(app).get(`/api/users/${staff.userId}/access`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(res.status).toBe(404);
    });

    it('a request for a non-existent user id is a 404, not a 500', async () => {
      const res = await request(app).get('/api/users/00000000-0000-0000-0000-000000000000/access').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('User-role assignment via the existing PATCH /api/users/:id', () => {
    it('a TENANT_ADMIN can change another user\'s role and branch', async () => {
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Reassign Branch' });
      const staff = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app)
        .patch(`/api/users/${staff.userId}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ role: 'STORE_KEEPER', branchId: branch2.body.item.id });
      expect(res.status).toBe(200);
      expect(res.body.item.role).toBe('STORE_KEEPER');
      expect(res.body.item.branchId).toBe(branch2.body.item.id);
    });

    it('role changes take effect immediately for the affected user, no re-login required', async () => {
      const staff = await createUserToken(tenantA.token, 'CASHIER');
      const before = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${staff.token}`).send({ name: 'Should Fail Warehouse' });
      expect(before.status).toBe(403); // CASHIER cannot create a warehouse

      await request(app).patch(`/api/users/${staff.userId}`).set('Authorization', `Bearer ${tenantA.token}`).send({ role: 'MANAGER' });

      const after = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${staff.token}`).send({ name: 'Now Allowed Warehouse' });
      expect(after.status).toBe(201); // MANAGER can, same token, no re-login
    });
  });

  describe('SUPER_ADMIN is structurally unreachable through tenant-facing user management', () => {
    it('creating a user with role SUPER_ADMIN is rejected by schema validation, not merely hidden in the UI', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Sneaky', email: uniqueEmail('sneaky'), password: 'TestPass123', role: 'SUPER_ADMIN' });
      expect(res.status).toBe(422); // this codebase's ValidationError status code (utils/errors.js)
    });

    it('promoting an existing user to SUPER_ADMIN via update is rejected by schema validation', async () => {
      const staff = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app)
        .patch(`/api/users/${staff.userId}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ role: 'SUPER_ADMIN' });
      expect(res.status).toBe(422);
    });
  });

  describe('Permission catalog viewer - tenant/role isolation (existing endpoint, re-verified here for Phase 1.2)', () => {
    it('the catalog is identical regardless of which tenant asks (it is global, not tenant data)', async () => {
      const resA = await request(app).get('/api/permissions').set('Authorization', `Bearer ${tenantA.token}`);
      const resB = await request(app).get('/api/permissions').set('Authorization', `Bearer ${tenantB.token}`);
      expect(resA.body.items.length).toBe(resB.body.items.length);
    });

    it('the TENANT resource added in Phase 1.1 is present with the correct roles', async () => {
      const res = await request(app).get('/api/permissions').set('Authorization', `Bearer ${tenantA.token}`);
      const tenantView = res.body.items.find((p) => p.key === 'TENANT:VIEW');
      const tenantUpdate = res.body.items.find((p) => p.key === 'TENANT:UPDATE');
      expect(tenantView.roles.length).toBe(7); // ALL_ROLES
      expect(tenantUpdate.roles).toEqual(['TENANT_ADMIN']);
    });
  });
});
