import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

const emptyForm = { name: '', parentId: '' };

export default function Categories() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('CATEGORY:CREATE') || hasPermission('CATEGORY:UPDATE') || hasPermission('CATEGORY:DELETE');

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [allCategories, setAllCategories] = useState([]);
  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/categories', { params: { page, pageSize, search: search || undefined, includeInactive: showInactive || undefined } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, showInactive]);
  useEffect(() => {
    apiClient.get('/categories', { params: { pageSize: 100 } }).then((res) => setAllCategories(res.data.items));
  }, [items]);

  function openCreate() {
    setEditingCategory(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(c) {
    setEditingCategory(c);
    setForm({ name: c.name || '', parentId: c.parentId || '' });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingCategory(null);
    setForm(emptyForm);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = { name: form.name, parentId: form.parentId || null };
      if (editingCategory) {
        await apiClient.patch(`/categories/${editingCategory.id}`, payload);
        closeModal();
        setNotice('Category updated.');
        load();
      } else {
        await apiClient.post('/categories', payload);
        closeModal();
        setPage(1);
        setNotice('Category created.');
        load();
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(c) {
    setError('');
    try {
      if (c.isActive) {
        await apiClient.delete(`/categories/${c.id}`);
      } else {
        await apiClient.patch(`/categories/${c.id}`, { isActive: true });
      }
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Categories</h4>
        {canManage && (
          <button className="btn btn-primary" onClick={openCreate}>
            + New Category
          </button>
        )}
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}

      <div className="d-flex flex-wrap gap-3 mb-3">
        <input
          className="form-control"
          style={{ maxWidth: 320 }}
          placeholder="Search by name..."
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
        {canManage && (
          <div className="form-check align-self-center">
            <input
              className="form-check-input"
              type="checkbox"
              id="showInactiveCategories"
              checked={showInactive}
              onChange={(e) => {
                setPage(1);
                setShowInactive(e.target.checked);
              }}
            />
            <label className="form-check-label" htmlFor="showInactiveCategories">
              Show deactivated
            </label>
          </div>
        )}
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No categories yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Parent</th>
                  <th className="text-end">Products</th>
                  <th>Updated</th>
                  {showInactive && <th>Status</th>}
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className={!c.isActive ? 'opacity-50' : ''}>
                    <td>{c.name}</td>
                    <td className="text-body-secondary">{c.parent?.name || '-'}</td>
                    <td className="text-end">{c.productCount ?? 0}</td>
                    <td>{c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : '—'}</td>
                    {showInactive && (
                      <td>
                        <span className={`badge text-bg-${c.isActive ? 'success' : 'secondary'}`}>
                          {c.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                    )}
                    {canManage && (
                      <td className="d-flex gap-1">
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
                    )}
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
        title={editingCategory ? 'Edit Category' : 'New Category'}
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="category-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="category-form">
          <div className="mb-2">
            <label className="form-label" htmlFor="category-name">Name</label>
            <input
              id="category-name"
              className="form-control"
              required
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="category-parent">Parent Category (optional)</label>
            <select id="category-parent" className="form-select" value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
              <option value="">None (top-level)</option>
              {allCategories
                .filter((c) => c.id !== editingCategory?.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
        </form>
      </Modal>
    </div>
  );
}
