// Phase 1.5 - Category, Brand & Unit Management tests.
//
// Same DB requirements as productArchitecture.test.js: point DATABASE_URL at
// a real, throwaway local Postgres database with all migrations applied
// (including 20260919100333_phase1_5_category_brand_unit_management) and the
// permission catalog seeded. NEVER point this at a database holding real
// tenant data.
//
// Category CRUD/isolation/permissions were already built and tested in
// earlier phases (permissionsArchitecture.test.js) - not duplicated here.
// This file covers what's genuinely new: subcategory hierarchy, the Brand
// and Unit of Measure catalogs, unit conversion references, and Product's
// new optional brandId/unitId links.
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

async function createUserToken(adminToken, role) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return { token: login.body.token, userId: created.body.item.id };
}

describe('Phase 1.5 - Category, Brand & Unit Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase15 Tenant A');
    tenantB = await registerTenant('Phase15 Tenant B');
  });

  describe('Subcategory / hierarchical categories', () => {
    let parent;

    beforeAll(async () => {
      const res = await request(app).post('/api/categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Eyewear' });
      parent = res.body.item;
    });

    it('a category can be created with a parentId', async () => {
      const res = await request(app).post('/api/categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Sunglasses', parentId: parent.id });
      expect(res.status).toBe(201);
      expect(res.body.item.parentId).toBe(parent.id);
    });

    it('GET /api/categories?parentId=X lists only that category\'s children', async () => {
      await request(app).post('/api/categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Reading Glasses', parentId: parent.id });
      const res = await request(app).get('/api/categories').set('Authorization', `Bearer ${tenantA.token}`).query({ parentId: parent.id, pageSize: 100 });
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(2);
      expect(res.body.items.every((c) => c.parentId === parent.id)).toBe(true);
    });

    it('a category cannot be set as its own parent', async () => {
      const res = await request(app).patch(`/api/categories/${parent.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ parentId: parent.id });
      expect(res.status).toBe(422);
    });

    it('a circular hierarchy (grandchild set as the root\'s parent) is rejected', async () => {
      const child = await request(app).post('/api/categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Circular Child', parentId: parent.id });
      const res = await request(app).patch(`/api/categories/${parent.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ parentId: child.body.item.id });
      expect(res.status).toBe(422);
    });

    it('a parentId belonging to another tenant is rejected', async () => {
      const otherTenantCategory = await request(app).post('/api/categories').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Category' });
      const res = await request(app).post('/api/categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cross-Tenant Attempt', parentId: otherTenantCategory.body.item.id });
      expect(res.status).toBe(404);
    });
  });

  describe('Brand catalog (new in Phase 1.5)', () => {
    it('a TENANT_ADMIN can create a brand', async () => {
      const res = await request(app).post('/api/brands').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Ray-Ban' });
      expect(res.status).toBe(201);
      expect(res.body.item.name).toBe('Ray-Ban');
      expect(res.body.item.isActive).toBe(true);
    });

    it('a duplicate brand name within the same tenant is rejected', async () => {
      await request(app).post('/api/brands').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Duplicate Brand' });
      const res = await request(app).post('/api/brands').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Duplicate Brand' });
      expect(res.status).toBe(409);
    });

    it('a STORE_KEEPER (INVENTORY_STAFF) can create a brand; a RECEPTIONIST cannot', async () => {
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const receptionist = await createUserToken(tenantA.token, 'RECEPTIONIST');
      const ok = await request(app).post('/api/brands').set('Authorization', `Bearer ${storeKeeper.token}`).send({ name: 'Store Keeper Brand' });
      expect(ok.status).toBe(201);
      const forbidden = await request(app).post('/api/brands').set('Authorization', `Bearer ${receptionist.token}`).send({ name: 'Receptionist Brand' });
      expect(forbidden.status).toBe(403);
    });

    it('a brand can be deactivated and reactivated', async () => {
      const created = await request(app).post('/api/brands').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Togglable Brand' });
      const deactivated = await request(app).delete(`/api/brands/${created.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(deactivated.body.item.isActive).toBe(false);
      const reactivated = await request(app).patch(`/api/brands/${created.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ isActive: true });
      expect(reactivated.body.item.isActive).toBe(true);
    });

    it('Tenant B cannot see or update Tenant A\'s brand', async () => {
      const created = await request(app).post('/api/brands').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation Brand' });
      const get = await request(app).get(`/api/brands/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);
    });

    it('the brand list shows a productCount reflecting products linked via brandId', async () => {
      const brand = await request(app).post('/api/brands').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Counted Brand' });
      await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Branded Product', brandId: brand.body.item.id, sellingPrice: 10 });
      const list = await request(app).get('/api/brands').set('Authorization', `Bearer ${tenantA.token}`);
      const found = list.body.items.find((b) => b.id === brand.body.item.id);
      expect(found.productCount).toBe(1);
    });
  });

  describe('Unit of Measure catalog (new in Phase 1.5)', () => {
    it('a unit can be created without any conversion relationship', async () => {
      const res = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Pieces', code: 'pcs' });
      expect(res.status).toBe(201);
      expect(res.body.item.baseUnitId).toBeNull();
    });

    it('a unit can declare a conversion relationship to a base unit', async () => {
      const pcs = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Pieces For Boxes' });
      const box = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Box', baseUnitId: pcs.body.item.id, conversionFactor: 12 });
      expect(box.status).toBe(201);
      expect(box.body.item.baseUnitId).toBe(pcs.body.item.id);
      expect(Number(box.body.item.conversionFactor)).toBe(12);
    });

    it('a conversionFactor is required when baseUnitId is set', async () => {
      const base = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Base Unit For Validation' });
      const res = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Missing Factor', baseUnitId: base.body.item.id });
      expect(res.status).toBe(422);
    });

    it('a unit cannot be set as its own base unit', async () => {
      const unit = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Self Base Attempt' });
      const res = await request(app).patch(`/api/units/${unit.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ baseUnitId: unit.body.item.id, conversionFactor: 1 });
      expect(res.status).toBe(422);
    });

    it('a circular unit conversion chain is rejected', async () => {
      const a = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Circular Unit A' });
      const b = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Circular Unit B', baseUnitId: a.body.item.id, conversionFactor: 2 });
      const res = await request(app).patch(`/api/units/${a.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ baseUnitId: b.body.item.id, conversionFactor: 0.5 });
      expect(res.status).toBe(422);
    });

    it('a baseUnitId belonging to another tenant is rejected', async () => {
      const otherUnit = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Unit' });
      const res = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cross-Tenant Unit Attempt', baseUnitId: otherUnit.body.item.id, conversionFactor: 1 });
      expect(res.status).toBe(404);
    });

    it('Tenant B cannot see Tenant A\'s unit', async () => {
      const created = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation Unit' });
      const get = await request(app).get(`/api/units/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);
    });
  });

  describe('Product compatibility with the new Brand/Unit catalogs', () => {
    it('a product can be created with brandId/unitId while keeping the free-text brand/unit fields fully independent', async () => {
      const brand = await request(app).post('/api/brands').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Compat Brand' });
      const unit = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Compat Unit' });
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Structured Product', brand: 'Free Text Brand', brandId: brand.body.item.id, unit: 'custom-unit-string', unitId: unit.body.item.id, sellingPrice: 10 });
      expect(res.status).toBe(201);
      expect(res.body.item.brand).toBe('Free Text Brand');
      expect(res.body.item.brandId).toBe(brand.body.item.id);
      expect(res.body.item.unit).toBe('custom-unit-string');
      expect(res.body.item.unitId).toBe(unit.body.item.id);
    });

    it('a product created with only the legacy free-text brand/unit strings (no catalog reference) still works exactly as before', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Legacy-Style Product', brand: 'Untracked Brand', unit: 'kg', sellingPrice: 5 });
      expect(res.status).toBe(201);
      expect(res.body.item.brandId).toBeNull();
      expect(res.body.item.unitId).toBeNull();
    });

    it('a brandId belonging to another tenant is rejected on product create', async () => {
      const otherBrand = await request(app).post('/api/brands').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Brand' });
      const res = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cross-Tenant Brand Attempt', brandId: otherBrand.body.item.id, sellingPrice: 1 });
      expect(res.status).toBe(404);
    });

    it('a unitId belonging to another tenant is rejected on product update', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Update Target Product', sellingPrice: 1 });
      const otherUnit = await request(app).post('/api/units').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Update Unit' });
      const res = await request(app).patch(`/api/products/${product.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ unitId: otherUnit.body.item.id });
      expect(res.status).toBe(404);
    });
  });

  describe('Existing Optical/Medical Category usage is unaffected by hierarchy support', () => {
    it('a flat (no-parent) category still behaves exactly as before', async () => {
      const res = await request(app).post('/api/categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Flat Category' });
      expect(res.status).toBe(201);
      expect(res.body.item.parentId).toBeNull();
    });
  });
});
