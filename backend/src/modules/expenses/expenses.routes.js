const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { runFinancialTransaction } = require('../accounting/financialTransaction');
const { resolveEventTime } = require('../../utils/eventTime');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { postJournalEntry, reverseJournalEntry, getExpenseCategoryAccountId, getMoneyAccountId } = require('../accounting/ledger');
const { branchScopeWhere, assertBranchAccess } = require('../../middleware/branchScope');
const { logAudit } = require('../../middleware/audit');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { triggerEvent } = require('../communication/automation');

const createSchema = z.object({
  categoryId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  amount: z.number().positive(),
  description: z.string().optional(),
  notes: z.string().optional(),
  expenseDate: z.coerce.date().optional(),
  method: z.string().default('cash'),
  // Optional payee attribution - a supplier being paid for a bill/service,
  // and/or an employee/user being reimbursed. Both optional and
  // independent; see this module's own doc comment on Expense.supplierId/
  // payeeUserId for why neither drives a workflow of its own.
  supplierId: z.string().uuid().optional(),
  payeeUserId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
  // Phase 3.2: when an offline terminal actually recorded it; becomes expenseDate unless one is given.
  occurredAt: z.coerce.date().optional(),
});

// Phase 1.12: deliberately excludes amount/categoryId/expenseDate - a real,
// previously-unfixed bug (see this phase's report, Existing Expense
// Architecture Audit) let those be edited via a blind PATCH that never
// touched the already-posted journal entry or the linked Payment's own
// amount, silently desyncing the ledger from the displayed expense. Sale/
// Purchase don't allow post-creation amount edits either (they're reversed
// and re-entered instead) - this now matches that same safe precedent.
// description/notes are pure metadata with zero ledger impact, so they
// remain freely editable. `.strict()` so an attempt to sneak amount/
// categoryId/expenseDate through is explicitly rejected (422) rather than
// silently ignored - a caller trying to correct the amount should see a
// clear error, not a 200 that quietly changed nothing.
const updateSchema = z.object({
  description: z.string().optional(),
  notes: z.string().optional(),
}).strict();

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('EXPENSE', 'VIEW'), async (req, res) => {
  const { from, to, categoryId, status, branchId, supplierId, payeeUserId, method, search } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (categoryId) where.categoryId = categoryId;
  if (status) where.status = status;
  if (supplierId) where.supplierId = supplierId;
  if (payeeUserId) where.payeeUserId = payeeUserId;
  if (method) where.payment = { method };
  if (search) {
    where.OR = [
      { expenseNumber: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (from || to) {
    where.expenseDate = {};
    if (from) where.expenseDate.gte = new Date(from);
    if (to) where.expenseDate.lte = new Date(to);
  }
  // branchId is validated against the caller's own access first (reusing
  // the existing assertBranchAccess, not new logic) before narrowing `where`
  // - mirrors Sale/Purchase's identical Phase 1.8/1.9 filter pattern exactly.
  if (branchId) {
    await assertBranchAccess(prisma, req.user, branchId);
    where.branchId = branchId;
  }

  const [items, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: { category: true, payment: true, supplier: true, payee: { select: { name: true } } },
      orderBy: { expenseDate: 'desc' },
      skip,
      take,
    }),
    prisma.expense.count({ where }),
  ]);

  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('EXPENSE', 'VIEW'), async (req, res) => {
  const item = await prisma.expense.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { category: true, payment: true, supplier: true, payee: { select: { name: true } }, createdBy: { select: { name: true } } },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

router.post('/', requirePermission('EXPENSE', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid expense data', parsed.error.flatten());
  const { method, occurredAt, ...data } = parsed.data;
  if (occurredAt && !data.expenseDate) data.expenseDate = resolveEventTime(occurredAt);
  data.branchId = data.branchId ?? req.user.branchId ?? null;

  if (data.idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.expense, req.user.tenantId, data.idempotencyKey, {
      category: true,
    });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const category = await prisma.expenseCategory.findFirst({ where: { id: data.categoryId, tenantId: req.user.tenantId } });
  if (!category) throw new NotFoundError('Expense category not found');
  if (data.branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: data.branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }
  await assertBranchAccess(prisma, req.user, data.branchId);
  if (data.supplierId) {
    const supplier = await prisma.supplier.findFirst({ where: { id: data.supplierId, tenantId: req.user.tenantId } });
    if (!supplier) throw new NotFoundError('Supplier not found');
  }
  if (data.payeeUserId) {
    const payee = await prisma.user.findFirst({ where: { id: data.payeeUserId, tenantId: req.user.tenantId } });
    if (!payee) throw new NotFoundError('Payee user not found');
  }

  // Large-expense approval control: same pattern as the large-discount
  // check on Sales - a configurable threshold above which only MANAGEMENT
  // can record the expense directly.
  if (!MANAGEMENT.includes(req.user.role)) {
    const thresholdSetting = await prisma.setting.findUnique({
      where: { tenantId_key: { tenantId: req.user.tenantId, key: 'largeExpenseThreshold' } },
    });
    const threshold = thresholdSetting?.value != null ? Number(thresholdSetting.value) : null;
    if (threshold != null && data.amount > threshold) {
      throw new ConflictError('This expense exceeds the configured threshold and requires a MANAGEMENT-role user');
    }
  }

  // Phase 1.12: audited per the Phase 1.8-1.11 precedent (Sale's
  // invoiceNumber / Purchase's purchaseNumber / Payment's receiptNumber
  // collision) - the shared nextSequenceNumber utility (Phase 0.6) is not
  // guaranteed gap/collision-free under concurrent creates. Mirrors the
  // identical local, bounded retry mitigation applied to those three,
  // without touching the shared utility itself.
  const MAX_EXPENSE_NUMBER_RETRIES = 15;
  let item;
  for (let attempt = 1; attempt <= MAX_EXPENSE_NUMBER_RETRIES; attempt++) {
    try {
      item = await runExpenseTransaction();
      break;
    } catch (err) {
      // Two identical requests racing past the pre-check: the loser hits the (tenantId,
      // idempotencyKey) unique index - answer it as the duplicate it is.
      // A duplicate of an operation that already succeeded resolves to that operation, whatever else
      // went wrong for the duplicate (another request with the same key raced it past the pre-check
      // and won: e.g. the stock the winner consumed is why this one now fails).
      if (data.idempotencyKey) {
        const existing = await findExistingByIdempotencyKey(prisma.expense, req.user.tenantId, data.idempotencyKey, { category: true });
        if (existing) return res.status(200).json({ item: existing, deduplicated: true });
      }
      const isExpenseNumberCollision = err.code === 'P2002' && err.meta?.target?.includes('expenseNumber');
      if (!isExpenseNumberCollision || attempt === MAX_EXPENSE_NUMBER_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
    }
  }

  async function runExpenseTransaction() {
    return runFinancialTransaction(prisma, async (tx) => {
      const expenseNumber = await nextSequenceNumber(tx.expense, req.user.tenantId, 'EXP', { tx });
      const expense = await tx.expense.create({ data: { ...data, tenantId: req.user.tenantId, expenseNumber, createdById: req.user.id } });
      await tx.payment.create({
        data: {
          tenantId: req.user.tenantId,
          direction: 'OUT',
          amount: expense.amount,
          method,
          expenseId: expense.id,
          supplierId: expense.supplierId,
          branchId: expense.branchId,
          paidAt: expense.expenseDate,
        },
      });

      const [expenseAccountId, cashBankAccountId] = await Promise.all([
        getExpenseCategoryAccountId(tx, req.user.tenantId, category.id, category.name),
        getMoneyAccountId(tx, req.user.tenantId, method),
      ]);
      await postJournalEntry(tx, {
        tenantId: req.user.tenantId,
        branchId: expense.branchId,
        date: expense.expenseDate,
        sourceType: 'EXPENSE',
        sourceId: expense.id,
        memo: expense.description || `Expense: ${category.name}`,
        postedById: req.user.id,
        lines: [
          { accountId: expenseAccountId, debit: Number(expense.amount), supplierId: expense.supplierId },
          { accountId: cashBankAccountId, credit: Number(expense.amount), supplierId: expense.supplierId },
        ],
      });

      return expense;
    });
  }

  await logAudit({ req, action: 'EXPENSE_CREATE', entity: 'Expense', entityId: item.id, metadata: { amount: item.amount, categoryId: item.categoryId }, branchId: item.branchId });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'EXPENSE_CREATED',
    sourceId: item.id,
    entityType: 'Expense',
    branchId: item.branchId,
    variables: { amount: Number(item.amount), expenseNumber: item.expenseNumber },
    internalTitle: `Expense recorded: ${item.expenseNumber || item.id}`,
    internalBody: `An expense of ${Number(item.amount).toFixed(2)} was recorded.`,
  });

  res.status(201).json({ item });
});

router.patch('/:id', requirePermission('EXPENSE', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid expense data', parsed.error.flatten());

  const existing = await prisma.expense.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, existing.branchId);

  const item = await prisma.expense.update({ where: { id: existing.id }, data: parsed.data });
  await logAudit({ req, action: 'EXPENSE_UPDATE', entity: 'Expense', entityId: item.id, metadata: { changedFields: Object.keys(parsed.data) } });
  res.json({ item });
});

