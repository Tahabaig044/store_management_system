import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES, refreshCaches } from '../../offline/syncEngine';
import { useLiveCustomers } from '../../offline/useOfflineData';
import { PAYMENT_METHODS } from '../../constants/paymentMethods';
import { formatCurrency } from '../../utils/currency';

const STATUS_VALUES = ['PENDING', 'IN_LAB', 'READY', 'DELIVERED', 'CANCELLED'];

export default function OpticalOrders() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  const customers = useLiveCustomers(tenantId);
  // Lets the Business Command Center's Pending/Ready/Delayed job widgets
  // deep-link here pre-filtered, via ?status=PENDING etc.
  const [searchParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [frameProducts, setFrameProducts] = useState([]);
  const [lensProducts, setLensProducts] = useState([]);
  const [selectedFrameId, setSelectedFrameId] = useState('');
  const [selectedLensId, setSelectedLensId] = useState('');
  const [form, setForm] = useState({
    customerId: '',
    frameDescription: '',
    lensDescription: '',
    totalAmount: 0,
    amountPaid: 0,
    expectedDeliveryDate: '',
    notes: '',
    odSphere: '',
    odCylinder: '',
    odAxis: '',
    osSphere: '',
    osCylinder: '',
    osAxis: '',
    pd: '',
  });

  // Phase 5.1: frame/lens can optionally be picked from tracked inventory (Product
  // type FRAME/LENS) instead of - or alongside - the free-text descriptions above.
  // Picking one deducts real stock and posts COGS when the order is saved; leaving
  // both unpicked behaves exactly as before (free text only, no stock/COGS effect).
  useEffect(() => {
    if (!showModal) return;
    apiClient.get('/products', { params: { pageSize: 200, type: 'FRAME' } }).then((res) => setFrameProducts(res.data.items || [])).catch(() => {});
    apiClient.get('/products', { params: { pageSize: 200, type: 'LENS' } }).then((res) => setLensProducts(res.data.items || [])).catch(() => {});
  }, [showModal]);

  const [payingOrder, setPayingOrder] = useState(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payNote, setPayNote] = useState('');
  const [payError, setPayError] = useState('');
  const [paySaving, setPaySaving] = useState(false);

  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/optical-orders', { params: { page, pageSize, status: statusFilter || undefined } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, statusFilter]);
  useEffect(() => {
    if (tenantId && navigator.onLine) {
      refreshCaches(tenantId).catch((err) => console.warn('Could not refresh offline cache:', err));
    }
  }, [tenantId]);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      // Phase 5.1: a picked frame/lens becomes a stock-linked order item (real
      // deduction + COGS on save); items is simply omitted when nothing was
      // picked, so a free-text-only order behaves exactly as before.
      const items = [];
      const frame = frameProducts.find((p) => p.id === selectedFrameId);
      if (frame) items.push({ productId: frame.id, quantity: 1, unitPrice: Number(frame.sellingPrice) });
      const lens = lensProducts.find((p) => p.id === selectedLensId);
      if (lens) items.push({ productId: lens.id, quantity: 1, unitPrice: Number(lens.sellingPrice) });

      const entry = await OUTBOXES.opticalOrders.submit(tenantId, {
        customerId: form.customerId,
        frameDescription: form.frameDescription || undefined,
        lensDescription: form.lensDescription || undefined,
        totalAmount: Number(form.totalAmount),
        amountPaid: Number(form.amountPaid),
        expectedDeliveryDate: form.expectedDeliveryDate || undefined,
        notes: form.notes || undefined,
        items: items.length ? items : undefined,
        prescription: {
          od: { sphere: numOrUndef(form.odSphere), cylinder: numOrUndef(form.odCylinder), axis: intOrUndef(form.odAxis) },
          os: { sphere: numOrUndef(form.osSphere), cylinder: numOrUndef(form.osCylinder), axis: intOrUndef(form.osAxis) },
          pd: numOrUndef(form.pd),
        },
      });
      if (entry.status === 'conflict' || entry.status === 'failed') {
        setError(`Could not save optical order: ${entry.lastError}`);
        return;
      }
      setShowModal(false);
      setSelectedFrameId('');
      setSelectedLensId('');
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

  function numOrUndef(v) {
    return v === '' ? undefined : Number(v);
  }
  function intOrUndef(v) {
    return v === '' ? undefined : parseInt(v, 10);
  }

  async function updateStatus(id, status) {
    try {
      await apiClient.patch(`/optical-orders/${id}`, { status });
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  function dueOf(o) {
    return Math.max(Number(o.totalAmount) - Number(o.amountPaid), 0);
  }

  function paymentStatusOf(o) {
    const paid = Number(o.amountPaid);
    const total = Number(o.totalAmount);
    if (paid <= 0) return 'UNPAID';
    if (paid >= total) return 'PAID';
    return 'PARTIAL';
  }

  function openPay(o) {
    setPayingOrder(o);
    setPayAmount('');
    setPayMethod('cash');
    setPayNote('');
    setPayError('');
  }

  function closePay() {
    setPayingOrder(null);
    setPayAmount('');
    setPayMethod('cash');
    setPayNote('');
    setPayError('');
  }

  async function handlePay(e) {
    e.preventDefault();
    if (!payingOrder) return;
    setPayError('');

    const amount = Number(payAmount);
    const due = dueOf(payingOrder);
    if (!payAmount || Number.isNaN(amount) || amount <= 0) {
      setPayError('Enter a valid payment amount greater than 0.');
      return;
    }
    if (amount > due) {
      setPayError(`Payment cannot exceed the remaining balance due (${formatCurrency(due)}).`);
      return;
    }

    setPaySaving(true);
    try {
      await apiClient.post(`/optical-orders/${payingOrder.id}/pay`, {
        amount,
        method: payMethod,
        note: payNote || undefined,
      });
      closePay();
      setNotice('Payment recorded.');
      load();
    } catch (err) {
      setPayError(extractErrorMessage(err));
    } finally {
      setPaySaving(false);
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
        <h4 className="mb-0">Optical Orders</h4>
        <div className="d-flex align-items-center gap-2">
          <select
            className="form-select form-select-sm"
            style={{ width: 'auto' }}
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          >
            <option value="">All statuses</option>
            {STATUS_VALUES.map((s) => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            onClick={() => {
              setSelectedFrameId('');
              setSelectedLensId('');
              setShowModal(true);
            }}
          >
            + New Order
          </button>
        </div>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No optical orders yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Expected Delivery</th>
                  <th className="text-end">Total</th>
                  <th className="text-end">Paid</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td>{o.orderNumber}</td>
                    <td>{o.customer?.name}</td>
                    <td><StatusBadge status={o.status} /></td>
                    <td><StatusBadge status={paymentStatusOf(o)} /></td>
                    <td>{o.expectedDeliveryDate ? new Date(o.expectedDeliveryDate).toLocaleDateString() : '-'}</td>
                    <td className="text-end">{formatCurrency(o.totalAmount)}</td>
                    <td className="text-end">{formatCurrency(o.amountPaid)}</td>
                    <td className="d-flex gap-1">
                      <select className="form-select form-select-sm" value={o.status} onChange={(e) => updateStatus(o.id, e.target.value)}>
                        {STATUS_VALUES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      {paymentStatusOf(o) !== 'PAID' && (
                        <button className="btn btn-sm btn-primary" onClick={() => openPay(o)}>
                          Pay
                        </button>
                      )}
                    </td>
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
        title="New Optical Order"
        size="lg"
        onClose={() => setShowModal(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>
              Cancel
            </button>
            <button type="submit" form="optical-order-form" className="btn btn-primary" disabled={saving || !form.customerId}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="optical-order-form">
          <div className="mb-2">
            <label className="form-label" htmlFor="optical-order-customer">Customer</label>
            <select id="optical-order-customer" className="form-select" required value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
              <option value="">Select customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="row g-2 mb-2">
            <div className="col-md-6">
              <label className="form-label" htmlFor="optical-order-frame">Frame (from inventory, optional)</label>
              <select id="optical-order-frame" className="form-select" value={selectedFrameId} onChange={(e) => setSelectedFrameId(e.target.value)}>
                <option value="">None - use description only</option>
                {frameProducts.map((p) => (
                  <option key={p.id} value={p.id} disabled={Number(p.stockQuantity) <= 0}>
                    {p.name} ({p.sku}) - {formatCurrency(p.sellingPrice)} - stock {Number(p.stockQuantity)}
                  </option>
                ))}
              </select>
              <label className="form-label mt-2">Frame Description</label>
              <input className="form-control" value={form.frameDescription} onChange={(e) => setForm({ ...form, frameDescription: e.target.value })} />
            </div>
            <div className="col-md-6">
              <label className="form-label" htmlFor="optical-order-lens">Lens (from inventory, optional)</label>
              <select id="optical-order-lens" className="form-select" value={selectedLensId} onChange={(e) => setSelectedLensId(e.target.value)}>
                <option value="">None - use description only</option>
                {lensProducts.map((p) => (
                  <option key={p.id} value={p.id} disabled={Number(p.stockQuantity) <= 0}>
                    {p.name} ({p.sku}) - {formatCurrency(p.sellingPrice)} - stock {Number(p.stockQuantity)}
                  </option>
                ))}
              </select>
              <label className="form-label mt-2">Lens Description</label>
              <input className="form-control" value={form.lensDescription} onChange={(e) => setForm({ ...form, lensDescription: e.target.value })} />
            </div>
          </div>
          {(selectedFrameId || selectedLensId) && (
            <div className="alert alert-info py-2 small mb-2">
              Picking a frame/lens from inventory will deduct real stock and post cost-of-goods when this order is saved.
            </div>
          )}

          <h6 className="mt-3">Prescription</h6>
          <div className="row g-2">
            <div className="col-4"><label className="form-label small">OD Sphere</label><input type="number" step="0.25" className="form-control form-control-sm" value={form.odSphere} onChange={(e) => setForm({ ...form, odSphere: e.target.value })} /></div>
            <div className="col-4"><label className="form-label small">OD Cylinder</label><input type="number" step="0.25" className="form-control form-control-sm" value={form.odCylinder} onChange={(e) => setForm({ ...form, odCylinder: e.target.value })} /></div>
            <div className="col-4"><label className="form-label small">OD Axis</label><input type="number" className="form-control form-control-sm" value={form.odAxis} onChange={(e) => setForm({ ...form, odAxis: e.target.value })} /></div>
            <div className="col-4"><label className="form-label small">OS Sphere</label><input type="number" step="0.25" className="form-control form-control-sm" value={form.osSphere} onChange={(e) => setForm({ ...form, osSphere: e.target.value })} /></div>
            <div className="col-4"><label className="form-label small">OS Cylinder</label><input type="number" step="0.25" className="form-control form-control-sm" value={form.osCylinder} onChange={(e) => setForm({ ...form, osCylinder: e.target.value })} /></div>
            <div className="col-4"><label className="form-label small">OS Axis</label><input type="number" className="form-control form-control-sm" value={form.osAxis} onChange={(e) => setForm({ ...form, osAxis: e.target.value })} /></div>
            <div className="col-4"><label className="form-label small">PD</label><input type="number" step="0.5" className="form-control form-control-sm" value={form.pd} onChange={(e) => setForm({ ...form, pd: e.target.value })} /></div>
          </div>

          <div className="row g-2 mt-2">
            <div className="col-md-4">
              <label className="form-label">Total Amount</label>
              <input type="number" min="0" step="0.01" className="form-control" value={form.totalAmount} onChange={(e) => setForm({ ...form, totalAmount: e.target.value })} />
            </div>
            <div className="col-md-4">
              <label className="form-label">Amount Paid</label>
              <input type="number" min="0" step="0.01" className="form-control" value={form.amountPaid} onChange={(e) => setForm({ ...form, amountPaid: e.target.value })} />
            </div>
            <div className="col-md-4">
              <label className="form-label">Expected Delivery</label>
              <input type="date" className="form-control" value={form.expectedDeliveryDate} onChange={(e) => setForm({ ...form, expectedDeliveryDate: e.target.value })} />
            </div>
          </div>
          <div className="mt-2">
            <label className="form-label">Notes</label>
            <textarea className="form-control" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </form>
      </Modal>

      <Modal
        show={!!payingOrder}
        title={`Record Payment - ${payingOrder?.orderNumber || ''}`}
        onClose={closePay}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closePay}>
              Cancel
            </button>
            <button type="submit" form="optical-order-pay-form" className="btn btn-primary" disabled={paySaving}>
              {paySaving ? 'Saving...' : 'Record Payment'}
            </button>
          </>
        }
      >
        {payingOrder && (
          <form onSubmit={handlePay} id="optical-order-pay-form">
            <ErrorAlert message={payError} />
            <div className="mb-3">
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Customer</span>
                <span>{payingOrder.customer?.name}</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Total</span>
                <span>{formatCurrency(payingOrder.totalAmount)}</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Already Paid</span>
                <span>{formatCurrency(payingOrder.amountPaid)}</span>
              </div>
              <div className="d-flex justify-content-between fw-bold">
                <span>Balance Due</span>
                <span>{formatCurrency(dueOf(payingOrder))}</span>
              </div>
            </div>
            <div className="mb-2">
              <label className="form-label">Payment Amount</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                max={dueOf(payingOrder)}
                className="form-control"
                required
                autoFocus
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
            </div>
            <div className="mb-2">
              <label className="form-label">Method</label>
              <select className="form-select" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-2">
              <label className="form-label">Note (optional)</label>
              <input className="form-control" value={payNote} onChange={(e) => setPayNote(e.target.value)} />
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
