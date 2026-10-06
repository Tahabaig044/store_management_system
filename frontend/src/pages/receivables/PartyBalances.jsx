// Phase 2.2: Receivables (customers) and Payables (suppliers) - one page
// component driven by `side` ('AR' | 'AP'). Outstanding balances, aging, and a
// per-party panel with outstanding documents, payment/credit-note allocation,
// the statement, and payment detail. Payments themselves are still recorded
// through the existing /payments API (Phase 1.11); nothing here is a second
// payment system.
import { useEffect, useRef, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency } from '../../utils/currency';
import { PAYMENT_METHODS } from '../../constants/paymentMethods';

const SIDES = {
  AR: { base: '/receivables', plural: 'customers', title: 'Receivables', party: 'Customer', doc: 'Invoice', note: 'Credit note', direction: 'IN', partyKey: 'customerId', docKey: 'saleId', payLabel: 'Record customer payment' },
  AP: { base: '/payables', plural: 'suppliers', title: 'Payables', party: 'Supplier', doc: 'Purchase', note: 'Debit note', direction: 'OUT', partyKey: 'supplierId', docKey: 'purchaseId', payLabel: 'Record supplier payment' },
};

const TYPE_LABELS = {
  INVOICE: 'Invoice', INVOICE_REVERSAL: 'Invoice reversed', PURCHASE: 'Purchase', PURCHASE_RETURN: 'Purchase returned',
  PAYMENT: 'Payment', PAYMENT_REVERSAL: 'Payment reversed', CREDIT_NOTE: 'Credit note', CREDIT_NOTE_CANCELLED: 'Credit note cancelled',
  DEBIT_NOTE: 'Debit note', DEBIT_NOTE_CANCELLED: 'Debit note cancelled', CREDIT_REFUND: 'Credit refunded', DEBIT_REFUND: 'Debit refunded',
  SETTLEMENT_RETURNED: 'Settlement returned', LEDGER_ADJUSTMENT: 'Ledger adjustment',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '');
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export default function PartyBalances({ side }) {
  const cfg = SIDES[side];
  const [tab, setTab] = useState('outstanding');
  const [summary, setSummary] = useState(null);
  const [search, setSearch] = useState('');
  const [aging, setAging] = useState(null);
  const [buckets, setBuckets] = useState('30,60,90');
  const [asOf, setAsOf] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [party, setParty] = useState(null);

  function loadSummary() {
    setLoading(true);
    setError('');
    apiClient
      .get(`${cfg.base}/summary`, { params: search ? { search } : {} })
      .then((res) => setSummary(res.data))
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }
  function loadAging() {
    setLoading(true);
    setError('');
    const params = { buckets };
    if (asOf) params.asOf = new Date(`${asOf}T23:59:59`).toISOString();
    apiClient
      .get(`${cfg.base}/aging`, { params })
      .then((res) => setAging(res.data))
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'outstanding') loadSummary(); else loadAging(); }, [tab, side]);

  return (
    <div>
      <h4 className="mb-3">{cfg.title}</h4>
      <ul className="nav nav-tabs mb-3">
        <li className="nav-item"><button className={`nav-link ${tab === 'outstanding' ? 'active' : ''}`} onClick={() => setTab('outstanding')}>Outstanding</button></li>
        <li className="nav-item"><button className={`nav-link ${tab === 'aging' ? 'active' : ''}`} onClick={() => setTab('aging')}>Aging</button></li>
      </ul>
      <ErrorAlert message={error} />

      {tab === 'outstanding' && (
        <>
          <form className="d-flex gap-2 mb-3" onSubmit={(e) => { e.preventDefault(); loadSummary(); }}>
            <input className="form-control" style={{ maxWidth: 280 }} placeholder={`Search ${cfg.plural}`} value={search} onChange={(e) => setSearch(e.target.value)} />
            <button className="btn btn-outline-secondary" type="submit">Search</button>
          </form>
          {loading ? <Spinner /> : !summary?.items.length ? <EmptyState message="Nothing outstanding." /> : (
            <div className="card"><div className="table-responsive"><table className="table table-hover mb-0">
              <thead><tr><th>{cfg.party}</th><th className="text-end">Open documents</th><th className="text-end">Due</th><th className="text-end">Available credit</th><th className="text-end">Net outstanding</th></tr></thead>
              <tbody>
                {summary.items.map((r) => (
                  <tr key={r.partyId || 'none'} role="button" onClick={() => r.partyId && setParty({ id: r.partyId, name: r.partyName })}>
                    <td>{r.partyName}</td>
                    <td className="text-end">{r.openDocuments}</td>
                    <td className="text-end">{formatCurrency(r.documentsDue)}</td>
                    <td className="text-end">{formatCurrency(r.availableCredit)}</td>
                    <td className="text-end fw-semibold">{formatCurrency(r.netOutstanding)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="fw-semibold"><td>Total</td><td /><td className="text-end">{formatCurrency(summary.totals.documentsDue)}</td><td className="text-end">{formatCurrency(summary.totals.availableCredit)}</td><td className="text-end">{formatCurrency(summary.totals.netOutstanding)}</td></tr></tfoot>
            </table></div>
            <div className="card-footer small text-body-secondary">
              Ledger control account: {formatCurrency(summary.totals.glControlBalance)}
              {Math.abs(summary.totals.reconciliationDifference) > 0.005 && (
                <span className="text-warning-emphasis" role="status"> - differs from the documents above by {formatCurrency(summary.totals.reconciliationDifference)} (opening balances, manual entries or transactions outside this view).</span>
              )}
            </div></div>
          )}
        </>
      )}

      {tab === 'aging' && (
        <>
          <form className="row g-2 align-items-end mb-3" onSubmit={(e) => { e.preventDefault(); loadAging(); }}>
            <div className="col-auto"><label className="form-label mb-0 small" htmlFor="ag-buckets">Buckets (days)</label><input id="ag-buckets" className="form-control" value={buckets} onChange={(e) => setBuckets(e.target.value)} /></div>
            <div className="col-auto"><label className="form-label mb-0 small" htmlFor="ag-asof">As of</label><input id="ag-asof" type="date" className="form-control" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
            <div className="col-auto"><button className="btn btn-outline-secondary" type="submit">Refresh</button></div>
          </form>
          {loading ? <Spinner /> : !aging?.items.length ? <EmptyState message="Nothing outstanding." /> : (
            <div className="card"><div className="table-responsive"><table className="table mb-0">
              <thead><tr><th>{cfg.party}</th>{aging.buckets.map((b) => <th key={b} className="text-end">{b}</th>)}<th className="text-end">Total</th><th className="text-end">Credit</th><th className="text-end">Net</th></tr></thead>
              <tbody>
                {aging.items.map((r) => (
                  <tr key={r.partyId || 'none'}>
                    <td>{r.partyName}</td>
                    {aging.buckets.map((b) => <td key={b} className="text-end">{formatCurrency(r.buckets[b])}</td>)}
                    <td className="text-end">{formatCurrency(r.total)}</td><td className="text-end">{formatCurrency(r.availableCredit)}</td><td className="text-end fw-semibold">{formatCurrency(r.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="fw-semibold"><td>Total</td>{aging.buckets.map((b) => <td key={b} className="text-end">{formatCurrency(aging.totals[b])}</td>)}<td className="text-end">{formatCurrency(aging.total)}</td><td className="text-end">{formatCurrency(aging.availableCredit)}</td><td className="text-end">{formatCurrency(aging.net)}</td></tr></tfoot>
            </table></div></div>
          )}
        </>
      )}

      {party && <PartyPanel cfg={cfg} party={party} onClose={() => { setParty(null); loadSummary(); }} />}
    </div>
  );
}

function PartyPanel({ cfg, party, onClose }) {
  const { hasPermission } = useAuth();
  const canPay = hasPermission('PAYMENT:CREATE');
  const [tab, setTab] = useState('documents');
  const [data, setData] = useState(null);
  const [statement, setStatement] = useState(null);
  const [range, setRange] = useState({ from: '', to: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [alloc, setAlloc] = useState({}); // documentId -> amount string (present = selected)
  const [method, setMethod] = useState('cash');
  const [noteId, setNoteId] = useState('');
  const [paymentDetail, setPaymentDetail] = useState(null);
  // One key per intended operation: a retry of the same click re-sends the same
  // key (safe), and it is renewed only after the operation succeeds.
  const paymentKey = useRef(newKey());
  const applyKey = useRef(newKey());

  function loadAll() {
    const params = {};
    if (range.from) params.from = range.from;
    if (range.to) params.to = new Date(`${range.to}T23:59:59`).toISOString();
    Promise.all([
      apiClient.get(`${cfg.base}/${cfg.plural}/${party.id}/outstanding`),
      apiClient.get(`${cfg.base}/${cfg.plural}/${party.id}/statement`, { params }),
    ])
      .then(([o, s]) => { setData(o.data); setStatement(s.data); })
      .catch((err) => setError(extractErrorMessage(err)));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadAll, []);

  const selected = Object.entries(alloc).map(([documentId, amount]) => ({ documentId, amount: round2(amount) }));
  const allocTotal = round2(selected.reduce((s, a) => s + (a.amount || 0), 0));
  const allocValid = selected.length > 0 && selected.every((a) => a.amount > 0 && a.amount <= (data?.documents.find((d) => d.id === a.documentId)?.balance ?? 0) + 0.005);
  const chosenNote = data?.notes.find((n) => n.id === noteId);

  function toggle(doc) {
    setAlloc((prev) => {
      const next = { ...prev };
      if (next[doc.id] !== undefined) delete next[doc.id];
      else next[doc.id] = String(doc.balance);
      return next;
    });
  }

  async function run(fn, done) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setNotice(done);
      setAlloc({});
      loadAll();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const recordPayment = () =>
    run(async () => {
      await apiClient.post('/payments', {
        direction: cfg.direction,
        [cfg.partyKey]: party.id,
        amount: allocTotal,
        method,
        allocations: selected.map((a) => ({ [cfg.docKey]: a.documentId, amount: a.amount })),
        idempotencyKey: paymentKey.current,
      });
      paymentKey.current = newKey();
    }, 'Payment recorded.');

  const applyNote = () =>
    run(async () => {
      await apiClient.post(`${cfg.base}/note-applications`, { noteId, allocations: selected, idempotencyKey: applyKey.current });
      applyKey.current = newKey();
    }, `${cfg.note} applied.`);

  function openPayment(paymentId) {
    apiClient.get(`/payments/${paymentId}`).then((res) => setPaymentDetail(res.data.item)).catch((err) => setError(extractErrorMessage(err)));
  }

  const reversePayment = () =>
    run(async () => {
      await apiClient.post(`/payments/${paymentDetail.id}/reverse`);
      setPaymentDetail(null);
    }, 'Payment reversed.');

  return (
    <Modal show title={`${party.name} - ${cfg.title}`} onClose={onClose} size="xl">
      <ErrorAlert message={error} />
      {notice && <div className="alert alert-info py-2">{notice}</div>}
      {!data || !statement ? <Spinner /> : (
        <>
          <div className="row g-2 mb-3">
            <div className="col"><div className="border rounded p-2"><div className="small text-body-secondary">Documents due</div><div className="fw-semibold">{formatCurrency(data.documentsDue)}</div></div></div>
            <div className="col"><div className="border rounded p-2"><div className="small text-body-secondary">Available credit</div><div className="fw-semibold">{formatCurrency(data.availableCredit)}</div></div></div>
            <div className="col"><div className="border rounded p-2"><div className="small text-body-secondary">Net outstanding</div><div className="fw-semibold">{formatCurrency(data.netOutstanding)}</div></div></div>
            <div className="col"><div className="border rounded p-2"><div className="small text-body-secondary">Ledger balance</div><div className="fw-semibold">{formatCurrency(data.glBalance)}</div></div></div>
          </div>
          <ul className="nav nav-pills mb-3">
            <li className="nav-item"><button className={`nav-link ${tab === 'documents' ? 'active' : ''}`} onClick={() => setTab('documents')}>Outstanding documents</button></li>
            <li className="nav-item"><button className={`nav-link ${tab === 'statement' ? 'active' : ''}`} onClick={() => setTab('statement')}>Statement</button></li>
          </ul>

          {tab === 'documents' && (
            <>
              {data.documents.length === 0 ? <EmptyState message={`No outstanding ${cfg.doc.toLowerCase()}s.`} /> : (
                <table className="table table-sm">
                  <thead><tr>{canPay && <th />}<th>{cfg.doc}</th><th>Date</th><th className="text-end">Total</th><th className="text-end">Balance</th><th className="text-end">Age (days)</th>{canPay && <th className="text-end" style={{ width: 140 }}>Allocate</th>}</tr></thead>
                  <tbody>
                    {data.documents.map((d) => (
                      <tr key={d.id}>
                        {canPay && <td><input type="checkbox" aria-label={`Select ${d.number}`} checked={alloc[d.id] !== undefined} onChange={() => toggle(d)} /></td>}
                        <td>{d.number}</td><td>{fmtDate(d.date)}</td>
                        <td className="text-end">{formatCurrency(d.total)}</td><td className="text-end">{formatCurrency(d.balance)}</td><td className="text-end">{d.ageDays}</td>
                        {canPay && <td>{alloc[d.id] !== undefined && <input type="number" min="0" step="0.01" className="form-control form-control-sm text-end" aria-label={`Amount for ${d.number}`} value={alloc[d.id]} onChange={(e) => setAlloc((p) => ({ ...p, [d.id]: e.target.value }))} />}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {canPay && data.documents.length > 0 && (
                <div className="border rounded p-3 mb-3">
                  <div className="d-flex flex-wrap gap-3 align-items-end">
                    <div><div className="small text-body-secondary">Selected total</div><div className="fw-semibold" data-testid="alloc-total">{formatCurrency(allocTotal)}</div></div>
                    <div>
                      <label className="form-label mb-0 small" htmlFor="pay-method">Method</label>
                      <select id="pay-method" className="form-select form-select-sm" value={method} onChange={(e) => setMethod(e.target.value)}>
                        {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                    <button className="btn btn-primary" disabled={busy || !allocValid} onClick={recordPayment}>{cfg.payLabel}</button>
                    {data.notes.length > 0 && (
                      <>
                        <div>
                          <label className="form-label mb-0 small" htmlFor="note-pick">{cfg.note}</label>
                          <select id="note-pick" className="form-select form-select-sm" value={noteId} onChange={(e) => setNoteId(e.target.value)}>
                            <option value="">Select...</option>
                            {data.notes.map((n) => <option key={n.id} value={n.id}>{n.number} - {formatCurrency(n.available)} available</option>)}
                          </select>
                        </div>
                        <button className="btn btn-outline-primary" disabled={busy || !allocValid || !chosenNote || allocTotal > chosenNote.available + 0.005} onClick={applyNote}>Apply {cfg.note.toLowerCase()}</button>
                      </>
                    )}
                  </div>
                  {chosenNote && allocTotal > chosenNote.available + 0.005 && <div className="small text-danger mt-2" role="alert">The selected amount exceeds the credit available on this note.</div>}
                </div>
              )}

              {data.notes.length > 0 && (
                <>
                  <h6>Available {cfg.note.toLowerCase()}s</h6>
                  <table className="table table-sm"><thead><tr><th>Number</th><th>Date</th><th>Reason</th><th className="text-end">Amount</th><th className="text-end">Available</th></tr></thead>
                    <tbody>{data.notes.map((n) => <tr key={n.id}><td>{n.number}</td><td>{fmtDate(n.date)}</td><td>{n.reason}</td><td className="text-end">{formatCurrency(n.amount)}</td><td className="text-end">{formatCurrency(n.available)}</td></tr>)}</tbody></table>
                </>
              )}
            </>
          )}

          {tab === 'statement' && (
            <>
              <form className="row g-2 align-items-end mb-3" onSubmit={(e) => { e.preventDefault(); loadAll(); }}>
                <div className="col-auto"><label className="form-label mb-0 small" htmlFor="st-from">From</label><input id="st-from" type="date" className="form-control form-control-sm" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
                <div className="col-auto"><label className="form-label mb-0 small" htmlFor="st-to">To</label><input id="st-to" type="date" className="form-control form-control-sm" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
                <div className="col-auto"><button className="btn btn-sm btn-outline-secondary" type="submit">Apply</button></div>
              </form>
              <table className="table table-sm">
                <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th className="text-end">Charges</th><th className="text-end">Payments / credits</th><th className="text-end">Balance</th></tr></thead>
                <tbody>
                  <tr className="table-light"><td colSpan={5}>Opening balance</td><td className="text-end">{formatCurrency(statement.openingBalance)}</td></tr>
                  {statement.rows.map((r, i) => (
                    <tr key={`${r.sourceId}-${r.type}-${i}`} role={r.sourceType === 'PAYMENT' ? 'button' : undefined} onClick={r.sourceType === 'PAYMENT' ? () => openPayment(r.sourceId) : undefined}>
                      <td>{fmtDate(r.date)}</td><td>{TYPE_LABELS[r.type] || r.type}</td><td>{r.reference}</td>
                      <td className="text-end">{r.increase ? formatCurrency(r.increase) : ''}</td><td className="text-end">{r.decrease ? formatCurrency(r.decrease) : ''}</td><td className="text-end">{formatCurrency(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="fw-semibold"><td colSpan={3}>Closing balance</td><td className="text-end">{formatCurrency(statement.totalIncrease)}</td><td className="text-end">{formatCurrency(statement.totalDecrease)}</td><td className="text-end">{formatCurrency(statement.closingBalance)}</td></tr></tfoot>
              </table>
              {Math.abs(statement.currentBalance - statement.glBalance) > 0.005 && (
                <div className="small text-warning-emphasis" role="status">The ledger shows {formatCurrency(statement.glBalance)} for this {cfg.party.toLowerCase()} - the difference is from entries outside this statement (for example optical orders).</div>
              )}
            </>
          )}
        </>
      )}

      <PaymentDetail payment={paymentDetail} onClose={() => setPaymentDetail(null)} onReverse={reversePayment} busy={busy} />
    </Modal>
  );
}

function PaymentDetail({ payment, onClose, onReverse, busy }) {
  const { hasPermission } = useAuth();
  if (!payment) return null;
  const canReverse = hasPermission('PAYMENT:REVERSE') && payment.status === 'COMPLETED' && payment.allocations?.length > 0;
  return (
    <Modal show title={`Payment ${payment.receiptNumber || ''}`} onClose={onClose} footer={canReverse && <button className="btn btn-outline-danger" disabled={busy} onClick={onReverse}>Reverse payment</button>}>
      <dl className="row mb-2">
        <dt className="col-4">Status</dt><dd className="col-8">{payment.status}</dd>
        <dt className="col-4">Amount</dt><dd className="col-8">{formatCurrency(payment.amount)}</dd>
        <dt className="col-4">Method</dt><dd className="col-8">{payment.method}</dd>
        <dt className="col-4">Date</dt><dd className="col-8">{fmtDate(payment.paidAt)}</dd>
      </dl>
      {payment.allocations?.length > 0 ? (
        <table className="table table-sm"><thead><tr><th>Applied to</th><th className="text-end">Amount</th></tr></thead>
          <tbody>{payment.allocations.map((a) => <tr key={a.id}><td>{a.sale?.invoiceNumber || a.purchase?.purchaseNumber}</td><td className="text-end">{formatCurrency(a.amount)}</td></tr>)}</tbody></table>
      ) : <div className="small text-body-secondary">Recorded with the document itself; it can be reversed only by reversing that document.</div>}
    </Modal>
  );
}
