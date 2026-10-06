const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY, FINANCE_STAFF } = require('../../constants/roles');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requireRole(...FINANCE_STAFF), async (req, res) => {
  const items = await prisma.accountingPeriod.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { startDate: 'desc' } });
  res.json({ items });
});

const createSchema = z.object({
  name: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

// Closing/opening periods is TENANT_ADMIN-only - it's the single control
// that makes historical postings immutable, so it deliberately sits above
// even MANAGER/ACCOUNTANT.
router.post('/', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid period data', parsed.error.flatten());
  if (parsed.data.startDate >= parsed.data.endDate) throw new ValidationError('startDate must be before endDate');

  const item = await prisma.accountingPeriod.create({ data: { ...parsed.data, tenantId: req.user.tenantId } });
  res.status(201).json({ item });
});

router.post('/:id/close', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const existing = await prisma.accountingPeriod.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  if (existing.status === 'CLOSED') throw new ConflictError('Period is already closed');

  const item = await prisma.accountingPeriod.update({
    where: { id: existing.id },
    data: { status: 'CLOSED', closedAt: new Date(), closedById: req.user.id },
  });
  res.json({ item });
});

router.post('/:id/reopen', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const existing = await prisma.accountingPeriod.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();

  const item = await prisma.accountingPeriod.update({
    where: { id: existing.id },
    data: { status: 'OPEN', closedAt: null, closedById: null },
  });
  res.json({ item });
});

module.exports = router;
