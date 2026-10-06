// Phase 1.5: universal, industry-neutral Unit of Measure catalog - mirrors
// categories.routes.js/brands.routes.js's shape (crudFactory + a bespoke
// list handler with product counts), extended with an optional, minimal
// unit-conversion relationship (baseUnitId/conversionFactor). Pure reference
// data only - no inventory/stock calculation anywhere reads this yet; that
// belongs to Phase 1.10's Inventory Engine, not this phase.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const buildCrudController = require('../../utils/crudFactory');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const baseSchema = {
  name: z.string().min(1),
  code: z.string().optional(),
  baseUnitId: z.string().uuid().nullable().optional(),
  conversionFactor: z.number().positive().nullable().optional(),
};
const createSchema = z.object(baseSchema);
const updateSchema = z.object({ ...baseSchema, name: baseSchema.name.optional(), isActive: z.boolean().optional() });

const baseController = buildCrudController({ model: 'unitOfMeasure', createSchema, updateSchema });

// Verifies a proposed baseUnitId both belongs to this tenant AND doesn't
// create a circular conversion chain (directly or transitively) - a unit
// can never end up being, indirectly, its own base.
async function assertValidBaseUnit(tenantId, unitId, proposedBaseUnitId) {
  if (!proposedBaseUnitId) return;
  if (proposedBaseUnitId === unitId) throw new ValidationError('A unit cannot be its own base unit');

  let current = proposedBaseUnitId;
  const seen = new Set();
  while (current) {
    if (current === unitId) throw new ValidationError('This would create a circular unit conversion chain');
    if (seen.has(current)) break;
    seen.add(current);
    const unit = await prisma.unitOfMeasure.findFirst({ where: { id: current, tenantId }, select: { baseUnitId: true } });
    if (!unit) throw new NotFoundError('Base unit not found');
    current = unit.baseUnitId;
  }
}

const controller = {
  ...baseController,
  create: async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid unit data', parsed.error.flatten());
    if (parsed.data.baseUnitId && !parsed.data.conversionFactor) {
      throw new ValidationError('A conversionFactor is required when baseUnitId is set');
    }
    await assertValidBaseUnit(req.user.tenantId, null, parsed.data.baseUnitId);
    return baseController.create(req, res);
  },
  update: async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid unit data', parsed.error.flatten());
    if (parsed.data.baseUnitId) {
      await assertValidBaseUnit(req.user.tenantId, req.params.id, parsed.data.baseUnitId);
    }
    return baseController.update(req, res);
  },
};

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('UNIT', 'VIEW'), async (req, res) => {
  const { search, includeInactive } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (includeInactive !== 'true') where.isActive = true;
  if (search) where.name = { contains: search, mode: 'insensitive' };

  const [rows, total] = await Promise.all([
    prisma.unitOfMeasure.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take,
      include: { _count: { select: { products: true } }, baseUnit: { select: { id: true, name: true } } },
    }),
    prisma.unitOfMeasure.count({ where }),
  ]);

  const items = rows.map(({ _count, ...unit }) => ({ ...unit, productCount: _count.products }));
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('UNIT', 'VIEW'), controller.getOne);
router.post('/', requirePermission('UNIT', 'CREATE'), controller.create);
router.patch('/:id', requirePermission('UNIT', 'UPDATE'), controller.update);
router.delete('/:id', requirePermission('UNIT', 'DELETE'), controller.archive);

module.exports = router;
