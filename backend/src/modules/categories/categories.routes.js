const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const buildCrudController = require('../../utils/crudFactory');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError } = require('../../utils/errors');

// Phase 1.5: parentId is optional subcategory support - additive, a tenant
// that never sets it keeps a flat category list exactly like before.
const createSchema = z.object({ name: z.string().min(1), parentId: z.string().uuid().nullable().optional() });
const updateSchema = z.object({ name: z.string().min(1).optional(), parentId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional() });

const baseController = buildCrudController({ model: 'category', createSchema, updateSchema });

// Verifies a proposed parentId both belongs to this tenant AND doesn't
// create a circular hierarchy (directly or transitively) - mirrors
// units.routes.js's identical assertValidBaseUnit check for the same
// self-referential-hierarchy shape.
async function assertValidParent(tenantId, categoryId, proposedParentId) {
  if (!proposedParentId) return;
  if (proposedParentId === categoryId) throw new ValidationError('A category cannot be its own parent');

  let current = proposedParentId;
  const seen = new Set();
  while (current) {
    if (current === categoryId) throw new ValidationError('This would create a circular category hierarchy');
    if (seen.has(current)) break;
    seen.add(current);
    const category = await prisma.category.findFirst({ where: { id: current, tenantId }, select: { parentId: true } });
    if (!category) throw new NotFoundError('Parent category not found');
    current = category.parentId;
  }
}

const controller = {
  ...baseController,
  create: async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.flatten());
    await assertValidParent(req.user.tenantId, null, parsed.data.parentId);
    return baseController.create(req, res);
  },
  update: async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.flatten());
    if (parsed.data.parentId) {
      await assertValidParent(req.user.tenantId, req.params.id, parsed.data.parentId);
    }
    return baseController.update(req, res);
  },
};

const router = express.Router();
router.use(authenticate, requireTenant);

// Same list behavior as the generic crudFactory (search/pagination/tenant
// scoping), but with each category's product count and immediate parent
// name attached - kept as a bespoke handler here rather than extending the
// shared crudFactory, since neither is a relation every crudFactory-backed
// model has.
router.get('/', requirePermission('CATEGORY', 'VIEW'), async (req, res) => {
  const { search, includeInactive, parentId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (includeInactive !== 'true') where.isActive = true;
  if (search) where.name = { contains: search, mode: 'insensitive' };
  // Explicit "top-level only" filter (parentId=null/"root") is intentionally
  // NOT special-cased here - Prisma's own `where: { parentId: null }` (sent
  // as an empty string from a query param) already means exactly that, so
  // ?parentId=<uuid> for "children of X" and omitting it for "everything"
  // cover both real use cases without extra logic.
  if (parentId) where.parentId = parentId;

  const [rows, total] = await Promise.all([
    prisma.category.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { _count: { select: { products: true } }, parent: { select: { id: true, name: true } } },
    }),
    prisma.category.count({ where }),
  ]);

  const items = rows.map(({ _count, ...category }) => ({ ...category, productCount: _count.products }));
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('CATEGORY', 'VIEW'), controller.getOne);
router.post('/', requirePermission('CATEGORY', 'CREATE'), controller.create);
router.patch('/:id', requirePermission('CATEGORY', 'UPDATE'), controller.update);
router.delete('/:id', requirePermission('CATEGORY', 'DELETE'), controller.archive);

module.exports = router;
