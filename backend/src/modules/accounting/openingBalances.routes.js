// Phase 2.1: controlled opening-balance entry. One balanced journal entry
// (sourceType OPENING_BALANCE); the difference between the entered debits and
// credits goes automatically to the system "Opening Balance Equity" account.
// Only one active (non-reversed) opening-balance entry can exist per tenant;
// to re-enter, reverse the existing entry first via the journal reverse action.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { assertBranchAccess } = require('../../middleware/branchScope');
const service = require('./accountingService');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('OPENING_BALANCE', 'VIEW'), async (req, res) => {
  const status = await service.getOpeningBalanceStatus(prisma, req.user.tenantId);
  res.json(status);
});

const lineSchema = z
  .object({
    accountId: z.string().uuid(),
    debit: z.number().nonnegative().optional(),
    credit: z.number().nonnegative().optional(),
    description: z.string().optional(),
    customerId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
  })
  .refine((l) => ((l.debit || 0) > 0) !== ((l.credit || 0) > 0), { message: 'Each line must have either a debit or a credit, not both or neither' });

const createSchema = z.object({
  asOfDate: z.coerce.date(),
  memo: z.string().optional(),
  reference: z.string().max(100).optional(),
  branchId: z.string().uuid().optional(),
  lines: z.array(lineSchema).min(1),
  idempotencyKey: z.string().max(100).optional(),
});

router.post('/', requirePermission('OPENING_BALANCE', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid opening balances', parsed.error.flatten());
  if (parsed.data.branchId) await assertBranchAccess(prisma, req.user, parsed.data.branchId);

  const { entry, deduplicated } = await service.postOpeningBalances(prisma, { tenantId: req.user.tenantId, userId: req.user.id }, parsed.data);
  if (deduplicated) return res.status(200).json({ item: entry, deduplicated: true });

  await logAudit({ req, action: 'OPENING_BALANCE_POST', entity: 'JournalEntry', entityId: entry.id, branchId: entry.branchId });
  res.status(201).json({ item: entry });
});

module.exports = router;
