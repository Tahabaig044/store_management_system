// Phase 0.3 Multi-Tenant/Company/Branch Architecture tests.
//
// Same DB requirements as business.test.js: point DATABASE_URL at a real,
// throwaway local Postgres database with migrations applied (including
// 20260917100806_phase0_3_multi_tenant_company_branch). NEVER point this at
// a database holding real tenant data.
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

describe('Phase 0.3 - Multi-Tenant / Company / Branch Architecture', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase03 Tenant A');
    tenantB = await registerTenant('Phase03 Tenant B');
  });

  describe('Company CRUD and tenant isolation', () => {
    it('a TENANT_ADMIN can create a company', async () => {
      const res = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Second Legal Entity', code: 'SLE' });
      expect(res.status).toBe(201);
      expect(res.body.item.name).toBe('Second Legal Entity');
    });

    it('Tenant B cannot read Tenant A\'s company by ID', async () => {
      const created = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'A-Only Company' });
      const crossTenant = await request(app)
        .get(`/api/companies/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantB.token}`);
      expect(crossTenant.status).toBe(404);
    });

    it('creating a branch with a company id belonging to another tenant is rejected', async () => {
      const companyB = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${tenantB.token}`)
        .send({ name: 'Tenant B Company' });
      const res = await request(app)
        .post('/api/branches')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Cross-Tenant Branch', companyId: companyB.body.item.id });
      expect(res.status).toBe(404);
    });
  });

  describe('Backward compatibility: branch creation without a companyId', () => {
    it('creating a branch with no companyId still succeeds and is auto-assigned a default company', async () => {
      const res = await request(app)
        .post('/api/branches')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: `Legacy-style Branch ${Date.now()}` });
      expect(res.status).toBe(201);
      expect(res.body.item.companyId).toBeTruthy();

      const company = await request(app)
        .get(`/api/companies/${res.body.item.companyId}`)
        .set('Authorization', `Bearer ${tenantA.token}`);
      expect(company.status).toBe(200);
    });

    it('two branches created with no companyId end up under the SAME default company (not two different ones)', async () => {
      const b1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantB.token}`).send({ name: `Def Branch 1 ${Date.now()}` });
      const b2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantB.token}`).send({ name: `Def Branch 2 ${Date.now()}` });
      expect(b1.body.item.companyId).toBe(b2.body.item.companyId);
    });
  });

  describe('Company-wide access tier', () => {
    let ownCompanyTenant;
    let companyX;
    let branch1;
    let branch2;
    let companyWideUser;
    let noAccessUser;

    beforeAll(async () => {
      ownCompanyTenant = await registerTenant('Phase03 Company-Wide Tenant');
      const companyRes = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${ownCompanyTenant.token}`)
        .send({ name: 'Company X' });
      companyX = companyRes.body.item;

      const b1 = await request(app)
        .post('/api/branches')
        .set('Authorization', `Bearer ${ownCompanyTenant.token}`)
        .send({ name: 'X Branch 1', companyId: companyX.id });
      branch1 = b1.body.item;
      const b2 = await request(app)
        .post('/api/branches')
        .set('Authorization', `Bearer ${ownCompanyTenant.token}`)
        .send({ name: 'X Branch 2', companyId: companyX.id });
      branch2 = b2.body.item;

      companyWideUser = await createUserToken(ownCompanyTenant.token, 'STORE_KEEPER', branch1.id);
      noAccessUser = await createUserToken(ownCompanyTenant.token, 'STORE_KEEPER', branch1.id);

      // Grant companyWideUser company-wide access to Company X.
      const grant = await request(app)
        .post(`/api/companies/${companyX.id}/access`)
        .set('Authorization', `Bearer ${ownCompanyTenant.token}`)
        .send({ userId: companyWideUser.userId });
      if (grant.status !== 201) throw new Error(`grant failed: ${JSON.stringify(grant.body)}`);
    });

    it('a user with company-wide access can act on BOTH branches under that company (warehouses)', async () => {
      const wh2 = await request(app)
        .post('/api/warehouses')
        .set('Authorization', `Bearer ${ownCompanyTenant.token}`)
        .send({ name: 'Branch 2 Warehouse', branchId: branch2.id });
      expect(wh2.status).toBe(201);

      // companyWideUser's OWN branch is branch1, but they should also reach
      // branch2's warehouse purely via the company-wide grant.
      const res = await request(app)
        .get(`/api/warehouses/${wh2.body.item.id}/stock`)
        .set('Authorization', `Bearer ${companyWideUser.token}`);
      expect(res.status).toBe(200);
    });

    it('a user WITHOUT the company-wide grant, restricted to branch1 only, cannot reach branch2\'s warehouse', async () => {
      const wh2 = await request(app)
        .post('/api/warehouses')
        .set('Authorization', `Bearer ${ownCompanyTenant.token}`)
        .send({ name: 'Branch 2 Warehouse Two', branchId: branch2.id });

      const res = await request(app)
        .get(`/api/warehouses/${wh2.body.item.id}/stock`)
        .set('Authorization', `Bearer ${noAccessUser.token}`);
      expect(res.status).toBe(403);
    });

    it('revoking company access removes the company-wide grant', async () => {
      const revoke = await request(app)
        .delete(`/api/companies/${companyX.id}/access/${companyWideUser.userId}`)
        .set('Authorization', `Bearer ${ownCompanyTenant.token}`);
      expect(revoke.status).toBe(204);

      const wh2 = await request(app)
        .post('/api/warehouses')
        .set('Authorization', `Bearer ${ownCompanyTenant.token}`)
        .send({ name: 'Branch 2 Warehouse Three', branchId: branch2.id });
      const res = await request(app)
        .get(`/api/warehouses/${wh2.body.item.id}/stock`)
        .set('Authorization', `Bearer ${companyWideUser.token}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Branch-scope fixes - spot checks across the documented gap list', () => {
    let scopeTenant;
    let branchA;
    let branchB;
    let storeKeeperA;
    let accountantA;

    beforeAll(async () => {
      scopeTenant = await registerTenant('Phase03 Scope Tenant');
      const bA = await request(app).post('/api/branches').set('Authorization', `Bearer ${scopeTenant.token}`).send({ name: 'Scope Branch A' });
      const bB = await request(app).post('/api/branches').set('Authorization', `Bearer ${scopeTenant.token}`).send({ name: 'Scope Branch B' });
      branchA = bA.body.item;
      branchB = bB.body.item;
      storeKeeperA = await createUserToken(scopeTenant.token, 'STORE_KEEPER', branchA.id);
      accountantA = await createUserToken(scopeTenant.token, 'ACCOUNTANT', branchA.id);
    });

    it('Warehouses: a branch-A STORE_KEEPER cannot list a branch-B warehouse in GET /api/warehouses', async () => {
      const whB = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${scopeTenant.token}`).send({ name: 'B Warehouse', branchId: branchB.id });
      const list = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${storeKeeperA.token}`);
      expect(list.status).toBe(200);
      expect(list.body.items.some((w) => w.id === whB.body.item.id)).toBe(false);
    });

    it('Warehouses: a branch-A STORE_KEEPER cannot adjust stock at a branch-B warehouse', async () => {
      const whB = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${scopeTenant.token}`).send({ name: 'B Warehouse 2', branchId: branchB.id });
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${scopeTenant.token}`).send({ name: 'Scope Product', sellingPrice: 5, purchasePrice: 2 });
      const res = await request(app)
        .post(`/api/warehouses/${whB.body.item.id}/adjust`)
        .set('Authorization', `Bearer ${storeKeeperA.token}`)
        .send({ productId: prod.body.item.id, quantity: 5, note: 'test' });
      expect(res.status).toBe(403);
    });

    it('Procurement: a branch-A STORE_KEEPER cannot see a branch-B purchase order', async () => {
      const supplier = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${scopeTenant.token}`).send({ name: 'Scope Supplier' });
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${scopeTenant.token}`).send({ name: 'Scope Product PO', sellingPrice: 5, purchasePrice: 2 });
      const po = await request(app)
        .post('/api/procurement/purchase-orders')
        .set('Authorization', `Bearer ${scopeTenant.token}`)
        .send({ supplierId: supplier.body.item.id, branchId: branchB.id, items: [{ productId: prod.body.item.id, quantity: 1, unitCost: 2 }] });
      const res = await request(app)
        .get(`/api/procurement/purchase-orders/${po.body.item.id}`)
        .set('Authorization', `Bearer ${storeKeeperA.token}`);
      expect(res.status).toBe(403);
    });

    it('Journal: a branch-A ACCOUNTANT cannot see a branch-B journal entry via the list endpoint', async () => {
      const accounts = await request(app).get('/api/accounting/accounts').set('Authorization', `Bearer ${scopeTenant.token}`);
      const cash = accounts.body.items.find((a) => a.type === 'ASSET');
      const equity = accounts.body.items.find((a) => a.type === 'EQUITY');
      const entry = await request(app)
        .post('/api/accounting/journal')
        .set('Authorization', `Bearer ${scopeTenant.token}`)
        .send({ branchId: branchB.id, memo: 'Scope test entry', lines: [{ accountId: cash.id, debit: 10 }, { accountId: equity.id, credit: 10 }] });
      const list = await request(app).get('/api/accounting/journal').set('Authorization', `Bearer ${accountantA.token}`);
      expect(list.status).toBe(200);
      expect(list.body.items.some((e) => e.id === entry.body.item.id)).toBe(false);
    });

    it('MANAGEMENT (unrestricted) still sees both branches\' data everywhere - branch-scope fixes do not affect unrestricted roles', async () => {
      const list = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${scopeTenant.token}`);
      expect(list.status).toBe(200);
      expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    });
  });
});
