// Phase 2.2 - Accounts Receivable / Accounts Payable endpoints. One router
// factory serves both sides; mounted at /api/receivables (customers, sales,
// credit notes) and /api/payables (suppliers, purchases, debit notes).
//
// Payments themselves are NOT here - they stay in /api/payments (Phase 1.11).
// This layer adds balances, statements, aging and credit/debit note application.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { parsePagination } = require('../../utils/pagination');
const { branchScopeWhere } = require('../../middleware/branchScope');
const svc = require('./arapService');
const fin = require('../accounting/financialReportsService');

function parseDate(value, label) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} is not a valid date`);
  return d;
}

function buildRouter(cfg) {
  const router = express.Router();
  router.use(authenticate, requireTenant);

  const partyPerm = cfg.side === 'AR' ? 'CUSTOMER' : 'SUPPLIER';
  const notePerm = cfg.side === 'AR' ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
  const partyPlural = cfg.side === 'AR' ? 'customers' : 'suppliers';

  // Per-party outstanding balances (+ available note credit, + GL control balance).
  router.get('/summary', requirePermission('REPORT', 'VIEW'), async (req, res) => {
    const asOf = parseDate(req.query.asOf, 'asOf') || new Date();
    const branchIds = await fin.resolveBranchIds(prisma, req.user, { branchId: req.query.branchId, companyId: req.query.companyId });
    res.json(await svc.getSummary(prisma, req.user, cfg, { asOf, search: req.query.search, branchIds: branchIds === null ? undefined : branchIds }));
  });

  router.get('/aging', requirePermission('REPORT', 'VIEW'), async (req, res) => {
    const asOf = parseDate(req.query.asOf, 'asOf') || new Date();
    const branchIds = await fin.resolveBranchIds(prisma, req.user, { branchId: req.query.branchId, companyId: req.query.companyId });
    res.json(
      await svc.getAging(prisma, req.user, cfg, {
        asOf,
        branchIds: branchIds === null ? undefined : branchIds,
        buckets: req.query.buckets,
        partyId: req.query.partyId,
        detail: req.query.detail === 'true',
      }),
    );
  });

  router.get(`/${partyPlural}/:id/outstanding`, requirePermission(partyPerm, 'VIEW'), async (req, res) => {
    res.json(await svc.getOutstanding(prisma, req.user, cfg, req.params.id, parseDate(req.query.asOf, 'asOf') || new Date()));
  });

  router.get(`/${partyPlural}/:id/statement`, requirePermission(partyPerm, 'VIEW'), async (req, res) => {
    res.json(await svc.getStatement(prisma, req.user, cfg, req.params.id, { from: parseDate(req.query.from, 'from'), to: parseDate(req.query.to, 'to') }));
  });

  // -- note applications ----------------------------------------------------
  const applySchema = z
    .object({
      noteId: z.string().uuid(),
      allocations: z.array(z.object({ documentId: z.string().uuid(), amount: z.number().positive() }).strict()).min(1),
      idempotencyKey: z.string().min(1).max(200).optional(),
      // Phase 3.3: when an offline terminal actually made the application.
      occurredAt: z.coerce.date().optional(),
    })
    .strict();

  router.post('/note-applications', requirePermission('PAYMENT', 'CREATE'), async (req, res) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid application data', parsed.error.flatten());
    const { item, deduplicated } = await svc.applyNote(prisma, req.user, cfg, parsed.data);
    if (deduplicated) return res.status(200).json({ item, deduplicated: true });
    await logAudit({ req, action: `${notePerm}_APPLY`, entity: 'NoteApplication', entityId: item.id, metadata: { noteId: parsed.data.noteId, amount: Number(item.amount) }, branchId: item.branchId });
    res.status(201).json({ item });
  });

  router.get('/note-applications', requirePermission('PAYMENT', 'VIEW'), async (req, res) => {
    const { page, pageSize, skip, take } = parsePagination(req.query);
    const where = { tenantId: req.user.tenantId, [cfg.noteField]: req.query.noteId || { not: null }, ...(await branchScopeWhere(prisma, req.user)) };
    if (req.query.status) where.status = req.query.status;
    const [items, total] = await Promise.all([
      prisma.noteApplication.findMany({ where, include: { lines: true, [cfg.noteModel]: true }, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.noteApplication.count({ where }),
    ]);
    res.json({ items, total, page: Number(page), pageSize: take });
  });

  router.get('/note-applications/:id', requirePermission('PAYMENT', 'VIEW'), async (req, res) => {
    const item = await prisma.noteApplication.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId, [cfg.noteField]: { not: null } },
      include: { lines: { include: { [cfg.docModel]: true } }, [cfg.noteModel]: true },
    });
    if (!item) throw new NotFoundError();
    res.json({ item });
  });

  router.post('/note-applications/:id/reverse', requirePermission('PAYMENT', 'REVERSE'), async (req, res) => {
    const item = await svc.reverseApplication(prisma, req.user, cfg, req.params.id);
    await logAudit({ req, action: `${notePerm}_APPLICATION_REVERSE`, entity: 'NoteApplication', entityId: item.id, branchId: item.branchId });
    res.json({ item });
  });

  return router;
}

module.exports = {
  receivablesRoutes: buildRouter(svc.SIDES.AR),
  payablesRoutes: buildRouter(svc.SIDES.AP),
};
