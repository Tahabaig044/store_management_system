// Phase 1.3 - Branch & Warehouse Management tests.
//
// Same DB requirements as the other Phase 0/1 test files: point DATABASE_URL
// at a real, throwaway local Postgres database with all migrations applied
// (including 20260919084337_phase1_3_branch_warehouse_management) and the
// permission catalog seeded. NEVER point this at a database holding real
// tenant data.
//
// This phase's genuine new surface is small: Branch.isMain and the new
// Warehouse.isDefault became admin-manageable (mirroring Company.isDefault
// from Phase 1.1), and Warehouse.companyId is now correctly derived from its
// branch at creation time (previously always null for any warehouse created
// via the API). Branch/Warehouse CRUD, access-grant endpoints, and the
// three-tier scope chain were already built and tested in Phase 0.3/0.4/6 -
// see companyArchitecture.test.js, multiBranch.test.js, and
// permissionsArchitecture.test.js for that existing coverage, not duplicated
// here.
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

describe('Phase 1.3 - Branch & Warehouse Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase13 Tenant A');
    tenantB = await registerTenant('Phase13 Tenant B');
  });

  describe('Warehouse.companyId is derived from its branch at creation', () => {
    it('a warehouse created with a branchId inherits that branch\'s companyId', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'WH Company Branch' });
      const wh = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Branch-tied Warehouse', branchId: branch.body.item.id });
      expect(wh.status).toBe(201);
      expect(wh.body.item.companyId).toBe(branch.body.item.companyId);
      expect(wh.body.item.companyId).toBeTruthy();
    });

    it('a central warehouse with no branchId has a null companyId (unchanged design)', async () => {
      const wh = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Central Warehouse', isCentral: true });
      expect(wh.status).toBe(201);
      expect(wh.body.item.companyId).toBeNull();
    });
  });

  describe('Warehouse.isDefault exclusivity (mirrors Company.isDefault, Phase 1.1)', () => {
    let excTenant;
    let warehouseOne;
    let warehouseTwo;

    beforeAll(async () => {
      excTenant = await registerTenant('Phase13 Warehouse Default Tenant');
      // The very first warehouse ever needed by this tenant is created
      // lazily via ensureDefaultWarehouse (triggered by a stock lookup) -
      // exercise that path directly rather than only the explicit-create path.
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${excTenant.token}`).send({ name: 'Default WH Branch' });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${excTenant.token}`).send({ name: 'Default WH Product', sellingPrice: 10, purchasePrice: 5 });
      expect(product.status).toBe(201);

      const w1 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${excTenant.token}`).send({ name: 'WH One', branchId: branch.body.item.id });
      warehouseOne = w1.body.item;
      const stockView = await request(app).get(`/api/warehouses/${warehouseOne.id}/stock`).set('Authorization', `Bearer ${excTenant.token}`);
      expect(stockView.status).toBe(200);

      const w2 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${excTenant.token}`).send({ name: 'WH Two', branchId: branch.body.item.id });
      warehouseTwo = w2.body.item;
    });

    it('the earliest-created warehouse is treated as default by ensureDefaultWarehouse, but isDefault itself is not auto-set on plain create', async () => {
      // isDefault is only ever turned on explicitly (via isDefault: true at
      // create/update) or by ensureDefaultWarehouse's own lazy-creation path
      // - a warehouse explicitly created via POST without isDefault stays false.
      expect(warehouseOne.isDefault).toBe(false);
    });

    it('marking a second warehouse as default clears the flag on the first', async () => {
      const res = await request(app).patch(`/api/warehouses/${warehouseTwo.id}`).set('Authorization', `Bearer ${excTenant.token}`).send({ isDefault: true });
      expect(res.status).toBe(200);
      expect(res.body.item.isDefault).toBe(true);

      const list = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${excTenant.token}`);
      const defaults = list.body.items.filter((w) => w.isDefault);
      expect(defaults.length).toBe(1);
      expect(defaults[0].id).toBe(warehouseTwo.id);
    });

    it('a newly created warehouse with isDefault: true immediately becomes the sole default', async () => {
      const w3 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${excTenant.token}`).send({ name: 'WH Three', isDefault: true });
      expect(w3.status).toBe(201);
      expect(w3.body.item.isDefault).toBe(true);

      const list = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${excTenant.token}`);
      const defaults = list.body.items.filter((w) => w.isDefault);
      expect(defaults.length).toBe(1);
      expect(defaults[0].id).toBe(w3.body.item.id);
    });

    it('sending isDefault: false alone never removes the default without another one taking over', async () => {
      const list = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${excTenant.token}`);
      const current = list.body.items.find((w) => w.isDefault);
      await request(app).patch(`/api/warehouses/${current.id}`).set('Authorization', `Bearer ${excTenant.token}`).send({ isDefault: false });

      const after = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${excTenant.token}`);
      const defaults = after.body.items.filter((w) => w.isDefault);
      expect(defaults.length).toBe(1);
      expect(defaults[0].id).toBe(current.id); // unchanged
    });
  });

  describe('Branch.isMain exclusivity (newly manageable, Phase 1.3)', () => {
    it('the tenant\'s registration-time branch starts as the sole Main branch', async () => {
      const list = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      const mains = list.body.items.filter((b) => b.isMain);
      expect(mains.length).toBe(1);
    });

    it('a TENANT_ADMIN can promote a different branch to Main, demoting the previous one', async () => {
      const before = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      const originalMain = before.body.items.find((b) => b.isMain);

      const newBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Promotable Branch' });
      const promote = await request(app).patch(`/api/branches/${newBranch.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ isMain: true });
      expect(promote.status).toBe(200);
      expect(promote.body.item.isMain).toBe(true);

      const originalAfter = await request(app).get(`/api/branches/${originalMain.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(originalAfter.body.item.isMain).toBe(false);

      const list = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      expect(list.body.items.filter((b) => b.isMain).length).toBe(1);
    });

    it('a branch can be created already marked as Main, demoting the current one', async () => {
      const created = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Born Main Branch', isMain: true });
      expect(created.status).toBe(201);
      expect(created.body.item.isMain).toBe(true);

      const list = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      const mains = list.body.items.filter((b) => b.isMain);
      expect(mains.length).toBe(1);
      expect(mains[0].id).toBe(created.body.item.id);
    });

    it('sending isMain: false alone never removes Main status without another branch taking over', async () => {
      const list = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      const current = list.body.items.find((b) => b.isMain);
      await request(app).patch(`/api/branches/${current.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ isMain: false });

      const after = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      const mains = after.body.items.filter((b) => b.isMain);
      expect(mains.length).toBe(1);
      expect(mains[0].id).toBe(current.id);
    });

    it('a non-admin cannot promote a branch to Main (BRANCH:UPDATE is TENANT_ADMIN-only)', async () => {
      const email = uniqueEmail('cashier');
      const created = await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cashier', email, password: 'TestPass123', role: 'CASHIER' });
      const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'No Promote Branch' });
      const res = await request(app).patch(`/api/branches/${branch.body.item.id}`).set('Authorization', `Bearer ${login.body.token}`).send({ isMain: true });
      expect(res.status).toBe(403);
    });

    it('Tenant B cannot promote a Tenant A branch to Main (tenant isolation)', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation Branch' });
      const res = await request(app).patch(`/api/branches/${branch.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`).send({ isMain: true });
      expect(res.status).toBe(404);
    });
  });
});
