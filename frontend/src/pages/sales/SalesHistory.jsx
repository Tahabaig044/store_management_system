import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES } from '../../offline/syncEngine';
import { useSyncStatus } from '../../offline/useSyncStatus';
import { formatCurrency } from '../../utils/currency';

export default function SalesHistory() {
  const { user, hasPermission } = useAuth();
  const canReverse = hasPermission('SALE:REVERSE');
  // Phase 1.13: a NEW, partial/line-item-level Return - distinct from the
  // existing whole-invoice Reverse action above. Online-only for now (see
  // this phase's verification report, Offline-First section, for why).
  const canReturn = hasPermission('SALES_RETURN:CREATE');

  const [searchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Phase 1.8: customer/status/paymentStatus filters, mirroring the new
  // GET /api/sales query params.
  const [customerId, setCustomerId] = useState('');
  const [status, setStatus] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [viewSale, setViewSale] = useState(null);
  const [reversingId, setReversingId] = useState(null);
  const [returnSale, setReturnSale] = useState(null);
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnReason, setReturnReason] = useState('');
  const [submittingReturn, setSubmittingReturn] = useState(false);
  const [returnError, setReturnError] = useState('');
  const pageSize = 20;

  const { items: syncItems } = useSyncStatus(user?.tenantId);
  const reversalItems = syncItems.filter((i) => i.entityKey === 'reversals');
  const queuedSaleIds = new Set(
    reversalItems.filter((i) => i.status === 'pending' || i.status === 'syncing').map((i) => i.payload.saleId)
  );

  // Once a queued offline reversal finishes syncing (or lands in conflict),
  // the sale's real status has changed on the server - reload so the row
  // reflects it without waiting for the user to manually refresh. Only
  // terminal states are tracked here - reacting to the initial "pending"
  // state too would trigger a reload (and a spurious network error) the
  // instant the user queues a reversal while still offline.
  const reversalStatusSignature = reversalItems
    .filter((i) => i.status === 'synced' || i.status === 'conflict')
    .map((i) => `${i.clientId}:${i.status}`)
    .join(',');
  const prevReversalSignatureRef = useRef(reversalStatusSignature);
  useEffect(() => {
    if (prevReversalSignatureRef.current !== reversalStatusSignature) {
      prevReversalSignatureRef.current = reversalStatusSignature;
      load();
    }
  }, [reversalStatusSignature]);

  function load() {
    setLoading(true);
    apiClient
      .get('/sales', {
        params: {
          page,
          pageSize,
          search: search || undefined,
          from: from || undefined,
          to: to || undefined,
          customerId: customerId || undefined,
          status: status || undefined,
          paymentStatus: paymentStatus || undefined,
        },
      })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, from, to, customerId, status, paymentStatus]);
  useEffect(() => {
    apiClient.get('/customers', { params: { pageSize: 200 } }).then((res) => setCustomers(res.data.items || []));
  }, []);

  async function handleReverse(sale) {
    setError('');
    setNotice('');

    if (!navigator.onLine) {
      try {
        await OUTBOXES.reversals.queue(user.tenantId, { saleId: sale.id, invoiceNumber: sale.invoiceNumber });
        setNotice(
          `You're offline - invoice ${sale.invoiceNumber} will be reversed automatically once you're back online.`
        );
      } catch (err) {
        setError(extractErrorMessage(err));
      }
      return;
    }

    setReversingId(sale.id);
    try {
      await apiClient.post(`/sales/${sale.id}/reverse`);
      setNotice(`Invoice ${sale.invoiceNumber} reversed - stock has been restored.`);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setReversingId(null);
    }
  }

  async function openReturnModal(sale) {
    setReturnError('');
    setReturnReason('');
    try {
      // The list row's items don't include product details - fetch the full
      // sale so the return modal can show product names.
      const res = await apiClient.get(`/sales/${sale.id}`);
      const full = res.data.item;
      const initial = {};
      for (const line of full.items) {
        initial[line.id] = 0;
      }
      setReturnQuantities(initial);
      setReturnSale(full);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function submitReturn() {
    setReturnError('');
    const lines = Object.entries(returnQuantities)
      .filter(([, qty]) => Number(qty) > 0)
      .map(([saleItemId, qty]) => ({ saleItemId, quantity: Number(qty) }));
    if (lines.length === 0) {
      setReturnError('Enter a return quantity for at least one item.');
      return;
    }
    setSubmittingReturn(true);
    try {
      await apiClient.post('/sales-returns', { saleId: returnSale.id, items: lines, reason: returnReason || undefined });
      setNotice(`Return recorded for invoice ${returnSale.invoiceNumber}.`);
      setReturnSale(null);
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
        <h4 className="mb-0">Sales History</h4>
      </div>

      <div className="d-flex flex-wrap gap-2 mb-3">
        <input
          className="form-control"
          style={{ maxWidth: 220 }}
          placeholder="Search invoice #..."
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
        <input
          type="date"
          className="form-control"
          style={{ maxWidth: 180 }}
          value={from}
          onChange={(e) => {
            setPage(1);
            setFrom(e.target.value);
          }}
        />
        <input
          type="date"
          className="form-control"
          style={{ maxWidth: 180 }}
          value={to}
          onChange={(e) => {
            setPage(1);
            setTo(e.target.value);
          }}
        />
        <select
          className="form-select"
          style={{ maxWidth: 200 }}
          value={customerId}
          onChange={(e) => {
            setPage(1);
            setCustomerId(e.target.value);
          }}
        >
          <option value="">All Customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="form-select"
          style={{ maxWidth: 160 }}
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
        >
          <option value="">All Statuses</option>
          <option value="COMPLETED">Completed</option>
          <option value="REVERSED">Reversed</option>
        </select>
        <select
          className="form-select"
          style={{ maxWidth: 160 }}
          value={paymentStatus}
          onChange={(e) => {
            setPage(1);
            setPaymentStatus(e.target.value);
          }}
        >
          <option value="">All Payment Statuses</option>
          <option value="PAID">Paid</option>
          <option value="PARTIAL">Partial</option>
          <option value="UNPAID">Unpaid</option>
        </select>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No sales found." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Cashier</th>
                  <th className="text-end">Total</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((sale) => (
                  <tr key={sale.id}>
                    <td>
                      <button className="btn btn-link p-0" onClick={() => setViewSale(sale)}>
                        {sale.invoiceNumber}
                      </button>
                    </td>
                    <td>{new Date(sale.createdAt).toLocaleString()}</td>
                    <td>{sale.customer?.name || 'Walk-in'}</td>
                    <td>{sale.cashier?.name || '-'}</td>
                    <td className="text-end">{formatCurrency(sale.total)}</td>
                    <td><StatusBadge status={sale.paymentStatus} /></td>
                    <td><StatusBadge status={sale.status} /></td>
                    <td className="d-flex gap-1">
                      {canReturn && sale.status === 'COMPLETED' && (
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => openReturnModal(sale)}>
                          Return
                        </button>
                      )}
                      {canReverse && sale.status === 'COMPLETED' && (
                        queuedSaleIds.has(sale.id) ? (
                          <span className="badge text-bg-warning" title="Will reverse automatically once back online">
                            Reversal queued
                          </span>
                        ) : (
                          <button
                            className="btn btn-sm btn-outline-danger"
                            disabled={reversingId === sale.id}
                            onClick={() => handleReverse(sale)}
                          >
                            {reversingId === sale.id ? 'Reversing...' : 'Reverse'}
                          </button>
                        )
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

      <Modal show={!!viewSale} title={`Invoice ${viewSale?.invoiceNumber || ''}`} onClose={() => setViewSale(null)}>
        {viewSale && (
          <div>
            <p className="mb-1">
              <strong>Customer:</strong> {viewSale.customer?.name || 'Walk-in'}
            </p>
            <p className="mb-3">
              <strong>Cashier:</strong> {viewSale.cashier?.name || '-'}
            </p>
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Qty</th>
                  <th className="text-end">Unit Price</th>
                  <th className="text-end">Discount</th>
                  <th className="text-end">Line Total</th>
                </tr>
              </thead>
              <tbody>
                {viewSale.items.map((line) => (
                  <tr key={line.id}>
                    <td>{Number(line.quantity)}</td>
                    <td className="text-end">{formatCurrency(line.unitPrice)}</td>
                    <td className="text-end">{formatCurrency(line.discount)}</td>
                    <td className="text-end">{formatCurrency(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="d-flex justify-content-between">
              <span>Subtotal</span>
              <span>{formatCurrency(viewSale.subtotal)}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span>Discount</span>
              <span>{formatCurrency(viewSale.discount)}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span>Tax</span>
              <span>{formatCurrency(viewSale.tax)}</span>
            </div>
            <hr />
            <div className="d-flex justify-content-between fw-bold">
              <span>Total</span>
              <span>{formatCurrency(viewSale.total)}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span>Amount Paid</span>
              <span>{formatCurrency(viewSale.amountPaid)}</span>
            </div>
            {viewSale.notes && (
              <div className="mt-3">
                <strong>Notes:</strong> {viewSale.notes}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        show={!!returnSale}
        title={`Return items - Invoice ${returnSale?.invoiceNumber || ''}`}
        onClose={() => setReturnSale(null)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setReturnSale(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={submittingReturn} onClick={submitReturn}>
              {submittingReturn ? 'Submitting...' : 'Submit Return'}
            </button>
          </>
        }
      >
        {returnSale && (
          <div>
            <ErrorAlert message={returnError} />
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-end">Sold Qty</th>
                  <th className="text-end">Already Returned</th>
                  <th className="text-end">Return Qty</th>
                </tr>
              </thead>
              <tbody>
                {returnSale.items.map((line) => {
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
