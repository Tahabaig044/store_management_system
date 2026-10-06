// Phase 1.13: Supplier Debit Notes - mirrors CreditNotes.jsx exactly for the
// supplier side. Most debit notes are created automatically as a side effect
// of a Purchase Return (see the "Return" action on the Purchases page); this
// page's own "+ New Debit Note" is for the standalone case (a supplier
// credit adjustment with no physical return involved).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { useLiveSuppliers } from '../../offline/useOfflineData';
import { PAYMENT_METHODS } from '../../constants/paymentMethods';
import { formatCurrency } from '../../utils/currency';

export default function DebitNotes() {
  const { user, hasPermission } = useAuth();
  const tenantId = user?.tenantId;
  const suppliers = useLiveSuppliers(tenantId);
  const canCreate = hasPermission('DEBIT_NOTE:CREATE');
  const canCancel = hasPermission('DEBIT_NOTE:REVERSE');
  const canRefund = hasPermission('DEBIT_NOTE:REFUND');

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({ supplierId: '', status: '', search: searchParams.get('search') || '' });

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ supplierId: '', amount: '', reason: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundMethod, setRefundMethod] = useState('cash');

  const pageSize = 20;

  function load() {
    setLoading(true);
    const params = { page, pageSize };
    if (filters.supplierId) params.supplierId = filters.supplierId;
    if (filters.status) params.status = filters.status;
    if (filters.search) params.search = filters.search;
    apiClient
      .get('/debit-notes', { params })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, filters.supplierId, filters.status, filters.search]);

  function remainingOf(dn) {
    return Math.max(Number(dn.amount) - Number(dn.refundedAmount || 0), 0);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/debit-notes', {
        supplierId: form.supplierId,
        amount: Number(form.amount),
        reason: form.reason,
        notes: form.notes || undefined,
      });
      setShowModal(false);
      setForm({ supplierId: '', amount: '', reason: '', notes: '' });
      setNotice('Debit note created.');
      setPage(1);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(dn) {
    setError('');
    try {
      const res = await apiClient.get(`/debit-notes/${dn.id}`);
      setSelected(res.data.item);
      setRefundAmount('');
      setRefundMethod('cash');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function handleCancel(dn) {
    if (!window.confirm(`Cancel debit note ${dn.debitNoteNumber || ''}? This cannot be undone.`)) return;
    setBusy(true);
    setError('');
    try {
      await apiClient.post(`/debit-notes/${dn.id}/cancel`);
      setNotice('Debit note cancelled.');
      setSelected(null);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRefund(dn) {
    const amount = Number(refundAmount);
    const remaining = remainingOf(dn);
    if (!refundAmount || Number.isNaN(amount) || amount <= 0) {
      setError('Enter a valid refund amount greater than 0.');
      return;
    }
    if (amount > remaining) {
      setError(`Refund cannot exceed the remaining balance (${formatCurrency(remaining)}).`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiClient.post(`/debit-notes/${dn.id}/refund`, { amount, method: refundMethod });
      setNotice('Refund recorded.');
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
        <h4 className="mb-0">Debit Notes</h4>
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            + New Debit Note
          </button>
        )}
      </div>

      <div className="row g-2 mb-3">
        <div className="col-auto">
          <select
            className="form-select form-select-sm"
            value={filters.supplierId}
            onChange={(e) => { setPage(1); setFilters({ ...filters, supplierId: e.target.value }); }}
          >
            <option value="">All Suppliers</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="col-auto">
          <select
            className="form-select form-select-sm"
            value={filters.status}
            onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }); }}
          >
            <option value="">All Statuses</option>
            <option value="ISSUED">Issued</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <div className="col-auto">
          <input
            className="form-control form-control-sm"
            placeholder="Search debit note #..."
            value={filters.search}
            onChange={(e) => { setPage(1); setFilters({ ...filters, search: e.target.value }); }}
          />
        </div>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No debit notes yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th className="text-end">Amount</th>
                  <th className="text-end">Refunded</th>
                </tr>
              </thead>
              <tbody>
                {items.map((dn) => (
                  <tr key={dn.id} role="button" onClick={() => openDetail(dn)}>
                    <td>{dn.debitNoteNumber || '-'}</td>
                    <td>{new Date(dn.createdAt).toLocaleDateString()}</td>
                    <td>{dn.supplier?.name || '-'}</td>
                    <td>{dn.purchaseReturn?.returnNumber ? `Return ${dn.purchaseReturn.returnNumber}` : 'Standalone'}</td>
                    <td><StatusBadge status={dn.status} /></td>
                    <td className="text-end">{formatCurrency(dn.amount)}</td>
                    <td className="text-end">{formatCurrency(dn.refundedAmount || 0)}</td>
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
        title="New Debit Note"
        onClose={() => setShowModal(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            <button type="submit" form="debit-note-form" className="btn btn-primary" disabled={saving || !form.supplierId}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="debit-note-form">
          <div className="mb-2">
            <label className="form-label">Supplier</label>
            <select className="form-select" required value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">Select supplier...</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="mb-2">
            <label className="form-label">Amount</label>
            <input type="number" min="0.01" step="0.01" className="form-control" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Reason</label>
            <input className="form-control" required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Notes</label>
            <textarea className="form-control" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </form>
      </Modal>

      <Modal
        show={!!selected}
        title={`Debit Note ${selected?.debitNoteNumber || ''}`}
        onClose={() => setSelected(null)}
        footer={
          selected && selected.status === 'ISSUED' ? (
            <>
              {canCancel && !selected.purchaseReturnId && Number(selected.refundedAmount) === 0 && (
                <button className="btn btn-outline-danger" disabled={busy} onClick={() => handleCancel(selected)}>
                  Cancel Note
                </button>
              )}
              {canRefund && remainingOf(selected) > 0 && (
                <button className="btn btn-primary" disabled={busy} onClick={() => handleRefund(selected)}>
                  {busy ? 'Processing...' : 'Refund'}
                </button>
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
              <span className="text-body-secondary">Supplier</span>
              <span>{selected.supplier?.name}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Amount</span>
              <span>{formatCurrency(selected.amount)}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Refunded</span>
              <span>{formatCurrency(selected.refundedAmount || 0)}</span>
            </div>
            <div className="d-flex justify-content-between fw-bold">
              <span>Remaining</span>
              <span>{formatCurrency(remainingOf(selected))}</span>
            </div>
            {selected.purchaseReturn?.returnNumber && (
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Linked Return</span>
                <span>{selected.purchaseReturn.returnNumber}</span>
              </div>
            )}
            {selected.reason && (
              <div className="mt-2">
                <div className="text-body-secondary small">Reason</div>
                <div>{selected.reason}</div>
              </div>
            )}
            {selected.purchaseReturnId && (
              <div className="alert alert-secondary mt-3 py-2 small mb-0">
                This note was issued alongside a Purchase Return - cancel it from the Purchases list instead.
              </div>
            )}
            {canRefund && selected.status === 'ISSUED' && remainingOf(selected) > 0 && (
              <div className="row g-2 mt-2">
                <div className="col-6">
                  <label className="form-label">Refund Amount</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={remainingOf(selected)}
                    className="form-control"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label">Method</label>
                  <select className="form-select" value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                    {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
