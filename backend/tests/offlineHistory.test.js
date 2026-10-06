// Phase 3.4 - server side of the offline read models for history: salesHistory / purchasesHistory.
// Proven against a real Postgres: correct rows and fields, every status (a reversed sale is shown as
// reversed), the 90-day window, complete paging, permission + branch scope + tenant isolation, and a
// version that moves when a sale changes (so terminals notice).
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(120000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: `${uniq('a')}@test.local`, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}
async function userToken(adminToken, role, branchId) {
  const email = `${uniq(role.toLowerCase())}@test.local`;
  const created = await post(adminToken, '/api/users', { name: role, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`user create failed ${JSON.stringify(created.body)}`);
  return (await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' })).body.token;
}
async function download(token, name, limit = 500) {
  const items = [];
  let after;
  let pages = 0;
  do {
    const res = await get(token, `/api/offline/datasets/${name}`, { limit, ...(after ? { after } : {}) });
    expect(res.status).toBe(200);
    items.push(...res.body.items);
    after = res.body.nextCursor;
    pages += 1;
  } while (after);
  return { items, pages };
}
const makeProduct = async (t) => (await post(t, '/api/products', { name: uniq('P'), sellingPrice: 10, purchasePrice: 5, openingStock: 200 })).body.item;

describe('Phase 3.4 - history read models', () => {
  let T;
  beforeAll(async () => { T = await registerTenant(uniq('History')); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('salesHistory lists recent sales of every status with what a statement needs, and the version moves when one changes', async () => {
    const p = await makeProduct(T.token);
    const cust = (await post(T.token, '/api/customers', { name: 'Hana' })).body.item.id;
    const a = (await post(T.token, '/api/sales', { customerId: cust, items: [{ productId: p.id, quantity: 2, unitPrice: 10 }], paymentMethod: 'card', amountPaid: 5 })).body.item;
    const b = (await post(T.token, '/api/sales', { items: [{ productId: p.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 })).body.item;
    const v0 = (await get(T.token, '/api/offline/manifest')).body.datasets.salesHistory;
    await new Promise((r) => setTimeout(r, 15));
    await post(T.token, `/api/sales/${b.id}/reverse`);
    const v1 = (await get(T.token, '/api/offline/manifest')).body.datasets.salesHistory;
    expect(v1.maxUpdatedAt).not.toBe(v0.maxUpdatedAt);

    const rows = (await download(T.token, 'salesHistory')).items;
    const ra = rows.find((r) => r.id === a.id);
    expect(ra).toMatchObject({ number: a.invoiceNumber, partyId: cust, partyName: 'Hana', status: 'COMPLETED', paymentMethod: 'card', total: 20, amountPaid: 5, itemCount: 1 });
    expect(rows.find((r) => r.id === b.id).status).toBe('REVERSED');
  });

  it('respects the 90-day window and pages completely', async () => {
    const U = await registerTenant(uniq('HistPaging'));
    const p = await makeProduct(U.token);
    const ids = [];
    for (let i = 0; i < 9; i += 1) ids.push((await post(U.token, '/api/sales', { items: [{ productId: p.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 })).body.item.id);
    await prisma.sale.update({ where: { id: ids[0] }, data: { createdAt: new Date(Date.now() - 120 * 86400000) } });
    const { items, pages } = await download(U.token, 'salesHistory', 4);
    expect(pages).toBeGreaterThan(1);
    expect(items.map((r) => r.id).sort()).toEqual(ids.slice(1).sort());
  });

  it('purchasesHistory carries supplier, status and amounts', async () => {
    const p = await makeProduct(T.token);
    const supp = (await post(T.token, '/api/suppliers', { name: 'Sami' })).body.item.id;
    const pur = (await post(T.token, '/api/purchases', { supplierId: supp, receiveImmediately: true, amountPaid: 10, items: [{ productId: p.id, quantity: 4, unitCost: 5 }] })).body.item;
    const row = (await download(T.token, 'purchasesHistory')).items.find((r) => r.id === pur.id);
    expect(row).toMatchObject({ number: pur.purchaseNumber, partyName: 'Sami', total: 20, amountPaid: 10, itemCount: 1 });
  });

  it('permission, branch scope and tenant isolation apply exactly as for the online lists', async () => {
    const doctor = await userToken(T.token, 'DOCTOR');
    expect((await get(doctor, '/api/offline/datasets/salesHistory')).status).toBe(403);
    expect((await get(doctor, '/api/offline/manifest')).body.datasets.salesHistory).toBeUndefined();

    const b1 = (await post(T.token, '/api/branches', { name: uniq('B1'), code: uniq('c').slice(-6) })).body.item;
    const b2 = (await post(T.token, '/api/branches', { name: uniq('B2'), code: uniq('d').slice(-6) })).body.item;
    const p = await makeProduct(T.token);
    const s1 = (await post(T.token, '/api/sales', { branchId: b1.id, items: [{ productId: p.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 })).body.item;
    const s2 = (await post(T.token, '/api/sales', { branchId: b2.id, items: [{ productId: p.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 })).body.item;
    const cashier = await userToken(T.token, 'CASHIER', b1.id);
    const seen = (await download(cashier, 'salesHistory')).items.map((r) => r.id);
    expect(seen).toContain(s1.id);
    expect(seen).not.toContain(s2.id);

    const other = await registerTenant(uniq('Other'));
    expect((await download(other.token, 'salesHistory')).items).toHaveLength(0);
  });
});
