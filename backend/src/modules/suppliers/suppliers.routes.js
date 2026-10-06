const express = require('express');
const { z } = require('zod');
const buildCrudController = require('../../utils/crudFactory');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const prisma = require('../../config/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');

// Phase 1.7: code/notes are additive, optional universal fields, mirroring
// Customer.code/notes (Phase 1.6) exactly - a tenant that never sets either
// keeps working exactly as before. `code` uniqueness (when set) is enforced
// at the database level (@@unique([tenantId, code]) in schema.prisma),
// which the centralized errorHandler already turns into a clean 409 on
// conflict (Prisma P2002).
const createSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  code: z.string().optional(),
  notes: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
const updateSchema = createSchema.omit({ idempotencyKey: true }).partial().extend({ isActive: z.boolean().optional() });

const baseController = buildCrudController({
  model: 'supplier',
  createSchema,
  updateSchema,
  searchFields: ['name', 'phone', 'email', 'code'],
  supportsIdempotencyKey: true,
});

// Phase 1.7: the same lightweight, non-blocking duplicate-identity check as
// Customer (Phase 1.6) - if the new supplier's phone or email matches an
// existing ACTIVE supplier, the create still succeeds (advisory, not a hard
// rule), but the response flags the possible match. Not a merge/dedup
// workflow.
async function findPossibleDuplicate(tenantId, { phone, email }, excludeId) {
  if (!phone && !email) return null;
  const match = await prisma.supplier.findFirst({
    where: {
      tenantId,
      isActive: true,
      id: excludeId ? { not: excludeId } : undefined,
      OR: [phone ? { phone } : undefined, email ? { email } : undefined].filter(Boolean),
    },
    select: { id: true, name: true, phone: true, email: true },
  });
  return match || null;
}

// Fully custom (not a baseController.create wrapper) so the possibleDuplicate
// check's result can be folded into the same response - mirrors
// customers.routes.js's identical create() exactly, kept in lockstep with
// utils/crudFactory.js's own create() logic (idempotency-key dedup, audit
// log, 201 response).
const controller = {
  ...baseController,
  create: async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid supplier data', parsed.error.flatten());

    if (parsed.data.idempotencyKey) {
      const existing = await findExistingByIdempotencyKey(prisma.supplier, req.user.tenantId, parsed.data.idempotencyKey);
      if (existing) return res.status(200).json({ item: existing, deduplicated: true });
    }

    const possibleDuplicate = await findPossibleDuplicate(req.user.tenantId, parsed.data);
    const item = await prisma.supplier.create({ data: { ...parsed.data, tenantId: req.user.tenantId } });
    await logAudit({ req, action: 'SUPPLIER_CREATE', entity: 'Supplier', entityId: item.id });
    res.status(201).json({ item, possibleDuplicate });
  },
};

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('SUPPLIER', 'VIEW'), baseController.list);
router.get('/:id', requirePermission('SUPPLIER', 'VIEW'), baseController.getOne);
router.post('/', requirePermission('SUPPLIER', 'CREATE'), controller.create);
router.patch('/:id', requirePermission('SUPPLIER', 'UPDATE'), baseController.update);
router.delete('/:id', requirePermission('SUPPLIER', 'DELETE'), baseController.archive);

// Supplier ledger: purchases + payments made to this supplier.
router.get('/:id/ledger', requirePermission('SUPPLIER', 'VIEW'), async (req, res) => {
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!supplier) throw new NotFoundError();

  const [purchases, payments] = await Promise.all([
    prisma.purchase.findMany({
      where: { tenantId: req.user.tenantId, supplierId: supplier.id },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    }),
    prisma.payment.findMany({
      where: { tenantId: req.user.tenantId, supplierId: supplier.id },
      orderBy: { paidAt: 'desc' },
    }),
  ]);

  const totalPurchased = purchases.reduce((sum, p) => sum + Number(p.total), 0);
  const totalPaid = purchases.reduce((sum, p) => sum + Number(p.amountPaid), 0);

  res.json({ supplier, purchases, payments, balanceDue: totalPurchased - totalPaid });
});

module.exports = router;
