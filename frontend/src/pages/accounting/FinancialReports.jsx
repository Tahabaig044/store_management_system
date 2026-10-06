// Phase 2.3: Financial statements and reconciliation - Trial Balance, Profit &
// Loss, Balance Sheet, Cash & Bank, and the ledger-to-subledger Reconciliation,
// all with date / branch / company filters, CSV export (REPORT:EXPORT) and print.
// Read-only: nothing here posts or changes accounting data, so nothing needs to
// be (or is) queued offline.
import { useEffect, useState } from 'react';
import { FiDownload, FiPrinter } from 'react-icons/fi';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency as money } from '../../utils/currency';
import { downloadCsv } from '../../utils/csv';

const TABS = [
  { key: 'trial-balance', label: 'Trial Balance' },
  { key: 'profit-loss', label: 'Profit & Loss' },
  { key: 'balance-sheet', label: 'Balance Sheet' },
  { key: 'cash-bank', label: 'Cash & Bank' },
  { key: 'reconciliation', label: 'Reconciliation' },
];

const REASONS = {
  MANUAL_OR_OPENING_ENTRIES: 'Manual or opening entries',
  SETTLEMENT_HELD_ON_REVERSED_DOCUMENT: 'Payment held on a reversed document',
  OPTICAL_ORDERS: 'Optical orders',
  UNTAGGED_LEDGER_ACTIVITY: 'Ledger activity without a customer/supplier',
  UNEXPLAINED: 'Unexplained',
};

const iso = (d) => d.toISOString().slice(0, 10);
const monthStart = () => { const d = new Date(); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); };

// Rows for CSV, shaped per report.
function csvRows(tab, d) {
  switch (tab) {
    case 'trial-balance':
      return [['Code', 'Account', 'Type', 'Debit', 'Credit'], ...d.rows.map((r) => [r.code, r.name, r.type, r.debit, r.credit]), [], ['Total', '', '', d.totalDebit, d.totalCredit]];
    case 'profit-loss':
      return [
        ['Section', 'Code', 'Account', 'Amount'],
        ...d.revenueLines.map((l) => ['Revenue', l.code, l.name, l.amount]),
        ['Revenue', '', 'Total revenue', d.totalRevenue],
        ...d.expenseLines.map((l) => ['Expense', l.code, l.name, l.amount]),
        ['Expense', '', 'Total expenses', d.totalExpense],
        ['', '', 'Gross profit', d.grossProfit],
        ['', '', 'Net profit', d.netProfit],
      ];
    case 'balance-sheet':
      return [
        ['Section', 'Code', 'Account', 'Amount'],
        ...d.assets.map((l) => ['Assets', l.code, l.name, l.amount]),
        ['Assets', '', 'Total assets', d.totalAssets],
        ...d.liabilities.map((l) => ['Liabilities', l.code, l.name, l.amount]),
        ['Liabilities', '', 'Total liabilities', d.totalLiabilities],
        ...d.equity.map((l) => ['Equity', l.code, l.name, l.amount]),
        ['Equity', '', 'Total equity', d.totalEquity],
      ];
    case 'cash-bank':
      return [['Account', 'Opening', 'Receipts', 'Payments', 'Closing'], ...d.accounts.map((a) => [a.name, a.openingBalance, a.receipts, a.payments, a.closingBalance]), ['Total', d.totals.openingBalance, d.totals.receipts, d.totals.payments, d.totals.closingBalance]];
    default:
      return [
        ['Check', 'Passed', 'Detail'],
        ...d.checks.map((c) => [c.key, c.ok ? 'Yes' : 'No', c.detail]),
        [],
        ['Side', 'Ledger', 'Subledger', 'Explained', 'Unexplained'],
        ['Receivables', d.receivables.ledgerBalance, d.receivables.subledgerBalance, d.receivables.explainedDifference, d.receivables.unexplainedDifference],
        ['Payables', d.payables.ledgerBalance, d.payables.subledgerBalance, d.payables.explainedDifference, d.payables.unexplainedDifference],
        ...(d.inventory?.available ? [[], ['Inventory ledger', 'Stock valuation', 'Difference'], [d.inventory.ledgerBalance, d.inventory.stockValuation, d.inventory.difference]] : []),
      ];
  }
}

