// Core double-entry posting engine. Every accounting effect in the system -
// sales, purchases, payments, expenses, optical orders, purchase returns -
// goes through postJournalEntry() below, inside the SAME database
// transaction as the business mutation it accompanies. If either half
// fails, both roll back together: a Sale can never exist without its
// journal entry, and a journal entry is never posted without its
// originating business record.
//
// This is deliberately NOT a reporting-only summary layer bolted on top of
// existing tables - report data (Trial Balance, P&L, Balance Sheet, etc.)
// is derived exclusively from JournalLine rows written here.

const { ConflictError, ValidationError } = require('../../utils/errors');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');

// Well-known accounts every tenant gets by default. `key` is how the rest of
// the codebase finds an account (e.g. getSystemAccountId(tx, tenantId,
// 'CASH')) regardless of what the tenant renames code/name to later.
const DEFAULT_ACCOUNTS = [
  { key: 'ASSETS', code: '1000', name: 'Assets', type: 'ASSET', parentKey: null },
  { key: 'CASH', code: '1010', name: 'Cash', type: 'ASSET', parentKey: 'ASSETS' },
  { key: 'BANK', code: '1020', name: 'Bank', type: 'ASSET', parentKey: 'ASSETS' },
  { key: 'ACCOUNTS_RECEIVABLE', code: '1030', name: 'Accounts Receivable', type: 'ASSET', parentKey: 'ASSETS' },
  { key: 'INVENTORY', code: '1040', name: 'Inventory', type: 'ASSET', parentKey: 'ASSETS' },
  { key: 'INPUT_TAX', code: '1050', name: 'Input Tax Recoverable', type: 'ASSET', parentKey: 'ASSETS' },
  { key: 'ADVANCE_TO_SUPPLIERS', code: '1060', name: 'Advance to Suppliers', type: 'ASSET', parentKey: 'ASSETS' },
  { key: 'LIABILITIES', code: '2000', name: 'Liabilities', type: 'LIABILITY', parentKey: null },
  { key: 'ACCOUNTS_PAYABLE', code: '2010', name: 'Accounts Payable', type: 'LIABILITY', parentKey: 'LIABILITIES' },
  { key: 'TAX_PAYABLE', code: '2020', name: 'Sales Tax Payable', type: 'LIABILITY', parentKey: 'LIABILITIES' },
  { key: 'EQUITY', code: '3000', name: 'Equity', type: 'EQUITY', parentKey: null },
  { key: 'OPENING_BALANCE_EQUITY', code: '3010', name: 'Opening Balance Equity', type: 'EQUITY', parentKey: 'EQUITY' },
  { key: 'REVENUE', code: '4000', name: 'Revenue', type: 'REVENUE', parentKey: null },
  { key: 'SALES_REVENUE', code: '4010', name: 'Sales Revenue', type: 'REVENUE', parentKey: 'REVENUE' },
  { key: 'OPTICAL_REVENUE', code: '4020', name: 'Optical Order Revenue', type: 'REVENUE', parentKey: 'REVENUE' },
  { key: 'EXPENSES', code: '5000', name: 'Expenses', type: 'EXPENSE', parentKey: null },
  { key: 'COGS', code: '5010', name: 'Cost of Goods Sold', type: 'EXPENSE', parentKey: 'EXPENSES' },
  { key: 'GENERAL_EXPENSE', code: '5020', name: 'General Expenses', type: 'EXPENSE', parentKey: 'EXPENSES' },
  // Phase 2.4: stock gains/losses that are not a purchase or a sale (count corrections,
  // damage, write-offs, direct warehouse receipts/dispatches).
  { key: 'INVENTORY_ADJUSTMENT', code: '5030', name: 'Inventory Adjustments', type: 'EXPENSE', parentKey: 'EXPENSES' },
];

