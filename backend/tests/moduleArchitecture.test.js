// Phase 0.5 - Core vs Industry Module Architecture tests.
//
// Same DB requirements as permissionsArchitecture.test.js: point DATABASE_URL
// at a real, throwaway local Postgres database with migrations applied
// (including the Phase 0.4 permissions migration) AND the Permission/
// RolePermission catalog seeded (npm run seed:permissions) - this phase adds
// no new migration (Tenant.enabledIndustryPacks already existed from Phase
// 0.2), but does add the MODULE:VIEW/MODULE:UPDATE permission, so the seed
// script must have been re-run after this phase's permissionCatalog.js change.
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

async function disableModule(adminToken, moduleId) {
  const res = await request(app).patch(`/api/modules/${moduleId}`).set('Authorization', `Bearer ${adminToken}`).send({ enabled: false });
  if (res.status !== 200) throw new Error(`disable ${moduleId} failed: ${JSON.stringify(res.body)}`);
  return res;
}

async function enableModule(adminToken, moduleId) {
  const res = await request(app).patch(`/api/modules/${moduleId}`).set('Authorization', `Bearer ${adminToken}`).send({ enabled: true });
  if (res.status !== 200) throw new Error(`enable ${moduleId} failed: ${JSON.stringify(res.body)}`);
  return res;
}

