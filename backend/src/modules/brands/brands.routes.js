// Phase 1.5: universal, industry-neutral Brand catalog - mirrors
// categories.routes.js's shape exactly (crudFactory + a bespoke list handler
// attaching each brand's product count), since Brand is the same kind of
// tenant-owned classification master data Category already is. Nothing here
// hard-codes any industry - a tenant configures whatever brands it needs.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const buildCrudController = require('../../utils/crudFactory');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');

const createSchema = z.object({ name: z.string().min(1) });
const updateSchema = z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional() });

const controller = buildCrudController({ model: 'brand', createSchema, updateSchema });

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('BRAND', 'VIEW'), async (req, res) => {
  const { search, includeInactive } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (includeInactive !== 'true') where.isActive = true;
  if (search) where.name = { contains: search, mode: 'insensitive' };

  const [rows, total] = await Promise.all([
    prisma.brand.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take,
      include: { _count: { select: { products: true } } },
    }),
    prisma.brand.count({ where }),
  ]);

  const items = rows.map(({ _count, ...brand }) => ({ ...brand, productCount: _count.products }));
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('BRAND', 'VIEW'), controller.getOne);
router.post('/', requirePermission('BRAND', 'CREATE'), controller.create);
router.patch('/:id', requirePermission('BRAND', 'UPDATE'), controller.update);
router.delete('/:id', requirePermission('BRAND', 'DELETE'), controller.archive);

module.exports = router;
