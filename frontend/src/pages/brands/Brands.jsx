// Phase 1.5: universal Brand catalog management - mirrors Categories.jsx's
// shape exactly, since Brand is the same kind of tenant-owned classification
// master data. Deliberately industry-neutral: no hard-coded suggestions or
// industry-specific naming anywhere on this screen.
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

const emptyForm = { name: '' };

export default function Brands() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('BRAND:CREATE') || hasPermission('BRAND:UPDATE') || hasPermission('BRAND:DELETE');

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
  const [editingBrand, setEditingBrand] = useState(null);
  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/brands', { params: { page, pageSize, search: search || undefined, includeInactive: showInactive || undefined } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, showInactive]);

  function openCreate() {
    setEditingBrand(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(b) {
    setEditingBrand(b);
    setForm({ name: b.name || '' });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingBrand(null);
    setForm(emptyForm);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (editingBrand) {
        await apiClient.patch(`/brands/${editingBrand.id}`, form);
        closeModal();
        setNotice('Brand updated.');
        load();
      } else {
        await apiClient.post('/brands', form);
        closeModal();
        setPage(1);
        setNotice('Brand created.');
        load();
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(b) {
    setError('');
    try {
      if (b.isActive) {
        await apiClient.delete(`/brands/${b.id}`);
      } else {
        await apiClient.patch(`/brands/${b.id}`, { isActive: true });
      }
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Brands</h4>
        {canManage && (
          <button className="btn btn-primary" onClick={openCreate}>
            + New Brand
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
              id="showInactiveBrands"
              checked={showInactive}
              onChange={(e) => {
                setPage(1);
                setShowInactive(e.target.checked);
              }}
            />
            <label className="form-check-label" htmlFor="showInactiveBrands">
              Show deactivated
            </label>
          </div>
        )}
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No brands yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="text-end">Products</th>
                  {showInactive && <th>Status</th>}
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id} className={!b.isActive ? 'opacity-50' : ''}>
                    <td>{b.name}</td>
                    <td className="text-end">{b.productCount ?? 0}</td>
                    {showInactive && (
                      <td>
                        <span className={`badge text-bg-${b.isActive ? 'success' : 'secondary'}`}>
                          {b.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                    )}
                    {canManage && (
                      <td className="d-flex gap-1">
                        <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(b)}>
                          Edit
                        </button>
                        <button
                          className={`btn btn-sm btn-outline-${b.isActive ? 'danger' : 'success'}`}
                          onClick={() => toggleActive(b)}
                        >
                          {b.isActive ? 'Deactivate' : 'Activate'}
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
        title={editingBrand ? 'Edit Brand' : 'New Brand'}
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="brand-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="brand-form">
          <div className="mb-2">
            <label className="form-label" htmlFor="brand-name">Name</label>
            <input id="brand-name" className="form-control" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
        </form>
      </Modal>
    </div>
  );
}
