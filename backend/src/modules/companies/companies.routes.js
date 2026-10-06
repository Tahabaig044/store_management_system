// Phase 0.3: Company sits between Tenant and Branch in the ownership
// hierarchy. Mirrors branches.routes.js's shape exactly (CRUD via
// crudFactory + an /access sub-resource), since Company is the same kind of
// tenant-owned master-data entity Branch already is.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const buildCrudController = require('../../utils/crudFactory');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY } = require('../../constants/roles');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { requirePermission } = require('../../middleware/permissions');

// Phase 1.1: identity/contact fields for this company as its own legal
// entity, plus an explicit isDefault marker - see schema.prisma's comment
// on Company for why these exist. All optional; a tenant that never sets
// any of them is completely unaffected.
const createSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  logoUrl: z.string().optional(),
  ntn: z.string().optional(),
  strn: z.string().optional(),
  isDefault: z.boolean().optional(),
});
const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });

const baseController = buildCrudController({ model: 'company', createSchema, updateSchema });

// isDefault is enforced as at-most-one-per-tenant here, in application code -
// the same way Branch.isMain/Warehouse.isCentral are already enforced
// without a database-level constraint. Clearing every sibling's flag and
// setting this one happens inside a single transaction so a request that
// fails partway (e.g. the target company doesn't exist) can never leave a
// tenant with zero default companies.
async function setAsDefault(tenantId, companyId) {
  await prisma.$transaction([
    prisma.company.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } }),
    prisma.company.update({ where: { id: companyId }, data: { isDefault: true } }),
  ]);
}

// Wraps baseController.create/update: when the caller is setting
// isDefault: true, clear every sibling first (via setAsDefault) and then
// delegate the rest of the field-set to the unmodified base controller, so
// validation/audit-logging/response-shaping stays identical to every other
// crudFactory-based resource.
const controller = {
  ...baseController,
  create: async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.flatten());

    const item = await prisma.company.create({
      data: { ...parsed.data, isDefault: false, tenantId: req.user.tenantId },
    });
    await logAudit({ req, action: 'COMPANY_CREATE', entity: 'Company', entityId: item.id });

    if (parsed.data.isDefault) {
      await setAsDefault(req.user.tenantId, item.id);
      return res.status(201).json({ item: await prisma.company.findUnique({ where: { id: item.id } }) });
    }
    res.status(201).json({ item });
  },
  update: async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.flatten());

    const existing = await prisma.company.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!existing) throw new NotFoundError();

    const { isDefault, ...rest } = parsed.data;
    if (isDefault === true && !existing.isDefault) {
      await setAsDefault(req.user.tenantId, existing.id);
    }
    const item = await prisma.company.update({ where: { id: existing.id }, data: rest });
    await logAudit({ req, action: 'COMPANY_UPDATE', entity: 'Company', entityId: item.id, metadata: { changedFields: Object.keys(parsed.data) } });
    res.json({ item: isDefault === true ? await prisma.company.findUnique({ where: { id: item.id } }) : item });
  },
};

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('COMPANY', 'VIEW'), controller.list);
router.get('/:id', requirePermission('COMPANY', 'VIEW'), controller.getOne);
router.post('/', requirePermission('COMPANY', 'CREATE'), controller.create);
router.patch('/:id', requirePermission('COMPANY', 'UPDATE'), controller.update);
router.delete('/:id', requirePermission('COMPANY', 'DELETE'), controller.archive);

// Company-wide access grants (Phase 0.3 access tier) - mirrors branches'
// /:id/access sub-routes exactly, but for UserCompanyAccess.
router.get('/:id/access', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const company = await prisma.company.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!company) throw new NotFoundError();
  const items = await prisma.userCompanyAccess.findMany({
    where: { companyId: company.id },
    include: { user: { select: { name: true, email: true, role: true } } },
  });
  res.json({ items });
});

router.post('/:id/access', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const schema = z.object({ userId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('A userId is required', parsed.error.flatten());

  const company = await prisma.company.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!company) throw new NotFoundError('Company not found');
  const user = await prisma.user.findFirst({ where: { id: parsed.data.userId, tenantId: req.user.tenantId } });
  if (!user) throw new NotFoundError('User not found');

  const item = await prisma.userCompanyAccess.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    create: { tenantId: req.user.tenantId, userId: user.id, companyId: company.id },
    update: {},
  });
  await logAudit({ req, action: 'COMPANY_ACCESS_GRANT', entity: 'Company', entityId: company.id, metadata: { userId: user.id } });
  res.status(201).json({ item });
});

router.delete('/:id/access/:userId', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const company = await prisma.company.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!company) throw new NotFoundError();
  await prisma.userCompanyAccess.deleteMany({ where: { companyId: company.id, userId: req.params.userId } });
  await logAudit({ req, action: 'COMPANY_ACCESS_REVOKE', entity: 'Company', entityId: company.id, metadata: { userId: req.params.userId } });
  res.status(204).send();
});

module.exports = router;
