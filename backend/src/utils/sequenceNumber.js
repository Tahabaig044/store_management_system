// Human-readable document numbers (INV-000123, JE-000045, RCT-000009 ...), zero-padded to 6 digits.
//
// Numbers used to be "count this tenant's rows + 1", which two simultaneous requests can compute identically:
// the loser then failed on the (tenantId, number) unique index. Under a burst (several terminals reconnecting
// and replaying queued sales at once) that exhausted the callers' retry budgets and rejected valid sales.
//
// Pass the transaction client as `{ tx }` and the number is drawn from a per-tenant, per-prefix counter row with
// ONE atomic upsert inside the document's own transaction:
//   * concurrent creates queue on that row's lock instead of colliding, so no retries are needed;
//   * if the document's transaction rolls back, the counter increment rolls back with it (no gaps);
//   * the counter never falls behind the real data: it is at least (existing rows + 1), so it self-heals for
//     tenants whose documents predate the counter table or were numbered by the old method.
// Without `{ tx }` the legacy count-based behaviour is kept (only used where no transaction client is at hand).
//
// `delegate` is the Prisma model delegate whose rows carry this number series (e.g. tx.sale).
async function nextSequenceNumber(delegate, tenantId, prefix, { padLength = 6, tx } = {}) {
  const count = await delegate.count({ where: { tenantId } });
  let n = count + 1;
  if (tx) {
    const rows = await tx.$queryRaw`
      INSERT INTO "sequence_counters" ("tenantId", "key", "value", "updatedAt")
      VALUES (${tenantId}, ${prefix}, ${n}, NOW())
      ON CONFLICT ("tenantId", "key")
      DO UPDATE SET "value" = GREATEST("sequence_counters"."value" + 1, EXCLUDED."value"), "updatedAt" = NOW()
      RETURNING "value"`;
    n = Number(rows[0].value);
  }
  return `${prefix}-${String(n).padStart(padLength, '0')}`;
}

module.exports = { nextSequenceNumber };
