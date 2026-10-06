// Phase 4.1 - the mobile app is an OWNER/MANAGEMENT app: TENANT_ADMIN and MANAGER may hold a mobile session, every
// other role is refused; what a session may do comes from the existing permission catalog; the branch/company
// context is exposed; isolation between mobile tokens and staff tokens still holds.
// Needs a real, throwaway Postgres (see README "Testing").
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(60000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const M = '/api/mobile/v1';

async function tenantWithAdmin(name) {
  const email = `${uniq('owner')}@test.local`;
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Owner', email, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { web: res.body.token, tenantId: res.body.tenant.id, email };
}
async function addUser(adminWeb, role) {
  const email = `${uniq(role.toLowerCase())}@test.local`;
  const res = await request(app).post('/api/users').set(auth(adminWeb)).send({ name: role, email, password: 'TestPass123', role });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { id: res.body.item.id, email };
}
const mobileLogin = (email, password = 'TestPass123') => request(app).post(`${M}/auth/login`).send({ email, password });

describe('Phase 4.1 - management access to the mobile API', () => {
  let T;
  let manager;
  let managerToken;
  beforeAll(async () => {
    T = await tenantWithAdmin(uniq('Mgmt Shop'));
    manager = await addUser(T.web, 'MANAGER');
    managerToken = (await mobileLogin(manager.email)).body.token;
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('a MANAGER can sign in; the response carries the real role, the catalog permissions and the branch scope, and the legacy fields are unchanged', async () => {
    const res = await mobileLogin(manager.email);
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual({ readOnly: true, role: 'OWNER_MOBILE' }); // unchanged for existing clients
    expect(res.body.user.role).toBe('MANAGER');
    expect(res.body.access.role).toBe('MANAGER');
    expect(res.body.access.branchRestricted).toBe(false);
    expect(res.body.access.branchIds).toBeNull();
    expect(res.body.access.permissions).toEqual(expect.arrayContaining(['REPORT:VIEW', 'SALE:VIEW', 'CUSTOMER:VIEW']));
    expect(res.body.access.permissions).not.toContain('USER:CREATE'); // owner-only in the catalog
    const owner = await mobileLogin(T.email);
    expect(owner.body.access.permissions).toContain('USER:CREATE');
    expect(owner.body.access.role).toBe('TENANT_ADMIN');
  });

  it('every other role is refused, with exactly the message of a wrong password (the account is not confirmed to exist)', async () => {
    const wrong = await mobileLogin(manager.email, 'not-the-password');
    for (const role of ['CASHIER', 'STORE_KEEPER', 'ACCOUNTANT', 'RECEPTIONIST', 'DOCTOR']) {
      const u = await addUser(T.web, role);
      const res = await mobileLogin(u.email);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe(wrong.body.error);
    }
  });

  it('the profile and the branch/company context come from the session; the token opens the mobile API and only that', async () => {
    const profile = await request(app).get(`${M}/profile`).set(auth(managerToken));
    expect(profile.status).toBe(200);
    expect(profile.body.access.role).toBe('MANAGER');

    const branchA = (await request(app).post('/api/branches').set(auth(T.web)).send({ name: uniq('North'), code: 'N1' })).body.item;
    const ctx = await request(app).get(`${M}/context`).set(auth(managerToken));
    expect(ctx.status).toBe(200);
    expect(ctx.body.branchRestricted).toBe(false);
    expect(ctx.body.branches.map((b) => b.id)).toContain(branchA.id);
    expect(ctx.body.defaultBranchId).toBeNull();

    // A mobile token is not a staff token, and a staff token is not a mobile token.
    expect((await request(app).get('/api/users').set(auth(managerToken))).status).toBe(401); // a mobile token reaches only the Phase 4.3 allow-list
    expect((await request(app).get(`${M}/profile`).set(auth(T.web))).status).toBe(401);
    expect((await request(app).get(`${M}/context`)).status).toBe(401);
  });

  it('the dashboards, alerts and AI advisor answer a MANAGER; a branch of another shop is refused', async () => {
    for (const path of ['/dashboard/summary', '/dashboard/filters', '/alerts', '/ai/home']) {
      const res = await request(app).get(`${M}${path}`).set(auth(managerToken));
      expect([200, 304]).toContain(res.status);
    }
    const other = await tenantWithAdmin(uniq('Other'));
    const foreign = (await request(app).post('/api/branches').set(auth(other.web)).send({ name: uniq('Far'), code: 'F1' })).body.item;
    expect((await request(app).get(`${M}/dashboard/summary`).query({ branchId: foreign.id }).set(auth(managerToken))).status).toBe(422);
    expect((await request(app).get(`${M}/ai/home`).query({ branchId: foreign.id }).set(auth(managerToken))).status).toBe(422);
  });

  it('the session is re-checked on every request: deactivating the user, or changing them to a non-management role, ends it at once', async () => {
    const u = await addUser(T.web, 'MANAGER');
    const token = (await mobileLogin(u.email)).body.token;
    expect((await request(app).get(`${M}/profile`).set(auth(token))).status).toBe(200);
    await prisma.user.update({ where: { id: u.id }, data: { role: 'CASHIER' } });
    expect((await request(app).get(`${M}/profile`).set(auth(token))).status).toBe(401);
    await prisma.user.update({ where: { id: u.id }, data: { role: 'MANAGER', isActive: false } });
    expect((await request(app).get(`${M}/profile`).set(auth(token))).status).toBe(401);
  });

  it('it is still read-only: writes to the mobile surface are refused whatever the role', async () => {
    expect((await request(app).post(`${M}/context`).set(auth(managerToken)).send({})).status).toBe(403);
    expect((await request(app).put(`${M}/profile`).set(auth(managerToken)).send({})).status).toBe(403);
  });
});