// Phase 2.1: which entry statuses count toward ledger balances. A reversed entry
// is marked VOID but its lines stay in the ledger, netting to zero against the
// mirror entry that reversed it - so balances must include BOTH. DRAFT and
// CANCELLED entries never touched the ledger and are excluded. (Before this
// phase reports counted POSTED only, which left just the mirror entry and made
// every reversed transaction show up as a negative.)
const LEDGER_STATUSES = ['POSTED', 'VOID'];

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Idempotent AND safe under concurrent callers: a single request often
// resolves several system accounts in parallel (Promise.all), each of which
// calls this - upsert (not find-then-create) means two concurrent calls
// racing to create the same account for the first time never collide on the
// (tenantId, systemKey) unique constraint.
async function ensureChartOfAccounts(tx, tenantId) {
  const existing = await tx.account.findMany({ where: { tenantId, systemKey: { not: null } } });
  const byKey = new Map(existing.map((a) => [a.systemKey, a]));
  if (byKey.size >= DEFAULT_ACCOUNTS.length) return byKey;

  // Only the (once per tenant) seeding path serializes: Prisma's upsert is not
  // atomic, so several requests first touching a brand-new tenant at once (a
  // dashboard plus a report, say) used to collide on the unique index and answer
  // 409. Whoever gets the lock seeds; the rest re-read and find it complete.
  // (Inside a transaction this is held to commit; outside one it is a no-op.)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chart:${tenantId}`}))`;
  const reread = await tx.account.findMany({ where: { tenantId, systemKey: { not: null } } });
  for (const a of reread) byKey.set(a.systemKey, a);
  if (byKey.size >= DEFAULT_ACCOUNTS.length) return byKey;

  for (const def of DEFAULT_ACCOUNTS) {
    if (byKey.has(def.key)) continue;
    const parent = def.parentKey ? byKey.get(def.parentKey) : null;
    const account = await tx.account.upsert({
      where: { tenantId_systemKey: { tenantId, systemKey: def.key } },
      create: {
        tenantId,
        code: def.code,
        name: def.name,
        type: def.type,
        systemKey: def.key,
        parentId: parent?.id ?? null,
        isSystem: true,
      },
      update: {},
    });
    byKey.set(def.key, account);
  }
  return byKey;
}

async function getSystemAccountId(tx, tenantId, key) {
  const accounts = await ensureChartOfAccounts(tx, tenantId);
  const account = accounts.get(key);
  if (!account) throw new Error(`System account ${key} missing for tenant ${tenantId}`);
  return account.id;
}

// One ledger account per expense category, created lazily the first time
// that category is posted against - existing expense categories therefore
// need no manual setup to start flowing into the accounting engine.
async function getExpenseCategoryAccountId(tx, tenantId, expenseCategoryId, categoryName) {
  const existing = await tx.account.findUnique({ where: { expenseCategoryId } });
  if (existing) return existing.id;

  const generalExpenseId = await getSystemAccountId(tx, tenantId, 'GENERAL_EXPENSE');
  // Codes for category sub-accounts start at 5100 and increment - collisions
  // are vanishingly unlikely (one per expense category per tenant) but a
  // unique-constraint retry loop would be overkill for this cardinality.
  const siblingCount = await tx.account.count({ where: { tenantId, parentId: generalExpenseId } });
  // upsert (not create) so two concurrent expense postings against a
  // brand-new category can't collide on the expenseCategoryId unique constraint.
  const account = await tx.account.upsert({
    where: { expenseCategoryId },
    create: {
      tenantId,
      code: `51${String(10 + siblingCount).padStart(2, '0')}`,
      name: categoryName,
      type: 'EXPENSE',
      parentId: generalExpenseId,
      expenseCategoryId,
      isSystem: true,
    },
    update: {},
  });
  return account.id;
}

function methodAccountKey(method) {
  return (method || '').trim().toLowerCase() === 'cash' ? 'CASH' : 'BANK';
}

async function getMoneyAccountId(tx, tenantId, method) {
  return getSystemAccountId(tx, tenantId, methodAccountKey(method));
}


// Rejects posting into a period the tenant has explicitly closed. Tenants
// that never set up periods (the common case for a small shop) are
// unaffected - there's nothing to check against.
async function assertPeriodOpen(tx, tenantId, date) {
  const period = await tx.accountingPeriod.findFirst({
    where: { tenantId, status: 'CLOSED', startDate: { lte: date }, endDate: { gte: date } },
  });
  if (period) {
    throw new ConflictError(`Accounting period "${period.name}" is closed and cannot accept new postings`, 'PERIOD_CLOSED');
  }
}

