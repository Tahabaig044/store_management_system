// Phase 1.15: a read-only viewer for the existing AuditLog table. AuditLog
// itself already existed and has been written to by `logAudit()`
// (middleware/audit.js) across every phase since 1.1 - this module adds the
// first-ever GET endpoint for it, deliberately NOT a new/parallel log
// table. Immutable by design: no PATCH/PUT/DELETE route exists here or
// anywhere else in the codebase for AuditLog, and no route in this file
// (or any other) ever calls `prisma.auditLog.update`/`.delete` - history
// cannot be rewritten through this API.
const express = require('express');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { NotFoundError } = require('../../utils/errors');
const { branchScopeWhere, assertBranchAccess } = require('../../middleware/branchScope');

const router = express.Router();
router.use(authenticate, requireTenant, requirePermission('AUDIT_LOG', 'VIEW'));

router.get('/', async (req, res) => {
  const { userId, action, entity, entityId, branchId, search, from, to } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (userId) where.userId = userId;
  if (action) where.action = action;
  if (entity) where.entity = entity;
  if (entityId) where.entityId = entityId;
  if (search) {
    where.OR = [
      { action: { contains: search, mode: 'insensitive' } },
      { entity: { contains: search, mode: 'insensitive' } },
      { entityId: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  // branchId is validated against the caller's own access first (mirrors
  // Sale/SalesReturn/etc.'s identical explicit-filter-vs-scope convention)
  // so a restricted user can't use it to see outside branchScopeWhere's
  // own restriction.
  if (branchId) {
    await assertBranchAccess(prisma, req.user, branchId);
    where.branchId = branchId;
  }

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { name: true, role: true } }, branch: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.auditLog.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', async (req, res) => {
  const item = await prisma.auditLog.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) },
    include: { user: { select: { name: true, role: true } }, branch: { select: { name: true } } },
  });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

module.exports = router;
