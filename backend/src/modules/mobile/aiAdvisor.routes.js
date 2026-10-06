// Owner Mobile AI Advisor (Phase 4). Every route here is GET-only, behind
// authenticateMobile + mobileReadOnlyGuard, same as every other mobile
// module - the AI Advisor is decision-support only and never writes
// anything (see dailyBrief.js/trendInsight.js's own headers for why the
// underlying figures are guaranteed evidence-based, never invented).
//
// Marking an insight read/dismissed is intentionally NOT duplicated here:
// AI insights are the exact same AiInsight rows Phase 3's Alert Center
// already exposes, so the Android app reuses the existing
// POST /api/mobile/v1/alerts/:id/read and /:id/dismiss endpoints for that -
// one write path for one underlying resource, not two.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { authenticateMobile, mobileReadOnlyGuard, requireMobilePermission, assertMobileBranch } = require('../../middleware/mobileAuth');
const { getOrGenerateDailyBrief } = require('../ai/dailyBrief');
const { getTrendInsight } = require('../ai/trendInsight');
const { SEVERITY_RANK, mapInsightType, toInsightDto, trendToInsightDto } = require('./aiInsightMapping');

const router = express.Router();
// Phase 4.1: same permission as the web reports/insights; branches must be ones this user may access.
router.use(authenticateMobile, mobileReadOnlyGuard, requireMobilePermission('REPORT', 'VIEW'));

const branchFilterSchema = z.object({ branchId: z.string().uuid().optional() });


router.get('/home', async (req, res) => {
  const parsed = branchFilterSchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid filters', parsed.error.flatten());
  const { branchId } = parsed.data;
  await assertMobileBranch(req.user, branchId);

  const [{ insight: briefInsight, cached }, trend, needsAttentionRows] = await Promise.all([
    getOrGenerateDailyBrief(req.user.tenantId, { branchId }),
    getTrendInsight(req.user.tenantId, { branchId }),
    prisma.aiInsight.findMany({
      where: { tenantId: req.user.tenantId, status: { in: ['NEW', 'ACKNOWLEDGED'] }, type: { in: ['ANOMALY', 'RECOMMENDATION'] } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const needsAttention = needsAttentionRows
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, 5)
    .map((insight, index) => ({ rank: index + 1, ...toInsightDto(insight) }));

  const counts = { anomaly: 0, risk: 0, opportunity: 0, recommendation: 0 };
  for (const row of needsAttentionRows) {
    const t = mapInsightType(row);
    if (t === 'ANOMALY') counts.anomaly += 1;
    else if (t === 'RISK') counts.risk += 1;
    else if (t === 'OPPORTUNITY') counts.opportunity += 1;
    else if (t === 'RECOMMENDATION') counts.recommendation += 1;
  }

  res.json({
    dailyAdvice: { ...toInsightDto(briefInsight), cached },
    needsAttention,
    trend: trendToInsightDto(trend),
    counts: { ...counts, total: needsAttentionRows.length },
  });
});

const briefingSchema = branchFilterSchema.extend({
  forceRegenerate: z.coerce.boolean().default(false),
});

router.get('/briefing', async (req, res) => {
  const parsed = briefingSchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid filters', parsed.error.flatten());
  const { branchId, forceRegenerate } = parsed.data;
  await assertMobileBranch(req.user, branchId);

  const { insight, cached } = await getOrGenerateDailyBrief(req.user.tenantId, { branchId, forceRegenerate });
  res.json({ item: { ...toInsightDto(insight), cached } });
});

router.get('/needs-attention', async (req, res) => {
  const rows = await prisma.aiInsight.findMany({
    where: { tenantId: req.user.tenantId, status: { in: ['NEW', 'ACKNOWLEDGED'] }, type: { in: ['ANOMALY', 'RECOMMENDATION'] } },
    orderBy: { createdAt: 'desc' },
  });
  const items = rows
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, 10)
    .map((insight, index) => ({ rank: index + 1, ...toInsightDto(insight) }));
  res.json({ items, total: rows.length });
});

const historySchema = z.object({
  insightType: z.enum(['PERFORMANCE', 'ANOMALY', 'RISK', 'OPPORTUNITY', 'RECOMMENDATION']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

router.get('/history', async (req, res) => {
  const parsed = historySchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid filters', parsed.error.flatten());
  const f = parsed.data;

  const rows = await prisma.aiInsight.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: 'desc' } });
  let mapped = rows.map(toInsightDto);
  if (f.insightType) mapped = mapped.filter((i) => i.insightType === f.insightType);

  const total = mapped.length;
  const start = (f.page - 1) * f.pageSize;
  const items = mapped.slice(start, start + f.pageSize);
  res.json({ items, total, page: f.page, pageSize: f.pageSize });
});

router.get('/insights/:id', async (req, res) => {
  const insight = await prisma.aiInsight.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!insight) throw new NotFoundError('Insight not found');
  res.json({ item: toInsightDto(insight) });
});

module.exports = router;
