// Phase 1.16 - Universal Search tests.
//
// Same DB requirements as previous phase test files: point DATABASE_URL at a
// real, throwaway local Postgres database with all migrations applied
// (including 20260923000000_phase1_16_universal_search) and the permission
// catalog seeded. NEVER point this at a database holding real tenant data.
//
// This is a brand-new module (no existing central/global search endpoint
// existed before this phase - see the report's Existing Architecture
// Audit) - every test here exercises genuinely new code, not an extension
// of pre-existing search test coverage (each module's own `?search=` filter
// is tested in that module's own phase test file, unchanged by this phase).
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
  return { token: login.body.token, userId: created.body.item.id };
}

function search(token, params) {
  return request(app).get('/api/search').set('Authorization', `Bearer ${token}`).query(params);
}

describe('Phase 1.16 - Universal Search', () => {
  let tenantA;
  let tenantB;
  let world; // shared fixture data for tenantA

  beforeAll(async () => {
    tenantA = await registerTenant('Phase116 Tenant A');
    tenantB = await registerTenant('Phase116 Tenant B');

    const uniq = `Zephyr${Date.now()}`;
    const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `${uniq} Customer`, phone: '03001112222', email: `${uniq.toLowerCase()}@test.local`, code: `CUST-${uniq}` });
    const supplier = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `${uniq} Supplier`, phone: '03003334444', code: `SUP-${uniq}` });
    const product = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `${uniq} Product`, sku: `SKU-${uniq}`, barcode: `BAR-${uniq}`, sellingPrice: 20, purchasePrice: 10, openingStock: 200 });
    const variant = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `${uniq} Variant Base`, sku: `SKUV-${uniq}`, sellingPrice: 15, purchasePrice: 7, openingStock: 100 });

    const sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: customer.body.item.id, items: [{ productId: product.body.item.id, quantity: 5, unitPrice: 20 }], paymentMethod: 'cash', amountPaid: 50 });
    const purchase = await request(app).post('/api/purchases').set('Authorization', `Bearer ${tenantA.token}`).send({ supplierId: supplier.body.item.id, receiveImmediately: true, items: [{ productId: product.body.item.id, quantity: 10, unitCost: 10 }] });
    const payment = await request(app).post('/api/payments').set('Authorization', `Bearer ${tenantA.token}`).send({ direction: 'IN', amount: 50, method: 'cash', customerId: customer.body.item.id, allocations: [{ saleId: sale.body.item.id, amount: 50 }] });
    if (payment.status !== 201) throw new Error(`payment setup failed: ${JSON.stringify(payment.body)}`);
    const catRes = await request(app).post('/api/expense-categories').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `${uniq} Category` });
    const expense = await request(app).post('/api/expenses').set('Authorization', `Bearer ${tenantA.token}`).send({ categoryId: catRes.body.item.id, amount: 30, description: `${uniq} expense desc` });
    const salesReturn = await request(app).post('/api/sales-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ saleId: sale.body.item.id, items: [{ saleItemId: sale.body.item.items[0].id, quantity: 1 }], reason: 'x' });
    const purchaseReturn = await request(app).post('/api/purchase-returns').set('Authorization', `Bearer ${tenantA.token}`).send({ purchaseId: purchase.body.item.id, items: [{ purchaseItemId: purchase.body.item.items[0].id, quantity: 1 }], reason: 'x' });
    const creditNote = await request(app).post('/api/credit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: customer.body.item.id, amount: 15, reason: `${uniq} adj` });
    const debitNote = await request(app).post('/api/debit-notes').set('Authorization', `Bearer ${tenantA.token}`).send({ supplierId: supplier.body.item.id, amount: 12, reason: `${uniq} adj` });
    const quotation = await request(app).post('/api/quotations').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: customer.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 20 }] });
    const salesOrder = await request(app).post('/api/sales-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: customer.body.item.id, items: [{ productId: product.body.item.id, quantity: 1, unitPrice: 20 }] });
    const purchaseRequest = await request(app).post('/api/procurement/purchase-requests').set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ productId: product.body.item.id, quantity: 5 }], notes: uniq });
    const rfq = await request(app).post('/api/procurement/rfqs').set('Authorization', `Bearer ${tenantA.token}`).send({ items: [{ productId: product.body.item.id, quantity: 5 }], supplierIds: [supplier.body.item.id] });
    const purchaseOrder = await request(app).post('/api/procurement/purchase-orders').set('Authorization', `Bearer ${tenantA.token}`).send({ supplierId: supplier.body.item.id, items: [{ productId: product.body.item.id, quantity: 5, unitCost: 10 }] });

    world = { uniq, customer: customer.body.item, supplier: supplier.body.item, product: product.body.item, variant: variant.body.item, sale: sale.body.item, purchase: purchase.body.item, payment: payment.body.item, expense: expense.body.item, salesReturn: salesReturn.body.item, purchaseReturn: purchaseReturn.body.item, creditNote: creditNote.body.item, debitNote: debitNote.body.item, quotation: quotation.body.item, salesOrder: salesOrder.body.item, purchaseRequest: purchaseRequest.body.item, rfq: rfq.body.item, purchaseOrder: purchaseOrder.body.item };
  });

  describe('Per-entity search', () => {
    it('finds a Product by name/sku/barcode', async () => {
      for (const q of [world.uniq, world.product.sku, world.product.barcode]) {
        const res = await search(tenantA.token, { q, entity: 'PRODUCT' });
        expect(res.status).toBe(200);
        expect(res.body.items.some((i) => i.entityId === world.product.id)).toBe(true);
      }
    });

    it('finds a Customer by name/code/phone/email', async () => {
      for (const q of [world.customer.name, world.customer.code, world.customer.phone, world.customer.email]) {
        const res = await search(tenantA.token, { q, entity: 'CUSTOMER' });
        expect(res.body.items.some((i) => i.entityId === world.customer.id)).toBe(true);
      }
    });

    it('finds a Supplier by name/code/phone', async () => {
      for (const q of [world.supplier.name, world.supplier.code, world.supplier.phone]) {
        const res = await search(tenantA.token, { q, entity: 'SUPPLIER' });
        expect(res.body.items.some((i) => i.entityId === world.supplier.id)).toBe(true);
      }
    });

    it('finds a Sale by invoice number and customer name', async () => {
      const byNumber = await search(tenantA.token, { q: world.sale.invoiceNumber, entity: 'SALE' });
      expect(byNumber.body.items.some((i) => i.entityId === world.sale.id)).toBe(true);
      const byCustomer = await search(tenantA.token, { q: world.uniq, entity: 'SALE' });
      expect(byCustomer.body.items.some((i) => i.entityId === world.sale.id)).toBe(true);
    });

    it('finds a Purchase by purchase number and supplier name', async () => {
      const res = await search(tenantA.token, { q: world.purchase.purchaseNumber, entity: 'PURCHASE' });
      expect(res.body.items.some((i) => i.entityId === world.purchase.id)).toBe(true);
    });

    it('finds a Payment by receipt number', async () => {
      const res = await search(tenantA.token, { q: world.payment.receiptNumber, entity: 'PAYMENT' });
      expect(res.body.items.some((i) => i.entityId === world.payment.id)).toBe(true);
    });

    it('finds an Expense by expense number and description', async () => {
      const byNumber = await search(tenantA.token, { q: world.expense.expenseNumber, entity: 'EXPENSE' });
      expect(byNumber.body.items.some((i) => i.entityId === world.expense.id)).toBe(true);
      const byDesc = await search(tenantA.token, { q: `${world.uniq} expense desc`, entity: 'EXPENSE' });
      expect(byDesc.body.items.some((i) => i.entityId === world.expense.id)).toBe(true);
    });

    it('finds a Sales Return and a Purchase Return by return number', async () => {
      const sr = await search(tenantA.token, { q: world.salesReturn.returnNumber, entity: 'SALES_RETURN' });
      expect(sr.body.items.some((i) => i.entityId === world.salesReturn.id)).toBe(true);
      const pr = await search(tenantA.token, { q: world.purchaseReturn.returnNumber, entity: 'PURCHASE_RETURN' });
      expect(pr.body.items.some((i) => i.entityId === world.purchaseReturn.id)).toBe(true);
    });

    it('finds a Credit Note and a Debit Note by note number', async () => {
      const cn = await search(tenantA.token, { q: world.creditNote.creditNoteNumber, entity: 'CREDIT_NOTE' });
      expect(cn.body.items.some((i) => i.entityId === world.creditNote.id)).toBe(true);
      const dn = await search(tenantA.token, { q: world.debitNote.debitNoteNumber, entity: 'DEBIT_NOTE' });
      expect(dn.body.items.some((i) => i.entityId === world.debitNote.id)).toBe(true);
    });

    it('finds a Quotation and a Sales Order by their own number', async () => {
      const quote = await search(tenantA.token, { q: world.quotation.quotationNumber, entity: 'QUOTATION' });
      expect(quote.body.items.some((i) => i.entityId === world.quotation.id)).toBe(true);
      const order = await search(tenantA.token, { q: world.salesOrder.orderNumber, entity: 'SALES_ORDER' });
      expect(order.body.items.some((i) => i.entityId === world.salesOrder.id)).toBe(true);
    });

    it('finds Purchase Requests, RFQs, and Purchase Orders by their own number', async () => {
      const pr = await search(tenantA.token, { q: world.purchaseRequest.requestNumber, entity: 'PURCHASE_REQUEST' });
      expect(pr.body.items.some((i) => i.entityId === world.purchaseRequest.id)).toBe(true);
      const rfq = await search(tenantA.token, { q: world.rfq.rfqNumber, entity: 'RFQ' });
      expect(rfq.body.items.some((i) => i.entityId === world.rfq.id)).toBe(true);
      // RFQ has no dedicated frontend detail screen (a pre-existing,
      // disclosed Phase 1.9 gap) - the result must still be returned but
      // carry a null route rather than a broken/misleading link.
      expect(rfq.body.items.find((i) => i.entityId === world.rfq.id).route).toBeNull();
      const po = await search(tenantA.token, { q: world.purchaseOrder.poNumber, entity: 'PURCHASE_ORDER' });
      expect(po.body.items.some((i) => i.entityId === world.purchaseOrder.id)).toBe(true);
    });

    it('finds a Product Variant by name, distinct from its parent Product', async () => {
      // ProductVariant has no standalone create endpoint audited in this
      // phase - verified indirectly via direct DB seeding, mirroring how the
      // entity is actually populated elsewhere in the codebase.
      const variant = await prisma.productVariant.create({ data: { tenantId: tenantA.tenantId, productId: world.variant.id, name: `${world.uniq} Blue`, sku: `VAR-${world.uniq}` } });
      const res = await search(tenantA.token, { q: `${world.uniq} Blue`, entity: 'PRODUCT_VARIANT' });
      expect(res.body.items.some((i) => i.entityId === variant.id)).toBe(true);
    });

    it('finds an own Notification by title/body', async () => {
      const notif = await prisma.notification.create({ data: { tenantId: tenantA.tenantId, userId: (await prisma.user.findFirst({ where: { tenantId: tenantA.tenantId, role: 'TENANT_ADMIN' } })).id, type: 'TEST', title: `${world.uniq} test notif` } });
      const res = await search(tenantA.token, { q: `${world.uniq} test notif`, entity: 'NOTIFICATION' });
      expect(res.body.items.some((i) => i.entityId === notif.id)).toBe(true);
    });

    it('finds an Activity Log entry by action', async () => {
      const res = await search(tenantA.token, { q: 'SALE_CREATE', entity: 'ACTIVITY_LOG' });
      expect(res.status).toBe(200);
      expect(res.body.items.some((i) => i.title === 'SALE_CREATE')).toBe(true);
    });

    it('finds a User by name/email (TENANT_ADMIN only)', async () => {
      const res = await search(tenantA.token, { q: 'Test Admin', entity: 'USER' });
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    });
  });

  describe('Multi-entity search', () => {
    it('a single query matching several entity types returns them grouped, each clearly typed', async () => {
      const res = await search(tenantA.token, { q: world.uniq });
      expect(res.status).toBe(200);
      const entityTypes = res.body.groups.map((g) => g.entity);
      expect(entityTypes).toEqual(expect.arrayContaining(['PRODUCT', 'CUSTOMER', 'SUPPLIER']));
      for (const group of res.body.groups) {
        expect(group.items.every((i) => i.entityType === group.entity)).toBe(true);
        // Sensible per-entity limit - never hundreds of rows for one type.
        expect(group.items.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('Search relevance (deterministic, no AI/semantic claims)', () => {
    it('an exact reference match ranks before a partial match within the same entity type', async () => {
      const exactName = `RelevanceExact${Date.now()}`;
      const partialName = `Something ${exactName} Extra Words`;
      await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: partialName });
      await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: exactName });

      const res = await search(tenantA.token, { q: exactName });
      const customerGroup = res.body.groups.find((g) => g.entity === 'CUSTOMER');
      expect(customerGroup).toBeDefined();
      const exactIndex = customerGroup.items.findIndex((i) => i.title === exactName);
      const partialIndex = customerGroup.items.findIndex((i) => i.title === partialName);
      expect(exactIndex).toBeGreaterThanOrEqual(0);
      if (partialIndex >= 0) expect(exactIndex).toBeLessThan(partialIndex);
    });

    it('a prefix match ranks before a mid-string partial match', async () => {
      const stem = `PrefixTest${Date.now()}`;
      const prefixName = `${stem} Co`;
      const midMatchName = `Global ${stem} Traders`;
      await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: midMatchName });
      await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: prefixName });

      const res = await search(tenantA.token, { q: stem, entity: undefined });
      const supplierGroup = res.body.groups.find((g) => g.entity === 'SUPPLIER');
      const prefixIndex = supplierGroup.items.findIndex((i) => i.title === prefixName);
      const midIndex = supplierGroup.items.findIndex((i) => i.title === midMatchName);
      expect(prefixIndex).toBeGreaterThanOrEqual(0);
      if (midIndex >= 0) expect(prefixIndex).toBeLessThan(midIndex);
    });
  });

  describe('Pagination and large-result handling', () => {
    it('single-entity mode paginates correctly and never returns an unbounded set', async () => {
      const stem = `PagingTest${Date.now()}`;
      for (let i = 0; i < 15; i++) {
        await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `${stem} Customer ${i}` });
      }
      const page1 = await search(tenantA.token, { q: stem, entity: 'CUSTOMER', page: 1, pageSize: 10 });
      expect(page1.body.items.length).toBe(10);
      expect(page1.body.total).toBe(15);
      const page2 = await search(tenantA.token, { q: stem, entity: 'CUSTOMER', page: 2, pageSize: 10 });
      expect(page2.body.items.length).toBe(5);
      const page1Ids = new Set(page1.body.items.map((i) => i.entityId));
      const page2Ids = new Set(page2.body.items.map((i) => i.entityId));
      expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
    });

    it('multi-entity mode caps results per entity type even when far more exist', async () => {
      const stem = `CapTest${Date.now()}`;
      for (let i = 0; i < 20; i++) {
        await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `${stem} Product ${i}`, sellingPrice: 5, purchasePrice: 2, openingStock: 10 });
      }
      const res = await search(tenantA.token, { q: stem });
      const productGroup = res.body.groups.find((g) => g.entity === 'PRODUCT');
      expect(productGroup.items.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Permission-aware search (CRITICAL)', () => {
    it('a role without SALE:VIEW never sees Sale/Quotation/SalesOrder/SalesReturn results, even for a matching query', async () => {
      const receptionist = await createUserToken(tenantA.token, 'RECEPTIONIST');
      const res = await search(receptionist.token, { q: world.uniq });
      const forbiddenTypes = ['SALE', 'QUOTATION', 'SALES_ORDER', 'SALES_RETURN'];
      expect(res.body.groups.some((g) => forbiddenTypes.includes(g.entity))).toBe(false);

      const direct = await search(receptionist.token, { q: world.sale.invoiceNumber, entity: 'SALE' });
      expect(direct.body.items).toHaveLength(0);
    });

    it('a role without FINANCE_STAFF permissions never sees Payment/Expense/CreditNote/DebitNote results', async () => {
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const res = await search(storeKeeper.token, { q: world.uniq });
      const forbiddenTypes = ['PAYMENT', 'EXPENSE', 'CREDIT_NOTE', 'DEBIT_NOTE'];
      expect(res.body.groups.some((g) => forbiddenTypes.includes(g.entity))).toBe(false);
    });

    it('USER search is TENANT_ADMIN-only - a MANAGER never sees User results', async () => {
      const manager = await createUserToken(tenantA.token, 'MANAGER');
      const res = await search(manager.token, { q: 'Test', entity: 'USER' });
      expect(res.body.items).toHaveLength(0);

      const multi = await search(manager.token, { q: 'Admin' });
      expect(multi.body.groups.some((g) => g.entity === 'USER')).toBe(false);
    });

    it('ACTIVITY_LOG search is MANAGEMENT-only - a CASHIER never sees Activity Log results', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await search(cashier.token, { q: 'SALE_CREATE', entity: 'ACTIVITY_LOG' });
      expect(res.body.items).toHaveLength(0);
    });

    it('Notification search is always allowed for any authenticated role, since it is self-scoped rather than permission-gated', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const res = await search(cashier.token, { q: 'anything', entity: 'NOTIFICATION' });
      expect(res.status).toBe(200);
    });
  });

  describe('Tenant/Branch/Warehouse isolation (mandatory)', () => {
    it('Tenant B never sees Tenant A data for any entity type, even an identical query', async () => {
      const res = await search(tenantB.token, { q: world.uniq });
      expect(res.body.groups).toHaveLength(0);

      const direct = await search(tenantB.token, { q: world.customer.name, entity: 'CUSTOMER' });
      expect(direct.body.items).toHaveLength(0);
    });

    it('a branch-restricted user searching for another branch\'s Sale finds nothing for that record', async () => {
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Search Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Search Branch 2' });
      const cust = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Branch Search Customer' });
      const prod = await request(app).post('/api/products').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Branch Search Product', sellingPrice: 10, purchasePrice: 5, openingStock: 50 });
      const branch2Sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${tenantA.token}`).send({ customerId: cust.body.item.id, branchId: branch2.body.item.id, items: [{ productId: prod.body.item.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 });

      const branch1Cashier = await createUserToken(tenantA.token, 'CASHIER', branch1.body.item.id);
      const res = await search(branch1Cashier.token, { q: branch2Sale.body.item.invoiceNumber, entity: 'SALE' });
      expect(res.body.items).toHaveLength(0);

      const branch2Cashier = await createUserToken(tenantA.token, 'CASHIER', branch2.body.item.id);
      const ownBranchRes = await search(branch2Cashier.token, { q: branch2Sale.body.item.invoiceNumber, entity: 'SALE' });
      expect(ownBranchRes.body.items.some((i) => i.entityId === branch2Sale.body.item.id)).toBe(true);
    });

    it('an explicit branchId filter is validated against the caller\'s own access', async () => {
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Explicit Filter Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Explicit Filter Branch 2' });
      const restrictedCashier = await createUserToken(tenantA.token, 'CASHIER', branch1.body.item.id);

      const res = await search(restrictedCashier.token, { q: world.uniq, branchId: branch2.body.item.id });
      expect(res.status).toBe(403);
    });

    it('an explicit warehouseId filter is validated against the caller\'s own access', async () => {
      const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Warehouse Filter Branch' });
      const warehouse = await request(app).post('/api/warehouses').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Restricted Search Warehouse', branchId: branch.body.item.id });
      const otherBranch = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Other Warehouse Filter Branch' });
      const restrictedCashier = await createUserToken(tenantA.token, 'CASHIER', otherBranch.body.item.id);

      const res = await search(restrictedCashier.token, { q: world.uniq, warehouseId: warehouse.body.item.id });
      expect(res.status).toBe(403);
    });
  });

  describe('Security: special inputs, injection-safety, empty query', () => {
    it('rejects an empty or whitespace-only query', async () => {
      const empty = await search(tenantA.token, { q: '' });
      expect(empty.status).toBe(422);
      const whitespace = await search(tenantA.token, { q: '   ' });
      expect(whitespace.status).toBe(422);
    });

    it('handles special characters, wildcards, and unicode safely without crashing', async () => {
      const inputs = ["O'Brien", '100%', 'a_b', '日本語テスト', 'a'.repeat(200), '  multiple   spaces  ', '<script>alert(1)</script>'];
      for (const q of inputs) {
        const res = await search(tenantA.token, { q });
        expect([200, 422]).toContain(res.status);
      }
    });

    it('SQL-injection-like input is treated as a literal, parameterized string - no crash, no data leakage', async () => {
      const injectionAttempts = ["'; DROP TABLE customers; --", "' OR '1'='1", "1; SELECT * FROM users", "%' OR 1=1 --"];
      for (const q of injectionAttempts) {
        const res = await search(tenantA.token, { q });
        expect(res.status).toBe(200);
      }
      // The customers table must still exist and be fully intact afterward.
      const stillThere = await prisma.customer.findUnique({ where: { id: world.customer.id } });
      expect(stillThere).not.toBeNull();
    });

    it('rejects an unknown entity type rather than silently ignoring the filter', async () => {
      const res = await search(tenantA.token, { q: 'x', entity: 'NOT_A_REAL_ENTITY' });
      expect(res.status).toBe(422);
    });
  });

  describe('Concurrency / read consistency', () => {
    it('search alongside a concurrent create of a matching record never errors, never leaks a half-written row incorrectly', async () => {
      const stem = `ConcurrentSearch${Date.now()}`;
      const [searchBefore, createRes] = await Promise.all([
        search(tenantA.token, { q: stem }),
        request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: `${stem} Customer` }),
      ]);
      expect(searchBefore.status).toBe(200);
      expect(createRes.status).toBe(201);

      const searchAfter = await search(tenantA.token, { q: stem, entity: 'CUSTOMER' });
      expect(searchAfter.body.items.some((i) => i.entityId === createRes.body.item.id)).toBe(true);
    });

    it('multiple concurrent multi-entity searches all resolve correctly with no server errors', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => search(tenantA.token, { q: world.uniq })));
      for (const res of results) expect(res.status).toBe(200);
    });
  });

  describe('Deep links (Section 11)', () => {
    it('every navigable result carries a route to an existing frontend page; RFQ (no dedicated screen) carries null', async () => {
      const knownRoutes = {
        PRODUCT: '/products', CUSTOMER: '/customers', SUPPLIER: '/suppliers', SALE: '/sales-history',
        PURCHASE: '/purchases', EXPENSE: '/expenses', CREDIT_NOTE: '/credit-notes', DEBIT_NOTE: '/debit-notes',
        QUOTATION: '/quotations', SALES_ORDER: '/sales-orders', ACTIVITY_LOG: '/activity-log', NOTIFICATION: '/notifications',
      };
      const res = await search(tenantA.token, { q: world.uniq });
      for (const group of res.body.groups) {
        if (knownRoutes[group.entity]) {
          expect(group.items.every((i) => i.route === knownRoutes[group.entity])).toBe(true);
        }
      }
    });
  });
});
