// Phase 2.1: Chart of Accounts + manual General Ledger + opening-balance
// service. Business rules live here, not in the route files. It reuses the
// existing posting engine (ledger.js: postJournalEntry/reverseJournalEntry)
// rather than introducing a second way to write journal rows.
//
// Concurrency model: every operation that assigns an entry number or moves an
// entry between statuses runs in ONE transaction that first takes a
// per-tenant Postgres advisory lock (pg_advisory_xact_lock, released
// automatically at commit/rollback). That serializes concurrent manual
// postings for a tenant, so the count-based entry numbering (see
// utils/sequenceNumber.js) cannot collide between them. Postings made by
// business modules (Sale, Purchase, ...) do not take this lock, so a residual
// collision against one of those is still possible and is handled by the
// whole-transaction retry in withJournalTransaction().
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { LEDGER_STATUSES, round2, postJournalEntry, reverseJournalEntry, getSystemAccountId, ensureChartOfAccounts, assertPeriodOpen, lockTenantJournal } = require('./ledger');

const MAX_NUMBER_RETRIES = 8;
// Entries created by these source types are ones a user may reverse directly;
// everything else must be reversed via its originating business action so the
// business record and its ledger effect never diverge.
const DIRECTLY_REVERSIBLE = ['MANUAL', 'OPENING_BALANCE', 'ADJUSTMENT'];
const DEBIT_NORMAL = ['ASSET', 'EXPENSE'];

