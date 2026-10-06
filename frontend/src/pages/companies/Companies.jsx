// Phase 0.3: Company management - deliberately minimal (list + create/edit,
// mirroring Categories.jsx), since most tenants will only ever have the one
// default company auto-created for them and never need this screen at all.
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

const emptyForm = { name: '', code: '', address: '', phone: '', email: '', logoUrl: '', ntn: '', strn: '' };

export default function Companies() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('COMPANY:CREATE') || hasPermission('COMPANY:UPDATE') || hasPermission('COMPANY:DELETE');

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
  const [editingCompany, setEditingCompany] = useState(null);
  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/companies', { params: { page, pageSize, search: search || undefined, includeInactive: showInactive || undefined } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, showInactive]);

  function openCreate() {
    setEditingCompany(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(c) {
    setEditingCompany(c);
    setForm({
      name: c.name || '',
      code: c.code || '',
      address: c.address || '',
      phone: c.phone || '',
      email: c.email || '',
      logoUrl: c.logoUrl || '',
      ntn: c.ntn || '',
      strn: c.strn || '',
    });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingCompany(null);
    setForm(emptyForm);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (editingCompany) {
        await apiClient.patch(`/companies/${editingCompany.id}`, form);
        closeModal();
        setNotice('Company updated.');
        load();
      } else {
        await apiClient.post('/companies', form);
        closeModal();
        setPage(1);
        setNotice('Company created.');
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
        await apiClient.delete(`/companies/${c.id}`);
      } else {
        await apiClient.patch(`/companies/${c.id}`, { isActive: true });
      }
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function makeDefault(c) {
    setError('');
    try {
      await apiClient.patch(`/companies/${c.id}`, { isDefault: true });
      setNotice(`${c.name} is now the default company.`);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Companies</h4>
        {canManage && (
          <button className="btn btn-primary" onClick={openCreate}>
            + New Company
          </button>
        )}
      </div>

      <p className="text-body-secondary small">
        Most businesses only need one company - it was created automatically for you. Add another only if you operate more
        than one distinct legal/business entity under this account.
      </p>

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
              id="showInactiveCompanies"
              checked={showInactive}
              onChange={(e) => {
                setPage(1);
                setShowInactive(e.target.checked);
              }}
            />
            <label className="form-check-label" htmlFor="showInactiveCompanies">
              Show deactivated
            </label>
          </div>
        )}
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No companies yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Code</th>
                  <th>Default</th>
                  {showInactive && <th>Status</th>}
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className={!c.isActive ? 'opacity-50' : ''}>
                    <td>{c.name}</td>
                    <td className="text-body-secondary">{c.code}</td>
                    <td>
                      {c.isDefault ? (
                        <span className="badge text-bg-primary">Default</span>
                      ) : (
                        canManage &&
                        c.isActive && (
                          <button className="btn btn-sm btn-link p-0" onClick={() => makeDefault(c)}>
                            Set as default
                          </button>
                        )
                      )}
                    </td>
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
        title={editingCompany ? 'Edit Company' : 'New Company'}
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="company-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="company-form">
          <div className="mb-2">
            <label className="form-label">Name</label>
            <input className="form-control" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Code</label>
            <input className="form-control" placeholder="e.g. MAIN" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Address</label>
            <input className="form-control" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div className="row">
            <div className="col-6 mb-2">
              <label className="form-label">Phone</label>
              <input className="form-control" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="col-6 mb-2">
              <label className="form-label">Email</label>
              <input type="email" className="form-control" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <div className="mb-2">
            <label className="form-label">Logo URL</label>
            <input className="form-control" value={form.logoUrl} onChange={(e) => setForm({ ...form, logoUrl: e.target.value })} />
          </div>
          <div className="row">
            <div className="col-6 mb-2">
              <label className="form-label">NTN</label>
              <input className="form-control" value={form.ntn} onChange={(e) => setForm({ ...form, ntn: e.target.value })} />
            </div>
            <div className="col-6 mb-2">
              <label className="form-label">STRN</label>
              <input className="form-control" value={form.strn} onChange={(e) => setForm({ ...form, strn: e.target.value })} />
            </div>
          </div>
        </form>
      </Modal>
    </div>
  );
}