// Per-tenant advisory lock serializing entry-number and receipt-number allocation
// (the shared count-based numbering is not collision-free under concurrency) and the
// single-post check below. It is taken INSIDE postJournalEntry - i.e. after a business
// transaction has done its row-level claims and just before it writes its last rows -
// so a transaction never holds it while waiting for a row another posting transaction
// holds (which would be a lock cycle). Held to commit; re-entrant within a transaction.
async function lockTenantJournal(tx, tenantId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal:${tenantId}`}))`;
}

// Receipt numbers ("RCT-...") are count-based like entry numbers; allocate them under the
// same lock so concurrent payments can never collide (and never need a retry).
async function allocateReceiptNumber(tx, tenantId) {
  await lockTenantJournal(tx, tenantId);
  return nextSequenceNumber(tx.payment, tenantId, 'RCT', { tx });
}

// Credit/Debit note numbers, likewise, so a note issued by a reversal and one issued from
// the notes screen at the same moment cannot pick the same number.
async function allocateNoteNumber(tx, tenantId, kind) {
  await lockTenantJournal(tx, tenantId);
  return kind === 'CN' ? nextSequenceNumber(tx.creditNote, tenantId, 'CN', { tx }) : nextSequenceNumber(tx.debitNote, tenantId, 'DN', { tx });
}

// Source types whose document is posted to the ledger exactly once: a second original
// (non-reversal) entry for the same document is a double posting and is refused.
const SINGLE_POST_TYPES = ['SALE', 'EXPENSE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'SALES_RETURN', 'INVENTORY_ADJUSTMENT'];

// Every account/branch/party a business posting names must belong to the tenant, and
// (unless this is a reversal mirror) accounts must still be active.
async function assertPostingReferences(tx, tenantId, branchId, lines, allowInactive) {
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, tenantId: true, isActive: true, code: true } });
  if (accounts.length !== accountIds.length || accounts.some((a) => a.tenantId !== tenantId)) {
    throw new ValidationError('A journal line references an account that does not belong to this tenant');
  }
  const inactive = accounts.find((a) => !a.isActive);
  if (inactive && !allowInactive) throw new ValidationError(`Account ${inactive.code} is inactive and cannot be posted to`);
  if (branchId) {
    const branch = await tx.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } });
    if (!branch) throw new ValidationError('The posting branch does not belong to this tenant');
  }
  const customerIds = [...new Set(lines.map((l) => l.customerId).filter(Boolean))];
  if (customerIds.length && (await tx.customer.count({ where: { id: { in: customerIds }, tenantId } })) !== customerIds.length) {
    throw new ValidationError('A journal line references a customer outside this tenant');
  }
  const supplierIds = [...new Set(lines.map((l) => l.supplierId).filter(Boolean))];
  if (supplierIds.length && (await tx.supplier.count({ where: { id: { in: supplierIds }, tenantId } })) !== supplierIds.length) {
    throw new ValidationError('A journal line references a supplier outside this tenant');
  }
}

// The one function every business route calls. `lines` is an array of
// { accountId, debit, credit, description?, customerId?, supplierId? } -
// exactly one of debit/credit should be positive per line, and the totals
// must balance to the cent or the whole posting (and therefore the whole
// enclosing business transaction) is rejected.
async function postJournalEntry(tx, { tenantId, branchId, date, sourceType, sourceId, memo, lines, postedById, reversalOfId, reference, idempotencyKey, allowInactive = false }) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new ValidationError('A journal entry needs at least two lines');
  }

  const totalDebit = round2(lines.reduce((s, l) => s + round2(l.debit || 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + round2(l.credit || 0), 0));
  if (totalDebit !== totalCredit) {
    throw new ValidationError(`Unbalanced journal entry: debits ${totalDebit} != credits ${totalCredit}`);
  }
  if (totalDebit === 0) {
    throw new ValidationError('A journal entry cannot post a zero amount');
  }

  const effectiveDate = date || new Date();
  await assertPeriodOpen(tx, tenantId, effectiveDate);
  await assertPostingReferences(tx, tenantId, branchId, lines, allowInactive || Boolean(reversalOfId));

  await lockTenantJournal(tx, tenantId);
  if (!reversalOfId && sourceId && SINGLE_POST_TYPES.includes(sourceType)) {
    const already = await tx.journalEntry.findFirst({ where: { tenantId, sourceType, sourceId, reversalOfId: null, status: { in: LEDGER_STATUSES } }, select: { id: true } });
    if (already) throw new ConflictError(`This ${sourceType.toLowerCase().replace('_', ' ')} has already been posted to the ledger`);
  }

  const entryNumber = await nextSequenceNumber(tx.journalEntry, tenantId, 'JE', { tx });
  return tx.journalEntry.create({
    data: {
      tenantId,
      branchId: branchId || null,
      entryNumber,
      date: effectiveDate,
      memo,
      sourceType,
      sourceId,
      postedById: postedById || null,
      createdById: postedById || null,
      postedAt: new Date(),
      reference: reference || null,
      idempotencyKey: idempotencyKey || null,
      reversalOfId: reversalOfId || null,
      lines: {
        create: lines.map((l) => ({
          accountId: l.accountId,
          debit: round2(l.debit || 0),
          credit: round2(l.credit || 0),
          description: l.description,
          customerId: l.customerId || null,
          supplierId: l.supplierId || null,
        })),
      },
    },
    include: { lines: true },
  });
}

