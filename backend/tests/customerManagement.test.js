// Phase 1.6 - Customer Management tests.
//
// Same DB requirements as the other Phase 0/1 test files: point DATABASE_URL
// at a real, throwaway local Postgres database with all migrations applied
// (including 20260919110000_phase1_6_customer_management) and the
// permission catalog seeded. NEVER point this at a database holding real
// tenant data.
//
// Customer CRUD, search, permissions, and tenant isolation were already
// built and tested in earlier phases (business.test.js,
// permissionsArchitecture.test.js) - not duplicated here. This file covers
// what's genuinely new in Phase 1.6: the code/notes fields, the non-blocking
// duplicate-identity check, and an explicit, direct verification that the
// universal Customer model and the clinical Patient extension remain
// correctly separated.
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

describe('Phase 1.6 - Customer Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase16 Tenant A');
    tenantB = await registerTenant('Phase16 Tenant B');
  });

  describe('Customer code and notes (new in Phase 1.6)', () => {
    it('a customer can be created with a code and notes', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Coded Customer', code: 'CUST-001', notes: 'Prefers WhatsApp contact.' });
      expect(res.status).toBe(201);
      expect(res.body.item.code).toBe('CUST-001');
      expect(res.body.item.notes).toBe('Prefers WhatsApp contact.');
    });

    it('a customer created with no code/notes still works exactly as before (fully backward compatible)', async () => {
      const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Plain Customer' });
      expect(res.status).toBe(201);
      expect(res.body.item.code).toBeNull();
      expect(res.body.item.notes).toBeNull();
    });

    it('two customers in the same tenant cannot share the same code', async () => {
      await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'First', code: 'DUPE-CODE' });
      const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Second', code: 'DUPE-CODE' });
      expect(res.status).toBe(409);
    });

    it('two DIFFERENT tenants CAN use the same code (uniqueness is per-tenant, not global)', async () => {
      const a = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Tenant A Shared Code', code: 'SHARED-001' });
      const b = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Shared Code', code: 'SHARED-001' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });

    it('multiple customers with no code at all is never a conflict', async () => {
      const one = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'No Code One' });
      const two = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'No Code Two' });
      expect(one.status).toBe(201);
      expect(two.status).toBe(201);
    });

    it('the code field is searchable', async () => {
      await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Searchable By Code', code: 'FINDME-42' });
      const res = await request(app).get('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).query({ search: 'FINDME-42' });
      expect(res.body.items.some((c) => c.code === 'FINDME-42')).toBe(true);
    });

    it('notes can be updated independently of other fields', async () => {
      const created = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Note Target' });
      const res = await request(app).patch(`/api/customers/${created.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`).send({ notes: 'Called back, no answer.' });
      expect(res.status).toBe(200);
      expect(res.body.item.notes).toBe('Called back, no answer.');
      expect(res.body.item.name).toBe('Note Target');
    });
  });

  describe('Non-blocking duplicate-identity check (new in Phase 1.6)', () => {
    it('creating a customer with a phone matching an existing active customer succeeds AND flags the possible duplicate', async () => {
      await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Original Phone Owner', phone: '0300-1112222' });
      const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'New Person Same Phone', phone: '0300-1112222' });
      expect(res.status).toBe(201); // never blocked
      expect(res.body.possibleDuplicate).not.toBeNull();
      expect(res.body.possibleDuplicate.name).toBe('Original Phone Owner');
    });

    it('creating a customer with a phone matching a DEACTIVATED customer does not flag a duplicate', async () => {
      const original = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Will Be Deactivated', phone: '0300-9998888' });
      await request(app).delete(`/api/customers/${original.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Fresh Owner', phone: '0300-9998888' });
      expect(res.status).toBe(201);
      expect(res.body.possibleDuplicate).toBeNull();
    });

    it('no phone or email means no duplicate check is even attempted', async () => {
      const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'No Contact Info' });
      expect(res.status).toBe(201);
      expect(res.body.possibleDuplicate).toBeNull();
    });

    it('a matching phone/email in a DIFFERENT tenant never triggers a cross-tenant duplicate flag', async () => {
      await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Person', phone: '0300-5551234' });
      const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Tenant A Person', phone: '0300-5551234' });
      expect(res.status).toBe(201);
      expect(res.body.possibleDuplicate).toBeNull();
    });
  });

  describe('Universal Customer vs clinical Patient separation (explicit verification)', () => {
    it('creating a Customer never accepts or requires any Patient-specific field', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Not A Patient Yet', dateOfBirth: '1990-01-01', bloodGroup: 'O+', allergies: 'Penicillin', medicalHistory: 'None' });
      expect(res.status).toBe(201);
      // The Customer model has no such columns - Zod's schema silently drops
      // unknown keys, so the created row (and the response) never carries them.
      expect(res.body.item.dateOfBirth).toBeUndefined();
      expect(res.body.item.bloodGroup).toBeUndefined();
      expect(res.body.item.allergies).toBeUndefined();
      expect(res.body.item.medicalHistory).toBeUndefined();
    });

    it('a Customer with no Patient profile is a completely valid, ordinary customer (Optical clinical activation is opt-in, not automatic)', async () => {
      const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Retail Only Customer' });
      const fetched = await request(app).get(`/api/customers/${res.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.item.patient).toBeUndefined(); // GET /customers/:id never includes the Patient relation
    });

    it('the customer list endpoint never leaks clinical data even for customers who DO have a Patient profile', async () => {
      const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Clinically Active Customer' });
      const patient = await request(app)
        .post('/api/patients')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customer.body.item.id, bloodGroup: 'AB+', allergies: 'Latex' });
      expect(patient.status).toBe(201);

      const list = await request(app).get('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).query({ search: 'Clinically Active Customer' });
      const found = list.body.items.find((c) => c.id === customer.body.item.id);
      expect(found).toBeDefined();
      expect(found.bloodGroup).toBeUndefined();
      expect(found.allergies).toBeUndefined();
      expect(found.patient).toBeUndefined();
    });
  });

  describe('Customer/company/branch relationship compatibility (Customer remains tenant-wide master data)', () => {
    it('a tenant-wide customer can transact at two different branches, and each sale correctly records its own branch', async () => {
      const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Multi-Branch Customer' });
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Customer Compat Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Customer Compat Branch 2' });
      const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Compat Product', sellingPrice: 10, purchasePrice: 5, openingStock: 20 });

      const sale1 = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customer.body.item.id, branchId: branch1.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 });
      const sale2 = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ customerId: customer.body.item.id, branchId: branch2.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 });
      expect(sale1.status).toBe(201);
      expect(sale2.status).toBe(201);
      expect(sale1.body.item.branchId).toBe(branch1.body.item.id);
      expect(sale2.body.item.branchId).toBe(branch2.body.item.id);

      const history = await request(app).get(`/api/customers/${customer.body.item.id}/history`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(history.body.sales.length).toBe(2);
      expect(history.body.balanceDue).toBe(0);
    });
  });

  describe('Tenant isolation (re-verified for the new fields)', () => {
    it('Tenant B cannot view or update Tenant A\'s customer, including its code/notes', async () => {
      const created = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation Target', code: 'ISO-1', notes: 'secret note' });
      const get = await request(app).get(`/api/customers/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);
      const update = await request(app).patch(`/api/customers/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`).send({ notes: 'hijacked' });
      expect(update.status).toBe(404);
    });
  });

  describe('Permission enforcement (re-verified, unchanged CUSTOMER resource)', () => {
    it('a DOCTOR (not CONTACTS_STAFF) cannot view the customer list', async () => {
      const doctor = await createUserToken(tenantA.token, 'DOCTOR');
      const res = await request(app).get('/api/customers').set('Authorization', `Bearer ${doctor.token}`);
      expect(res.status).toBe(403);
    });

    it('a CASHIER (CONTACTS_STAFF) can create and view customers', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app).post('/api/customers').set('Authorization', `Bearer ${cashier.token}`).send({ name: 'Cashier Created Customer' });
      expect(res.status).toBe(201);
    });
  });
});
