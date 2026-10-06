import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES, refreshCaches } from '../../offline/syncEngine';
import { useLiveExpenseCategories, useLiveSuppliers } from '../../offline/useOfflineData';
import { PAYMENT_METHODS } from '../../constants/paymentMethods';
import { formatCurrency } from '../../utils/currency';

export default function Expenses() {
  const { user, hasPermission } = useAuth();
  const tenantId = user?.tenantId;
  const categories = useLiveExpenseCategories(tenantId);
  const suppliers = useLiveSuppliers(tenantId);
  const canReverse = hasPermission('EXPENSE:REVERSE');
  const canUpdate = hasPermission('EXPENSE:UPDATE');

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [showCatModal, setShowCatModal] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [form, setForm] = useState({ categoryId: '', amount: '', description: '', notes: '', expenseDate: '', method: 'cash', supplierId: '' });
  const [saving, setSaving] = useState(false);

  const [selected, setSelected] = useState(null);
  const [reversing, setReversing] = useState(false);
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesDraft, setNotesDraft] = useState('');

  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({ categoryId: '', status: '', method: '', search: searchParams.get('search') || '' });

  const pageSize = 20;

  function load() {
    setLoading(true);
    const params = { page, pageSize };
    if (filters.categoryId) params.categoryId = filters.categoryId;
    if (filters.status) params.status = filters.status;
    if (filters.method) params.method = filters.method;
    if (filters.search) params.search = filters.search;
    apiClient
      .get('/expenses', { params })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, filters.categoryId, filters.status, filters.method, filters.search]);

  // Populate/refresh the offline category cache so the expense form's
  // dropdown works even without connectivity.
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
      const entry = await OUTBOXES.expenses.submit(tenantId, {
        categoryId: form.categoryId,
        amount: Number(form.amount),
        description: form.description || undefined,
        notes: form.notes || undefined,
        expenseDate: form.expenseDate || undefined,
        method: form.method,
        supplierId: form.supplierId || undefined,
      });
      if (entry.status === 'conflict' || entry.status === 'failed') {
        setError(`Could not save expense: ${entry.lastError}`);
        return;
      }
      setShowModal(false);
      setForm({ categoryId: '', amount: '', description: '', notes: '', expenseDate: '', method: 'cash', supplierId: '' });
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

  // Expense categories are lightweight master data managed online-only for
  // now (they aren't in the Phase 2 offline-creation scope) - the expense
  // record itself is what needs to work offline.
  async function handleSaveCategory(e) {
    e.preventDefault();
    try {
      await apiClient.post('/expense-categories', { name: newCatName });
      setNewCatName('');
      setShowCatModal(false);
      await refreshCaches(tenantId);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function handleReverse(expense) {
    if (!window.confirm(`Reverse expense ${expense.expenseNumber || ''}? This cannot be undone.`)) return;
    setReversing(true);
    setError('');
    try {
      await apiClient.post(`/expenses/${expense.id}/reverse`);
      setNotice('Expense reversed.');
      setSelected(null);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setReversing(false);
    }
  }

  function openNotesEdit(expense) {
    setEditingNotes(expense.id);
    setNotesDraft(expense.notes || '');
  }

  async function saveNotes(expense) {
    try {
      const res = await apiClient.patch(`/expenses/${expense.id}`, { notes: notesDraft });
      setEditingNotes(null);
      setSelected(res.data.item);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Expenses</h4>
        <div className="d-flex gap-2">
          <button className="btn btn-outline-secondary" onClick={() => setShowCatModal(true)}>
            + Category
          </button>
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            + New Expense
          </button>
        </div>
      </div>

      <div className="row g-2 mb-3">
        <div className="col-auto">
          <select className="form-select form-select-sm" value={filters.categoryId} onChange={(e) => { setPage(1); setFilters({ ...filters, categoryId: e.target.value }); }}>
            <option value="">All Categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="col-auto">
          <select className="form-select form-select-sm" value={filters.status} onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }); }}>
            <option value="">All Statuses</option>
            <option value="PAID">Paid</option>
            <option value="REVERSED">Reversed</option>
          </select>
        </div>
        <div className="col-auto">
          <select className="form-select form-select-sm" value={filters.method} onChange={(e) => { setPage(1); setFilters({ ...filters, method: e.target.value }); }}>
            <option value="">All Payment Methods</option>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div className="col-auto">
          <input className="form-control form-control-sm" placeholder="Search number/description..." value={filters.search} onChange={(e) => { setPage(1); setFilters({ ...filters, search: e.target.value }); }} />
        </div>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No expenses recorded yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th className="text-end">Amount</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} role="button" onClick={() => setSelected(e)}>
                    <td>{e.expenseNumber || '-'}</td>
                    <td>{new Date(e.expenseDate).toLocaleDateString()}</td>
                    <td>{e.category?.name}</td>
                    <td>{e.description}</td>
                    <td><StatusBadge status={e.status || 'PAID'} /></td>
                    <td className="text-end">{formatCurrency(e.amount)}</td>
                    <td>
                      {canReverse && e.status !== 'REVERSED' && (
                        <button
                          className="btn btn-sm btn-outline-danger"
                          onClick={(ev) => { ev.stopPropagation(); handleReverse(e); }}
                          disabled={reversing}
                        >
                          Reverse
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
        title="New Expense"
        onClose={() => setShowModal(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>
              Cancel
            </button>
            <button type="submit" form="expense-form" className="btn btn-primary" disabled={saving || !form.categoryId}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="expense-form">
          <div className="mb-2">
            <label className="form-label">Category</label>
            <select className="form-select" required value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">Select category...</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mb-2">
            <label className="form-label">Amount</label>
            <input type="number" min="0.01" step="0.01" className="form-control" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Payment Method</label>
            <select className="form-select" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="mb-2">
            <label className="form-label">Paid To (optional supplier/payee)</label>
            <select className="form-select" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">None</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="mb-2">
            <label className="form-label">Date</label>
            <input type="date" className="form-control" value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Description</label>
            <input className="form-control" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Notes</label>
            <textarea className="form-control" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </form>
      </Modal>

      <Modal
        show={showCatModal}
        title="New Expense Category"
        onClose={() => setShowCatModal(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowCatModal(false)}>
              Cancel
            </button>
            <button type="submit" form="expense-category-form" className="btn btn-primary">
              Save
            </button>
          </>
        }
      >
        <form onSubmit={handleSaveCategory} id="expense-category-form">
          <label className="form-label">Name</label>
          <input className="form-control" required value={newCatName} onChange={(e) => setNewCatName(e.target.value)} />
        </form>
      </Modal>

      <Modal
        show={!!selected}
        title={`Expense ${selected?.expenseNumber || ''}`}
        onClose={() => { setSelected(null); setEditingNotes(null); }}
        footer={
          canReverse && selected?.status !== 'REVERSED' ? (
            <button className="btn btn-outline-danger" disabled={reversing} onClick={() => handleReverse(selected)}>
              {reversing ? 'Reversing...' : 'Reverse'}
            </button>
          ) : null
        }
      >
        {selected && (
          <div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Status</span>
              <StatusBadge status={selected.status || 'PAID'} />
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Category</span>
              <span>{selected.category?.name}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Amount</span>
              <span>{formatCurrency(selected.amount)}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Date</span>
              <span>{new Date(selected.expenseDate).toLocaleDateString()}</span>
            </div>
            {selected.supplier && (
              <div className="d-flex justify-content-between">
                <span className="text-body-secondary">Paid To</span>
                <span>{selected.supplier.name}</span>
              </div>
            )}
            {selected.description && (
              <div className="mt-2">
                <div className="text-body-secondary small">Description</div>
                <div>{selected.description}</div>
              </div>
            )}
            <div className="mt-2">
              <div className="d-flex justify-content-between align-items-center">
                <div className="text-body-secondary small">Notes</div>
                {canUpdate && editingNotes !== selected.id && (
                  <button className="btn btn-sm btn-link p-0" onClick={() => openNotesEdit(selected)}>Edit</button>
                )}
              </div>
              {editingNotes === selected.id ? (
                <div>
                  <textarea className="form-control form-control-sm mb-1" rows={2} value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} />
                  <button className="btn btn-sm btn-primary" onClick={() => saveNotes(selected)}>Save</button>
                </div>
              ) : (
                <div>{selected.notes || '-'}</div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
