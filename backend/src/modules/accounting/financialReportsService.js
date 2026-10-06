// Phase 2.3 - shared financial reporting service.
//
// Every statement here is derived exclusively from JournalLine rows (never from
// Sale/Purchase totals), so a report can never drift from what was posted, and
// every entry point takes the same (user, {branchId, companyId}) scope so the
// reports, the reconciliations and the dashboard KPIs all agree by construction.
//
// Reconciliation reuses the Phase 2.2 AR/AP read models (arapService) rather than
// re-deriving subledger balances.
const { ValidationError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const { getAccessibleBranchIds } = require('../../middleware/branchScope');
const { LEDGER_STATUSES, round2, ensureChartOfAccounts } = require('./ledger');
const arap = require('../receivables/arapService');

const num = (v) => Number(v || 0);
const EPS = 0.005;
const DEBIT_NORMAL = ['ASSET', 'EXPENSE'];
const normalNet = (type, debit, credit) => (DEBIT_NORMAL.includes(type) ? debit - credit : credit - debit);

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A bare date ("2026-09-24") used as an upper bound means "through the end of
// that day"; as a lower bound, "from the start of that day". Full ISO
// timestamps are used exactly as given.
function parseDate(value, label, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value);
  const d = DATE_ONLY.test(s) ? new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} is not a valid date`);
  return d;
}

function parseRange(query, defaultDays = 30) {
  const to = parseDate(query.to, 'to', { endOfDay: true }) || new Date();
  const from = parseDate(query.from, 'from') || new Date(to.getTime() - defaultDays * 86400000);
  if (from > to) throw new ValidationError('from must not be after to');
  return { from, to };
}

// Resolves branchId / companyId query filters against what the caller may
// access. Returns null for "no restriction", otherwise the exact branch ids the
// report must be limited to (possibly empty). A caller can only ever narrow
// their own access, never widen it.
async function resolveBranchIds(prisma, user, { branchId, companyId } = {}) {
  const accessible = await getAccessibleBranchIds(prisma, user);
  let ids = accessible;

  if (companyId) {
    const company = await prisma.company.findFirst({ where: { id: companyId, tenantId: user.tenantId } });
    if (!company) throw new NotFoundError('Company not found');
    const inCompany = (await prisma.branch.findMany({ where: { tenantId: user.tenantId, companyId }, select: { id: true } })).map((b) => b.id);
    ids = ids === null ? inCompany : ids.filter((id) => inCompany.includes(id));
  }
  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId: user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
    if (accessible !== null && !accessible.includes(branchId)) throw new ForbiddenError('You do not have access to this branch');
    if (ids !== null && !ids.includes(branchId)) ids = [];
    else ids = [branchId];
  }
  return ids;
}

const branchWhere = (ids) => (ids === null ? {} : { branchId: { in: ids } });

// ---------------------------------------------------------------------------
// Ledger aggregation
// ---------------------------------------------------------------------------

async function sumByAccount(prisma, tenantId, ids, dateWhere, accountIds) {
  return prisma.journalLine.groupBy({
    by: ['accountId'],
    where: {
      ...(accountIds ? { accountId: { in: accountIds } } : {}),
      account: { tenantId },
      journalEntry: { tenantId, status: { in: LEDGER_STATUSES }, ...(dateWhere ? { date: dateWhere } : {}), ...branchWhere(ids) },
    },
    _sum: { debit: true, credit: true },
  });
}

const toMap = (rows) => new Map(rows.map((r) => [r.accountId, { debit: num(r._sum.debit), credit: num(r._sum.credit) }]));

// Works with either the root client or an already-open transaction client.
async function ensureChart(client, tenantId) {
  if (typeof client.$transaction === 'function') await client.$transaction((tx) => ensureChartOfAccounts(tx, tenantId));
  else await ensureChartOfAccounts(client, tenantId);
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

// Trial balance as of `asOf`. When `from` is also given the period view adds
// opening balance, period debits/credits and closing balance per account.
async function trialBalance(prisma, user, ids, { asOf, from }) {
  await ensureChart(prisma, user.tenantId);
  const accounts = await prisma.account.findMany({ where: { tenantId: user.tenantId }, orderBy: { code: 'asc' } });
  const closing = toMap(await sumByAccount(prisma, user.tenantId, ids, { lte: asOf }));
  const opening = from ? toMap(await sumByAccount(prisma, user.tenantId, ids, { lt: from })) : null;
  const period = from ? toMap(await sumByAccount(prisma, user.tenantId, ids, { gte: from, lte: asOf })) : null;

  const rows = [];
  for (const a of accounts) {
    const c = closing.get(a.id) || { debit: 0, credit: 0 };
    const net = c.debit - c.credit;
    const row = { accountId: a.id, code: a.code, name: a.name, type: a.type, debit: net > 0 ? round2(net) : 0, credit: net < 0 ? round2(-net) : 0 };
    if (from) {
      const o = opening.get(a.id) || { debit: 0, credit: 0 };
      const p = period.get(a.id) || { debit: 0, credit: 0 };
      row.openingBalance = round2(o.debit - o.credit);
      row.periodDebit = round2(p.debit);
      row.periodCredit = round2(p.credit);
      row.closingBalance = round2(net);
    }
    if (Math.abs(net) < EPS && !(from && (row.periodDebit || row.periodCredit || Math.abs(row.openingBalance) >= EPS))) continue;
    rows.push(row);
  }
  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return { asOf, from: from || null, rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

async function profitLoss(prisma, user, ids, { from, to }) {
  const accounts = await prisma.account.findMany({ where: { tenantId: user.tenantId, type: { in: ['REVENUE', 'EXPENSE'] } }, orderBy: { code: 'asc' } });
  const sums = toMap(await sumByAccount(prisma, user.tenantId, ids, { gte: from, lte: to }));
  const revenueLines = [];
  const expenseLines = [];
  let cogs = 0;
  for (const a of accounts) {
    const s = sums.get(a.id);
    if (!s) continue;
    const amount = round2(normalNet(a.type, s.debit, s.credit));
    if (amount === 0) continue;
    if (a.type === 'REVENUE') revenueLines.push({ accountId: a.id, code: a.code, name: a.name, amount });
    else {
      expenseLines.push({ accountId: a.id, code: a.code, name: a.name, amount });
      if (a.systemKey === 'COGS') cogs = amount;
    }
  }
  const totalRevenue = round2(revenueLines.reduce((s, l) => s + l.amount, 0));
  const totalExpense = round2(expenseLines.reduce((s, l) => s + l.amount, 0));
  return {
    from, to, revenueLines, expenseLines, totalRevenue, totalExpense,
    costOfGoodsSold: cogs,
    grossProfit: round2(totalRevenue - cogs),
    operatingExpense: round2(totalExpense - cogs),
    netProfit: round2(totalRevenue - totalExpense),
  };
}

async function balanceSheet(prisma, user, ids, { asOf }) {
  const accounts = await prisma.account.findMany({ where: { tenantId: user.tenantId }, orderBy: { code: 'asc' } });
  const sums = toMap(await sumByAccount(prisma, user.tenantId, ids, { lte: asOf }));
  const byType = { ASSET: [], LIABILITY: [], EQUITY: [] };
  let revenue = 0;
  let expense = 0;
  for (const a of accounts) {
    const s = sums.get(a.id);
    if (!s) continue;
    const amount = round2(normalNet(a.type, s.debit, s.credit));
    if (amount === 0) continue;
    if (a.type === 'REVENUE') revenue += amount;
    else if (a.type === 'EXPENSE') expense += amount;
    else byType[a.type].push({ accountId: a.id, code: a.code, name: a.name, amount });
  }
  // No period-close-to-equity step exists yet, so cumulative profit is shown as a
  // computed line - otherwise Assets = Liabilities + Equity would not hold.
  const retained = round2(revenue - expense);
  const totalAssets = round2(byType.ASSET.reduce((s, l) => s + l.amount, 0));
  const totalLiabilities = round2(byType.LIABILITY.reduce((s, l) => s + l.amount, 0));
  const totalEquity = round2(byType.EQUITY.reduce((s, l) => s + l.amount, 0) + retained);
  return {
    asOf,
    assets: byType.ASSET,
    liabilities: byType.LIABILITY,
    equity: [...byType.EQUITY, { accountId: null, code: null, name: 'Retained Earnings (current, unclosed)', amount: retained }],
    totalAssets, totalLiabilities, totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  };
}

// Cash & bank position: per account opening balance, receipts, payments and
// closing balance for the period, plus movement by originating transaction type.
async function cashBank(prisma, user, ids, { from, to }) {
  await ensureChart(prisma, user.tenantId);
  const accounts = await prisma.account.findMany({ where: { tenantId: user.tenantId, systemKey: { in: ['CASH', 'BANK'] } }, orderBy: { code: 'asc' } });
  const accountIds = accounts.map((a) => a.id);
  const [openingRows, periodRows] = await Promise.all([
    sumByAccount(prisma, user.tenantId, ids, { lt: from }, accountIds),
    sumByAccount(prisma, user.tenantId, ids, { gte: from, lte: to }, accountIds),
  ]);
  const opening = toMap(openingRows);
  const period = toMap(periodRows);

  const lines = await prisma.journalLine.findMany({
    where: { accountId: { in: accountIds }, journalEntry: { tenantId: user.tenantId, status: { in: LEDGER_STATUSES }, date: { gte: from, lte: to }, ...branchWhere(ids) } },
    select: { accountId: true, debit: true, credit: true, journalEntry: { select: { sourceType: true } } },
  });
  const bySource = {};
  for (const l of lines) {
    const key = l.journalEntry.sourceType;
    bySource[key] = round2((bySource[key] || 0) + num(l.debit) - num(l.credit));
  }

  const out = accounts.map((a) => {
    const o = opening.get(a.id) || { debit: 0, credit: 0 };
    const p = period.get(a.id) || { debit: 0, credit: 0 };
    const openingBalance = round2(o.debit - o.credit);
    return { accountId: a.id, code: a.code, name: a.name, key: a.systemKey, openingBalance, receipts: round2(p.debit), payments: round2(p.credit), closingBalance: round2(openingBalance + p.debit - p.credit) };
  });
  const sum = (k) => round2(out.reduce((s, a) => s + a[k], 0));
  return { from, to, accounts: out, totals: { openingBalance: sum('openingBalance'), receipts: sum('receipts'), payments: sum('payments'), closingBalance: sum('closingBalance') }, bySource, netChange: round2(sum('closingBalance') - sum('openingBalance')) };
}

// Cash / bank book: like a general ledger for one account, but the running
// balance starts from the account's balance BEFORE the period.
async function moneyBook(prisma, user, ids, systemKey, { from, to }) {
  await ensureChart(prisma, user.tenantId);
  const account = await prisma.account.findFirst({ where: { tenantId: user.tenantId, systemKey } });
  const openingRows = toMap(await sumByAccount(prisma, user.tenantId, ids, { lt: from }, [account.id]));
  const o = openingRows.get(account.id) || { debit: 0, credit: 0 };
  const openingBalance = round2(o.debit - o.credit);
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId: user.tenantId, status: { in: LEDGER_STATUSES }, date: { gte: from, lte: to }, lines: { some: { accountId: account.id } }, ...branchWhere(ids) },
    include: { lines: { where: { accountId: account.id } } },
    orderBy: [{ date: 'asc' }, { entryNumber: 'asc' }],
  });
  let running = openingBalance;
  const rows = entries.map((e) => {
    const debit = e.lines.reduce((s, l) => s + num(l.debit), 0);
    const credit = e.lines.reduce((s, l) => s + num(l.credit), 0);
    running = round2(running + debit - credit);
    return { journalEntryId: e.id, entryNumber: e.entryNumber, date: e.date, memo: e.memo, sourceType: e.sourceType, debit, credit, runningBalance: running };
  });
  return { from, to, account: { id: account.id, code: account.code, name: account.name }, openingBalance, rows, closingBalance: running };
}

// ---------------------------------------------------------------------------
// KPIs (ledger-derived; used by the dashboard and the reports page)
// ---------------------------------------------------------------------------

async function kpis(prisma, user, ids, { from, to }) {
  const [pl, cb, sheet] = await Promise.all([
    profitLoss(prisma, user, ids, { from, to }),
    cashBank(prisma, user, ids, { from, to: new Date() }),
    (async () => {
      await ensureChart(prisma, user.tenantId);
      const keyed = await prisma.account.findMany({ where: { tenantId: user.tenantId, systemKey: { in: ['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY'] } } });
      const sums = toMap(await sumByAccount(prisma, user.tenantId, ids, { lte: new Date() }, keyed.map((a) => a.id)));
      const bal = (key, credit) => {
        const a = keyed.find((k) => k.systemKey === key);
        const s = a && sums.get(a.id);
        return s ? round2(credit ? s.credit - s.debit : s.debit - s.credit) : 0;
      };
      return { receivables: bal('ACCOUNTS_RECEIVABLE'), payables: bal('ACCOUNTS_PAYABLE', true), inventoryValue: bal('INVENTORY') };
    })(),
  ]);
  const byKey = Object.fromEntries(cb.accounts.map((a) => [a.key, a.closingBalance]));
  return {
    from, to,
    revenue: pl.totalRevenue, costOfGoodsSold: pl.costOfGoodsSold, grossProfit: pl.grossProfit, operatingExpense: pl.operatingExpense, netProfit: pl.netProfit,
    cashBalance: byKey.CASH || 0, bankBalance: byKey.BANK || 0, cashAndBank: cb.totals.closingBalance,
    ...sheet,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

// Number of posted/voided entries whose debits and credits differ - must always
// be zero (postJournalEntry refuses to write one); reported as a standing check.
async function unbalancedEntryCount(prisma, tenantId) {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM (
      SELECT je.id FROM "journal_entries" je JOIN "journal_lines" jl ON jl."journalEntryId" = je.id
      WHERE je."tenantId" = ${tenantId} AND je.status IN ('POSTED','VOID')
      GROUP BY je.id HAVING ROUND(SUM(jl.debit) - SUM(jl.credit), 2) <> 0
    ) t`;
  return rows[0]?.n ?? 0;
}

