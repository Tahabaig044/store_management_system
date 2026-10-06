const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { forecastSales } = require('./forecast');
const { assertWithinQuota, logUsage } = require('./usage');

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...MANAGEMENT));

const generateSchema = z.object({
  scope: z.enum(['TENANT', 'BRANCH', 'CATEGORY', 'PRODUCT']).default('TENANT'),
  scopeId: z.string().uuid().optional(),
  granularity: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).default('DAILY'),
  horizon: z.number().int().positive().max(90).default(14),
});

async function assertScopeOwnership(tenantId, scope, scopeId) {
  if (!scopeId) return;
  const model = { BRANCH: 'branch', CATEGORY: 'category', PRODUCT: 'product' }[scope];
  if (!model) return;
  const found = await prisma[model].findFirst({ where: { id: scopeId, tenantId } });
  if (!found) throw new NotFoundError(`${scope} not found`);
}

router.post('/generate', async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid forecast request', parsed.error.flatten());
  if (parsed.data.scope !== 'TENANT' && !parsed.data.scopeId) {
    throw new ValidationError(`scopeId is required for scope "${parsed.data.scope}"`);
  }

  await assertScopeOwnership(req.user.tenantId, parsed.data.scope, parsed.data.scopeId);
  await assertWithinQuota(req.user.tenantId);

  const result = await forecastSales(req.user.tenantId, { ...parsed.data, generatedById: req.user.id });
  await logUsage({ tenantId: req.user.tenantId, userId: req.user.id, feature: 'sales_forecast', provider: 'deterministic' });
  res.status(result.insufficientData ? 200 : 201).json({ item: result });
});

router.get('/', async (req, res) => {
  const { scope, scopeId } = req.query;
  const where = { tenantId: req.user.tenantId };
  if (scope) where.scope = scope;
  if (scopeId) where.scopeId = scopeId;
  const items = await prisma.aiForecast.findMany({ where, orderBy: { generatedAt: 'desc' }, take: 20 });
  res.json({ items });
});

module.exports = router;
