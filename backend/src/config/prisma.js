const { PrismaClient } = require('@prisma/client');

// Connection pool sizing. Prisma's default pool is only (CPU cores x 2 + 1) connections with a 10 s wait.
// Document numbers are drawn from a per-tenant counter inside the document's own transaction, so a burst of
// simultaneous sales (several terminals reconnecting and replaying queued work) is served one after another
// while each waiting request holds a connection; with the default pool the later ones failed with "Timed out
// fetching a new connection" (found by the multi-terminal pilot / sequenceNumbering test). A larger pool and a
// longer wait absorb such bursts. Set connection_limit / pool_timeout in DATABASE_URL to override, or
// DB_POOL_SIZE for the size only. Keep (pool size x API processes) below PostgreSQL's max_connections (100).
function withPoolDefaults(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', process.env.DB_POOL_SIZE || '25');
    if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', '30');
    return u.toString();
  } catch {
    return url;
  }
}

// Single shared Prisma client instance for the process.
//
// Raised interactive-transaction limits (Prisma's defaults are 5s timeout /
// 2s maxWait): several code paths - most notably ensureChartOfAccounts()
// lazily seeding ~17 ledger accounts as sequential queries the first time a
// tenant does anything accounting-related - run a chain of round-trips
// inside one $transaction. That comfortably finishes in well under 5s
// against a low-latency local database, but against a pooled remote
// Postgres (e.g. Neon) each round-trip is slow enough that the default
// timeout is exceeded on a fresh tenant's very first transaction. Raising
// the limit here (rather than per call site) covers every current and
// future $transaction in the codebase, and has no effect on the common
// case where a transaction already finishes quickly.
const prisma = new PrismaClient({
  datasourceUrl: withPoolDefaults(process.env.DATABASE_URL),
  transactionOptions: { timeout: 30000, maxWait: 30000 },
});

module.exports = prisma;
