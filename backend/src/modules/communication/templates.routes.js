const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { renderTemplate, extractPlaceholders } = require('./render');
const { ensureDefaultAutomations } = require('./automation');

const TEMPLATE_TYPES = [
  'INVOICE_RECEIPT', 'PAYMENT_RECEIPT', 'PAYMENT_REMINDER', 'CUSTOMER_STATEMENT',
  'OPTICAL_ORDER_CONFIRMATION', 'OPTICAL_ORDER_STATUS_UPDATE', 'OPTICAL_JOB_READY', 'OPTICAL_ORDER_DELIVERED',
  'APPOINTMENT_CONFIRMATION', 'APPOINTMENT_REMINDER', 'APPOINTMENT_CANCELLED', 'FOLLOW_UP_REMINDER',
  'PRESCRIPTION_SUMMARY', 'PROMOTIONAL', 'CUSTOM',
];

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('COMMUNICATION', 'VIEW'), async (req, res) => {
  await ensureDefaultAutomations(prisma, req.user.tenantId);
  const items = await prisma.messageTemplate.findMany({
    where: { tenantId: req.user.tenantId, ...(req.query.includeInactive === 'true' ? {} : { isActive: true }) },
    orderBy: { type: 'asc' },
  });
  res.json({ items });
});

const createSchema = z.object({
  type: z.enum(TEMPLATE_TYPES),
  name: z.string().min(1),
  body: z.string().min(1),
  channel: z.enum(['WHATSAPP', 'IN_APP', 'EMAIL']).default('WHATSAPP'),
});

router.post('/', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid template data', parsed.error.flatten());
  const item = await prisma.messageTemplate.create({ data: { ...parsed.data, tenantId: req.user.tenantId } });
  res.status(201).json({ item });
});

const updateSchema = z.object({ name: z.string().min(1).optional(), body: z.string().min(1).optional(), isActive: z.boolean().optional() });

router.patch('/:id', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid template data', parsed.error.flatten());
  const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  if (existing.isSystem && parsed.data.isActive === false) throw new ConflictError('System templates cannot be deactivated');
  const item = await prisma.messageTemplate.update({ where: { id: existing.id }, data: parsed.data });
  res.json({ item });
});

// Preview: render the template against sample or caller-supplied variables,
// and list which placeholders it still needs - the "variable/placeholder
// preview before sending" requirement.
router.post('/:id/preview', requirePermission('COMMUNICATION', 'VIEW'), async (req, res) => {
  const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();

  const schema = z.object({ variables: z.record(z.string(), z.string()).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid preview data', parsed.error.flatten());

  const placeholders = extractPlaceholders(existing.body);
  const rendered = renderTemplate(existing.body, parsed.data.variables || {});
  res.json({ placeholders, rendered });
});

module.exports = router;
