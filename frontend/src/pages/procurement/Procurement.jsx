import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency as money } from '../../utils/currency';

// Covers the full Phase 4 procurement lifecycle: Purchase Request (draft or
// submitted) -> Approval -> RFQ -> Supplier Quotations -> Selection -> Purchase
// Order -> Goods Receipt -> Inventory, plus reconciliation/dashboard reporting.
//
// Offline boundary (Phase 4.3.10): every mutation on this page is ONLINE ONLY -
// none of it is registered in frontend/src/offline/syncEngine.js's outbox list.
// This is deliberate, not an oversight: procurement involves multi-step approval
// and supplier-facing decisions (an approval, a supplier quotation selection, a
// goods receipt that immediately posts to accounting) that must be resolved
// against the server's current, authoritative state - queuing them for a later,
// possibly stale, replay would risk approving against numbers that have since
// changed, or double-committing a receipt. POS sales/payments/expenses are
// queueable because they are single-actor, additive records; procurement's
// multi-party approval chain is not that shape, so it stays online-only, exactly
// like Sales reversal and Accounting posting already do elsewhere in this app.
const TABS = ['Purchase Requests', 'RFQs & Quotations', 'Purchase Orders', 'Goods Receipts', 'Reports'];

export default function Procurement() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState(TABS[0]);

  return (
    <div>
      <div className="mb-4">
        <h4 className="mb-1">Procurement</h4>
        <div className="text-body-secondary small">Purchase Request &rarr; RFQ &rarr; Supplier Quotation &rarr; Purchase Order &rarr; Goods Receipt &rarr; Inventory.</div>
      </div>
      <ul className="nav nav-pills mb-3 flex-wrap gap-1">
        {TABS.map((t) => (
          <li className="nav-item" key={t}>
            <button className={`nav-link ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
          </li>
        ))}
      </ul>
      {tab === 'Purchase Requests' && <PurchaseRequests canApprove={hasPermission('PURCHASE_REQUEST:APPROVE')} canEdit={hasPermission('PURCHASE_REQUEST:UPDATE')} />}
      {tab === 'RFQs & Quotations' && <RfqsAndQuotations />}
      {tab === 'Purchase Orders' && <PurchaseOrders canApprove={hasPermission('PURCHASE_ORDER:APPROVE')} canEdit={hasPermission('PURCHASE_ORDER:UPDATE')} />}
      {tab === 'Goods Receipts' && <GoodsReceipts />}
      {tab === 'Reports' && <ProcurementReports />}
    </div>
  );
}

function useProducts() {
  const [products, setProducts] = useState([]);
  useEffect(() => {
    apiClient.get('/products', { params: { pageSize: 200 } }).then((res) => setProducts(res.data.items || []));
  }, []);
  return products;
}

function useSuppliers() {
  const [suppliers, setSuppliers] = useState([]);
  useEffect(() => {
    apiClient.get('/suppliers', { params: { pageSize: 200 } }).then((res) => setSuppliers(res.data.items || []));
  }, []);
  return suppliers;
}

const PR_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'];

function PurchaseRequests({ canApprove, canEdit }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null); // a DRAFT request being edited, or null for "create new"
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [requiredDate, setRequiredDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const products = useProducts();

  function load() {
    setLoading(true);
    apiClient.get('/procurement/purchase-requests', { params: statusFilter ? { status: statusFilter } : {} })
      .then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(load, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setEditing(null);
    setProductId(''); setQuantity(1); setRequiredDate(''); setNotes('');
    setShowModal(true);
  }
  function openEdit(pr) {
    setEditing(pr);
    setProductId(pr.items[0]?.productId || ''); setQuantity(pr.items[0]?.quantity || 1);
    setRequiredDate(pr.requiredDate ? pr.requiredDate.slice(0, 10) : ''); setNotes(pr.notes || '');
    setShowModal(true);
  }

  async function saveDraft() {
    setSaving(true); setError('');
    const body = { items: [{ productId, quantity: Number(quantity) }], requiredDate: requiredDate || undefined, notes: notes || undefined };
    try {
      if (editing) await apiClient.patch(`/procurement/purchase-requests/${editing.id}`, body);
      else await apiClient.post('/procurement/purchase-requests', { ...body, status: 'DRAFT' });
      setShowModal(false); load();
    } catch (e) { setError(extractErrorMessage(e)); } finally { setSaving(false); }
  }

  async function submitNow() {
    setSaving(true); setError('');
    const body = { items: [{ productId, quantity: Number(quantity) }], requiredDate: requiredDate || undefined, notes: notes || undefined };
    try {
      if (editing) {
        await apiClient.patch(`/procurement/purchase-requests/${editing.id}`, body);
        await apiClient.post(`/procurement/purchase-requests/${editing.id}/submit`);
      } else {
        await apiClient.post('/procurement/purchase-requests', body); // default status: PENDING_APPROVAL
      }
      setShowModal(false); load();
    } catch (e) { setError(extractErrorMessage(e)); } finally { setSaving(false); }
  }

  async function act(id, action) {
    try {
      await apiClient.post(`/procurement/purchase-requests/${id}/${action}`, action === 'reject' ? { reason: 'Not needed' } : {});
      load();
    } catch (e) { setError(extractErrorMessage(e)); }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
        <select className="form-select form-select-sm" style={{ width: 200 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {PR_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>+ New Request</button>
      </div>
      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No purchase requests yet." /> : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead><tr><th>#</th><th>Items</th><th>Required By</th><th>Status</th><th>Requested By</th><th></th></tr></thead>
              <tbody>
                {items.map((pr) => (
                  <tr key={pr.id}>
                    <td>{pr.requestNumber}</td>
                    <td className="small">{pr.items.map((i) => `${i.product.name} x${Number(i.quantity)}`).join(', ')}</td>
                    <td className="small text-body-secondary">{pr.requiredDate ? new Date(pr.requiredDate).toLocaleDateString() : '-'}</td>
                    <td><StatusBadge status={pr.status} /></td>
                    <td>{pr.requestedBy?.name}</td>
                    <td>
                      <div className="d-flex gap-1 flex-wrap">
                        {canEdit && pr.status === 'DRAFT' && (
                          <>
                            <button className="btn btn-sm btn-outline-secondary" onClick={() => openEdit(pr)}>Edit</button>
                            <button className="btn btn-sm btn-outline-primary" onClick={() => act(pr.id, 'submit')}>Submit</button>
                          </>
                        )}
                        {canApprove && pr.status === 'PENDING_APPROVAL' && (
                          <>
                            <button className="btn btn-sm btn-outline-success" onClick={() => act(pr.id, 'approve')}>Approve</button>
                            <button className="btn btn-sm btn-outline-danger" onClick={() => act(pr.id, 'reject')}>Reject</button>
                          </>
                        )}
                        {['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(pr.status) && (
                          <button className="btn btn-sm btn-outline-danger" onClick={() => act(pr.id, 'cancel')}>Cancel</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        show={showModal}
        title={editing ? `Edit Draft ${editing.requestNumber}` : 'New Purchase Request'}
        onClose={() => setShowModal(false)}
        footer={
          <>
            <button className="btn btn-outline-secondary" disabled={!productId || saving} onClick={saveDraft}>{saving ? 'Saving...' : 'Save as Draft'}</button>
            <button className="btn btn-primary" disabled={!productId || saving} onClick={submitNow}>{saving ? 'Saving...' : 'Submit for Approval'}</button>
          </>
        }
      >
        <div className="mb-3">
          <label className="form-label">Product</label>
          <select className="form-select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Select a product</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="row g-2">
          <div className="col-6">
            <label className="form-label">Quantity</label>
            <input type="number" min="1" className="form-control" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="col-6">
            <label className="form-label">Required by</label>
            <input type="date" className="form-control" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
          </div>
        </div>
        <div className="mb-3 mt-2">
          <label className="form-label">Notes</label>
          <textarea className="form-control" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </Modal>
    </div>
  );
}

const RFQ_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED'];

function RfqsAndQuotations() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState(null); // the open RFQ's full record (with quotations)
  const [compare, setCompare] = useState(null);
  const products = useProducts();
  const suppliers = useSuppliers();

  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [supplierIds, setSupplierIds] = useState([]);
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [saving, setSaving] = useState(false);

  const [qSupplierId, setQSupplierId] = useState('');
  const [qUnitPrice, setQUnitPrice] = useState(0);
  const [qValidUntil, setQValidUntil] = useState('');
  const [qDeliveryDays, setQDeliveryDays] = useState('');
  const [qNotes, setQNotes] = useState('');

  function load() {
    setLoading(true);
    apiClient.get('/procurement/rfqs', { params: statusFilter ? { status: statusFilter } : {} })
      .then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(load, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openDetail(rfq) {
    setError('');
    try {
      const [d, c] = await Promise.all([
        apiClient.get(`/procurement/rfqs/${rfq.id}`),
        apiClient.get(`/procurement/rfqs/${rfq.id}/compare`),
      ]);
      setDetail(d.data.item);
      setCompare(c.data);
      setQSupplierId(''); setQUnitPrice(0); setQValidUntil(''); setQDeliveryDays(''); setQNotes('');
    } catch (e) { setError(extractErrorMessage(e)); }
  }

  async function createRfq() {
    setSaving(true); setError('');
    try {
      await apiClient.post('/procurement/rfqs', {
        items: [{ productId, quantity: Number(quantity) }],
        supplierIds,
        expectedDeliveryDate: expectedDeliveryDate || undefined,
      });
      setShowCreate(false); load();
    } catch (e) { setError(extractErrorMessage(e)); } finally { setSaving(false); }
  }

  async function addQuotation() {
    setError('');
    try {
      await apiClient.post(`/procurement/rfqs/${detail.id}/quotations`, {
        supplierId: qSupplierId,
        validUntil: qValidUntil || undefined,
        deliveryDays: qDeliveryDays ? Number(qDeliveryDays) : undefined,
        notes: qNotes || undefined,
        items: detail.items.map((i) => ({ productId: i.productId, quantity: Number(i.quantity), unitPrice: Number(qUnitPrice) })),
      });
      openDetail(detail);
    } catch (e) { setError(extractErrorMessage(e)); }
  }

  async function selectQuotation(quotationId) {
    setError('');
    try {
      await apiClient.post(`/procurement/rfqs/${detail.id}/quotations/${quotationId}/select`);
      setDetail(null); load();
    } catch (e) { setError(extractErrorMessage(e)); }
  }

  async function rfqAction(action) {
    setError('');
    try {
      await apiClient.post(`/procurement/rfqs/${detail.id}/${action}`);
      setDetail(null); load();
    } catch (e) { setError(extractErrorMessage(e)); }
  }

  const invitedNotYetQuoted = detail
    ? detail.suppliers.filter((s) => !detail.quotations.some((q) => q.supplierId === s.supplierId))
    : [];

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
        <select className="form-select form-select-sm" style={{ width: 200 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {RFQ_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" onClick={() => { setProductId(''); setQuantity(1); setSupplierIds([]); setExpectedDeliveryDate(''); setShowCreate(true); }}>+ New RFQ</button>
      </div>
      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No RFQs yet. A Purchase Request isn't required - an RFQ can be created directly for any product." /> : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead><tr><th>RFQ #</th><th>Items</th><th>Suppliers Invited</th><th>Quotations</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {items.map((rfq) => (
                  <tr key={rfq.id}>
                    <td>{rfq.rfqNumber}</td>
                    <td className="small">{rfq.items.map((i) => `${i.product.name} x${Number(i.quantity)}`).join(', ')}</td>
                    <td className="small">{rfq.suppliers.map((s) => s.supplier.name).join(', ')}</td>
                    <td>{rfq.quotations.length}</td>
                    <td><StatusBadge status={rfq.status} /></td>
                    <td><button className="btn btn-sm btn-outline-primary" onClick={() => openDetail(rfq)}>View &amp; Compare</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        show={showCreate}
        title="New RFQ"
        onClose={() => setShowCreate(false)}
        footer={<button className="btn btn-primary" disabled={!productId || supplierIds.length === 0 || saving} onClick={createRfq}>{saving ? 'Creating...' : 'Create RFQ'}</button>}
      >
        <p className="text-body-secondary small">
          Creating this RFQ makes it ready to share with the invited suppliers by whatever channel your shop
          normally uses (phone, WhatsApp, in person) - this system does not send it automatically.
        </p>
        <div className="mb-3">
          <label className="form-label">Product</label>
          <select className="form-select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Select a product</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="row g-2 mb-3">
          <div className="col-6">
            <label className="form-label">Quantity</label>
            <input type="number" min="1" className="form-control" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="col-6">
            <label className="form-label">Expected delivery</label>
            <input type="date" className="form-control" value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} />
          </div>
        </div>
        <div className="mb-3">
          <label className="form-label">Invite suppliers</label>
          <select multiple className="form-select" style={{ minHeight: 120 }} value={supplierIds}
            onChange={(e) => setSupplierIds(Array.from(e.target.selectedOptions, (o) => o.value))}>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="form-text">Ctrl/Cmd-click to select more than one.</div>
        </div>
      </Modal>

      <Modal
        show={Boolean(detail)}
        title={detail ? `RFQ ${detail.rfqNumber}` : ''}
        onClose={() => setDetail(null)}
        footer={detail?.status === 'OPEN' && (
          <>
            <button className="btn btn-outline-danger" onClick={() => rfqAction('cancel')}>Cancel RFQ</button>
            <button className="btn btn-outline-secondary" onClick={() => rfqAction('close')}>Close (no selection)</button>
          </>
        )}
      >
        {detail && (
          <>
            <p className="small text-body-secondary">
              {detail.items.map((i) => `${i.product.name} x${Number(i.quantity)}`).join(', ')}
              {detail.expectedDeliveryDate && ` · expected ${new Date(detail.expectedDeliveryDate).toLocaleDateString()}`}
              {' · '}<StatusBadge status={detail.status} />
            </p>

            <h6 className="mt-3">Quotations</h6>
            {detail.quotations.length === 0 ? <EmptyState message="No quotations recorded yet." /> : (
              <table className="table table-sm align-middle">
                <thead><tr><th>Supplier</th><th className="text-end">Total</th><th>Delivery</th><th>Valid Until</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {detail.quotations.map((q) => {
                    const isBest = compare?.recommendation?.lowestTotalId === q.id;
                    const isFastest = compare?.recommendation?.fastestDeliveryId === q.id;
                    return (
                      <tr key={q.id}>
                        <td>{q.supplier?.name}</td>
                        <td className="text-end">
                          {money(q.total)}
                          {isBest && <span className="badge text-bg-success ms-1">Lowest total</span>}
                          {isFastest && <span className="badge text-bg-info ms-1">Fastest</span>}
                        </td>
                        <td>{q.deliveryDays != null ? `${q.deliveryDays}d` : '-'}</td>
                        <td>{q.validUntil ? new Date(q.validUntil).toLocaleDateString() : '-'}</td>
                        <td><StatusBadge status={q.status} /></td>
                        <td>
                          {detail.status === 'OPEN' && q.status === 'RECEIVED' && (
                            <button className="btn btn-sm btn-outline-success" onClick={() => selectQuotation(q.id)}>Select &amp; Create PO</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {detail.status === 'OPEN' && invitedNotYetQuoted.length > 0 && (
              <>
                <h6 className="mt-3">Record a supplier's quotation</h6>
                <div className="row g-2">
                  <div className="col-6">
                    <label className="form-label small">Supplier</label>
                    <select className="form-select form-select-sm" value={qSupplierId} onChange={(e) => setQSupplierId(e.target.value)}>
                      <option value="">Select an invited supplier</option>
                      {invitedNotYetQuoted.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.supplier.name}</option>)}
                    </select>
                  </div>
                  <div className="col-6">
                    <label className="form-label small">Unit price (all lines)</label>
                    <input type="number" min="0" step="0.01" className="form-control form-control-sm" value={qUnitPrice} onChange={(e) => setQUnitPrice(e.target.value)} />
                  </div>
                  <div className="col-4">
                    <label className="form-label small">Valid until</label>
                    <input type="date" className="form-control form-control-sm" value={qValidUntil} onChange={(e) => setQValidUntil(e.target.value)} />
                  </div>
                  <div className="col-4">
                    <label className="form-label small">Delivery (days)</label>
                    <input type="number" min="0" className="form-control form-control-sm" value={qDeliveryDays} onChange={(e) => setQDeliveryDays(e.target.value)} />
                  </div>
                  <div className="col-4">
                    <label className="form-label small">Notes</label>
                    <input className="form-control form-control-sm" value={qNotes} onChange={(e) => setQNotes(e.target.value)} />
                  </div>
                </div>
                <button className="btn btn-sm btn-primary mt-2" disabled={!qSupplierId} onClick={addQuotation}>Add Quotation</button>
              </>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}

const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'REJECTED', 'CANCELLED'];

function PurchaseOrders({ canApprove, canEdit }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [unitCost, setUnitCost] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [reconId, setReconId] = useState(null);
  const [recon, setRecon] = useState(null);
  const products = useProducts();
  const suppliers = useSuppliers();

  function load() {
    setLoading(true);
    const params = {};
    if (statusFilter) params.status = statusFilter;
    if (supplierFilter) params.supplierId = supplierFilter;
    apiClient.get('/procurement/purchase-orders', { params }).then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(load, [statusFilter, supplierFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    setSaving(true);
    try {
      await apiClient.post('/procurement/purchase-orders', {
        supplierId,
        items: [{ productId, quantity: Number(quantity), unitCost: Number(unitCost) }],
        notes: notes || undefined,
      });
      setShowModal(false);
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function act(id, action) {
    try {
      await apiClient.post(`/procurement/purchase-orders/${id}/${action}`, action === 'reject' ? { reason: 'Not approved' } : {});
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  async function openReconciliation(id) {
    setError('');
    setReconId(id);
    try {
      const res = await apiClient.get(`/procurement/purchase-orders/${id}/reconciliation`);
      setRecon(res.data);
    } catch (e) { setError(extractErrorMessage(e)); }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
        <div className="d-flex gap-2 flex-wrap">
          <select className="form-select form-select-sm" style={{ width: 180 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {PO_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <select className="form-select form-select-sm" style={{ width: 180 }} value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
            <option value="">All suppliers</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => { setSupplierId(''); setProductId(''); setQuantity(1); setUnitCost(0); setNotes(''); setShowModal(true); }}>+ New Purchase Order</button>
      </div>
      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No purchase orders yet." /> : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead><tr><th>PO #</th><th>Supplier</th><th className="text-end">Total</th><th>Received</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {items.map((po) => {
                  const orderedQty = (po.items || []).reduce((s, i) => s + Number(i.quantity), 0);
                  const receivedQty = (po.items || []).reduce((s, i) => s + Number(i.receivedQuantity), 0);
                  return (
                    <tr key={po.id}>
                      <td>{po.poNumber}</td>
                      <td>{po.supplier?.name}</td>
                      <td className="text-end">{money(po.total)}</td>
                      <td className="small text-body-secondary">{receivedQty} / {orderedQty}</td>
                      <td><StatusBadge status={po.status} /></td>
                      <td>
                        <div className="d-flex gap-1 flex-wrap">
                          {canApprove && po.status === 'PENDING_APPROVAL' && (
                            <>
                              <button className="btn btn-sm btn-outline-success" onClick={() => act(po.id, 'approve')}>Approve</button>
                              <button className="btn btn-sm btn-outline-danger" onClick={() => act(po.id, 'reject')}>Reject</button>
                            </>
                          )}
                          {canEdit && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(po.status) && (
                            <button className="btn btn-sm btn-outline-danger" onClick={() => act(po.id, 'cancel')}>Cancel</button>
                          )}
                          <button className="btn btn-sm btn-outline-secondary" onClick={() => openReconciliation(po.id)}>Reconciliation</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        show={showModal}
        title="New Purchase Order"
        onClose={() => setShowModal(false)}
        footer={<button className="btn btn-primary" disabled={!supplierId || !productId || saving} onClick={create}>{saving ? 'Saving...' : 'Submit'}</button>}
      >
        <div className="mb-3">
          <label className="form-label">Supplier</label>
          <select className="form-select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Select a supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Product</label>
          <select className="form-select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Select a product</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="row g-2">
          <div className="col-6">
            <label className="form-label">Quantity</label>
            <input type="number" min="1" className="form-control" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="col-6">
            <label className="form-label">Unit Cost</label>
            <input type="number" min="0" step="0.01" className="form-control" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </div>
        </div>
        <div className="mb-3 mt-2">
          <label className="form-label">Notes</label>
          <textarea className="form-control" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </Modal>

      <Modal show={Boolean(reconId)} title="Purchase Order Reconciliation" onClose={() => { setReconId(null); setRecon(null); }}>
        {!recon ? <Spinner /> : (
          <>
            <p className="small text-body-secondary">
              {recon.purchaseOrder.poNumber} &middot; <StatusBadge status={recon.purchaseOrder.status} />
              {recon.hasDiscrepancies && <span className="badge text-bg-warning ms-2">Discrepancy found</span>}
            </p>
            <table className="table table-sm align-middle">
              <thead><tr><th>Product</th><th className="text-end">Ordered</th><th className="text-end">Received</th><th className="text-end">Billed</th><th className="text-end">Remaining</th></tr></thead>
              <tbody>
                {recon.lines.map((l) => (
                  <tr key={l.productId} className={l.flags.length ? 'table-warning' : ''}>
                    <td>{l.productName}</td>
                    <td className="text-end">{l.orderedQty}</td>
                    <td className="text-end">{l.receivedQty}</td>
                    <td className="text-end">{l.billedQty}</td>
                    <td className="text-end">{l.remainingQty}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="fw-semibold">
                  <td>Value</td>
                  <td className="text-end">{money(recon.totals.orderedValue)}</td>
                  <td className="text-end">{money(recon.totals.receivedValue)}</td>
                  <td className="text-end">{money(recon.totals.billedValue)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </Modal>
    </div>
  );
}

function GoodsReceipts() {
  const [pos, setPos] = useState([]);
  const [selectedPoId, setSelectedPoId] = useState('');
  const [receivedQty, setReceivedQty] = useState({});
  const [rejectedQty, setRejectedQty] = useState({});
  const [damagedQty, setDamagedQty] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [grns, setGrns] = useState([]);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    Promise.all([
      apiClient.get('/procurement/purchase-orders', { params: { status: 'APPROVED' } }),
      apiClient.get('/procurement/purchase-orders', { params: { status: 'PARTIALLY_RECEIVED' } }),
      apiClient.get('/procurement/goods-receipts'),
    ])
      .then(([approved, partial, receipts]) => {
        setPos([...approved.data.items, ...partial.data.items]);
        setGrns(receipts.data.items);
      })
      .catch((e) => setError(extractErrorMessage(e)))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  const selectedPo = pos.find((p) => p.id === selectedPoId);

  async function submitGrn() {
    setSaving(true);
    setError('');
    try {
      const items = selectedPo.items
        .filter((i) => Number(receivedQty[i.id] || 0) + Number(rejectedQty[i.id] || 0) + Number(damagedQty[i.id] || 0) > 0)
        .map((i) => ({
          purchaseOrderItemId: i.id,
          receivedQuantity: Number(receivedQty[i.id] || 0),
          rejectedQuantity: Number(rejectedQty[i.id] || 0),
          damagedQuantity: Number(damagedQty[i.id] || 0),
        }));
      if (items.length === 0) throw { response: { data: { error: 'Enter at least one received/rejected/damaged quantity' } } };
      await apiClient.post('/procurement/goods-receipts', { purchaseOrderId: selectedPoId, items, idempotencyKey: crypto.randomUUID() });
      setNotice('Goods receipt recorded and stock updated.');
      setSelectedPoId('');
      setReceivedQty({});
      setRejectedQty({});
      setDamagedQty({});
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div>
      {notice && <div className="alert alert-success py-2">{notice}</div>}
      <ErrorAlert message={error} />
      <div className="card mb-3">
        <div className="card-header">Receive against an approved Purchase Order</div>
        <div className="card-body">
          {pos.length === 0 ? (
            <EmptyState message="No approved purchase orders awaiting receipt." />
          ) : (
            <>
              <select className="form-select mb-3" value={selectedPoId} onChange={(e) => setSelectedPoId(e.target.value)}>
                <option value="">Select a purchase order</option>
                {pos.map((po) => <option key={po.id} value={po.id}>{po.poNumber} - {po.supplier?.name}</option>)}
              </select>

              {selectedPo && (
                <>
                  <table className="table table-sm align-middle">
                    <thead><tr><th>Product</th><th>Ordered</th><th>Already Received</th><th>Accepted</th><th>Rejected</th><th>Damaged</th></tr></thead>
                    <tbody>
                      {selectedPo.items.map((i) => {
                        const remaining = Number(i.quantity) - Number(i.receivedQuantity);
                        return (
                          <tr key={i.id}>
                            <td>{i.product.name}</td>
                            <td>{Number(i.quantity)}</td>
                            <td>{Number(i.receivedQuantity)} (remaining {remaining})</td>
                            <td><input type="number" min="0" max={remaining} className="form-control form-control-sm" style={{ width: 90 }}
                              value={receivedQty[i.id] || ''} onChange={(e) => setReceivedQty({ ...receivedQty, [i.id]: e.target.value })} /></td>
                            <td><input type="number" min="0" className="form-control form-control-sm" style={{ width: 90 }}
                              value={rejectedQty[i.id] || ''} onChange={(e) => setRejectedQty({ ...rejectedQty, [i.id]: e.target.value })} /></td>
                            <td><input type="number" min="0" className="form-control form-control-sm" style={{ width: 90 }}
                              value={damagedQty[i.id] || ''} onChange={(e) => setDamagedQty({ ...damagedQty, [i.id]: e.target.value })} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <button className="btn btn-primary" disabled={saving} onClick={submitGrn}>{saving ? 'Recording...' : 'Record Goods Receipt'}</button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">Recent Goods Receipts</div>
        {grns.length === 0 ? <div className="card-body"><EmptyState message="None yet." /></div> : (
          <ul className="list-group list-group-flush">
            {grns.map((g) => (
              <li key={g.id} className="list-group-item d-flex justify-content-between">
                <span>{g.grnNumber} &middot; {g.purchaseOrder?.supplier?.name}</span>
                <span className="text-body-secondary small">{g.purchase ? money(g.purchase.total) : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProcurementReports() {
  const [dashboard, setDashboard] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [supplierId, setSupplierId] = useState('');
  const suppliers = useSuppliers();

  function load() {
    setLoading(true);
    Promise.all([
      apiClient.get('/procurement/dashboard', { params: supplierId ? { supplierId } : {} }),
      apiClient.get('/procurement/summary'),
    ])
      .then(([d, s]) => { setDashboard(d.data); setSummary(s.data); })
      .catch((e) => setError(extractErrorMessage(e)))
      .finally(() => setLoading(false));
  }
  useEffect(load, [supplierId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Spinner />;

  return (
    <div>
      <ErrorAlert message={error} />
      <div className="mb-3">
        <select className="form-select form-select-sm" style={{ width: 220 }} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">All suppliers</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <div className="row g-3 mb-3">
        <div className="col-md-3">
          <div className="card p-3"><div className="text-body-secondary small">Pending PO Approvals</div><div className="fs-4 fw-semibold">{dashboard.pendingApprovals.purchaseOrders}</div></div>
        </div>
        <div className="col-md-3">
          <div className="card p-3"><div className="text-body-secondary small">Pending Request Approvals</div><div className="fs-4 fw-semibold">{dashboard.pendingApprovals.purchaseRequests}</div></div>
        </div>
        <div className="col-md-3">
          <div className="card p-3"><div className="text-body-secondary small">Awaiting Receipt</div><div className="fs-4 fw-semibold">{dashboard.pendingReceipts}</div></div>
        </div>
        <div className="col-md-3">
          <div className="card p-3"><div className="text-body-secondary small">Integrity Findings</div><div className={`fs-4 fw-semibold ${summary.counts.findings > 0 ? 'text-warning' : ''}`}>{summary.counts.findings}</div></div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-header">Purchase orders by status</div>
        <div className="table-responsive">
          <table className="table table-sm mb-0"><thead><tr><th>Status</th><th className="text-end">Count</th><th className="text-end">Value</th></tr></thead>
            <tbody>
              {dashboard.statusSummary.map((s) => (
                <tr key={s.status}><td><StatusBadge status={s.status} /></td><td className="text-end">{s.count}</td><td className="text-end">{money(s.total)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-header">Top suppliers by purchase value</div>
        {dashboard.topSuppliers.length === 0 ? <div className="card-body"><EmptyState message="No purchase orders yet." /></div> : (
          <div className="table-responsive">
            <table className="table table-sm mb-0"><thead><tr><th>Supplier</th><th className="text-end">Orders</th><th className="text-end">Total Value</th></tr></thead>
              <tbody>
                {dashboard.topSuppliers.map((s) => (
                  <tr key={s.supplierId}><td>{s.supplierName}</td><td className="text-end">{s.orderCount}</td><td className="text-end">{money(s.totalValue)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">Data integrity findings</div>
        {summary.findings.length === 0 ? <div className="card-body"><EmptyState message="No discrepancies found." /></div> : (
          <ul className="list-group list-group-flush">
            {summary.findings.map((f, idx) => (
              <li key={idx} className="list-group-item small">
                <span className="badge text-bg-warning me-2">{f.type.replace(/_/g, ' ')}</span>
                {f.poNumber && <span>PO {f.poNumber} </span>}
                {f.grnNumber && <span>GRN {f.grnNumber} </span>}
                {f.rfqNumber && <span>RFQ {f.rfqNumber} </span>}
                {f.ordered != null && <span className="text-body-secondary">(ordered {f.ordered}, received {f.received})</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
