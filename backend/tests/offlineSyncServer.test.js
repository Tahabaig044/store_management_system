// Phase 3.2 - server side of offline synchronization.
//
// The client sync engine (frontend/src/offline) replays queued work with the SAME idempotency keys
// it was queued with. What it needs from the server, proven here with real HTTP requests against a
// real Postgres:
//   - a stable machine-readable `code` on every rejection, so a conflict is classified
//     deterministically (never by message text);
//   - the original business event time (`occurredAt`) preserved on sales, purchases, expenses,
//     payments and stock moves - and a device clock never trusted forward;
//   - the exact stale-stock / oversell scenario: the server validates the ACTUAL current stock, never
//     goes negative, and a rejected replay is a clean, repeatable 409 - not a lost or doubled sale.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(90000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: `${uniq('a')}@test.local`, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}
const makeProduct = async (t, extra = {}) => (await post(t, '/api/products', { name: uniq('Prod'), sellingPrice: 10, purchasePrice: 5, openingStock: 10, ...extra })).body.item;
const saleBody = (productId, quantity, extra = {}) => ({ items: [{ productId, quantity, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: quantity * 10, ...extra });

describe('Phase 3.2 - server side of offline synchronization', () => {
  let T;

  beforeAll(async () => {
    T = await registerTenant(uniq('Sync Server'));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Deterministic conflict codes', () => {
    it('an oversell is 409 STOCK_INSUFFICIENT with the actual available quantity, and stock is untouched', async () => {
      const p = await makeProduct(T.token, { openingStock: 4 });
      const res = await post(T.token, '/api/sales', saleBody(p.id, 7, { idempotencyKey: uniq('k') }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STOCK_INSUFFICIENT');
      expect(res.body.error).toMatch(/available: 4/);
      expect(Number((await prisma.product.findUnique({ where: { id: p.id } })).stockQuantity)).toBe(4);
    });

    it('an already-reversed sale is 409 ALREADY_APPLIED; a payment beyond the balance is 422 BALANCE_CHANGED; an unknown record is 404 NOT_FOUND', async () => {
      const p = await makeProduct(T.token, { openingStock: 10 });
      const sale = (await post(T.token, '/api/sales', saleBody(p.id, 2, { amountPaid: 0 }))).body.item;
      expect((await post(T.token, `/api/sales/${sale.id}/reverse`)).status).toBe(200);
      const again = await post(T.token, `/api/sales/${sale.id}/reverse`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_APPLIED');

      const sale2 = (await post(T.token, '/api/sales', saleBody(p.id, 1, { amountPaid: 0 }))).body.item;
      const over = await post(T.token, `/api/sales/${sale2.id}/pay`, { amount: 999 });
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('BALANCE_CHANGED');

      const missing = await post(T.token, '/api/sales/00000000-0000-4000-8000-000000000000/reverse');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('NOT_FOUND');
    });

    it('a payment on a sale that was reversed meanwhile is 409 DOCUMENT_NOT_OPEN, and a closed accounting period is 409 PERIOD_CLOSED', async () => {
      const p = await makeProduct(T.token, { openingStock: 10 });
      const sale = (await post(T.token, '/api/sales', saleBody(p.id, 1, { amountPaid: 0 }))).body.item;
      await post(T.token, `/api/sales/${sale.id}/reverse`);
      const late = await post(T.token, `/api/sales/${sale.id}/pay`, { amount: 5 });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('DOCUMENT_NOT_OPEN');

      const period = (await post(T.token, '/api/accounting/periods', { name: uniq('P'), startDate: daysAgo(40).toISOString(), endDate: daysAgo(30).toISOString() })).body.item;
      expect((await post(T.token, `/api/accounting/periods/${period.id}/close`)).status).toBeLessThan(300);
      const backdated = await post(T.token, '/api/sales', saleBody(p.id, 1, { occurredAt: daysAgo(35).toISOString() }));
      expect(backdated.status).toBe(409);
      expect(backdated.body.code).toBe('PERIOD_CLOSED');
    });

    it('validation errors keep their own code so a client does not mistake them for a conflict', async () => {
      const res = await post(T.token, '/api/sales', { items: [] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION');
      const forbidden = await request(app).get('/api/offline/manifest');
      expect(forbidden.status).toBe(401);
    });
  });

  describe('Original event time is preserved', () => {
    it('a sale made offline three days ago is recorded (and ledgered, and paid) three days ago, not at sync time', async () => {
      const p = await makeProduct(T.token, { openingStock: 20 });
      const when = daysAgo(3);
      const res = await post(T.token, '/api/sales', saleBody(p.id, 2, { occurredAt: when.toISOString() }));
      expect(res.status).toBe(201);
      const sale = await prisma.sale.findUnique({ where: { id: res.body.item.id } });
      expect(Math.abs(sale.createdAt.getTime() - when.getTime())).toBeLessThan(1000);
      const payment = await prisma.payment.findFirst({ where: { saleId: sale.id } });
      expect(Math.abs(payment.paidAt.getTime() - when.getTime())).toBeLessThan(1000);
      const entry = await prisma.journalEntry.findFirst({ where: { sourceType: 'SALE', sourceId: sale.id } });
      expect(Math.abs(entry.date.getTime() - when.getTime())).toBeLessThan(1000);
      expect(entry.postedAt.getTime()).toBeGreaterThan(when.getTime() + 86400000); // posted now, dated then

      // It belongs to THAT business day in the reports.
      const day = when.toISOString().slice(0, 10);
      const pl = await get(T.token, '/api/accounting/reports/profit-loss', { from: day, to: day });
      expect(pl.body.totalRevenue).toBeGreaterThanOrEqual(20);
    });

    it('a device clock ahead of the server is clamped to now; an unparseable time is rejected; no time means now', async () => {
      const p = await makeProduct(T.token, { openingStock: 20 });
      const future = new Date(Date.now() + 5 * 86400000);
      const clamped = await post(T.token, '/api/sales', saleBody(p.id, 1, { occurredAt: future.toISOString() }));
      const sale = await prisma.sale.findUnique({ where: { id: clamped.body.item.id } });
      expect(sale.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect((await post(T.token, '/api/sales', saleBody(p.id, 1, { occurredAt: 'not-a-time' }))).status).toBe(422);
      const plain = await post(T.token, '/api/sales', saleBody(p.id, 1));
      const s2 = await prisma.sale.findUnique({ where: { id: plain.body.item.id } });
      expect(Math.abs(s2.createdAt.getTime() - Date.now())).toBeLessThan(15000);
    });

    it('purchases, expenses, standalone payments and stock moves keep their event time too', async () => {
      const p = await makeProduct(T.token, { openingStock: 0 });
      const supplier = (await post(T.token, '/api/suppliers', { name: uniq('S') })).body.item.id;
      const customer = (await post(T.token, '/api/customers', { name: uniq('C') })).body.item.id;
      const when = daysAgo(2).toISOString();
      const near = (d) => Math.abs(new Date(d).getTime() - new Date(when).getTime()) < 1000;

      const purchase = (await post(T.token, '/api/purchases', { supplierId: supplier, receiveImmediately: true, amountPaid: 5, items: [{ productId: p.id, quantity: 2, unitCost: 5 }], occurredAt: when })).body.item;
      const pRow = await prisma.purchase.findUnique({ where: { id: purchase.id } });
      expect(near(pRow.createdAt) && near(pRow.receivedAt)).toBe(true);
      expect(near((await prisma.journalEntry.findFirst({ where: { sourceType: 'PURCHASE', sourceId: purchase.id } })).date)).toBe(true);

      const cat = (await post(T.token, '/api/expense-categories', { name: uniq('Cat') })).body.item.id;
      const expense = (await post(T.token, '/api/expenses', { categoryId: cat, amount: 12, method: 'cash', occurredAt: when })).body.item;
      expect(near((await prisma.expense.findUnique({ where: { id: expense.id } })).expenseDate)).toBe(true);
      expect(near((await prisma.payment.findFirst({ where: { expenseId: expense.id } })).paidAt)).toBe(true);

      const sale = (await post(T.token, '/api/sales', saleBody(p.id, 1, { customerId: customer, amountPaid: 0 }))).body.item;
      const pay = (await post(T.token, '/api/payments', { direction: 'IN', customerId: customer, amount: 4, allocations: [{ saleId: sale.id, amount: 4 }], occurredAt: when })).body.item;
      expect(near((await prisma.payment.findUnique({ where: { id: pay.id } })).paidAt)).toBe(true);
      expect(near((await prisma.journalEntry.findFirst({ where: { sourceType: 'PAYMENT', sourceId: pay.id } })).date)).toBe(true);

      const wh = (await post(T.token, '/api/warehouses', { name: uniq('WH') })).body.item.id;
      expect((await post(T.token, `/api/warehouses/${wh}/receive`, { productId: p.id, quantity: 3, occurredAt: when })).status).toBe(200);
      const txn = await prisma.inventoryTransaction.findFirst({ where: { productId: p.id, warehouseId: wh }, orderBy: { createdAt: 'desc' } });
      expect(near(txn.createdAt)).toBe(true);
    });

    it('a replay with the same idempotency key returns the ORIGINAL record - a different occurredAt never rewrites history', async () => {
      const p = await makeProduct(T.token, { openingStock: 20 });
      const key = uniq('k');
      const first = await post(T.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: key, occurredAt: daysAgo(2).toISOString() }));
      const replay = await post(T.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: key, occurredAt: daysAgo(1).toISOString() }));
      expect(replay.status).toBe(200);
      expect(replay.body.deduplicated).toBe(true);
      expect(replay.body.item.id).toBe(first.body.item.id);
      expect(new Date(replay.body.item.createdAt).getTime()).toBe(new Date(first.body.item.createdAt).getTime());
    });
  });

  describe('Two terminals, one unit of stock (the exact oversell scenario)', () => {
    it('Terminal A replays an offline sale while Terminal B sells the last unit online: exactly one wins, stock never goes negative, the loser is a clean repeatable 409', async () => {
      const p = await makeProduct(T.token, { openingStock: 1 });
      const keyA = uniq('terminal-a');
      const keyB = uniq('terminal-b');
      const results = await Promise.all([
        post(T.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: keyA, occurredAt: daysAgo(0.01).toISOString() })), // A, queued offline
        post(T.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: keyB })), // B, online
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409);
      expect(loser.body.code).toBe('STOCK_INSUFFICIENT');
      expect(Number((await prisma.product.findUnique({ where: { id: p.id } })).stockQuantity)).toBe(0);

      const loserKey = loser === results[0] ? keyA : keyB;
      // Retrying the rejected sale is repeatable and never creates anything while stock is out...
      for (let i = 0; i < 3; i += 1) expect((await post(T.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: loserKey }))).status).toBe(409);
      expect(await prisma.sale.count({ where: { tenantId: T.tenantId, items: { some: { productId: p.id } } } })).toBe(1);

      // ...and once stock arrives it is accepted exactly once, however many times it is replayed.
      await post(T.token, `/api/products/${p.id}/adjust-stock`, { quantity: 1, note: 'restock' });
      const retries = await Promise.all(Array.from({ length: 4 }, () => post(T.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: loserKey }))));
      expect(retries.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(retries.filter((r) => r.status === 201)).toHaveLength(1);
      expect(retries.filter((r) => r.status === 200 && r.body.deduplicated)).toHaveLength(3);
      expect(await prisma.sale.count({ where: { tenantId: T.tenantId, items: { some: { productId: p.id } } } })).toBe(2);
      expect(Number((await prisma.product.findUnique({ where: { id: p.id } })).stockQuantity)).toBe(0);
    });

    it('a stale local figure is not trusted: the cache said 10, the server has 4, a sale of 7 is rejected against the real 4', async () => {
      const p = await makeProduct(T.token, { openingStock: 10 });
      await post(T.token, '/api/sales', saleBody(p.id, 6)); // Terminal B, online
      const res = await post(T.token, '/api/sales', saleBody(p.id, 7, { idempotencyKey: uniq('stale') })); // Terminal A, from its stale cache
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/available: 4/);
      // The server's numbers - what the terminal's next refresh will download - are the truth.
      const manifest = await get(T.token, '/api/offline/datasets/products');
      expect(Number(manifest.body.items.find((x) => x.id === p.id).stockQuantity)).toBe(4);
    });

    it('many terminals racing for limited stock: accepted quantity never exceeds stock, every loser is a 409, nothing is duplicated', async () => {
      const p = await makeProduct(T.token, { openingStock: 5 });
      const jobs = Array.from({ length: 12 }, (_, i) => post(T.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: `race-${p.id}-${i}` })));
      const results = await Promise.all(jobs);
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(results.filter((r) => r.status === 409 && r.body.code === 'STOCK_INSUFFICIENT')).toHaveLength(7);
      expect(Number((await prisma.product.findUnique({ where: { id: p.id } })).stockQuantity)).toBe(0);
    });

    it('a queued warehouse dispatch that the stock no longer supports is a 409 STOCK_INSUFFICIENT and changes nothing', async () => {
      const p = await makeProduct(T.token, { openingStock: 0 });
      const wh = (await post(T.token, '/api/warehouses', { name: uniq('WH') })).body.item.id;
      await post(T.token, `/api/warehouses/${wh}/receive`, { productId: p.id, quantity: 3 });
      const res = await post(T.token, `/api/warehouses/${wh}/dispatch`, { productId: p.id, quantity: 5, idempotencyKey: uniq('d') });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STOCK_INSUFFICIENT');
      expect(Number((await prisma.product.findUnique({ where: { id: p.id } })).stockQuantity)).toBe(3);
    });
  });

  describe('Isolation', () => {
    it('another tenant\'s replay of the same idempotency key is its own operation, and it cannot touch this tenant\'s stock', async () => {
      const U = await registerTenant(uniq('Sync Other'));
      const p = await makeProduct(T.token, { openingStock: 5 });
      const q = await makeProduct(U.token, { openingStock: 5 });
      const key = uniq('shared');
      const a = await post(T.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: key }));
      const b = await post(U.token, '/api/sales', saleBody(q.id, 1, { idempotencyKey: key }));
      expect([a.status, b.status]).toEqual([201, 201]);
      expect((await post(U.token, '/api/sales', saleBody(p.id, 1, { idempotencyKey: uniq('x') }))).status).toBe(404);
      expect(Number((await prisma.product.findUnique({ where: { id: p.id } })).stockQuantity)).toBe(4);
    });
  });
});
