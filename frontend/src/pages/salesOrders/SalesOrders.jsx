// Phase 1.14: Sales Orders - a NEW page (no prior Sales Order UI existed
// anywhere in the frontend). Online-only (see this phase's verification
// report, Offline-First section) - unlike Quotation creation, Sales Order
// creation and every lifecycle/conversion action here require connectivity.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { refreshCaches } from '../../offline/syncEngine';
import { useLiveCustomers, useLiveProducts } from '../../offline/useOfflineData';
import { PAYMENT_METHODS } from '../../constants/paymentMethods';
import { formatCurrency } from '../../utils/currency';

export default function SalesOrders() {
  const { user, hasPermission } = useAuth();
  const tenantId = user?.tenantId;
  const customers = useLiveCustomers(tenantId);
  const products = useLiveProducts(tenantId);
  const canCreate = hasPermission('SALES_ORDER:CREATE');
  const canConfirm = hasPermission('SALES_ORDER:APPROVE');
  const canCancel = hasPermission('SALES_ORDER:REVERSE');
  const canFulfill = hasPermission('SALE:CREATE');

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
  const [lines, setLines] = useState([{ productId: '', quantity: 1, unitPrice: 0, discount: 0 }]);
  const [saving, setSaving] = useState(false);

  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fulfillQuantities, setFulfillQuantities] = useState({});
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');

  const pageSize = 20;

  function load() {
    setLoading(true);
    const params = { page, pageSize };
    if (filters.customerId) params.customerId = filters.customerId;
    if (filters.status) params.status = filters.status;
    if (filters.search) params.search = filters.search;
    apiClient
      .get('/sales-orders', { params })
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
    setLines((ls) => [...ls, { productId: '', quantity: 1, unitPrice: 0, discount: 0 }]);
  }
  function removeLine(idx) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/sales-orders', {
        customerId,
        items: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discount: Number(l.discount || 0) })),
      });
      setShowModal(false);
      setCustomerId('');
      setLines([{ productId: '', quantity: 1, unitPrice: 0, discount: 0 }]);
      setNotice('Sales order created.');
      setPage(1);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(o) {
    setError('');
    try {
      const res = await apiClient.get(`/sales-orders/${o.id}`);
      setSelected(res.data.item);
      const initial = {};
      for (const line of res.data.item.items) {
        initial[line.id] = 0;
      }
      setFulfillQuantities(initial);
      setPayAmount('');
      setPayMethod('cash');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setError('');
    try {
      const res = await apiClient.post(`/sales-orders/${selected.id}/confirm`);
      setNotice('Sales order confirmed.');
      setSelected(res.data.item);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm(`Cancel sales order ${selected.orderNumber}? This cannot be undone.`)) return;
    setBusy(true);
    setError('');
    try {
      await apiClient.post(`/sales-orders/${selected.id}/cancel`);
      setNotice('Sales order cancelled.');
      setSelected(null);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleFulfill() {
    setError('');
    const requestedLines = Object.entries(fulfillQuantities)
      .filter(([, qty]) => Number(qty) > 0)
      .map(([salesOrderItemId, qty]) => ({ salesOrderItemId, quantity: Number(qty) }));
    if (requestedLines.length === 0) {
      setError('Enter a quantity to fulfill for at least one item.');
      return;
    }
    setBusy(true);
    try {
      const res = await apiClient.post(`/sales-orders/${selected.id}/convert`, {
        items: requestedLines,
        amountPaid: payAmount ? Number(payAmount) : 0,
        paymentMethod: payMethod,
      });
      setNotice(`Sale ${res.data.item.invoiceNumber} created from this order.`);
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
        <h4 className="mb-0">Sales Orders</h4>
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            + New Sales Order
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
            <option value="CONFIRMED">Confirmed</option>
            <option value="PROCESSING">Processing</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <div className="col-auto">
          <input className="form-control form-control-sm" placeholder="Search order #..." value={filters.search} onChange={(e) => { setPage(1); setFilters({ ...filters, search: e.target.value }); }} />
        </div>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No sales orders yet." />
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
                  <th>Source Quotation</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id} role="button" onClick={() => openDetail(o)}>
                    <td>{o.orderNumber}</td>
                    <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                    <td>{o.customer?.name || '-'}</td>
                    <td><StatusBadge status={o.status} /></td>
                    <td className="text-end">{formatCurrency(o.total)}</td>
                    <td>{o.sourceQuotation?.quotationNumber || '-'}</td>
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
        title="New Sales Order"
        size="lg"
        onClose={() => setShowModal(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            <button type="submit" form="sales-order-form" className="btn btn-primary" disabled={saving || !customerId}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="sales-order-form">
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
              <div className="col-4">
                <select className="form-select" value={line.productId} onChange={(e) => updateLine(idx, 'productId', e.target.value)}>
                  <option value="">Select product...</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="col-3">
                <input type="number" min="0.01" step="0.01" className="form-control" placeholder="Qty" value={line.quantity} onChange={(e) => updateLine(idx, 'quantity', e.target.value)} />
              </div>
              <div className="col-3">
                <input type="number" min="0" step="0.01" className="form-control" placeholder="Unit Price" value={line.unitPrice} onChange={(e) => updateLine(idx, 'unitPrice', e.target.value)} />
              </div>
              <div className="col-1">
                <button type="button" className="btn btn-outline-danger" onClick={() => removeLine(idx)}>&times;</button>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-outline-secondary mb-3" onClick={addLine}>+ Add Line</button>
        </form>
      </Modal>

      <Modal
        show={!!selected}
        title={`Sales Order ${selected?.orderNumber || ''}`}
        size="lg"
        onClose={() => setSelected(null)}
        footer={
          selected ? (
            <>
              {canConfirm && selected.status === 'DRAFT' && (
                <button className="btn btn-success" disabled={busy} onClick={handleConfirm}>Confirm</button>
              )}
              {canCancel && ['DRAFT', 'CONFIRMED', 'PROCESSING'].includes(selected.status) && (
                <button className="btn btn-outline-danger" disabled={busy} onClick={handleCancel}>Cancel Order</button>
              )}
              {canFulfill && ['CONFIRMED', 'PROCESSING'].includes(selected.status) && (
                <button className="btn btn-primary" disabled={busy} onClick={handleFulfill}>Fulfill / Create Sale</button>
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
            {selected.sourceQuotation?.quotationNumber && (
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Source Quotation</span>
                <span>{selected.sourceQuotation.quotationNumber}</span>
              </div>
            )}
            <table className="table table-sm mt-2">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-end">Ordered</th>
                  <th className="text-end">Fulfilled</th>
                  <th className="text-end">Remaining</th>
                  {['CONFIRMED', 'PROCESSING'].includes(selected.status) && canFulfill && <th className="text-end">Fulfill Now</th>}
                </tr>
              </thead>
              <tbody>
                {selected.items?.map((l) => {
                  const remaining = Number(l.quantity) - Number(l.fulfilledQuantity || 0);
                  return (
                    <tr key={l.id}>
                      <td>{l.product?.name || l.productId}</td>
                      <td className="text-end">{Number(l.quantity)}</td>
                      <td className="text-end">{Number(l.fulfilledQuantity || 0)}</td>
                      <td className="text-end">{remaining}</td>
                      {['CONFIRMED', 'PROCESSING'].includes(selected.status) && canFulfill && (
                        <td className="text-end" style={{ maxWidth: 110 }}>
                          <input
                            type="number"
                            className="form-control form-control-sm"
                            min={0}
                            max={remaining}
                            step="any"
                            disabled={remaining <= 0}
                            value={fulfillQuantities[l.id] ?? 0}
                            onChange={(e) => setFulfillQuantities((prev) => ({ ...prev, [l.id]: e.target.value }))}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="d-flex justify-content-between fw-bold">
              <span>Total</span>
              <span>{formatCurrency(selected.total)}</span>
            </div>

            {['CONFIRMED', 'PROCESSING'].includes(selected.status) && canFulfill && (
              <div className="row g-2 mt-2">
                <div className="col-6">
                  <label className="form-label">Amount to Collect Now (optional)</label>
                  <input type="number" min="0" step="0.01" className="form-control" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </div>
                <div className="col-6">
                  <label className="form-label">Method</label>
                  <select className="form-select" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                    {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
              </div>
            )}

            {selected.sales?.length > 0 && (
              <div className="mt-3">
                <div className="text-body-secondary small mb-1">Sales created from this order</div>
                <ul className="mb-0">
                  {selected.sales.map((s) => (
                    <li key={s.id}>{s.invoiceNumber} - {formatCurrency(s.total)} ({new Date(s.createdAt).toLocaleDateString()})</li>
                  ))}
                </ul>
              </div>
            )}
            {selected.notes && <div className="mt-2"><div className="text-body-secondary small">Notes</div><div>{selected.notes}</div></div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
