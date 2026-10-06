// Tenant-configurable automation rules: enable/disable, adjust delay/
// template/conditions, and inspect the execution log. System-seeded rules
// (isSystem) can be disabled/reconfigured but never deleted, mirroring the
// system-template protection in templates.routes.js.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { ensureDefaultAutomations } = require('./automation');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('COMMUNICATION', 'VIEW'), async (req, res) => {
  await ensureDefaultAutomations(prisma, req.user.tenantId);
  const items = await prisma.automationRule.findMany({
    where: { tenantId: req.user.tenantId },
    include: { template: true },
    orderBy: { event: 'asc' },
  });
  res.json({ items });
});

const updateSchema = z.object({
  isEnabled: z.boolean().optional(),
  delayMinutes: z.number().int().min(0).max(10080).optional(),
  templateId: z.string().uuid().nullable().optional(),
  conditions: z.record(z.string(), z.any()).nullable().optional(),
  name: z.string().min(1).optional(),
});

router.patch('/:id', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid automation rule data', parsed.error.flatten());

  const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();

  if (parsed.data.templateId) {
    const template = await prisma.messageTemplate.findFirst({ where: { id: parsed.data.templateId, tenantId: req.user.tenantId } });
    if (!template) throw new NotFoundError('Template not found');
  }

  const item = await prisma.automationRule.update({ where: { id: existing.id }, data: parsed.data });
  res.json({ item });
});

router.delete('/:id', requireRole(...MANAGEMENT), async (req, res) => {
  const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  if (existing.isSystem) throw new ConflictError('System automation rules cannot be deleted - disable it instead');
  await prisma.automationRule.delete({ where: { id: existing.id } });
  res.status(204).send();
});

router.get('/:id/executions', requirePermission('COMMUNICATION', 'VIEW'), async (req, res) => {
  const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();

  const { page, pageSize, skip, take } = parsePagination(req.query);

  const [items, total] = await Promise.all([
    prisma.automationExecution.findMany({
      where: { automationRuleId: existing.id, tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.automationExecution.count({ where: { automationRuleId: existing.id, tenantId: req.user.tenantId } }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

module.exports = router;
