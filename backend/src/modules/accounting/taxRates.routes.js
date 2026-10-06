const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY, ALL_ROLES } = require('../../constants/roles');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();
router.use(authenticate, requireTenant);

// Readable by everyone (POS/Purchases need the list to compute tax at the
// point of sale/purchase); only TENANT_ADMIN can change what rates exist -
// rates are never hard-coded, per the Phase 5 tax-configuration requirement.
router.get('/', requireRole(...ALL_ROLES), async (req, res) => {
  const items = await prisma.taxRate.findMany({
    where: { tenantId: req.user.tenantId, ...(req.query.includeInactive === 'true' ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
  res.json({ items });
});

const createSchema = z.object({
  name: z.string().min(1),
  rate: z.number().nonnegative(),
  isInclusive: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});

router.post('/', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid tax rate data', parsed.error.flatten());

  const item = await prisma.$transaction(async (tx) => {
    if (parsed.data.isDefault) {
      await tx.taxRate.updateMany({ where: { tenantId: req.user.tenantId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.taxRate.create({ data: { ...parsed.data, tenantId: req.user.tenantId } });
  });
  res.status(201).json({ item });
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  rate: z.number().nonnegative().optional(),
  isInclusive: z.boolean().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

router.patch('/:id', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid tax rate data', parsed.error.flatten());

  const existing = await prisma.taxRate.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();

  const item = await prisma.$transaction(async (tx) => {
    if (parsed.data.isDefault) {
      await tx.taxRate.updateMany({ where: { tenantId: req.user.tenantId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.taxRate.update({ where: { id: existing.id }, data: parsed.data });
  });
  res.json({ item });
});

module.exports = router;