// Reversal instead of deletion - the original expense record is preserved
// (financial transactions must be immutable/reversal-based, never deleted),
// mirroring Sale's/Purchase's own reversal endpoints exactly. Scoped to the
// expense's own inline-created Payment (every expense has exactly one,
// created alongside it - see POST / above), not the general-purpose
// POST /payments/:id/reverse (Phase 1.11), which is deliberately scoped to
// standalone, allocation-carrying payments only.
router.post('/:id/reverse', requirePermission('EXPENSE', 'REVERSE'), async (req, res) => {
  const item = await runFinancialTransaction(prisma, async (tx) => {
    const existing = await tx.expense.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      include: { payment: true },
    });
    if (!existing) throw new NotFoundError();
    await assertBranchAccess(prisma, req.user, existing.branchId);

    // Atomic guard against a concurrent double-reversal - mirrors Sale
    // reversal's identical Phase 1.8 guard exactly: two simultaneous
    // reverse requests could otherwise both read status: 'PAID' before
    // either writes, and both proceed to reverse the same journal entry.
    const flipped = await tx.expense.updateMany({
      where: { id: existing.id, status: 'PAID' },
      data: { status: 'REVERSED', reversedAt: new Date() },
    });
    if (flipped.count === 0) throw new ConflictError('Expense has already been reversed', 'ALREADY_APPLIED');

    if (existing.payment) {
      await tx.payment.update({ where: { id: existing.payment.id }, data: { status: 'REVERSED' } });
    }

    const originalEntry = await tx.journalEntry.findFirst({
      where: { tenantId: req.user.tenantId, sourceType: 'EXPENSE', sourceId: existing.id, status: 'POSTED' },
    });
    if (originalEntry) {
      await reverseJournalEntry(tx, {
        tenantId: req.user.tenantId,
        sourceEntryId: originalEntry.id,
        sourceType: 'EXPENSE_REVERSAL',
        sourceId: existing.id,
        memo: `Reversal of expense ${existing.expenseNumber || existing.id}`,
        postedById: req.user.id,
      });
    }

    return tx.expense.findUnique({ where: { id: existing.id }, include: { category: true, payment: true } });
  });

  await logAudit({ req, action: 'EXPENSE_REVERSE', entity: 'Expense', entityId: item.id, branchId: item.branchId });

  await triggerEvent(prisma, {
    tenantId: req.user.tenantId,
    event: 'EXPENSE_REVERSED',
    sourceId: item.id,
    entityType: 'Expense',
    branchId: item.branchId,
    variables: { amount: Number(item.amount), expenseNumber: item.expenseNumber },
    internalTitle: `Expense reversed: ${item.expenseNumber || item.id}`,
    internalBody: `An expense of ${Number(item.amount).toFixed(2)} was reversed.`,
  });

  res.json({ item });
});

module.exports = router;
