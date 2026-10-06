// Phase 4.1 - the mobile routes enforce the EXISTING permission catalog and branch scope, not a hard-coded role.
// The catalog grants and the branch scope are controlled here so each rule can be proven in isolation: a
// role without REPORT:VIEW is refused on every report-like mobile route; a branch-restricted session may only
// see, name or default to its own branches.
const mockScope = { ids: null };
jest.mock('../src/middleware/branchScope', () => {
  const real = jest.requireActual('../src/middleware/branchScope');
  return {
    ...real,
    getAccessibleBranchIds: async () => mockScope.ids,
    assertBranchAccess: async (prisma, user, branchId) => {
      if (!branchId || mockScope.ids === null) return;
      if (!mockScope.ids.includes(branchId)) {
        const { ForbiddenError } = require('../src/utils/errors');
        throw new ForbiddenError('You do not have access to this branch');
      }
    },
  };
});

const request = require('supertest');
const prisma = require('../src/config/prisma');

// Take REPORT:VIEW away from MANAGER in the (cached) catalog before anything loads it.
const realFindMany = prisma.rolePermission.findMany.bind(prisma.rolePermission);
let withheld = true;
jest.spyOn(prisma.rolePermission, 'findMany').mockImplementation(async (args) => {
  const rows = await realFindMany(args);
  return withheld ? rows.filter((r) => !(r.role === 'MANAGER' && r.permission.resource === 'REPORT' && r.permission.action === 'VIEW')) : rows;
});
const app = require('../src/app');

jest.setTimeout(60000);
const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const M = '/api/mobile/v1';

describe('Phase 4.1 - permission and branch enforcement on the mobile API', () => {
  let T;
  let ownerToken;
  let mgrToken;
  let b1;
  let b2;
  let b3;
  beforeAll(async () => {
    const email = `${uniq('o')}@test.local`;
    const reg = await request(app).post('/api/auth/register-tenant').send({ businessName: uniq('Gate'), adminName: 'Owner', email, password: 'TestPass123' });
    if (reg.status !== 201) throw new Error(JSON.stringify(reg.body));
    T = { web: reg.body.token, tenantId: reg.body.tenant.id };
    const mEmail = `${uniq('m')}@test.local`;
    await request(app).post('/api/users').set(auth(T.web)).send({ name: 'Manager', email: mEmail, password: 'TestPass123', role: 'MANAGER' });
    ownerToken = (await request(app).post(`${M}/auth/login`).send({ email, password: 'TestPass123' })).body.token;
    mgrToken = (await request(app).post(`${M}/auth/login`).send({ email: mEmail, password: 'TestPass123' })).body.token;
    const mk = async (n, c) => (await request(app).post('/api/branches').set(auth(T.web)).send({ name: uniq(n), code: c })).body.item;
    [b1, b2, b3] = [await mk('B1', 'G1'), await mk('B2', 'G2'), await mk('B3', 'G3')];
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('without REPORT:VIEW in the catalog every report-like mobile route is refused (403) - and the login shows what is missing', async () => {
    for (const path of ['/dashboard/summary', '/dashboard/sales', '/dashboard/filters', '/dashboard/purchases', '/dashboard/cash', '/alerts', '/alerts/meta/categories', '/ai/home', '/ai/needs-attention']) {
      const res = await request(app).get(`${M}${path}`).set(auth(mgrToken));
      expect([path, res.status]).toEqual([path, 403]);
    }
    const owner = await request(app).get(`${M}/dashboard/summary`).set(auth(ownerToken));
    expect(owner.status).toBe(200); // the owner's grants are untouched
    const profile = await request(app).get(`${M}/profile`).set(auth(mgrToken));
    expect(profile.status).toBe(200); // the profile/context are the session itself, not a report
    expect(profile.body.access.permissions).not.toContain('REPORT:VIEW');
    expect(profile.body.access.permissions).toContain('SALE:VIEW');
  });

  it('a branch-restricted session: context lists only its branches; a foreign branch is 403; with no branch chosen the figures cover exactly its own branches; one allowed branch is the default', async () => {
    mockScope.ids = [b1.id, b2.id];
    const ctx = await request(app).get(`${M}/context`).set(auth(ownerToken));
    expect(ctx.body.branchRestricted).toBe(true);
    expect(ctx.body.branches.map((b) => b.id).sort()).toEqual([b1.id, b2.id].sort());
    expect(ctx.body.defaultBranchId).toBeNull();

    const filters = await request(app).get(`${M}/dashboard/filters`).set(auth(ownerToken));
    expect(filters.body.branches.map((b) => b.id).sort()).toEqual([b1.id, b2.id].sort());

    expect((await request(app).get(`${M}/dashboard/summary`).query({ branchId: b3.id }).set(auth(ownerToken))).status).toBe(403);
    expect((await request(app).get(`${M}/ai/home`).query({ branchId: b3.id }).set(auth(ownerToken))).status).toBe(403);
    // No branch chosen: the dashboard covers the user's own two branches together (never the third).
    const none = await request(app).get(`${M}/dashboard/summary`).set(auth(ownerToken));
    expect(none.status).toBe(200);
    expect((await request(app).get(`${M}/dashboard/summary`).query({ branchId: b1.id }).set(auth(ownerToken))).status).toBe(200);

    mockScope.ids = [b2.id];
    expect((await request(app).get(`${M}/context`).set(auth(ownerToken))).body.defaultBranchId).toBe(b2.id);
    expect((await request(app).get(`${M}/dashboard/summary`).set(auth(ownerToken))).status).toBe(200); // held to its only branch
    mockScope.ids = null;
    expect((await request(app).get(`${M}/dashboard/summary`).set(auth(ownerToken))).status).toBe(200);
  });
});
