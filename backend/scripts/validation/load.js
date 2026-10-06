// Practical load test over REAL HTTP against a running server (see lib.js). Not an enterprise benchmark: it
// answers "does one server hold up under a busy multi-terminal shop day, and where is it slowest?"
//   DATABASE_URL=<the SAME disposable db the server uses> BASE_URL=http://localhost:4100/api \
//     USERS=40 SECONDS=30 node scripts/validation/load.js
//
// Data: one tenant with PRODUCTS (default 3000) products and 500 customers, inserted straight into the
// database so seeding does not depend on the API rate limit. Traffic: USERS concurrent cashiers/managers, each
// looping over a realistic mix at a human-plausible pace (default ~3 requests/s per user, under the API's
// 300 requests/minute per-user ceiling, so the numbers are the server's, not the limiter's).
const { PrismaClient } = require('@prisma/client');
const { call, mustOk, registerTenant, createUser, pool, percentile, uuid } = require('./lib');

const USERS = parseInt(process.env.USERS || '40', 10);
const SECONDS = parseInt(process.env.SECONDS || '30', 10);
const PRODUCTS = parseInt(process.env.PRODUCTS || '3000', 10);
const GAP_MS = parseInt(process.env.GAP_MS || '330', 10);

const stats = new Map(); // flow -> { ms: [], errors: n, statuses: {} }
function record(flow, r) {
  if (!stats.has(flow)) stats.set(flow, { ms: [], errors: 0, statuses: {} });
  const s = stats.get(flow);
  s.ms.push(r.ms);
  s.statuses[r.status] = (s.statuses[r.status] || 0) + 1;
  // 409 STOCK_INSUFFICIENT / 4xx business refusals are correct behaviour; only 5xx and 429 are failures here.
  if (r.status >= 500 || r.status === 429 || r.status === 0) s.errors += 1;
}
const timed = async (flow, p) => { const r = await p; record(flow, r); return r; };

