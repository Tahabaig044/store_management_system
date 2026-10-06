// Phase 4.3 - behind the allow-list, the EXISTING permission catalog and branch/warehouse scope still decide.
// Controlled here: MANAGER loses a few catalog grants (so each is proven to be enforced for a mobile session), and
// the branch/warehouse scope is restricted to prove the approval routes honour it.
const mockScope = { branches: null, warehouses: null };
jest.mock('../src/middleware/branchScope', () => {
  const real = jest.requireActual('../src/middleware/branchScope');
  const { ForbiddenError } = require('../src/utils/errors');
  return {
    ...real,
    getAccessibleBranchIds: async () => mockScope.branches,
    getAccessibleWarehouseIds: async () => mockScope.warehouses,
    assertBranchAccess: async (prisma, user, branchId) => {
      if (!branchId || mockScope.branches === null) return;
      if (!mockScope.branches.includes(branchId)) throw new ForbiddenError('You do not have access to this branch');
    },
    assertWarehouseAccess: async (prisma, user, warehouseId) => {
      if (!warehouseId || mockScope.warehouses === null) return;
      if (!mockScope.warehouses.includes(warehouseId)) throw new ForbiddenError('You do not have access to this warehouse');
    },
  };
});

const request = require('supertest');
const prisma = require('../src/config/prisma');

const WITHHELD = new Set(['MANAGER:CUSTOMER:VIEW', 'MANAGER:PRODUCT:VIEW', 'MANAGER:PURCHASE_REQUEST:APPROVE', 'MANAGER:STOCK_TRANSFER:APPROVE']);
const realFindMany = prisma.rolePermission.findMany.bind(prisma.rolePermission);
jest.spyOn(prisma.rolePermission, 'findMany').mockImplementation(async (args) => {
  const rows = await realFindMany(args);
  return rows.filter((r) => !WITHHELD.has(`${r.role}:${r.permission.resource}:${r.permission.action}`));
});
const app = require('../src/app');

jest.setTimeout(120000);
const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const M = '/api/mobile/v1';
async function post(token, path, body) {
  const res = await request(app).post(path).set(auth(token)).send(body || {});
  if (res.status >= 400) throw new Error(`POST ${path}: ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('Phase 4.3 - permissions and scope behind the allow-list', () => {
  let web; let owner; let mgr; let product; let supplier; let b1; let b2; let wh1; let wh2; let wh3;
  beforeAll(async () => {
    const email = `${uniq('o')}@test.local`;
    const reg = await request(app).post('/api/auth/register-tenant').send({ businessName: uniq('Gate43'), adminName: 'Owner', email, password: 'TestPass123' });
    web = reg.body.token;
    const mEmail = `${uniq('m')}@test.local`;
    await post(web, '/api/users', { name: 'Manager', email: mEmail, password: 'TestPass123', role: 'MANAGER' });
    owner = (await request(app).post(`${M}/auth/login`).send({ email, password: 'TestPass123' })).body.token;
    mgr = (await request(app).post(`${M}/auth/login`).send({ email: mEmail, password: 'TestPass123' })).body.token;
    product = (await post(web, '/api/products', { name: uniq('P'), purchasePrice: 1, sellingPrice: 2, openingStock: 10 })).item;
    supplier = (await post(web, '/api/suppliers', { name: uniq('S') })).item;
    b1 = (await post(web, '/api/branches', { name: uniq('B1'), code: 'X1' })).item;
    b2 = (await post(web, '/api/branches', { name: uniq('B2'), code: 'X2' })).item;
    [wh1, wh2, wh3] = [(await post(web, '/api/warehouses', { name: uniq('W1') })).item, (await post(web, '/api/warehouses', { name: uniq('W2') })).item, (await post(web, '/api/warehouses', { name: uniq('W3') })).item];
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('a permission missing from the catalog is refused (403) for a mobile session on every affected route, while the owner keeps it', async () => {
    const pr = (await post(web, '/api/procurement/purchase-requests', { items: [{ productId: product.id, quantity: 1 }] })).item;
    expect((await request(app).get('/api/customers').set(auth(mgr))).status).toBe(403);
    expect((await request(app).get('/api/products').set(auth(mgr))).status).toBe(403);
    expect((await request(app).post(`/api/procurement/purchase-requests/${pr.id}/approve`).set(auth(mgr)).send({})).status).toBe(403);
    expect((await prisma.purchaseRequest.findUnique({ where: { id: pr.id } })).status).toBe('PENDING_APPROVAL'); // refused means nothing changed
    // still allowed for the manager: what the catalog still grants
    expect((await request(app).get('/api/suppliers').set(auth(mgr))).status).toBe(200);
    // the owner is unaffected
    expect((await request(app).get('/api/customers').set(auth(owner))).status).toBe(200);
    expect((await request(app).post(`/api/procurement/purchase-requests/${pr.id}/approve`).set(auth(owner)).send({})).status).toBe(200);
  });

  it('branch scope: approving a purchase request of a branch the user may not access is 403 and changes nothing', async () => {
    const inB2 = (await post(web, '/api/procurement/purchase-requests', { branchId: b2.id, items: [{ productId: product.id, quantity: 1 }] })).item;
    const inB1 = (await post(web, '/api/procurement/purchase-requests', { branchId: b1.id, items: [{ productId: product.id, quantity: 1 }] })).item;
    mockScope.branches = [b1.id];
    const refused = await request(app).post(`/api/procurement/purchase-requests/${inB2.id}/approve`).set(auth(owner)).send({});
    expect(refused.status).toBe(403);
    expect((await prisma.purchaseRequest.findUnique({ where: { id: inB2.id } })).status).toBe('PENDING_APPROVAL');
    expect((await request(app).post(`/api/procurement/purchase-requests/${inB1.id}/approve`).set(auth(owner)).send({})).status).toBe(200);
    mockScope.branches = null;
  });

  it('warehouse scope: a transfer between warehouses the user cannot access cannot be decided; one touching an accessible warehouse can', async () => {
    const other = (await post(web, '/api/stock-transfers', { sourceWarehouseId: wh2.id, destinationWarehouseId: wh3.id, items: [{ productId: product.id, quantity: 1 }] })).item;
    const mine = (await post(web, '/api/stock-transfers', { sourceWarehouseId: wh1.id, destinationWarehouseId: wh3.id, items: [{ productId: product.id, quantity: 1 }] })).item;
    await prisma.stockTransfer.updateMany({ where: { id: { in: [other.id, mine.id] } }, data: { status: 'PENDING_APPROVAL' } });
    mockScope.warehouses = [wh1.id];
    for (const verb of ['approve', 'reject']) {
      const res = await request(app).post(`/api/stock-transfers/${other.id}/${verb}`).set(auth(owner)).send({ reason: 'x' });
      expect([verb, res.status]).toEqual([verb, 403]);
    }
    expect((await prisma.stockTransfer.findUnique({ where: { id: other.id } })).status).toBe('PENDING_APPROVAL');
    expect((await request(app).post(`/api/stock-transfers/${mine.id}/approve`).set(auth(owner)).send({})).status).toBe(200);
    mockScope.warehouses = null;
    void supplier;
  });
});
