// Phase 2.2 - Receivables (AR) & Payables (AP) read models and note applications.
//
// Deliberately NOT a second payment system. Payments, allocations, receipts
// and payment reversal stay in modules/payments (Phase 1.11); this file adds
//   1. the shared settle/release primitives those flows (and note
//      applications) use to move Sale/Purchase.amountPaid atomically,
//   2. Credit Note / Debit Note applications (allocate an already-issued note
//      against open documents - no journal impact, see schema comment), and
//   3. read models: party balances, outstanding documents, statements, aging.
//
// One config object per side lets AR (customers/sales/credit notes) and AP
// (suppliers/purchases/debit notes) share every code path.
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { assertBranchAccess, getAccessibleBranchIds } = require('../../middleware/branchScope');
const { LEDGER_STATUSES, round2 } = require('../accounting/ledger');
const { resolveEventTime } = require('../../utils/eventTime');

const EPS = 0.0001;
const DAY_MS = 86400000;

const SIDES = {
  AR: {
    side: 'AR',
    partyField: 'customerId',
    partyModel: 'customer',
    docModel: 'sale',
    docField: 'saleId',
    docNumberField: 'invoiceNumber',
    docLabel: 'invoice',
    openStatuses: ['COMPLETED'],
    noteModel: 'creditNote',
    noteField: 'creditNoteId',
    noteNumberField: 'creditNoteNumber',
    paymentDirection: 'IN',
    refundDirection: 'OUT',
    accountKey: 'ACCOUNTS_RECEIVABLE',
    docReversalSource: 'SALE_REVERSAL',
    noteCancelSource: 'CREDIT_NOTE_CANCEL',
    paymentReversalSource: 'PAYMENT_REVERSAL',
  },
  AP: {
    side: 'AP',
    partyField: 'supplierId',
    partyModel: 'supplier',
    docModel: 'purchase',
    docField: 'purchaseId',
    docNumberField: 'purchaseNumber',
    docLabel: 'purchase',
    openStatuses: ['RECEIVED'],
    noteModel: 'debitNote',
    noteField: 'debitNoteId',
    noteNumberField: 'debitNoteNumber',
    paymentDirection: 'OUT',
    refundDirection: 'IN',
    accountKey: 'ACCOUNTS_PAYABLE',
    docReversalSource: 'PURCHASE_RETURN',
    noteCancelSource: 'DEBIT_NOTE_CANCEL',
    paymentReversalSource: 'PAYMENT_REVERSAL',
  },
};

const num = (v) => Number(v || 0);

// ---------------------------------------------------------------------------
// Settlement primitives (shared with payments.routes.js)
// ---------------------------------------------------------------------------

function statusFor(amountPaid, total) {
  if (amountPaid <= EPS) return 'UNPAID';
  return amountPaid >= total - EPS ? 'PAID' : 'PARTIAL';
}

// Adds `amount` to a Sale's/Purchase's amountPaid only if it still fits under
// the total at the moment the UPDATE runs (re-evaluated against the latest
// committed row) - two concurrent settlements can never together exceed it.
async function settleDocument(delegate, doc, amount, message, openStatuses) {
  // The status is part of the claim: a reversal/return that commits between this caller's
  // read and its update would otherwise leave money settled on a document that no longer
  // exists, after the credit note for it was already issued.
  const claim = await delegate.updateMany({
    where: { id: doc.id, amountPaid: { lte: Number(doc.total) - amount + EPS }, ...(openStatuses ? { status: { in: openStatuses } } : {}) },
    data: { amountPaid: { increment: amount } },
  });
  if (claim.count === 0) {
    const current = await delegate.findUnique({ where: { id: doc.id }, select: { status: true, total: true, amountPaid: true } });
    if (current && openStatuses && !openStatuses.includes(current.status)) throw new ConflictError(`This document is no longer open (${current.status})`, 'DOCUMENT_NOT_OPEN');
    // The facts behind the refusal, so an offline terminal can propose the amount that still fits.
    throw new ValidationError(message, current ? { documentId: doc.id, balance: round2(num(current.total) - num(current.amountPaid)) } : undefined, 'BALANCE_CHANGED');
  }
  const refreshed = await delegate.findUnique({ where: { id: doc.id } });
  await delegate.update({ where: { id: doc.id }, data: { paymentStatus: statusFor(num(refreshed.amountPaid), num(refreshed.total)) } });
}

