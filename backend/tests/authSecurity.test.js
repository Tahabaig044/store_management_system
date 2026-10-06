// V1 Phase 3 - account security: password policy, intentional signup policy, forgot/reset/change password,
// admin-issued reset links, session invalidation on password change, and duplicate-email safety.
const supertest = require('supertest');
const app = require('../src/app');

// The app trusts one proxy hop, so a unique X-Forwarded-For per call keeps these many calls out of the
// per-IP brute-force buckets (the limiters themselves are covered by phase12Hardening).
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const request = () => ({
  get: (p) => supertest(app).get(p).set('X-Forwarded-For', ip()),
  post: (p) => supertest(app).post(p).set('X-Forwarded-For', ip()),
  patch: (p) => supertest(app).patch(p).set('X-Forwarded-For', ip()),
});
const prisma = require('../src/config/prisma');
const mailer = require('../src/utils/mailer');
const { hashPassword } = require('../src/utils/password');

jest.setTimeout(60000);

const email = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function register(over = {}) {
  const body = { businessName: `Sec ${Date.now()}${Math.random()}`, adminName: 'Sec Admin', email: email('admin'), password: 'GoodPass123', ...over };
  const res = await request().post('/api/auth/register-tenant').send(body);
  return { res, body };
}
async function login(e, p) {
  return request().post('/api/auth/login').send({ email: e, password: p });
}
const tokenFromLink = (link) => new URL(link).searchParams.get('token');

describe('password policy', () => {
  test.each([
    ['too short', 'Ab1'],
    ['no digit', 'OnlyLettersHere'],
    ['no letter', '1234567890'],
    ['over bcrypt limit', 'A1' + 'x'.repeat(80)],
  ])('registration rejects %s', async (_n, password) => {
    const { res } = await register({ password });
    expect(res.status).toBe(422);
  });

  test('user create and admin password change use the same policy', async () => {
    const { res } = await register();
    const t = res.body.token;
    const weak = await request().post('/api/users').set(auth(t)).send({ name: 'Weak User', email: email('w'), password: 'abcdefgh', role: 'CASHIER' });
    expect(weak.status).toBe(422);
    const ok = await request().post('/api/users').set(auth(t)).send({ name: 'Ok User', email: email('o'), password: 'abcdefg1', role: 'CASHIER' });
    expect(ok.status).toBe(201);
    const weakPatch = await request().patch(`/api/users/${ok.body.item.id}`).set(auth(t)).send({ password: 'short1' });
    expect(weakPatch.status).toBe(422);
  });
});

describe('signup policy', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['NODE_ENV', 'SIGNUP_OPEN', 'SIGNUP_INVITE_CODE']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  test('production with nothing configured is closed (fail-closed)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SIGNUP_OPEN; delete process.env.SIGNUP_INVITE_CODE;
    const cfg = await request().get('/api/auth/config');
    expect(cfg.body.signupMode).toBe('closed');
    const { res } = await register();
    expect(res.status).toBe(403);
  });

  test('production with SIGNUP_OPEN=true is open', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SIGNUP_OPEN = 'true';
    expect((await request().get('/api/auth/config')).body.signupMode).toBe('open');
    expect((await register()).res.status).toBe(201);
  });

  test('invite mode requires the exact code', async () => {
    process.env.SIGNUP_INVITE_CODE = 'launch-2026';
    expect((await request().get('/api/auth/config')).body.signupMode).toBe('invite');
    expect((await register()).res.status).toBe(403);
    expect((await register({ inviteCode: 'wrong' })).res.status).toBe(403);
    expect((await register({ inviteCode: 'launch-2026' })).res.status).toBe(201);
  });

  test('an email already used by any tenant cannot register again (case-insensitive)', async () => {
    const first = await register();
    const dup = await register({ email: first.body.email.toUpperCase() });
    expect(dup.res.status).toBe(409);
  });
});

