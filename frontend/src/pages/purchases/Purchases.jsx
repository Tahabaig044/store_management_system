import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES, refreshCaches } from '../../offline/syncEngine';
import { useLiveProducts, useLiveSuppliers } from '../../offline/useOfflineData';
import { PAYMENT_METHODS } from '../../constants/paymentMethods';
import { formatCurrency } from '../../utils/currency';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export default function Purchases() {
  const { user, hasPermission } = useAuth();
  const tenantId = user?.tenantId;
  // Phase 1.13: a NEW, partial/line-item-level Return - distinct from the
  // existing whole-purchase :id/return action (unused in this UI). Online-only
  // for now (see this phase's verification report, Offline-First section).
  const canReturn = hasPermission('PURCHASE_RETURN:CREATE');
  const suppliers = useLiveSuppliers(tenantId);
  const products = useLiveProducts(tenantId);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState([{ productId: '', quantity: 1, unitCost: 0 }]);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [amountPaid, setAmountPaid] = useState(0);
  const [receiveImmediately, setReceiveImmediately] = useState(true);
  const [saving, setSaving] = useState(false);

  const [payingPurchase, setPayingPurchase] = useState(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payNote, setPayNote] = useState('');
  const [payError, setPayError] = useState('');
  const [paySaving, setPaySaving] = useState(false);

  const [returnPurchase, setReturnPurchase] = useState(null);
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnReason, setReturnReason] = useState('');
  const [submittingReturn, setSubmittingReturn] = useState(false);
  const [returnError, setReturnError] = useState('');

  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/purchases', { params: { page, pageSize } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page]);
  useEffect(() => {
    if (tenantId && navigator.onLine) {
      refreshCaches(tenantId).catch((err) => console.warn('Could not refresh offline cache:', err));
    }
  }, [tenantId]);

  function updateLine(idx, field, value) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }
  function addLine() {
    setLines((ls) => [...ls, { productId: '', quantity: 1, unitCost: 0 }]);
  }
  function removeLine(idx) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }

  const subtotal = lines.reduce((sum, l) => sum + Number(l.quantity || 0) * Number(l.unitCost || 0), 0);
  // Discount is entered as a percentage but stored/sent as a currency amount -
  // Purchase.discount and the POST /api/purchases payload both stay
  // unchanged (an amount), so this is a purely frontend conversion. Clamped
  // to 0-100 here (not just via the input's min/max) since some browsers
  // still allow typing outside that range despite the HTML attributes.
  const clampedDiscountPercent = Math.min(Math.max(Number(discountPercent || 0), 0), 100);
  const discountAmount = round2((subtotal * clampedDiscountPercent) / 100);
  const total_ = Math.max(subtotal - discountAmount, 0);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const entry = await OUTBOXES.purchases.submit(tenantId, {
        supplierId,
        items: lines
          .filter((l) => l.productId)
          .map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitCost: Number(l.unitCost) })),
        discount: discountAmount,
        amountPaid: Number(amountPaid),
        receiveImmediately,
      });
      if (entry.status === 'conflict' || entry.status === 'failed') {
        setError(`Could not save purchase: ${entry.lastError}`);
        return;
      }
      setShowModal(false);
      setSupplierId('');
      setLines([{ productId: '', quantity: 1, unitCost: 0 }]);
      setDiscountPercent(0);
      setAmountPaid(0);
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

  async function receive(id) {
    try {
      await apiClient.post(`/purchases/${id}/receive`);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  function dueOf(p) {
    return Math.max(Number(p.total) - Number(p.amountPaid), 0);
  }

  function openPay(p) {
    setPayingPurchase(p);
    setPayAmount('');
    setPayMethod('cash');
    setPayNote('');
    setPayError('');
  }

  function closePay() {
    setPayingPurchase(null);
    setPayAmount('');
    setPayMethod('cash');
    setPayNote('');
    setPayError('');
  }

  async function handlePay(e) {
    e.preventDefault();
    if (!payingPurchase) return;
    setPayError('');

    const amount = Number(payAmount);
    const due = dueOf(payingPurchase);
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
      await apiClient.post(`/purchases/${payingPurchase.id}/pay`, {
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

  async function openReturnModal(p) {
    setReturnError('');
    setReturnReason('');
    try {
      const res = await apiClient.get(`/purchases/${p.id}`);
      const full = res.data.item;
      const initial = {};
      for (const line of full.items) {
        initial[line.id] = 0;
      }
      setReturnQuantities(initial);
      setReturnPurchase(full);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function submitReturn() {
    setReturnError('');
    const linesToReturn = Object.entries(returnQuantities)
      .filter(([, qty]) => Number(qty) > 0)
      .map(([purchaseItemId, qty]) => ({ purchaseItemId, quantity: Number(qty) }));
    if (linesToReturn.length === 0) {
      setReturnError('Enter a return quantity for at least one item.');
      return;
    }
    setSubmittingReturn(true);
    try {
      await apiClient.post('/purchase-returns', {
        purchaseId: returnPurchase.id,
        items: linesToReturn,
        reason: returnReason || undefined,
      });
      setNotice(`Return recorded for purchase ${returnPurchase.purchaseNumber}.`);
      setReturnPurchase(null);
      load();
    } catch (err) {
      setReturnError(extractErrorMessage(err));
    } finally {
      setSubmittingReturn(false);
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Purchases</h4>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          + New Purchase
        </button>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No purchases yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th className="text-end">Total</th>
                  <th className="text-end">Paid</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>{p.purchaseNumber}</td>
                    <td>{p.supplier?.name}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td><StatusBadge status={p.paymentStatus} /></td>
                    <td className="text-end">{formatCurrency(p.total)}</td>
                    <td className="text-end">{formatCurrency(p.amountPaid)}</td>
                    <td className="d-flex gap-1">
                      {p.status === 'DRAFT' && (
                        <button className="btn btn-sm btn-outline-success" onClick={() => receive(p.id)}>
                          Receive Stock
                        </button>
                      )}
                      {p.paymentStatus !== 'PAID' && (
                        <button className="btn btn-sm btn-primary" onClick={() => openPay(p)}>
                          Pay
                        </button>
                      )}
                      {canReturn && p.status === 'RECEIVED' && (
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => openReturnModal(p)}>
                          Return
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
        title="New Purchase"
        size="lg"
        onClose={() => setShowModal(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>
              Cancel
            </button>
            <button type="submit" form="purchase-form" className="btn btn-primary" disabled={saving || !supplierId}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="purchase-form">
          <div className="mb-2">
            <label className="form-label">Supplier</label>
            <select className="form-select" required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select supplier...</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <label className="form-label">Items</label>
          {lines.map((line, idx) => (
            <div className="row g-2 mb-2" key={idx}>
              <div className="col-5">
                <select className="form-select" value={line.productId} onChange={(e) => updateLine(idx, 'productId', e.target.value)}>
                  <option value="">Select product...</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-3">
                <input type="number" min="0.01" step="0.01" className="form-control" placeholder="Qty" value={line.quantity} onChange={(e) => updateLine(idx, 'quantity', e.target.value)} />
              </div>
              <div className="col-3">
                <input type="number" min="0" step="0.01" className="form-control" placeholder="Unit Cost" value={line.unitCost} onChange={(e) => updateLine(idx, 'unitCost', e.target.value)} />
              </div>
              <div className="col-1">
                <button type="button" className="btn btn-outline-danger" onClick={() => removeLine(idx)}>
                  &times;
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-outline-secondary mb-3" onClick={addLine}>
            + Add Line
          </button>

          <div className="row g-2">
            <div className="col-md-4">
              <label className="form-label">Discount (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                className="form-control"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
              />
            </div>
            <div className="col-md-4">
              <label className="form-label">Amount Paid Now</label>
              <input type="number" min="0" step="0.01" className="form-control" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
            </div>
            <div className="col-md-4 d-flex align-items-end">
              <div className="form-check">
                <input className="form-check-input" type="checkbox" id="receiveNow" checked={receiveImmediately} onChange={(e) => setReceiveImmediately(e.target.checked)} />
                <label className="form-check-label" htmlFor="receiveNow">
                  Receive stock immediately
                </label>
              </div>
            </div>
          </div>

          <div className="text-end mt-3">
            <div>Subtotal: {formatCurrency(subtotal)}</div>
            <div>Discount ({clampedDiscountPercent}%): {formatCurrency(discountAmount)}</div>
            <div className="fw-bold">Final Total: {formatCurrency(total_)}</div>
          </div>
        </form>
      </Modal>

      <Modal
        show={!!payingPurchase}
        title={`Record Payment - ${payingPurchase?.purchaseNumber || ''}`}
        onClose={closePay}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closePay}>
              Cancel
            </button>
            <button type="submit" form="purchase-pay-form" className="btn btn-primary" disabled={paySaving}>
              {paySaving ? 'Saving...' : 'Record Payment'}
            </button>
          </>
        }
      >
        {payingPurchase && (
          <form onSubmit={handlePay} id="purchase-pay-form">
            <ErrorAlert message={payError} />
            <div className="mb-3">
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Supplier</span>
                <span>{payingPurchase.supplier?.name}</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Total</span>
                <span>{formatCurrency(payingPurchase.total)}</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Already Paid</span>
                <span>{formatCurrency(payingPurchase.amountPaid)}</span>
              </div>
              <div className="d-flex justify-content-between fw-bold">
                <span>Balance Due</span>
                <span>{formatCurrency(dueOf(payingPurchase))}</span>
              </div>
            </div>
            <div className="mb-2">
              <label className="form-label">Payment Amount</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                max={dueOf(payingPurchase)}
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

      <Modal
        show={!!returnPurchase}
        title={`Return items - ${returnPurchase?.purchaseNumber || ''}`}
        onClose={() => setReturnPurchase(null)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setReturnPurchase(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={submittingReturn} onClick={submitReturn}>
              {submittingReturn ? 'Submitting...' : 'Submit Return'}
            </button>
          </>
        }
      >
        {returnPurchase && (
          <div>
            <ErrorAlert message={returnError} />
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-end">Received Qty</th>
                  <th className="text-end">Already Returned</th>
                  <th className="text-end">Return Qty</th>
                </tr>
              </thead>
              <tbody>
                {returnPurchase.items.map((line) => {
                  const remaining = Number(line.quantity) - Number(line.returnedQuantity || 0);
                  return (
                    <tr key={line.id}>
                      <td>{line.product?.name || line.productId}</td>
                      <td className="text-end">{Number(line.quantity)}</td>
                      <td className="text-end">{Number(line.returnedQuantity || 0)}</td>
                      <td className="text-end" style={{ maxWidth: 120 }}>
                        <input
                          type="number"
                          className="form-control form-control-sm"
                          min={0}
                          max={remaining}
                          step="any"
                          disabled={remaining <= 0}
                          value={returnQuantities[line.id] ?? 0}
                          onChange={(e) =>
                            setReturnQuantities((prev) => ({ ...prev, [line.id]: e.target.value }))
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mb-2">
              <label className="form-label">Reason</label>
              <input
                className="form-control"
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                placeholder="Why is this being returned?"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
