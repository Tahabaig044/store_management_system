// Phase 0.2 Universal Product Architecture tests.
//
// Same DB requirements as business.test.js: point DATABASE_URL at a real,
// throwaway local Postgres database with migrations applied (including the
// hand-authored 20260917120000_phase0_2_universal_product_architecture
// migration - see docs/phase0-2-migration-api-compatibility-plan.md). NEVER
// point this at a database holding real tenant data.
//
// NOTE: these tests were written before `npx prisma generate` / `migrate
// dev` could be run in the authoring session (blocked by sandbox
// permissions - see the Phase 0.2 implementation report). They have not
// been executed yet. They should be run, and fixed if anything doesn't
// match actual behavior, as part of closing out this phase.
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

describe('Phase 0.2 - Universal Product Architecture', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase02 Tenant A');
    tenantB = await registerTenant('Phase02 Tenant B');
  });

  describe('Legacy compatibility (Acceptance Criteria: existing records/behavior unchanged)', () => {
    it('creating a product with only legacy fields (no productKind/brand) still succeeds, exactly like today', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ type: 'GENERAL', name: 'Legacy Widget', sellingPrice: 10, purchasePrice: 5 });
      expect(res.status).toBe(201);
      expect(res.body.item.type).toBe('GENERAL');
    });

    it('a legacy FRAME product is backfilled into productKind=PHYSICAL_GOOD and an opticalAttributes extension with opticalKind=FRAME', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          type: 'FRAME',
          name: 'Ray-Style Frame',
          sellingPrice: 50,
          purchasePrice: 20,
          frameBrand: 'Acme',
          frameColor: 'Black',
        });
      expect(res.status).toBe(201);
      expect(res.body.item.type).toBe('FRAME');
      expect(res.body.item.productKind).toBe('PHYSICAL_GOOD');
      expect(res.body.item.frameBrand).toBe('Acme');
      expect(res.body.item.opticalAttributes).toBeTruthy();
      expect(res.body.item.opticalAttributes.opticalKind).toBe('FRAME');
      expect(res.body.item.opticalAttributes.frameBrand).toBe('Acme');
      expect(res.body.item.opticalAttributes.frameColor).toBe('Black');
    });

    it('a legacy LENS product gets opticalKind=LENS', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ type: 'LENS', name: 'Progressive Lens', sellingPrice: 80, purchasePrice: 30, lensType: 'Progressive' });
      expect(res.status).toBe(201);
      expect(res.body.item.opticalAttributes.opticalKind).toBe('LENS');
      expect(res.body.item.opticalAttributes.lensType).toBe('Progressive');
    });

    it('a legacy MEDICINE product gets a medicineAttributes extension, not an opticalAttributes one', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({
          type: 'MEDICINE',
          name: 'Test Tablet',
          sellingPrice: 5,
          purchasePrice: 2,
          batchNumber: 'BATCH-001',
          expiryDate: '2027-01-01',
        });
      expect(res.status).toBe(201);
      expect(res.body.item.medicineAttributes).toBeTruthy();
      expect(res.body.item.medicineAttributes.batchNumber).toBe('BATCH-001');
      expect(res.body.item.opticalAttributes).toBeFalsy();
    });

    it('updating an existing FRAME product\'s frameColor also updates the opticalAttributes extension (ongoing dual-write, not just one-time backfill)', async () => {
      const created = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ type: 'FRAME', name: 'Updatable Frame', sellingPrice: 40, purchasePrice: 15, frameColor: 'Red' });
      const patch = await request(app)
        .patch(`/api/products/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ frameColor: 'Blue' });
      expect(patch.status).toBe(200);
      expect(patch.body.item.frameColor).toBe('Blue');
      expect(patch.body.item.opticalAttributes.frameColor).toBe('Blue');
    });
  });

  describe('New universal capability (Acceptance Criteria: generic business, no Optical/Medical fields)', () => {
    it('creating a product with productKind=SERVICE and no type-specific fields succeeds and has no industry extensions', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Consultation', productKind: 'SERVICE', sellingPrice: 100, purchasePrice: 0 });
      expect(res.status).toBe(201);
      expect(res.body.item.productKind).toBe('SERVICE');
      expect(res.body.item.opticalAttributes).toBeFalsy();
      expect(res.body.item.medicineAttributes).toBeFalsy();
    });

    it('creating a GENERAL product with a universal brand field succeeds (no Optical/Medical fields required)', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Generic Retail Item', productKind: 'PHYSICAL_GOOD', brand: 'Acme Retail', sellingPrice: 25, purchasePrice: 10 });
      expect(res.status).toBe(201);
      expect(res.body.item.brand).toBe('Acme Retail');
      expect(res.body.item.opticalAttributes).toBeFalsy();
      expect(res.body.item.medicineAttributes).toBeFalsy();
    });
  });

  describe('Security - tenant isolation on the new extension tables', () => {
    it('Tenant B cannot see Tenant A\'s optical/medicine extension data by reading Tenant A\'s product id', async () => {
      const created = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ type: 'FRAME', name: 'Tenant A Secret Frame', sellingPrice: 60, purchasePrice: 25, frameBrand: 'SecretBrand' });

      const crossTenantRead = await request(app)
        .get(`/api/products/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantB.token}`);
      expect(crossTenantRead.status).toBe(404);
    });
  });
});