(async () => {
  const prisma = new PrismaClient();
  const owner = await registerTenant(`Load Shop ${Date.now()}`);
  const O = owner.token;
  const tenantId = owner.tenantId;
  const branchId = (await mustOk('branches', call('GET', '/branches', { token: O }))).data.items[0].id;

  await prisma.product.createMany({
    data: Array.from({ length: PRODUCTS }, (_, i) => ({
      tenantId, name: `Item ${i} ${['Frame', 'Lens', 'Drop', 'Case'][i % 4]}`, sku: `LD-${i}`, barcode: `890${String(100000 + i)}`,
      purchasePrice: 40 + (i % 20), sellingPrice: 100 + (i % 50) * 10, stockQuantity: 100000, lowStockThreshold: 5,
    })),
  });
  await prisma.customer.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ tenantId, name: `Load Customer ${i}`, phone: `0311${String(1000000 + i)}` })) });
  const productIds = (await prisma.product.findMany({ where: { tenantId }, select: { id: true, sellingPrice: true }, take: 500 })).map((p) => ({ id: p.id, price: Number(p.sellingPrice) }));
  const customerIds = (await prisma.customer.findMany({ where: { tenantId }, select: { id: true }, take: 100 })).map((c) => c.id);
  console.log(`seeded ${PRODUCTS} products, 500 customers; creating ${USERS} users ...`);

  const users = await pool(Array.from({ length: USERS }, (_, i) => async () => ({ token: await createUser(O, i % 8 === 0 ? 'MANAGER' : 'CASHIER', branchId), manager: i % 8 === 0 })), 6);

  // ---- login burst (bcrypt is CPU-heavy): everyone signs in at once -----------------------------------------------
  const loginEmails = users.length; // logins re-use users created above via their tokens' tenant; measure fresh logins
  const owners = await Promise.all(Array.from({ length: 20 }, () => timed('login (20 at once)', call('POST', '/auth/login', { body: { email: owner.email, password: owner.password } }))));
  console.log(`login burst: ${owners.filter((r) => r.status === 200).length}/20 ok (${loginEmails} users active)`);

  // ---- steady mixed traffic ------------------------------------------------------------------------------------------
  const stopAt = Date.now() + SECONDS * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const creditSales = [];
  async function virtualUser(u, idx) {
    while (Date.now() < stopAt) {
      const roll = Math.random();
      const pick = () => productIds[Math.floor(Math.random() * productIds.length)];
      if (roll < 0.45) {
        const n = 1 + Math.floor(Math.random() * 3);
        const items = Array.from({ length: n }, () => { const p = pick(); return { productId: p.id, quantity: 1, unitPrice: p.price }; });
        const credit = Math.random() < 0.15;
        const r = await timed('POS sale', call('POST', '/sales', { token: u.token, body: { items, idempotencyKey: uuid(), ...(credit ? { customerId: customerIds[idx % customerIds.length], amountPaid: 0 } : {}) } }));
        if (credit && r.status === 201) creditSales.push({ id: r.data.item.id, customerId: customerIds[idx % customerIds.length], token: u.token });
      } else if (roll < 0.62) {
        await timed('product search/list', call('GET', `/products?search=Frame&pageSize=50&page=${1 + Math.floor(Math.random() * 20)}`, { token: u.token }));
      } else if (roll < 0.72) {
        await timed('product detail (inventory)', call('GET', `/products/${pick().id}`, { token: u.token }));
      } else if (roll < 0.82) {
        await timed('sync manifest', call('GET', '/offline/manifest', { token: u.token }));
      } else if (roll < 0.88) {
        const cs = creditSales.pop();
        if (cs) await timed('payment', call('POST', '/payments', { token: cs.token, body: { direction: 'IN', customerId: cs.customerId, amount: 50, method: 'cash', idempotencyKey: uuid(), allocations: [{ saleId: cs.id, amount: 50 }] } }));
      } else if (roll < 0.94 && u.manager) {
        await timed('dashboard (command center)', call('GET', '/dashboard/command-center', { token: u.token }));
      } else if (roll < 0.97 && u.manager) {
        await timed('report: trial balance', call('GET', '/accounting/reports/trial-balance', { token: u.token }));
      } else {
        await timed('sales history', call('GET', '/sales?pageSize=25', { token: u.token }));
      }
      await sleep(GAP_MS + Math.random() * 100);
    }
  }
  const t0 = Date.now();
  await Promise.all(users.map((u, i) => virtualUser(u, i)));
  const wall = (Date.now() - t0) / 1000;

  // ---- report ----------------------------------------------------------------------------------------------------------
  let total = 0; let errors = 0;
  console.log(`\n${USERS} users, ${wall.toFixed(0)}s\n`);
  console.log('flow'.padEnd(30), 'n'.padStart(6), 'p50'.padStart(8), 'p95'.padStart(8), 'p99'.padStart(8), 'max'.padStart(8), 'errors'.padStart(7));
  for (const [flow, s] of [...stats.entries()].sort()) {
    const sorted = s.ms.slice().sort((a, b) => a - b);
    total += sorted.length; errors += s.errors;
    console.log(flow.padEnd(30), String(sorted.length).padStart(6), `${percentile(sorted, 50).toFixed(0)}ms`.padStart(8), `${percentile(sorted, 95).toFixed(0)}ms`.padStart(8), `${percentile(sorted, 99).toFixed(0)}ms`.padStart(8), `${sorted[sorted.length - 1].toFixed(0)}ms`.padStart(8), String(s.errors).padStart(7));
  }
  console.log(`\ntotal ${total} requests, ${(total / wall).toFixed(1)} req/s, ${errors} failures (5xx/429)`);
  console.log('status codes:', JSON.stringify(Object.fromEntries([...stats.entries()].map(([f, s]) => [f, s.statuses]))));

  // Integrity after load: books balance and stock ledger agrees.
  const tb = await mustOk('tb', call('GET', '/accounting/reports/trial-balance', { token: O }));
  const dr = tb.data.rows.reduce((s, r) => s + r.debit, 0); const cr = tb.data.rows.reduce((s, r) => s + r.credit, 0);
  console.log(`\nafter load: trial balance debit=${dr} credit=${cr} -> ${Math.abs(dr - cr) < 0.005 ? 'BALANCED' : 'UNBALANCED'}`);
  const rec = await mustOk('rec', call('GET', '/accounting/reports/reconciliation', { token: O }));
  console.log('after load: reconciliation', ['receivables', 'payables', 'cash'].map((k) => `${k}=${rec.data[k]?.reconciled}`).join(' '));

  await prisma.$disconnect();
  process.exit(errors === 0 && Math.abs(dr - cr) < 0.005 ? 0 : 1);
})().catch((e) => { console.error('LOAD TEST ABORTED:', e.stack || e.message); process.exit(2); });