describe('Phase 0.5 - Core vs Industry Module Architecture', () => {
  describe('Module registry introspection', () => {
    let tenant;
    beforeAll(async () => {
      tenant = await registerTenant('Phase05 Registry Tenant');
    });

    it('GET /api/modules lists Core, Universal, and Industry modules with their enabled state', async () => {
      const res = await request(app).get('/api/modules').set('Authorization', `Bearer ${tenant.token}`);
      expect(res.status).toBe(200);
      const byId = new Map(res.body.items.map((m) => [m.id, m]));
      expect(byId.get('PRODUCTS').type).toBe('CORE');
      expect(byId.get('PRODUCTS').enabled).toBe(true);
      expect(byId.get('REPORTS').type).toBe('UNIVERSAL');
      expect(byId.get('REPORTS').enabled).toBe(true);
      expect(byId.get('OPTICAL').type).toBe('INDUSTRY');
      // Every new tenant defaults to OPTICAL+MEDICINE enabled (Phase 0.2 default).
      expect(byId.get('OPTICAL').enabled).toBe(true);
      expect(byId.get('RETAIL').implemented).toBe(false);
    });

    it('a non-admin can view the module registry (MODULE:VIEW is ALL_ROLES) but cannot toggle a module', async () => {
      const cashier = await createUserToken(tenant.token, 'CASHIER');
      const view = await request(app).get('/api/modules').set('Authorization', `Bearer ${cashier.token}`);
      expect(view.status).toBe(200);
      const toggle = await request(app).patch('/api/modules/OPTICAL').set('Authorization', `Bearer ${cashier.token}`).send({ enabled: false });
      expect(toggle.status).toBe(403);
    });

    it('cannot toggle a Core or Universal module, or an unimplemented Industry placeholder', async () => {
      const core = await request(app).patch('/api/modules/PRODUCTS').set('Authorization', `Bearer ${tenant.token}`).send({ enabled: false });
      expect(core.status).toBe(409);
      const universal = await request(app).patch('/api/modules/REPORTS').set('Authorization', `Bearer ${tenant.token}`).send({ enabled: false });
      expect(universal.status).toBe(409);
      const placeholder = await request(app).patch('/api/modules/RETAIL').set('Authorization', `Bearer ${tenant.token}`).send({ enabled: true });
      expect(placeholder.status).toBe(409);
    });
  });

  describe('Disabling the OPTICAL module blocks its routes but leaves Core untouched', () => {
    let tenant;
    let productId;

    beforeAll(async () => {
      tenant = await registerTenant('Phase05 Optical-Disable Tenant');
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Module Test Product', sellingPrice: 20, purchasePrice: 10, openingStock: 50 });
      productId = prod.body.item.id;
      await disableModule(tenant.token, 'OPTICAL');
    });

    afterAll(async () => {
      // Leave the module enabled again so it doesn't leak into any other
      // suite that might reuse a cached app/db state.
      await enableModule(tenant.token, 'OPTICAL');
    });

    it('every Optical/Clinical route now returns 403, even for TENANT_ADMIN', async () => {
      const endpoints = [
        ['get', '/api/optical-orders'],
        ['get', '/api/patients'],
        ['get', '/api/doctors'],
        ['get', '/api/appointments'],
        ['get', '/api/examinations'],
        ['get', '/api/clinical-prescriptions'],
        ['get', '/api/labs'],
        ['get', '/api/clinical-reports/appointments'],
      ];
      for (const [method, url] of endpoints) {
        const res = await request(app)[method](url).set('Authorization', `Bearer ${tenant.token}`);
        expect({ url, status: res.status }).toEqual({ url, status: 403 });
      }
    });

    it('the disabled-module error is a clean 403, not a crash, and creating an optical order is blocked the same way', async () => {
      const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Blocked Customer' });
      const res = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ customerId: customer.body.item.id });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not enabled/i);
    });

    it('Core continues to work fully with OPTICAL disabled: products, customers, sales, purchases, inventory, payments, expenses', async () => {
      const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Core Regression Customer' });
      expect(customer.status).toBe(201);

      const supplier = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Core Regression Supplier' });
      expect(supplier.status).toBe(201);

      const sale = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ customerId: customer.body.item.id, items: [{ productId, quantity: 2, unitPrice: 20 }], paymentMethod: 'cash', amountPaid: 40 });
      expect(sale.status).toBe(201);

      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ supplierId: supplier.body.item.id, items: [{ productId, quantity: 5, unitCost: 10 }], receiveImmediately: true });
      expect(purchase.status).toBe(201);

      const expenseCategory = await request(app).post('/api/expense-categories').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Core Regression Expense Category' });
      const expense = await request(app).post('/api/expenses').set('Authorization', `Bearer ${tenant.token}`).send({ categoryId: expenseCategory.body.item.id, amount: 25 });
      expect(expense.status).toBe(201);

      const payments = await request(app).get('/api/payments').set('Authorization', `Bearer ${tenant.token}`);
      expect(payments.status).toBe(200);

      const products = await request(app).get('/api/products').set('Authorization', `Bearer ${tenant.token}`);
      expect(products.status).toBe(200);
    });

    it('the Command Center dashboard still responds correctly, with the clinical section empty/zeroed instead of erroring', async () => {
      const res = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenant.token}`);
      expect(res.status).toBe(200);
      expect(res.body.clinical).toBeNull();
      expect(res.body.opticalJobs).toEqual({ pending: 0, ready: 0, delayed: 0 });
      // Core KPIs are still fully populated - Core does not depend on Optical.
      expect(res.body.kpis).toBeDefined();
      expect(typeof res.body.kpis.sales).toBe('number');
    });

    it('the Optical Order Report under /api/reports is also blocked, but the rest of the universal Reports module is unaffected', async () => {
      const opticalReport = await request(app).get('/api/reports/optical-orders').set('Authorization', `Bearer ${tenant.token}`);
      expect(opticalReport.status).toBe(403);
      const inventoryReport = await request(app).get('/api/reports/inventory').set('Authorization', `Bearer ${tenant.token}`);
      expect(inventoryReport.status).toBe(200);
    });
  });

  describe('Re-enabling a module restores access immediately, with no re-login required', () => {
    it('a token issued before disabling still works after re-enabling, since enabledIndustryPacks is read fresh on every request', async () => {
      const tenant = await registerTenant('Phase05 Re-Enable Tenant');
      const before = await request(app).get('/api/optical-orders').set('Authorization', `Bearer ${tenant.token}`);
      expect(before.status).toBe(200);

      await disableModule(tenant.token, 'OPTICAL');
      const during = await request(app).get('/api/optical-orders').set('Authorization', `Bearer ${tenant.token}`);
      expect(during.status).toBe(403);

      await enableModule(tenant.token, 'OPTICAL');
      const after = await request(app).get('/api/optical-orders').set('Authorization', `Bearer ${tenant.token}`);
      expect(after.status).toBe(200);
    });
  });

  describe('Enabling/disabling one industry module does not affect another', () => {
    it('disabling MEDICINE leaves OPTICAL fully working, and vice versa', async () => {
      const tenant = await registerTenant('Phase05 Independent-Modules Tenant');

      await disableModule(tenant.token, 'MEDICINE');
      const opticalStillWorks = await request(app).get('/api/optical-orders').set('Authorization', `Bearer ${tenant.token}`);
      expect(opticalStillWorks.status).toBe(200);
      const medicineReportBlocked = await request(app).get('/api/reports/medicine-expiry').set('Authorization', `Bearer ${tenant.token}`);
      expect(medicineReportBlocked.status).toBe(403);

      await enableModule(tenant.token, 'MEDICINE');
      await disableModule(tenant.token, 'OPTICAL');
      const medicineReportWorksAgain = await request(app).get('/api/reports/medicine-expiry').set('Authorization', `Bearer ${tenant.token}`);
      expect(medicineReportWorksAgain.status).toBe(200);
      const opticalNowBlocked = await request(app).get('/api/optical-orders').set('Authorization', `Bearer ${tenant.token}`);
      expect(opticalNowBlocked.status).toBe(403);
    });
  });

  describe('Industry module access still respects Tenant/Company/Branch/Warehouse authorization', () => {
    it('a disabled module returns 403 before any tenant-ownership check ever runs, and an enabled module still enforces cross-tenant isolation', async () => {
      const tenantA = await registerTenant('Phase05 Isolation Tenant A');
      const tenantB = await registerTenant('Phase05 Isolation Tenant B');

      // Tenant A creates a patient; Tenant B (OPTICAL still enabled) must not
      // be able to reach it - ordinary cross-tenant isolation, unaffected by
      // the new module gate.
      const patient = await request(app).post('/api/patients').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Isolation Patient', phone: `05${Date.now()}` });
      const crossTenant = await request(app).get(`/api/patients/${patient.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(crossTenant.status).toBe(404);

      // Now disable OPTICAL for Tenant B and confirm it gets the module
      // error (403), not a tenant-scoping-derived 404 - the module gate is
      // the outermost check, tenant scoping still applies underneath it.
      await disableModule(tenantB.token, 'OPTICAL');
      const disabledAndCrossTenant = await request(app).get(`/api/patients/${patient.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(disabledAndCrossTenant.status).toBe(403);
    });
  });

  describe('Existing Optical/Medical regression - unaffected by the module architecture', () => {
    it('a default tenant (OPTICAL enabled) can still run the full optical order + clinical workflow end to end', async () => {
      const tenant = await registerTenant('Phase05 Full Workflow Tenant');
      const patient = await request(app).post('/api/patients').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Workflow Patient', phone: `06${Date.now()}` });
      expect(patient.status).toBe(201);

      const appointment = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ patientId: patient.body.item.id, scheduledAt: new Date(Date.now() + 86400000).toISOString() });
      expect(appointment.status).toBe(201);

      const exam = await request(app)
        .post('/api/examinations')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ patientId: patient.body.item.id, appointmentId: appointment.body.item.id });
      expect(exam.status).toBe(201);

      const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Workflow Customer' });
      const order = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ customerId: customer.body.item.id, patientId: patient.body.item.id, totalAmount: 100, amountPaid: 50 });
      expect(order.status).toBe(201);
    });
  });
});
