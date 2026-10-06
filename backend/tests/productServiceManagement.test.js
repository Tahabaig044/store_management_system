// Phase 1.4 - Product & Service Management tests.
//
// Same DB requirements as productArchitecture.test.js: point DATABASE_URL at
// a real, throwaway local Postgres database with all migrations applied
// (including 20260917120000_phase0_2_universal_product_architecture) and the
// permission catalog seeded. NEVER point this at a database holding real
// tenant data.
//
// This phase's genuine new surface is Product Variants - a Core Product
// entity declared in moduleRegistry.js since Phase 0.2 but with zero routes
// until now - plus a productKind list filter, and explicit verification that
// the Core Product model stays industry-neutral for new universal usage and
// that the Phase 0.2 legacy-data backfill script still works correctly.
// Everything else (Product CRUD, dual-write to industry extensions, tenant
// isolation on extensions) was already built and tested in Phase 0.2 - see
// productArchitecture.test.js, not duplicated here.
const request = require('supertest');
const { execSync } = require('child_process');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

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

describe('Phase 1.4 - Product & Service Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase14 Tenant A');
    tenantB = await registerTenant('Phase14 Tenant B');
  });

  describe('Core Product model stays industry-neutral for new universal usage', () => {
    it('creating a SERVICE product touches zero Optical/Medicine data', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Eye Exam Consultation', productKind: 'SERVICE', sellingPrice: 50 });
      expect(res.status).toBe(201);
      expect(res.body.item.productKind).toBe('SERVICE');
      expect(res.body.item.opticalAttributes).toBeNull();
      expect(res.body.item.medicineAttributes).toBeNull();
      // legacy columns are still present on the row (Phase 0.2 ADR-3) but
      // must remain unpopulated for a product that never supplied them.
      expect(res.body.item.frameBrand).toBeNull();
      expect(res.body.item.batchNumber).toBeNull();
    });

    it('creating a GENERAL physical good with only universal fields touches zero Optical/Medicine data', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Generic Widget', brand: 'Acme', sellingPrice: 10, purchasePrice: 5 });
      expect(res.status).toBe(201);
      expect(res.body.item.opticalAttributes).toBeNull();
      expect(res.body.item.medicineAttributes).toBeNull();
    });

    it('a Service product is excluded from low-stock filtering semantics (no meaningful stock concept)', async () => {
      const svc = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Repair Service', productKind: 'SERVICE', sellingPrice: 20 });
      expect(Number(svc.body.item.stockQuantity)).toBe(0);
    });
  });

  describe('productKind filter', () => {
    it('GET /api/products?productKind=SERVICE returns only services', async () => {
      const res = await request(app).get('/api/products').set('Authorization', `Bearer ${tenantA.token}`).query({ productKind: 'SERVICE', pageSize: 100 });
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((p) => p.productKind === 'SERVICE')).toBe(true);
    });

    it('GET /api/products?productKind=PHYSICAL_GOOD excludes services', async () => {
      const res = await request(app).get('/api/products').set('Authorization', `Bearer ${tenantA.token}`).query({ productKind: 'PHYSICAL_GOOD', pageSize: 100 });
      expect(res.body.items.every((p) => p.productKind === 'PHYSICAL_GOOD')).toBe(true);
    });
  });

  describe('Product Variants (new in Phase 1.4)', () => {
    let product;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Variant Parent Product', sellingPrice: 15, purchasePrice: 8 });
      product = res.body.item;
    });

    it('a new product has no variants', async () => {
      const res = await request(app).get(`/api/products/${product.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('a STORE_KEEPER (has PRODUCT:CREATE) can create a variant', async () => {
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const res = await request(app)
        .post(`/api/products/${product.id}/variants`)
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ name: 'Large', sku: 'VAR-L', priceOverride: 18, stockQuantity: 5 });
      expect(res.status).toBe(201);
      expect(res.body.item.name).toBe('Large');
      expect(res.body.item.productId).toBe(product.id);
    });

    it('a CASHIER (no PRODUCT:CREATE) cannot create a variant', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app)
        .post(`/api/products/${product.id}/variants`)
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ name: 'Small' });
      expect(res.status).toBe(403);
    });

    it('a variant can be updated', async () => {
      const created = await request(app).post(`/api/products/${product.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Medium' });
      const res = await request(app)
        .patch(`/api/products/${product.id}/variants/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ priceOverride: 22 });
      expect(res.status).toBe(200);
      expect(Number(res.body.item.priceOverride)).toBe(22);
    });

    it('a duplicate variant barcode within the same tenant is rejected', async () => {
      await request(app).post(`/api/products/${product.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Barcoded One', barcode: 'DUPVAR1' });
      const res = await request(app).post(`/api/products/${product.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Barcoded Two', barcode: 'DUPVAR1' });
      expect(res.status).toBe(409);
    });

    it('archiving a variant sets isActive: false rather than deleting it', async () => {
      const created = await request(app).post(`/api/products/${product.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'To Archive' });
      const res = await request(app).delete(`/api/products/${product.id}/variants/${created.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.item.isActive).toBe(false);
    });

    it('Tenant B cannot list, create, or update variants under Tenant A\'s product', async () => {
      const list = await request(app).get(`/api/products/${product.id}/variants`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(list.status).toBe(404);
      const create = await request(app).post(`/api/products/${product.id}/variants`).set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Intruder' });
      expect(create.status).toBe(404);
    });

    it('a variant id that does not belong to the given product 404s even if it belongs to another product of the SAME tenant', async () => {
      const otherProduct = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Other Product', sellingPrice: 5 });
      const variantOfOther = await request(app).post(`/api/products/${otherProduct.body.item.id}/variants`).set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Belongs Elsewhere' });
      const res = await request(app)
        .patch(`/api/products/${product.id}/variants/${variantOfOther.body.item.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Hijacked' });
      expect(res.status).toBe(404);
    });
  });

  describe('Phase 0.2 legacy-data migration/backfill remains intact', () => {
    it('backfillProductExtensions.js correctly creates extensions for products written directly to legacy columns (simulating pre-Phase-0.2 data)', async () => {
      // Bypasses the API entirely to simulate a row that predates Phase 0.2's
      // dual-write logic - written with only the legacy `type`/frame*/lens*/
      // batch fields, no extension row, exactly like real pre-migration data.
      const legacyFrame = await prisma.product.create({
        data: {
          tenantId: tenantA.tenantId,
          name: 'Legacy Frame Product',
          type: 'FRAME',
          frameBrand: 'Ray-Ban',
          frameColor: 'Black',
          sellingPrice: 100,
        },
      });
      const legacyMedicine = await prisma.product.create({
        data: {
          tenantId: tenantA.tenantId,
          name: 'Legacy Medicine Product',
          type: 'MEDICINE',
          batchNumber: 'BATCH-001',
          expiryDate: new Date('2027-01-01'),
          sellingPrice: 20,
        },
      });

      const before = await prisma.productOpticalAttributes.findUnique({ where: { productId: legacyFrame.id } });
      expect(before).toBeNull();

      execSync('node prisma/backfillProductExtensions.js', {
        cwd: require('path').join(__dirname, '..'),
        env: { ...process.env },
        stdio: 'pipe',
      });

      const opticalExt = await prisma.productOpticalAttributes.findUnique({ where: { productId: legacyFrame.id } });
      expect(opticalExt).not.toBeNull();
      expect(opticalExt.opticalKind).toBe('FRAME');
      expect(opticalExt.frameBrand).toBe('Ray-Ban');

      const medicineExt = await prisma.productMedicineAttributes.findUnique({ where: { productId: legacyMedicine.id } });
      expect(medicineExt).not.toBeNull();
      expect(medicineExt.batchNumber).toBe('BATCH-001');

      // Never modifies, deletes, or overwrites the legacy Product columns -
      // only ever reads them and writes to the new extension tables.
      const productAfter = await prisma.product.findUnique({ where: { id: legacyFrame.id } });
      expect(productAfter.frameBrand).toBe('Ray-Ban');
      expect(productAfter.type).toBe('FRAME');
    });
  });

  describe('Company/branch/warehouse compatibility (Product remains a pure tenant-scoped master record)', () => {
    it('the same product can carry independent stock levels at two different warehouses across branches', async () => {
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Multi-Warehouse Product', sellingPrice: 30, purchasePrice: 15 });
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Product Compat Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Product Compat Branch 2' });
      const wh1 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Compat WH1', branchId: branch1.body.item.id });
      const wh2 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Compat WH2', branchId: branch2.body.item.id });

      await request(app).post(`/api/warehouses/${wh1.body.item.id}/receive`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId: product.body.item.id, quantity: 10 });
      await request(app).post(`/api/warehouses/${wh2.body.item.id}/receive`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId: product.body.item.id, quantity: 4 });

      const stock1 = await request(app).get(`/api/warehouses/${wh1.body.item.id}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      const stock2 = await request(app).get(`/api/warehouses/${wh2.body.item.id}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      const item1 = stock1.body.items.find((i) => i.productId === product.body.item.id);
      const item2 = stock2.body.items.find((i) => i.productId === product.body.item.id);
      expect(item1.quantity).toBe(10);
      expect(item2.quantity).toBe(4);
    });
  });
});
