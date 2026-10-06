const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { branchScopeWhere, assertBranchAccess } = require('../../middleware/branchScope');
const service = require('./accountingService');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('JOURNAL', 'VIEW'), async (req, res) => {
  const { from, to, sourceType, accountId, branchId, status, search } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) where.date.lte = new Date(to);
  }
  if (sourceType) where.sourceType = sourceType;
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { entryNumber: { contains: search, mode: 'insensitive' } },
      { memo: { contains: search, mode: 'insensitive' } },
      { reference: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (branchId) {
    await assertBranchAccess(prisma, req.user, branchId);
    where.branchId = branchId;
  }
  if (accountId) where.lines = { some: { accountId } };

  const [items, total] = await Promise.all([
    prisma.journalEntry.findMany({
      where,
      include: { lines: { include: { account: true } }, branch: true, postedBy: { select: { name: true } } },
      orderBy: { date: 'desc' },
      skip,
      take,
    }),
    prisma.journalEntry.count({ where }),
  ]);

  res.json({ items, total, page: Number(page), pageSize: take });
});

// Best-effort traceability from a ledger entry back to the business record
// that caused it. Several source types record different ids depending on which
// code path posted them (e.g. PAYMENT entries use the sale/purchase id for
// inline payments but the Payment id for standalone ones), so each candidate
// is tried in order. Phase 2.1 extended this to the Phase 1.11-1.14 document
// types, which previously resolved to no source at all.
async function findSource(entry, tenantId) {
  if (!entry.sourceId) return null;
  const id = entry.sourceId;
  const where = { id, tenantId };
  const candidates = {
    SALE: [['Sale', () => prisma.sale.findFirst({ where })]],
    SALE_REVERSAL: [['Sale', () => prisma.sale.findFirst({ where })]],
    PURCHASE: [['Purchase', () => prisma.purchase.findFirst({ where })]],
    PURCHASE_RETURN: [['PurchaseReturn', () => prisma.purchaseReturn.findFirst({ where })], ['Purchase', () => prisma.purchase.findFirst({ where })]],
    PURCHASE_RETURN_REVERSAL: [['PurchaseReturn', () => prisma.purchaseReturn.findFirst({ where })]],
    SALES_RETURN: [['SalesReturn', () => prisma.salesReturn.findFirst({ where })]],
    SALES_RETURN_REVERSAL: [['SalesReturn', () => prisma.salesReturn.findFirst({ where })]],
    PAYMENT: [['Payment', () => prisma.payment.findFirst({ where })], ['Sale', () => prisma.sale.findFirst({ where })], ['Purchase', () => prisma.purchase.findFirst({ where })]],
    PAYMENT_REVERSAL: [['Payment', () => prisma.payment.findFirst({ where })]],
    EXPENSE: [['Expense', () => prisma.expense.findFirst({ where })]],
    EXPENSE_REVERSAL: [['Expense', () => prisma.expense.findFirst({ where })]],
    CREDIT_NOTE: [['CreditNote', () => prisma.creditNote.findFirst({ where })]],
    CREDIT_NOTE_CANCEL: [['CreditNote', () => prisma.creditNote.findFirst({ where })]],
    CREDIT_NOTE_REFUND: [['CreditNote', () => prisma.creditNote.findFirst({ where })]],
    DEBIT_NOTE: [['DebitNote', () => prisma.debitNote.findFirst({ where })]],
    DEBIT_NOTE_CANCEL: [['DebitNote', () => prisma.debitNote.findFirst({ where })]],
    DEBIT_NOTE_REFUND: [['DebitNote', () => prisma.debitNote.findFirst({ where })]],
    OPTICAL_ORDER: [['OpticalOrder', () => prisma.opticalOrder.findFirst({ where })]],
  }[entry.sourceType];
  for (const [entity, lookup] of candidates || []) {
    const record = await lookup();
    if (record) return { entity, record };
  }
  return null;
}

// Traceability: given a journal entry, follow sourceType/sourceId back to
// the actual business record it came from (Sale, Purchase, Expense, ...).
router.get('/:id', requirePermission('JOURNAL', 'VIEW'), async (req, res) => {
  const item = await prisma.journalEntry.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: {
      lines: { include: { account: true, customer: true, supplier: true } },
      branch: true,
      postedBy: { select: { name: true } },
      reversalOf: true,
      reversedBy: true,
    },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);

  const found = await findSource(item, req.user.tenantId);
  // `source` keeps its pre-Phase-2.1 shape (the record itself); `sourceEntity`
  // is new and names which kind of record it is.
  res.json({ item, source: found?.record ?? null, sourceEntity: found?.entity ?? null });
});

const lineSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.number().nonnegative().default(0),
  credit: z.number().nonnegative().default(0),
  description: z.string().optional(),
  customerId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
});

const createSchema = z.object({
  date: z.coerce.date().optional(),
  memo: z.string().optional(),
  reference: z.string().max(100).optional(),
  branchId: z.string().uuid().optional(),
  lines: z.array(lineSchema).min(2),
  // draft: true saves without posting; omitted/false posts immediately (the
  // behavior of this endpoint before Phase 2.1).
  draft: z.boolean().optional(),
  idempotencyKey: z.string().max(100).optional(),
});

// Manual journal entries (adjustments, corrections) - restricted to
// MANAGEMENT so ordinary shop staff never touch raw ledger postings directly.
router.post('/', requirePermission('JOURNAL', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid journal entry', parsed.error.flatten());
  if (parsed.data.branchId) await assertBranchAccess(prisma, req.user, parsed.data.branchId);

  const { entry, deduplicated } = await service.createManualEntry(prisma, { tenantId: req.user.tenantId, userId: req.user.id }, parsed.data);
  if (deduplicated) return res.status(200).json({ item: entry, deduplicated: true });

  await logAudit({ req, action: parsed.data.draft ? 'JOURNAL_ENTRY_DRAFT_CREATE' : 'JOURNAL_ENTRY_CREATE', entity: 'JournalEntry', entityId: entry.id, branchId: entry.branchId });
  res.status(201).json({ item: entry });
});

const updateSchema = z
  .object({
    date: z.coerce.date().optional(),
    memo: z.string().optional(),
    reference: z.string().max(100).nullable().optional(),
    branchId: z.string().uuid().nullable().optional(),
    lines: z.array(lineSchema).min(2).optional(),
  })
  .strict();

// Edit a DRAFT only. A posted entry is immutable - correct it by reversing and
// re-entering.
router.patch('/:id', requirePermission('JOURNAL', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid journal entry', parsed.error.flatten());
  const current = await prisma.journalEntry.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!current) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, current.branchId);
  if (parsed.data.branchId) await assertBranchAccess(prisma, req.user, parsed.data.branchId);

  const item = await service.updateDraftEntry(prisma, { tenantId: req.user.tenantId }, req.params.id, parsed.data);
  await logAudit({ req, action: 'JOURNAL_ENTRY_UPDATE', entity: 'JournalEntry', entityId: item.id, branchId: item.branchId });
  res.json({ item });
});

router.post('/:id/post', requirePermission('JOURNAL', 'APPROVE'), async (req, res) => {
  const current = await prisma.journalEntry.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!current) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, current.branchId);

  const item = await service.postDraftEntry(prisma, { tenantId: req.user.tenantId, userId: req.user.id }, req.params.id);
  await logAudit({ req, action: 'JOURNAL_ENTRY_POST', entity: 'JournalEntry', entityId: item.id, branchId: item.branchId });
  res.json({ item });
});

router.post('/:id/cancel', requirePermission('JOURNAL', 'UPDATE'), async (req, res) => {
  const current = await prisma.journalEntry.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!current) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, current.branchId);

  const item = await service.cancelDraftEntry(prisma, { tenantId: req.user.tenantId }, req.params.id);
  await logAudit({ req, action: 'JOURNAL_ENTRY_CANCEL', entity: 'JournalEntry', entityId: item.id, branchId: item.branchId });
  res.json({ item });
});

// Reverse (void) a posted manual/adjustment/opening-balance entry by posting an
// exact mirror. Anything else (a Sale's entry, a Purchase's entry) must be
// reversed via its own originating business action so the two stay in sync.
// `/void` is the pre-Phase-2.1 path, kept as an alias of `/reverse`.
async function reverseHandler(req, res) {
  const current = await prisma.journalEntry.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!current) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, current.branchId);

  const reversal = await service.reverseEntry(prisma, { tenantId: req.user.tenantId, userId: req.user.id }, req.params.id, {
    memo: req.body?.memo,
    date: req.body?.date ? new Date(req.body.date) : undefined,
  });
  await logAudit({ req, action: 'JOURNAL_ENTRY_VOID', entity: 'JournalEntry', entityId: current.id, branchId: current.branchId, metadata: { reversalEntryId: reversal.id } });
  res.json({ item: reversal });
}
router.post('/:id/reverse', requirePermission('JOURNAL', 'REVERSE'), reverseHandler);
router.post('/:id/void', requirePermission('JOURNAL', 'REVERSE'), reverseHandler);

module.exports = router;
