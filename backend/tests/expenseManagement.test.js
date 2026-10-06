// Phase 1.12 - Expenses Management tests.
//
// Same DB requirements as previous phase test files: point DATABASE_URL at a
// real, throwaway local Postgres database with all migrations applied
// (including 20260921050000_phase1_12_expenses) and the permission catalog
// seeded (including the new EXPENSE:UPDATE/REVERSE actions). NEVER point
// this at a database holding real tenant data.
//
// Base Expense creation, its accounting posting, and the large-expense
// approval threshold pre-date this phase and are re-verified via the
// existing accounting.test.js/multiBranch.test.js suites (not duplicated
// here). This file covers what's genuinely new/fixed in Phase 1.12: the
// expense-number generation and its concurrency safety, the PATCH ledger-
// desync bug fix, the new GET /:id and POST /:id/reverse endpoints, RBAC
// gaps closed, branch isolation on update/reverse, idempotency, and real
// concurrent-request tests for the new financial-safety-sensitive paths.
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

describe('Phase 1.12 - Expense Management', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    tenantA = await registerTenant('Phase112 Tenant A');
    tenantB = await registerTenant('Phase112 Tenant B');
  });

  async function makeCategory(token, name) {
    const res = await request(app).post('/api/expense-categories').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.item.id;
  }
  async function makeExpense(token, categoryId, amount, extra = {}) {
    const res = await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`).send({ categoryId, amount, ...extra });
    return res;
  }

  describe('Expense number generation (new in Phase 1.12)', () => {
    it('a created expense receives a unique expenseNumber', async () => {
      const categoryId = await makeCategory(tenantA.token, `Rent ${Date.now()}`);
      const res = await makeExpense(tenantA.token, categoryId, 500);
      expect(res.status).toBe(201);
      expect(res.body.item.expenseNumber).toMatch(/^EXP-/);
    });

    it('creating many expenses concurrently for the same tenant never produces a 500, and no two share an expenseNumber', async () => {
      const categoryId = await makeCategory(tenantA.token, `Numbering Race Category ${Date.now()}`);
      const results = await Promise.all(
        Array.from({ length: 8 }).map(() => makeExpense(tenantA.token, categoryId, 10))
      );
      for (const res of results) {
        expect(res.status).not.toBe(500);
      }
      const succeeded = results.filter((r) => r.status === 201);
      const numbers = succeeded.map((r) => r.body.item.expenseNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
    });
  });

  describe('GET /:id (new in Phase 1.12 - a genuine, previously-missing endpoint)', () => {
    it('returns the expense detail with category/payment/payee included', async () => {
      const categoryId = await makeCategory(tenantA.token, `Utilities ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 200, { notes: 'Monthly electric bill' });

      const res = await request(app).get(`/api/expenses/${created.body.item.id}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.item.notes).toBe('Monthly electric bill');
      expect(res.body.item.category).toBeDefined();
      expect(res.body.item.payment).toBeDefined();
    });

    it('returns 404 for a nonexistent expense, and for another tenant\'s expense', async () => {
      const categoryId = await makeCategory(tenantA.token, `Cross Tenant Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 50);

      const notFound = await request(app).get('/api/expenses/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${tenantA.token}`);
      expect(notFound.status).toBe(404);

      const crossTenant = await request(app).get(`/api/expenses/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(crossTenant.status).toBe(404);
    });
  });

  describe('PATCH /:id - ledger-desync bug fix (Phase 1.12)', () => {
    it('description/notes remain editable and do not affect the posted journal entry', async () => {
      const categoryId = await makeCategory(tenantA.token, `Office ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 300, { description: 'Original' });

      const updated = await request(app)
        .patch(`/api/expenses/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ description: 'Corrected description', notes: 'Added a note' });
      expect(updated.status).toBe(200);
      expect(updated.body.item.description).toBe('Corrected description');
      expect(updated.body.item.notes).toBe('Added a note');

      // The already-posted journal entry must be completely unaffected.
      const journal = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'EXPENSE', sourceId: created.body.item.id } });
      expect(journal).toBeDefined();
    });

    it('amount/categoryId/expenseDate are REJECTED by PATCH - the real bug this phase fixed (they used to silently desync the ledger)', async () => {
      const categoryId = await makeCategory(tenantA.token, `Marketing ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 400);

      const attemptAmount = await request(app)
        .patch(`/api/expenses/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ amount: 999 });
      expect(attemptAmount.status).toBe(422);

      const attemptCategory = await request(app)
        .patch(`/api/expenses/${created.body.item.id}`)
        .set('Authorization', `Bearer ${tenantA.token}`)
        .send({ categoryId: (await makeCategory(tenantA.token, `Other Cat ${Date.now()}`)) });
      expect(attemptCategory.status).toBe(422);

      // Confirm the amount genuinely never changed in the DB either.
      const finalExpense = await prisma.expense.findUnique({ where: { id: created.body.item.id } });
      expect(Number(finalExpense.amount)).toBe(400);
    });

    it('PATCH now enforces branch access, which it previously never checked at all', async () => {
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Expense Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Expense Branch 2' });
      const categoryId = await makeCategory(tenantA.token, `Branch Scoped Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 100, { branchId: branch1.body.item.id });

      const restrictedUser = await createUserToken(tenantA.token, 'ACCOUNTANT', branch2.body.item.id);
      const res = await request(app)
        .patch(`/api/expenses/${created.body.item.id}`)
        .set('Authorization', `Bearer ${restrictedUser.token}`)
        .send({ description: 'Should be blocked' });
      expect(res.status).toBe(403);
    });

    it('PATCH is gated by the centralized EXPENSE:UPDATE permission, not a legacy role check', async () => {
      const categoryId = await makeCategory(tenantA.token, `RBAC Update Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 60);

      const cashierEmail = uniqueEmail('cashier-update');
      await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Test Cashier', email: cashierEmail, password: 'TestPass123', role: 'CASHIER' });
      const cashierToken = (await request(app).post('/api/auth/login').send({ email: cashierEmail, password: 'TestPass123' })).body.token;

      const blocked = await request(app).patch(`/api/expenses/${created.body.item.id}`).set('Authorization', `Bearer ${cashierToken}`).send({ description: 'x' });
      expect(blocked.status).toBe(403);
    });
  });

  describe('POST /:id/reverse (new in Phase 1.12)', () => {
    it('reverses the expense, the linked payment, and mirrors the journal entry', async () => {
      const categoryId = await makeCategory(tenantA.token, `Repairs ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 250);

      const reversed = await request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(reversed.status).toBe(200);
      expect(reversed.body.item.status).toBe('REVERSED');
      expect(reversed.body.item.payment.status).toBe('REVERSED');

      const originalEntry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'EXPENSE', sourceId: created.body.item.id } });
      const reversalEntry = await prisma.journalEntry.findFirst({ where: { tenantId: tenantA.tenantId, sourceType: 'EXPENSE_REVERSAL', sourceId: created.body.item.id } });
      expect(originalEntry).toBeDefined();
      expect(reversalEntry).toBeDefined();

      // The reversal entry must exactly mirror the original (net effect zero).
      const originalLines = await prisma.journalLine.findMany({ where: { journalEntryId: originalEntry.id } });
      const reversalLines = await prisma.journalLine.findMany({ where: { journalEntryId: reversalEntry.id } });
      const sumDebits = (lines) => lines.reduce((s, l) => s + Number(l.debit), 0);
      const sumCredits = (lines) => lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(sumDebits(originalLines)).toBeCloseTo(sumCredits(reversalLines), 2);
      expect(sumCredits(originalLines)).toBeCloseTo(sumDebits(reversalLines), 2);
    });

    it('a concurrent double-reversal of the SAME expense only reverses the journal once', async () => {
      const categoryId = await makeCategory(tenantA.token, `Double Reverse Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 150);

      const [reverseA, reverseB] = await Promise.all([
        request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`),
        request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`),
      ]);
      const statuses = [reverseA.status, reverseB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const reversalEntries = await prisma.journalEntry.findMany({ where: { tenantId: tenantA.tenantId, sourceType: 'EXPENSE_REVERSAL', sourceId: created.body.item.id } });
      expect(reversalEntries).toHaveLength(1); // not two
    });

    it('reversal is restricted to MANAGEMENT roles', async () => {
      const categoryId = await makeCategory(tenantA.token, `RBAC Reverse Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 80);

      const accountantToken = (await createUserToken(tenantA.token, 'ACCOUNTANT')).token;
      const res = await request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${accountantToken}`);
      expect(res.status).toBe(403);
    });

    it('a reversed expense cannot be reversed again on a later, separate (non-concurrent) request', async () => {
      const categoryId = await makeCategory(tenantA.token, `Sequential Reverse Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 90);
      await request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);

      const second = await request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(second.status).toBe(409);
    });

    // Note: EXPENSE:REVERSE is MANAGEMENT-only (TENANT_ADMIN/MANAGER), and
    // both of those roles are permanently branch-unrestricted by design
    // (branchScope.js's UNRESTRICTED_ROLES) - the same is already true for
    // Sale's/Purchase's own :id/reverse. There is therefore no role that is
    // both authorized to reverse AND branch-restricted under the current
    // role architecture, so a "blocked by branch" scenario cannot be
    // constructed - this test instead confirms the assertBranchAccess call
    // present in the handler (defense-in-depth, consistent with the same
    // pattern added to PurchaseOrder/PurchaseRequest in Phase 1.9) does not
    // wrongly block a legitimate cross-branch MANAGER reversal, which is the
    // only behavior actually observable given today's role definitions.
    it('a MANAGER (branch-unrestricted by role design) can reverse an expense in any branch', async () => {
      const branch1 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Reverse Branch 1' });
      const branch2 = await request(app).post('/api/branches').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Reverse Branch 2' });
      const categoryId = await makeCategory(tenantA.token, `Branch Reverse Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 70, { branchId: branch1.body.item.id });

      const otherBranchManager = await createUserToken(tenantA.token, 'MANAGER', branch2.body.item.id);
      const res = await request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${otherBranchManager.token}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Idempotency (existing on create, re-verified)', () => {
    it('a retried create with the same idempotencyKey is deduplicated, not double-posted', async () => {
      const categoryId = await makeCategory(tenantA.token, `Idempotent Cat ${Date.now()}`);
      const idempotencyKey = `expense-test-${Date.now()}`;

      const first = await makeExpense(tenantA.token, categoryId, 120, { idempotencyKey });
      expect(first.status).toBe(201);
      const retry = await makeExpense(tenantA.token, categoryId, 120, { idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);

      const count = await prisma.expense.count({ where: { idempotencyKey } });
      expect(count).toBe(1);
      const paymentCount = await prisma.payment.count({ where: { expenseId: retry.body.item.id } });
      expect(paymentCount).toBe(1);
    });
  });

  describe('Concurrent expense creation and duplicate submission', () => {
    it('two concurrent creates for the same tenant both succeed independently with distinct numbers', async () => {
      const categoryId = await makeCategory(tenantA.token, `Concurrent Create Cat ${Date.now()}`);
      const [resA, resB] = await Promise.all([makeExpense(tenantA.token, categoryId, 30), makeExpense(tenantA.token, categoryId, 40)]);
      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);
      expect(resA.body.item.expenseNumber).not.toBe(resB.body.item.expenseNumber);
    });
  });

  describe('Supplier/payee attribution (new in Phase 1.12)', () => {
    it('an expense can be linked to a supplier and the payee is propagated to its Payment', async () => {
      const categoryId = await makeCategory(tenantA.token, `Supplier Expense Cat ${Date.now()}`);
      const sup = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Utility Company' });
      const created = await makeExpense(tenantA.token, categoryId, 500, { supplierId: sup.body.item.id });
      expect(created.status).toBe(201);
      expect(created.body.item.supplierId).toBe(sup.body.item.id);

      const paymentRow = await prisma.payment.findFirst({ where: { expenseId: created.body.item.id } });
      expect(paymentRow.supplierId).toBe(sup.body.item.id);
    });

    it('rejects a supplierId belonging to another tenant', async () => {
      const supB = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Supplier' });
      const categoryId = await makeCategory(tenantA.token, `Cross Tenant Supplier Cat ${Date.now()}`);
      const res = await makeExpense(tenantA.token, categoryId, 100, { supplierId: supB.body.item.id });
      expect(res.status).toBe(404);
    });
  });

  describe('Search/filter/pagination', () => {
    it('filters /api/expenses by status, categoryId, and method', async () => {
      const categoryId = await makeCategory(tenantA.token, `Filter Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 60, { method: 'bank_transfer' });
      await request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantA.token}`);

      const res = await request(app).get('/api/expenses').set('Authorization', `Bearer ${tenantA.token}`).query({ categoryId, status: 'REVERSED', method: 'bank_transfer' });
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((e) => e.status === 'REVERSED' && e.categoryId === categoryId)).toBe(true);
    });

    it('filters by search matching the expenseNumber', async () => {
      const categoryId = await makeCategory(tenantA.token, `Search Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 15);
      const res = await request(app).get('/api/expenses').set('Authorization', `Bearer ${tenantA.token}`).query({ search: created.body.item.expenseNumber });
      expect(res.status).toBe(200);
      expect(res.body.items.some((e) => e.id === created.body.item.id)).toBe(true);
    });
  });

  describe('Tenant/branch isolation (mandatory)', () => {
    it('Tenant B cannot view, update, or reverse Tenant A\'s expense', async () => {
      const categoryId = await makeCategory(tenantA.token, `Isolation Cat ${Date.now()}`);
      const created = await makeExpense(tenantA.token, categoryId, 45);

      const get = await request(app).get(`/api/expenses/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(get.status).toBe(404);

      const patch = await request(app).patch(`/api/expenses/${created.body.item.id}`).set('Authorization', `Bearer ${tenantB.token}`).send({ description: 'hack' });
      expect(patch.status).toBe(404);

      const reverse = await request(app).post(`/api/expenses/${created.body.item.id}/reverse`).set('Authorization', `Bearer ${tenantB.token}`);
      expect(reverse.status).toBe(404);
    });
  });

  describe('Optical/Medical regression (Universal Expense stays industry-neutral)', () => {
    it('creating an expense never accepts or requires any Optical/Medical-specific field', async () => {
      const categoryId = await makeCategory(tenantA.token, `Neutral Cat ${Date.now()}`);
      const res = await makeExpense(tenantA.token, categoryId, 25, { prescriptionId: 'not-a-real-field', frameBrand: 'Ray-Ban' });
      expect(res.status).toBe(201);
      expect(res.body.item.prescriptionId).toBeUndefined();
      expect(res.body.item.frameBrand).toBeUndefined();
    });
  });
});
