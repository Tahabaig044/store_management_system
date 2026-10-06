// Phase 2.1 - Chart of Accounts & General Ledger tests.
//
// Needs DATABASE_URL pointed at a real, throwaway Postgres database with all
// migrations applied (including 20260924000000_phase2_1_...) and the
// permission catalog seeded (ACCOUNT / OPENING_BALANCE / extended JOURNAL).
// Existing Phase 5 accounting behavior (posting from Sale/Purchase/Expense/...)
// is covered by accounting.test.js; this file covers what Phase 2.1 added or
// fixed, plus the concurrency behavior of the new services.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(40000);

// Each jest file builds its own Prisma pool; release it so a full --runInBand
// run does not accumulate connections until Postgres refuses new ones.
afterAll(async () => {
  await prisma.$disconnect();
});

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: uniqueEmail('admin'), password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id, permissions: res.body.permissions };
}

async function roleToken(adminToken, role) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`).send({ name: role, email, password: 'TestPass123', role });
  if (created.status !== 201) throw new Error(`user create failed ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return { token: login.body.token, permissions: login.body.permissions };
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});
const patch = (t, path, body) => request(app).patch(path).set(auth(t)).send(body || {});
const del = (t, path) => request(app).delete(path).set(auth(t));

async function chart(t) {
  const res = await get(t, '/api/accounting/accounts', { includeInactive: 'true' });
  return Object.fromEntries(res.body.items.map((a) => [a.code, a]));
}

async function trialBalance(t) {
  const res = await get(t, '/api/accounting/reports/trial-balance');
  return res.body;
}

function tbRow(tb, code) {
  return tb.rows.find((r) => r.code === code);
}

// The trial balance omits accounts whose net balance is zero, so an absent row
// means zero.
function tbNet(tb, code) {
  const row = tbRow(tb, code);
  return row ? Number(row.debit) - Number(row.credit) : 0;
}

const lines2 = (debitId, creditId, amount) => [
  { accountId: debitId, debit: amount },
  { accountId: creditId, credit: amount },
];