// Runs fn(tx) in a transaction, retrying the whole transaction if it loses a
// race on the entry-number unique constraint (P2002 on entryNumber).
async function withJournalTransaction(prisma, tenantId, fn) {
  for (let attempt = 1; attempt <= MAX_NUMBER_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTenantJournal(tx, tenantId);
        return fn(tx);
      });
    } catch (err) {
      const isNumberCollision = err.code === 'P2002' && String(err.meta?.target).includes('entryNumber');
      if (!isNumberCollision || attempt === MAX_NUMBER_RETRIES) throw err;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Chart of Accounts
// ---------------------------------------------------------------------------

function signedBalance(type, debit, credit) {
  return DEBIT_NORMAL.includes(type) ? debit - credit : credit - debit;
}

async function ledgerTotalsByAccount(client, tenantId) {
  const rows = await client.journalLine.groupBy({
    by: ['accountId'],
    where: { journalEntry: { tenantId, status: { in: LEDGER_STATUSES } } },
    _sum: { debit: true, credit: true },
  });
  return new Map(rows.map((r) => [r.accountId, { debit: Number(r._sum.debit || 0), credit: Number(r._sum.credit || 0) }]));
}

async function accountNetBalance(client, tenantId, account) {
  const agg = await client.journalLine.aggregate({
    where: { accountId: account.id, journalEntry: { tenantId, status: { in: LEDGER_STATUSES } } },
    _sum: { debit: true, credit: true },
  });
  return round2(signedBalance(account.type, Number(agg._sum.debit || 0), Number(agg._sum.credit || 0)));
}

async function getAccountOrThrow(client, tenantId, id) {
  const account = await client.account.findFirst({ where: { id, tenantId } });
  if (!account) throw new NotFoundError('Account not found');
  return account;
}

// The parent must be in the same tenant, active, and of the SAME account type
// (an Asset can only sit under an Asset), and must not be the account itself
// or one of its descendants (that would create a cycle).
async function assertValidParent(client, tenantId, parentId, { selfId, type }) {
  const parent = await getAccountOrThrow(client, tenantId, parentId).catch(() => {
    throw new NotFoundError('Parent account not found');
  });
  if (!parent.isActive) throw new ConflictError('Parent account is inactive');
  if (type && parent.type !== type) {
    throw new ValidationError(`A ${type} account cannot be placed under a ${parent.type} account`);
  }
  if (selfId) {
    if (parent.id === selfId) throw new ValidationError('An account cannot be its own parent');
    let cursor = parent;
    for (let depth = 0; cursor.parentId && depth < 50; depth++) {
      if (cursor.parentId === selfId) throw new ValidationError('That parent would create a circular hierarchy');
      cursor = await client.account.findUnique({ where: { id: cursor.parentId } });
      if (!cursor) break;
    }
  }
  return parent;
}

async function assertCodeFree(client, tenantId, code, exceptId) {
  const clash = await client.account.findFirst({ where: { tenantId, code, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (clash) throw new ConflictError(`Account code ${code} is already in use`);
}

async function createAccount(prisma, tenantId, data) {
  const code = data.code.trim();
  const name = data.name.trim();
  if (!code || !name) throw new ValidationError('Account code and name are required');
  await assertCodeFree(prisma, tenantId, code);
  if (data.parentId) await assertValidParent(prisma, tenantId, data.parentId, { type: data.type });
  try {
    return await prisma.account.create({
      data: { tenantId, code, name, type: data.type, parentId: data.parentId || null, description: data.description || null },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ConflictError(`Account code ${code} is already in use`);
    throw err;
  }
}

async function updateAccount(prisma, tenantId, id, data) {
  const existing = await getAccountOrThrow(prisma, tenantId, id);
  const patch = {};

  if (data.name !== undefined) {
    if (!data.name.trim()) throw new ValidationError('Account name is required');
    patch.name = data.name.trim();
  }
  if (data.description !== undefined) patch.description = data.description || null;
  if (data.code !== undefined && data.code.trim() !== existing.code) {
    const code = data.code.trim();
    if (!code) throw new ValidationError('Account code is required');
    await assertCodeFree(prisma, tenantId, code, existing.id);
    patch.code = code;
  }

  if (data.parentId !== undefined && data.parentId !== existing.parentId) {
    // The posting engine and reports lean on the shape of the default system
    // hierarchy, so system accounts keep their parent.
    if (existing.isSystem) throw new ConflictError('System accounts cannot be moved to a different parent');
    if (data.parentId === null) patch.parentId = null;
    else {
      await assertValidParent(prisma, tenantId, data.parentId, { selfId: existing.id, type: existing.type });
      patch.parentId = data.parentId;
    }
  }

  if (data.isActive === false && existing.isActive) {
    // System accounts (Cash, Accounts Receivable, ...) are needed by the
    // posting engine at all times.
    if (existing.isSystem) throw new ConflictError('System accounts cannot be deactivated');
    const activeChildren = await prisma.account.count({ where: { tenantId, parentId: existing.id, isActive: true } });
    if (activeChildren > 0) throw new ConflictError('Deactivate or move this account\'s active sub-accounts first');
    const balance = await accountNetBalance(prisma, tenantId, existing);
    if (balance !== 0) throw new ConflictError(`This account has a non-zero balance (${balance}) and cannot be deactivated`);
    const draftLines = await prisma.journalLine.count({ where: { accountId: existing.id, journalEntry: { tenantId, status: 'DRAFT' } } });
    if (draftLines > 0) throw new ConflictError('This account is used by draft journal entries and cannot be deactivated');
    patch.isActive = false;
  } else if (data.isActive === true && !existing.isActive) {
    patch.isActive = true;
  }

  if (Object.keys(patch).length === 0) return existing;
  try {
    return await prisma.account.update({ where: { id: existing.id }, data: patch });
  } catch (err) {
    if (err.code === 'P2002') throw new ConflictError('Account code is already in use');
    throw err;
  }
}

async function deleteAccount(prisma, tenantId, id) {
  const existing = await getAccountOrThrow(prisma, tenantId, id);
  if (existing.isSystem) throw new ConflictError('System accounts cannot be deleted');
  const lineCount = await prisma.journalLine.count({ where: { accountId: existing.id } });
  if (lineCount > 0) throw new ConflictError('This account has journal lines (posted or draft) and cannot be deleted; deactivate it instead');
  const childCount = await prisma.account.count({ where: { parentId: existing.id } });
  if (childCount > 0) throw new ConflictError('This account has sub-accounts and cannot be deleted');
  await prisma.account.delete({ where: { id: existing.id } });
  return existing;
}

// Nested tree of accounts. With `withBalances`, each node carries its own
// signed balance (normal-balance aware) and a `rolledUpBalance` that includes
// all descendants (safe to sum because a child always shares its parent's type).
async function getAccountTree(prisma, tenantId, { includeInactive = false, withBalances = false } = {}) {
  await prisma.$transaction((tx) => ensureChartOfAccounts(tx, tenantId));
  const accounts = await prisma.account.findMany({
    where: { tenantId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { code: 'asc' },
  });
  const totals = withBalances ? await ledgerTotalsByAccount(prisma, tenantId) : null;
  const nodes = new Map(
    accounts.map((a) => {
      const t = totals?.get(a.id) || { debit: 0, credit: 0 };
      return [a.id, { ...a, children: [], ...(withBalances ? { balance: round2(signedBalance(a.type, t.debit, t.credit)) } : {}) }];
    })
  );
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    // A node whose parent is inactive (and therefore filtered out) is shown at
    // the top level rather than silently disappearing.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  if (withBalances) {
    const roll = (node) => {
      node.rolledUpBalance = round2(node.balance + node.children.reduce((s, c) => s + roll(c), 0));
      return node.rolledUpBalance;
    };
    roots.forEach(roll);
  }
  return roots;
}

async function getAccountDetail(prisma, tenantId, id) {
  const account = await prisma.account.findFirst({
    where: { id, tenantId },
    include: { parent: { select: { id: true, code: true, name: true } }, children: { select: { id: true, code: true, name: true, isActive: true }, orderBy: { code: 'asc' } } },
  });
  if (!account) throw new NotFoundError('Account not found');
  const agg = await prisma.journalLine.aggregate({
    where: { accountId: account.id, journalEntry: { tenantId, status: { in: LEDGER_STATUSES } } },
    _sum: { debit: true, credit: true },
  });
  const debit = Number(agg._sum.debit || 0);
  const credit = Number(agg._sum.credit || 0);
  const lineCount = await prisma.journalLine.count({ where: { accountId: account.id } });
  return { ...account, totalDebit: round2(debit), totalCredit: round2(credit), balance: round2(signedBalance(account.type, debit, credit)), lineCount };
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

// Structural + referential checks shared by draft-save and post. `requireBalance`
// is false only when saving a draft (drafts may be incomplete).
async function validateLines(tx, tenantId, lines, { requireBalance, allowInactive = false, minLines = 2 }) {
  if (!Array.isArray(lines) || lines.length < minLines) throw new ValidationError(minLines > 1 ? 'A journal entry needs at least two lines' : 'At least one line is required');
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const debit = round2(line.debit || 0);
    const credit = round2(line.credit || 0);
    if (debit < 0 || credit < 0) throw new ValidationError('Debit and credit amounts cannot be negative');
    if ((debit > 0) === (credit > 0)) throw new ValidationError('Each line must have either a debit or a credit, not both or neither');
    totalDebit += debit;
    totalCredit += credit;
  }
  totalDebit = round2(totalDebit);
  totalCredit = round2(totalCredit);
  if (requireBalance && totalDebit !== totalCredit) {
    throw new ValidationError(`Unbalanced journal entry: debits ${totalDebit} != credits ${totalCredit}`);
  }

  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds }, tenantId } });
  if (accounts.length !== accountIds.length) throw new NotFoundError('One or more accounts not found');
  if (!allowInactive) {
    const inactive = accounts.find((a) => !a.isActive);
    if (inactive) throw new ConflictError(`Account ${inactive.code} ${inactive.name} is inactive and cannot be posted to`);
  }

  const customerIds = [...new Set(lines.map((l) => l.customerId).filter(Boolean))];
  if (customerIds.length) {
    const found = await tx.customer.count({ where: { id: { in: customerIds }, tenantId } });
    if (found !== customerIds.length) throw new NotFoundError('One or more customers not found');
  }
  const supplierIds = [...new Set(lines.map((l) => l.supplierId).filter(Boolean))];
  if (supplierIds.length) {
    const found = await tx.supplier.count({ where: { id: { in: supplierIds }, tenantId } });
    if (found !== supplierIds.length) throw new NotFoundError('One or more suppliers not found');
  }
  return { totalDebit, totalCredit, accounts };
}

function lineData(l) {
  return {
    accountId: l.accountId,
    debit: round2(l.debit || 0),
    credit: round2(l.credit || 0),
    description: l.description,
    customerId: l.customerId || null,
    supplierId: l.supplierId || null,
  };
}

async function assertBranchInTenant(client, tenantId, branchId) {
  if (!branchId) return;
  const branch = await client.branch.findFirst({ where: { id: branchId, tenantId } });
  if (!branch) throw new NotFoundError('Branch not found');
}

async function loadEntry(client, tenantId, id) {
  const entry = await client.journalEntry.findFirst({ where: { id, tenantId }, include: { lines: true } });
  if (!entry) throw new NotFoundError();
  return entry;
}

// Creates a manual entry: posted straight to the ledger by default (the
// pre-Phase-2.1 behavior of POST /journal), or saved as a DRAFT when asked.
async function createManualEntry(prisma, { tenantId, userId }, input) {
  await assertBranchInTenant(prisma, tenantId, input.branchId);
  const result = await withJournalTransaction(prisma, tenantId, async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.journalEntry.findFirst({ where: { tenantId, idempotencyKey: input.idempotencyKey }, include: { lines: true } });
      if (existing) return { entry: existing, deduplicated: true };
    }
    await validateLines(tx, tenantId, input.lines, { requireBalance: !input.draft });

    if (input.draft) {
      const entryNumber = await nextSequenceNumber(tx.journalEntry, tenantId, 'JE', { tx });
      const entry = await tx.journalEntry.create({
        data: {
          tenantId,
          branchId: input.branchId || null,
          entryNumber,
          date: input.date || new Date(),
          memo: input.memo,
          reference: input.reference || null,
          idempotencyKey: input.idempotencyKey || null,
          sourceType: 'MANUAL',
          status: 'DRAFT',
          createdById: userId,
          lines: { create: input.lines.map(lineData) },
        },
        include: { lines: true },
      });
      return { entry, deduplicated: false };
    }

    const entry = await postJournalEntry(tx, {
      tenantId,
      branchId: input.branchId,
      date: input.date,
      sourceType: 'MANUAL',
      memo: input.memo,
      reference: input.reference,
      idempotencyKey: input.idempotencyKey,
      postedById: userId,
      lines: input.lines,
    });
    return { entry, deduplicated: false };
  });
  return result;
}

