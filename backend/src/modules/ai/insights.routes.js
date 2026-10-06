// The AI Recommendation Center: a prioritized, dismissible list of stored
// AiInsight rows (recommendations + anomalies), each with severity,
// evidence, and a drill-down source. Refreshing re-runs the deterministic
// analytics/anomaly scans and upserts insights - it never resets a status
// a user already set, which is what keeps repeated noise down over time.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { refreshInsights } = require('./recommendations');
const { assertWithinQuota, logUsage } = require('./usage');

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...MANAGEMENT));

router.post('/refresh', async (req, res) => {
  await assertWithinQuota(req.user.tenantId);
  const result = await refreshInsights(req.user.tenantId);
  await logUsage({ tenantId: req.user.tenantId, userId: req.user.id, feature: 'insights_refresh', provider: 'deterministic' });
  res.json(result);
});

router.get('/', async (req, res) => {
  const { status, type, severity } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (status) where.status = status;
  if (type) where.type = type;
  if (severity) where.severity = severity;

  const SEVERITY_ORDER = { URGENT: 0, ATTENTION: 1, OPPORTUNITY: 2, INFORMATION: 3 };
  const [items, total] = await Promise.all([
    prisma.aiInsight.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.aiInsight.count({ where }),
  ]);
  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

async function transitionStatus(req, res, status, field) {
  const existing = await prisma.aiInsight.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  const item = await prisma.aiInsight.update({
    where: { id: existing.id },
    data: { status, [`${field}ById`]: req.user.id, [`${field}At`]: new Date() },
  });
  await logAudit({ req, action: `AI_INSIGHT_${status}`, entity: 'AiInsight', entityId: item.id });
  res.json({ item });
}

router.post('/:id/acknowledge', (req, res) => transitionStatus(req, res, 'ACKNOWLEDGED', 'acknowledged'));
router.post('/:id/dismiss', (req, res) => transitionStatus(req, res, 'DISMISSED', 'dismissed'));

const feedbackSchema = z.object({ helpful: z.boolean(), comment: z.string().optional() });

router.post('/:id/feedback', async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid feedback', parsed.error.flatten());
  const existing = await prisma.aiInsight.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  const item = await prisma.aiFeedback.create({
    data: { tenantId: req.user.tenantId, userId: req.user.id, insightId: existing.id, helpful: parsed.data.helpful, comment: parsed.data.comment },
  });
  res.status(201).json({ item });
});

module.exports = router;
