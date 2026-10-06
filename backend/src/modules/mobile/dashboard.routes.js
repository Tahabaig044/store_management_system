// Owner Mobile executive dashboard - Phase 2, extended in Phase 4.2 (purchases, payables, cash & bank, company
// filter). Every route here is GET-only and protected by authenticateMobile + mobileReadOnlyGuard (see
// middleware/mobileAuth.js). All calculations are delegated to dashboardService.js, which calls the tenant's
// existing analytics engine (modules/ai/analytics.js) and the ledger's own cash/bank report.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { ValidationError } = require('../../utils/errors');
const { authenticateMobile, mobileReadOnlyGuard, requireMobilePermission, assertMobileBranch, branchContext } = require('../../middleware/mobileAuth');
const { resolveBranchIds } = require('../accounting/financialReportsService');
const dashboardService = require('./dashboardService');

const router = express.Router();
// Phase 4.1: the dashboards are reports - the same REPORT:VIEW permission the web reports need.
router.use(authenticateMobile, mobileReadOnlyGuard, requireMobilePermission('REPORT', 'VIEW'));

const PRODUCT_TYPES = ['GENERAL', 'MEDICINE', 'FRAME', 'LENS'];

const filterSchema = z.object({
  range: z.enum(['today', 'yesterday', 'week', 'month', 'custom']).default('today'),
  from: z.string().optional(),
  to: z.string().optional(),
  branchId: z.string().uuid().optional(),
  // Phase 4.2: a company narrows the figures to its branches (still limited to what the user may access).
  companyId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  // "Business Area" filter from the phase spec - this schema's closest
  // equivalent to a distinct business line is Product.type.
  productType: z.enum(PRODUCT_TYPES).optional(),
});

// Turns the chosen branch/company and the user's own access into the branch scope every figure is computed over:
//   nothing chosen, unrestricted user  -> no filter (the whole business)
//   one branch                         -> that branch (must be the tenant's AND one the user may access: 422 / 403)
//   a company                          -> the accessible branches of that company
//   nothing chosen, restricted user    -> exactly the branches they may access
// The scope is only ever narrowed from the user's own access, never widened.
async function parseFilters(req) {
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid dashboard filters', parsed.error.flatten());
  const filters = parsed.data;
  await assertMobileBranch(req.user, filters.branchId);

  if (filters.companyId) {
    const company = await prisma.company.findFirst({ where: { id: filters.companyId, tenantId: req.user.tenantId } });
    if (!company) throw new ValidationError('companyId does not belong to this tenant');
    const ids = await resolveBranchIds(prisma, req.user, { branchId: filters.branchId, companyId: filters.companyId });
    filters.branchId = { in: ids };
  } else if (!filters.branchId) {
    const ctx = await branchContext(req.user);
    if (ctx.restricted) filters.branchId = { in: ctx.branchIds };
  }
  return filters;
}

router.get('/summary', async (req, res) => {
  const filters = await parseFilters(req);
  res.json(await dashboardService.getSummary(req.user.tenantId, filters));
});

router.get('/sales', async (req, res) => {
  const filters = await parseFilters(req);
  res.json(await dashboardService.getSales(req.user.tenantId, filters));
});

router.get('/profit', async (req, res) => {
  const filters = await parseFilters(req);
  res.json(await dashboardService.getProfit(req.user.tenantId, filters));
});

router.get('/expenses', async (req, res) => {
  const filters = await parseFilters(req);
  res.json(await dashboardService.getExpensesSummary(req.user.tenantId, filters));
});

router.get('/receivables', async (req, res) => {
  const filters = await parseFilters(req);
  res.json(await dashboardService.getReceivablesSummary(req.user.tenantId, filters));
});

router.get('/purchases', async (req, res) => {
  const filters = await parseFilters(req);
  res.json(await dashboardService.getPurchases(req.user.tenantId, filters));
});

router.get('/cash', async (req, res) => {
  const filters = await parseFilters(req);
  res.json(await dashboardService.getCash(req.user.tenantId, filters));
});

router.get('/inventory', async (req, res) => {
  const filters = await parseFilters(req);
  res.json(await dashboardService.getInventorySummary(req.user.tenantId, filters));
});

// The choices the filter bar offers: only what this user may access.
router.get('/filters', async (req, res) => {
  const all = await dashboardService.getFilters(req.user.tenantId);
  const ctx = await branchContext(req.user);
  if (!ctx.restricted) return res.json(all);
  const branches = all.branches.filter((b) => ctx.branchIds.includes(b.id));
  const companyIds = new Set(branches.map((b) => b.companyId).filter(Boolean));
  return res.json({ ...all, branches, companies: all.companies.filter((c) => companyIds.has(c.id)) });
});

module.exports = router;
