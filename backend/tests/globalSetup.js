// Runs once before the whole jest run.
//
// 1. Isolation guard: the suites create and mutate real rows, and backend/.env
//    may point at a hosted (production) database. Refuse to run unless the
//    database host is local.
// 2. Seed the global permission catalog (idempotent upserts). Without it every
//    authenticated route answers 403, so a fresh test database would fail.
require('dotenv').config();
const { execFileSync } = require('child_process');
const path = require('path');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

module.exports = async () => {
  const url = process.env.DATABASE_URL || '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // fall through to the refusal below
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run tests: DATABASE_URL host "${host || 'unparseable'}" is not local. ` +
        'Point DATABASE_URL at a local/CI test database (see README "Testing").'
    );
  }
  execFileSync(process.execPath, [path.join(__dirname, '..', 'prisma', 'seedPermissions.js')], {
    stdio: 'ignore',
    env: process.env,
  });
};
