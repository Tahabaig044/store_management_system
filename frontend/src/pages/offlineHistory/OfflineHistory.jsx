// Phase 3.4: history, statements and summaries that work with no connection. Everything here is read from
// this device's copy ("as of the last download") plus what this terminal has queued; the official
// figures stay on the server (Reports / Accounting) and need the network.
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { useAuth } from '../../context/AuthContext';
import { getSalesHistory, getPurchasesHistory, getPartyStatement, getSalesSummary, getAging } from '../../offline/historyViews';
import { useLiveCustomers, useLiveSuppliers } from '../../offline/useOfflineData';
import { subscribeSecure, secureVersion } from '../../offline/secureStore';
import { formatCurrency } from '../../utils/currency';
import { formatAge } from '../../offline/useLocalDataStatus';

function useView(tenantId, read, deps) {
  const [value, setValue] = useState(null);
  const [secureV, setSecureV] = useState(secureVersion());
  useEffect(() => subscribeSecure(() => setSecureV(secureVersion())), []);
  useEffect(() => {
    if (!tenantId) return undefined;
    const sub = liveQuery(() => read(tenantId)).subscribe({ next: setValue, error: () => {} });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, secureV, ...deps]);
  return value;
}

const TABS = [
  { key: 'sales', label: 'Sales history', any: ['SALE:VIEW'] },
  { key: 'purchases', label: 'Purchase history', any: ['PURCHASE:VIEW'] },
  { key: 'statement', label: 'Party statement', any: ['CUSTOMER:VIEW', 'SUPPLIER:VIEW'] },
  { key: 'summary', label: 'Sales summary', any: ['SALE:VIEW'] },
  { key: 'aging', label: 'Aging', any: ['CUSTOMER:VIEW', 'SUPPLIER:VIEW'] },
];

function AsOf({ info }) {
  if (!info) return null;
  if (!info.everDownloaded) return <div className="alert alert-warning py-2 small" data-testid="asof">Nothing has been downloaded to this device for this view yet. Connect once (and unlock, if asked) to fill it.</div>;
  return <div className="small text-body-secondary mb-2" data-testid="asof">As of the last download, {formatAge(info.lastCheckedAt ?? info.asOf)}. Figures on this screen are for viewing; the official reports are on the server.</div>;
}

const statusBadge = (r) => (r.queued ? <span className={`badge text-bg-${r.queueStatus === 'conflict' || r.queueStatus === 'failed' ? 'danger' : 'warning'}`}>{r.status === 'REFUSED' ? 'Refused' : 'Not synced'}</span> : <span className="badge text-bg-secondary">{r.status}</span>);

