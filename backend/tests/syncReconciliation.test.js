// Phase 3.3.4 - multi-terminal reconciliation, proven with real concurrent HTTP against a real Postgres.
//
// Terminals report what they still hold unsent and which queued transactions the server refused; managers
// see all of it across terminals and acknowledge it. Proven here:
//   - a report is replay-safe, and many terminals/reports racing for the same rows never duplicate them;
//   - reports that arrive OUT OF ORDER never overwrite newer information;
//   - an issue is resolved by the terminal, and reopens if the same entry is refused again;
//   - two managers acknowledging at once: one acknowledgement is kept, both get an answer;
//   - tenant isolation, and reading requires a manager;
//   - a terminal holding work and gone quiet is flagged silent.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(120000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (t, path, query) => request(app).get(path).set(auth(t)).query(query || {});
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: `${uniq('a')}@test.local`, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}
async function userToken(adminToken, role) {
  const email = `${uniq(role.toLowerCase())}@test.local`;
  const created = await post(adminToken, '/api/users', { name: role, email, password: 'TestPass123', role });
  if (created.status !== 201) throw new Error(`user create failed ${JSON.stringify(created.body)}`);
  return (await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' })).body.token;
}

const t0 = Date.now();
const report = (token, terminalId, over = {}) =>
  post(token, '/api/sync/terminal-report', {
    terminalId,
    sentAt: new Date(t0 + (over.n || 0) * 1000).toISOString(),
    counts: { pending: 0, conflict: 0, failed: 0 },
    issues: [],
    resolved: [],
    ...over.body,
  });
const conflict = (clientId, extra = {}) => ({ clientId, entity: 'Sales Return', kind: 'RETURN_EXCEEDS', code: 'RETURN_EXCEEDS', message: 'Cannot return 2; only 1 remains', details: { saleItemId: 'x', remaining: 1 }, ...extra });

describe('Phase 3.3.4 - multi-terminal reconciliation', () => {
  let T;
  let manager;
  let cashier;

  beforeAll(async () => {
    T = await registerTenant(uniq('Reconcile'));
    manager = await userToken(T.token, 'MANAGER');
    cashier = await userToken(T.token, 'CASHIER');
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a report registers the terminal and its refusals; replaying the same report changes nothing', async () => {
    const id = uniq('terminal');
    const body = { counts: { pending: 2, conflict: 1, failed: 0, oldestPendingAt: new Date(t0 - 60000).toISOString() }, issues: [conflict('c-1')], label: 'Front desk' };
    const first = await report(cashier, id, { n: 1, body });
    expect(first.status).toBe(200);
    for (let i = 0; i < 3; i += 1) expect((await report(cashier, id, { n: 1, body })).status).toBe(200);

    const rows = await prisma.syncTerminal.findMany({ where: { tenantId: T.tenantId, terminalId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pendingCount: 2, conflictCount: 1, label: 'Front desk' });
    expect(await prisma.syncIssue.count({ where: { terminalRecordId: rows[0].id } })).toBe(1);
  });

  it('many reports racing for one new terminal create it once, and the newest report wins', async () => {
    const id = uniq('race');
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => report(cashier, id, { n: 10 + i, body: { counts: { pending: i, conflict: 0, failed: 0 }, issues: [conflict(`race-${i % 3}`)] } })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const terminals = await prisma.syncTerminal.findMany({ where: { tenantId: T.tenantId, terminalId: id } });
    expect(terminals).toHaveLength(1);
    expect(terminals[0].pendingCount).toBe(11); // the report composed last (n = 21 -> i = 11)
    // A report is a snapshot: one that lost the race to a newer snapshot is dropped, and an entry only that older
    // snapshot named is (correctly) not a current issue. So how many entries were recorded depends on arrival
    // order - but there is never more than one row per entry, and the newest snapshot's entry is always there.
    const issues = await prisma.syncIssue.findMany({ where: { terminalRecordId: terminals[0].id } });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.length).toBeLessThanOrEqual(3);
    expect(new Set(issues.map((i) => i.clientId)).size).toBe(issues.length);
    expect(issues.map((i) => i.clientId)).toContain('race-2'); // report n=21 (i=11 -> race-2) is the newest and always applied
  });

  it('a report that arrives after a newer one is dropped and cannot reopen or overwrite anything', async () => {
    const id = uniq('order');
    await report(cashier, id, { n: 100, body: { counts: { pending: 0, conflict: 1, failed: 0 }, issues: [conflict('o-1')] } });
    // The terminal resolved it (newer report) ...
    expect((await report(cashier, id, { n: 102, body: { counts: { pending: 0, conflict: 0, failed: 0 }, resolved: [{ clientId: 'o-1', resolution: 'synced' }] } })).status).toBe(200);
    // ... and the older report that was still in flight finally lands.
    const late = await report(cashier, id, { n: 101, body: { counts: { pending: 5, conflict: 1, failed: 0 }, issues: [conflict('o-1')] } });
    expect(late.body.stale).toBe(true);
    const terminal = await prisma.syncTerminal.findFirst({ where: { tenantId: T.tenantId, terminalId: id } });
    expect(terminal.pendingCount).toBe(0);
    expect((await prisma.syncIssue.findFirst({ where: { terminalRecordId: terminal.id, clientId: 'o-1' } })).status).toBe('RESOLVED');
  });

  it('an issue is resolved by the terminal and reopens if the same entry is refused again', async () => {
    const id = uniq('reopen');
    await report(cashier, id, { n: 200, body: { counts: { pending: 0, conflict: 1, failed: 0 }, issues: [conflict('r-1')] } });
    await report(cashier, id, { n: 201, body: { resolved: [{ clientId: 'r-1', resolution: 'discarded' }] } });
    const terminal = await prisma.syncTerminal.findFirst({ where: { tenantId: T.tenantId, terminalId: id } });
    let issue = await prisma.syncIssue.findFirst({ where: { terminalRecordId: terminal.id, clientId: 'r-1' } });
    expect(issue).toMatchObject({ status: 'RESOLVED', resolution: 'discarded' });
    await report(cashier, id, { n: 202, body: { counts: { pending: 0, conflict: 1, failed: 0 }, issues: [conflict('r-1', { message: 'Refused again' })] } });
    issue = await prisma.syncIssue.findFirst({ where: { terminalRecordId: terminal.id, clientId: 'r-1' } });
    expect(issue).toMatchObject({ status: 'OPEN', resolution: null, message: 'Refused again' });
  });

  it('reading is for managers; every user can report; another shop sees nothing and cannot touch our issues', async () => {
    const sharedId = uniq('shared-terminal');
    expect((await get(cashier, '/api/sync/terminals')).status).toBe(403);
    expect((await get(cashier, '/api/sync/issues')).status).toBe(403);
    const listed = await get(manager, '/api/sync/terminals');
    expect(listed.status).toBe(200);
    expect(listed.body.summary.terminals).toBeGreaterThanOrEqual(1);

    const other = await registerTenant(uniq('Other Shop'));
    expect((await get(other.token, '/api/sync/terminals')).body.items).toHaveLength(0);
    const mine = (await get(manager, '/api/sync/issues')).body.items[0];
    expect((await post(other.token, `/api/sync/issues/${mine.id}/acknowledge`)).status).toBe(404);
    // Same terminal id, different shop => a separate terminal, never ours.
    await report(other.token, sharedId, { n: 1, body: { issues: [conflict('same-client-id')] } });
    expect(await prisma.syncTerminal.count({ where: { terminalId: sharedId } })).toBe(1);
    expect((await get(manager, '/api/sync/issues')).body.items.some((i) => i.clientId === 'same-client-id')).toBe(false);
  });

  it('two managers acknowledging the same issue at once both get an answer; one acknowledgement is kept; the terminal is told', async () => {
    const id = uniq('ack');
    await report(cashier, id, { n: 300, body: { counts: { pending: 0, conflict: 1, failed: 0 }, issues: [conflict('a-1')] } });
    const issue = (await get(manager, '/api/sync/issues')).body.items.find((i) => i.clientId === 'a-1');
    const admin = T.token;
    const [a, b] = await Promise.all([post(manager, `/api/sync/issues/${issue.id}/acknowledge`, { note: 'looking' }), post(admin, `/api/sync/issues/${issue.id}/acknowledge`, { note: 'me too' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.alreadyHandled, b.body.alreadyHandled].filter(Boolean)).toHaveLength(1);
    const row = await prisma.syncIssue.findUnique({ where: { id: issue.id } });
    expect(row.status).toBe('ACKNOWLEDGED');
    expect(['looking', 'me too']).toContain(row.acknowledgeNote);
    expect(await prisma.auditLog.count({ where: { tenantId: T.tenantId, action: 'SYNC_ISSUE_ACKNOWLEDGE', entityId: issue.id } })).toBe(1);

    const next = await report(cashier, id, { n: 301, body: { counts: { pending: 0, conflict: 1, failed: 0 }, issues: [conflict('a-1')] } });
    expect(next.body.acknowledged.map((x) => x.clientId)).toContain('a-1'); // an acknowledged issue stays acknowledged when re-reported
    expect((await prisma.syncIssue.findUnique({ where: { id: issue.id } })).status).toBe('ACKNOWLEDGED');
  });

  it('the overview totals every terminal and flags one that holds unsent work but has gone quiet', async () => {
    const quiet = uniq('quiet');
    const idle = uniq('idle');
    await report(cashier, quiet, { n: 400, body: { counts: { pending: 4, conflict: 0, failed: 0, oldestPendingAt: new Date(t0 - 3600000).toISOString() } } });
    await report(cashier, idle, { n: 401, body: { counts: { pending: 0, conflict: 0, failed: 0 } } });
    await prisma.syncTerminal.updateMany({ where: { tenantId: T.tenantId, terminalId: { in: [quiet, idle] } }, data: { lastSeenAt: new Date(Date.now() - 3 * 3600000) } });

    const res = await get(manager, '/api/sync/terminals');
    const byId = Object.fromEntries(res.body.items.map((t) => [t.terminalId, t]));
    expect(byId[quiet]).toMatchObject({ silent: true, pendingCount: 4 });
    expect(byId[idle].silent).toBe(false); // quiet, but nothing unsent - not a concern
    expect(res.body.summary.silentWithWork).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.pending).toBe(res.body.items.reduce((s, t) => s + t.pendingCount, 0));
  });

  it('a malformed report is a coded validation error and stores nothing', async () => {
    const before = await prisma.syncTerminal.count({ where: { tenantId: T.tenantId } });
    const res = await post(cashier, '/api/sync/terminal-report', { terminalId: 'x', counts: { pending: -1 } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBeDefined();
    expect(await prisma.syncTerminal.count({ where: { tenantId: T.tenantId } })).toBe(before);
  });
});
