// Phase 4.3 - management operations from the phone: browse/search/details and approvals, through the EXISTING
// endpoints behind an allow-list (middleware/mobileGateway.js). Proven with real HTTP against a real Postgres:
// the door (what a mobile token may and may not reach), permissions, tenant isolation, audit, and concurrency on
// the approvals (two managers racing on one document: exactly one wins, the other gets a clean 409).
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { isMobileAllowed } = require('../src/middleware/mobileGateway');

jest.setTimeout(120000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const M = '/api/mobile/v1';

async function post(token, path, body) {
  const res = await request(app).post(path).set(auth(token)).send(body || {});
  if (res.status >= 400) throw new Error(`POST ${path}: ${JSON.stringify(res.body)}`);
  return res.body;
}
async function mobileLogin(email) {
  const res = await request(app).post(`${M}/auth/login`).send({ email, password: 'TestPass123' });
  return res.body.token;
}

describe('the allow-list itself', () => {
  it('lets through exactly the listed method + path pairs, whatever the query string', () => {
    const id = '3f815404-cf12-46d2-9043-a51a799d5909';
    expect(isMobileAllowed('GET', '/api/customers?search=ann&page=2')).toBe(true);
    expect(isMobileAllowed('GET', `/api/customers/${id}`)).toBe(true);
    expect(isMobileAllowed('GET', `/api/customers/${id}/history`)).toBe(true);
    expect(isMobileAllowed('POST', `/api/procurement/purchase-orders/${id}/approve`)).toBe(true);
    expect(isMobileAllowed('POST', `/api/stock-transfers/${id}/reject`)).toBe(true);
  });

  it('refuses everything else: other methods, other paths, look-alikes, traversal, non-ids', () => {
    const id = '3f815404-cf12-46d2-9043-a51a799d5909';
    for (const [m, p] of [
      ['POST', '/api/customers'], ['PATCH', `/api/customers/${id}`], ['PUT', `/api/customers/${id}`], ['DELETE', `/api/customers/${id}`],
      ['POST', '/api/sales'], ['POST', `/api/sales/${id}/reverse`], ['POST', '/api/payments'], ['GET', '/api/users'],
      ['GET', '/api/accounting/journal-entries'], ['GET', '/api/settings'], ['POST', `/api/procurement/purchase-orders/${id}/cancel`],
      ['POST', `/api/procurement/purchase-requests/${id}/receive`], ['GET', '/api/customers-export'], ['GET', '/api/customers/../users'],
      ['GET', `/api/customers/${id}/../users`], ['GET', '/api/customers/not-an-id'], ['GET', '/api/customers//'],
      ['POST', `/api/stock-transfers/${id}/dispatch`], ['GET', '/customers'], ['GET', '/api/mobile/v1/profile'],
    ]) {
      expect([m, p, isMobileAllowed(m, p)]).toEqual([m, p, false]);
    }
  });
});

describe('Phase 4.3 - management operations over real HTTP', () => {
  let T; let web; let ownerEmail; let owner; let manager; let managerEmail;
  let customer; let supplier; let product; let sale; let purchase; let pr; let po; let st; let wh1; let wh2;
  const G = (token, path, query) => request(app).get(path).set(auth(token)).query(query || {});

  beforeAll(async () => {
    ownerEmail = `${uniq('owner')}@test.local`;
    const reg = await request(app).post('/api/auth/register-tenant').send({ businessName: uniq('Ops43'), adminName: 'Owner', email: ownerEmail, password: 'TestPass123' });
    web = reg.body.token;
    T = reg.body.tenant.id;
    managerEmail = `${uniq('mgr')}@test.local`;
    await post(web, '/api/users', { name: 'Manager', email: managerEmail, password: 'TestPass123', role: 'MANAGER' });
    owner = await mobileLogin(ownerEmail);
    manager = await mobileLogin(managerEmail);

    customer = (await post(web, '/api/customers', { name: 'Ann Optical', phone: '0300111' })).item;
    await post(web, '/api/customers', { name: 'Bob Buyer' });
    supplier = (await post(web, '/api/suppliers', { name: 'Zed Frames Ltd' })).item;
    product = (await post(web, '/api/products', { name: 'Ray Frame X', sku: 'RF-X', barcode: '5551234', purchasePrice: 40, sellingPrice: 90, openingStock: 20 })).item;
    sale = (await post(web, '/api/sales', { customerId: customer.id, items: [{ productId: product.id, quantity: 2, unitPrice: 90 }], paymentMethod: 'cash', amountPaid: 100 })).item;
    purchase = (await post(web, '/api/purchases', { supplierId: supplier.id, receiveImmediately: true, amountPaid: 0, items: [{ productId: product.id, quantity: 5, unitCost: 40 }] })).item;
    wh1 = (await post(web, '/api/warehouses', { name: uniq('WH1') })).item;
    wh2 = (await post(web, '/api/warehouses', { name: uniq('WH2') })).item;
  });
  afterAll(async () => { await prisma.$disconnect(); });

  const newPurchaseRequest = async () => (await post(web, '/api/procurement/purchase-requests', { items: [{ productId: product.id, quantity: 3 }] })).item;
  const newPurchaseOrder = async () => {
    const item = (await post(web, '/api/procurement/purchase-orders', { supplierId: supplier.id, items: [{ productId: product.id, quantity: 4, unitCost: 40 }] })).item;
    await prisma.purchaseOrder.update({ where: { id: item.id }, data: { status: 'PENDING_APPROVAL' } });
    return item;
  };
  const newTransfer = async () => {
    const item = (await post(web, '/api/stock-transfers', { sourceWarehouseId: wh1.id, destinationWarehouseId: wh2.id, items: [{ productId: product.id, quantity: 1 }] })).item;
    await prisma.stockTransfer.update({ where: { id: item.id }, data: { status: 'PENDING_APPROVAL' } });
    return item;
  };

  it('browse, search and details answer a management mobile session - through the existing routes', async () => {
    for (const token of [owner, manager]) {
      const customers = await G(token, '/api/customers', { search: 'Ann' });
      expect(customers.status).toBe(200);
      expect(customers.body.items.map((c) => c.name)).toEqual(['Ann Optical']);
      expect((await G(token, `/api/customers/${customer.id}`)).body.item.phone).toBe('0300111');
      expect((await G(token, `/api/customers/${customer.id}/history`)).status).toBe(200);
      expect((await G(token, '/api/suppliers', { search: 'Zed' })).body.items).toHaveLength(1);
      expect((await G(token, `/api/suppliers/${supplier.id}/ledger`)).status).toBe(200);
      expect((await G(token, '/api/products', { search: 'Ray' })).body.items.map((p) => p.sku)).toContain('RF-X');
      expect((await G(token, `/api/products/${product.id}`)).body.item.stockQuantity).toBeDefined();
      expect((await G(token, '/api/sales')).body.items.map((s) => s.id)).toContain(sale.id);
      expect((await G(token, `/api/sales/${sale.id}`)).body.item.items).toHaveLength(1);
      expect((await G(token, '/api/purchases')).body.items.map((p) => p.id)).toContain(purchase.id);
      expect((await G(token, `/api/purchases/${purchase.id}`)).status).toBe(200);
      expect((await G(token, '/api/warehouses')).status).toBe(200);
      expect((await G(token, `/api/warehouses/${wh1.id}/stock`)).status).toBe(200);
    }
  });

  it('the door stays shut everywhere else: writes, other modules, and the identities that are not management', async () => {
    for (const [method, path, body] of [
      ['post', '/api/customers', { name: 'Nope' }],
      ['patch', `/api/customers/${customer.id}`, { name: 'Renamed' }],
      ['delete', `/api/customers/${customer.id}`],
      ['post', '/api/sales', { items: [] }],
      ['post', `/api/sales/${sale.id}/reverse`, {}],
      ['post', '/api/payments', {}],
      ['get', '/api/users'],
      ['get', '/api/accounting/reports/cash-bank'],
      ['post', `/api/products/${product.id}/adjust-stock`, {}],
    ]) {
      const res = await request(app)[method](path).set(auth(owner)).send(body);
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
    // nothing changed
    expect((await prisma.customer.findUnique({ where: { id: customer.id } })).name).toBe('Ann Optical');
    // a demoted user's mobile token stops working at once, on the existing routes too
    const emailC = `${uniq('demote')}@test.local`;
    const u = (await post(web, '/api/users', { name: 'Demote', email: emailC, password: 'TestPass123', role: 'MANAGER' })).item;
    const tk = await mobileLogin(emailC);
    expect((await G(tk, '/api/customers')).status).toBe(200);
    await prisma.user.update({ where: { id: u.id }, data: { role: 'CASHIER' } });
    expect((await G(tk, '/api/customers')).status).toBe(401);
    // a cashier can never obtain a mobile token
    const cashierEmail = `${uniq('cash')}@test.local`;
    await post(web, '/api/users', { name: 'Cash', email: cashierEmail, password: 'TestPass123', role: 'CASHIER' });
    expect((await request(app).post(`${M}/auth/login`).send({ email: cashierEmail, password: 'TestPass123' })).status).toBe(401);
    // a staff web token is still not a mobile token and works exactly as before
    expect((await G(web, '/api/customers')).status).toBe(200);
  });

  it('tenant isolation: another shop\'s records are invisible and unreachable, by list, by id and by approval', async () => {
    const otherEmail = `${uniq('other')}@test.local`;
    const other = await request(app).post('/api/auth/register-tenant').send({ businessName: uniq('Elsewhere'), adminName: 'Other', email: otherEmail, password: 'TestPass123' });
    const otherMobile = await mobileLogin(otherEmail);
    expect((await G(otherMobile, '/api/customers', { search: 'Ann' })).body.items).toHaveLength(0);
    expect((await G(otherMobile, `/api/customers/${customer.id}`)).status).toBe(404);
    expect((await G(otherMobile, `/api/sales/${sale.id}`)).status).toBe(404);
    const req1 = await newPurchaseRequest();
    expect((await request(app).post(`/api/procurement/purchase-requests/${req1.id}/approve`).set(auth(otherMobile)).send({})).status).toBe(404);
    expect((await prisma.purchaseRequest.findUnique({ where: { id: req1.id } })).status).toBe('PENDING_APPROVAL');
    void other;
  });

  it('approvals: approve and reject work for purchase requests, purchase orders and stock transfers, and are audited with the mobile user', async () => {
    pr = await newPurchaseRequest();
    po = await newPurchaseOrder();
    st = await newTransfer();
    for (const [path, id] of [['procurement/purchase-requests', pr.id], ['procurement/purchase-orders', po.id], ['stock-transfers', st.id]]) {
      expect((await G(manager, `/api/${path}`, { status: 'PENDING_APPROVAL' })).body.items.map((x) => x.id)).toContain(id);
      const res = await request(app).post(`/api/${path}/${id}/approve`).set(auth(manager)).send({});
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.body.item.status).toBe('APPROVED');
    }
    const audits = await prisma.auditLog.findMany({ where: { tenantId: T, action: { in: ['PURCHASE_REQUEST_APPROVE', 'PURCHASE_ORDER_APPROVE', 'STOCK_TRANSFER_APPROVE'] } } });
    expect(audits).toHaveLength(3);
    const managerRow = await prisma.user.findFirst({ where: { email: managerEmail } });
    expect(audits.every((a) => a.userId === managerRow.id)).toBe(true);

    // reject needs a reason, records it, and a decided document cannot be decided again
    const pr2 = await newPurchaseRequest();
    const noReason = await request(app).post(`/api/procurement/purchase-requests/${pr2.id}/reject`).set(auth(owner)).send({});
    expect(noReason.status).toBe(422);
    const rejected = await request(app).post(`/api/procurement/purchase-requests/${pr2.id}/reject`).set(auth(owner)).send({ reason: 'Over budget' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.item).toMatchObject({ status: 'REJECTED', rejectionReason: 'Over budget' });
    const again = await request(app).post(`/api/procurement/purchase-requests/${pr2.id}/approve`).set(auth(manager)).send({});
    expect(again.status).toBe(409);
    expect((await prisma.purchaseRequest.findUnique({ where: { id: pr2.id } })).status).toBe('REJECTED');
  });

  it('concurrency: two managers racing to decide one document - exactly one decision is recorded, the rest are clean 409s', async () => {
    for (const [path, make] of [['procurement/purchase-requests', newPurchaseRequest], ['procurement/purchase-orders', newPurchaseOrder], ['stock-transfers', newTransfer]]) {
      const doc = await make();
      const attempts = [];
      for (let i = 0; i < 4; i += 1) {
        attempts.push(request(app).post(`/api/${path}/${doc.id}/approve`).set(auth(i % 2 ? owner : manager)).send({}));
        attempts.push(request(app).post(`/api/${path}/${doc.id}/reject`).set(auth(i % 2 ? manager : owner)).send({ reason: 'racing' }));
      }
      const results = await Promise.all(attempts);
      const won = results.filter((r) => r.status === 200);
      expect([path, won.length]).toEqual([path, 1]);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      const model = { 'procurement/purchase-requests': 'purchaseRequest', 'procurement/purchase-orders': 'purchaseOrder', 'stock-transfers': 'stockTransfer' }[path];
      const final = await prisma[model].findUnique({ where: { id: doc.id } });
      expect(final.status).toBe(won[0].body.item.status); // the stored state is the winner's, not a blend
      const auditBase = { 'procurement/purchase-requests': 'PURCHASE_REQUEST', 'procurement/purchase-orders': 'PURCHASE_ORDER', 'stock-transfers': 'STOCK_TRANSFER' }[path];
      const acts = await prisma.auditLog.count({ where: { tenantId: T, entityId: doc.id, action: { in: [`${auditBase}_APPROVE`, `${auditBase}_REJECT`] } } });
      expect(acts).toBe(1); // one decision, one audit row
    }
  });

  // Not a check: with DUMP_CONTRACT_DIR set, saves REAL responses for the Android contract tests.
  it('contract fixtures for the Android tests (only when DUMP_CONTRACT_DIR is set)', async () => {
    const dir = process.env.DUMP_CONTRACT_DIR;
    if (!dir) return;
    const fs = require('fs');
    fs.mkdirSync(dir, { recursive: true });
    const prPending = await newPurchaseRequest();
    const poPending = await newPurchaseOrder();
    const stPending = await newTransfer();
    const dump = async (name, path, query) => fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify((await G(owner, path, query)).body, null, 2));
    await dump('customers-list', '/api/customers', { search: 'Ann' });
    await dump('customer-detail', `/api/customers/${customer.id}`);
    await dump('customer-history', `/api/customers/${customer.id}/history`);
    await dump('suppliers-list', '/api/suppliers');
    await dump('supplier-ledger', `/api/suppliers/${supplier.id}/ledger`);
    await dump('products-list', '/api/products', { search: 'Ray' });
    await dump('product-detail', `/api/products/${product.id}`);
    await dump('sales-list', '/api/sales');
    await dump('sale-detail', `/api/sales/${sale.id}`);
    await dump('purchases-list', '/api/purchases');
    await dump('purchase-detail', `/api/purchases/${purchase.id}`);
    await dump('purchase-requests-list', '/api/procurement/purchase-requests', { status: 'PENDING_APPROVAL' });
    await dump('purchase-request-detail', `/api/procurement/purchase-requests/${prPending.id}`);
    await dump('purchase-orders-list', '/api/procurement/purchase-orders', { status: 'PENDING_APPROVAL' });
    await dump('purchase-order-detail', `/api/procurement/purchase-orders/${poPending.id}`);
    await dump('stock-transfers-list', '/api/stock-transfers', { status: 'PENDING_APPROVAL' });
    await dump('stock-transfer-detail', `/api/stock-transfers/${stPending.id}`);
    const approved = await request(app).post(`/api/procurement/purchase-requests/${prPending.id}/approve`).set(auth(owner)).send({});
    fs.writeFileSync(`${dir}/approve-result.json`, JSON.stringify(approved.body, null, 2));
    const conflict = await request(app).post(`/api/procurement/purchase-requests/${prPending.id}/approve`).set(auth(owner)).send({});
    fs.writeFileSync(`${dir}/approve-conflict.json`, JSON.stringify(conflict.body, null, 2));
  });
});