// The inverse: releases a previously settled amount, never below zero.
async function releaseDocument(delegate, docId, amount) {
  const claim = await delegate.updateMany({
    where: { id: docId, amountPaid: { gte: amount - EPS } },
    data: { amountPaid: { decrement: amount } },
  });
  if (claim.count === 0) throw new ConflictError('Cannot release more than has been settled on this document');
  const refreshed = await delegate.findUnique({ where: { id: docId } });
  await delegate.update({ where: { id: docId }, data: { paymentStatus: statusFor(num(refreshed.amountPaid), num(refreshed.total)) } });
}

// The shared nextSequenceNumber utility derives receipt numbers from a row count, so two
// concurrent payments can compute the same one and the loser dies on the
// (tenantId, receiptNumber) unique index with a spurious 409. Retrying the whole
// transaction re-derives a fresh number - the same bounded mitigation POST /payments
// has used since Phase 1.11, now also applied to Sale's and Purchase's own :id/pay.
async function withReceiptRetry(run, maxAttempts = 8) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const collision = err.code === 'P2002' && err.meta?.target?.includes('receiptNumber');
      if (!collision || attempt >= maxAttempts) throw err;
    }
  }
}

// Serializes receipt-number and journal-entry-number generation for one tenant's
// payment transactions (the same per-tenant advisory lock manual journal posting
// takes, so the two also serialize against each other). Must be the FIRST statement
// of the transaction: taken before any row lock it cannot take part in a lock cycle.
async function lockTenantNumbering(tx, tenantId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal:${tenantId}`}))`;
}

// Row lock so a refund and an application against the same note serialize -
// their guards each look at refundedAmount + appliedAmount together, which a
// single-column conditional update cannot express.
async function lockNote(tx, cfg, noteId) {
  if (cfg.side === 'AR') await tx.$executeRaw`SELECT 1 FROM "credit_notes" WHERE id = ${noteId} FOR UPDATE`;
  else await tx.$executeRaw`SELECT 1 FROM "debit_notes" WHERE id = ${noteId} FOR UPDATE`;
}

function noteAvailable(note) {
  return round2(num(note.amount) - num(note.refundedAmount) - num(note.appliedAmount));
}

// Used by credit/debit note refund handlers (taken under lockNote).
async function assertRefundFits(tx, cfg, noteId, amount) {
  await lockNote(tx, cfg, noteId);
  const note = await tx[cfg.noteModel].findUnique({ where: { id: noteId } });
  if (amount > noteAvailable(note) + EPS) {
    throw new ValidationError('Refund would exceed the credit still available on this note (amount minus refunds and applications)', { available: noteAvailable(note) }, 'BALANCE_CHANGED');
  }
}

// Whole-document cancellation guards.
async function assertDocumentHasNoActiveApplications(tx, cfg, docId, tenantId) {
  const count = await tx.noteApplicationLine.count({
    where: { tenantId, [cfg.docField]: docId, application: { status: 'ACTIVE' } },
  });
  if (count > 0) throw new ConflictError('A credit/debit note has been applied to this document - reverse that application first');
}

// ---------------------------------------------------------------------------
// Note applications
// ---------------------------------------------------------------------------