describe('Phase 2.1 - Chart of Accounts & General Ledger', () => {
  let A;
  let B;
  let acctA; // accountant token
  let mgrA;
  let cashierA;
  let coa; // tenant A chart by code

  beforeAll(async () => {
    A = await registerTenant('P21 Tenant A');
    B = await registerTenant('P21 Tenant B');
    acctA = (await roleToken(A.token, 'ACCOUNTANT')).token;
    mgrA = (await roleToken(A.token, 'MANAGER')).token;
    cashierA = (await roleToken(A.token, 'CASHIER')).token;
    coa = await chart(A.token);
  });

  describe('Chart of Accounts', () => {
    it('provisions the default chart with a hierarchy, and /tree returns it nested with balances', async () => {
      const res = await get(A.token, '/api/accounting/accounts/tree', { withBalances: 'true' });
      expect(res.status).toBe(200);
      const assets = res.body.items.find((n) => n.code === '1000');
      expect(assets.type).toBe('ASSET');
      expect(assets.children.map((c) => c.code)).toEqual(expect.arrayContaining(['1010', '1020', '1030']));
      expect(assets).toHaveProperty('rolledUpBalance');
      // The five top-level categories exist.
      expect(res.body.items.map((n) => n.type).sort()).toEqual(['ASSET', 'EQUITY', 'EXPENSE', 'LIABILITY', 'REVENUE']);
    });

    it('creates parent/child accounts of the same type and rejects a duplicate code (409) in the same tenant only', async () => {
      const parent = await post(A.token, '/api/accounting/accounts', { code: '1100', name: 'Fixed Assets', type: 'ASSET', parentId: coa['1000'].id, description: 'Long-lived' });
      expect(parent.status).toBe(201);
      expect(parent.body.item.description).toBe('Long-lived');
      const child = await post(A.token, '/api/accounting/accounts', { code: '1110', name: 'Equipment', type: 'ASSET', parentId: parent.body.item.id });
      expect(child.status).toBe(201);

      const dup = await post(A.token, '/api/accounting/accounts', { code: '1100', name: 'Dup', type: 'ASSET' });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toMatch(/already in use/);
      // Same code in another tenant is fine.
      const other = await post(B.token, '/api/accounting/accounts', { code: '1100', name: 'Fixed Assets', type: 'ASSET' });
      expect(other.status).toBe(201);
    });

    it('rejects a parent of a different type, a cross-tenant parent, and an inactive parent', async () => {
      const wrongType = await post(A.token, '/api/accounting/accounts', { code: '1200', name: 'Bad', type: 'LIABILITY', parentId: coa['1000'].id });
      expect(wrongType.status).toBe(422);
      const bParent = (await post(B.token, '/api/accounting/accounts', { code: '1900', name: 'B parent', type: 'ASSET' })).body.item;
      const crossTenant = await post(A.token, '/api/accounting/accounts', { code: '1201', name: 'Bad', type: 'ASSET', parentId: bParent.id });
      expect(crossTenant.status).toBe(404);
      const inactive = (await post(A.token, '/api/accounting/accounts', { code: '1210', name: 'Dormant', type: 'ASSET' })).body.item;
      await patch(A.token, `/api/accounting/accounts/${inactive.id}`, { isActive: false });
      const underInactive = await post(A.token, '/api/accounting/accounts', { code: '1211', name: 'Under dormant', type: 'ASSET', parentId: inactive.id });
      expect(underInactive.status).toBe(409);
    });

    it('prevents cycles and self-parenting when re-parenting; type is immutable; system accounts keep their parent', async () => {
      const a = (await post(A.token, '/api/accounting/accounts', { code: '1300', name: 'Cyc A', type: 'ASSET' })).body.item;
      const b = (await post(A.token, '/api/accounting/accounts', { code: '1310', name: 'Cyc B', type: 'ASSET', parentId: a.id })).body.item;
      const cycle = await patch(A.token, `/api/accounting/accounts/${a.id}`, { parentId: b.id });
      expect(cycle.status).toBe(422);
      const self = await patch(A.token, `/api/accounting/accounts/${a.id}`, { parentId: a.id });
      expect(self.status).toBe(422);
      const typeChange = await patch(A.token, `/api/accounting/accounts/${a.id}`, { type: 'LIABILITY' });
      expect(typeChange.status).toBe(422);
      const systemMove = await patch(A.token, `/api/accounting/accounts/${coa['1010'].id}`, { parentId: a.id });
      expect(systemMove.status).toBe(409);
      const ok = await patch(A.token, `/api/accounting/accounts/${b.id}`, { parentId: null, name: 'Cyc B renamed' });
      expect(ok.status).toBe(200);
      expect(ok.body.item.parentId).toBeNull();
    });

    it('re-coding to an existing code is rejected', async () => {
      const x = (await post(A.token, '/api/accounting/accounts', { code: '1400', name: 'X', type: 'ASSET' })).body.item;
      const clash = await patch(A.token, `/api/accounting/accounts/${x.id}`, { code: '1010' });
      expect(clash.status).toBe(409);
    });

    it('deactivation is blocked for a non-zero balance and for active sub-accounts; delete is blocked once any journal line exists', async () => {
      const acct = (await post(A.token, '/api/accounting/accounts', { code: '1500', name: 'Petty', type: 'ASSET' })).body.item;
      await post(A.token, '/api/accounting/journal', { memo: 'fund petty', lines: lines2(acct.id, coa['3010'].id, 75) });

      const blockedBal = await patch(A.token, `/api/accounting/accounts/${acct.id}`, { isActive: false });
      expect(blockedBal.status).toBe(409);
      expect(blockedBal.body.error).toMatch(/non-zero balance/);
      const blockedDelete = await del(A.token, `/api/accounting/accounts/${acct.id}`);
      expect(blockedDelete.status).toBe(409);

      // Zero it out -> deactivation becomes safe; delete stays blocked (lines exist).
      await post(A.token, '/api/accounting/journal', { memo: 'drain petty', lines: lines2(coa['3010'].id, acct.id, 75) });
      const off = await patch(A.token, `/api/accounting/accounts/${acct.id}`, { isActive: false });
      expect(off.status).toBe(200);
      expect((await del(A.token, `/api/accounting/accounts/${acct.id}`)).status).toBe(409);

      const parent = (await post(A.token, '/api/accounting/accounts', { code: '1510', name: 'P', type: 'ASSET' })).body.item;
      await post(A.token, '/api/accounting/accounts', { code: '1511', name: 'C', type: 'ASSET', parentId: parent.id });
      expect((await patch(A.token, `/api/accounting/accounts/${parent.id}`, { isActive: false })).status).toBe(409);

      // A never-used account can be deleted.
      const unused = (await post(A.token, '/api/accounting/accounts', { code: '1520', name: 'Unused', type: 'ASSET' })).body.item;
      expect((await del(A.token, `/api/accounting/accounts/${unused.id}`)).status).toBe(204);
    });

    it('a deactivated account cannot be posted to until reactivated', async () => {
      const acct = (await post(A.token, '/api/accounting/accounts', { code: '1600', name: 'Dormant2', type: 'ASSET' })).body.item;
      await patch(A.token, `/api/accounting/accounts/${acct.id}`, { isActive: false });
      const blocked = await post(A.token, '/api/accounting/journal', { lines: lines2(acct.id, coa['3010'].id, 10) });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/inactive/);
      await patch(A.token, `/api/accounting/accounts/${acct.id}`, { isActive: true });
      const ok = await post(A.token, '/api/accounting/journal', { lines: lines2(acct.id, coa['3010'].id, 10) });
      expect(ok.status).toBe(201);
    });

    it('GET /:id returns balance and line count; the list supports type/search filters', async () => {
      const cash = await get(A.token, `/api/accounting/accounts/${coa['1010'].id}`);
      expect(cash.status).toBe(200);
      expect(cash.body.item).toHaveProperty('balance');
      expect(cash.body.item).toHaveProperty('lineCount');
      const filtered = await get(A.token, '/api/accounting/accounts', { type: 'LIABILITY', search: 'payable' });
      expect(filtered.body.items.length).toBeGreaterThan(0);
      expect(filtered.body.items.every((a) => a.type === 'LIABILITY')).toBe(true);
    });

    it('RBAC: CASHIER cannot view; ACCOUNTANT can view but not create/update/delete; MANAGER can write', async () => {
      expect((await get(cashierA, '/api/accounting/accounts')).status).toBe(403);
      expect((await get(cashierA, '/api/accounting/accounts/tree')).status).toBe(403);
      expect((await get(acctA, '/api/accounting/accounts')).status).toBe(200);
      expect((await post(acctA, '/api/accounting/accounts', { code: '9001', name: 'Nope', type: 'ASSET' })).status).toBe(403);
      expect((await patch(acctA, `/api/accounting/accounts/${coa['1010'].id}`, { name: 'Nope' })).status).toBe(403);
      expect((await del(acctA, `/api/accounting/accounts/${coa['1010'].id}`)).status).toBe(403);
      expect((await post(mgrA, '/api/accounting/accounts', { code: '9002', name: 'Mgr acct', type: 'EXPENSE' })).status).toBe(201);
    });

    it('tenant isolation: tenant B cannot read, change or delete tenant A accounts, and its tree contains only its own', async () => {
      expect((await get(B.token, `/api/accounting/accounts/${coa['1010'].id}`)).status).toBe(404);
      expect((await patch(B.token, `/api/accounting/accounts/${coa['1010'].id}`, { name: 'hijack' })).status).toBe(404);
      expect((await del(B.token, `/api/accounting/accounts/${coa['1010'].id}`)).status).toBe(404);
      const tree = await get(B.token, '/api/accounting/accounts/tree');
      const ids = JSON.stringify(tree.body.items);
      expect(ids).not.toContain(coa['1010'].id);
    });

    it('creating/updating accounts is written to the audit log', async () => {
      const entry = await prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'ACCOUNT_CREATE' } });
      expect(entry).not.toBeNull();
    });

    it('the default chart stays industry-neutral: Phase 2.1 adds no Optical/Medical/Pharmacy/Clinic/Lens accounts', async () => {
      const fresh = await registerTenant('P21 Neutral Chart');
      const accounts = await chart(fresh.token);
      expect(Object.keys(accounts)).toHaveLength(19); // 18 from Phase 2.1 + Inventory Adjustments (Phase 2.4)
      const industry = Object.values(accounts).filter((a) => /lens|clinic|pharmac|medic|frame|patient/i.test(a.name));
      expect(industry).toHaveLength(0);
    });
  });

  describe('Journal entries: posting, balance rules', () => {
    it('posts a balanced manual entry immediately (POSTED, postedAt, reference) and it hits the trial balance', async () => {
      const before = tbRow(await trialBalance(A.token), '1010');
      const res = await post(A.token, '/api/accounting/journal', { memo: 'Owner injection', reference: 'VCH-1', lines: lines2(coa['1010'].id, coa['3010'].id, 500) });
      expect(res.status).toBe(201);
      expect(res.body.item.status).toBe('POSTED');
      expect(res.body.item.reference).toBe('VCH-1');
      expect(res.body.item.postedAt).toBeTruthy();
      const after = tbRow(await trialBalance(A.token), '1010');
      expect(Number(after.debit) - Number(after.credit)).toBeCloseTo(Number(before?.debit || 0) - Number(before?.credit || 0) + 500, 2);
    });

    it('rejects unbalanced, one-sided/both-sided, single-line, zero-amount and negative entries', async () => {
      const cases = [
        [{ accountId: coa['1010'].id, debit: 100 }, { accountId: coa['3010'].id, credit: 90 }],
        [{ accountId: coa['1010'].id, debit: 100, credit: 100 }, { accountId: coa['3010'].id, credit: 0 }],
        [{ accountId: coa['1010'].id, debit: 0 }, { accountId: coa['3010'].id, credit: 0 }],
        [{ accountId: coa['1010'].id, debit: 100 }],
        [{ accountId: coa['1010'].id, debit: -5 }, { accountId: coa['3010'].id, credit: 5 }],
      ];
      for (const lines of cases) {
        const res = await post(A.token, '/api/accounting/journal', { lines });
        expect(res.status).toBe(422);
      }
    });

    it('rejects an unknown account (404) and a customer/supplier reference from another tenant', async () => {
      const bogus = await post(A.token, '/api/accounting/journal', { lines: lines2('11111111-1111-4111-8111-111111111111', coa['3010'].id, 5) });
      expect(bogus.status).toBe(404);
      const bCustomer = (await post(B.token, '/api/customers', { name: 'B cust' })).body.item;
      const cross = await post(A.token, '/api/accounting/journal', {
        lines: [{ accountId: coa['1030'].id, debit: 5, customerId: bCustomer.id }, { accountId: coa['3010'].id, credit: 5 }],
      });
      expect(cross.status).toBe(404);
    });

    it('RBAC: ACCOUNTANT/CASHIER cannot create, edit, post, cancel or reverse; ACCOUNTANT can view', async () => {
      const draft = (await post(A.token, '/api/accounting/journal', { draft: true, lines: lines2(coa['1010'].id, coa['3010'].id, 20) })).body.item;
      for (const t of [acctA, cashierA]) {
        expect((await post(t, '/api/accounting/journal', { lines: lines2(coa['1010'].id, coa['3010'].id, 1) })).status).toBe(403);
        expect((await patch(t, `/api/accounting/journal/${draft.id}`, { memo: 'x' })).status).toBe(403);
        expect((await post(t, `/api/accounting/journal/${draft.id}/post`)).status).toBe(403);
        expect((await post(t, `/api/accounting/journal/${draft.id}/cancel`)).status).toBe(403);
        expect((await post(t, `/api/accounting/journal/${draft.id}/reverse`)).status).toBe(403);
      }
      expect((await get(acctA, '/api/accounting/journal')).status).toBe(200);
      expect((await get(cashierA, '/api/accounting/journal')).status).toBe(403);
    });

    it('tenant isolation: tenant B cannot see, post, cancel or reverse tenant A entries', async () => {
      const e = (await post(A.token, '/api/accounting/journal', { lines: lines2(coa['1010'].id, coa['3010'].id, 7) })).body.item;
      const d = (await post(A.token, '/api/accounting/journal', { draft: true, lines: lines2(coa['1010'].id, coa['3010'].id, 7) })).body.item;
      expect((await get(B.token, `/api/accounting/journal/${e.id}`)).status).toBe(404);
      expect((await post(B.token, `/api/accounting/journal/${e.id}/reverse`)).status).toBe(404);
      expect((await post(B.token, `/api/accounting/journal/${d.id}/post`)).status).toBe(404);
      expect((await post(B.token, `/api/accounting/journal/${d.id}/cancel`)).status).toBe(404);
      const list = await get(B.token, '/api/accounting/journal');
      expect(list.body.items.find((x) => x.id === e.id)).toBeUndefined();
    });
  });

  describe('Draft / post workflow', () => {
    it('a draft may be unbalanced, is invisible to the ledger, can be edited, and posts only once balanced', async () => {
      const draft = await post(A.token, '/api/accounting/journal', { draft: true, memo: 'wip', lines: [{ accountId: coa['1010'].id, debit: 100 }, { accountId: coa['3010'].id, credit: 60 }] });
      expect(draft.status).toBe(201);
      expect(draft.body.item.status).toBe('DRAFT');
      expect(draft.body.item.postedAt).toBeNull();
      const id = draft.body.item.id;

      const tbBefore = tbRow(await trialBalance(A.token), '1010');
      // Unbalanced draft cannot be posted, and stays a draft.
      const bad = await post(A.token, `/api/accounting/journal/${id}/post`);
      expect(bad.status).toBe(422);
      expect((await get(A.token, `/api/accounting/journal/${id}`)).body.item.status).toBe('DRAFT');

      const edited = await patch(A.token, `/api/accounting/journal/${id}`, { memo: 'fixed', lines: lines2(coa['1010'].id, coa['3010'].id, 100) });
      expect(edited.status).toBe(200);
      expect(edited.body.item.lines).toHaveLength(2);

      // Still not in the ledger.
      const tbMid = tbRow(await trialBalance(A.token), '1010');
      expect(tbMid?.debit).toEqual(tbBefore?.debit);

      const posted = await post(A.token, `/api/accounting/journal/${id}/post`);
      expect(posted.status).toBe(200);
      expect(posted.body.item.status).toBe('POSTED');
      const tbAfter = tbRow(await trialBalance(A.token), '1010');
      expect(Number(tbAfter.debit)).toBeCloseTo(Number(tbBefore?.debit || 0) + 100, 2);
    });

    it('a posted entry is immutable: edit, re-post and cancel are all rejected (409)', async () => {
      const e = (await post(A.token, '/api/accounting/journal', { lines: lines2(coa['1010'].id, coa['3010'].id, 33) })).body.item;
      expect((await patch(A.token, `/api/accounting/journal/${e.id}`, { memo: 'tamper' })).status).toBe(409);
      expect((await patch(A.token, `/api/accounting/journal/${e.id}`, { lines: lines2(coa['1010'].id, coa['3010'].id, 1) })).status).toBe(409);
      expect((await post(A.token, `/api/accounting/journal/${e.id}/post`)).status).toBe(409);
      expect((await post(A.token, `/api/accounting/journal/${e.id}/cancel`)).status).toBe(409);
      const stored = await prisma.journalEntry.findUnique({ where: { id: e.id }, include: { lines: true } });
      expect(stored.memo).toBeNull();
      expect(stored.lines.map((l) => Number(l.debit) + Number(l.credit)).sort()).toEqual([33, 33]);
    });

    it('cancelling a draft keeps its number, removes it from everything, and blocks later posting', async () => {
      const d = (await post(A.token, '/api/accounting/journal', { draft: true, lines: lines2(coa['1010'].id, coa['3010'].id, 12) })).body.item;
      const cancelled = await post(A.token, `/api/accounting/journal/${d.id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.item.status).toBe('CANCELLED');
      expect((await post(A.token, `/api/accounting/journal/${d.id}/post`)).status).toBe(409);
      expect((await post(A.token, `/api/accounting/journal/${d.id}/reverse`)).status).toBe(409);
      const still = await prisma.journalEntry.findUnique({ where: { id: d.id } });
      expect(still.entryNumber).toBe(d.entryNumber);
    });

    it('posting a draft into a closed accounting period fails and leaves it a draft', async () => {
      const d = (await post(A.token, '/api/accounting/journal', { draft: true, date: '2020-03-15T00:00:00.000Z', lines: lines2(coa['1010'].id, coa['3010'].id, 9) })).body.item;
      const period = await post(A.token, '/api/accounting/periods', { name: 'Q1-2020', startDate: '2020-01-01', endDate: '2020-03-31' });
      await post(A.token, `/api/accounting/periods/${period.body.item.id}/close`);
      const blocked = await post(A.token, `/api/accounting/journal/${d.id}/post`);
      expect(blocked.status).toBe(409);
      expect((await get(A.token, `/api/accounting/journal/${d.id}`)).body.item.status).toBe('DRAFT');
    });

    it('drafts reject inactive accounts at save time, and deactivating an account used by a draft is blocked', async () => {
      const acct = (await post(A.token, '/api/accounting/accounts', { code: '1700', name: 'Draft-used', type: 'ASSET' })).body.item;
      await post(A.token, '/api/accounting/journal', { draft: true, lines: lines2(acct.id, coa['3010'].id, 4) });
      const blocked = await patch(A.token, `/api/accounting/accounts/${acct.id}`, { isActive: false });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/draft/);
    });

    it('the journal list filters by status and searches entry number / memo / reference', async () => {
      const unique = `REF-${Date.now()}`;
      await post(A.token, '/api/accounting/journal', { draft: true, reference: unique, lines: lines2(coa['1010'].id, coa['3010'].id, 2) });
      const drafts = await get(A.token, '/api/accounting/journal', { status: 'DRAFT', search: unique });
      expect(drafts.body.total).toBe(1);
      expect(drafts.body.items[0].reference).toBe(unique);
      const posted = await get(A.token, '/api/accounting/journal', { status: 'POSTED', search: unique });
      expect(posted.body.total).toBe(0);
    });
  });

  describe('Reversal / correction', () => {
    it('reversing a manual entry posts an exact mirror, marks the original VOID, and nets every account to zero in reports', async () => {
      const acct = (await post(A.token, '/api/accounting/accounts', { code: '1800', name: 'Reversal probe', type: 'ASSET' })).body.item;
      const e = (await post(A.token, '/api/accounting/journal', { lines: lines2(acct.id, coa['3010'].id, 250) })).body.item;
      const tbBefore = await trialBalance(A.token);
      expect(Number(tbRow(tbBefore, '1800').debit)).toBe(250);

      const rev = await post(A.token, `/api/accounting/journal/${e.id}/reverse`, { memo: 'entered in error' });
      expect(rev.status).toBe(200);
      expect(rev.body.item.reversalOfId).toBe(e.id);
      expect(rev.body.item.status).toBe('POSTED');
      const original = await prisma.journalEntry.findUnique({ where: { id: e.id } });
      expect(original.status).toBe('VOID');

      const tb = await trialBalance(A.token);
      expect(tb.balanced).toBe(true);
      // Ledger keeps both entries; the account nets to zero (the pre-fix
      // behavior counted only the mirror entry, leaving -250).
      expect(tbNet(tb, '1800')).toBe(0);
      const detail = await get(A.token, `/api/accounting/accounts/${acct.id}`);
      expect(detail.body.item.balance).toBe(0);
    });

    it('reversal is one-shot, a reversal entry cannot be reversed, and source-linked entries are refused (409)', async () => {
      const e = (await post(A.token, '/api/accounting/journal', { lines: lines2(coa['1010'].id, coa['3010'].id, 11) })).body.item;
      const rev = await post(A.token, `/api/accounting/journal/${e.id}/reverse`);
      expect(rev.status).toBe(200);
      expect((await post(A.token, `/api/accounting/journal/${e.id}/reverse`)).status).toBe(409);
      expect((await post(A.token, `/api/accounting/journal/${rev.body.item.id}/reverse`)).status).toBe(409);
      // legacy alias still works and enforces the same rule
      expect((await post(A.token, `/api/accounting/journal/${e.id}/void`)).status).toBe(409);

      const cust = (await post(A.token, '/api/customers', { name: 'Src cust' })).body.item;
      const prod = (await post(A.token, '/api/products', { name: 'Src prod', sellingPrice: 10, purchasePrice: 4, openingStock: 20 })).body.item;
      const sale = (await post(A.token, '/api/sales', { customerId: cust.id, items: [{ productId: prod.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 })).body.item;
      const saleEntry = await prisma.journalEntry.findFirst({ where: { tenantId: A.tenantId, sourceType: 'SALE', sourceId: sale.id } });
      expect((await post(A.token, `/api/accounting/journal/${saleEntry.id}/reverse`)).status).toBe(409);
    });

    it('REGRESSION (integrity fix): reversing a Sale nets Cash and Sales Revenue to zero in the trial balance and cash-flow', async () => {
      const fresh = await registerTenant('P21 Sale Reversal Report');
      const cust = (await post(fresh.token, '/api/customers', { name: 'C' })).body.item;
      const prod = (await post(fresh.token, '/api/products', { name: 'P', sellingPrice: 10, purchasePrice: 5, openingStock: 50 })).body.item;
      const sale = (await post(fresh.token, '/api/sales', { customerId: cust.id, items: [{ productId: prod.id, quantity: 2, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 20 })).body.item;
      let tb = await trialBalance(fresh.token);
      expect(Number(tbRow(tb, '4010').credit)).toBe(20);

      expect((await post(fresh.token, `/api/sales/${sale.id}/reverse`)).status).toBe(200);
      tb = await trialBalance(fresh.token);
      expect(tb.balanced).toBe(true);
      // Phase 2.4: the 20 the customer already paid is not silently handed back - it stays in Cash
      // and is owed to the customer (AR credit) until refunded; revenue and COGS net to zero, and the
      // 250 of opening stock is back on the books (opening entry + the 10 of COGS restored).
      for (const code of ['4010', '5010']) expect(tbNet(tb, code)).toBe(0);
      expect(tbNet(tb, '1010')).toBe(20);
      expect(tbNet(tb, '1030')).toBe(-20);
      expect(tbNet(tb, '1040')).toBe(250);
      const pl = await get(fresh.token, '/api/accounting/reports/profit-loss');
      expect(pl.status).toBe(200);
      expect(Number(pl.body.netProfit ?? 0)).toBe(0);
    });

    it('journal detail resolves the source record for Phase 1.13 document types (traceability fix)', async () => {
      const cust = (await post(A.token, '/api/customers', { name: 'Trace cust' })).body.item;
      const cn = (await post(A.token, '/api/credit-notes', { customerId: cust.id, amount: 15, reason: 'trace' })).body.item;
      const entry = await prisma.journalEntry.findFirst({ where: { tenantId: A.tenantId, sourceType: 'CREDIT_NOTE', sourceId: cn.id } });
      const detail = await get(A.token, `/api/accounting/journal/${entry.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.sourceEntity).toBe('CreditNote');
      expect(detail.body.source.id).toBe(cn.id);
    });
  });

  describe('Opening balances', () => {
    it('posts one balanced entry: entered lines plus an automatic Opening Balance Equity offset; trial balance stays balanced', async () => {
      const O = await registerTenant('P21 Opening');
      const c = await chart(O.token);
      const res = await post(O.token, '/api/accounting/opening-balances', {
        asOfDate: '2026-01-01',
        memo: 'Go-live balances',
        lines: [
          { accountId: c['1010'].id, debit: 1000 },
          { accountId: c['1040'].id, debit: 4000 },
          { accountId: c['2010'].id, credit: 1500 },
        ],
      });
      expect(res.status).toBe(201);
      const entry = res.body.item;
      expect(entry.sourceType).toBe('OPENING_BALANCE');
      const debit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const credit = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debit).toBe(credit);
      const equityLine = entry.lines.find((l) => l.accountId === c['3010'].id);
      expect(Number(equityLine.credit)).toBe(3500);

      const tb = await trialBalance(O.token);
      expect(tb.balanced).toBe(true);
      const status = await get(O.token, '/api/accounting/opening-balances');
      expect(status.body.posted).toBe(true);
      expect(status.body.active.id).toBe(entry.id);
    });

    it('rejects a second posting (409) while one is active, then allows re-entry after the first is reversed', async () => {
      const O = await registerTenant('P21 Opening Repost');
      const c = await chart(O.token);
      const body = { asOfDate: '2026-01-01', lines: [{ accountId: c['1010'].id, debit: 100 }] };
      const first = await post(O.token, '/api/accounting/opening-balances', body);
      expect(first.status).toBe(201);
      const second = await post(O.token, '/api/accounting/opening-balances', body);
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already posted/);

      expect((await post(O.token, `/api/accounting/journal/${first.body.item.id}/reverse`)).status).toBe(200);
      const status = await get(O.token, '/api/accounting/opening-balances');
      expect(status.body.posted).toBe(false);
      const third = await post(O.token, '/api/accounting/opening-balances', body);
      expect(third.status).toBe(201);
      // The ledger holds exactly one net set of opening balances.
      const tb = await trialBalance(O.token);
      expect(Number(tbRow(tb, '1010').debit) - Number(tbRow(tb, '1010').credit)).toBe(100);
    });

    it('validates lines: no equity line, no zero/two-sided lines, no inactive/unknown accounts', async () => {
      const O = await registerTenant('P21 Opening Validation');
      const c = await chart(O.token);
      const url = '/api/accounting/opening-balances';
      const base = { asOfDate: '2026-01-01' };
      expect((await post(O.token, url, { ...base, lines: [{ accountId: c['3010'].id, credit: 5 }] })).status).toBe(422);
      expect((await post(O.token, url, { ...base, lines: [{ accountId: c['1010'].id, debit: 0 }] })).status).toBe(422);
      expect((await post(O.token, url, { ...base, lines: [{ accountId: c['1010'].id, debit: 5, credit: 5 }] })).status).toBe(422);
      expect((await post(O.token, url, { ...base, lines: [] })).status).toBe(422);
      expect((await post(O.token, url, { ...base, lines: [{ accountId: '11111111-1111-4111-8111-111111111111', debit: 5 }] })).status).toBe(404);
      const dormant = (await post(O.token, '/api/accounting/accounts', { code: '1990', name: 'Dormant', type: 'ASSET' })).body.item;
      await patch(O.token, `/api/accounting/accounts/${dormant.id}`, { isActive: false });
      expect((await post(O.token, url, { ...base, lines: [{ accountId: dormant.id, debit: 5 }] })).status).toBe(409);
      // nothing was posted by any of the failures
      expect((await get(O.token, url)).body.posted).toBe(false);
    });

    it('is TENANT_ADMIN-only to post; FINANCE_STAFF can view status; other tenants see their own state', async () => {
      const c = coa;
      const body = { asOfDate: '2026-01-01', lines: [{ accountId: c['1010'].id, debit: 1 }] };
      expect((await post(mgrA, '/api/accounting/opening-balances', body)).status).toBe(403);
      expect((await post(acctA, '/api/accounting/opening-balances', body)).status).toBe(403);
      expect((await get(acctA, '/api/accounting/opening-balances')).status).toBe(200);
      expect((await get(cashierA, '/api/accounting/opening-balances')).status).toBe(403);
      // tenant A's account id is not usable by tenant B
      expect((await post(B.token, '/api/accounting/opening-balances', body)).status).toBe(404);
    });

    it('is idempotent: a retried request with the same key returns the same entry without posting twice', async () => {
      const O = await registerTenant('P21 Opening Idem');
      const c = await chart(O.token);
      const body = { asOfDate: '2026-01-01', idempotencyKey: `ob-${Date.now()}`, lines: [{ accountId: c['1010'].id, debit: 50 }] };
      const a = await post(O.token, '/api/accounting/opening-balances', body);
      const b = await post(O.token, '/api/accounting/opening-balances', body);
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.body.deduplicated).toBe(true);
      expect(b.body.item.id).toBe(a.body.item.id);
      expect(await prisma.journalEntry.count({ where: { tenantId: O.tenantId, sourceType: 'OPENING_BALANCE' } })).toBe(1);
    });

    it('CONCURRENCY: simultaneous opening-balance requests produce exactly one entry', async () => {
      const O = await registerTenant('P21 Opening Concurrent');
      const c = await chart(O.token);
      const body = { asOfDate: '2026-01-01', lines: [{ accountId: c['1010'].id, debit: 10 }, { accountId: c['2010'].id, credit: 4 }] };
      const results = await Promise.all(Array.from({ length: 5 }, () => post(O.token, '/api/accounting/opening-balances', body)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409]);
      expect(await prisma.journalEntry.count({ where: { tenantId: O.tenantId, sourceType: 'OPENING_BALANCE', status: 'POSTED' } })).toBe(1);
      expect((await trialBalance(O.token)).balanced).toBe(true);
    });
  });

  describe('Concurrency and idempotency of manual journal operations', () => {
    it('10 concurrent manual postings all succeed with unique entry numbers and every entry balanced', async () => {
      const T = await registerTenant('P21 Concurrent Post');
      const c = await chart(T.token);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => post(T.token, '/api/accounting/journal', { memo: `c${i}`, lines: lines2(c['1010'].id, c['3010'].id, 10 + i) })));
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
      const numbers = results.map((r) => r.body.item.entryNumber);
      expect(new Set(numbers).size).toBe(10);
      const entries = await prisma.journalEntry.findMany({ where: { tenantId: T.tenantId, sourceType: 'MANUAL' }, include: { lines: true } });
      for (const e of entries) {
        expect(e.lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(e.lines.reduce((s, l) => s + Number(l.credit), 0));
      }
      expect((await trialBalance(T.token)).balanced).toBe(true);
    });

    it('concurrent posting of the SAME draft: exactly one succeeds, the rest get 409, and it is posted once', async () => {
      const d = (await post(A.token, '/api/accounting/journal', { draft: true, lines: lines2(coa['1010'].id, coa['3010'].id, 14) })).body.item;
      const results = await Promise.all(Array.from({ length: 5 }, () => post(A.token, `/api/accounting/journal/${d.id}/post`)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const stored = await prisma.journalEntry.findUnique({ where: { id: d.id } });
      expect(stored.status).toBe('POSTED');
    });

    it('concurrent post vs cancel of the same draft: exactly one wins and the entry ends in a single consistent state', async () => {
      const d = (await post(A.token, '/api/accounting/journal', { draft: true, lines: lines2(coa['1010'].id, coa['3010'].id, 15) })).body.item;
      const [p, c] = await Promise.all([post(A.token, `/api/accounting/journal/${d.id}/post`), post(A.token, `/api/accounting/journal/${d.id}/cancel`)]);
      expect([p.status, c.status].sort()).toEqual([200, 409]);
      const stored = await prisma.journalEntry.findUnique({ where: { id: d.id } });
      expect(['POSTED', 'CANCELLED']).toContain(stored.status);
      expect(stored.status).toBe(p.status === 200 ? 'POSTED' : 'CANCELLED');
    });

    it('concurrent reversal of the SAME entry: exactly one mirror entry is created', async () => {
      const e = (await post(A.token, '/api/accounting/journal', { lines: lines2(coa['1010'].id, coa['3010'].id, 16) })).body.item;
      const results = await Promise.all(Array.from({ length: 5 }, () => post(A.token, `/api/accounting/journal/${e.id}/reverse`)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
      expect(await prisma.journalEntry.count({ where: { reversalOfId: e.id } })).toBe(1);
    });

    it('idempotency: same key returns the original entry (200, deduplicated); concurrent same-key requests create one row', async () => {
      const key = `je-${Date.now()}`;
      const body = { idempotencyKey: key, memo: 'idem', lines: lines2(coa['1010'].id, coa['3010'].id, 17) };
      const first = await post(A.token, '/api/accounting/journal', body);
      const retry = await post(A.token, '/api/accounting/journal', body);
      expect(first.status).toBe(201);
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);
      expect(retry.body.item.id).toBe(first.body.item.id);

      const key2 = `je2-${Date.now()}`;
      const race = await Promise.all(Array.from({ length: 4 }, () => post(A.token, '/api/accounting/journal', { ...body, idempotencyKey: key2 })));
      expect(race.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
      expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, idempotencyKey: key2 } })).toBe(1);
    });

    it('a manual posting racing a business posting never produces a 500 or an unbalanced ledger', async () => {
      const T = await registerTenant('P21 Mixed Concurrency');
      const c = await chart(T.token);
      const cust = (await post(T.token, '/api/customers', { name: 'Mix' })).body.item;
      const prod = (await post(T.token, '/api/products', { name: 'Mix P', sellingPrice: 10, purchasePrice: 5, openingStock: 100 })).body.item;
      const work = [];
      for (let i = 0; i < 4; i++) {
        work.push(post(T.token, '/api/accounting/journal', { lines: lines2(c['1010'].id, c['3010'].id, 5 + i) }));
        work.push(post(T.token, '/api/sales', { customerId: cust.id, items: [{ productId: prod.id, quantity: 1, unitPrice: 10 }], paymentMethod: 'cash', amountPaid: 10 }));
      }
      const results = await Promise.all(work);
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      expect((await trialBalance(T.token)).balanced).toBe(true);
    });
  });

  describe('Permission catalog parity and existing accounting regression', () => {
    it('the seeded roles expose exactly the new ACCOUNT / JOURNAL / OPENING_BALANCE keys', async () => {
      expect(A.permissions).toEqual(expect.arrayContaining(['ACCOUNT:VIEW', 'ACCOUNT:CREATE', 'ACCOUNT:UPDATE', 'ACCOUNT:DELETE', 'JOURNAL:CREATE', 'JOURNAL:UPDATE', 'JOURNAL:APPROVE', 'JOURNAL:REVERSE', 'OPENING_BALANCE:VIEW', 'OPENING_BALANCE:CREATE']));
      const login = await roleToken(A.token, 'ACCOUNTANT');
      expect(login.permissions).toEqual(expect.arrayContaining(['ACCOUNT:VIEW', 'JOURNAL:VIEW', 'OPENING_BALANCE:VIEW']));
      expect(login.permissions).not.toEqual(expect.arrayContaining(['ACCOUNT:CREATE']));
      expect(login.permissions).not.toEqual(expect.arrayContaining(['JOURNAL:APPROVE']));
      expect(login.permissions).not.toEqual(expect.arrayContaining(['OPENING_BALANCE:CREATE']));
      const mgr = await roleToken(A.token, 'MANAGER');
      expect(mgr.permissions).toEqual(expect.arrayContaining(['ACCOUNT:CREATE', 'JOURNAL:APPROVE']));
      expect(mgr.permissions).not.toEqual(expect.arrayContaining(['OPENING_BALANCE:CREATE']));
    });

    it('existing behavior is unchanged: default accounts list shape, system-account protections, manual void alias', async () => {
      const list = await get(A.token, '/api/accounting/accounts');
      expect(list.body).toHaveProperty('items');
      expect((await patch(A.token, `/api/accounting/accounts/${coa['1010'].id}`, { isActive: false })).status).toBe(409);
      expect((await del(A.token, `/api/accounting/accounts/${coa['1010'].id}`)).status).toBe(409);
      const e = (await post(A.token, '/api/accounting/journal', { lines: lines2(coa['1010'].id, coa['3010'].id, 3) })).body.item;
      expect((await post(A.token, `/api/accounting/journal/${e.id}/void`, { memo: 'legacy void' })).status).toBe(200);
    });
  });
});
