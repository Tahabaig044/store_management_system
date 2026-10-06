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

export default function Customers() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  // Lets the Business Command Center's Receivables widget deep-link here
  // pre-filtered to one customer, via ?search=<name>.
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
  const [editingCustomer, setEditingCustomer] = useState(null);

  const [historyCustomer, setHistoryCustomer] = useState(null);
  const [historyData, setHistoryData] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const activeHistoryIdRef = useRef(null);

  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/customers', { params: { page, pageSize, search: search || undefined, includeInactive: showInactive || undefined } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, showInactive]);

  async function toggleActive(c) {
    setError('');
    try {
      await apiClient.patch(`/customers/${c.id}`, { isActive: !c.isActive });
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  function openCreate() {
    setEditingCustomer(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(c) {
    setEditingCustomer(c);
    setForm({ name: c.name || '', phone: c.phone || '', email: c.email || '', address: c.address || '', code: c.code || '', notes: c.notes || '' });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingCustomer(null);
    setForm(emptyForm);
  }

  // Fetched on demand (never on the main list load) - and any in-flight
  // request from a previously-opened customer is ignored if it resolves
  // after a different customer's history has since been opened, so stale
  // data can never render under the wrong customer's name.
  function openHistory(c) {
    setHistoryCustomer(c);
    setHistoryData(null);
    setHistoryError('');
    setHistoryLoading(true);
    activeHistoryIdRef.current = c.id;

    apiClient
      .get(`/customers/${c.id}/history`)
      .then((res) => {
        if (activeHistoryIdRef.current !== c.id) return;
        setHistoryData(res.data);
      })
      .catch((err) => {
        if (activeHistoryIdRef.current !== c.id) return;
        setHistoryError(extractErrorMessage(err));
      })
      .finally(() => {
        if (activeHistoryIdRef.current !== c.id) return;
        setHistoryLoading(false);
      });
  }

  function closeHistory() {
    activeHistoryIdRef.current = null;
    setHistoryCustomer(null);
    setHistoryData(null);
    setHistoryError('');
    setHistoryLoading(false);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (editingCustomer) {
        await apiClient.patch(`/customers/${editingCustomer.id}`, form);
        closeModal();
        setNotice('Customer updated.');
        load();
        return;
      }

      const entry = await OUTBOXES.customers.submit(tenantId, form);
      if (entry.status === 'conflict' || entry.status === 'failed') {
        setError(`Could not save customer: ${entry.lastError}`);
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
        <h4 className="mb-0">Customers</h4>
        <button className="btn btn-primary" onClick={openCreate}>
          + New Customer
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
            id="showInactiveCustomers"
            checked={showInactive}
            onChange={(e) => {
              setPage(1);
              setShowInactive(e.target.checked);
            }}
          />
          <label className="form-check-label" htmlFor="showInactiveCustomers">
            Show deactivated
          </label>
        </div>
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No customers yet." />
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
                {items.map((c) => (
                  <tr key={c.id} className={!c.isActive ? 'opacity-50' : ''}>
                    <td className="text-body-secondary">{c.code || '-'}</td>
                    <td>{c.name}</td>
                    <td>{c.phone}</td>
                    <td>{c.email}</td>
                    <td>{c.address}</td>
                    {showInactive && (
                      <td>
                        <span className={`badge text-bg-${c.isActive ? 'success' : 'secondary'}`}>
                          {c.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                    )}
                    <td className="d-flex gap-1">
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => openHistory(c)}>
                        History
                      </button>
                      <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(c)}>
                        Edit
                      </button>
                      <button
                        className={`btn btn-sm btn-outline-${c.isActive ? 'danger' : 'success'}`}
                        onClick={() => toggleActive(c)}
                      >
                        {c.isActive ? 'Deactivate' : 'Activate'}
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
        title={editingCustomer ? 'Edit Customer' : 'New Customer'}
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="customer-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="customer-form">
          <div className="mb-2">
            <label className="form-label" htmlFor="customer-name">Name</label>
            <input id="customer-name" className="form-control" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="customer-code">Code</label>
            <input id="customer-code" className="form-control" placeholder="e.g. CUST-0001 (optional)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="customer-phone">Phone</label>
            <input id="customer-phone" className="form-control" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="customer-email">Email</label>
            <input id="customer-email" type="email" className="form-control" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="customer-address">Address</label>
            <input id="customer-address" className="form-control" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="customer-notes">Notes</label>
            <textarea id="customer-notes" className="form-control" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </form>
      </Modal>

      <Modal
        show={!!historyCustomer}
        title={`History - ${historyCustomer?.name || ''}`}
        size="lg"
        onClose={closeHistory}
        footer={
          <button className="btn btn-secondary" onClick={closeHistory}>
            Close
          </button>
        }
      >
        {historyLoading && <Spinner />}
        <ErrorAlert message={historyError} />
        {!historyLoading && !historyError && historyData && (
          <div>
            <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
              <div className="text-body-secondary small">
                {historyData.customer.phone && <span className="me-3">{historyData.customer.phone}</span>}
                {historyData.customer.email && <span>{historyData.customer.email}</span>}
              </div>
              <div className="fw-bold">
                Balance Due: {formatCurrency(historyData.balanceDue)}
              </div>
            </div>

            {historyData.sales.length === 0 && historyData.opticalOrders.length === 0 && historyData.payments.length === 0 && (
              <EmptyState message="No history found." />
            )}

            {historyData.sales.length > 0 && (
              <div className="mb-3">
                <h6>Sales</h6>
                <div className="table-responsive">
                  <table className="table table-sm align-middle">
                    <thead>
                      <tr>
                        <th>Invoice</th>
                        <th>Date</th>
                        <th>Status</th>
                        <th className="text-end">Total</th>
                        <th className="text-end">Paid</th>
                        <th className="text-end">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyData.sales.map((s) => (
                        <tr key={s.id}>
                          <td>{s.invoiceNumber}</td>
                          <td>{new Date(s.createdAt).toLocaleString()}</td>
                          <td><StatusBadge status={s.status} /></td>
                          <td className="text-end">{formatCurrency(s.total)}</td>
                          <td className="text-end">{formatCurrency(s.amountPaid)}</td>
                          <td className="text-end">{formatCurrency(Number(s.total) - Number(s.amountPaid))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {historyData.opticalOrders.length > 0 && (
              <div className="mb-3">
                <h6>Optical Orders</h6>
                <div className="table-responsive">
                  <table className="table table-sm align-middle">
                    <thead>
                      <tr>
                        <th>Order #</th>
                        <th>Date</th>
                        <th>Status</th>
                        <th className="text-end">Total</th>
                        <th className="text-end">Paid</th>
                        <th className="text-end">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyData.opticalOrders.map((o) => (
                        <tr key={o.id}>
                          <td>{o.orderNumber}</td>
                          <td>{new Date(o.createdAt).toLocaleString()}</td>
                          <td><StatusBadge status={o.status} /></td>
                          <td className="text-end">{formatCurrency(o.totalAmount)}</td>
                          <td className="text-end">{formatCurrency(o.amountPaid)}</td>
                          <td className="text-end">{formatCurrency(Number(o.totalAmount) - Number(o.amountPaid))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {historyData.payments.length > 0 && (
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
                      {historyData.payments.map((p) => (
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