async function applyNote(prisma, user, cfg, { noteId, allocations, idempotencyKey, occurredAt }) {
  const tenantId = user.tenantId;
  if (!allocations?.length) throw new ValidationError('Provide at least one allocation');
  const ids = allocations.map((a) => a.documentId);
  if (new Set(ids).size !== ids.length) throw new ValidationError('The same document appears more than once in the allocations');
  const total = round2(allocations.reduce((s, a) => s + a.amount, 0));

  if (idempotencyKey) {
    const existing = await prisma.noteApplication.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
      include: { lines: true },
    });
    if (existing) return { item: existing, deduplicated: true };
  }

  try {
    const item = await prisma.$transaction(async (tx) => {
      const probe = await tx[cfg.noteModel].findFirst({ where: { id: noteId, tenantId } });
      if (!probe) throw new NotFoundError(`${cfg.side === 'AR' ? 'Credit' : 'Debit'} note not found`);
      await assertBranchAccess(tx, user, probe.branchId);
      await lockNote(tx, cfg, noteId);
      const note = await tx[cfg.noteModel].findUnique({ where: { id: noteId } });
      if (note.status !== 'ISSUED') throw new ConflictError('Only an issued note can be applied');
      if (total > noteAvailable(note) + EPS) {
        throw new ValidationError(`Allocation total ${total.toFixed(2)} exceeds the ${noteAvailable(note).toFixed(2)} still available on this note`, { available: noteAvailable(note) }, 'BALANCE_CHANGED');
      }

      // Fixed lock order (by document id) so two concurrent applications or
      // payments touching the same documents cannot deadlock each other.
      const ordered = [...allocations].sort((a, b) => (a.documentId < b.documentId ? -1 : 1));
      for (const a of ordered) {
        const doc = await tx[cfg.docModel].findFirst({ where: { id: a.documentId, tenantId } });
        if (!doc) throw new NotFoundError(`${cfg.docLabel} not found`);
        if (doc[cfg.partyField] !== note[cfg.partyField]) throw new ValidationError(`This ${cfg.docLabel} does not belong to the note's ${cfg.partyModel}`);
        if (!cfg.openStatuses.includes(doc.status)) throw new ConflictError(`Cannot apply a note to a ${cfg.docLabel} in status ${doc.status}`);
        await assertBranchAccess(tx, user, doc.branchId);
        await settleDocument(tx[cfg.docModel], doc, a.amount, `Amount would exceed the ${cfg.docLabel} balance`, cfg.openStatuses);
      }

      await tx[cfg.noteModel].update({ where: { id: note.id }, data: { appliedAmount: { increment: total } } });
      return tx.noteApplication.create({
        data: {
          tenantId,
          [cfg.noteField]: note.id,
          amount: total,
          branchId: note.branchId,
          idempotencyKey,
          createdById: user.id,
          createdAt: resolveEventTime(occurredAt),
          lines: { create: allocations.map((a) => ({ tenantId, [cfg.docField]: a.documentId, amount: a.amount })) },
        },
        include: { lines: true },
      });
    });
    return { item, deduplicated: false };
  } catch (err) {
    // Two identical requests racing past the pre-check: the loser hits the
    // (tenantId, idempotencyKey) unique index - answer as a duplicate.
    if (err.code === 'P2002' && idempotencyKey && err.meta?.target?.includes('idempotencyKey')) {
      const existing = await prisma.noteApplication.findUnique({
        where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
        include: { lines: true },
      });
      if (existing) return { item: existing, deduplicated: true };
    }
    throw err;
  }
}