describe('login with the same email in two tenants (legacy data)', () => {
  test('the account is chosen by password; neither user is locked out; wrong password fails', async () => {
    const a = await register();
    const b = await register();
    const shared = email('shared');
    const tenantIds = [a.res.body.tenant.id, b.res.body.tenant.id];
    await prisma.user.create({ data: { tenantId: tenantIds[0], name: 'A', email: shared, passwordHash: await hashPassword('PassForA111'), role: 'CASHIER' } });
    await prisma.user.create({ data: { tenantId: tenantIds[1], name: 'B', email: shared, passwordHash: await hashPassword('PassForB222'), role: 'CASHIER' } });
    const la = await login(shared, 'PassForA111');
    const lb = await login(shared, 'PassForB222');
    expect(la.status).toBe(200);
    expect(lb.status).toBe(200);
    expect(la.body.user.tenantId).toBe(tenantIds[0]);
    expect(lb.body.user.tenantId).toBe(tenantIds[1]);
    expect((await login(shared, 'nope12345')).status).toBe(401);
    expect((await login(email('ghost'), 'nope12345')).status).toBe(401);
  });
});

describe('forgot / reset password', () => {
  let sent;
  beforeEach(() => {
    sent = [];
    mailer._setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  });
  afterEach(() => mailer._setTransportForTests(null));

  test('without SMTP the API says so honestly and creates nothing', async () => {
    mailer._setTransportForTests(null);
    const { body } = await register();
    const before = await prisma.passwordResetToken.count();
    const res = await request().post('/api/auth/forgot-password').send({ email: body.email });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_NOT_CONFIGURED');
    expect(await prisma.passwordResetToken.count()).toBe(before);
    expect((await request().get('/api/auth/config')).body.passwordResetByEmail).toBe(false);
  });

  test('known and unknown emails get the identical response; only the known one is emailed', async () => {
    const { body } = await register();
    const known = await request().post('/api/auth/forgot-password').send({ email: body.email });
    const unknown = await request().post('/api/auth/forgot-password').send({ email: email('nobody') });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(body.email.toLowerCase());
    expect(sent[0].text).toMatch(/reset-password\?token=/);
  });

  test('a token resets the password once, invalidates old sessions and dies with use', async () => {
    const { res: reg, body } = await register();
    const oldToken = reg.body.token;
    expect((await request().get('/api/auth/me').set(auth(oldToken))).status).toBe(200);

    await request().post('/api/auth/forgot-password').send({ email: body.email });
    const token = tokenFromLink(sent[0].text.match(/https?:\/\/\S+/)[0]);
    // Only the hash is stored.
    const stored = await prisma.passwordResetToken.findMany({ where: { user: { email: body.email.toLowerCase() } } });
    expect(stored.some((r) => r.tokenHash === token)).toBe(false);

    await new Promise((r) => setTimeout(r, 1100)); // JWT iat has 1 s resolution
    const weak = await request().post('/api/auth/reset-password').send({ token, password: 'weak' });
    expect(weak.status).toBe(422);
    const done = await request().post('/api/auth/reset-password').send({ token, password: 'BrandNew456' });
    expect(done.status).toBe(200);

    expect((await login(body.email, 'GoodPass123')).status).toBe(401);
    expect((await login(body.email, 'BrandNew456')).status).toBe(200);
    expect((await request().get('/api/auth/me').set(auth(oldToken))).status).toBe(401);
    expect((await request().post('/api/auth/reset-password').send({ token, password: 'Another789x' })).status).toBe(422);
  });

  test('two simultaneous submissions of one token: exactly one wins', async () => {
    const { body } = await register();
    await request().post('/api/auth/forgot-password').send({ email: body.email });
    const token = tokenFromLink(sent[0].text.match(/https?:\/\/\S+/)[0]);
    const rs = await Promise.all([
      request().post('/api/auth/reset-password').send({ token, password: 'RaceOne111' }),
      request().post('/api/auth/reset-password').send({ token, password: 'RaceTwo222' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 422]);
  });

  test('expired and garbage tokens are refused', async () => {
    const { body } = await register();
    await request().post('/api/auth/forgot-password').send({ email: body.email });
    const token = tokenFromLink(sent[0].text.match(/https?:\/\/\S+/)[0]);
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) }, where: { user: { email: body.email.toLowerCase() } } });
    expect((await request().post('/api/auth/reset-password').send({ token, password: 'LateOne111' })).status).toBe(422);
    expect((await request().post('/api/auth/reset-password').send({ token: 'x'.repeat(43), password: 'LateOne111' })).status).toBe(422);
  });

  test('a deactivated user gets no reset email', async () => {
    const { res: reg } = await register();
    const u = await request().post('/api/users').set(auth(reg.body.token)).send({ name: 'Gone User', email: email('gone'), password: 'GonePass123', role: 'CASHIER' });
    await request().patch(`/api/users/${u.body.item.id}`).set(auth(reg.body.token)).send({ isActive: false });
    await request().post('/api/auth/forgot-password').send({ email: u.body.item.email });
    expect(sent).toHaveLength(0);
  });
});

