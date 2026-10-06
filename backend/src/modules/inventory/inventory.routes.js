const express = require('express');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { INVENTORY_STAFF } = require('../../constants/roles');
const { getAccessibleBranchIds } = require('../../middleware/branchScope');

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...INVENTORY_STAFF));

// Stock movement listing - supports the Stock Movement Report and per-product history.
router.get('/transactions', async (req, res) => {
  const { productId, from, to } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });

  const where = { tenantId: req.user.tenantId };
  if (productId) where.productId = productId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  if (accessibleBranchIds !== null) where.warehouse = { branchId: { in: accessibleBranchIds } };

  const [items, total] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where,
      include: { product: { select: { name: true, sku: true, unit: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.inventoryTransaction.count({ where }),
  ]);

  res.json({ items, total, page: Number(page), pageSize: take });
});

module.exports = router;
