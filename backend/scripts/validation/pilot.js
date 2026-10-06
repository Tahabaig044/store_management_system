// Multi-terminal shop pilot, run over REAL HTTP against a running server (see lib.js).
//   BASE_URL=http://localhost:4100/api node scripts/validation/pilot.js
//
// Simulates one shop with 3 point-of-sale terminals plus the owner and asserts that the SERVER stays
// authoritative under the situations offline-first creates: last-unit races, offline queues replayed after
// reconnect (twice, as flaky networks do), stale offline sales against stock that has since run out,
// concurrent payments, duplicate submissions from two terminals, and finally that the books still balance.
// Exit code 0 only if every check passes.
const { call, seedCall, mustOk, registerTenant, createUser, pool, uuid } = require('./lib');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const num = (v) => Number(v);

async function stockOf(token, productId) {
  const r = await mustOk('product', call('GET', `/products/${productId}`, { token }));
  return num(r.data.item.stockQuantity);
}

(async () => {
  const t0 = Date.now();
  const owner = await registerTenant(`Pilot Optical ${Date.now()}`);
  const O = owner.token;
  const branches = await mustOk('branches', call('GET', '/branches', { token: O }));
  const branchId = branches.data.items[0].id;
  const terminals = [];
  for (let i = 0; i < 3; i += 1) terminals.push(await createUser(O, 'CASHIER', branchId));

  // ---- shop data: 200 products, 100 customers --------------------------------------------------------------
  const products = [];
  await pool(Array.from({ length: 200 }, (_, i) => async () => {
    const r = await mustOk('product', seedCall('POST', '/products', { token: O, body: { name: `Frame ${i}`, sku: `FR-${i}-${Date.now()}`, sellingPrice: 50 + (i % 10) * 50, purchasePrice: 30 + (i % 10) * 20, openingStock: 100 } }));
    products.push({ id: r.data.item.id, price: 50 + (i % 10) * 50 });
  }), 10);
  const customers = [];
  await pool(Array.from({ length: 100 }, (_, i) => async () => {
    const r = await mustOk('customer', seedCall('POST', '/customers', { token: O, body: { name: `Customer ${i}`, phone: `0300${String(1000000 + i)}` } }));
    customers.push(r.data.item.id);
  }), 10);
  check('shop seeded (200 products, 100 customers)', products.length === 200 && customers.length === 100);

  const scarce = (await mustOk('scarce', call('POST', '/products', { token: O, body: { name: 'Last Units Frame', sellingPrice: 100, purchasePrice: 50, openingStock: 10 } }))).data.item.id;
  const sale = (token, items, extra = {}) => call('POST', '/sales', { token, body: { items, ...extra } });

  // ---- S1: 60 concurrent sales for the last 10 units, from 3 terminals -------------------------------------
  const s1 = await Promise.all(Array.from({ length: 60 }, (_, i) => sale(terminals[i % 3], [{ productId: scarce, quantity: 1, unitPrice: 100 }], { idempotencyKey: uuid() })));
  const s1ok = s1.filter((r) => r.status === 201 || r.status === 200).length;
  const s1rej = s1.filter((r) => r.status === 409 && r.data?.code === 'STOCK_INSUFFICIENT').length;
  const s1other = s1.length - s1ok - s1rej;
  check('S1 last-unit race: exactly 10 of 60 concurrent sales succeed', s1ok === 10, `ok=${s1ok} rejected=${s1rej} other=${s1other}`);
  check('S1 the other 50 are refused as STOCK_INSUFFICIENT (a conflict the terminal can show), none as 5xx', s1rej === 50 && s1other === 0);
  check('S1 stock is exactly 0, never negative', (await stockOf(O, scarce)) === 0);

  // ---- S2: three terminals replay 40 offline sales each, every request delivered TWICE ---------------------
  const before = new Map();
  const touched = products.slice(0, 40);
  for (const p of touched) before.set(p.id, await stockOf(O, p.id));
  const queues = terminals.map((token, ti) => Array.from({ length: 40 }, (_, k) => {
    const p = touched[(ti * 13 + k) % touched.length];
    const cust = customers[(ti * 31 + k) % customers.length];
    return { token, key: uuid(), body: { customerId: cust, items: [{ productId: p.id, quantity: 1, unitPrice: p.price }], occurredAt: new Date(Date.now() - (40 - k) * 60000).toISOString() }, productId: p.id };
  }));
  const replies = [];
  await Promise.all(queues.map((q) => pool(q.flatMap((e) => [0, 1].map(() => async () => {
    const r = await sale(e.token, e.body.items, { customerId: e.body.customerId, occurredAt: e.body.occurredAt, idempotencyKey: e.key });
    replies.push({ key: e.key, status: r.status, id: r.data?.item?.id, body: r.status >= 300 ? JSON.stringify(r.data).slice(0, 200) : undefined });
  })), 5)));
  const byKey = new Map();
  for (const r of replies) { if (!byKey.has(r.key)) byKey.set(r.key, new Set()); if (r.id) byKey.get(r.key).add(r.id); }
  const allOk = replies.every((r) => r.status === 200 || r.status === 201);
  for (const r of replies.filter((x) => x.status >= 300).slice(0, 6)) console.log(`     S2 non-success: HTTP ${r.status} ${r.body}`);
  check('S2 all 240 deliveries (120 sales x2) are answered successfully', allOk && replies.length === 240, `answered=${replies.filter((r) => r.status < 300).length}/240`);
  check('S2 duplicate delivery returns the SAME sale (120 distinct sales, 1 per key)', byKey.size === 120 && [...byKey.values()].every((s) => s.size === 1));
  let expectedDrop = new Map();
  for (const q of queues) for (const e of q) expectedDrop.set(e.productId, (expectedDrop.get(e.productId) || 0) + 1);
  let stockExact = true; let firstBad = '';
  for (const p of touched) {
    const now = await stockOf(O, p.id);
    if (now !== before.get(p.id) - (expectedDrop.get(p.id) || 0)) { stockExact = false; firstBad = `${p.id}: ${before.get(p.id)} -> ${now}, expected -${expectedDrop.get(p.id) || 0}`; }
  }
  check('S2 stock fell by exactly the number of distinct sales (no double deduction)', stockExact, firstBad);

  // ---- S3: a terminal that was offline replays a sale of the now-sold-out item --------------------------------
  const stale = await sale(terminals[0], [{ productId: scarce, quantity: 1, unitPrice: 100 }], { idempotencyKey: uuid(), occurredAt: new Date(Date.now() - 3600000).toISOString() });
  check('S3 stale offline sale of a sold-out item is refused as a conflict (409 STOCK_INSUFFICIENT)', stale.status === 409 && stale.data?.code === 'STOCK_INSUFFICIENT');
  check('S3 server stock unchanged by the refused sale', (await stockOf(O, scarce)) === 0);

  // ---- S4: 10 concurrent payments of 300 against a 1000 credit sale ---------------------------------------
  const pp = products[150];
  const credit = await mustOk('credit sale', sale(O, [{ productId: pp.id, quantity: 1, unitPrice: 1000 }], { customerId: customers[0], amountPaid: 0, idempotencyKey: uuid() }));
  const saleId = credit.data.item.id;
  const pays = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/payments', { token: terminals[i % 3], body: { direction: 'IN', customerId: customers[0], amount: 300, method: 'cash', idempotencyKey: uuid(), allocations: [{ saleId, amount: 300 }] } })));
  const payOk = pays.filter((r) => r.status === 201 || r.status === 200).length;
  const payBad5xx = pays.filter((r) => r.status >= 500).length;
  const after = await mustOk('sale', call('GET', `/sales/${saleId}`, { token: O }));
  check('S4 concurrent payments never over-collect: exactly 3 x 300 accepted against 1000', payOk === 3 && payBad5xx === 0, `accepted=${payOk} 5xx=${payBad5xx}`);
  check('S4 invoice amountPaid = 900, status PARTIAL', num(after.data.item.amountPaid) === 900 && after.data.item.paymentStatus === 'PARTIAL', `paid=${after.data.item.amountPaid} ${after.data.item.paymentStatus}`);

  // ---- S5: the same sale submitted by two terminals at once (same idempotency key) ------------------------
  const k = uuid();
  const dup = await Promise.all([0, 1, 2].map((i) => sale(terminals[i], [{ productId: products[160].id, quantity: 1, unitPrice: products[160].price }], { idempotencyKey: k })));
  const ids = new Set(dup.map((r) => r.data?.item?.id).filter(Boolean));
  check('S5 one idempotency key from three terminals at once creates exactly one sale', ids.size === 1 && dup.every((r) => r.status < 300), `distinct=${ids.size}`);

  // ---- S6: reversal restores stock -------------------------------------------------------------------------
  const rp = products[170];
  const st0 = await stockOf(O, rp.id);
  const rs = await mustOk('sale', sale(O, [{ productId: rp.id, quantity: 3, unitPrice: rp.price }], { idempotencyKey: uuid() }));
  const rev = await call('POST', `/sales/${rs.data.item.id}/reverse`, { token: O, body: {} });
  check('S6 reversing a sale restores stock exactly', rev.status < 300 && (await stockOf(O, rp.id)) === st0, `reverse=${rev.status}`);

  // ---- S7: terminal reports and the sync monitor -------------------------------------------------------------
  const term = 'pilot-terminal-0001';
  const rep = await call('POST', '/sync/terminal-report', { token: terminals[0], body: { terminalId: term, label: 'Counter 1', sentAt: new Date().toISOString(), counts: { pending: 1, conflict: 1, failed: 0 }, issues: [{ clientId: 'c-1', entity: 'Sale', kind: 'STOCK_INSUFFICIENT', code: 'STOCK_INSUFFICIENT', message: 'Last Units Frame sold out while offline' }], resolved: [] } });
  const issues = await call('GET', '/sync/issues', { token: O });
  check('S7 a terminal reports a conflict and the manager sees it in the sync monitor', rep.status === 200 && JSON.stringify(issues.data).includes('sold out while offline'));
  const forbidden = await call('GET', '/sync/issues', { token: terminals[0] });
  check('S7 a cashier cannot read the manager-only sync issues', forbidden.status === 403);

  // ---- S8: the books after all of the above --------------------------------------------------------------------
  const tb = await mustOk('tb', call('GET', '/accounting/reports/trial-balance', { token: O }));
  const dr = tb.data.rows.reduce((s, r) => s + r.debit, 0); const cr = tb.data.rows.reduce((s, r) => s + r.credit, 0);
  check('S8 trial balance: total debits equal total credits', Math.abs(dr - cr) < 0.005, `debit=${dr} credit=${cr}`);
  const rec = await mustOk('rec', call('GET', '/accounting/reports/reconciliation', { token: O }));
  for (const part of ['receivables', 'payables', 'cash', 'inventory']) {
    check(`S8 reconciliation: ${part} ledger agrees with its sub-ledger/records`, rec.data[part]?.reconciled === true, JSON.stringify(rec.data[part]).slice(0, 160));
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('PILOT ABORTED:', e.message); process.exit(2); });
