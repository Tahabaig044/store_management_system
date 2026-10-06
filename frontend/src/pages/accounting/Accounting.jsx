import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { formatCurrency as money } from '../../utils/currency';

// A single page covering the Phase 5 accounting module's most-used views.
// Every one of these reports also exists as a tested backend endpoint even
// where there's no dedicated tab here (see docs/phase5-accounting-procurement.md).
const TABS = [
  { key: 'accounts', label: 'Chart of Accounts' },
  { key: 'journal', label: 'Journal' },
  { key: 'trial-balance', label: 'Trial Balance' },
  { key: 'profit-loss', label: 'Profit & Loss' },
  { key: 'balance-sheet', label: 'Balance Sheet' },
  { key: 'ar-aging', label: 'Receivables Aging' },
  { key: 'ap-aging', label: 'Payables Aging' },
];


export default function Accounting() {
  const [tab, setTab] = useState('accounts');
  // Keyed by tab so a tab is never rendered with another tab's payload during the render between
  // switching tabs and the new response arriving (each view reads its own shape unconditionally).
  const [result, setResult] = useState(null);
  const data = result && result.tab === tab ? result.data : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    // A request for a tab the user has since switched away from can resolve
    // after a later one (ordinary out-of-order network timing) - without this
    // guard its response would overwrite `data` with a shape that doesn't
    // match the now-current tab (e.g. balance-sheet's {assets,...} landing
    // while `tab` has already moved to journal's {items}), and every view
    // below reads its own shape unconditionally.
    let cancelled = false;
    setLoading(true);
    setError('');
    setResult(null);
    const path = {
      accounts: '/accounting/accounts',
      journal: '/accounting/journal',
      'trial-balance': '/accounting/reports/trial-balance',
      'profit-loss': '/accounting/reports/profit-loss',
      'balance-sheet': '/accounting/reports/balance-sheet',
      'ar-aging': '/accounting/reports/ar-aging',
      'ap-aging': '/accounting/reports/ap-aging',
    }[tab];
    apiClient
      .get(path)
      .then((res) => { if (!cancelled) setResult({ tab, data: res.data }); })
      .catch((err) => { if (!cancelled) setError(extractErrorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab]);

  return (
    <div>
      <div className="mb-4">
        <h4 className="mb-1">Accounting</h4>
        <div className="text-body-secondary small">Chart of Accounts, journal, and financial reports - a real double-entry ledger behind every number.</div>
      </div>

      <ul className="nav nav-pills mb-3 flex-wrap gap-1">
        {TABS.map((t) => (
          <li className="nav-item" key={t.key}>
            <button className={`nav-link ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          </li>
        ))}
      </ul>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : !data ? (
        <EmptyState />
      ) : (
        <div className="card">
          <div className="table-responsive">
            {tab === 'accounts' && <AccountsTable items={data.items} />}
            {tab === 'journal' && <JournalTable items={data.items} />}
            {tab === 'trial-balance' && <TrialBalanceTable data={data} />}
            {tab === 'profit-loss' && <ProfitLossView data={data} />}
            {tab === 'balance-sheet' && <BalanceSheetView data={data} />}
            {tab === 'ar-aging' && <AgingTable data={data} nameKey="customerName" numberKey="invoiceNumber" />}
            {tab === 'ap-aging' && <AgingTable data={data} nameKey="supplierName" numberKey="purchaseNumber" />}
          </div>
        </div>
      )}
    </div>
  );
}

function AccountsTable({ items }) {
  if (!items.length) return <EmptyState message="No accounts yet." />;
  return (
    <table className="table table-hover mb-0 align-middle">
      <thead>
        <tr><th>Code</th><th>Name</th><th>Type</th><th>System</th></tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id}>
            <td className="text-body-secondary">{a.code}</td>
            <td>{a.name}</td>
            <td><span className="badge text-bg-secondary-subtle text-secondary-emphasis">{a.type}</span></td>
            <td>{a.isSystem ? 'Yes' : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JournalTable({ items }) {
  if (!items.length) return <EmptyState message="No journal entries yet." />;
  return (
    <table className="table table-hover mb-0 align-middle">
      <thead>
        <tr><th>Entry #</th><th>Date</th><th>Source</th><th>Memo</th><th>Lines</th><th>Status</th></tr>
      </thead>
      <tbody>
        {items.map((e) => (
          <tr key={e.id}>
            <td className="text-body-secondary">{e.entryNumber}</td>
            <td>{new Date(e.date).toLocaleDateString()}</td>
            <td><span className="badge text-bg-info-subtle text-info-emphasis">{e.sourceType}</span></td>
            <td>{e.memo}</td>
            <td className="small">
              {e.lines.map((l) => (
                <div key={l.id}>
                  {l.account.name}: {Number(l.debit) > 0 ? `Dr ${money(l.debit)}` : `Cr ${money(l.credit)}`}
                </div>
              ))}
            </td>
            <td><span className={`badge text-bg-${e.status === 'VOID' ? 'secondary' : 'success'}`}>{e.status}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrialBalanceTable({ data }) {
  if (!data.rows.length) return <EmptyState message="No activity posted yet." />;
  return (
    <>
      <table className="table table-hover mb-0 align-middle">
        <thead>
          <tr><th>Code</th><th>Account</th><th className="text-end">Debit</th><th className="text-end">Credit</th></tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.accountId}>
              <td className="text-body-secondary">{r.code}</td>
              <td>{r.name}</td>
              <td className="text-end">{r.debit > 0 ? money(r.debit) : ''}</td>
              <td className="text-end">{r.credit > 0 ? money(r.credit) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="fw-bold">
            <td colSpan={2}>Total {data.balanced ? '(balanced)' : '(NOT balanced - please report this)'}</td>
            <td className="text-end">{money(data.totalDebit)}</td>
            <td className="text-end">{money(data.totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

function ProfitLossView({ data }) {
  return (
    <div className="p-3">
      <h6>Revenue</h6>
      {data.revenueLines.length === 0 && <div className="text-body-secondary small mb-2">None</div>}
      {data.revenueLines.map((l) => (
        <div className="d-flex justify-content-between" key={l.accountId}><span>{l.name}</span><span>{money(l.amount)}</span></div>
      ))}
      <hr />
      <h6>Expenses</h6>
      {data.expenseLines.length === 0 && <div className="text-body-secondary small mb-2">None</div>}
      {data.expenseLines.map((l) => (
        <div className="d-flex justify-content-between" key={l.accountId}><span>{l.name}</span><span>{money(l.amount)}</span></div>
      ))}
      <hr />
      <div className="d-flex justify-content-between fw-bold"><span>Net Profit</span><span>{money(data.netProfit)}</span></div>
    </div>
  );
}

function BalanceSheetView({ data }) {
  const section = (title, rows) => (
    <div className="mb-3">
      <h6>{title}</h6>
      {rows.map((r) => (
        <div className="d-flex justify-content-between" key={r.accountId || r.name}><span>{r.name}</span><span>{money(r.amount)}</span></div>
      ))}
    </div>
  );
  return (
    <div className="p-3">
      {section('Assets', data.assets)}
      <div className="d-flex justify-content-between fw-bold mb-3"><span>Total Assets</span><span>{money(data.totalAssets)}</span></div>
      {section('Liabilities', data.liabilities)}
      {section('Equity', data.equity)}
      <div className="d-flex justify-content-between fw-bold"><span>Total Liabilities + Equity</span><span>{money(data.totalLiabilities + data.totalEquity)}</span></div>
      {!data.balanced && <div className="alert alert-danger mt-2">Balance sheet does not balance - please report this.</div>}
    </div>
  );
}

function AgingTable({ data, nameKey, numberKey }) {
  if (!data.rows.length) return <EmptyState message="Nothing outstanding." />;
  return (
    <>
      <table className="table table-hover mb-0 align-middle">
        <thead>
          <tr><th>#</th><th>Name</th><th className="text-end">Amount Due</th><th>Age (days)</th><th>Bucket</th></tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.id}>
              <td className="text-body-secondary">{r[numberKey]}</td>
              <td>{r[nameKey]}</td>
              <td className="text-end">{money(r.amountDue)}</td>
              <td>{r.ageDays}</td>
              <td><span className="badge text-bg-warning-subtle text-warning-emphasis">{r.bucket}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="d-flex gap-3 p-3 border-top small">
        {Object.entries(data.totals).map(([bucket, amount]) => (
          <div key={bucket}><strong>{bucket}:</strong> {money(amount)}</div>
        ))}
      </div>
    </>
  );
}
