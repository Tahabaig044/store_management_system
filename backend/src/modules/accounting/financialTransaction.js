// Phase 2.4: one entry point for every transaction that moves money or stock.
//
// Wraps prisma.$transaction with the same bounded retry on a database-detected write
// conflict / deadlock (Prisma P2034, Postgres 40001/40P01) - the only failure a caller
// cannot cause and can safely retry, because the callback re-runs from a clean state.
// Business errors (validation, conflict, not-found) are never retried.
const prisma = require('../../config/prisma');

const RETRYABLE = new Set(['P2034']);
const MAX_ATTEMPTS = 4;

function isRetryable(err) {
  return RETRYABLE.has(err?.code) || /deadlock detected|could not serialize access/i.test(err?.message || '');
}

async function runFinancialTransaction(client, fn, options) {
  const root = client || prisma;
  for (let attempt = 1; ; attempt++) {
    try {
      return await root.$transaction(fn, options);
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 15 * attempt + Math.floor(Math.random() * 25)));
    }
  }
}

module.exports = { runFinancialTransaction, isRetryable };
