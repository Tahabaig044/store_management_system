const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const buildCrudController = require('../../utils/crudFactory');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY } = require('../../constants/roles');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { ensureDefaultCompany } = require('../companies/companyService');
const { requirePermission } = require('../../middleware/permissions');

// Phase 0.3: companyId is optional on create - a tenant that never thinks
// about "companies" at all should see no change in behavior (a branch
// created with no companyId is transparently assigned to the tenant's
// lazily-created default company, mirroring the existing
// ensureDefaultWarehouse pattern), while a tenant that DOES want multiple
// companies can specify one explicitly.
const createSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().min(1),
  code: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  isMain: z.boolean().optional(),
});
const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional(), isOpen: z.boolean().optional() });

const baseController = buildCrudController({ model: 'branch', createSchema, updateSchema });

// Verifies a supplied companyId actually belongs to this tenant - the same
// ownership-check pattern used everywhere else in this codebase for a
// foreign key supplied in a request body (e.g. products.routes.js's
// categoryId check).
async function assertCompanyOwnership(companyId, tenantId) {
  if (!companyId) return;
  const company = await prisma.company.findFirst({ where: { id: companyId, tenantId } });
  if (!company) throw new NotFoundError('Company not found');
}

// Phase 1.3: isMain is enforced as at-most-one-per-tenant here, in
// application code - the same way Company.isDefault (Phase 1.1) and
// Warehouse.isDefault are already enforced without a DB-level constraint.
// Previously isMain could only ever be set once, at tenant registration
// (auth.controller.js) - there was no way for a TENANT_ADMIN to designate a
// different branch as Main afterward.
async function setBranchAsMain(tenantId, branchId) {
  await prisma.$transaction([
    prisma.branch.updateMany({ where: { tenantId, isMain: true }, data: { isMain: false } }),
    prisma.branch.update({ where: { id: branchId }, data: { isMain: true } }),
  ]);
}

// isMain, like Company.isDefault (Phase 1.1), can only ever be turned ON
// through setBranchAsMain (which atomically clears every sibling first) -
// an explicit `isMain: false` sent alone is never written directly, the
// same way Company.isDefault's write path silently drops a bare `false`
// rather than risking a tenant with zero main branches.
const controller = {
  ...baseController,
  create: async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.flatten());

    if (parsed.data.companyId) {
      await assertCompanyOwnership(parsed.data.companyId, req.user.tenantId);
    } else {
      parsed.data.companyId = (await ensureDefaultCompany(prisma, req.user.tenantId)).id;
    }

    const { isMain, ...rest } = parsed.data;
    const item = await prisma.branch.create({ data: { ...rest, isMain: false, tenantId: req.user.tenantId } });
    await logAudit({ req, action: 'BRANCH_CREATE', entity: 'Branch', entityId: item.id });

    if (isMain) {
      await setBranchAsMain(req.user.tenantId, item.id);
      return res.status(201).json({ item: await prisma.branch.findUnique({ where: { id: item.id } }) });
    }
    res.status(201).json({ item });
  },
  update: async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.flatten());
    if (parsed.data.companyId) await assertCompanyOwnership(parsed.data.companyId, req.user.tenantId);

    const existing = await prisma.branch.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();

    const { isMain, ...rest } = parsed.data;
    if (isMain === true && !existing.isMain) {
      await setBranchAsMain(req.user.tenantId, existing.id);
    }
    const item = await prisma.branch.update({ where: { id: existing.id }, data: rest });
    await logAudit({ req, action: 'BRANCH_UPDATE', entity: 'Branch', entityId: item.id, metadata: { changedFields: Object.keys(parsed.data) } });
    res.json({ item: isMain === true ? await prisma.branch.findUnique({ where: { id: item.id } }) : item });
  },
};

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('BRANCH', 'VIEW'), controller.list);
router.get('/:id', requirePermission('BRANCH', 'VIEW'), controller.getOne);
router.post('/', requirePermission('BRANCH', 'CREATE'), controller.create);
router.patch('/:id', requirePermission('BRANCH', 'UPDATE'), controller.update);
router.delete('/:id', requirePermission('BRANCH', 'DELETE'), controller.archive);

// Phase 6: additional (non-primary) branch access for staff who need
// visibility into more than one branch without being full MANAGEMENT.
router.get('/:id/access', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const branch = await prisma.branch.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!branch) throw new NotFoundError();
  const items = await prisma.userBranchAccess.findMany({ where: { branchId: branch.id }, include: { user: { select: { name: true, email: true, role: true } } } });
  res.json({ items });
});

router.post('/:id/access', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const schema = z.object({ userId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('A userId is required', parsed.error.flatten());

  const branch = await prisma.branch.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!branch) throw new NotFoundError('Branch not found');
  const user = await prisma.user.findFirst({ where: { id: parsed.data.userId, tenantId: req.user.tenantId } });
  if (!user) throw new NotFoundError('User not found');

  const item = await prisma.userBranchAccess.upsert({
    where: { userId_branchId: { userId: user.id, branchId: branch.id } },
    create: { userId: user.id, branchId: branch.id },
    update: {},
  });
  await logAudit({ req, action: 'BRANCH_ACCESS_GRANT', entity: 'Branch', entityId: branch.id, metadata: { userId: user.id } });
  res.status(201).json({ item });
});

router.delete('/:id/access/:userId', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const branch = await prisma.branch.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!branch) throw new NotFoundError();
  await prisma.userBranchAccess.deleteMany({ where: { branchId: branch.id, userId: req.params.userId } });
  await logAudit({ req, action: 'BRANCH_ACCESS_REVOKE', entity: 'Branch', entityId: branch.id, metadata: { userId: req.params.userId } });
  res.status(204).send();
});

module.exports = router;