describe('admin-issued reset link', () => {
  test('tenant admin can issue one for own-tenant users; other roles and other tenants cannot', async () => {
    const a = await register();
    const b = await register();
    const cashier = await request().post('/api/users').set(auth(a.res.body.token)).send({ name: 'Cash Ier', email: email('c'), password: 'CashPass123', role: 'CASHIER' });
    const uid = cashier.body.item.id;
    const cashierLogin = await login(cashier.body.item.email, 'CashPass123');

    const noAuth = await request().post(`/api/users/${uid}/reset-link`);
    expect(noAuth.status).toBe(401);
    expect((await request().post(`/api/users/${uid}/reset-link`).set(auth(cashierLogin.body.token))).status).toBe(403);
    expect((await request().post(`/api/users/${uid}/reset-link`).set(auth(b.res.body.token))).status).toBe(404);

    const issued = await request().post(`/api/users/${uid}/reset-link`).set(auth(a.res.body.token));
    expect(issued.status).toBe(201);
    const token = tokenFromLink(issued.body.link);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'USER_RESET_LINK_ISSUED', entityId: uid } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain(token);

    await new Promise((r) => setTimeout(r, 1100));
    expect((await request().post('/api/auth/reset-password').send({ token, password: 'FreshPass999' })).status).toBe(200);
    expect((await login(cashier.body.item.email, 'FreshPass999')).status).toBe(200);
    expect((await request().get('/api/auth/me').set(auth(cashierLogin.body.token))).status).toBe(401);
  });
});

describe('change password / admin password change', () => {
  test('change-password checks the current password, signs out other sessions, keeps this one', async () => {
    const { res: reg, body } = await register();
    const second = await login(body.email, 'GoodPass123');
    await new Promise((r) => setTimeout(r, 1100));

    const wrong = await request().post('/api/auth/change-password').set(auth(reg.body.token)).send({ currentPassword: 'nope', newPassword: 'NewPass1234' });
    expect(wrong.status).toBe(422);
    const weak = await request().post('/api/auth/change-password').set(auth(reg.body.token)).send({ currentPassword: 'GoodPass123', newPassword: 'weak' });
    expect(weak.status).toBe(422);
    const ok = await request().post('/api/auth/change-password').set(auth(reg.body.token)).send({ currentPassword: 'GoodPass123', newPassword: 'NewPass1234' });
    expect(ok.status).toBe(200);

    expect((await request().get('/api/auth/me').set(auth(ok.body.token))).status).toBe(200);
    expect((await request().get('/api/auth/me').set(auth(reg.body.token))).status).toBe(401);
    expect((await request().get('/api/auth/me').set(auth(second.body.token))).status).toBe(401);
    expect((await login(body.email, 'NewPass1234')).status).toBe(200);
    expect(await request().post('/api/auth/change-password').send({ currentPassword: 'a', newPassword: 'NewPass9999' })).toHaveProperty('status', 401);
  });

  test('an admin setting a user password signs that user out', async () => {
    const a = await register();
    const u = await request().post('/api/users').set(auth(a.res.body.token)).send({ name: 'Some User', email: email('s'), password: 'SomePass123', role: 'CASHIER' });
    const l = await login(u.body.item.email, 'SomePass123');
    await new Promise((r) => setTimeout(r, 1100));
    expect((await request().patch(`/api/users/${u.body.item.id}`).set(auth(a.res.body.token)).send({ password: 'AdminSet456' })).status).toBe(200);
    expect((await request().get('/api/auth/me').set(auth(l.body.token))).status).toBe(401);
    expect((await login(u.body.item.email, 'AdminSet456')).status).toBe(200);
  });
});