async function updateDraftEntry(prisma, { tenantId }, id, input) {
  await assertBranchInTenant(prisma, tenantId, input.branchId);
  return prisma.$transaction(async (tx) => {
    // Claim the row first: a concurrent post/cancel of the same draft either
    // completes before us (count 0 -> conflict) or waits on this row lock and
    // then sees the new lines.
    const claimed = await tx.journalEntry.updateMany({
      where: { id, tenantId, status: 'DRAFT' },
      data: {
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.date !== undefined ? { date: input.date } : {}),
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      },
    });
    if (claimed.count === 0) {
      const exists = await tx.journalEntry.findFirst({ where: { id, tenantId } });
      if (!exists) throw new NotFoundError();
      throw new ConflictError('Only a draft journal entry can be edited; posted entries are immutable (reverse and re-enter instead)');
    }
    if (input.lines) {
      await validateLines(tx, tenantId, input.lines, { requireBalance: false });
      await tx.journalLine.deleteMany({ where: { journalEntryId: id } });
      await tx.journalLine.createMany({ data: input.lines.map((l) => ({ ...lineData(l), journalEntryId: id })) });
    }
    return tx.journalEntry.findUnique({ where: { id }, include: { lines: true } });
  });
}

async function postDraftEntry(prisma, { tenantId, userId }, id) {
  return withJournalTransaction(prisma, tenantId, async (tx) => {
    // Atomic claim DRAFT -> POSTED before reading lines (see updateDraftEntry).
    const claimed = await tx.journalEntry.updateMany({
      where: { id, tenantId, status: 'DRAFT' },
      data: { status: 'POSTED', postedAt: new Date(), postedById: userId },
    });
    if (claimed.count === 0) {
      const exists = await tx.journalEntry.findFirst({ where: { id, tenantId } });
      if (!exists) throw new NotFoundError();
      throw new ConflictError('Only a draft journal entry can be posted, and it may already have been posted');
    }
    const entry = await loadEntry(tx, tenantId, id);
    // Any failure below (unbalanced, inactive account, closed period) throws,
    // rolling the claim back so the entry stays a DRAFT.
    await validateLines(tx, tenantId, entry.lines, { requireBalance: true });
    const total = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
    if (round2(total) === 0) throw new ValidationError('A journal entry cannot post a zero amount');
    await assertPeriodOpen(tx, tenantId, entry.date);
    return entry;
  });
}