// Ledger control account vs the AR/AP subledger (Phase 2.2 read models). The
// subledger is "now" only - open documents carry current balances - so this is
// a current-position reconciliation. Every party whose ledger balance differs
// from its open documents is classified; anything not explained is flagged.
async function subledgerReconciliation(prisma, user, cfg, ids) {
  const opts = { branchIds: ids };
  const [summary, gl] = await Promise.all([arap.getSummary(prisma, user, cfg, opts), arap.glBalances(prisma, user, cfg, undefined, opts)]);
  const docsByParty = new Map(summary.items.map((r) => [r.partyId || null, r]));
  const partyIds = new Set([...docsByParty.keys(), ...gl.byParty.keys()]);
  const names = new Map();
  const real = [...partyIds].filter(Boolean);
  if (real.length) {
    const found = await prisma[cfg.partyModel].findMany({ where: { tenantId: user.tenantId, id: { in: real } }, select: { id: true, name: true } });
    for (const p of found) names.set(p.id, p.name);
  }

  const differing = [];
  for (const id of partyIds) {
    const docNet = docsByParty.get(id)?.netOutstanding ?? 0;
    const ledger = gl.byParty.get(id) ?? 0;
    const diff = round2(ledger - docNet);
    if (Math.abs(diff) < EPS) continue;
    differing.push({ partyId: id, partyName: id ? names.get(id) || 'Unknown' : cfg.side === 'AR' ? 'Walk-in / untagged' : 'Untagged', documentsNet: docNet, ledgerBalance: ledger, difference: diff });
  }

  const totals = { explained: 0, unexplained: 0 };
  const capped = differing.slice(0, 200);
  for (const row of capped) {
    if (!row.partyId) {
      row.reason = 'UNTAGGED_LEDGER_ACTIVITY';
      totals.explained += row.difference;
      continue;
    }
    const statement = await arap.getStatement(prisma, user, cfg, row.partyId, { branchIds: ids });
    if (Math.abs(statement.currentBalance - row.ledgerBalance) < EPS) {
      row.reason = statement.rows.some((r) => r.type === 'LEDGER_ADJUSTMENT') ? 'MANUAL_OR_OPENING_ENTRIES' : 'SETTLEMENT_HELD_ON_REVERSED_DOCUMENT';
    } else if (cfg.side === 'AR' && (await prisma.opticalOrder.count({ where: { tenantId: user.tenantId, customerId: row.partyId } })) > 0) {
      row.reason = 'OPTICAL_ORDERS';
    } else {
      row.reason = 'UNEXPLAINED';
    }
    if (row.reason === 'UNEXPLAINED') totals.unexplained += row.difference;
    else totals.explained += row.difference;
  }
  // Parties beyond the cap are counted as unexplained rather than silently dropped.
  for (const row of differing.slice(200)) totals.unexplained += row.difference;

  const glTotal = gl.total;
  const subTotal = summary.totals.netOutstanding;
  return {
    side: cfg.side,
    controlAccount: cfg.accountKey,
    ledgerBalance: glTotal,
    subledgerBalance: subTotal,
    difference: round2(glTotal - subTotal),
    explainedDifference: round2(totals.explained),
    unexplainedDifference: round2(totals.unexplained),
    reconciled: Math.abs(totals.unexplained) < EPS,
    partiesWithDifferences: capped,
    truncated: differing.length > capped.length,
  };
}

