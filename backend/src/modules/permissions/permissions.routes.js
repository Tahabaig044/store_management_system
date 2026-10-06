// Phase 0.4: read-only introspection of the centralized Permission/
// RolePermission catalog - lets an admin (or the frontend) see the full
// authorization model rather than it being implicit in scattered
// requireRole() calls across the codebase. TENANT_ADMIN-only, since this
// exposes the full role/permission matrix, not just the caller's own.
const express = require('express');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY } = require('../../constants/roles');

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...TENANT_ADMIN_ONLY));

router.get('/', async (req, res) => {
  const permissions = await prisma.permission.findMany({
    include: { rolePermissions: true },
    orderBy: [{ resource: 'asc' }, { action: 'asc' }],
  });
  const items = permissions.map((p) => ({
    id: p.id,
    resource: p.resource,
    action: p.action,
    key: p.key,
    roles: p.rolePermissions.map((rp) => rp.role),
  }));
  res.json({ items });
});

module.exports = router;
