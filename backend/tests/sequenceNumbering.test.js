// Document numbers are drawn from an atomic per-tenant counter: a burst of simultaneous creates must all succeed
// with distinct numbers, and a rolled-back document must not burn a number.
const supertest = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { nextSequenceNumber } = require('../src/utils/sequenceNumber');

jest.setTimeout(120000);

const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const api = (m, p, token, body) => {
  const r = supertest(app)[m](p).set('X-Forwarded-For', ip());
  if (token) r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};

let token; let tenantId; let productId; let scarceId;
beforeAll(async () => {
  const reg = await api('post', '/api/auth/register-tenant', null, { businessName: `Seq ${Date.now()}`, adminName: 'Seq Admin', email: `seq-${Date.now()}@test.local`, password: 'GoodPass123' });
  token = reg.body.token; tenantId = reg.body.tenant.id;
  productId = (await api('post', '/api/products', token, { name: 'Bulk Frame', sellingPrice: 10, purchasePrice: 5, openingStock: 5000 })).body.item.id;
  scarceId = (await api('post', '/api/products', token, { name: 'One Left', sellingPrice: 10, purchasePrice: 5, openingStock: 1 })).body.item.id;
});

test('100 simultaneous sales all succeed with distinct invoice and journal numbers', async () => {
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => api('post', '/api/sales', token, {
    items: [{ productId, quantity: 1, unitPrice: 10 }], idempotencyKey: `burst-${i}-${Date.now()}`,
  })));
  expect(rs.filter((r) => r.status !== 201).map((r) => `${r.status} ${JSON.stringify(r.body)}`)).toEqual([]);
  const invoices = new Set(rs.map((r) => r.body.item.invoiceNumber));
  expect(invoices.size).toBe(100);
  const entries = await prisma.journalEntry.findMany({ where: { tenantId }, select: { entryNumber: true } });
  expect(new Set(entries.map((e) => e.entryNumber)).size).toBe(entries.length);
});

test('a refused (rolled-back) sale does not consume a number', async () => {
  const first = await api('post', '/api/sales', token, { items: [{ productId: scarceId, quantity: 1, unitPrice: 10 }], idempotencyKey: `s1-${Date.now()}` });
  expect(first.status).toBe(201);
  const refused = await api('post', '/api/sales', token, { items: [{ productId: scarceId, quantity: 1, unitPrice: 10 }], idempotencyKey: `s2-${Date.now()}` });
  expect(refused.status).toBe(409);
  const next = await api('post', '/api/sales', token, { items: [{ productId, quantity: 1, unitPrice: 10 }], idempotencyKey: `s3-${Date.now()}` });
  const n = (inv) => Number(inv.split('-')[1]);
  expect(n(next.body.item.invoiceNumber)).toBe(n(first.body.item.invoiceNumber) + 1);
});

test('the counter never falls behind existing rows (self-heals for numbers issued before it existed)', async () => {
  await prisma.sequenceCounter.deleteMany({ where: { tenantId } });
  const number = await prisma.$transaction((tx) => nextSequenceNumber(tx.sale, tenantId, 'INV', { tx }));
  const count = await prisma.sale.count({ where: { tenantId } });
  expect(Number(number.split('-')[1])).toBe(count + 1);
});
