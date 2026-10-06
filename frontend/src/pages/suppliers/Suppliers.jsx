import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES } from '../../offline/syncEngine';
import { formatCurrency } from '../../utils/currency';

const emptyForm = { name: '', phone: '', email: '', address: '', code: '', notes: '' };

export default function Suppliers() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  // Lets the Business Command Center's Payables widget deep-link here
  // pre-filtered to one supplier, via ?search=<name>.
  const [searchParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(null);

  const [ledgerSupplier, setLedgerSupplier] = useState(null);
  const [ledgerData, setLedgerData] = useState(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState('');
  const activeLedgerIdRef = useRef(null);

  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/suppliers', { params: { page, pageSize, search: search || undefined, includeInactive: showInactive || undefined } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, showInactive]);

  async function toggleActive(s) {
    setError('');
    try {
      await apiClient.patch(`/suppliers/${s.id}`, { isActive: !s.isActive });
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  function openCreate() {
    setEditingSupplier(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(s) {
    setEditingSupplier(s);
    setForm({ name: s.name || '', phone: s.phone || '', email: s.email || '', address: s.address || '', code: s.code || '', notes: s.notes || '' });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingSupplier(null);
    setForm(emptyForm);
  }

  // Fetched on demand (never on the main list load) - a stale in-flight
  // request from a previously-opened supplier is ignored if it resolves
  // after a different supplier's ledger has since been opened.
  function openLedger(s) {
    setLedgerSupplier(s);
    setLedgerData(null);
    setLedgerError('');
    setLedgerLoading(true);
    activeLedgerIdRef.current = s.id;

    apiClient
      .get(`/suppliers/${s.id}/ledger`)
      .then((res) => {
        if (activeLedgerIdRef.current !== s.id) return;
        setLedgerData(res.data);
      })
      .catch((err) => {
        if (activeLedgerIdRef.current !== s.id) return;
        setLedgerError(extractErrorMessage(err));
      })
      .finally(() => {
        if (activeLedgerIdRef.current !== s.id) return;
        setLedgerLoading(false);
      });
  }

  function closeLedger() {
    activeLedgerIdRef.current = null;
    setLedgerSupplier(null);
    setLedgerData(null);
    setLedgerError('');
    setLedgerLoading(false);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (editingSupplier) {
        await apiClient.patch(`/suppliers/${editingSupplier.id}`, form);
        closeModal();
        setNotice('Supplier updated.');
        load();
        return;
      }

      const entry = await OUTBOXES.suppliers.submit(tenantId, form);
      if (entry.status === 'conflict' || entry.status === 'failed') {
        setError(`Could not save supplier: ${entry.lastError}`);
        return;
      }
      closeModal();
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

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Suppliers</h4>
        <button className="btn btn-primary" onClick={openCreate}>
          + New Supplier
        </button>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}

      <div className="d-flex flex-wrap gap-3 mb-3">
        <input
          className="form-control"
          style={{ maxWidth: 320 }}
          placeholder="Search by name, phone, email..."
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
        <div className="form-check align-self-center">
          <input
            className="form-check-input"
            type="checkbox"
            id="showInactiveSuppliers"
            checked={showInactive}
            onChange={(e) => {
              setPage(1);
              setShowInactive(e.target.checked);
            }}
          />
          <label className="form-check-label" htmlFor="showInactiveSuppliers">
            Show deactivated
          </label>
        </div>
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No suppliers yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Email</th>
                  <th>Address</th>
                  {showInactive && <th>Status</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className={!s.isActive ? 'opacity-50' : ''}>
                    <td className="text-body-secondary">{s.code || '-'}</td>
                    <td>{s.name}</td>
                    <td>{s.phone}</td>
                    <td>{s.email}</td>
                    <td>{s.address}</td>
                    {showInactive && (
                      <td>
                        <span className={`badge text-bg-${s.isActive ? 'success' : 'secondary'}`}>
                          {s.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                    )}
                    <td className="d-flex gap-1">
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => openLedger(s)}>
                        Ledger
                      </button>
                      <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(s)}>
                        Edit
                      </button>
                      <button
                        className={`btn btn-sm btn-outline-${s.isActive ? 'danger' : 'success'}`}
                        onClick={() => toggleActive(s)}
                      >
                        {s.isActive ? 'Deactivate' : 'Activate'}
                      </button>
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
        title={editingSupplier ? 'Edit Supplier' : 'New Supplier'}
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="supplier-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="supplier-form">
          <div className="mb-2">
            <label className="form-label" htmlFor="supplier-name">Name</label>
            <input id="supplier-name" className="form-control" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="supplier-code">Code</label>
            <input id="supplier-code" className="form-control" placeholder="e.g. SUP-0001 (optional)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="supplier-phone">Phone</label>
            <input id="supplier-phone" className="form-control" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="supplier-email">Email</label>
            <input id="supplier-email" type="email" className="form-control" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="supplier-address">Address</label>
            <input id="supplier-address" className="form-control" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="supplier-notes">Notes</label>
            <textarea id="supplier-notes" className="form-control" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </form>
      </Modal>

      <Modal
        show={!!ledgerSupplier}
        title={`Ledger - ${ledgerSupplier?.name || ''}`}
        size="lg"
        onClose={closeLedger}
        footer={
          <button className="btn btn-secondary" onClick={closeLedger}>
            Close
          </button>
        }
      >
        {ledgerLoading && <Spinner />}
        <ErrorAlert message={ledgerError} />
        {!ledgerLoading && !ledgerError && ledgerData && (
          <div>
            <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
              <div className="text-body-secondary small">
                {ledgerData.supplier.phone && <span className="me-3">{ledgerData.supplier.phone}</span>}
                {ledgerData.supplier.email && <span>{ledgerData.supplier.email}</span>}
              </div>
              <div className="fw-bold">
                Balance Due: {formatCurrency(ledgerData.balanceDue)}
              </div>
            </div>

            {ledgerData.purchases.length === 0 && ledgerData.payments.length === 0 && (
              <EmptyState message="No history found." />
            )}

            {ledgerData.purchases.length > 0 && (
              <div className="mb-3">
                <h6>Purchases</h6>
                <div className="table-responsive">
                  <table className="table table-sm align-middle">
                    <thead>
                      <tr>
                        <th>PO #</th>
                        <th>Date</th>
                        <th>Status</th>
                        <th className="text-end">Total</th>
                        <th className="text-end">Paid</th>
                        <th className="text-end">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledgerData.purchases.map((p) => (
                        <tr key={p.id}>
                          <td>{p.purchaseNumber}</td>
                          <td>{new Date(p.createdAt).toLocaleString()}</td>
                          <td><StatusBadge status={p.paymentStatus} /></td>
                          <td className="text-end">{formatCurrency(p.total)}</td>
                          <td className="text-end">{formatCurrency(p.amountPaid)}</td>
                          <td className="text-end">{formatCurrency(Number(p.total) - Number(p.amountPaid))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {ledgerData.payments.length > 0 && (
              <div>
                <h6>Payments</h6>
                <div className="table-responsive">
                  <table className="table table-sm align-middle">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Method</th>
                        <th className="text-end">Amount</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledgerData.payments.map((p) => (
                        <tr key={p.id}>
                          <td>{new Date(p.paidAt).toLocaleString()}</td>
                          <td className="text-capitalize">{p.method}</td>
                          <td className="text-end">{formatCurrency(p.amount)}</td>
                          <td>{p.note || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
