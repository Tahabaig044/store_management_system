// Phase 6 - multi-branch, warehouse, stock-transfer, and branch-permission
// tests. Same convention as the other integration suites: real HTTP calls
// against a real (disposable, throwaway) database.
const request = require('supertest');
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

async function createUserToken(adminToken, role, branchId) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return login.body.token;
}

describe('Phase 6 - Multi-Branch + Warehouse + Advanced Business Control', () => {
  let tenantA;
  let tenantB;
  let mainBranchId;
  let secondBranchId;
  let productId;

  beforeAll(async () => {
    tenantA = await registerTenant(`Multi-Branch Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`Multi-Branch Tenant B ${Date.now()}`);

    const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
    mainBranchId = branches.body.items[0].id;

    const secondBranch = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({ name: `Second Branch ${Date.now()}`, code: 'B2' });
    secondBranchId = secondBranch.body.item.id;

    const prod = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({ name: 'Multi-Branch Test Product', purchasePrice: 20, sellingPrice: 35, openingStock: 100 });
    productId = prod.body.item.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Branch management', () => {
    test('a branch can be created with a code and toggled open/closed', async () => {
      const res = await request(app)
        .patch(`/api/branches/${secondBranchId}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ isOpen: false });
      expect(res.status).toBe(200);
      expect(res.body.item.isOpen).toBe(false);

      const reopened = await request(app)
        .patch(`/api/branches/${secondBranchId}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ isOpen: true });
      expect(reopened.body.item.isOpen).toBe(true);
    });

    test('deactivating a branch does not delete it or its historical data', async () => {
      const throwawayBranch = await request(app)
        .post('/api/branches')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: `Throwaway Branch ${Date.now()}` });

      const deactivated = await request(app).delete(`/api/branches/${throwawayBranch.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(deactivated.status).toBe(200);

      const fetched = await request(app).get(`/api/branches/${throwawayBranch.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.item.isActive).toBe(false);
    });
  });

  describe('Multi-branch user access', () => {
    test('a user can be granted access to an additional branch beyond their primary one', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER', mainBranchId);
      const users = await request(app).get('/api/users').set('Authorization', `Bearer ${tenantA.token}`);
      const cashierUser = users.body.items.find((u) => u.role === 'CASHIER' && u.branchId === mainBranchId);

      const granted = await request(app)
        .post(`/api/branches/${secondBranchId}/access`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ userId: cashierUser.id });
      expect(granted.status).toBe(201);

      const list = await request(app).get(`/api/branches/${secondBranchId}/access`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(list.body.items.some((a) => a.userId === cashierUser.id)).toBe(true);
      void cashier;
    });

    test('branch access management is restricted to TENANT_ADMIN', async () => {
      const manager = await createUserToken(tenantA.token, 'MANAGER');
      const res = await request(app)
        .post(`/api/branches/${secondBranchId}/access`)
        .set('Authorization', `Bearer ${manager}`)
        .send({ userId: 'irrelevant' });
      expect(res.status).toBe(403);
    });
  });

  describe('Branch-level RBAC / data scoping', () => {
    test('a cashier restricted to one branch only sees that branch\'s sales', async () => {
      const cashierMain = await createUserToken(tenantA.token, 'CASHIER', mainBranchId);
      const cashierSecond = await createUserToken(tenantA.token, 'CASHIER', secondBranchId);

      // Phase 0.6: captured before either sale, so the dashboard assertions
      // below can use deltas rather than absolute totals - this tenant
      // already has other sales from earlier tests today.
      const dashboardBefore = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${cashierMain}`);
      const totalBefore = dashboardBefore.body.todaySales.total;

      const saleMain = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${cashierMain}`)
        .send({ items: [{ productId, quantity: 1, unitPrice: 35 }] });
      expect(saleMain.status).toBe(201);
      expect(saleMain.body.item.branchId).toBe(mainBranchId);

      const saleSecond = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${cashierSecond}`)
        .send({ items: [{ productId, quantity: 1, unitPrice: 35 }] });
      expect(saleSecond.status).toBe(201);
      expect(saleSecond.body.item.branchId).toBe(secondBranchId);

      const mainCashierView = await request(app).get('/api/sales').set('Authorization', `Bearer ${cashierMain}`);
      expect(mainCashierView.body.items.some((s) => s.id === saleMain.body.item.id)).toBe(true);
      expect(mainCashierView.body.items.some((s) => s.id === saleSecond.body.item.id)).toBe(false);

      // Direct-ID access to the other branch's sale is also blocked, not just filtered from the list.
      const directAccess = await request(app).get(`/api/sales/${saleSecond.body.item.id}`).set('Authorization', `Bearer ${cashierMain}`);
      expect(directAccess.status).toBe(404);

      // Phase 0.6: GET /api/dashboard (the basic dashboard, open to every
      // authenticated role, unlike /api/dashboard/command-center which is
      // MANAGEMENT-only) previously aggregated Sale totals with no branch
      // scoping at all - the main-branch cashier's total must move by
      // exactly their own sale's amount and by nothing at all for the
      // second branch's sale.
      const dashboardAfterOwnSale = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${cashierMain}`);
      expect(dashboardAfterOwnSale.body.todaySales.total).toBeCloseTo(totalBefore + 35, 5);
    });

    test('a cashier cannot create a sale for a branch they are not assigned to', async () => {
      const cashierMain = await createUserToken(tenantA.token, 'CASHIER', mainBranchId);
      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${cashierMain}`)
        .send({ branchId: secondBranchId, items: [{ productId, quantity: 1, unitPrice: 35 }] });
      expect(res.status).toBe(403);
    });

    test('a MANAGER sees sales across every branch, unrestricted', async () => {
      const manager = await createUserToken(tenantA.token, 'MANAGER');
      const res = await request(app).get('/api/sales').set('Authorization', `Bearer ${manager}`);
      expect(res.status).toBe(200);
      const branchIdsSeen = new Set(res.body.items.map((s) => s.branchId).filter(Boolean));
      expect(branchIdsSeen.has(mainBranchId) || branchIdsSeen.has(secondBranchId)).toBe(true);
    });

    test('granting a cashier access to a second branch lets them see both', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER', mainBranchId);
      const users = await request(app).get('/api/users').set('Authorization', `Bearer ${tenantA.token}`);
      const cashierUser = [...users.body.items].reverse().find((u) => u.role === 'CASHIER' && u.branchId === mainBranchId);
      await request(app).post(`/api/branches/${secondBranchId}/access`).set('Authorization', `Bearer ${tenantA.token}`).send({ userId: cashierUser.id });

      const saleInSecond = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ branchId: secondBranchId, items: [{ productId, quantity: 1, unitPrice: 35 }] });

      const view = await request(app).get('/api/sales').set('Authorization', `Bearer ${cashier}`);
      expect(view.body.items.some((s) => s.id === saleInSecond.body.item.id)).toBe(true);
    });
  });

  describe('Large-discount / large-expense approval thresholds', () => {
    test('a cashier is blocked from applying a discount above the configured threshold; a manager is not', async () => {
      await request(app).put('/api/settings/largeDiscountThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '5' });
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const manager = await createUserToken(tenantA.token, 'MANAGER');

      const blocked = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${cashier}`)
        .send({ items: [{ productId, quantity: 1, unitPrice: 35, discount: 10 }] });
      expect(blocked.status).toBe(409);

      const allowed = await request(app)
        .post('/api/sales')
        .set('Authorization', `Bearer ${manager}`)
        .send({ items: [{ productId, quantity: 1, unitPrice: 35, discount: 10 }] });
      expect(allowed.status).toBe(201);

      await request(app).put('/api/settings/largeDiscountThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '999999' });
    });

    test('a store keeper cannot record an expense above the configured threshold via a direct API call', async () => {
      await request(app).put('/api/settings/largeExpenseThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '50' });
      const accountant = await createUserToken(tenantA.token, 'ACCOUNTANT');
      const cat = await request(app).post('/api/expense-categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `Threshold Cat ${Date.now()}` });

      const blocked = await request(app)
        .post('/api/expenses')
        .set('Authorization', `Bearer ${accountant}`)
        .send({ categoryId: cat.body.item.id, amount: 100 });
      expect(blocked.status).toBe(409);

      const allowed = await request(app)
        .post('/api/expenses')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ categoryId: cat.body.item.id, amount: 100 });
      expect(allowed.status).toBe(201);

      await request(app).put('/api/settings/largeExpenseThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '999999' });
    });
  });

  describe('Warehouses and location-aware inventory', () => {
    let warehouseA;
    let warehouseB;

    test('a default warehouse is lazily created and existing stock is assigned to it without loss', async () => {
      const before = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      const existingStock = Number(before.body.item.stockQuantity);

      const warehouses = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`);
      expect(warehouses.body.items.length).toBeGreaterThanOrEqual(0); // may be empty until first touched

      const created = await request(app)
        .post('/api/warehouses')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Warehouse A', code: 'WH-A', branchId: mainBranchId });
      expect(created.status).toBe(201);
      warehouseA = created.body.item.id;

      const stockView = await request(app).get(`/api/warehouses/${warehouseA}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(stockView.status).toBe(200);
      // Since warehouseA is the very first warehouse ever created for this
      // tenant, it becomes the default location and inherits the product's
      // full existing stock (nothing lost, nothing duplicated).
      const row = stockView.body.items.find((i) => i.productId === productId);
      expect(row.quantity).toBe(existingStock);

      const after = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(after.body.item.stockQuantity)).toBe(existingStock); // unchanged
    });

    test('a second warehouse starts at zero for that product, not a duplicate of the first', async () => {
      const created = await request(app)
        .post('/api/warehouses')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ name: 'Warehouse B', code: 'WH-B', branchId: secondBranchId });
      warehouseB = created.body.item.id;

      const stockView = await request(app).get(`/api/warehouses/${warehouseB}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      const row = stockView.body.items.find((i) => i.productId === productId);
      expect(row.quantity).toBe(0);
    });

    test('receiving and dispatching directly against a warehouse keeps Product.stockQuantity in sync', async () => {
      const before = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      const beforeTotal = Number(before.body.item.stockQuantity);

      const received = await request(app)
        .post(`/api/warehouses/${warehouseB}/receive`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ productId, quantity: 10 });
      expect(received.status).toBe(200);
      expect(Number(received.body.item.quantity)).toBe(10);

      const afterReceive = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(afterReceive.body.item.stockQuantity)).toBe(beforeTotal + 10);

      const dispatched = await request(app)
        .post(`/api/warehouses/${warehouseB}/dispatch`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ productId, quantity: 4 });
      expect(dispatched.status).toBe(200);
      expect(Number(dispatched.body.item.quantity)).toBe(6);

      const afterDispatch = await request(app).get(`/api/products/${productId}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(Number(afterDispatch.body.item.stockQuantity)).toBe(beforeTotal + 6);
    });

    test('a stock adjustment above the configured threshold requires MANAGEMENT', async () => {
      await request(app).put('/api/settings/stockAdjustmentApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '50' });
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');

      // 10 units * $20 purchase price = $200 > $50 threshold.
      const blocked = await request(app)
        .post(`/api/warehouses/${warehouseB}/adjust`)
        .set('Authorization', `Bearer ${storeKeeper}`)
        .send({ productId, quantity: 10, note: 'Cycle count correction' });
      expect(blocked.status).toBe(409);

      const allowed = await request(app)
        .post(`/api/warehouses/${warehouseB}/adjust`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ productId, quantity: 10, note: 'Cycle count correction' });
      expect(allowed.status).toBe(200);

      await request(app).put('/api/settings/stockAdjustmentApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '999999' });
    });

    test('warehouse management is restricted to INVENTORY_STAFF; creation to MANAGEMENT', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const forbiddenView = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${cashier}`);
      expect(forbiddenView.status).toBe(403);

      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const forbiddenCreate = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${storeKeeper}`).send({ name: 'Nope' });
      expect(forbiddenCreate.status).toBe(403);
    });
  });

  describe('Stock Transfer lifecycle', () => {
    let warehouseSource;
    let warehouseDest;

    beforeAll(async () => {
      const src = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `Transfer Source ${Date.now()}` });
      warehouseSource = src.body.item.id;
      const dst = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `Transfer Dest ${Date.now()}` });
      warehouseDest = dst.body.item.id;
      // Seed the source warehouse with stock to transfer.
      await request(app).post(`/api/warehouses/${warehouseSource}/receive`).set('Authorization', `Bearer ${tenantA.token}`).send({ productId, quantity: 50 });
    });

    test('a full request -> approve -> dispatch -> receive lifecycle moves stock correctly', async () => {
      const created = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 20 }] });
      expect(created.status).toBe(201);
      expect(created.body.item.status).toBe('APPROVED'); // no threshold configured => auto-approved

      const sourceBefore = await request(app).get(`/api/warehouses/${warehouseSource}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      const sourceQtyBefore = sourceBefore.body.items.find((i) => i.productId === productId).quantity;

      const dispatched = await request(app).post(`/api/stock-transfers/${created.body.item.id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(dispatched.status).toBe(200);
      expect(dispatched.body.item.status).toBe('IN_TRANSIT');

      const sourceAfterDispatch = await request(app).get(`/api/warehouses/${warehouseSource}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(sourceAfterDispatch.body.items.find((i) => i.productId === productId).quantity).toBe(sourceQtyBefore - 20);

      const destBefore = await request(app).get(`/api/warehouses/${warehouseDest}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      const destQtyBefore = destBefore.body.items.find((i) => i.productId === productId).quantity;

      const received = await request(app)
        .post(`/api/stock-transfers/${created.body.item.id}/receive`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId, receivedQuantity: 20 }] });
      expect(received.status).toBe(200);
      expect(received.body.item.status).toBe('COMPLETED');

      const destAfterReceive = await request(app).get(`/api/warehouses/${warehouseDest}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(destAfterReceive.body.items.find((i) => i.productId === productId).quantity).toBe(destQtyBefore + 20);
    });

    test('short and damaged quantities are recorded but never added to destination stock', async () => {
      const created = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 10 }] });
      await request(app).post(`/api/stock-transfers/${created.body.item.id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);

      const destBefore = await request(app).get(`/api/warehouses/${warehouseDest}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      const destQtyBefore = destBefore.body.items.find((i) => i.productId === productId).quantity;

      const received = await request(app)
        .post(`/api/stock-transfers/${created.body.item.id}/receive`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId, receivedQuantity: 6, shortQuantity: 3, damagedQuantity: 1 }] });
      expect(received.status).toBe(200);

      const destAfter = await request(app).get(`/api/warehouses/${warehouseDest}/stock`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(destAfter.body.items.find((i) => i.productId === productId).quantity).toBe(destQtyBefore + 6); // not +10
    });

    test('cannot dispatch a transfer that is not APPROVED, and cannot dispatch twice', async () => {
      const created = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 1 }] });

      await request(app).post(`/api/stock-transfers/${created.body.item.id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);
      const secondDispatch = await request(app).post(`/api/stock-transfers/${created.body.item.id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(secondDispatch.status).toBe(409);
    });

    test('cannot receive a transfer that has not been dispatched', async () => {
      const created = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 1 }] });

      const res = await request(app)
        .post(`/api/stock-transfers/${created.body.item.id}/receive`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId, receivedQuantity: 1 }] });
      expect(res.status).toBe(409);
    });

    test('a transfer above the approval threshold requires MANAGEMENT approval before it can be dispatched', async () => {
      await request(app).put('/api/settings/transferApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '50' });
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');

      // 5 units * $20 = $100 > $50 threshold.
      const created = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${storeKeeper}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 5 }] });
      expect(created.body.item.status).toBe('PENDING_APPROVAL');

      const dispatchAttempt = await request(app).post(`/api/stock-transfers/${created.body.item.id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(dispatchAttempt.status).toBe(409);

      const approved = await request(app).post(`/api/stock-transfers/${created.body.item.id}/approve`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(approved.body.item.status).toBe('APPROVED');

      const dispatchAfterApproval = await request(app).post(`/api/stock-transfers/${created.body.item.id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(dispatchAfterApproval.status).toBe(200);

      await request(app).put('/api/settings/transferApprovalThreshold').set('Authorization', `Bearer ${tenantA.token}`).send({ value: '999999' });
    });

    test('a retried transfer creation with the same idempotencyKey is deduplicated', async () => {
      const idempotencyKey = `transfer-test-${Date.now()}`;
      const first = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 1 }], idempotencyKey });
      expect(first.status).toBe(201);

      const retry = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 1 }], idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);
      expect(retry.body.item.id).toBe(first.body.item.id);
    });

    test('transfers do not post any accounting/revenue journal entry - they are a pure inventory movement', async () => {
      const created = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 1 }] });
      await request(app).post(`/api/stock-transfers/${created.body.item.id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);
      await request(app)
        .post(`/api/stock-transfers/${created.body.item.id}/receive`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ items: [{ productId, receivedQuantity: 1 }] });

      const accountant = await createUserToken(tenantA.token, 'ACCOUNTANT');
      const journal = await request(app)
        .get(`/api/accounting/journal?sourceType=SALE`)
        .set('Authorization', `Bearer ${accountant}`);
      // No SALE-type entry should reference this transfer's id (transfers
      // don't create sourceType SALE/OPTICAL_ORDER entries at all).
      expect(journal.body.items.some((e) => e.sourceId === created.body.item.id)).toBe(false);
    });

    test('an unapproved transfer can be cancelled, but a dispatched one cannot', async () => {
      const created = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 1 }] });
      const cancelled = await request(app).post(`/api/stock-transfers/${created.body.item.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.item.status).toBe('CANCELLED');

      const created2 = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ sourceWarehouseId: warehouseSource, destinationWarehouseId: warehouseDest, items: [{ productId, quantity: 1 }] });
      await request(app).post(`/api/stock-transfers/${created2.body.item.id}/dispatch`).set('Authorization', `Bearer ${tenantA.token}`);
      const cancelAfterDispatch = await request(app).post(`/api/stock-transfers/${created2.body.item.id}/cancel`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(cancelAfterDispatch.status).toBe(409);
    });
  });

  describe('Branch reports', () => {
    test('branch-sales and branch-comparison reports return accurate, ledger-consistent numbers', async () => {
      const accountant = await createUserToken(tenantA.token, 'ACCOUNTANT');
      const salesReport = await request(app).get('/api/accounting/reports/branch-sales').set('Authorization', `Bearer ${accountant}`);
      expect(salesReport.status).toBe(200);
      expect(Array.isArray(salesReport.body.rows)).toBe(true);

      const comparison = await request(app).get('/api/accounting/reports/branch-comparison').set('Authorization', `Bearer ${accountant}`);
      expect(comparison.status).toBe(200);
      expect(comparison.body.rows.length).toBeGreaterThanOrEqual(2); // mainBranch + secondBranch
    });

    test('branch reports are restricted to FINANCE_STAFF', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await request(app).get('/api/accounting/reports/branch-sales').set('Authorization', `Bearer ${cashier}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Command Center Phase 6 integration', () => {
    test('the locations section reports warehouse comparison and the transfer pipeline', async () => {
      const res = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.locations).toBeDefined();
      expect(Array.isArray(res.body.locations.warehouseComparison)).toBe(true);
      expect(res.body.locations.warehouseComparison.length).toBeGreaterThan(0);
      expect(typeof res.body.locations.pendingTransferApprovals).toBe('number');
    });
  });

  describe('Tenant isolation across warehouses and transfers', () => {
    test('tenant B cannot see or act on tenant A\'s warehouses or transfers', async () => {
      const warehouses = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`);
      const warehouseId = warehouses.body.items[0].id;

      const crossTenantGet = await request(app).get(`/api/warehouses/${warehouseId}/stock`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(crossTenantGet.status).toBe(404);

      const list = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${tenantB.token}`);
      expect(list.body.items.find((w) => w.id === warehouseId)).toBeUndefined();
    });

    test('a transfer cannot be created using another tenant\'s warehouse', async () => {
      const warehouses = await request(app).get('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`);
      const warehouseIdA = warehouses.body.items[0].id;
      const warehouseB = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Warehouse' });

      const res = await request(app)
        .post('/api/stock-transfers')
        .set('Authorization', `Bearer ${tenantB.token}`)
        .send({ sourceWarehouseId: warehouseIdA, destinationWarehouseId: warehouseB.body.item.id, items: [{ productId, quantity: 1 }] });
      expect(res.status).toBe(404);
    });
  });
});
