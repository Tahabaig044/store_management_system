// Owner Mobile Alert Center (Phase 3). Alerts are the tenant's existing
// AiInsight rows (see modules/ai/recommendations.js) shaped through
// alertMapping.js - this router never creates its own alert rows.
//
// Marking an alert read/dismissed is the one deliberate exception to the
// read-only rule established in Phase 1: it is pure notification-state
// metadata on the AiInsight row itself (status/acknowledgedAt/dismissedAt),
// never touches a Sale/Product/Customer/etc. business record, and the phase
// spec explicitly calls this out ("dismiss/archive behavior without
// modifying underlying business data"). It follows the same
// safe-write-before-the-guard pattern already used for POST /auth/logout in
// mobile.routes.js. Every other write remains blocked by mobileReadOnlyGuard.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { authenticateMobile, mobileReadOnlyGuard, requireMobilePermission } = require('../../middleware/mobileAuth');
const { toAlertDto } = require('./alertMapping');

const router = express.Router();
router.use(authenticateMobile, requireMobilePermission('REPORT', 'VIEW')); // alerts are the AI insights the web reports expose

async function loadOwnedInsight(req) {
  const insight = await prisma.aiInsight.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!insight) throw new NotFoundError('Alert not found');
  return insight;
}

router.post('/:id/read', async (req, res) => {
  const existing = await loadOwnedInsight(req);
  const item = existing.status === 'NEW'
    ? await prisma.aiInsight.update({
        where: { id: existing.id },
        data: { status: 'ACKNOWLEDGED', acknowledgedById: req.user.id, acknowledgedAt: new Date() },
      })
    : existing;
  await logAudit({ req, action: 'MOBILE_ALERT_READ', entity: 'AiInsight', entityId: item.id });
  res.json({ item: toAlertDto(item) });
});

router.post('/:id/dismiss', async (req, res) => {
  const existing = await loadOwnedInsight(req);
  const item = await prisma.aiInsight.update({
    where: { id: existing.id },
    data: { status: 'DISMISSED', dismissedById: req.user.id, dismissedAt: new Date() },
  });
  await logAudit({ req, action: 'MOBILE_ALERT_DISMISS', entity: 'AiInsight', entityId: item.id });
  res.json({ item: toAlertDto(item) });
});

// Everything below this point must be a read (GET).
router.use(mobileReadOnlyGuard);

const listSchema = z.object({
  status: z.enum(['unread', 'read', 'all']).default('all'),
  priority: z.enum(['CRITICAL', 'IMPORTANT', 'INFORMATIONAL']).optional(),
  // Phase 4.2: "important alerts" for the dashboard = CRITICAL + IMPORTANT (everything but informational).
  important: z.enum(['true', 'false']).optional(),
  category: z.enum(['SALES', 'PROFIT', 'RECEIVABLES', 'INVENTORY', 'EXPENSES', 'BUSINESS_ANOMALY', 'PERFORMANCE']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

router.get('/', async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid alert filters', parsed.error.flatten());
  const f = parsed.data;

  // status/priority/category are mapped display concepts (see
  // alertMapping.js), not raw columns, so filtering happens in JS after a
  // tenant-scoped fetch rather than in the SQL where-clause. Alert volume
  // per tenant is small (bounded by AiInsight's own dedupe/upsert model),
  // so this is not a performance concern.
  const all = await prisma.aiInsight.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: 'desc' } });
  let mapped = all.map(toAlertDto);

  if (f.status === 'unread') mapped = mapped.filter((a) => !a.isRead);
  if (f.status === 'read') mapped = mapped.filter((a) => a.isRead);
  if (f.priority) mapped = mapped.filter((a) => a.priority === f.priority);
  if (f.important === 'true') mapped = mapped.filter((a) => a.priority === 'CRITICAL' || a.priority === 'IMPORTANT');
  if (f.category) mapped = mapped.filter((a) => a.category === f.category);

  const total = mapped.length;
  const start = (f.page - 1) * f.pageSize;
  const items = mapped.slice(start, start + f.pageSize);

  res.json({ items, total, page: f.page, pageSize: f.pageSize });
});

router.get('/meta/categories', async (req, res) => {
  res.json({
    categories: ['SALES', 'PROFIT', 'RECEIVABLES', 'INVENTORY', 'EXPENSES', 'BUSINESS_ANOMALY', 'PERFORMANCE'],
    priorities: ['CRITICAL', 'IMPORTANT', 'INFORMATIONAL'],
  });
});

router.get('/:id', async (req, res) => {
  const insight = await loadOwnedInsight(req);
  res.json({ item: toAlertDto(insight) });
});

module.exports = router;
