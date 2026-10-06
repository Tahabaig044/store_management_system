// Shared helpers for the live validation scripts (pilot.js, load.js). They talk to a RUNNING server over real
// HTTP - point BASE_URL at a local/staging server whose database is disposable. Never point them at production:
// they create tenants, products and sales.
const BASE = process.env.BASE_URL || 'http://localhost:4100/api';

if (/neon\.tech|amazonaws|vercel\.app/i.test(BASE) && process.env.I_UNDERSTAND_THIS_WRITES_DATA !== 'yes') {
  console.error(`Refusing to run against ${BASE}: these scripts write test data.`);
  process.exit(2);
}

let ipCounter = 0;
// The server trusts one proxy hop, so a distinct X-Forwarded-For per simulated terminal gives each its own
// rate-limit bucket, like separate shops would have.
const fakeIp = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

async function call(method, path, { token, body, ip, raw } = {}) {
  const started = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip || fakeIp(++ipCounter),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ms = performance.now() - started;
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return raw ? { status: res.status, data, ms, res } : { status: res.status, data, ms };
}

// For seeding only: a real client that is rate-limited waits and retries. Scenario calls do NOT use this, so a
// 429 can never hide a concurrency result.
async function seedCall(method, path, opts = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const r = await call(method, path, opts);
    if (r.status !== 429 || attempt >= 8) return r;
    await new Promise((res) => setTimeout(res, 15000));
  }
}

async function mustOk(label, p, expected = [200, 201]) {
  const r = await p;
  if (!expected.includes(r.status)) throw new Error(`${label}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r;
}

async function registerTenant(name) {
  const email = `pilot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const r = await mustOk('register', call('POST', '/auth/register-tenant', {
    body: { businessName: name, adminName: 'Pilot Owner', email, password: 'PilotPass123' },
  }));
  return { token: r.data.token, tenantId: r.data.tenant.id, email, password: 'PilotPass123', user: r.data.user };
}

async function createUser(adminToken, role, branchId) {
  const email = `${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  await mustOk('create user', call('POST', '/users', { token: adminToken, body: { name: `Pilot ${role}`, email, password: 'PilotPass123', role, branchId } }));
  const login = await mustOk('login', call('POST', '/auth/login', { body: { email, password: 'PilotPass123' } }));
  return login.data.token;
}

// Run `tasks` (array of async functions) with at most `limit` in flight.
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }));
  return results;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const uuid = () => crypto.randomUUID();

module.exports = { BASE, call, seedCall, mustOk, registerTenant, createUser, pool, percentile, uuid };
