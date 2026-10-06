const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY, ALL_ROLES } = require('../../constants/roles');
const { ValidationError } = require('../../utils/errors');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requireRole(...ALL_ROLES), async (req, res) => {
  const settings = await prisma.setting.findMany({ where: { tenantId: req.user.tenantId } });
  res.json({ items: settings });
});

router.put('/:key', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const schema = z.object({ value: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid setting value', parsed.error.flatten());

  const setting = await prisma.setting.upsert({
    where: { tenantId_key: { tenantId: req.user.tenantId, key: req.params.key } },
    create: { tenantId: req.user.tenantId, key: req.params.key, value: parsed.data.value },
    update: { value: parsed.data.value },
  });
  res.json({ item: setting });
});

module.exports = router;