// Ledger cash/bank vs the Payment records (cumulative through `to`). Only
// meaningful tenant-wide: Payment rows do not all carry a branch.
async function cashReconciliation(prisma, user, ids, { to }) {
  await ensureChart(prisma, user.tenantId);
  const accounts = await prisma.account.findMany({ where: { tenantId: user.tenantId, systemKey: { in: ['CASH', 'BANK'] } } });
  const accountIds = accounts.map((a) => a.id);
  const sums = await sumByAccount(prisma, user.tenantId, ids, { lte: to }, accountIds);
  const ledger = round2(sums.reduce((s, r) => s + num(r._sum.debit) - num(r._sum.credit), 0));

  if (ids !== null) {
    return { available: false, reason: 'Payment records are not attributed to a branch on every row, so this check runs tenant-wide only', ledgerBalance: ledger };
  }

  const payments = await prisma.payment.groupBy({
    by: ['direction'],
    where: { tenantId: user.tenantId, status: 'COMPLETED', paidAt: { lte: to } },
    _sum: { amount: true },
  });
  const paymentNet = round2(payments.reduce((s, p) => s + (p.direction === 'IN' ? num(p._sum.amount) : -num(p._sum.amount)), 0));

  // Ledger movements that legitimately have no Payment row: manual/opening
  // postings, and reversal entries that mirror cash settled inside the original
  // entry while that Payment row stays COMPLETED.
  // (SALES_RETURN is deliberately absent: a walk-in return refunds cash and writes its own Payment record.)
  const NO_PAYMENT_ROW = ['OPENING_BALANCE', 'MANUAL', 'ADJUSTMENT', 'SALE_REVERSAL', 'PURCHASE_RETURN', 'PURCHASE_RETURN_REVERSAL', 'SALES_RETURN_REVERSAL'];
  const lines = await prisma.journalLine.findMany({
    where: { accountId: { in: accountIds }, journalEntry: { tenantId: user.tenantId, status: { in: LEDGER_STATUSES }, date: { lte: to }, sourceType: { in: NO_PAYMENT_ROW } } },
    select: { debit: true, credit: true, journalEntry: { select: { sourceType: true } } },
  });
  const explainedBySource = {};
  for (const l of lines) {
    const k = l.journalEntry.sourceType;
    explainedBySource[k] = round2((explainedBySource[k] || 0) + num(l.debit) - num(l.credit));
  }
  const explained = round2(Object.values(explainedBySource).reduce((s, v) => s + v, 0));
  const residual = round2(ledger - paymentNet - explained);
  return { available: true, ledgerBalance: ledger, paymentRecordsNet: paymentNet, explainedBySource, explained, residual, reconciled: Math.abs(residual) < EPS };
}

