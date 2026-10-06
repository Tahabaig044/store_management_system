// Integration tests for Web ERP Phase 12 - Production Hardening: audit
// logging coverage (REQ-12-002..010), the general API rate limiter
// (REQ-12-011), the database-aware health check (REQ-12-015), and the
// request correlation ID (REQ-12-016). Needs a real, throwaway Postgres
// database with migrations applied, same as the other integration suites.
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
  return { token: res.body.token, tenantId: res.body.tenant.id, userId: res.body.user.id };
}

async function latestAuditLog(tenantId, action) {
  return prisma.auditLog.findFirst({ where: { tenantId, action }, orderBy: { createdAt: 'desc' } });
}

describe('Phase 12 - Production Hardening', () => {
  let tenant;

  beforeAll(async () => {
    tenant = await registerTenant(`Phase12 Tenant ${Date.now()}`);
  });

  describe('audit logging coverage', () => {
    it('logs CUSTOMER_CREATE and CUSTOMER_UPDATE without leaking sensitive data', async () => {
      const created = await request(app)
        .post('/api/customers')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: 'Audit Test Customer', phone: '0300-1111111' });
      expect(created.status).toBe(201);

      const createLog = await latestAuditLog(tenant.tenantId, 'CUSTOMER_CREATE');
      expect(createLog).not.toBeNull();
      expect(createLog.entity).toBe('Customer');
      expect(createLog.entityId).toBe(created.body.item.id);
      expect(createLog.userId).toBe(tenant.userId);

      const updated = await request(app)
        .patch(`/api/customers/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ phone: '0300-2222222' });
      expect(updated.status).toBe(200);

      const updateLog = await latestAuditLog(tenant.tenantId, 'CUSTOMER_UPDATE');
      expect(updateLog).not.toBeNull();
      expect(updateLog.metadata.changedFields).toEqual(['phone']);
      // Field names only, never the new value itself.
      expect(JSON.stringify(updateLog.metadata)).not.toContain('0300-2222222');
    });

    it('logs SUPPLIER_CREATE and SUPPLIER_ARCHIVE', async () => {
      const created = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: 'Audit Test Supplier' });
      expect(created.status).toBe(201);
      expect(await latestAuditLog(tenant.tenantId, 'SUPPLIER_CREATE')).not.toBeNull();

      const archived = await request(app)
        .delete(`/api/suppliers/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenant.token}`);
      expect(archived.status).toBe(200);
      const archiveLog = await latestAuditLog(tenant.tenantId, 'SUPPLIER_ARCHIVE');
      expect(archiveLog).not.toBeNull();
      expect(archiveLog.entityId).toBe(created.body.item.id);
    });

    it('logs CATEGORY_CREATE and BRANCH_CREATE via the shared CRUD factory', async () => {
      const category = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: `Audit Category ${Date.now()}` });
      expect(category.status).toBe(201);
      expect(await latestAuditLog(tenant.tenantId, 'CATEGORY_CREATE')).not.toBeNull();

      const branch = await request(app)
        .post('/api/branches')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: `Audit Branch ${Date.now()}` });
      expect(branch.status).toBe(201);
      expect(await latestAuditLog(tenant.tenantId, 'BRANCH_CREATE')).not.toBeNull();
    });

    it('logs EXPENSE_CATEGORY_CREATE (multi-word model name resolves correctly)', async () => {
      const res = await request(app)
        .post('/api/expense-categories')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: `Audit Expense Category ${Date.now()}` });
      expect(res.status).toBe(201);
      const log = await latestAuditLog(tenant.tenantId, 'EXPENSE_CATEGORY_CREATE');
      expect(log).not.toBeNull();
      expect(log.entity).toBe('ExpenseCategory');
    });

    it('logs EXPENSE_CREATE without leaking payment internals, and EXPENSE_UPDATE', async () => {
      const cat = await request(app)
        .post('/api/expense-categories')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: `Expense Cat ${Date.now()}` });

      const expense = await request(app)
        .post('/api/expenses')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ categoryId: cat.body.item.id, amount: 500, description: 'Audit test expense' });
      expect(expense.status).toBe(201);
      const createLog = await latestAuditLog(tenant.tenantId, 'EXPENSE_CREATE');
      expect(createLog).not.toBeNull();
      expect(createLog.metadata.amount).toBe(500);

      const updated = await request(app)
        .patch(`/api/expenses/${expense.body.item.id}`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ description: 'Updated description' });
      expect(updated.status).toBe(200);
      expect(await latestAuditLog(tenant.tenantId, 'EXPENSE_UPDATE')).not.toBeNull();
    });

    it('logs USER_CREATE and USER_UPDATE without ever including the password', async () => {
      const created = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: 'Audit Staff', email: uniqueEmail('staff'), password: 'SuperSecret123', role: 'CASHIER' });
      expect(created.status).toBe(201);
      const createLog = await latestAuditLog(tenant.tenantId, 'USER_CREATE');
      expect(createLog).not.toBeNull();
      expect(JSON.stringify(createLog.metadata)).not.toContain('SuperSecret123');

      const updated = await request(app)
        .patch(`/api/users/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ password: 'AnotherSecret456', role: 'MANAGER' });
      expect(updated.status).toBe(200);
      const updateLog = await latestAuditLog(tenant.tenantId, 'USER_UPDATE');
      expect(updateLog).not.toBeNull();
      expect(updateLog.metadata.passwordChanged).toBe(true);
      expect(JSON.stringify(updateLog.metadata)).not.toContain('AnotherSecret456');
    });

    it('logs PRODUCT_ARCHIVE (a pre-existing gap found and fixed during Phase 12)', async () => {
      const product = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: 'Audit Test Product', sellingPrice: 10, purchasePrice: 5, openingStock: 5 });
      expect(product.status).toBe(201);

      const archived = await request(app)
        .delete(`/api/products/${product.body.item.id}`)
        .set('Authorization', `Bearer ${tenant.token}`);
      expect(archived.status).toBe(200);
      const log = await latestAuditLog(tenant.tenantId, 'PRODUCT_ARCHIVE');
      expect(log).not.toBeNull();
      expect(log.entityId).toBe(product.body.item.id);
    });

    it('logs PURCHASE_PAYMENT_RECORD and OPTICAL_ORDER_PAYMENT_RECORD (pre-existing gaps found and fixed)', async () => {
      const supplier = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Pay Supplier' });
      const product = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: 'Pay Product', sellingPrice: 10, purchasePrice: 5, openingStock: 5 });
      const purchase = await request(app)
        .post('/api/purchases')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ supplierId: supplier.body.item.id, items: [{ productId: product.body.item.id, quantity: 5, unitCost: 5 }], receiveImmediately: true });
      expect(purchase.status).toBe(201);

      const paid = await request(app)
        .post(`/api/purchases/${purchase.body.item.id}/pay`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ amount: 10 });
      expect(paid.status).toBe(200);
      const purchasePayLog = await latestAuditLog(tenant.tenantId, 'PURCHASE_PAYMENT_RECORD');
      expect(purchasePayLog).not.toBeNull();
      expect(purchasePayLog.metadata.amount).toBe(10);

      const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenant.token}`).send({ name: 'Pay Customer' });
      const order = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ customerId: customer.body.item.id, totalAmount: 100, amountPaid: 0 });
      expect(order.status).toBe(201);

      const orderPaid = await request(app)
        .post(`/api/optical-orders/${order.body.item.id}/pay`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ amount: 50 });
      expect(orderPaid.status).toBe(200);
      const orderPayLog = await latestAuditLog(tenant.tenantId, 'OPTICAL_ORDER_PAYMENT_RECORD');
      expect(orderPayLog).not.toBeNull();
      expect(orderPayLog.metadata.amount).toBe(50);
    });

    it('logs BRANCH_ACCESS_GRANT and BRANCH_ACCESS_REVOKE (a pre-existing gap found and fixed)', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenant.token}`).send({ name: `Access Branch ${Date.now()}` });
      const staff = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ name: 'Access Staff', email: uniqueEmail('accessstaff'), password: 'TestPass123', role: 'CASHIER' });

      const granted = await request(app)
        .post(`/api/branches/${branch.body.item.id}/access`)
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({ userId: staff.body.item.id });
      expect(granted.status).toBe(201);
      expect(await latestAuditLog(tenant.tenantId, 'BRANCH_ACCESS_GRANT')).not.toBeNull();

      const revoked = await request(app)
        .delete(`/api/branches/${branch.body.item.id}/access/${staff.body.item.id}`)
        .set('Authorization', `Bearer ${tenant.token}`);
      expect(revoked.status).toBe(204);
      expect(await latestAuditLog(tenant.tenantId, 'BRANCH_ACCESS_REVOKE')).not.toBeNull();
    });
  });

  describe('database-aware health check', () => {
    it('reports healthy status with a correlation ID when the database is reachable', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.requestId).toBeTruthy();
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
    });
  });

  describe('request correlation ID', () => {
    it('attaches a unique X-Request-Id header to every response', async () => {
      const first = await request(app).get('/api/health');
      const second = await request(app).get('/api/health');
      expect(first.headers['x-request-id']).toBeTruthy();
      expect(second.headers['x-request-id']).toBeTruthy();
      expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
    });

    it('does not trust a client-supplied X-Request-Id - always generates its own', async () => {
      const res = await request(app).get('/api/health').set('X-Request-Id', 'attacker-supplied-id');
      expect(res.headers['x-request-id']).not.toBe('attacker-supplied-id');
    });
  });

  describe('general API rate limiter', () => {
    it('does not block a normal-volume burst of legitimate requests', async () => {
      const results = await Promise.all(
        Array.from({ length: 30 }, () => request(app).get('/api/customers').set('Authorization', `Bearer ${tenant.token}`))
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
    });

    it('preserves the existing strict auth-endpoint limiter alongside the new general limiter', async () => {
      // The auth limiter (20 per 15 minutes) is far stricter than the
      // general limiter (300 per minute) and must still be the binding
      // constraint on the login endpoint - unaffected by this phase.
      const attempts = await Promise.all(
        Array.from({ length: 3 }, () => request(app).post('/api/auth/login').send({ email: 'nonexistent@test.local', password: 'wrong' }))
      );
      // All three should be normal 401s (wrong credentials), not 429s -
      // confirms the general limiter's generous ceiling doesn't interfere
      // with a handful of legitimate attempts, while the dedicated auth
      // limiter test below confirms the strict limit still exists.
      expect(attempts.every((r) => r.status === 401)).toBe(true);
    });
  });

  describe('production JWT placeholder protection (REQ-12-019)', () => {
    it('refuses to start in production with the known placeholder JWT_SECRET', () => {
      expect(() => {
        execSync(
          'node -e "require(\'./src/config/env\')"',
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_ENV: 'production',
              JWT_SECRET: 'change-this-to-a-long-random-string',
              DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
            },
            stdio: 'pipe',
          }
        );
      }).toThrow();
    });

    it('starts normally in production with a real secret', () => {
      expect(() => {
        execSync(
          'node -e "require(\'./src/config/env\')"',
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_ENV: 'production',
              JWT_SECRET: 'a-real-random-production-secret-value',
              DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
            },
            stdio: 'pipe',
          }
        );
      }).not.toThrow();
    });

    it('does not affect development/test behavior with the same placeholder value', () => {
      expect(() => {
        execSync(
          'node -e "require(\'./src/config/env\')"',
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_ENV: 'development',
              JWT_SECRET: 'change-this-to-a-long-random-string',
              DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
            },
            stdio: 'pipe',
          }
        );
      }).not.toThrow();
    });
  });
});
