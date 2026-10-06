// AI usage/cost report and "most-used questions" analytics - required by
// the phase's reporting section. TENANT_ADMIN only, since this exposes
// per-user request volume across the whole tenant.
const express = require('express');
const prisma = require('../../config/prisma');
const { dateRange } = require('../../utils/dateRange');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY } = require('../../constants/roles');

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...TENANT_ADMIN_ONLY));

router.get('/', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const logs = await prisma.aiUsageLog.findMany({ where: { tenantId: req.user.tenantId, createdAt: { gte: from, lte: to } } });
  const byFeature = {};
  let totalCost = 0;
  for (const l of logs) {
    byFeature[l.feature] = (byFeature[l.feature] || 0) + 1;
    totalCost += Number(l.costEstimate || 0);
  }
  res.json({ from, to, totalRequests: logs.length, byFeature, totalCostEstimate: totalCost });
});

router.get('/most-used-questions', async (req, res) => {
  const conversations = await prisma.aiConversation.findMany({
    where: { tenantId: req.user.tenantId },
    include: { messages: { where: { role: 'ASSISTANT' }, select: { intent: true } } },
  });
  const counts = {};
  for (const c of conversations) {
    for (const m of c.messages) {
      if (!m.intent) continue;
      counts[m.intent] = (counts[m.intent] || 0) + 1;
    }
  }
  const items = Object.entries(counts).map(([intent, count]) => ({ intent, count })).sort((a, b) => b.count - a.count);
  res.json({ items });
});

module.exports = router;
