// The Customer Communication Center: unified message history, search/
// filter, safe retry, manual send, and tenant-level statistics. Clinical
// template bodies are redacted for any staff outside CLINICAL_STAFF, even
// though they can still see that a message exists (date/status/customer).
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { COMMUNICATION_STAFF, CLINICAL_STAFF, MANAGEMENT } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { branchScopeWhere } = require('../../middleware/branchScope');
const { queueAndDispatch, dispatchMessage } = require('./queue');
const { renderTemplate } = require('./render');

const CLINICAL_TEMPLATE_TYPES = new Set(['PRESCRIPTION_SUMMARY']);
const REDACTED_BODY = '[Clinical content - restricted]';

function redactIfNeeded(message, canSeeClinical) {
  if (!canSeeClinical && message.template && CLINICAL_TEMPLATE_TYPES.has(message.template.type)) {
    return { ...message, body: REDACTED_BODY };
  }
  return message;
}

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('COMMUNICATION', 'VIEW'), async (req, res) => {
  const { customerId, channel, status, event, from, to } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (customerId) where.customerId = customerId;
  if (channel) where.channel = channel;
  if (status) where.status = status;
  if (event) where.sourceEventType = event;
  if (from || to) {
    where.queuedAt = {};
    if (from) where.queuedAt.gte = new Date(from);
    if (to) where.queuedAt.lte = new Date(to);
  }

  const canSeeClinical = CLINICAL_STAFF.includes(req.user.role);
  const [rows, total] = await Promise.all([
    prisma.message.findMany({
      where,
      include: { customer: true, template: true, automationRule: true, triggeredByUser: { select: { name: true } } },
      orderBy: { queuedAt: 'desc' },
      skip,
      take,
    }),
    prisma.message.count({ where }),
  ]);
  res.json({ items: rows.map((m) => redactIfNeeded(m, canSeeClinical)), total, page: Number(page), pageSize: take });
});

router.get('/stats', requirePermission('COMMUNICATION', 'VIEW'), async (req, res) => {
  const { from, to } = req.query;
  const dateFilter = {};
  if (from) dateFilter.gte = new Date(from);
  if (to) dateFilter.lte = new Date(to);
  const where = { tenantId: req.user.tenantId, ...(from || to ? { queuedAt: dateFilter } : {}) };

  const rows = await prisma.message.groupBy({ by: ['status', 'channel'], where, _count: true });
  const byStatus = {};
  const byChannel = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + r._count;
    byChannel[r.channel] = (byChannel[r.channel] || 0) + r._count;
    total += r._count;
  }
  res.json({ total, byStatus, byChannel });
});

router.get('/:id', requirePermission('COMMUNICATION', 'VIEW'), async (req, res) => {
  const item = await prisma.message.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) },
    include: { customer: true, template: true, automationRule: true },
  });
  if (!item) throw new NotFoundError();
  res.json({ item: redactIfNeeded(item, CLINICAL_STAFF.includes(req.user.role)) });
});

// Manual send - previewed, then sent with explicit staff attribution and a
// confirmation-required client-side step (UX requirement); backend records
// who triggered it either way.
const sendSchema = z.object({
  customerId: z.string().uuid(),
  templateId: z.string().uuid().optional(),
  body: z.string().min(1).optional(),
  idempotencyKey: z.string().optional(),
}).refine((d) => d.templateId || d.body, { message: 'Either templateId or body is required' });

router.post('/', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid message data', parsed.error.flatten());

  const customer = await prisma.customer.findFirst({ where: { id: parsed.data.customerId, tenantId: req.user.tenantId } });
  if (!customer) throw new NotFoundError('Customer not found');
  if (!customer.phone) throw new ValidationError('This customer has no phone number on file');

  let body = parsed.data.body;
  let templateId = parsed.data.templateId;
  if (templateId) {
    const template = await prisma.messageTemplate.findFirst({ where: { id: templateId, tenantId: req.user.tenantId } });
    if (!template) throw new NotFoundError('Template not found');
    if (!body) body = renderTemplate(template.body, { customerName: customer.name });
  }

  const { message, deduplicated } = await queueAndDispatch(prisma, {
    tenantId: req.user.tenantId,
    channel: 'WHATSAPP',
    customerId: customer.id,
    recipientPhone: customer.phone,
    templateId,
    body,
    idempotencyKey: parsed.data.idempotencyKey,
    sourceEventType: 'MANUAL',
    triggeredByUserId: req.user.id,
  });

  await logAudit({ req, action: 'MESSAGE_SEND_MANUAL', entity: 'Message', entityId: message.id, metadata: { customerId: customer.id } });
  res.status(201).json({ item: message, deduplicated });
});

// Safe retry - only a FAILED message can be retried, and only by
// MANAGEMENT; resets it to QUEUED and attempts dispatch immediately.
// retryCount is reset to 0 - a human explicitly asking to retry deserves a
// fresh full set of backoff attempts, not an immediate re-failure because
// the count was already sitting at the cap from before.
router.post('/:id/retry', requireRole(...MANAGEMENT), async (req, res) => {
  const existing = await prisma.message.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  if (existing.status !== 'FAILED') throw new ConflictError('Only a failed message can be retried');

  await prisma.message.update({ where: { id: existing.id }, data: { status: 'QUEUED', failureReason: null, retryCount: 0, nextRetryAt: null } });
  const item = await dispatchMessage(prisma, existing.id);
  await logAudit({ req, action: 'MESSAGE_RETRY', entity: 'Message', entityId: item.id });
  res.json({ item });
});

// Webhook receiver for provider delivery/read/failure callbacks. The mock
// provider has no real webhook to call this, so it's exercised via a
// manual "simulate" call in tests/dev - a real provider would call this
// URL directly, with its own signature verification added at that point.
router.post('/webhook', requireRole(...COMMUNICATION_STAFF), async (req, res) => {
  const schema = z.object({ providerMessageId: z.string(), status: z.enum(['DELIVERED', 'READ', 'FAILED']), failureReason: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid webhook payload', parsed.error.flatten());

  const message = await prisma.message.findFirst({ where: { tenantId: req.user.tenantId, providerMessageId: parsed.data.providerMessageId } });
  if (!message) throw new NotFoundError('No message found for this provider message id');

  const data = { status: parsed.data.status };
  if (parsed.data.status === 'DELIVERED') data.deliveredAt = new Date();
  if (parsed.data.status === 'READ') data.readAt = new Date();
  if (parsed.data.status === 'FAILED') data.failureReason = parsed.data.failureReason;

  const item = await prisma.message.update({ where: { id: message.id }, data });
  res.json({ item });
});

module.exports = router;