function HistoryTable({ tenantId, kind }) {
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const data = useView(tenantId, (t) => (kind === 'sale' ? getSalesHistory : getPurchasesHistory)(t, { search, from: from || undefined, to: to || undefined }), [kind, search, from, to]);
  return (
    <>
      <div className="row g-2 mb-2">
        <div className="col-md-4"><input aria-label="Search" className="form-control form-control-sm" placeholder="Number or name" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="col-md-3"><input aria-label="From" type="date" className="form-control form-control-sm" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="col-md-3"><input aria-label="To" type="date" className="form-control form-control-sm" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <AsOf info={data} />
      <div className="table-responsive">
        <table className="table table-sm align-middle">
          <thead><tr><th>Number</th><th>Date</th><th>{kind === 'sale' ? 'Customer' : 'Supplier'}</th><th>Status</th><th className="text-end">Total</th><th className="text-end">Paid</th></tr></thead>
          <tbody>
            {(data?.rows || []).map((r) => (
              <tr key={r.id}>
                <td>{r.number}</td><td>{new Date(r.date).toLocaleDateString()}</td><td>{r.partyName || (kind === 'sale' ? 'Walk-in' : '-')}</td>
                <td>{statusBadge(r)}</td><td className="text-end">{formatCurrency(r.total)}</td><td className="text-end">{formatCurrency(r.amountPaid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.rows.length === 0 && <div className="text-body-secondary small">Nothing to show.</div>}
      </div>
    </>
  );
}

function Statement({ tenantId }) {
  const customers = useLiveCustomers(tenantId);
  const suppliers = useLiveSuppliers(tenantId);
  const [side, setSide] = useState('credit');
  const [partyId, setPartyId] = useState('');
  const parties = side === 'credit' ? customers : suppliers;
  const data = useView(tenantId, (t) => (partyId ? getPartyStatement(t, side, partyId) : Promise.resolve(null)), [side, partyId]);
  return (
    <>
      <div className="row g-2 mb-2">
        <div className="col-md-3">
          <select aria-label="Statement for" className="form-select form-select-sm" value={side} onChange={(e) => { setSide(e.target.value); setPartyId(''); }}>
            <option value="credit">Customer</option><option value="debit">Supplier</option>
          </select>
        </div>
        <div className="col-md-6">
          <select aria-label="Party" className="form-select form-select-sm" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">Choose...</option>
            {parties.filter((p) => !p._pendingSync).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
      {data && (
        <div data-testid="statement">
          <AsOf info={data} />
          <div className="row g-2 mb-3">
            {[[side === 'credit' ? 'They owe' : 'We owe', data.owed], ['Credit held', data.credit], ['Balance', data.balance]].map(([l, v]) => (
              <div className="col-4" key={l}><div className="border rounded p-2"><div className="small text-body-secondary">{l}</div><div className="fs-5">{formatCurrency(v)}</div></div></div>
            ))}
          </div>
          <table className="table table-sm">
            <thead><tr><th>Date</th><th>Number</th><th>Status</th><th className="text-end">Total</th><th className="text-end">Paid</th><th className="text-end">Outstanding</th></tr></thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}><td>{new Date(l.date).toLocaleDateString()}</td><td>{l.number}</td><td>{l.queued ? <span className="badge text-bg-warning">Not synced</span> : l.status}</td><td className="text-end">{formatCurrency(l.total)}</td><td className="text-end">{formatCurrency(l.paid)}</td><td className="text-end">{formatCurrency(l.outstanding)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Summary({ tenantId }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const data = useView(tenantId, (t) => getSalesSummary(t, { from: from || undefined, to: to || undefined }), [from, to]);
  return (
    <>
      <div className="row g-2 mb-2">
        <div className="col-md-3"><input aria-label="From" type="date" className="form-control form-control-sm" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="col-md-3"><input aria-label="To" type="date" className="form-control form-control-sm" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {data && (
        <div data-testid="summary">
          <AsOf info={data} />
          <div className="row g-2 mb-3">
            <div className="col-md-4"><div className="border rounded p-2"><div className="small text-body-secondary">Accepted by the server ({data.accepted.count})</div><div className="fs-5">{formatCurrency(data.accepted.total)}</div></div></div>
            <div className="col-md-4"><div className="border rounded p-2"><div className="small text-body-secondary">Still on this terminal ({data.queued.count})</div><div className="fs-5">{formatCurrency(data.queued.total)}</div></div></div>
          </div>
          <table className="table table-sm">
            <thead><tr><th>Day</th><th className="text-end">Sales</th></tr></thead>
            <tbody>{data.byDay.map((d) => <tr key={d.date}><td>{d.date}</td><td className="text-end">{formatCurrency(d.total)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Aging({ tenantId }) {
  const [side, setSide] = useState('credit');
  const data = useView(tenantId, (t) => getAging(t, side), [side]);
  return (
    <>
      <select aria-label="Aging of" className="form-select form-select-sm mb-2" style={{ maxWidth: 260 }} value={side} onChange={(e) => setSide(e.target.value)}>
        <option value="credit">Customers owe us</option><option value="debit">We owe suppliers</option>
      </select>
      {data && (
        <div data-testid="aging">
          <AsOf info={data} />
          <div className="row g-2 mb-3">
            {data.buckets.map((b) => <div className="col-6 col-md-3" key={b.label}><div className="border rounded p-2"><div className="small text-body-secondary">{b.label} days ({b.count})</div><div className="fs-5">{formatCurrency(b.total)}</div></div></div>)}
          </div>
          <table className="table table-sm">
            <thead><tr><th>Party</th><th className="text-end">Open</th></tr></thead>
            <tbody>{data.parties.map((p) => <tr key={p.partyId || 'none'}><td>{p.partyName}</td><td className="text-end">{formatCurrency(p.total)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function OfflineHistory() {
  const { user, hasPermission } = useAuth();
  const tenantId = user?.tenantId;
  const tabs = TABS.filter((t) => t.any.some(hasPermission));
  const [tab, setTab] = useState(null);
  const active = tab && tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;
  if (!tabs.length) return <div className="alert alert-warning">Your role cannot view history.</div>;
  return (
    <div>
      <h4 className="mb-1">History &amp; Statements</h4>
      <p className="text-body-secondary small">Works without a connection, from this device&apos;s copy of recent records.</p>
      <ul className="nav nav-tabs mb-3" role="tablist">
        {tabs.map((t) => <li className="nav-item" key={t.key}><button role="tab" aria-selected={active === t.key} className={`nav-link ${active === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button></li>)}
      </ul>
      {active === 'sales' && <HistoryTable tenantId={tenantId} kind="sale" />}
      {active === 'purchases' && <HistoryTable tenantId={tenantId} kind="purchase" />}
      {active === 'statement' && <Statement tenantId={tenantId} />}
      {active === 'summary' && <Summary tenantId={tenantId} />}
      {active === 'aging' && <Aging tenantId={tenantId} />}
    </div>
  );
}
