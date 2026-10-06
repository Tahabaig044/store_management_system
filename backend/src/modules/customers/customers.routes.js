const express = require('express');
const { z } = require('zod');
const buildCrudController = require('../../utils/crudFactory');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const prisma = require('../../config/prisma');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');

// Phase 1.6: code/notes are additive, optional universal fields - a tenant
// that never sets either keeps working exactly as before. `code` uniqueness
// (when set) is enforced at the database level (@@unique([tenantId, code])
// in schema.prisma), which the centralized errorHandler already turns into
// a clean 409 on conflict (Prisma P2002) - no extra application-layer check
// needed, the same way barcode uniqueness on Product is handled explicitly
// but this one is simpler since Customer.code is genuinely optional and
// rarely written by more than one request at a time.
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
  model: 'customer',
  createSchema,
  updateSchema,
  searchFields: ['name', 'phone', 'email', 'code'],
  supportsIdempotencyKey: true,
});

// Phase 1.6: lightweight, non-blocking duplicate-identity check - if the new
// customer's phone or email matches an existing ACTIVE customer, the create
// still succeeds (two real people can share a household phone; this is
// advisory, not a hard rule), but the response flags the possible match so
// the frontend can warn the user. Not a merge/dedup workflow - that is CRM
// scope, explicitly out of this phase.
async function findPossibleDuplicate(tenantId, { phone, email }, excludeId) {
  if (!phone && !email) return null;
  const match = await prisma.customer.findFirst({
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
// check's result can be folded into the same response, mirroring the exact
// create logic crudFactory would otherwise run (idempotency-key dedup, audit
// log, 201 response) - see utils/crudFactory.js's own create() for the
// original this intentionally stays in lockstep with.
const controller = {
  ...baseController,
  create: async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid customer data', parsed.error.flatten());

    if (parsed.data.idempotencyKey) {
      const existing = await findExistingByIdempotencyKey(prisma.customer, req.user.tenantId, parsed.data.idempotencyKey);
      if (existing) return res.status(200).json({ item: existing, deduplicated: true });
    }

    const possibleDuplicate = await findPossibleDuplicate(req.user.tenantId, parsed.data);
    const item = await prisma.customer.create({ data: { ...parsed.data, tenantId: req.user.tenantId } });
    await logAudit({ req, action: 'CUSTOMER_CREATE', entity: 'Customer', entityId: item.id });
    res.status(201).json({ item, possibleDuplicate });
  },
};

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('CUSTOMER', 'VIEW'), baseController.list);
router.get('/:id', requirePermission('CUSTOMER', 'VIEW'), baseController.getOne);
router.post('/', requirePermission('CUSTOMER', 'CREATE'), controller.create);
router.patch('/:id', requirePermission('CUSTOMER', 'UPDATE'), baseController.update);
router.delete('/:id', requirePermission('CUSTOMER', 'DELETE'), baseController.archive);

// Transaction/history view: sales + optical orders + payments for this customer.
router.get('/:id/history', requirePermission('CUSTOMER', 'VIEW'), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!customer) throw new NotFoundError();

  const [sales, opticalOrders, payments] = await Promise.all([
    prisma.sale.findMany({
      where: { tenantId: req.user.tenantId, customerId: customer.id },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    }),
    prisma.opticalOrder.findMany({
      where: { tenantId: req.user.tenantId, customerId: customer.id },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.payment.findMany({
      where: { tenantId: req.user.tenantId, customerId: customer.id },
      orderBy: { paidAt: 'desc' },
    }),
  ]);

  // Reversed sales stay in the returned list (full history stays visible),
  // but must not count toward the balance - the transaction was voided, so
  // nothing is actually owed from it. Without this, a reversed sale that had
  // been partially paid leaves a phantom balance due on a sale that no
  // longer exists.
  const activeSales = sales.filter((s) => s.status !== 'REVERSED');
  const totalSales = activeSales.reduce((sum, s) => sum + Number(s.total), 0);
  const totalPaid = activeSales.reduce((sum, s) => sum + Number(s.amountPaid), 0);

  res.json({
    customer,
    sales,
    opticalOrders,
    payments,
    balanceDue: totalSales - totalPaid,
  });
});

module.exports = router;
