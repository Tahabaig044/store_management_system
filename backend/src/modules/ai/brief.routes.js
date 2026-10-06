const express = require('express');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { NotFoundError } = require('../../utils/errors');
const { compileDailyBrief } = require('./brief');
const { assertWithinQuota, logUsage } = require('./usage');

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...MANAGEMENT));

router.get('/', async (req, res) => {
  await assertWithinQuota(req.user.tenantId);
  const { branchId } = req.query;
  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }
  const brief = await compileDailyBrief(req.user.tenantId, { branchId });
  await logUsage({ tenantId: req.user.tenantId, userId: req.user.id, feature: 'daily_brief', provider: 'deterministic' });
  res.json({ item: brief });
});

module.exports = router;