async function reverseApplication(prisma, user, cfg, applicationId) {
  const tenantId = user.tenantId;
  return prisma.$transaction(async (tx) => {
    const app = await tx.noteApplication.findFirst({ where: { id: applicationId, tenantId }, include: { lines: true } });
    if (!app || !app[cfg.noteField]) throw new NotFoundError('Application not found');
    await assertBranchAccess(tx, user, app.branchId);
    const flipped = await tx.noteApplication.updateMany({ where: { id: app.id, status: 'ACTIVE' }, data: { status: 'REVERSED', reversedAt: new Date() } });
    if (flipped.count === 0) throw new ConflictError('This application has already been reversed', 'ALREADY_APPLIED');
    await lockNote(tx, cfg, app[cfg.noteField]);
    const ordered = [...app.lines].sort((a, b) => ((a[cfg.docField] || '') < (b[cfg.docField] || '') ? -1 : 1));
    for (const line of ordered) await releaseDocument(tx[cfg.docModel], line[cfg.docField], num(line.amount));
    const noteClaim = await tx[cfg.noteModel].updateMany({
      where: { id: app[cfg.noteField], appliedAmount: { gte: num(app.amount) - EPS } },
      data: { appliedAmount: { decrement: num(app.amount) } },
    });
    if (noteClaim.count === 0) throw new ConflictError('Note applied amount is inconsistent with this application');
    return tx.noteApplication.findUnique({ where: { id: app.id }, include: { lines: true } });
  });
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

function docDate(cfg, d) {
  return cfg.side === 'AP' ? d.receivedAt || d.createdAt : d.createdAt;
}

// `override` (Phase 2.3): the exact branch ids a report was narrowed to by an
// explicit branch/company filter (already intersected with the caller's access);
// undefined means "just the caller's own access".
async function scopeWhere(prisma, user, override) {
  const ids = override !== undefined ? override : await getAccessibleBranchIds(prisma, user);
  return ids === null ? {} : { branchId: { in: ids } };
}

async function loadOpenDocuments(prisma, user, cfg, { partyId, asOf, branchIds } = {}) {
  const where = {
    tenantId: user.tenantId,
    status: { in: cfg.openStatuses },
    paymentStatus: { not: 'PAID' },
    ...(await scopeWhere(prisma, user, branchIds)),
  };
  if (partyId) where[cfg.partyField] = partyId;
  const docs = await prisma[cfg.docModel].findMany({
    where,
    include: { [cfg.partyModel]: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return docs
    .map((d) => {
      const date = docDate(cfg, d);
      return {
        id: d.id,
        number: d[cfg.docNumberField],
        partyId: d[cfg.partyField] || null,
        partyName: d[cfg.partyModel]?.name || (cfg.side === 'AR' ? 'Walk-in' : 'Unknown'),
        branchId: d.branchId,
        date,
        total: num(d.total),
        amountPaid: num(d.amountPaid),
        balance: round2(Math.max(num(d.total) - num(d.amountPaid), 0)),
        ageDays: Math.max(Math.floor((asOf - new Date(date)) / DAY_MS), 0),
        paymentStatus: d.paymentStatus,
      };
    })
    .filter((d) => d.balance > EPS && new Date(d.date) <= asOf);
}

async function loadAvailableNotes(prisma, user, cfg, { partyId, branchIds } = {}) {
  const where = { tenantId: user.tenantId, status: 'ISSUED', ...(await scopeWhere(prisma, user, branchIds)) };
  if (partyId) where[cfg.partyField] = partyId;
  const notes = await prisma[cfg.noteModel].findMany({
    where,
    include: { [cfg.partyModel]: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return notes
    .map((n) => ({
      id: n.id,
      number: n[cfg.noteNumberField],
      partyId: n[cfg.partyField],
      partyName: n[cfg.partyModel]?.name,
      branchId: n.branchId,
      date: n.createdAt,
      amount: num(n.amount),
      refundedAmount: num(n.refundedAmount),
      appliedAmount: num(n.appliedAmount),
      available: noteAvailable(n),
      reason: n.reason,
    }))
    .filter((n) => n.available > EPS);
}

// GL balance per party on the AR/AP control account (journal lines carry the
// customer/supplier id), signed so a positive number always means "owed".
async function glBalances(prisma, user, cfg, partyId, { branchIds } = {}) {
  const account = await prisma.account.findFirst({ where: { tenantId: user.tenantId, systemKey: cfg.accountKey } });
  const out = new Map();
  if (!account) return { total: 0, byParty: out };
  const scope = await scopeWhere(prisma, user, branchIds);
  const rows = await prisma.journalLine.groupBy({
    by: [cfg.partyField],
    where: {
      accountId: account.id,
      ...(partyId ? { [cfg.partyField]: partyId } : {}),
      journalEntry: { tenantId: user.tenantId, status: { in: LEDGER_STATUSES }, ...scope },
    },
    _sum: { debit: true, credit: true },
  });
  let total = 0;
  for (const r of rows) {
    const net = cfg.side === 'AR' ? num(r._sum.debit) - num(r._sum.credit) : num(r._sum.credit) - num(r._sum.debit);
    out.set(r[cfg.partyField] || null, round2(net));
    total += net;
  }
  return { total: round2(total), byParty: out };
}

async function getSummary(prisma, user, cfg, { asOf = new Date(), search, branchIds } = {}) {
  const [docs, notes, gl] = await Promise.all([
    loadOpenDocuments(prisma, user, cfg, { asOf, branchIds }),
    loadAvailableNotes(prisma, user, cfg, { branchIds }),
    glBalances(prisma, user, cfg, undefined, { branchIds }),
  ]);
  const parties = new Map();
  const row = (id, name) => {
    const key = id || 'none';
    if (!parties.has(key)) parties.set(key, { partyId: id, partyName: name, openDocuments: 0, documentsDue: 0, availableCredit: 0, netOutstanding: 0, glBalance: gl.byParty.get(id || null) ?? 0 });
    return parties.get(key);
  };
  for (const d of docs) {
    const r = row(d.partyId, d.partyName);
    r.openDocuments += 1;
    r.documentsDue = round2(r.documentsDue + d.balance);
  }
  for (const n of notes) {
    const r = row(n.partyId, n.partyName);
    r.availableCredit = round2(r.availableCredit + n.available);
  }
  let items = [...parties.values()].map((r) => ({ ...r, netOutstanding: round2(r.documentsDue - r.availableCredit) }));
  if (search) items = items.filter((r) => (r.partyName || '').toLowerCase().includes(String(search).toLowerCase()));
  items.sort((a, b) => b.netOutstanding - a.netOutstanding);
  const totals = items.reduce(
    (t, r) => ({ documentsDue: round2(t.documentsDue + r.documentsDue), availableCredit: round2(t.availableCredit + r.availableCredit), netOutstanding: round2(t.netOutstanding + r.netOutstanding) }),
    { documentsDue: 0, availableCredit: 0, netOutstanding: 0 },
  );
  return {
    items,
    totals: { ...totals, glControlBalance: gl.total, reconciliationDifference: round2(totals.netOutstanding - gl.total) },
  };
}

async function getOutstanding(prisma, user, cfg, partyId, asOf = new Date()) {
  const party = await prisma[cfg.partyModel].findFirst({ where: { id: partyId, tenantId: user.tenantId } });
  if (!party) throw new NotFoundError(`${cfg.side === 'AR' ? 'Customer' : 'Supplier'} not found`);
  const [documents, notes, gl] = await Promise.all([
    loadOpenDocuments(prisma, user, cfg, { partyId, asOf }),
    loadAvailableNotes(prisma, user, cfg, { partyId }),
    glBalances(prisma, user, cfg, partyId),
  ]);
  const documentsDue = round2(documents.reduce((s, d) => s + d.balance, 0));
  const availableCredit = round2(notes.reduce((s, n) => s + n.available, 0));
  return {
    party: { id: party.id, name: party.name },
    documents,
    notes,
    documentsDue,
    availableCredit,
    netOutstanding: round2(documentsDue - availableCredit),
    glBalance: gl.byParty.get(partyId) ?? 0,
  };
}

// Buckets are given as ascending upper bounds in days, e.g. [30,60,90] ->
// 0-30, 31-60, 61-90, 90+.
function parseBuckets(raw) {
  const edges = raw
    ? String(raw).split(',').map((s) => Number(s.trim()))
    : [30, 60, 90];
  if (edges.length < 1 || edges.length > 8 || edges.some((n) => !Number.isInteger(n) || n < 1) || edges.some((n, i) => i > 0 && n <= edges[i - 1])) {
    throw new ValidationError('buckets must be a comma-separated list of ascending positive whole numbers of days, e.g. 30,60,90');
  }
  const labels = edges.map((e, i) => `${i === 0 ? 0 : edges[i - 1] + 1}-${e}`);
  labels.push(`${edges[edges.length - 1]}+`);
  return { edges, labels };
}

function bucketFor(edges, labels, ageDays) {
  const i = edges.findIndex((e) => ageDays <= e);
  return labels[i === -1 ? labels.length - 1 : i];
}

async function getAging(prisma, user, cfg, { asOf = new Date(), buckets, partyId, detail = false, branchIds } = {}) {
  const { edges, labels } = parseBuckets(buckets);
  const [docs, notes] = await Promise.all([
    loadOpenDocuments(prisma, user, cfg, { partyId, asOf, branchIds }),
    loadAvailableNotes(prisma, user, cfg, { partyId, branchIds }),
  ]);
  const zero = () => Object.fromEntries(labels.map((l) => [l, 0]));
  const parties = new Map();
  const row = (id, name) => {
    const key = id || 'none';
    if (!parties.has(key)) parties.set(key, { partyId: id, partyName: name, buckets: zero(), total: 0, availableCredit: 0, net: 0, ...(detail ? { documents: [] } : {}) });
    return parties.get(key);
  };
  const totals = zero();
  for (const d of docs) {
    const label = bucketFor(edges, labels, d.ageDays);
    const r = row(d.partyId, d.partyName);
    r.buckets[label] = round2(r.buckets[label] + d.balance);
    r.total = round2(r.total + d.balance);
    totals[label] = round2(totals[label] + d.balance);
    if (detail) r.documents.push({ ...d, bucket: label });
  }
  let creditTotal = 0;
  for (const n of notes) {
    const r = row(n.partyId, n.partyName);
    r.availableCredit = round2(r.availableCredit + n.available);
    creditTotal = round2(creditTotal + n.available);
  }
  const items = [...parties.values()].map((r) => ({ ...r, net: round2(r.total - r.availableCredit) })).sort((a, b) => b.total - a.total);
  const total = round2(docs.reduce((s, d) => s + d.balance, 0));
  return { asOf, buckets: labels, items, totals, total, availableCredit: creditTotal, net: round2(total - creditTotal) };
}

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------
// Built from the business documents (so invoices/payments/notes are visible as
// such), with manual/opening ledger adjustments on the control account merged
// in, and cross-checked against the party's GL balance. "increase" always means
// the amount owed grows (customer owes more / we owe the supplier more).
async function getStatement(prisma, user, cfg, partyId, { from, to, branchIds } = {}) {
  const tenantId = user.tenantId;
  const party = await prisma[cfg.partyModel].findFirst({ where: { id: partyId, tenantId } });
  if (!party) throw new NotFoundError(`${cfg.side === 'AR' ? 'Customer' : 'Supplier'} not found`);
  const scope = await scopeWhere(prisma, user, branchIds);
  const isAR = cfg.side === 'AR';

  const [docs, payments, notes, glLines] = await Promise.all([
    prisma[cfg.docModel].findMany({ where: { tenantId, [cfg.partyField]: partyId, ...scope } }),
    prisma.payment.findMany({ where: { tenantId, [cfg.partyField]: partyId, opticalOrderId: null } }),
    prisma[cfg.noteModel].findMany({ where: { tenantId, [cfg.partyField]: partyId, ...scope } }),
    (async () => {
      const account = await prisma.account.findFirst({ where: { tenantId, systemKey: cfg.accountKey } });
      if (!account) return [];
      return prisma.journalLine.findMany({
        where: {
          accountId: account.id,
          [cfg.partyField]: partyId,
          journalEntry: { tenantId, status: { in: LEDGER_STATUSES }, sourceType: { in: ['MANUAL', 'OPENING_BALANCE', 'ADJUSTMENT'] }, ...scope },
        },
        include: { journalEntry: true },
      });
    })(),
  ]);

  const docIds = new Set(docs.map((d) => d.id));
  const docById = new Map(docs.map((d) => [d.id, d]));

  // Dates for the "undo" rows come from the mirror journal entries.
  const reversalKeys = [...docs.map((d) => d.id), ...payments.map((p) => p.id), ...notes.map((n) => n.id)];
  const reversalEntries = reversalKeys.length
    ? await prisma.journalEntry.findMany({
        where: { tenantId, sourceId: { in: reversalKeys }, reversalOfId: { not: null }, sourceType: { in: [cfg.docReversalSource, cfg.paymentReversalSource, cfg.noteCancelSource] } },
        select: { sourceId: true, sourceType: true, date: true },
      })
    : [];
  const reversalDate = (id, type) => reversalEntries.find((e) => e.sourceId === id && e.sourceType === type)?.date;

  // Before Phase 2.4, reversing a sale / returning a purchase mirrored the ORIGINAL entry in
  // full, handing back whatever cash was settled inside it at creation while the Payment
  // row stayed COMPLETED. Such (legacy) reversal entries still carry cash/bank legs, so the
  // statement adds an explicit row for exactly the amount that reversal entry moved through
  // cash - otherwise it would drift from the ledger by that amount. Reversals made since
  // Phase 2.4 book that money to the party's account instead (backed by a credit/debit
  // note), carry no cash leg, and therefore add no such row.
  const undoneDocIds = docs.filter((d) => (isAR ? d.status === 'REVERSED' : d.status === 'RETURNED')).map((d) => d.id);
  const inlineReturned = new Map();
  if (undoneDocIds.length) {
    const moneyAccounts = await prisma.account.findMany({ where: { tenantId, systemKey: { in: ['CASH', 'BANK'] } }, select: { id: true } });
    const reversals = await prisma.journalEntry.findMany({
      where: { tenantId, sourceType: cfg.docReversalSource, sourceId: { in: undoneDocIds }, reversalOfId: { not: null }, status: { in: LEDGER_STATUSES } },
      include: { lines: { where: { accountId: { in: moneyAccounts.map((m) => m.id) } } } },
    });
    for (const e of reversals) {
      const moved = e.lines.reduce((s, l) => s + (isAR ? num(l.credit) - num(l.debit) : num(l.debit) - num(l.credit)), 0);
      if (Math.abs(moved) > EPS) inlineReturned.set(e.sourceId, (inlineReturned.get(e.sourceId) || 0) + round2(moved));
    }
  }

  const rows = [];
  const push = (r) => rows.push({ increase: 0, decrease: 0, ...r });

  for (const d of docs) {
    // A supplier-side DRAFT/CANCELLED purchase carries no payable yet.
    if (!isAR && !['RECEIVED', 'RETURNED'].includes(d.status)) continue;
    if (isAR && !['COMPLETED', 'REVERSED'].includes(d.status)) continue;
    push({ date: docDate(cfg, d), type: isAR ? 'INVOICE' : 'PURCHASE', reference: d[cfg.docNumberField], sourceType: cfg.docModel.toUpperCase(), sourceId: d.id, increase: num(d.total) });
    if ((isAR && d.status === 'REVERSED') || (!isAR && d.status === 'RETURNED')) {
      const undoneAt = reversalDate(d.id, cfg.docReversalSource) || d.updatedAt;
      push({ date: undoneAt, type: isAR ? 'INVOICE_REVERSAL' : 'PURCHASE_RETURN', reference: d[cfg.docNumberField], sourceType: cfg.docModel.toUpperCase(), sourceId: d.id, decrease: num(d.total) });
      if (inlineReturned.get(d.id)) {
        push({ date: undoneAt, type: 'SETTLEMENT_RETURNED', reference: d[cfg.docNumberField], sourceType: cfg.docModel.toUpperCase(), sourceId: d.id, increase: inlineReturned.get(d.id), description: 'Amount settled at creation, handed back by the reversal entry' });
      }
    }
  }

  for (const p of payments) {
    const linkedDoc = p[cfg.docField] ? docById.get(p[cfg.docField]) : null;
    // Payments tied to a document outside the caller's branch scope are hidden.
    if (p[cfg.docField] && !linkedDoc && Object.keys(scope).length) continue;
    // Prepayment on a not-yet-received purchase sits in the Advance asset.
    if (!isAR && linkedDoc && !['RECEIVED', 'RETURNED'].includes(linkedDoc.status)) continue;
    if (p.creditNoteId || p.debitNoteId) {
      // Refund of a note: cash moving the opposite way, so the balance grows.
      push({ date: p.paidAt, type: isAR ? 'CREDIT_REFUND' : 'DEBIT_REFUND', reference: p.receiptNumber, sourceType: 'PAYMENT', sourceId: p.id, increase: num(p.amount) });
      continue;
    }
    if (p.direction !== cfg.paymentDirection) continue;
    push({ date: p.paidAt, type: 'PAYMENT', reference: p.receiptNumber, sourceType: 'PAYMENT', sourceId: p.id, decrease: num(p.amount), method: p.method });
    if (p.status === 'REVERSED') {
      push({ date: reversalDate(p.id, cfg.paymentReversalSource) || p.paidAt, type: 'PAYMENT_REVERSAL', reference: p.receiptNumber, sourceType: 'PAYMENT', sourceId: p.id, increase: num(p.amount) });
    }
  }

  for (const n of notes) {
    // A note issued by reversing/returning a document has no ledger entry of its own - the
    // reversal entry already recognized the credit (and is shown as the document reversal
    // row above) - so listing it again would count it twice.
    if (n.reversedSaleId || n.returnedPurchaseId) continue;
    push({ date: n.createdAt, type: isAR ? 'CREDIT_NOTE' : 'DEBIT_NOTE', reference: n[cfg.noteNumberField], sourceType: cfg.noteModel === 'creditNote' ? 'CREDIT_NOTE' : 'DEBIT_NOTE', sourceId: n.id, decrease: num(n.amount), reason: n.reason });
    if (n.status === 'CANCELLED') {
      push({ date: reversalDate(n.id, cfg.noteCancelSource) || n.updatedAt, type: isAR ? 'CREDIT_NOTE_CANCELLED' : 'DEBIT_NOTE_CANCELLED', reference: n[cfg.noteNumberField], sourceType: cfg.noteModel === 'creditNote' ? 'CREDIT_NOTE' : 'DEBIT_NOTE', sourceId: n.id, increase: num(n.amount) });
    }
  }

  for (const l of glLines) {
    const net = isAR ? num(l.debit) - num(l.credit) : num(l.credit) - num(l.debit);
    if (Math.abs(net) < EPS) continue;
    push({ date: l.journalEntry.date, type: 'LEDGER_ADJUSTMENT', reference: l.journalEntry.entryNumber, sourceType: 'JOURNAL', sourceId: l.journalEntryId, increase: net > 0 ? net : 0, decrease: net < 0 ? -net : 0, description: l.journalEntry.memo });
  }

  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  let running = 0;
  for (const r of rows) {
    running = round2(running + r.increase - r.decrease);
    r.balance = running;
  }

  const fromD = from ? new Date(from) : null;
  const toD = to ? new Date(to) : null;
  let openingBalance = 0;
  const visible = [];
  for (const r of rows) {
    const d = new Date(r.date);
    if (fromD && d < fromD) { openingBalance = r.balance; continue; }
    if (toD && d > toD) continue;
    visible.push(r);
  }
  const closingBalance = visible.length ? visible[visible.length - 1].balance : openingBalance;

  // Statement/GL cross-check is only meaningful for the unfiltered whole-life view.
  const gl = await glBalances(prisma, user, cfg, partyId, { branchIds });
  return {
    party: { id: party.id, name: party.name },
    from: fromD, to: toD,
    openingBalance,
    rows: visible,
    totalIncrease: round2(visible.reduce((s, r) => s + r.increase, 0)),
    totalDecrease: round2(visible.reduce((s, r) => s + r.decrease, 0)),
    closingBalance,
    currentBalance: rows.length ? rows[rows.length - 1].balance : 0,
    glBalance: gl.byParty.get(partyId) ?? 0,
  };
}

module.exports = {
  SIDES,
  EPS,
  settleDocument,
  releaseDocument,
  withReceiptRetry,
  lockTenantNumbering,
  lockNote,
  noteAvailable,
  assertRefundFits,
  assertDocumentHasNoActiveApplications,
  applyNote,
  reverseApplication,
  glBalances,
  getSummary,
  getOutstanding,
  getAging,
  getStatement,
  parseBuckets,
};
