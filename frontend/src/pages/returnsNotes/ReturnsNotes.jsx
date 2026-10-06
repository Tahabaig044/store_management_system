// Phase 3.3: returns, credit/debit notes, applying a note to invoices, and refunding a note - all usable
// with no network. Each form works from the LOCAL selection lists (what can still be returned, which
// documents are open, which notes have credit left), subtracts what is already queued on this terminal,
// queues the request (idempotent, stamped with the time it really happened) and - when online - sends it
// at once. Whatever the server later refuses (another terminal used the goods or the credit first) shows
// up in the sync panel as a conflict the person can Edit and retry.
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { useAuth } from '../../context/AuthContext';
import { getOfflineDb } from '../../offline/db';
import { OUTBOXES } from '../../offline/syncEngine';
import { getReturnableSales, getReturnablePurchases, getOpenNotes, getOpenDocuments } from '../../offline/derivedViews';
import { useLiveCustomers, useLiveSuppliers } from '../../offline/useOfflineData';
import { PAYMENT_METHODS } from '../../constants/paymentMethods';
import { extractErrorMessage } from '../../components/Feedback';
import { formatCurrency } from '../../utils/currency';

// Re-reads a derived view whenever ANY local table changes (a queued entry, a download, a sync result).
function useDerived(tenantId, read, deps = []) {
  const [value, setValue] = useState([]);
  useEffect(() => {
    if (!tenantId) return undefined;
    const sub = liveQuery(() => read(tenantId)).subscribe({ next: setValue, error: () => {} });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, ...deps]);
  return value;
}

const TABS = [
  { key: 'salesReturn', label: 'Sales return', permission: 'SALES_RETURN:CREATE' },
  { key: 'purchaseReturn', label: 'Purchase return', permission: 'PURCHASE_RETURN:CREATE' },
  { key: 'note', label: 'Credit / debit note', permission: ['CREDIT_NOTE:CREATE', 'DEBIT_NOTE:CREATE'] },
  { key: 'apply', label: 'Apply a note', permission: 'PAYMENT:CREATE' },
  { key: 'refund', label: 'Refund a note', permission: ['CREDIT_NOTE:REFUND', 'DEBIT_NOTE:REFUND'] },
];

function Result({ result }) {
  if (!result) return null;
  const cls = result.kind === 'error' ? 'danger' : result.kind === 'queued' ? 'warning' : 'success';
  return <div className={`alert alert-${cls} py-2 small`} role="status" data-testid="submit-result">{result.message}</div>;
}

// What the person is told after queueing: synced now, waiting for the network, or refused by the server.
function describeSubmit(entry, what) {
  if (entry.status === 'synced') return { kind: 'ok', message: `${what} recorded.` };
  if (entry.status === 'conflict' || entry.status === 'failed') return { kind: 'error', message: `${what} was refused: ${entry.failure?.message || 'see the sync panel'}. Open the sync panel to edit and retry it.` };
  return { kind: 'queued', message: `${what} saved on this device and will be sent when the connection is back.` };
}