// Ledger Inventory account vs stock on hand valued at each product's purchase price (the same
// basis sales use for COGS and stock adjustments use for their entries). Informational: a
// deliberate change of a product's purchase price revalues stock without a journal entry, so
// a difference is something to review, not proof of a fault. Tenant-wide only.
async function inventoryReconciliation(prisma, user, ids, { to }) {
  await ensureChart(prisma, user.tenantId);
  const account = await prisma.account.findFirst({ where: { tenantId: user.tenantId, systemKey: 'INVENTORY' } });
  const sums = toMap(await sumByAccount(prisma, user.tenantId, ids, { lte: to }, [account.id]));
  const s = sums.get(account.id) || { debit: 0, credit: 0 };
  const ledger = round2(s.debit - s.credit);
  if (ids !== null) return { available: false, reason: 'Stock on hand is not attributed to a branch on every product, so this check runs tenant-wide only', ledgerBalance: ledger };
  const products = await prisma.product.findMany({ where: { tenantId: user.tenantId, productKind: { not: 'SERVICE' } }, select: { stockQuantity: true, purchasePrice: true } });
  const stockValue = round2(products.reduce((sum, p) => sum + num(p.stockQuantity) * num(p.purchasePrice), 0));
  const difference = round2(ledger - stockValue);
  return { available: true, ledgerBalance: ledger, stockValuation: stockValue, difference, reconciled: Math.abs(difference) < EPS };
}

