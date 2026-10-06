const prisma = require('../config/prisma');

// Fire-and-forget audit log write. Never throws into the request path -
// an audit logging failure must not block the business operation itself.
// Phase 1.15: accepts an optional `branchId` - when a caller knows the
// actual business object's own branch (e.g. the Sale/Purchase/Return just
// created, which may differ from the acting user's own primary branch for
// an unrestricted TENANT_ADMIN/MANAGER), it should pass that explicitly for
// the most accurate record. When omitted, this falls back to the acting
// user's own `branchId` (a reasonable best-effort default, not a guarantee)
// so every pre-existing call site - none of which pass this new parameter -
// keeps working unchanged and now also gets a non-null branchId "for free"
// whenever the acting user has one, with no call site needing to change.
async function logAudit({ req, action, entity, entityId, metadata, branchId }) {
  try {
    await prisma.auditLog.create({
      data: {
        // Customer Portal requests carry req.portal instead of req.user
        // (a distinct, non-staff identity) - fall back to it so portal
        // activity still lands in the right tenant's audit trail, with
        // userId left null since a portal customer is never a User row.
        tenantId: req.user?.tenantId ?? req.portal?.tenantId ?? null,
        userId: req.user?.id ?? null,
        branchId: branchId ?? req.user?.branchId ?? null,
        action,
        entity,
        entityId,
        metadata,
        ipAddress: req.ip,
      },
    });
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

module.exports = { logAudit };
