// Phase 5 - Industry Modules. Covers what the Phase 5 audit found genuinely missing
// (not already covered by tests/clinical.test.js, which is re-run unmodified - see
// the Phase 5 report): Optical Order product-linked stock/COGS, a real concurrency
// race on the last frame unit, concurrent order-status updates, a locked terminal
// state, branch/warehouse scoping on optical orders, a clinical visit's appointment
// linked to an ordinary Sale (billing traceability), and medicine expiry (report +
// sale-time prevention).
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(30000);

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}
async function registerTenant(businessName) {
  const res = await request(app).post('/api/auth/register-tenant').send({
    businessName, adminName: 'Test Admin', email: uniqueEmail('admin'), password: 'TestPass123',
  });
  if (res.status !== 201) throw new Error(`register-tenant failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}
async function createUserToken(adminToken, role, branchId) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role, branchId });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return login.body.token;
}

describe('Phase 5 - Industry Modules', () => {
  let tenantA, tenantB, adminA, customerId, frameId, patientId;

  beforeAll(async () => {
    tenantA = await registerTenant(`P5 Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`P5 Tenant B ${Date.now()}`);
    adminA = tenantA.token;

    const cust = await request(app).post('/api/customers').set('Authorization', `Bearer ${adminA}`).send({ name: 'P5 Customer', phone: '03001112222' });
    customerId = cust.body.item.id;
    const pat = await request(app).post('/api/patients').set('Authorization', `Bearer ${adminA}`).send({ customerId });
    patientId = pat.body.item.id;
    const frame = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
      .send({ name: 'P5 Frame', type: 'FRAME', purchasePrice: 40, sellingPrice: 100, openingStock: 5 });
    frameId = frame.body.item.id;
  });

  afterAll(async () => { await prisma.$disconnect(); });

  describe('5.1 Optical order items: stock, COGS, and accounting integration', () => {
    test('an order with a linked frame deducts stock and posts a balanced COGS/Inventory ledger entry', async () => {
      const stockBefore = (await request(app).get(`/api/products/${frameId}`).set('Authorization', `Bearer ${adminA}`)).body.item.stockQuantity;
      const order = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${adminA}`)
        .send({ customerId, items: [{ productId: frameId, quantity: 1, unitPrice: 100 }], totalAmount: 100, amountPaid: 100 });
      expect(order.status).toBe(201);
      const stockAfter = (await request(app).get(`/api/products/${frameId}`).set('Authorization', `Bearer ${adminA}`)).body.item.stockQuantity;
      expect(Number(stockAfter)).toBe(Number(stockBefore) - 1);

      const entry = await prisma.journalEntry.findFirst({ where: { sourceType: 'OPTICAL_ORDER', sourceId: order.body.item.id }, include: { lines: true } });
      expect(entry).not.toBeNull();
      const debit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const credit = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debit).toBeCloseTo(credit, 2);
      const cogsLine = entry.lines.find((l) => Number(l.debit) === 40);
      expect(cogsLine).toBeTruthy();

      const txn = await prisma.inventoryTransaction.findFirst({ where: { productId: frameId, reference: order.body.item.id } });
      expect(txn).not.toBeNull();
      expect(Number(txn.quantity)).toBe(-1);
    });

    test('an order with no items still posts revenue only, exactly as before (backward compatible)', async () => {
      const order = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${adminA}`)
        .send({ customerId, frameDescription: 'Custom off-catalogue frame', totalAmount: 200, amountPaid: 200 });
      expect(order.status).toBe(201);
      const entry = await prisma.journalEntry.findFirst({ where: { sourceType: 'OPTICAL_ORDER', sourceId: order.body.item.id }, include: { lines: true } });
      expect(entry.lines.some((l) => Number(l.debit) > 0 && Number(l.debit) !== 200)).toBe(false); // no stray COGS line
    });

    test('insufficient stock refuses the whole order (nothing partially created)', async () => {
      const before = await prisma.opticalOrder.count({ where: { tenantId: tenantA.tenantId } });
      const res = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${adminA}`)
        .send({ customerId, items: [{ productId: frameId, quantity: 999, unitPrice: 100 }], totalAmount: 99900 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STOCK_INSUFFICIENT');
      const after = await prisma.opticalOrder.count({ where: { tenantId: tenantA.tenantId } });
      expect(after).toBe(before);
    });

    test('concurrency: two optical orders racing for the last unit of a frame - exactly one succeeds', async () => {
      const frame = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
        .send({ name: 'P5 Race Frame', type: 'FRAME', purchasePrice: 20, sellingPrice: 50, openingStock: 1 });
      const raceFrameId = frame.body.item.id;
      const [rA, rB] = await Promise.all([
        request(app).post('/api/optical-orders').set('Authorization', `Bearer ${adminA}`).send({ customerId, items: [{ productId: raceFrameId, quantity: 1, unitPrice: 50 }], totalAmount: 50 }),
        request(app).post('/api/optical-orders').set('Authorization', `Bearer ${adminA}`).send({ customerId, items: [{ productId: raceFrameId, quantity: 1, unitPrice: 50 }], totalAmount: 50 }),
      ]);
      const statuses = [rA.status, rB.status].sort();
      expect(statuses).toEqual([201, 409]);
      const finalStock = (await request(app).get(`/api/products/${raceFrameId}`).set('Authorization', `Bearer ${adminA}`)).body.item.stockQuantity;
      expect(Number(finalStock)).toBe(0);
    });
  });

  describe('5.1 Optical order status: concurrency and terminal-state lock', () => {
    test('concurrency: two simultaneous status updates on the same order - exactly one applies, the other is a clean conflict', async () => {
      const order = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${adminA}`).send({ customerId, frameDescription: 'x', totalAmount: 50 });
      const id = order.body.item.id;
      const [rA, rB] = await Promise.all([
        request(app).patch(`/api/optical-orders/${id}`).set('Authorization', `Bearer ${adminA}`).send({ status: 'IN_LAB' }),
        request(app).patch(`/api/optical-orders/${id}`).set('Authorization', `Bearer ${adminA}`).send({ status: 'CANCELLED' }),
      ]);
      const statuses = [rA.status, rB.status].sort();
      expect(statuses).toEqual([200, 409]);
      const final = await request(app).get(`/api/optical-orders/${id}`).set('Authorization', `Bearer ${adminA}`);
      expect(['IN_LAB', 'CANCELLED']).toContain(final.body.item.status);
    });

    test('a delivered order can no longer be edited', async () => {
      const order = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${adminA}`).send({ customerId, frameDescription: 'x', totalAmount: 50 });
      const id = order.body.item.id;
      await request(app).patch(`/api/optical-orders/${id}`).set('Authorization', `Bearer ${adminA}`).send({ status: 'DELIVERED' });
      const res = await request(app).patch(`/api/optical-orders/${id}`).set('Authorization', `Bearer ${adminA}`).send({ notes: 'too late' });
      expect(res.status).toBe(409);
    });
  });

  describe('5.1/5.4 Branch/warehouse scoping and tenant isolation', () => {
    test('an optical order cannot be created against another tenant\'s branch, warehouse, or product', async () => {
      const branchRes = await request(app).get('/api/branches').set('Authorization', `Bearer ${tenantA.token}`);
      const branchId = branchRes.body.items[0].id;
      const res = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${tenantB.token}`)
        .send({ customerId: (await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'B Cust' })).body.item.id, branchId, totalAmount: 10 });
      expect(res.status).toBe(404);
      const res2 = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${tenantB.token}`)
        .send({ customerId: customerId, items: [{ productId: frameId, quantity: 1, unitPrice: 10 }], totalAmount: 10 });
      expect(res2.status).toBe(404);
    });

    test('tenant B cannot view tenant A\'s optical order', async () => {
      const order = await request(app).post('/api/optical-orders').set('Authorization', `Bearer ${adminA}`).send({ customerId, frameDescription: 'x', totalAmount: 10 });
      const res = await request(app).get(`/api/optical-orders/${order.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('5.2 Clinical visit billing: Sale linked to an Appointment', () => {
    test('a consultation Sale can be tied to the visit that generated it', async () => {
      const doctor = await request(app).post('/api/doctors').set('Authorization', `Bearer ${adminA}`).send({ name: 'Dr. P5' });
      const appt = await request(app).post('/api/appointments').set('Authorization', `Bearer ${adminA}`)
        .send({ patientId, doctorId: doctor.body.item.id, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
      const service = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
        .send({ name: 'Consultation Fee', productKind: 'SERVICE', purchasePrice: 0, sellingPrice: 500, openingStock: 0 });
      // Billing itself stays gated by the existing SALE:CREATE permission (unchanged by
      // this phase) - RECEPTIONIST is a clinical-front-desk role, not a sales role, in
      // this app's RBAC, so a sales-capable role records the charge, same as today.
      const sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${adminA}`)
        .send({ customerId, appointmentId: appt.body.item.id, items: [{ productId: service.body.item.id, quantity: 1, unitPrice: 500 }] });
      expect(sale.status).toBe(201);
      expect(sale.body.item.appointmentId).toBe(appt.body.item.id);
    });

    test('a sale cannot be linked to another tenant\'s appointment', async () => {
      const doctorB = await request(app).post('/api/doctors').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Dr. B' });
      const custB = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'B Cust 2' });
      const patB = await request(app).post('/api/patients').set('Authorization', `Bearer ${tenantB.token}`).send({ customerId: custB.body.item.id });
      const apptB = await request(app).post('/api/appointments').set('Authorization', `Bearer ${tenantB.token}`)
        .send({ patientId: patB.body.item.id, doctorId: doctorB.body.item.id, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
      const service = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
        .send({ name: 'Consultation Fee 2', productKind: 'SERVICE', purchasePrice: 0, sellingPrice: 500, openingStock: 0 });
      const sale = await request(app).post('/api/sales').set('Authorization', `Bearer ${adminA}`)
        .send({ customerId, appointmentId: apptB.body.item.id, items: [{ productId: service.body.item.id, quantity: 1, unitPrice: 500 }] });
      expect(sale.status).toBe(404);
    });
  });

  describe('5.3 Medicine expiry: reporting and sale-time prevention', () => {
    test('the expiry report separates already-expired from merely near-expiry stock', async () => {
      const expired = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
        .send({ name: 'P5 Expired Medicine', type: 'MEDICINE', purchasePrice: 5, sellingPrice: 10, openingStock: 10, expiryDate: '2020-01-01' });
      const nearExpiry = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
        .send({ name: 'P5 Near-Expiry Medicine', type: 'MEDICINE', purchasePrice: 5, sellingPrice: 10, openingStock: 10, expiryDate: new Date(Date.now() + 10 * 86400000).toISOString() });

      const report = await request(app).get('/api/reports/medicine-expiry?withinDays=30').set('Authorization', `Bearer ${adminA}`);
      expect(report.status).toBe(200);
      const expiredRow = report.body.products.find((p) => p.id === expired.body.item.id);
      const nearRow = report.body.products.find((p) => p.id === nearExpiry.body.item.id);
      expect(expiredRow.isExpired).toBe(true);
      expect(nearRow.isExpired).toBe(false);
      expect(report.body.expiredCount).toBeGreaterThanOrEqual(1);
    });

    test('a sale of an already-expired product is refused; the same product before expiry sells fine', async () => {
      const med = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
        .send({ name: 'P5 Sale-Blocked Medicine', type: 'MEDICINE', purchasePrice: 5, sellingPrice: 10, openingStock: 10, expiryDate: '2020-06-15' });
      const blocked = await request(app).post('/api/sales').set('Authorization', `Bearer ${adminA}`)
        .send({ customerId, items: [{ productId: med.body.item.id, quantity: 1, unitPrice: 10 }] });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('PRODUCT_EXPIRED');
      const stockUnchanged = await request(app).get(`/api/products/${med.body.item.id}`).set('Authorization', `Bearer ${adminA}`);
      expect(Number(stockUnchanged.body.item.stockQuantity)).toBe(10);

      const fresh = await request(app).post('/api/products').set('Authorization', `Bearer ${adminA}`)
        .send({ name: 'P5 Fresh Medicine', type: 'MEDICINE', purchasePrice: 5, sellingPrice: 10, openingStock: 10, expiryDate: new Date(Date.now() + 365 * 86400000).toISOString() });
      const ok = await request(app).post('/api/sales').set('Authorization', `Bearer ${adminA}`)
        .send({ customerId, items: [{ productId: fresh.body.item.id, quantity: 1, unitPrice: 10 }] });
      expect(ok.status).toBe(201);
    });

    test('tenant B\'s expiry report never includes tenant A\'s medicines', async () => {
      const report = await request(app).get('/api/reports/medicine-expiry?withinDays=365000').set('Authorization', `Bearer ${tenantB.token}`);
      expect(report.status).toBe(200);
      const aProductIds = new Set((await prisma.product.findMany({ where: { tenantId: tenantA.tenantId } })).map((p) => p.id));
      expect(report.body.products.some((p) => aProductIds.has(p.id))).toBe(false);
    });
  });
});