// ---------------------------------------------------------------------------------------------
function ReturnForm({ tenantId, kind }) {
  const sale = kind === 'sale';
  const docs = useDerived(tenantId, sale ? getReturnableSales : getReturnablePurchases);
  const [docId, setDocId] = useState('');
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const doc = docs.find((d) => d.id === docId);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const items = doc.items.filter((i) => Number(qty[i.id]) > 0).map((i) => ({ [sale ? 'saleItemId' : 'purchaseItemId']: i.id, quantity: Number(qty[i.id]) }));
      if (!items.length) throw new Error('Enter a quantity to return.');
      const display = { products: Object.fromEntries(doc.items.map((i) => [i.id, i.productId])), warehouseId: doc.warehouseId, lines: Object.fromEntries(doc.items.map((i) => [i.id, i.name])), documentNumber: sale ? doc.invoiceNumber : doc.purchaseNumber };
      const outbox = sale ? OUTBOXES.salesReturns : OUTBOXES.purchaseReturns;
      const payload = { [sale ? 'saleId' : 'purchaseId']: doc.id, items, ...(reason ? { reason } : {}), ...(sale && !doc.customerId ? { refundMethod } : {}), _display: display };
      const entry = await outbox.submit(tenantId, payload);
      setResult(describeSubmit(entry, 'The return'));
      if (entry.status !== 'conflict' && entry.status !== 'failed') { setDocId(''); setQty({}); setReason(''); }
    } catch (err) {
      setResult({ kind: 'error', message: extractErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label={sale ? 'Sales return' : 'Purchase return'}>
      <div className="mb-2">
        <label className="form-label small mb-1" htmlFor="return-doc">{sale ? 'Sale' : 'Purchase'}</label>
        <select id="return-doc" className="form-select form-select-sm" value={docId} onChange={(e) => { setDocId(e.target.value); setQty({}); }}>
          <option value="">Choose...</option>
          {docs.map((d) => <option key={d.id} value={d.id}>{sale ? d.invoiceNumber : d.purchaseNumber} - {(sale ? d.customerName : d.supplierName) || (sale ? 'Walk-in' : '')} - {formatCurrency(d.total)}</option>)}
        </select>
        {docs.length === 0 && <div className="form-text">Nothing on this device can be returned. Connect once to download recent {sale ? 'sales' : 'purchases'}.</div>}
      </div>
      {doc && (
        <>
          <table className="table table-sm align-middle">
            <thead><tr><th>Item</th><th>Sold</th><th>Can return</th><th style={{ width: 120 }}>Return</th></tr></thead>
            <tbody>
              {doc.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td>{i.quantity}</td>
                  <td>{i.remaining}{i.queuedQuantity > 0 && <span className="text-body-secondary"> ({i.queuedQuantity} queued)</span>}</td>
                  <td><input aria-label={`Return ${i.name}`} type="number" min="0" step="any" className="form-control form-control-sm" disabled={i.remaining <= 0} value={qty[i.id] ?? ''} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row g-2 mb-2">
            <div className="col-md-6"><input className="form-control form-control-sm" placeholder="Reason" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            {sale && !doc.customerId && (
              <div className="col-md-6">
                <select aria-label="Refund method" className="form-select form-select-sm" value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                  {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>Refund by {m.label}</option>)}
                </select>
              </div>
            )}
          </div>
        </>
      )}
      <Result result={result} />
      <button className="btn btn-primary btn-sm" disabled={!doc || busy}>{busy ? 'Saving...' : 'Record return'}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
function NoteForm({ tenantId, can }) {
  const customers = useLiveCustomers(tenantId);
  const suppliers = useLiveSuppliers(tenantId);
  const [side, setSide] = useState(can('CREDIT_NOTE:CREATE') ? 'credit' : 'debit');
  const [party, setParty] = useState('');
  const [amount, setAmount] = useState('');
  const [tax, setTax] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const parties = side === 'credit' ? customers : suppliers;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const partyRow = parties.find((p) => p.id === party);
      const payload = { [side === 'credit' ? 'customerId' : 'supplierId']: party, amount: Number(amount), ...(tax ? { tax: Number(tax) } : {}), reason, _display: { partyName: partyRow?.name } };
      const entry = await (side === 'credit' ? OUTBOXES.creditNotes : OUTBOXES.debitNotes).submit(tenantId, payload);
      setResult(describeSubmit(entry, `The ${side} note`));
      if (entry.status !== 'conflict' && entry.status !== 'failed') { setAmount(''); setTax(''); setReason(''); }
    } catch (err) {
      setResult({ kind: 'error', message: extractErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Credit or debit note">
      <div className="row g-2 mb-2">
        <div className="col-md-4">
          <select aria-label="Note type" className="form-select form-select-sm" value={side} onChange={(e) => { setSide(e.target.value); setParty(''); }}>
            {can('CREDIT_NOTE:CREATE') && <option value="credit">Credit note (to a customer)</option>}
            {can('DEBIT_NOTE:CREATE') && <option value="debit">Debit note (to a supplier)</option>}
          </select>
        </div>
        <div className="col-md-8">
          <select aria-label={side === 'credit' ? 'Customer' : 'Supplier'} className="form-select form-select-sm" value={party} onChange={(e) => setParty(e.target.value)}>
            <option value="">Choose {side === 'credit' ? 'customer' : 'supplier'}...</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}{p._pendingSync ? ' (not synced yet)' : ''}</option>)}
          </select>
        </div>
        <div className="col-md-4"><input aria-label="Amount" type="number" min="0" step="any" className="form-control form-control-sm" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="col-md-4"><input aria-label="Tax" type="number" min="0" step="any" className="form-control form-control-sm" placeholder="Tax (optional)" value={tax} onChange={(e) => setTax(e.target.value)} /></div>
        <div className="col-md-4"><input aria-label="Reason" className="form-control form-control-sm" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <Result result={result} />
      <button className="btn btn-primary btn-sm" disabled={!party || busy}>{busy ? 'Saving...' : 'Issue note'}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
function NotePicker({ tenantId, sideOptions, children }) {
  const [side, setSide] = useState(sideOptions[0]);
  const notes = useDerived(tenantId, (t) => getOpenNotes(t, side), [side]);
  const [noteId, setNoteId] = useState('');
  const note = notes.find((n) => n.id === noteId);
  return (
    <>
      <div className="row g-2 mb-2">
        <div className="col-md-4">
          <select aria-label="Note type" className="form-select form-select-sm" value={side} onChange={(e) => { setSide(e.target.value); setNoteId(''); }}>
            {sideOptions.includes('credit') && <option value="credit">Credit note</option>}
            {sideOptions.includes('debit') && <option value="debit">Debit note</option>}
          </select>
        </div>
        <div className="col-md-8">
          <select aria-label="Note" className="form-select form-select-sm" value={noteId} onChange={(e) => setNoteId(e.target.value)}>
            <option value="">Choose a note with credit left...</option>
            {notes.map((n) => <option key={n.id} value={n.id}>{n.number} - {n.partyName || ''} - {formatCurrency(n.available)} left</option>)}
          </select>
        </div>
      </div>
      {children({ side, note })}
    </>
  );
}

function ApplyForm({ tenantId, side, note }) {
  const docs = useDerived(tenantId, (t) => getOpenDocuments(t, side), [side]);
  const [amounts, setAmounts] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const open = docs.filter((d) => note && d.partyId === note.partyId);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const allocations = open.filter((d) => Number(amounts[d.id]) > 0).map((d) => ({ documentId: d.id, amount: Number(amounts[d.id]) }));
      if (!allocations.length) throw new Error('Enter an amount for at least one document.');
      const display = { noteNumber: note.number, documents: Object.fromEntries(open.map((d) => [d.id, d.number])) };
      const entry = await (side === 'credit' ? OUTBOXES.creditApplications : OUTBOXES.debitApplications).submit(tenantId, { noteId: note.id, allocations, _display: display });
      setResult(describeSubmit(entry, 'The application'));
      if (entry.status !== 'conflict' && entry.status !== 'failed') setAmounts({});
    } catch (err) {
      setResult({ kind: 'error', message: extractErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!note) return <div className="text-body-secondary small">Choose a note to see the open {side === 'credit' ? 'invoices' : 'purchases'} it can settle.</div>;
  return (
    <form onSubmit={submit} aria-label="Apply a note">
      <table className="table table-sm align-middle">
        <thead><tr><th>{side === 'credit' ? 'Invoice' : 'Purchase'}</th><th>Owed</th><th style={{ width: 130 }}>Apply</th></tr></thead>
        <tbody>
          {open.map((d) => (
            <tr key={d.id}>
              <td>{d.number}</td>
              <td>{formatCurrency(d.balance)}</td>
              <td><input aria-label={`Apply to ${d.number}`} type="number" min="0" step="any" className="form-control form-control-sm" value={amounts[d.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [d.id]: e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {open.length === 0 && <div className="text-body-secondary small mb-2">This party has nothing open on this device.</div>}
      <Result result={result} />
      <button className="btn btn-primary btn-sm" disabled={busy || open.length === 0}>{busy ? 'Saving...' : 'Apply note'}</button>
    </form>
  );
}

function RefundForm({ tenantId, side, note }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const entry = await (side === 'credit' ? OUTBOXES.creditRefunds : OUTBOXES.debitRefunds).submit(tenantId, { noteId: note.id, amount: Number(amount), method, _display: { noteNumber: note.number } });
      setResult(describeSubmit(entry, 'The refund'));
      if (entry.status !== 'conflict' && entry.status !== 'failed') setAmount('');
    } catch (err) {
      setResult({ kind: 'error', message: extractErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!note) return <div className="text-body-secondary small">Choose a note to refund.</div>;
  return (
    <form onSubmit={submit} aria-label="Refund a note">
      <div className="row g-2 mb-2">
        <div className="col-md-6"><input aria-label="Refund amount" type="number" min="0" step="any" className="form-control form-control-sm" placeholder={`Up to ${note.available}`} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="col-md-6">
          <select aria-label="Refund method" className="form-select form-select-sm" value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      </div>
      <Result result={result} />
      <button className="btn btn-primary btn-sm" disabled={busy || !amount}>{busy ? 'Saving...' : 'Refund'}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
export default function ReturnsNotes() {
  const { user, hasPermission } = useAuth();
  const tenantId = user?.tenantId;
  const can = (p) => (Array.isArray(p) ? p.some(hasPermission) : hasPermission(p));
  const tabs = TABS.filter((t) => can(t.permission));
  const [tab, setTab] = useState(null);
  const active = tab && tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;

  // Make sure the local database exists even if nothing else has opened it yet.
  useEffect(() => { if (tenantId) getOfflineDb(tenantId); }, [tenantId]);

  if (!tabs.length) return <div className="alert alert-warning">Your role cannot record returns or notes.</div>;
  const sideOptions = (a, b) => [a && 'credit', b && 'debit'].filter(Boolean);

  return (
    <div>
      <h4 className="mb-1">Returns &amp; Notes</h4>
      <p className="text-body-secondary small">Works without a connection: what you record here is saved on this device and sent when the connection is back. If another terminal used the same goods or credit first, the entry is kept and shown in the sync panel so you can edit and retry it.</p>
      <ul className="nav nav-tabs mb-3" role="tablist">
        {tabs.map((t) => (
          <li className="nav-item" key={t.key}><button role="tab" aria-selected={active === t.key} className={`nav-link ${active === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button></li>
        ))}
      </ul>
      {active === 'salesReturn' && <ReturnForm tenantId={tenantId} kind="sale" />}
      {active === 'purchaseReturn' && <ReturnForm tenantId={tenantId} kind="purchase" />}
      {active === 'note' && <NoteForm tenantId={tenantId} can={can} />}
      {active === 'apply' && <NotePicker tenantId={tenantId} sideOptions={['credit', 'debit']}>{(p) => <ApplyForm key={p.side + (p.note?.id || '')} tenantId={tenantId} {...p} />}</NotePicker>}
      {active === 'refund' && <NotePicker tenantId={tenantId} sideOptions={sideOptions(can('CREDIT_NOTE:REFUND'), can('DEBIT_NOTE:REFUND'))}>{(p) => <RefundForm key={p.side + (p.note?.id || '')} tenantId={tenantId} {...p} />}</NotePicker>}
    </div>
  );
}
