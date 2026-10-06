// Phase 0.4/1.2: user management. Create/edit/deactivate were already
// wired to the backend; Phase 1.2 adds the missing pieces needed to
// actually USE User/Role/Company/Branch/Warehouse management from the app
// rather than only via direct API calls: editing an existing user's
// role/branch, and a per-user "Manage Access" panel over the three existing
// access-grant endpoints (POST/DELETE .../:id/access on companies, branches,
// and warehouses - unchanged here, only newly surfaced in the UI).
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import { Spinner, ErrorAlert, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

const ROLES = ['MANAGER', 'CASHIER', 'STORE_KEEPER', 'RECEPTIONIST', 'ACCOUNTANT', 'DOCTOR', 'TENANT_ADMIN'];
const emptyForm = { name: '', email: '', password: '', role: 'CASHIER', branchId: '' };

export default function Users() {
  const { user: currentUser } = useAuth();

  const [items, setItems] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const [resetLinkInfo, setResetLinkInfo] = useState(null);
  const [accessUser, setAccessUser] = useState(null);
  const [accessData, setAccessData] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [accessError, setAccessError] = useState('');
  const [accessLoading, setAccessLoading] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([apiClient.get('/users'), apiClient.get('/branches', { params: { pageSize: 100 } })])
      .then(([usersRes, branchesRes]) => {
        setItems(usersRes.data.items);
        setBranches(branchesRes.data.items);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function openCreate() {
    setEditingUser(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(u) {
    setEditingUser(u);
    setForm({ name: u.name, email: u.email, password: '', role: u.role, branchId: u.branchId || '' });
    setShowModal(true);
  }

  async function issueResetLink(u) {
    setError('');
    try {
      const res = await apiClient.post(`/users/${u.id}/reset-link`);
      setResetLinkInfo({ user: u, link: res.data.link, expiresAt: res.data.expiresAt });
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  function closeModal() {
    setShowModal(false);
    setEditingUser(null);
    setForm(emptyForm);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingUser) {
        const payload = { name: form.name, role: form.role, branchId: form.branchId || null };
        if (form.password) payload.password = form.password;
        await apiClient.patch(`/users/${editingUser.id}`, payload);
      } else {
        await apiClient.post('/users', { ...form, branchId: form.branchId || undefined });
      }
      closeModal();
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(u) {
    setError('');
    try {
      await apiClient.patch(`/users/${u.id}`, { isActive: !u.isActive });
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function openAccess(u) {
    setAccessUser(u);
    setAccessError('');
    setAccessLoading(true);
    try {
      const [accessRes, companiesRes, warehousesRes] = await Promise.all([
        apiClient.get(`/users/${u.id}/access`),
        apiClient.get('/companies', { params: { pageSize: 100 } }),
        apiClient.get('/warehouses'),
      ]);
      setAccessData(accessRes.data);
      setCompanies(companiesRes.data.items);
      setWarehouses(warehousesRes.data.items);
    } catch (err) {
      setAccessError(extractErrorMessage(err));
    } finally {
      setAccessLoading(false);
    }
  }

  function closeAccess() {
    setAccessUser(null);
    setAccessData(null);
  }

  async function reloadAccess() {
    const res = await apiClient.get(`/users/${accessUser.id}/access`);
    setAccessData(res.data);
  }

  async function grantCompany(companyId) {
    if (!companyId) return;
    setAccessError('');
    try {
      await apiClient.post(`/companies/${companyId}/access`, { userId: accessUser.id });
      await reloadAccess();
    } catch (err) {
      setAccessError(extractErrorMessage(err));
    }
  }

  async function revokeCompany(companyId) {
    setAccessError('');
    try {
      await apiClient.delete(`/companies/${companyId}/access/${accessUser.id}`);
      await reloadAccess();
    } catch (err) {
      setAccessError(extractErrorMessage(err));
    }
  }

  async function grantBranch(branchId) {
    if (!branchId) return;
    setAccessError('');
    try {
      await apiClient.post(`/branches/${branchId}/access`, { userId: accessUser.id });
      await reloadAccess();
    } catch (err) {
      setAccessError(extractErrorMessage(err));
    }
  }

  async function revokeBranch(branchId) {
    setAccessError('');
    try {
      await apiClient.delete(`/branches/${branchId}/access/${accessUser.id}`);
      await reloadAccess();
    } catch (err) {
      setAccessError(extractErrorMessage(err));
    }
  }

  async function grantWarehouse(warehouseId) {
    if (!warehouseId) return;
    setAccessError('');
    try {
      await apiClient.post(`/warehouses/${warehouseId}/access`, { userId: accessUser.id });
      await reloadAccess();
    } catch (err) {
      setAccessError(extractErrorMessage(err));
    }
  }

  async function revokeWarehouse(warehouseId) {
    setAccessError('');
    try {
      await apiClient.delete(`/warehouses/${warehouseId}/access/${accessUser.id}`);
      await reloadAccess();
    } catch (err) {
      setAccessError(extractErrorMessage(err));
    }
  }

  const editingSelf = editingUser && editingUser.id === currentUser?.id;

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Users</h4>
        <button className="btn btn-primary" onClick={openCreate}>
          + New User
        </button>
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Branch</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td><span className="badge text-bg-secondary">{u.role}</span></td>
                    <td className="text-body-secondary">{branches.find((b) => b.id === u.branchId)?.name || '-'}</td>
                    <td><span className={`badge text-bg-${u.isActive ? 'success' : 'danger'}`}>{u.isActive ? 'Active' : 'Inactive'}</span></td>
                    <td className="d-flex gap-1">
                      <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(u)}>
                        Edit
                      </button>
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => issueResetLink(u)}>
                        Reset link
                      </button>
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => openAccess(u)}>
                        Access
                      </button>
                      <button
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => toggleActive(u)}
                        disabled={u.id === currentUser?.id && u.isActive}
                        title={u.id === currentUser?.id && u.isActive ? 'You cannot deactivate your own account' : ''}
                      >
                        {u.isActive ? 'Deactivate' : 'Activate'}
                      </button>
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
        title={editingUser ? 'Edit User' : 'New User'}
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="user-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="user-form">
          <div className="mb-2">
            <label className="form-label">Name</label>
            <input className="form-control" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Email</label>
            <input
              type="email"
              className="form-control"
              required
              disabled={Boolean(editingUser)}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="mb-2">
            <label className="form-label">{editingUser ? 'New Password (leave blank to keep current)' : 'Password'}</label>
            <input
              type="password"
              className="form-control"
              required={!editingUser}
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <div className="mb-2">
            <label className="form-label">Role</label>
            <select
              className="form-select"
              value={form.role}
              disabled={editingSelf}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {editingSelf && <div className="form-text">You cannot change your own role.</div>}
          </div>
          <div className="mb-2">
            <label className="form-label">Branch</label>
            <select className="form-select" value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
              <option value="">No specific branch (tenant-wide, unless granted access below)</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </form>
      </Modal>

      <Modal show={Boolean(resetLinkInfo)} title={resetLinkInfo ? `Password reset link - ${resetLinkInfo.user.name}` : ''} onClose={() => setResetLinkInfo(null)} footer={<button className="btn btn-secondary" onClick={() => setResetLinkInfo(null)}>Close</button>}>
        {resetLinkInfo && (
          <>
            <p>Give this one-time link to {resetLinkInfo.user.name}. It works once, expires {new Date(resetLinkInfo.expiresAt).toLocaleString()} and will not be shown again.</p>
            <input className="form-control" readOnly value={resetLinkInfo.link} onFocus={(e) => e.target.select()} aria-label="Reset link" />
          </>
        )}
      </Modal>

      <Modal show={Boolean(accessUser)} title={accessUser ? `Manage Access - ${accessUser.name}` : ''} onClose={closeAccess} footer={<button className="btn btn-secondary" onClick={closeAccess}>Close</button>}>
        {accessLoading || !accessData ? (
          <Spinner />
        ) : (
          <div>
            <ErrorAlert message={accessError} />
            <p className="text-body-secondary small">
              Primary branch: <strong>{branches.find((b) => b.id === accessData.primaryBranchId)?.name || 'None'}</strong>.
              Grants below give access to ADDITIONAL companies/branches/warehouses beyond the primary branch.
            </p>

            <div className="mb-3">
              <h6>Company-wide access</h6>
              {accessData.companyAccess.map((a) => (
                <div key={a.companyId} className="d-flex justify-content-between align-items-center border-bottom py-1">
                  <span>{a.name}</span>
                  <button className="btn btn-sm btn-outline-danger" onClick={() => revokeCompany(a.companyId)}>Revoke</button>
                </div>
              ))}
              <select className="form-select form-select-sm mt-2" defaultValue="" onChange={(e) => { grantCompany(e.target.value); e.target.value = ''; }}>
                <option value="" disabled>+ Grant access to a company...</option>
                {companies.filter((c) => !accessData.companyAccess.some((a) => a.companyId === c.id)).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="mb-3">
              <h6>Additional branch access</h6>
              {accessData.branchAccess.map((a) => (
                <div key={a.branchId} className="d-flex justify-content-between align-items-center border-bottom py-1">
                  <span>{a.name}</span>
                  <button className="btn btn-sm btn-outline-danger" onClick={() => revokeBranch(a.branchId)}>Revoke</button>
                </div>
              ))}
              <select className="form-select form-select-sm mt-2" defaultValue="" onChange={(e) => { grantBranch(e.target.value); e.target.value = ''; }}>
                <option value="" disabled>+ Grant access to a branch...</option>
                {branches.filter((b) => !accessData.branchAccess.some((a) => a.branchId === b.id)).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>

            <div className="mb-2">
              <h6>Warehouse access (fine-grained, optional)</h6>
              {accessData.warehouseAccess.map((a) => (
                <div key={a.warehouseId} className="d-flex justify-content-between align-items-center border-bottom py-1">
                  <span>{a.name}</span>
                  <button className="btn btn-sm btn-outline-danger" onClick={() => revokeWarehouse(a.warehouseId)}>Revoke</button>
                </div>
              ))}
              <select className="form-select form-select-sm mt-2" defaultValue="" onChange={(e) => { grantWarehouse(e.target.value); e.target.value = ''; }}>
                <option value="" disabled>+ Grant access to a warehouse...</option>
                {warehouses.filter((w) => !accessData.warehouseAccess.some((a) => a.warehouseId === w.id)).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
              <div className="form-text">
                Without any warehouse grant, access follows branch access (every warehouse in an accessible branch).
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
