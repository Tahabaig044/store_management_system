// Internal notification center (in-app "bell") - every authenticated staff
// user can see and manage their own notifications; there is no cross-user
// access at all, unlike most other tenant resources which are role-scoped.
const express = require('express');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { NotFoundError } = require('../../utils/errors');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', async (req, res) => {
  // Phase 1.15: added type/priority/from/to filters alongside the existing
  // unreadOnly - the response shape (items/total/unreadCount/page/pageSize)
  // is completely unchanged for every existing caller that doesn't pass them.
  const { unreadOnly, type, priority, from, to } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, userId: req.user.id, ...(unreadOnly === 'true' ? { isRead: false } : {}) };
  if (type) where.type = type;
  if (priority) where.priority = priority;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  const [items, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { tenantId: req.user.tenantId, userId: req.user.id, isRead: false } }),
  ]);
  res.json({ items, total, unreadCount, page: Number(page), pageSize: take });
});

router.get('/unread-count', async (req, res) => {
  const count = await prisma.notification.count({ where: { tenantId: req.user.tenantId, userId: req.user.id, isRead: false } });
  res.json({ count });
});

// Phase 1.15: detail view, for a client that wants the full row (e.g. to
// follow entityType/entityId to the source record) without it appearing in
// the paginated list response.
router.get('/:id', async (req, res) => {
  const item = await prisma.notification.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId, userId: req.user.id } });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.patch('/:id/read', async (req, res) => {
  const existing = await prisma.notification.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId, userId: req.user.id } });
  if (!existing) throw new NotFoundError();
  // Idempotent: re-marking an already-read notification simply keeps its
  // original readAt rather than overwriting it with a later timestamp -
  // safe under a retried/duplicate request or a concurrent second read.
  const item = await prisma.notification.update({
    where: { id: existing.id },
    data: { isRead: true, readAt: existing.readAt ?? new Date() },
  });
  res.json({ item });
});

router.post('/mark-all-read', async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { tenantId: req.user.tenantId, userId: req.user.id, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  res.json({ updated: result.count });
});

// Phase 1.15: dismiss/delete - self-scoped exactly like every other action
// here, no RBAC gate needed (a user can only ever delete their own row).
router.delete('/:id', async (req, res) => {
  const existing = await prisma.notification.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId, userId: req.user.id } });
  if (!existing) throw new NotFoundError();
  await prisma.notification.delete({ where: { id: existing.id } });
  res.status(204).end();
});

module.exports = router;
