// Shared dedup lookup for offline-sync-safe creates. Every model that
// supports client-generated idempotency keys has a @@unique([tenantId,
// idempotencyKey]) constraint - this just looks up whether that key has
// already been used, so a retried sync request returns the original record
// instead of creating a duplicate.
async function findExistingByIdempotencyKey(delegate, tenantId, idempotencyKey, include) {
  if (!idempotencyKey) return null;
  return delegate.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    include,
  });
}

module.exports = { findExistingByIdempotencyKey };
