// Phase 1.14: Customer Quotations - a NEW page (no prior Quotation UI
// existed anywhere in the frontend). Online-only (see this phase's
// verification report, Offline-First section, for why creating a quotation
// IS offline-capable via OUTBOXES.quotations, but its lifecycle actions and
// conversion are not).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES, refreshCaches } from '../../offline/syncEngine';
import { useLiveCustomers, useLiveProducts } from '../../offline/useOfflineData';
import { formatCurrency } from '../../utils/currency';

export default function Quotations() {
  const { user, hasPermission } = useAuth();
  const tenantId = user?.tenantId;
  const customers = useLiveCustomers(tenantId);
  const products = useLiveProducts(tenantId);
  const canCreate = hasPermission('QUOTATION:CREATE');
  const canUpdate = hasPermission('QUOTATION:UPDATE');
  const canAccept = hasPermission('QUOTATION:APPROVE');
  const canReject = hasPermission('QUOTATION:REVERSE');
  const canConvert = hasPermission('SALES_ORDER:CREATE');

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({ customerId: '', status: '', search: searchParams.get('search') || '' });

  const [showModal, setShowModal] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [lines, setLines] = useState([{ productId: '', quantity: 1, unitPrice: 0, discount: 0, tax: 0 }]);
  const [saving, setSaving] = useState(false);

  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);

  const pageSize = 20;

  function load() {
    setLoading(true);
    const params = { page, pageSize };
    if (filters.customerId) params.customerId = filters.customerId;
    if (filters.status) params.status = filters.status;
    if (filters.search) params.search = filters.search;
    apiClient
      .get('/quotations', { params })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, filters.customerId, filters.status, filters.search]);
  useEffect(() => {
    if (tenantId && navigator.onLine) {
      refreshCaches(tenantId).catch((err) => console.warn('Could not refresh offline cache:', err));
    }
  }, [tenantId]);

  function updateLine(idx, field, value) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }
  function addLine() {
    setLines((ls) => [...ls, { productId: '', quantity: 1, unitPrice: 0, discount: 0, tax: 0 }]);
  }
  function removeLine(idx) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }
  function resetForm() {
    setCustomerId('');
    setValidUntil('');
    setNotes('');
    setTerms('');
    setLines([{ productId: '', quantity: 1, unitPrice: 0, discount: 0, tax: 0 }]);
  }

  const subtotal = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unitPrice || 0), 0);
  const totalDiscount = lines.reduce((s, l) => s + Number(l.discount || 0), 0);
  const totalTax = lines.reduce((s, l) => s + Number(l.tax || 0), 0);
  const grandTotal = Math.max(subtotal - totalDiscount + totalTax, 0);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        customerId,
        items: lines.filter((l) => l.productId).map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          discount: Number(l.discount || 0),
          tax: Number(l.tax || 0),
        })),
        validUntil: validUntil ? new Date(validUntil).toISOString() : undefined,
        notes: notes || undefined,
        terms: terms || undefined,
      };
      const entry = await OUTBOXES.quotations.submit(tenantId, payload);
      if (entry.status === 'conflict' || entry.status === 'failed') {
        setError(`Could not save quotation: ${entry.lastError}`);
        return;
      }
      setShowModal(false);
      resetForm();
      if (entry.status === 'synced') {
        setPage(1);
        load();
      } else {
        setNotice("Saved on this device - will appear in the list once it's synced (you're offline).");
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(q) {
    setError('');
    try {
      const res = await apiClient.get(`/quotations/${q.id}`);
      setSelected(res.data.item);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function doAction(path, successMessage) {
    setBusy(true);
    setError('');
    try {
      const res = await apiClient.post(`/quotations/${selected.id}/${path}`);
      setNotice(successMessage);
      setSelected(res.data.item);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConvert() {
    setBusy(true);
    setError('');
    try {
      const res = await apiClient.post(`/quotations/${selected.id}/convert`);
      setNotice(`Converted to Sales Order ${res.data.item.orderNumber}.`);
      setSelected(null);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Quotations</h4>
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            + New Quotation
          </button>
        )}
      </div>

      <div className="row g-2 mb-3">
        <div className="col-auto">
          <select className="form-select form-select-sm" value={filters.customerId} onChange={(e) => { setPage(1); setFilters({ ...filters, customerId: e.target.value }); }}>
            <option value="">All Customers</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="col-auto">
          <select className="form-select form-select-sm" value={filters.status} onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }); }}>
            <option value="">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="SENT">Sent</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="REJECTED">Rejected</option>
            <option value="EXPIRED">Expired</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="CONVERTED">Converted</option>
          </select>
        </div>
        <div className="col-auto">
          <input className="form-control form-control-sm" placeholder="Search quotation #..." value={filters.search} onChange={(e) => { setPage(1); setFilters({ ...filters, search: e.target.value }); }} />
        </div>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No quotations yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th className="text-end">Total</th>
                  <th>Sales Order</th>
                </tr>
              </thead>
              <tbody>
                {items.map((q) => (
                  <tr key={q.id} role="button" onClick={() => openDetail(q)}>
                    <td>{q.quotationNumber}</td>
                    <td>{new Date(q.quotationDate).toLocaleDateString()}</td>
                    <td>{q.customer?.name || '-'}</td>
                    <td><StatusBadge status={q.status} /></td>
                    <td className="text-end">{formatCurrency(q.total)}</td>
                    <td>{q.salesOrder?.orderNumber || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-footer">
            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </div>
        </div>
      )}

      <Modal
        show={showModal}
        title="New Quotation"
        size="lg"
        onClose={() => setShowModal(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            <button type="submit" form="quotation-form" className="btn btn-primary" disabled={saving || !customerId}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="quotation-form">
          <div className="mb-2">
            <label className="form-label">Customer</label>
            <select className="form-select" required value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select customer...</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <label className="form-label">Items</label>
          {lines.map((line, idx) => (
            <div className="row g-2 mb-2" key={idx}>
              <div className="col-3">
                <select className="form-select" value={line.productId} onChange={(e) => updateLine(idx, 'productId', e.target.value)}>
                  <option value="">Select product...</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="col-2">
                <input type="number" min="0.01" step="0.01" className="form-control" placeholder="Qty" value={line.quantity} onChange={(e) => updateLine(idx, 'quantity', e.target.value)} />
              </div>
              <div className="col-2">
                <input type="number" min="0" step="0.01" className="form-control" placeholder="Unit Price" value={line.unitPrice} onChange={(e) => updateLine(idx, 'unitPrice', e.target.value)} />
              </div>
              <div className="col-2">
                <input type="number" min="0" step="0.01" className="form-control" placeholder="Discount" value={line.discount} onChange={(e) => updateLine(idx, 'discount', e.target.value)} />
              </div>
              <div className="col-2">
                <input type="number" min="0" step="0.01" className="form-control" placeholder="Tax" value={line.tax} onChange={(e) => updateLine(idx, 'tax', e.target.value)} />
              </div>
              <div className="col-1">
                <button type="button" className="btn btn-outline-danger" onClick={() => removeLine(idx)}>&times;</button>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-outline-secondary mb-3" onClick={addLine}>+ Add Line</button>

          <div className="row g-2 mb-2">
            <div className="col-md-6">
              <label className="form-label">Valid Until</label>
              <input type="date" className="form-control" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>
          <div className="mb-2">
            <label className="form-label">Notes</label>
            <textarea className="form-control" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="mb-2">
            <label className="form-label">Terms & Conditions</label>
            <textarea className="form-control" rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} />
          </div>

          <div className="text-end mt-3">
            <div>Subtotal: {formatCurrency(subtotal)}</div>
            <div>Discount: {formatCurrency(totalDiscount)}</div>
            <div>Tax: {formatCurrency(totalTax)}</div>
            <div className="fw-bold">Grand Total: {formatCurrency(grandTotal)}</div>
          </div>
        </form>
      </Modal>

      <Modal
        show={!!selected}
        title={`Quotation ${selected?.quotationNumber || ''}`}
        onClose={() => setSelected(null)}
        footer={
          selected ? (
            <>
              {canUpdate && selected.status === 'DRAFT' && (
                <button className="btn btn-outline-primary" disabled={busy} onClick={() => doAction('send', 'Quotation sent.')}>Send</button>
              )}
              {canAccept && selected.status === 'SENT' && (
                <button className="btn btn-success" disabled={busy} onClick={() => doAction('accept', 'Quotation accepted.')}>Accept</button>
              )}
              {canReject && selected.status === 'SENT' && (
                <button className="btn btn-outline-danger" disabled={busy} onClick={() => doAction('reject', 'Quotation rejected.')}>Reject</button>
              )}
              {canReject && ['DRAFT', 'SENT'].includes(selected.status) && (
                <button className="btn btn-outline-secondary" disabled={busy} onClick={() => doAction('cancel', 'Quotation cancelled.')}>Cancel</button>
              )}
              {canConvert && selected.status === 'ACCEPTED' && (
                <button className="btn btn-primary" disabled={busy} onClick={handleConvert}>Convert to Sales Order</button>
              )}
            </>
          ) : null
        }
      >
        {selected && (
          <div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Status</span>
              <StatusBadge status={selected.status} />
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Customer</span>
              <span>{selected.customer?.name}</span>
            </div>
            {selected.validUntil && (
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Valid Until</span>
                <span>{new Date(selected.validUntil).toLocaleDateString()}</span>
              </div>
            )}
            <table className="table table-sm mt-2">
              <thead>
                <tr><th>Item</th><th className="text-end">Qty</th><th className="text-end">Price</th><th className="text-end">Line Total</th></tr>
              </thead>
              <tbody>
                {selected.items?.map((l) => (
                  <tr key={l.id}>
                    <td>{l.product?.name || l.productId}</td>
                    <td className="text-end">{Number(l.quantity)}</td>
                    <td className="text-end">{formatCurrency(l.unitPrice)}</td>
                    <td className="text-end">{formatCurrency(l.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="d-flex justify-content-between fw-bold">
              <span>Total</span>
              <span>{formatCurrency(selected.total)}</span>
            </div>
            {selected.salesOrder?.orderNumber && (
              <div className="alert alert-secondary mt-3 py-2 small mb-0">
                Converted to Sales Order {selected.salesOrder.orderNumber}.
              </div>
            )}
            {selected.terms && <div className="mt-2"><div className="text-body-secondary small">Terms</div><div>{selected.terms}</div></div>}
            {selected.notes && <div className="mt-2"><div className="text-body-secondary small">Notes</div><div>{selected.notes}</div></div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
