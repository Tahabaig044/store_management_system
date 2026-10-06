import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

// Phase 0.3: companyId defaults to '' (server auto-assigns the tenant's
// default company when omitted) rather than being required here, matching
// the backend's own optional-with-lazy-default design.
const emptyForm = { companyId: '', name: '', code: '', address: '', phone: '' };

export default function Branches() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('BRANCH:CREATE') || hasPermission('BRANCH:UPDATE') || hasPermission('BRANCH:DELETE');

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
  const [editingBranch, setEditingBranch] = useState(null);
  const [companies, setCompanies] = useState([]);
  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/branches', { params: { page, pageSize, search: search || undefined, includeInactive: showInactive || undefined } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, showInactive]);
  useEffect(() => {
    apiClient.get('/companies', { params: { pageSize: 100 } }).then((res) => setCompanies(res.data.items));
  }, []);

  function companyName(companyId) {
    return companies.find((c) => c.id === companyId)?.name || '—';
  }

  function openCreate() {
    setEditingBranch(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(b) {
    setEditingBranch(b);
    setForm({ companyId: b.companyId || '', name: b.name || '', code: b.code || '', address: b.address || '', phone: b.phone || '' });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingBranch(null);
    setForm(emptyForm);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      // An empty selector means "let the server pick the default company" -
      // must be omitted, not sent as '', since the server's schema expects
      // a real uuid or nothing.
      const payload = { ...form, companyId: form.companyId || undefined };
      if (editingBranch) {
        await apiClient.patch(`/branches/${editingBranch.id}`, payload);
        closeModal();
        setNotice('Branch updated.');
        load();
      } else {
        await apiClient.post('/branches', payload);
        closeModal();
        setPage(1);
        setNotice('Branch created.');
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
        await apiClient.delete(`/branches/${b.id}`);
      } else {
        await apiClient.patch(`/branches/${b.id}`, { isActive: true });
      }
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function toggleOpen(b) {
    setError('');
    try {
      await apiClient.patch(`/branches/${b.id}`, { isOpen: !b.isOpen });
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function makeMain(b) {
    setError('');
    try {
      await apiClient.patch(`/branches/${b.id}`, { isMain: true });
      setNotice(`${b.name} is now the Main branch.`);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Branches</h4>
        {canManage && (
          <button className="btn btn-primary" onClick={openCreate}>
            + New Branch
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
              id="showInactiveBranches"
              checked={showInactive}
              onChange={(e) => {
                setPage(1);
                setShowInactive(e.target.checked);
              }}
            />
            <label className="form-check-label" htmlFor="showInactiveBranches">
              Show deactivated
            </label>
          </div>
        )}
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No branches yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Code</th>
                  <th>Phone</th>
                  <th>Address</th>
                  <th>Open</th>
                  {showInactive && <th>Status</th>}
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id} className={!b.isActive ? 'opacity-50' : ''}>
                    <td>
                      {b.name}
                      {b.isMain && <span className="badge text-bg-primary ms-2">Main</span>}
                    </td>
                    <td className="text-body-secondary">{companyName(b.companyId)}</td>
                    <td className="text-body-secondary">{b.code}</td>
                    <td>{b.phone}</td>
                    <td>{b.address}</td>
                    <td>
                      <span className={`badge text-bg-${b.isOpen ? 'success' : 'secondary'}`}>{b.isOpen ? 'Open' : 'Closed'}</span>
                    </td>
                    {showInactive && (
                      <td>
                        <span className={`badge text-bg-${b.isActive ? 'success' : 'secondary'}`}>
                          {b.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                    )}
                    {canManage && (
                      <td className="d-flex gap-1 flex-wrap">
                        <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(b)}>
                          Edit
                        </button>
                        {!b.isMain && b.isActive && (
                          <button className="btn btn-sm btn-outline-secondary" onClick={() => makeMain(b)}>
                            Set as Main
                          </button>
                        )}
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => toggleOpen(b)}>
                          {b.isOpen ? 'Close' : 'Reopen'}
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
        title={editingBranch ? 'Edit Branch' : 'New Branch'}
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="branch-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="branch-form">
          <div className="mb-2">
            <label className="form-label" htmlFor="branch-company">Company</label>
            <select
              id="branch-company"
              className="form-select"
              value={form.companyId}
              onChange={(e) => setForm({ ...form, companyId: e.target.value })}
            >
              <option value="">Default company</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mb-2">
            <label className="form-label">Name</label>
            <input
              className="form-control"
              required
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="mb-2">
            <label className="form-label">Code</label>
            <input className="form-control" placeholder="e.g. B02" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Phone</label>
            <input className="form-control" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Address</label>
            <input className="form-control" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
        </form>
      </Modal>
    </div>
  );
}