// One consistent snapshot of everything: run inside a REPEATABLE READ
// transaction so concurrent postings cannot make the parts disagree.
async function reconciliationReport(prisma, user, { branchId, companyId, to }) {
  // Seed the default chart BEFORE opening the snapshot transaction (it may write).
  await ensureChart(prisma, user.tenantId);
  return prisma.$transaction(
    async (tx) => {
      const ids = await resolveBranchIds(tx, user, { branchId, companyId });
      const [receivables, payables, cash, inventory, tb, unbalanced] = await Promise.all([
        subledgerReconciliation(tx, user, arap.SIDES.AR, ids),
        subledgerReconciliation(tx, user, arap.SIDES.AP, ids),
        cashReconciliation(tx, user, ids, { to }),
        inventoryReconciliation(tx, user, ids, { to }),
        trialBalance(tx, user, ids, { asOf: to }),
        unbalancedEntryCount(tx, user.tenantId),
      ]);
      const checks = [
        { key: 'TRIAL_BALANCE_BALANCED', ok: tb.balanced, detail: `Debits ${tb.totalDebit} / Credits ${tb.totalCredit}` },
        { key: 'NO_UNBALANCED_ENTRIES', ok: unbalanced === 0, detail: `${unbalanced} unbalanced entries` },
        { key: 'RECEIVABLES_RECONCILED', ok: receivables.reconciled, detail: `Unexplained ${receivables.unexplainedDifference}` },
        { key: 'PAYABLES_RECONCILED', ok: payables.reconciled, detail: `Unexplained ${payables.unexplainedDifference}` },
      ];
      if (cash.available) checks.push({ key: 'CASH_RECONCILED', ok: cash.reconciled, detail: `Residual ${cash.residual}` });
      return { asOf: to, scoped: ids !== null, receivables, payables, cash, inventory, checks, allChecksPassed: checks.every((c) => c.ok) };
    },
    { isolationLevel: 'RepeatableRead', timeout: 30000, maxWait: 10000 },
  );
}

module.exports = {
  parseDate, parseRange, resolveBranchIds, branchWhere,
  trialBalance, profitLoss, balanceSheet, cashBank, moneyBook, kpis,
  subledgerReconciliation, cashReconciliation, inventoryReconciliation, reconciliationReport, unbalancedEntryCount,
};
