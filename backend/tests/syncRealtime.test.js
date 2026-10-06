// Phase 3.4 - the "something changed" stream (SSE) and reconciliation retention, over a real HTTP server.
// Proven: authentication is required; another terminal of the same shop is told within a moment of a write;
// a burst is collapsed; reads and rejected writes announce nothing; another shop hears nothing; the per-user
// cap holds and closed streams are released; and an event carries no business data.
const http = require('http');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { stats } = require('../src/modules/sync/realtime');

jest.setTimeout(120000);

const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const post = (t, path, body) => request(app).post(path).set(auth(t)).send(body || {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function registerTenant(name) {
  const res = await request(app).post('/api/auth/register-tenant').send({ businessName: name, adminName: 'Admin', email: `${uniq('a')}@test.local`, password: 'TestPass123' });
  if (res.status !== 201) throw new Error(`register failed ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}

let server;
let port;
const openStreams = [];

// Opens the stream and collects what arrives. Resolves once the response headers are in.
function openStream(token) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/sync/stream', headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        for (const block of body.split('\n\n').slice(0, -1)) {
          const m = /^event: (\w+)\ndata: (.*)$/m.exec(block);
          if (m && !events.some((e) => e.raw === block)) events.push({ raw: block, event: m[1], data: JSON.parse(m[2]) });
        }
      });
      const handle = { status: res.statusCode, events, close: () => req.destroy(), body: () => body, res };
      openStreams.push(handle);
      resolve(handle);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}
const changed = (h) => h.events.filter((e) => e.event === 'changed');
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return false; };

describe('Phase 3.4 - realtime refresh stream', () => {
  let T;
  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    T = await registerTenant(uniq('Realtime'));
  });
  afterAll(async () => {
    openStreams.forEach((h) => h.close());
    await new Promise((r) => server.close(r));
    await prisma.$disconnect();
  });

  it('requires a valid session', async () => {
    const h = await openStream(null);
    expect(h.status).toBe(401);
    const bad = await openStream('not-a-token');
    expect(bad.status).toBe(401);
  });

  it('another terminal of the same shop is told about a write; a burst collapses; the event carries no business data', async () => {
    const listener = await openStream(T.token);
    expect(listener.status).toBe(200);
    expect(await waitFor(() => listener.events.some((e) => e.event === 'ready'))).toBe(true);

    await Promise.all(Array.from({ length: 8 }, (_, i) => post(T.token, '/api/products', { name: uniq(`P${i}`), sellingPrice: 5, purchasePrice: 2, openingStock: 1 })));
    expect(await waitFor(() => changed(listener).length >= 1)).toBe(true);
    await sleep(700);
    expect(changed(listener).length).toBeLessThanOrEqual(3); // 8 writes, not 8 events
    expect(Object.keys(changed(listener)[0].data)).toEqual(['at']); // "something changed" - nothing more
    expect(listener.body()).not.toMatch(/openingStock|sellingPrice|P0/);
    listener.close();
  });

  it('reads and rejected writes announce nothing; neither do terminal reports', async () => {
    const listener = await openStream(T.token);
    await waitFor(() => listener.events.some((e) => e.event === 'ready'));
    await request(app).get('/api/products').set(auth(T.token));
    await post(T.token, '/api/products', { name: '' }); // invalid -> rejected
    await post(T.token, '/api/sync/terminal-report', { terminalId: uniq('term-x'), sentAt: new Date().toISOString(), counts: { pending: 0, conflict: 0, failed: 0 } });
    await sleep(700);
    expect(changed(listener)).toHaveLength(0);
    listener.close();
  });

  it('another shop hears nothing of our writes', async () => {
    const other = await registerTenant(uniq('Other'));
    const theirs = await openStream(other.token);
    const ours = await openStream(T.token);
    await waitFor(() => theirs.events.length >= 1 && ours.events.length >= 1);
    await post(T.token, '/api/products', { name: uniq('Mine'), sellingPrice: 5, purchasePrice: 2, openingStock: 1 });
    expect(await waitFor(() => changed(ours).length >= 1)).toBe(true);
    await sleep(500);
    expect(changed(theirs)).toHaveLength(0);
    theirs.close();
    ours.close();
  });

  it('caps streams per user, and releases them when they close', async () => {
    const U = await registerTenant(uniq('Caps'));
    const held = [];
    for (let i = 0; i < 5; i += 1) held.push(await openStream(U.token));
    expect(held.every((h) => h.status === 200)).toBe(true);
    const sixth = await openStream(U.token);
    expect(sixth.status).toBe(429);
    expect(sixth.body()).toContain('TOO_MANY_STREAMS');
    const before = stats().streams;
    held.slice(0, 2).forEach((h) => h.close());
    expect(await waitFor(() => stats().streams <= before - 2)).toBe(true);
    const again = await openStream(U.token); // room again
    expect(again.status).toBe(200);
    held.forEach((h) => h.close());
    again.close();
  });
});

describe('Phase 3.4 - reconciliation retention', () => {
  it('resolved issues older than 90 days are dropped when the terminal next reports; recent ones and open ones stay', async () => {
    const T = await registerTenant(uniq('Retention'));
    const id = uniq('term-ret');
    const report = (n, body = {}) => post(T.token, '/api/sync/terminal-report', { terminalId: id, sentAt: new Date(Date.now() + n * 1000).toISOString(), counts: { pending: 0, conflict: 0, failed: 0 }, ...body });
    await report(1, { issues: [{ clientId: 'old', entity: 'Sale', kind: 'X', message: 'm' }, { clientId: 'recent', entity: 'Sale', kind: 'X', message: 'm' }, { clientId: 'open', entity: 'Sale', kind: 'X', message: 'm' }] });
    const term = await prisma.syncTerminal.findFirst({ where: { tenantId: T.tenantId, terminalId: id } });
    await prisma.syncIssue.updateMany({ where: { terminalRecordId: term.id, clientId: 'old' }, data: { status: 'RESOLVED', resolvedAt: new Date(Date.now() - 100 * 86400000), resolution: 'synced' } });
    await prisma.syncIssue.updateMany({ where: { terminalRecordId: term.id, clientId: 'recent' }, data: { status: 'RESOLVED', resolvedAt: new Date(Date.now() - 5 * 86400000), resolution: 'synced' } });
    await report(2);
    for (let i = 0; i < 40; i += 1) {
      if ((await prisma.syncIssue.count({ where: { terminalRecordId: term.id, clientId: 'old' } })) === 0) break;
      await sleep(50);
    }
    const left = (await prisma.syncIssue.findMany({ where: { terminalRecordId: term.id } })).map((i) => i.clientId).sort();
    expect(left).toEqual(['open', 'recent']);
  });
});
