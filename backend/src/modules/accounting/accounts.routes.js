const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { ensureChartOfAccounts } = require('./ledger');
const service = require('./accountingService');

const router = express.Router();
router.use(authenticate, requireTenant);

// Phase 2.1: these routes previously used requireRole(...FINANCE_STAFF) /
// requireRole(...MANAGEMENT). They now use the centralized permission catalog
// (ACCOUNT:*), seeded with exactly those same role groups, so who can do what
// is unchanged - only where it is defined moved. Business rules (parent/type
// consistency, safe deactivation, code uniqueness) live in accountingService.js.

router.get('/', requirePermission('ACCOUNT', 'VIEW'), async (req, res) => {
  await prisma.$transaction((tx) => ensureChartOfAccounts(tx, req.user.tenantId));
  const { type, search } = req.query;
  const items = await prisma.account.findMany({
    where: {
      tenantId: req.user.tenantId,
      ...(req.query.includeInactive === 'true' ? {} : { isActive: true }),
      ...(type ? { type } : {}),
      ...(search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } : {}),
    },
    orderBy: { code: 'asc' },
  });
  res.json({ items });
});

// Nested hierarchy; ?withBalances=true adds each node's own and rolled-up
// (including descendants) balance.
router.get('/tree', requirePermission('ACCOUNT', 'VIEW'), async (req, res) => {
  const items = await service.getAccountTree(prisma, req.user.tenantId, {
    includeInactive: req.query.includeInactive === 'true',
    withBalances: req.query.withBalances === 'true',
  });
  res.json({ items });
});

router.get('/:id', requirePermission('ACCOUNT', 'VIEW'), async (req, res) => {
  const item = await service.getAccountDetail(prisma, req.user.tenantId, req.params.id);
  res.json({ item });
});

// `type` is chosen once at creation and is immutable afterwards (changing it
// would silently reclassify every posted line).
const createSchema = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(200),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  parentId: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
});

router.post('/', requirePermission('ACCOUNT', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid account data', parsed.error.flatten());
  const item = await service.createAccount(prisma, req.user.tenantId, parsed.data);
  await logAudit({ req, action: 'ACCOUNT_CREATE', entity: 'Account', entityId: item.id, metadata: { code: item.code, type: item.type } });
  res.status(201).json({ item });
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    code: z.string().min(1).max(30).optional(),
    description: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    parentId: z.string().uuid().nullable().optional(),
  })
  .strict();

router.patch('/:id', requirePermission('ACCOUNT', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid account data', parsed.error.flatten());
  const item = await service.updateAccount(prisma, req.user.tenantId, req.params.id, parsed.data);
  await logAudit({ req, action: 'ACCOUNT_UPDATE', entity: 'Account', entityId: item.id, metadata: { changedFields: Object.keys(parsed.data) } });
  res.json({ item });
});

router.delete('/:id', requirePermission('ACCOUNT', 'DELETE'), async (req, res) => {
  const removed = await service.deleteAccount(prisma, req.user.tenantId, req.params.id);
  await logAudit({ req, action: 'ACCOUNT_DELETE', entity: 'Account', entityId: removed.id, metadata: { code: removed.code } });
  res.status(204).send();
});

module.exports = router;
