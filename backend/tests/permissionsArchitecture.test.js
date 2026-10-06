// Phase 0.4 Permissions, RBAC & Authorization Architecture tests.
//
// Same DB requirements as business.test.js: point DATABASE_URL at a real,
// throwaway local Postgres database with migrations applied (including
// 20260917105435_phase0_4_permissions_rbac_authorization) AND the
// Permission/RolePermission catalog seeded (npm run seed:permissions).
// NEVER point this at a database holding real tenant data.
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
  return { token: res.body.token, tenantId: res.body.tenant.id, permissions: res.body.permissions };
}

async function createUserToken(adminToken, role, branchId) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return { token: login.body.token, userId: created.body.item.id, permissions: login.body.permissions };
}

describe('Phase 0.4 - Permissions, RBAC & Authorization Architecture', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase04 Tenant A');
    tenantB = await registerTenant('Phase04 Tenant B');
  });

  describe('Permission catalog', () => {
    it('login/registration responses include effective permissions for the role', () => {
      expect(Array.isArray(tenantA.permissions)).toBe(true);
      expect(tenantA.permissions).toEqual(expect.arrayContaining(['PRODUCT:CREATE', 'PRODUCT:VIEW', 'WAREHOUSE:APPROVE']));
    });

    it('TENANT_ADMIN can list the full permission catalog', async () => {
      const res = await request(app).get('/api/permissions').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(50);
      const productCreate = res.body.items.find((p) => p.key === 'PRODUCT:CREATE');
      expect(productCreate.roles).toEqual(expect.arrayContaining(['TENANT_ADMIN', 'MANAGER', 'STORE_KEEPER']));
    });

    it('a non-admin cannot view the permission catalog', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app).get('/api/permissions').set('Authorization', `Bearer ${cashier.token}`);
      expect(res.status).toBe(403);
    });

    it('Optical/Medical resources are present in the migrated catalog (PATIENT, APPOINTMENT, EXAMINATION, PRESCRIPTION, OPTICAL_ORDER)', async () => {
      const res = await request(app).get('/api/permissions').set('Authorization', `Bearer ${tenantA.token}`);
      const resources = new Set(res.body.items.map((p) => p.resource));
      for (const r of ['PATIENT', 'APPOINTMENT', 'EXAMINATION', 'PRESCRIPTION', 'OPTICAL_ORDER']) {
        expect(resources.has(r)).toBe(true);
      }
    });
  });

  describe('Centralized permission enforcement (requirePermission) - demonstration modules', () => {
    it('a CASHIER (no PRODUCT:CREATE) cannot create a product - direct API call, not just hidden UI', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ name: 'Should Fail', sellingPrice: 10, purchasePrice: 5 });
      expect(res.status).toBe(403);
    });

    it('a STORE_KEEPER (has PRODUCT:CREATE) can create a product', async () => {
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ name: 'Store Keeper Product', sellingPrice: 10, purchasePrice: 5 });
      expect(res.status).toBe(201);
    });

    it('a CASHIER cannot reverse a sale (SALE:REVERSE is MANAGEMENT-only)', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Reverse Test Product', sellingPrice: 10, purchasePrice: 5, openingStock: 100 });
      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ items: [{ productId: prod.body.item.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 });
      expect(sale.status).toBe(201);
      const res = await request(app).post(`/api/sales/${sale.body.item.id}/reverse`).set('Authorization', `Bearer ${cashier.token}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Warehouse-level access (third scope tier)', () => {
    let whTenant;
    let branch1;
    let warehouse1;
    let warehouse2;
    let restrictedUser;

    beforeAll(async () => {
      whTenant = await registerTenant('Phase04 Warehouse Tenant');
      const b1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${whTenant.token}`).send({ name: 'WH Branch 1' });
      branch1 = b1.body.item;
      const w1 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${whTenant.token}`).send({ name: 'Sales Floor', branchId: branch1.id });
      warehouse1 = w1.body.item;
      const w2 = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${whTenant.token}`).send({ name: 'Stockroom Safe', branchId: branch1.id });
      warehouse2 = w2.body.item;
      restrictedUser = await createUserToken(whTenant.token, 'STORE_KEEPER', branch1.id);
    });

    it('with NO explicit warehouse grant, a branch-assigned STORE_KEEPER can reach BOTH warehouses in their branch (backward-compatible default)', async () => {
      const r1 = await request(app).get(`/api/warehouses/${warehouse1.id}/stock`).set('Authorization', `Bearer ${restrictedUser.token}`);
      const r2 = await request(app).get(`/api/warehouses/${warehouse2.id}/stock`).set('Authorization', `Bearer ${restrictedUser.token}`);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    });

    it('granting an EXPLICIT warehouse access restricts the user to ONLY that warehouse (fine-grained opt-in)', async () => {
      const grant = await request(app)
        .post(`/api/warehouses/${warehouse1.id}/access`)
        .set('Authorization', `Bearer ${whTenant.token}`)
        .send({ userId: restrictedUser.userId });
      expect(grant.status).toBe(201);

      const r1 = await request(app).get(`/api/warehouses/${warehouse1.id}/stock`).set('Authorization', `Bearer ${restrictedUser.token}`);
      const r2 = await request(app).get(`/api/warehouses/${warehouse2.id}/stock`).set('Authorization', `Bearer ${restrictedUser.token}`);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(403); // warehouse2 no longer reachable now that an explicit allowlist exists
    });

    it('an explicit warehouse grant is void if the warehouse\'s branch is no longer accessible ("must respect Company and Branch authorization")', async () => {
      const otherBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${whTenant.token}`).send({ name: 'WH Branch 2' });
      const otherWarehouse = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${whTenant.token}`).send({ name: 'Other Branch Warehouse', branchId: otherBranch.body.item.id });

      // Grant explicit access to a warehouse in a branch this user has NO branch access to.
      await request(app).post(`/api/warehouses/${otherWarehouse.body.item.id}/access`).set('Authorization', `Bearer ${whTenant.token}`).send({ userId: restrictedUser.userId });

      const res = await request(app).get(`/api/warehouses/${otherWarehouse.body.item.id}/stock`).set('Authorization', `Bearer ${restrictedUser.token}`);
      expect(res.status).toBe(403);

      // Clean up this grant so it doesn't leak into the next test's
      // "zero explicit grants -> fall back to branch access" expectation.
      await request(app).delete(`/api/warehouses/${otherWarehouse.body.item.id}/access/${restrictedUser.userId}`).set('Authorization', `Bearer ${whTenant.token}`);
    });

    it('revoking warehouse access removes it immediately (access after change)', async () => {
      const revoke = await request(app)
        .delete(`/api/warehouses/${warehouse1.id}/access/${restrictedUser.userId}`)
        .set('Authorization', `Bearer ${whTenant.token}`);
      expect(revoke.status).toBe(204);

      // Now the user has zero explicit grants again, so falls back to
      // branch-derived access - both warehouses reachable again.
      const r1 = await request(app).get(`/api/warehouses/${warehouse1.id}/stock`).set('Authorization', `Bearer ${restrictedUser.token}`);
      expect(r1.status).toBe(200);
    });
  });

  describe('Cross-tenant / cross-company / cross-branch isolation', () => {
    it('cross-tenant: Tenant B cannot create a warehouse access grant for a Tenant A warehouse', async () => {
      const wh = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'A-only WH' });
      const res = await request(app)
        .post(`/api/warehouses/${wh.body.item.id}/access`)
        .set('Authorization', `Bearer ${tenantB.token}`)
        .send({ userId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(404);
    });

    it('cross-company: a user with company-wide access to Company X cannot reach a warehouse under Company Y of the same tenant', async () => {
      const t = await registerTenant('Phase04 Cross-Company Tenant');
      const companyX = await request(app).post('/api/companies').set('Authorization', `Bearer ${t.token}`).send({ name: 'Company X' });
      const companyY = await request(app).post('/api/companies').set('Authorization', `Bearer ${t.token}`).send({ name: 'Company Y' });
      const branchX = await request(app).post('/api/branches').set('Authorization', `Bearer ${t.token}`).send({ name: 'Branch X', companyId: companyX.body.item.id });
      const branchY = await request(app).post('/api/branches').set('Authorization', `Bearer ${t.token}`).send({ name: 'Branch Y', companyId: companyY.body.item.id });
      const whY = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${t.token}`).send({ name: 'Y Warehouse', branchId: branchY.body.item.id });

      const user = await createUserToken(t.token, 'STORE_KEEPER', branchX.body.item.id);
      await request(app).post(`/api/companies/${companyX.body.item.id}/access`).set('Authorization', `Bearer ${t.token}`).send({ userId: user.userId });

      const res = await request(app).get(`/api/warehouses/${whY.body.item.id}/stock`).set('Authorization', `Bearer ${user.token}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Role & privilege escalation', () => {
    it('a non-admin cannot create a TENANT_ADMIN user (role-gated at the route, not just the UI)', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ name: 'Escalation Attempt', email: uniqueEmail('escalate'), password: 'TestPass123', role: 'TENANT_ADMIN' });
      expect(res.status).toBe(403);
    });

    it('a TENANT_ADMIN cannot change their OWN role (self-privilege-escalation guard)', async () => {
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tenantA.token}`);
      const res = await request(app)
        .patch(`/api/users/${me.body.user.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ role: 'MANAGER' });
      expect(res.status).toBe(403);
    });

    it('access reflects a role change immediately, on the very next request, with no re-login required', async () => {
      const staff = await createUserToken(tenantA.token, 'CASHIER');
      const before = await request(app).post('/api/products').set('Authorization', `Bearer ${staff.token}`).send({ name: 'Before Promotion', sellingPrice: 5, purchasePrice: 2 });
      expect(before.status).toBe(403);

      await request(app).patch(`/api/users/${staff.userId}`).set('Authorization', `Bearer ${tenantA.token}`).send({ role: 'STORE_KEEPER' });

      // Same original token, no new login - role is re-read from the DB on every request.
      const after = await request(app).post('/api/products').set('Authorization', `Bearer ${staff.token}`).send({ name: 'After Promotion', sellingPrice: 5, purchasePrice: 2 });
      expect(after.status).toBe(201);
    });

    it('access is revoked immediately after a demotion, with the same pre-existing token', async () => {
      const staff = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const before = await request(app).post('/api/products').set('Authorization', `Bearer ${staff.token}`).send({ name: 'Before Demotion', sellingPrice: 5, purchasePrice: 2 });
      expect(before.status).toBe(201);

      await request(app).patch(`/api/users/${staff.userId}`).set('Authorization', `Bearer ${tenantA.token}`).send({ role: 'CASHIER' });

      const after = await request(app).post('/api/products').set('Authorization', `Bearer ${staff.token}`).send({ name: 'After Demotion', sellingPrice: 5, purchasePrice: 2 });
      expect(after.status).toBe(403);
    });
  });

  describe('Existing Optical/Medical permissions after migration', () => {
    it('a RECEPTIONIST (CLINICAL_STAFF) can still create a patient - unaffected by the permission catalog migration', async () => {
      const receptionist = await createUserToken(tenantA.token, 'RECEPTIONIST');
      const res = await request(app)
        .post('/api/patients')
        .set('Authorization', `Bearer ${receptionist.token}`)
        .send({ name: 'Migration Check Patient', phone: `03${Date.now()}` });
      expect(res.status).toBe(201);
    });

    it('a CASHIER (not CLINICAL_STAFF) still cannot access patient records', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app).get('/api/patients').set('Authorization', `Bearer ${cashier.token}`);
      expect(res.status).toBe(403);
    });
  });

  // Phase 0.4 Condition Closure: spot-checks across the modules migrated
  // from requireRole to requirePermission in the condition-closure pass.
  // Not exhaustive of every migrated route - the goal is to prove the
  // migration preserved each module's pre-existing role boundary exactly
  // (same roles allowed, same roles denied), for a representative sample
  // spanning contacts, sales, procurement, accounting, clinical, optical,
  // and communication.
  //
  // One token per role is created ONCE in beforeAll and reused across every
  // assertion below - /api/auth/login and /api/auth/register-tenant share a
  // 20-per-15-minutes rate limiter (brute-force protection, see app.js), and
  // minting a fresh user per assertion would exhaust that quota well before
  // this block finishes.
  describe('Condition Closure - newly migrated modules retain their pre-existing role boundaries', () => {
    let cashier;
    let storeKeeper;
    let receptionist;
    let manager;
    let accountant;

    beforeAll(async () => {
      cashier = await createUserToken(tenantA.token, 'CASHIER');
      storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      receptionist = await createUserToken(tenantA.token, 'RECEPTIONIST');
      manager = await createUserToken(tenantA.token, 'MANAGER');
      accountant = await createUserToken(tenantA.token, 'ACCOUNTANT');
    });

    it('CATEGORY: a CASHIER (CONTACTS_STAFF) can view but not create a category', async () => {
      const view = await request(app).get('/api/categories').set('Authorization', `Bearer ${cashier.token}`);
      expect(view.status).toBe(200);
      const create = await request(app).post('/api/categories').set('Authorization', `Bearer ${cashier.token}`).send({ name: 'Should Fail' });
      expect(create.status).toBe(403);
    });

    it('SUPPLIER: a STORE_KEEPER (INVENTORY_STAFF) can create a supplier; a RECEPTIONIST cannot', async () => {
      const ok = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${storeKeeper.token}`).send({ name: 'Cond Closure Supplier' });
      expect(ok.status).toBe(201);
      const denied = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${receptionist.token}`).send({ name: 'Should Fail' });
      expect(denied.status).toBe(403);
    });

    it('BRANCH and COMPANY: a MANAGER (not TENANT_ADMIN) cannot create either', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${manager.token}`).send({ name: 'Should Fail Branch' });
      expect(branch.status).toBe(403);
      const company = await request(app).post('/api/companies').set('Authorization', `Bearer ${manager.token}`).send({ name: 'Should Fail Company' });
      expect(company.status).toBe(403);
    });

    it('USER: a CASHIER cannot list users (USER:VIEW is TENANT_ADMIN-only)', async () => {
      const res = await request(app).get('/api/users').set('Authorization', `Bearer ${cashier.token}`);
      expect(res.status).toBe(403);
    });

    it('SALE: a RECEPTIONIST (not SALES_STAFF) cannot create or list sales', async () => {
      const list = await request(app).get('/api/sales').set('Authorization', `Bearer ${receptionist.token}`);
      expect(list.status).toBe(403);
      const create = await request(app).post('/api/sales').set('Authorization', `Bearer ${receptionist.token}`).send({ items: [], paymentMethod: 'cash' });
      expect(create.status).toBe(403);
    });

    it('PURCHASE: a STORE_KEEPER can create a purchase and a MANAGER can return it; a RECEPTIONIST cannot create one', async () => {
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Purchase Cond Closure Product', sellingPrice: 20, purchasePrice: 10 });
      const supplier = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cond Closure Purchase Supplier' });
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ supplierId: supplier.body.item.id, items: [{ productId: prod.body.item.id, quantity: 5, unitCost: 10 }], receiveImmediately: true });
      expect(purchase.status).toBe(201);

      const ret = await request(app).post(`/api/purchases/${purchase.body.item.id}/return`).set('Authorization', `Bearer ${manager.token}`);
      expect(ret.status).toBe(200);

      const denied = await request(app).post('/api/purchases').set('Authorization', `Bearer ${receptionist.token}`).send({ supplierId: supplier.body.item.id, items: [] });
      expect(denied.status).toBe(403);
    });

    it('EXPENSE: an ACCOUNTANT (FINANCE_STAFF) can create an expense; a CASHIER cannot', async () => {
      const cat = await request(app).post('/api/expense-categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Cond Closure Expense Category' });
      const ok = await request(app).post('/api/expenses').set('Authorization', `Bearer ${accountant.token}`).send({ categoryId: cat.body.item.id, amount: 50 });
      expect(ok.status).toBe(201);

      const denied = await request(app).post('/api/expenses').set('Authorization', `Bearer ${cashier.token}`).send({ categoryId: cat.body.item.id, amount: 50 });
      expect(denied.status).toBe(403);
    });

    it('PAYMENT: an ACCOUNTANT can list payments; a CASHIER cannot', async () => {
      const ok = await request(app).get('/api/payments').set('Authorization', `Bearer ${accountant.token}`);
      expect(ok.status).toBe(200);
      const denied = await request(app).get('/api/payments').set('Authorization', `Bearer ${cashier.token}`);
      expect(denied.status).toBe(403);
    });

    it('PURCHASE_REQUEST: a STORE_KEEPER can create one but not approve it; a MANAGER can approve it', async () => {
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'PR Cond Closure Product', sellingPrice: 20, purchasePrice: 10 });
      const pr = await request(app)
        .post('/api/procurement/purchase-requests')
        .set('Authorization', `Bearer ${storeKeeper.token}`)
        .send({ items: [{ productId: prod.body.item.id, quantity: 3 }] });
      expect(pr.status).toBe(201);

      const selfApprove = await request(app).post(`/api/procurement/purchase-requests/${pr.body.item.id}/approve`).set('Authorization', `Bearer ${storeKeeper.token}`);
      expect(selfApprove.status).toBe(403);

      const approve = await request(app).post(`/api/procurement/purchase-requests/${pr.body.item.id}/approve`).set('Authorization', `Bearer ${manager.token}`);
      expect(approve.status).toBe(200);
    });

    it('JOURNAL: an ACCOUNTANT can view journal entries but still cannot post a manual entry (unmigrated MANAGEMENT-only action)', async () => {
      const view = await request(app).get('/api/accounting/journal').set('Authorization', `Bearer ${accountant.token}`);
      expect(view.status).toBe(200);
      const create = await request(app).post('/api/accounting/journal').set('Authorization', `Bearer ${accountant.token}`).send({ lines: [] });
      expect(create.status).toBe(403);
    });

    it('REPORT: an ACCOUNTANT can view reports; a CASHIER cannot', async () => {
      const ok = await request(app).get('/api/reports/inventory').set('Authorization', `Bearer ${accountant.token}`);
      expect(ok.status).toBe(200);
      const denied = await request(app).get('/api/reports/inventory').set('Authorization', `Bearer ${cashier.token}`);
      expect(denied.status).toBe(403);
    });

    it('APPOINTMENT: a RECEPTIONIST (CLINICAL_STAFF) can create an appointment; a CASHIER cannot', async () => {
      const patient = await request(app).post('/api/patients').set('Authorization', `Bearer ${receptionist.token}`).send({ name: 'Appt Cond Closure Patient', phone: `04${Date.now()}` });
      const ok = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionist.token}`)
        .send({ patientId: patient.body.item.id, scheduledAt: new Date(Date.now() + 86400000).toISOString() });
      expect(ok.status).toBe(201);

      const denied = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ patientId: patient.body.item.id, scheduledAt: new Date(Date.now() + 86400000).toISOString() });
      expect(denied.status).toBe(403);
    });

    it('OPTICAL_ORDER: a RECEPTIONIST (FRONT_DESK) can create an optical order; a STORE_KEEPER cannot', async () => {
      const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${receptionist.token}`).send({ name: 'Optical Cond Closure Customer' });
      const ok = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${receptionist.token}`).send({ customerId: customer.body.item.id });
      expect(ok.status).toBe(201);

      const denied = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${storeKeeper.token}`).send({ customerId: customer.body.item.id });
      expect(denied.status).toBe(403);
    });

    it('COMMUNICATION: an ACCOUNTANT (COMMUNICATION_STAFF) can view messages; a STORE_KEEPER cannot', async () => {
      const ok = await request(app).get('/api/communication/messages').set('Authorization', `Bearer ${accountant.token}`);
      expect(ok.status).toBe(200);
      const denied = await request(app).get('/api/communication/messages').set('Authorization', `Bearer ${storeKeeper.token}`);
      expect(denied.status).toBe(403);
    });
  });
});