export default function FinancialReports() {
  const { hasPermission } = useAuth();
  const canExport = hasPermission('REPORT:EXPORT');
  const [tab, setTab] = useState('trial-balance');
  const [filters, setFilters] = useState({ from: monthStart(), to: iso(new Date()), branchId: '', companyId: '' });
  const [branches, setBranches] = useState([]);
  const [companies, setCompanies] = useState([]);
  // Keyed by tab so a report is never rendered with another report's payload
  // during the render between switching tabs and the new response arriving.
  const [result, setResult] = useState(null);
  const data = result && result.tab === tab ? result.data : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    apiClient.get('/branches').then((r) => setBranches(r.data.items || [])).catch(() => {});
    apiClient.get('/companies').then((r) => setCompanies(r.data.items || [])).catch(() => {});
  }, []);

  function load() {
    setLoading(true);
    setError('');
    setResult(null);
    const params = {};
    if (filters.branchId) params.branchId = filters.branchId;
    if (filters.companyId) params.companyId = filters.companyId;
    if (tab === 'trial-balance') { params.from = filters.from; params.asOf = filters.to; }
    else if (tab === 'profit-loss' || tab === 'cash-bank') { params.from = filters.from; params.to = filters.to; }
    else params.asOf = filters.to;
    apiClient
      .get(`/accounting/reports/${tab}`, { params })
      .then((res) => setResult({ tab, data: res.data }))
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [tab]);

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h4 className="mb-0">Financial Reports</h4>
        <div className="d-flex gap-2 d-print-none">
          {canExport && (
            <button className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1" disabled={!data} onClick={() => downloadCsv(`${tab}-${filters.to}.csv`, csvRows(tab, data))}>
              <FiDownload /> Export CSV
            </button>
          )}
          <button className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1" disabled={!data} onClick={() => window.print()}>
            <FiPrinter /> Print
          </button>
        </div>
      </div>

      <ul className="nav nav-tabs mb-3 d-print-none">
        {TABS.map((t) => (
          <li className="nav-item" key={t.key}>
            <button className={`nav-link ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
          </li>
        ))}
      </ul>

      <form className="row g-2 align-items-end mb-3 d-print-none" onSubmit={(e) => { e.preventDefault(); load(); }}>
        {tab !== 'balance-sheet' && tab !== 'reconciliation' && (
          <div className="col-auto"><label className="form-label mb-0 small" htmlFor="fr-from">From</label><input id="fr-from" type="date" className="form-control form-control-sm" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></div>
        )}
        <div className="col-auto"><label className="form-label mb-0 small" htmlFor="fr-to">{tab === 'balance-sheet' || tab === 'reconciliation' ? 'As of' : 'To'}</label><input id="fr-to" type="date" className="form-control form-control-sm" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></div>
        <div className="col-auto">
          <label className="form-label mb-0 small" htmlFor="fr-branch">Branch</label>
          <select id="fr-branch" className="form-select form-select-sm" value={filters.branchId} onChange={(e) => setFilters({ ...filters, branchId: e.target.value })}>
            <option value="">All branches</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        {companies.length > 0 && (
          <div className="col-auto">
            <label className="form-label mb-0 small" htmlFor="fr-company">Company</label>
            <select id="fr-company" className="form-select form-select-sm" value={filters.companyId} onChange={(e) => setFilters({ ...filters, companyId: e.target.value })}>
              <option value="">All companies</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div className="col-auto"><button className="btn btn-sm btn-primary" type="submit">Run report</button></div>
      </form>

      <ErrorAlert message={error} />
      {loading ? <Spinner /> : !data ? null : (
        <>
          {tab === 'trial-balance' && <TrialBalance d={data} />}
          {tab === 'profit-loss' && <ProfitLoss d={data} />}
          {tab === 'balance-sheet' && <BalanceSheet d={data} />}
          {tab === 'cash-bank' && <CashBank d={data} />}
          {tab === 'reconciliation' && <Reconciliation d={data} />}
        </>
      )}
    </div>
  );
}

const Num = ({ v }) => <td className="text-end">{money(v)}</td>;

function TrialBalance({ d }) {
  if (!d.rows.length) return <EmptyState message="No ledger activity for this selection." />;
  const period = d.from !== null;
  return (
    <div className="card"><div className="table-responsive"><table className="table table-sm mb-0">
      <thead><tr><th>Code</th><th>Account</th>{period && <><th className="text-end">Opening</th><th className="text-end">Period Dr</th><th className="text-end">Period Cr</th></>}<th className="text-end">Debit</th><th className="text-end">Credit</th></tr></thead>
      <tbody>
        {d.rows.map((r) => (
          <tr key={r.accountId}><td>{r.code}</td><td>{r.name}</td>{period && <><Num v={r.openingBalance} /><Num v={r.periodDebit} /><Num v={r.periodCredit} /></>}<Num v={r.debit} /><Num v={r.credit} /></tr>
        ))}
      </tbody>
      <tfoot><tr className="fw-semibold"><td colSpan={period ? 5 : 2}>Total</td><Num v={d.totalDebit} /><Num v={d.totalCredit} /></tr></tfoot>
    </table></div>
    <div className="card-footer small" role="status">{d.balanced ? 'Debits equal credits.' : 'Debits and credits do NOT balance - see the Reconciliation tab.'}</div></div>
  );
}

function Section({ title, lines, total }) {
  return (
    <>
      <tr className="table-light"><td colSpan={2} className="fw-semibold">{title}</td></tr>
      {lines.map((l) => <tr key={`${l.code}-${l.name}`}><td>{l.code ? `${l.code} - ` : ''}{l.name}</td><Num v={l.amount} /></tr>)}
      <tr className="fw-semibold"><td>Total {title.toLowerCase()}</td><Num v={total} /></tr>
    </>
  );
}

function ProfitLoss({ d }) {
  return (
    <div className="card"><div className="table-responsive"><table className="table table-sm mb-0"><tbody>
      <Section title="Revenue" lines={d.revenueLines} total={d.totalRevenue} />
      <Section title="Expenses" lines={d.expenseLines} total={d.totalExpense} />
      <tr className="fw-semibold"><td>Gross profit (revenue - cost of goods sold)</td><Num v={d.grossProfit} /></tr>
      <tr className="fw-bold table-light"><td>Net profit</td><Num v={d.netProfit} /></tr>
    </tbody></table></div></div>
  );
}

function BalanceSheet({ d }) {
  return (
    <div className="card"><div className="table-responsive"><table className="table table-sm mb-0"><tbody>
      <Section title="Assets" lines={d.assets} total={d.totalAssets} />
      <Section title="Liabilities" lines={d.liabilities} total={d.totalLiabilities} />
      <Section title="Equity" lines={d.equity} total={d.totalEquity} />
    </tbody></table></div>
    <div className="card-footer small" role="status">{d.balanced ? 'Assets equal liabilities plus equity.' : 'The balance sheet does NOT balance - see the Reconciliation tab.'}</div></div>
  );
}

function CashBank({ d }) {
  return (
    <>
      <div className="card mb-3"><div className="table-responsive"><table className="table table-sm mb-0">
        <thead><tr><th>Account</th><th className="text-end">Opening</th><th className="text-end">Receipts</th><th className="text-end">Payments</th><th className="text-end">Closing</th></tr></thead>
        <tbody>{d.accounts.map((a) => <tr key={a.accountId}><td>{a.name}</td><Num v={a.openingBalance} /><Num v={a.receipts} /><Num v={a.payments} /><Num v={a.closingBalance} /></tr>)}</tbody>
        <tfoot><tr className="fw-semibold"><td>Total</td><Num v={d.totals.openingBalance} /><Num v={d.totals.receipts} /><Num v={d.totals.payments} /><Num v={d.totals.closingBalance} /></tr></tfoot>
      </table></div></div>
      {Object.keys(d.bySource).length > 0 && (
        <div className="card"><div className="card-header small fw-semibold">Net movement by transaction type</div>
          <table className="table table-sm mb-0"><tbody>{Object.entries(d.bySource).map(([k, v]) => <tr key={k}><td>{k}</td><Num v={v} /></tr>)}</tbody></table></div>
      )}
    </>
  );
}

function SideReconciliation({ title, r }) {
  return (
    <div className="card mb-3">
      <div className="card-header d-flex justify-content-between"><span className="fw-semibold">{title}</span><span className={`badge text-bg-${r.reconciled ? 'success' : 'danger'}`}>{r.reconciled ? 'Reconciled' : 'Needs review'}</span></div>
      <div className="card-body">
        <div className="row g-2 mb-2">
          <div className="col"><div className="small text-body-secondary">Ledger</div><div className="fw-semibold">{money(r.ledgerBalance)}</div></div>
          <div className="col"><div className="small text-body-secondary">Open documents (net of credit)</div><div className="fw-semibold">{money(r.subledgerBalance)}</div></div>
          <div className="col"><div className="small text-body-secondary">Explained difference</div><div className="fw-semibold">{money(r.explainedDifference)}</div></div>
          <div className="col"><div className="small text-body-secondary">Unexplained</div><div className="fw-semibold">{money(r.unexplainedDifference)}</div></div>
        </div>
        {r.partiesWithDifferences.length > 0 && (
          <table className="table table-sm mb-0">
            <thead><tr><th>Party</th><th className="text-end">Documents</th><th className="text-end">Ledger</th><th className="text-end">Difference</th><th>Reason</th></tr></thead>
            <tbody>{r.partiesWithDifferences.map((p) => <tr key={p.partyId || 'none'}><td>{p.partyName}</td><Num v={p.documentsNet} /><Num v={p.ledgerBalance} /><Num v={p.difference} /><td>{REASONS[p.reason] || p.reason}</td></tr>)}</tbody>
          </table>
        )}
        {r.truncated && <div className="small text-warning-emphasis mt-2">Only the first 200 differing parties are listed; the rest are counted as unexplained.</div>}
      </div>
    </div>
  );
}

function Reconciliation({ d }) {
  return (
    <>
      <div className={`alert py-2 ${d.allChecksPassed ? 'alert-success' : 'alert-danger'}`} role="status">
        {d.allChecksPassed ? 'All integrity checks passed.' : 'One or more integrity checks need review.'}
      </div>
      <ul className="list-group mb-3">
        {d.checks.map((c) => (
          <li className="list-group-item d-flex justify-content-between" key={c.key}>
            <span>{c.key.replaceAll('_', ' ').toLowerCase()}</span>
            <span className={c.ok ? 'text-success' : 'text-danger'}>{c.ok ? 'OK' : 'FAILED'} - {c.detail}</span>
          </li>
        ))}
      </ul>
      <SideReconciliation title="Accounts Receivable vs customer documents" r={d.receivables} />
      <SideReconciliation title="Accounts Payable vs supplier documents" r={d.payables} />
      <div className="card">
        <div className="card-header fw-semibold">Cash &amp; bank vs payment records</div>
        <div className="card-body small">
          {d.cash.available
            ? <>Ledger {money(d.cash.ledgerBalance)} - payment records {money(d.cash.paymentRecordsNet)} - explained {money(d.cash.explained)} = residual {money(d.cash.residual)}.</>
            : d.cash.reason}
        </div>
      </div>
      {d.inventory && (
        <div className="card mt-3">
          <div className="card-header fw-semibold">Inventory ledger vs stock on hand</div>
          <div className="card-body small">
            {d.inventory.available
              ? <>Ledger {money(d.inventory.ledgerBalance)} - stock valued at purchase price {money(d.inventory.stockValuation)} = difference {money(d.inventory.difference)}. {d.inventory.reconciled ? 'They agree.' : 'For review (informational): a cost adjustment or a changed purchase price revalues stock without a stock movement.'}</>
              : d.inventory.reason}
          </div>
        </div>
      )}
      {d.scoped && <div className="small text-body-secondary mt-2">This view is limited to the selected branch/company.</div>}
    </>
  );
}