async function cancelDraftEntry(prisma, { tenantId }, id) {
  const claimed = await prisma.journalEntry.updateMany({ where: { id, tenantId, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
  if (claimed.count === 0) {
    const exists = await prisma.journalEntry.findFirst({ where: { id, tenantId } });
    if (!exists) throw new NotFoundError();
    throw new ConflictError('Only a draft journal entry can be cancelled');
  }
  return prisma.journalEntry.findUnique({ where: { id }, include: { lines: true } });
}

async function reverseEntry(prisma, { tenantId, userId }, id, { date, memo } = {}) {
  return withJournalTransaction(prisma, tenantId, async (tx) => {
    const entry = await loadEntry(tx, tenantId, id);
    if (!DIRECTLY_REVERSIBLE.includes(entry.sourceType)) {
      throw new ConflictError('Only manual, adjustment and opening-balance entries can be reversed directly; reverse the originating transaction instead');
    }
    if (entry.reversalOfId) throw new ConflictError('A reversal entry cannot itself be reversed; post a new correcting entry');
    return reverseJournalEntry(tx, {
      tenantId,
      sourceEntryId: entry.id,
      date,
      memo: memo || `Reversal of ${entry.entryNumber}`,
      postedById: userId,
    });
  });
}

// ---------------------------------------------------------------------------
// Opening balances
// ---------------------------------------------------------------------------

async function getOpeningBalanceStatus(prisma, tenantId) {
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId, sourceType: 'OPENING_BALANCE', reversalOfId: null },
    include: { lines: { include: { account: { select: { code: true, name: true, type: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  const active = entries.find((e) => e.status === 'POSTED') || null;
  return { posted: !!active, active, history: entries.map((e) => ({ id: e.id, entryNumber: e.entryNumber, date: e.date, status: e.status })) };
}

// Posts ONE balanced opening-balance entry. Callers give per-account balances;
// any difference is posted automatically to the system "Opening Balance
// Equity" account so the entry always balances. Only one active (non-reversed)
// opening-balance entry may exist per tenant.
async function postOpeningBalances(prisma, { tenantId, userId }, input) {
  await assertBranchInTenant(prisma, tenantId, input.branchId);
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ValidationError('At least one opening balance line is required');

  return withJournalTransaction(prisma, tenantId, async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.journalEntry.findFirst({ where: { tenantId, idempotencyKey: input.idempotencyKey }, include: { lines: true } });
      if (existing) return { entry: existing, deduplicated: true };
    }
    const already = await tx.journalEntry.findFirst({ where: { tenantId, sourceType: 'OPENING_BALANCE', status: 'POSTED', reversalOfId: null } });
    if (already) {
      throw new ConflictError(`Opening balances were already posted (${already.entryNumber}). Reverse that entry first if it must be re-entered.`);
    }

    const equityId = await getSystemAccountId(tx, tenantId, 'OPENING_BALANCE_EQUITY');
    if (input.lines.some((l) => l.accountId === equityId)) {
      throw new ValidationError('Opening Balance Equity is calculated automatically; do not enter a balance for it');
    }
    // Each entered line must have exactly one positive side; balance is NOT
    // required of the input - the equity line below makes the entry balance.
    const { totalDebit, totalCredit } = await validateLines(tx, tenantId, input.lines, { requireBalance: false, minLines: 1 });
    const entered = { debit: totalDebit, credit: totalCredit };
    const diff = round2(entered.debit - entered.credit);

    const lines = input.lines.map((l) => ({ accountId: l.accountId, debit: l.debit || 0, credit: l.credit || 0, description: l.description, customerId: l.customerId, supplierId: l.supplierId }));
    if (diff > 0) lines.push({ accountId: equityId, credit: diff, description: 'Opening balance offset' });
    else if (diff < 0) lines.push({ accountId: equityId, debit: -diff, description: 'Opening balance offset' });
    if (round2(entered.debit + entered.credit) === 0) throw new ValidationError('Opening balances cannot all be zero');

    const entry = await postJournalEntry(tx, {
      tenantId,
      branchId: input.branchId,
      date: input.asOfDate,
      sourceType: 'OPENING_BALANCE',
      memo: input.memo || 'Opening balances',
      reference: input.reference,
      idempotencyKey: input.idempotencyKey,
      postedById: userId,
      lines,
    });
    return { entry, deduplicated: false };
  });
}

module.exports = {
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountTree,
  getAccountDetail,
  createManualEntry,
  updateDraftEntry,
  postDraftEntry,
  cancelDraftEntry,
  reverseEntry,
  getOpeningBalanceStatus,
  postOpeningBalances,
  DIRECTLY_REVERSIBLE,
};