// Posts an exact mirror of a prior entry (debit<->credit swapped on every
// line) - the correction/reversal workflow the phase requires instead of
// ever editing or deleting a posted entry.
// `settleTo` (Phase 2.4): instead of returning cash/bank legs of the original entry to the
// money accounts, book them to the party's receivable/payable control account, so the
// amount the party had already paid stays with them as a credit (backed by a credit/debit
// note) rather than silently leaving the books as cash. { accountId, partyField, partyId,
// moneyAccountIds }.
async function reverseJournalEntry(tx, { tenantId, sourceEntryId, date, memo, sourceType, sourceId, postedById, branchId, settleTo }) {
  // Same lock order as every other posting path: journal lock before the entry row.
  await lockTenantJournal(tx, tenantId);
  const original = await tx.journalEntry.findFirst({
    where: { id: sourceEntryId, tenantId },
    include: { lines: true },
  });
  if (!original) throw new Error(`Journal entry ${sourceEntryId} not found for reversal`);
  if (original.status === 'VOID') throw new ConflictError('This journal entry has already been reversed', 'ALREADY_APPLIED');
  if (original.status !== 'POSTED') throw new ConflictError('Only a posted journal entry can be reversed');

  // Phase 2.1: atomic claim BEFORE posting the mirror. The read-then-check
  // above is only a friendly fast path - two concurrent reversals of the same
  // entry could both pass it, and only the (tenant-agnostic) @@unique on
  // reversalOfId would then stop the second, surfacing as an unhandled
  // unique-violation instead of a clean conflict. Flipping the status with a
  // conditional UPDATE first makes exactly one caller win; the loser blocks on
  // the row lock, then sees count 0.
  const claimed = await tx.journalEntry.updateMany({
    where: { id: original.id, tenantId, status: 'POSTED' },
    data: { status: 'VOID' },
  });
  if (claimed.count === 0) throw new ConflictError('This journal entry has already been reversed', 'ALREADY_APPLIED');

  const reversal = await postJournalEntry(tx, {
    tenantId,
    branchId: branchId ?? original.branchId,
    date: date || new Date(),
    sourceType: sourceType || original.sourceType,
    sourceId: sourceId ?? original.sourceId,
    memo: memo || `Reversal of ${original.entryNumber}`,
    postedById,
    reversalOfId: original.id,
    lines: original.lines.map((l) => {
      const toControl = settleTo && settleTo.moneyAccountIds.includes(l.accountId);
      return {
        accountId: toControl ? settleTo.accountId : l.accountId,
        debit: l.credit,
        credit: l.debit,
        description: l.description,
        customerId: toControl && settleTo.partyField === 'customerId' ? settleTo.partyId : l.customerId,
        supplierId: toControl && settleTo.partyField === 'supplierId' ? settleTo.partyId : l.supplierId,
      };
    }),
  });

  return reversal;
}

module.exports = {
  DEFAULT_ACCOUNTS,
  LEDGER_STATUSES,
  round2,
  ensureChartOfAccounts,
  getSystemAccountId,
  getExpenseCategoryAccountId,
  getMoneyAccountId,
  methodAccountKey,
  assertPeriodOpen,
  lockTenantJournal,
  allocateReceiptNumber,
  allocateNoteNumber,
  postJournalEntry,
  reverseJournalEntry,
};
