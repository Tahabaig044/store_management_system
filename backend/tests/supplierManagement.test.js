// Phase 1.7 - Supplier Management tests.
//
// Same DB requirements as customerManagement.test.js: point DATABASE_URL at
// a real, throwaway local Postgres database with all migrations applied
// (including 20260921000000_phase1_7_supplier_management) and the
// permission catalog seeded. NEVER point this at a database holding real
// tenant data.
//
// Supplier CRUD, search, permissions, and tenant isolation were already
// built and tested in earlier phases (business.test.js,
// permissionsArchitecture.test.js) - not duplicated here. This file mirrors
// customerManagement.test.js's shape for what's genuinely new in Phase 1.7:
// the code/notes fields and the non-blocking duplicate-identity check,
// mirroring Customer (Phase 1.6) field-for-field, plus verification that
// Supplier stays industry-neutral and remains compatible with the
// existing Purchase/Payable workflow and the pre-existing offline outbox.
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

describe('Phase 1.7 - Supplier Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase17 Tenant A');
    tenantB = await registerTenant('Phase17 Tenant B');
  });

  describe('Supplier code and notes (new in Phase 1.7)', () => {
    it('a supplier can be created with a code and notes', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Coded Supplier', code: 'SUP-001', notes: 'Net 30 payment terms.' });
      expect(res.status).toBe(201);
      expect(res.body.item.code).toBe('SUP-001');
      expect(res.body.item.notes).toBe('Net 30 payment terms.');
    });

    it('a supplier created with no code/notes still works exactly as before (fully backward compatible)', async () => {
      const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Plain Supplier' });
      expect(res.status).toBe(201);
      expect(res.body.item.code).toBeNull();
      expect(res.body.item.notes).toBeNull();
    });

    it('two suppliers in the same tenant cannot share the same code', async () => {
      await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'First', code: 'DUPE-CODE' });
      const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Second', code: 'DUPE-CODE' });
      expect(res.status).toBe(409);
    });

    it('two DIFFERENT tenants CAN use the same code (uniqueness is per-tenant, not global)', async () => {
      const a = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Tenant A Shared Code', code: 'SHARED-001' });
      const b = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Shared Code', code: 'SHARED-001' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });

    it('multiple suppliers with no code at all is never a conflict', async () => {
      const one = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'No Code One' });
      const two = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'No Code Two' });
      expect(one.status).toBe(201);
      expect(two.status).toBe(201);
    });

    it('the code field is searchable', async () => {
      await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Searchable By Code', code: 'FINDME-42' });
      const res = await request(app).get('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).query({ search: 'FINDME-42' });
      expect(res.body.items.some((s) => s.code === 'FINDME-42')).toBe(true);
    });

    it('notes can be updated independently of other fields', async () => {
      const created = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Note Target' });
      const res = await request(app).patch(`/api/suppliers/${created.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ notes: 'Slow to respond to emails.' });
      expect(res.status).toBe(200);
      expect(res.body.item.notes).toBe('Slow to respond to emails.');
      expect(res.body.item.name).toBe('Note Target');
    });
  });

  describe('Non-blocking duplicate-identity check (new in Phase 1.7)', () => {
    it('creating a supplier with a phone matching an existing active supplier succeeds AND flags the possible duplicate', async () => {
      await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Original Phone Owner', phone: '021-1112222' });
      const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'New Vendor Same Phone', phone: '021-1112222' });
      expect(res.status).toBe(201); // never blocked
      expect(res.body.possibleDuplicate).not.toBeNull();
      expect(res.body.possibleDuplicate.name).toBe('Original Phone Owner');
    });

    it('creating a supplier with a phone matching a DEACTIVATED supplier does not flag a duplicate', async () => {
      const original = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Will Be Deactivated', phone: '021-9998888' });
      await request(app).delete(`/api/suppliers/${original.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Fresh Vendor', phone: '021-9998888' });
      expect(res.status).toBe(201);
      expect(res.body.possibleDuplicate).toBeNull();
    });

    it('no phone or email means no duplicate check is even attempted', async () => {
      const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'No Contact Info' });
      expect(res.status).toBe(201);
      expect(res.body.possibleDuplicate).toBeNull();
    });

    it('a matching phone/email in a DIFFERENT tenant never triggers a cross-tenant duplicate flag', async () => {
      await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Vendor', phone: '021-5551234' });
      const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Tenant A Vendor', phone: '021-5551234' });
      expect(res.status).toBe(201);
      expect(res.body.possibleDuplicate).toBeNull();
    });
  });

  describe('Universal architecture: Supplier stays industry-neutral', () => {
    it('creating a supplier never accepts or requires any industry-specific field', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Not Industry Specific', frameBrand: 'Ray-Ban', batchNumber: 'BATCH-1', licenseNumber: 'PHARM-123' });
      expect(res.status).toBe(201);
      expect(res.body.item.frameBrand).toBeUndefined();
      expect(res.body.item.batchNumber).toBeUndefined();
      expect(res.body.item.licenseNumber).toBeUndefined();
    });
  });

  describe('Supplier/Purchase/Payable compatibility (Supplier remains tenant-wide master data)', () => {
    it('a tenant-wide supplier can be used in purchases at two different branches, and the ledger aggregates correctly', async () => {
      const supplier = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Multi-Branch Supplier' });
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Supplier Compat Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Supplier Compat Branch 2' });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Compat Purchase Product', sellingPrice: 10, purchasePrice: 5 });

      const purchase1 = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId: supplier.body.item.id, branchId: branch1.body.item.id, items: [{ productId: product.body.item.id, quantity: 2, unitCost: 5 }], receiveImmediately: true, paymentMethod: 'cash', amountPaid: 10 });
      const purchase2 = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ supplierId: supplier.body.item.id, branchId: branch2.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitCost: 5 }], receiveImmediately: true, paymentMethod: 'cash', amountPaid: 5 });
      expect(purchase1.status).toBe(201);
      expect(purchase2.status).toBe(201);
      expect(purchase1.body.item.branchId).toBe(branch1.body.item.id);
      expect(purchase2.body.item.branchId).toBe(branch2.body.item.id);

      const ledger = await request(app).get(`/api/suppliers/${supplier.body.item.id}/ledger`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(ledger.body.purchases.length).toBe(2);
      expect(ledger.body.balanceDue).toBe(0);
    });
  });

  describe('Tenant isolation (re-verified for the new fields)', () => {
    it('Tenant B cannot view or update Tenant A\'s supplier, including its code/notes', async () => {
      const created = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation Target', code: 'ISO-1', notes: 'secret note' });
      const get = await request(app).get(`/api/suppliers/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);
      const update = await request(app).patch(`/api/suppliers/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`).send({ notes: 'hijacked' });
      expect(update.status).toBe(404);
    });
  });

  describe('Permission enforcement (re-verified, unchanged SUPPLIER resource)', () => {
    it('a RECEPTIONIST (CONTACTS_STAFF) can view suppliers but not create one (SUPPLIER:CREATE is INVENTORY_STAFF-only)', async () => {
      const receptionist = await createUserToken(tenantA.token, 'RECEPTIONIST');
      const view = await request(app).get('/api/suppliers').set('Authorization', `Bearer ${receptionist.token}`);
      expect(view.status).toBe(200);
      const create = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${receptionist.token}`).send({ name: 'Should Fail' });
      expect(create.status).toBe(403);
    });

    it('a STORE_KEEPER (INVENTORY_STAFF) can create a supplier', async () => {
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${storeKeeper.token}`).send({ name: 'Store Keeper Created Supplier' });
      expect(res.status).toBe(201);
    });
  });
});
