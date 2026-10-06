// V1 smoke test: the workflows a shop cannot live without, end to end over real HTTP.
//   BASE_URL=https://erp.example.com/api node scripts/validation/smoke.js
// Run it after every deployment. It creates its own throwaway tenant, so it is safe on staging; on production
// it leaves one clearly-named "SMOKE" tenant behind (deactivate it afterwards) - it never touches other tenants.
// Exit code 0 only if every step passes.
const { call, mustOk, registerTenant, createUser, uuid } = require('./lib');

const steps = [];
async function step(name, fn) {
  try {
    const detail = await fn();
    steps.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    steps.push({ name, ok: false });
    console.log(`FAIL  ${name}  (${e.message})`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const num = (v) => Number(v);

(async () => {
  const ctx = {};
  const cfg = (await call('GET', '/auth/config')).data || {};
  console.log(`server: signupMode=${cfg.signupMode} whatsapp=${cfg.whatsappAvailable} portal=${cfg.portalLoginAvailable} push=${cfg.pushAvailable}`);
  const health = await call('GET', '/health');
  console.log(`health: ${health.status} ${JSON.stringify(health.data)}`);

  await step('register the business and sign in', async () => {
    const t = await registerTenant(`SMOKE ${new Date().toISOString()}`);
    Object.assign(ctx, t);
    const login = await mustOk('login', call('POST', '/auth/login', { body: { email: t.email, password: t.password } }));
    expect(login.data.token && login.data.permissions, 'no token/permissions');
    ctx.token = login.data.token;
    const me = await mustOk('me', call('GET', '/auth/me', { token: ctx.token }));
    expect(me.data.user.email === t.email.toLowerCase(), 'me mismatch');
    ctx.branchId = me.data.branch?.id;
  });

  await step('a wrong password is refused', async () => {
    const r = await call('POST', '/auth/login', { body: { email: ctx.email, password: 'WrongPass999' } });
    expect(r.status === 401, `expected 401 got ${r.status}`);
  });

  await step('create a customer', async () => {
    const r = await mustOk('customer', call('POST', '/customers', { token: ctx.token, body: { name: 'Smoke Customer', phone: '03001234567' } }));
    ctx.customerId = r.data.item.id;
  });

  await step('create a supplier and a product (opening stock 20)', async () => {
    ctx.supplierId = (await mustOk('supplier', call('POST', '/suppliers', { token: ctx.token, body: { name: 'Smoke Supplier' } }))).data.item.id;
    const p = await mustOk('product', call('POST', '/products', { token: ctx.token, body: { name: 'Smoke Frame', sku: `SMK-${Date.now()}`, sellingPrice: 100, purchasePrice: 60, openingStock: 20 } }));
    ctx.productId = p.data.item.id;
  });

  const stock = async () => num((await mustOk('product', call('GET', `/products/${ctx.productId}`, { token: ctx.token }))).data.item.stockQuantity);

  await step('sale: 3 units, stock 20 -> 17, invoice numbered', async () => {
    const r = await mustOk('sale', call('POST', '/sales', { token: ctx.token, body: { items: [{ productId: ctx.productId, quantity: 3, unitPrice: 100 }], customerId: ctx.customerId, amountPaid: 100, idempotencyKey: uuid() } }));
    ctx.saleId = r.data.item.id;
    expect(/^INV-\d{6}$/.test(r.data.item.invoiceNumber), 'invoice number format');
    expect(r.data.item.paymentStatus === 'PARTIAL', `paymentStatus ${r.data.item.paymentStatus}`);
    expect((await stock()) === 17, 'stock not 17');
  });

  await step('payment: settle the remaining 200', async () => {
    const r = await mustOk('payment', call('POST', '/payments', { token: ctx.token, body: { direction: 'IN', customerId: ctx.customerId, amount: 200, method: 'cash', idempotencyKey: uuid(), allocations: [{ saleId: ctx.saleId, amount: 200 }] } }));
    expect(/^RCT-\d{6}$/.test(r.data.item?.receiptNumber || ''), `receipt number missing/invalid: ${JSON.stringify(r.data).slice(0, 120)}`);
    const sale = (await mustOk('sale', call('GET', `/sales/${ctx.saleId}`, { token: ctx.token }))).data.item;
    expect(sale.paymentStatus === 'PAID' && num(sale.amountPaid) === 300, `sale ${sale.paymentStatus} ${sale.amountPaid}`);
  });

  await step('purchase: receive 10 units, stock 17 -> 27', async () => {
    const r = await mustOk('purchase', call('POST', '/purchases', { token: ctx.token, body: { supplierId: ctx.supplierId, items: [{ productId: ctx.productId, quantity: 10, unitCost: 60 }], receiveImmediately: true, idempotencyKey: uuid() } }));
    expect(r.data.item.status === 'RECEIVED', `status ${r.data.item.status}`);
    expect((await stock()) === 27, 'stock not 27');
  });

  await step('inventory movement: manual adjustment -2 with a note, recorded in the stock ledger', async () => {
    await mustOk('adjust', call('POST', `/products/${ctx.productId}/adjust-stock`, { token: ctx.token, body: { quantity: -2, note: 'smoke: damaged', idempotencyKey: uuid() } }));
    expect((await stock()) === 25, 'stock not 25');
    const tx = await mustOk('tx', call('GET', '/inventory/transactions', { token: ctx.token }));
    expect(JSON.stringify(tx.data).includes('smoke: damaged'), 'adjustment not in inventory transactions');
  });

  await step('expense recorded', async () => {
    const cat = await mustOk('cat', call('POST', '/expense-categories', { token: ctx.token, body: { name: `Smoke Rent ${Date.now()}` } }));
    const r = await mustOk('expense', call('POST', '/expenses', { token: ctx.token, body: { categoryId: cat.data.item.id, amount: 500, description: 'smoke rent', idempotencyKey: uuid() } }));
    expect(/^EXP-/.test(r.data.item.expenseNumber), 'expense number');
  });

  await step('sales return: 1 unit back, stock 25 -> 26, credit note issued', async () => {
    const sale = (await mustOk('sale', call('GET', `/sales/${ctx.saleId}`, { token: ctx.token }))).data.item;
    const r = await mustOk('return', call('POST', '/sales-returns', { token: ctx.token, body: { saleId: ctx.saleId, items: [{ saleItemId: sale.items[0].id, quantity: 1 }], reason: 'smoke return' } }));
    expect(/^SRT-/.test(r.data.item.returnNumber), 'return number');
    expect((await stock()) === 26, 'stock not 26');
  });

  await step('accounting: trial balance balances; receivables/payables/cash/inventory reconcile', async () => {
    const tb = (await mustOk('tb', call('GET', '/accounting/reports/trial-balance', { token: ctx.token }))).data;
    const dr = tb.rows.reduce((s, r) => s + r.debit, 0); const cr = tb.rows.reduce((s, r) => s + r.credit, 0);
    expect(Math.abs(dr - cr) < 0.005, `debit ${dr} != credit ${cr}`);
    const rec = (await mustOk('rec', call('GET', '/accounting/reports/reconciliation', { token: ctx.token }))).data;
    for (const k of ['receivables', 'payables', 'cash', 'inventory']) expect(rec[k]?.reconciled === true, `${k} not reconciled`);
    const pl = await mustOk('pl', call('GET', '/accounting/reports/profit-loss', { token: ctx.token }));
    expect(pl.status === 200, 'profit-loss');
    return `debits=credits=${dr}`;
  });

  await step('offline sale: queued with an old timestamp, delivered twice after reconnect = one sale', async () => {
    const key = uuid(); const at = new Date(Date.now() - 2 * 3600000).toISOString();
    const body = { items: [{ productId: ctx.productId, quantity: 1, unitPrice: 100 }], occurredAt: at, idempotencyKey: key };
    const a = await mustOk('first delivery', call('POST', '/sales', { token: ctx.token, body }));
    const b = await mustOk('duplicate delivery', call('POST', '/sales', { token: ctx.token, body }));
    expect(a.data.item.id === b.data.item.id, 'duplicate created a second sale');
    expect((await stock()) === 25, 'stock not 25 after one offline sale');
  });

  await step('sync + conflict: oversell is refused as STOCK_INSUFFICIENT and the terminal reports it to the monitor', async () => {
    const r = await call('POST', '/sales', { token: ctx.token, body: { items: [{ productId: ctx.productId, quantity: 999, unitPrice: 100 }], idempotencyKey: uuid() } });
    expect(r.status === 409 && r.data.code === 'STOCK_INSUFFICIENT', `expected 409 STOCK_INSUFFICIENT got ${r.status}`);
    const rep = await mustOk('report', call('POST', '/sync/terminal-report', { token: ctx.token, body: { terminalId: `smoke-${uuid()}`, label: 'Smoke terminal', sentAt: new Date().toISOString(), counts: { pending: 0, conflict: 1, failed: 0 }, issues: [{ clientId: 'smoke-1', entity: 'Sale', kind: 'STOCK_INSUFFICIENT', code: 'STOCK_INSUFFICIENT', message: 'smoke oversell' }], resolved: [] } }));
    const issues = await mustOk('issues', call('GET', '/sync/issues', { token: ctx.token }));
    expect(JSON.stringify(issues.data).includes('smoke oversell'), 'issue not visible to the manager');
    const manifest = await mustOk('manifest', call('GET', '/offline/manifest', { token: ctx.token }));
    expect(manifest.data.datasets.products, 'manifest lacks products');
  });

  await step('owner dashboard (web command center + owner mobile API)', async () => {
    const web = await mustOk('command center', call('GET', '/dashboard/command-center', { token: ctx.token }));
    expect(web.status === 200, 'command center');
    const m = await mustOk('mobile login', call('POST', '/mobile/v1/auth/login', { body: { email: ctx.email, password: ctx.password, deviceId: `smoke-${uuid()}` } }));
    const sum = await mustOk('mobile summary', call('GET', '/mobile/v1/dashboard/summary', { token: m.data.token }));
    expect(sum.status === 200, 'mobile summary');
    const write = await call('POST', '/mobile/v1/dashboard/summary', { token: m.data.token, body: {} });
    expect(write.status >= 400 && write.status < 500, `mobile write not refused (${write.status})`);
  });

  await step('isolation: a second business cannot see the first one\'s data', async () => {
    const other = await registerTenant(`SMOKE other ${Date.now()}`);
    const r = await call('GET', `/products/${ctx.productId}`, { token: other.token });
    expect(r.status === 404, `expected 404 got ${r.status}`);
    const sale = await call('POST', '/sales', { token: other.token, body: { items: [{ productId: ctx.productId, quantity: 1, unitPrice: 1 }] } });
    expect(sale.status === 404, `expected 404 got ${sale.status}`);
  });

  await step('cashier permissions: cannot reach accounting or user management', async () => {
    const cashier = await createUser(ctx.token, 'CASHIER', ctx.branchId);
    expect((await call('GET', '/users', { token: cashier })).status === 403, 'cashier can list users');
    expect([401, 403].includes((await call('GET', '/accounting/reports/trial-balance', { token: cashier })).status), 'cashier can read trial balance');
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\nSMOKE ${failed.length ? 'FAILED' : 'PASSED'}: ${steps.length - failed.length}/${steps.length} steps`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE ABORTED:', e.message); process.exit(2); });
