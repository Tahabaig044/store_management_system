// Phase 2.1: Chart of Accounts - hierarchy/tree view with create, edit, view,
// deactivate/reactivate and delete. All rules (parent/type consistency, safe
// deactivation, duplicate codes) are enforced by the backend; this page only
// surfaces them. Controls are permission-driven (ACCOUNT:*).
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency } from '../../utils/currency';

const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
const EMPTY_FORM = { code: '', name: '', type: 'ASSET', parentId: '', description: '' };

function flatten(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    out.push({ ...n, depth });
    flatten(n.children || [], depth + 1, out);
  }
  return out;
}

export default function ChartOfAccounts() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('ACCOUNT:CREATE');
  const canUpdate = hasPermission('ACCOUNT:UPDATE');
  const canDelete = hasPermission('ACCOUNT:DELETE');

  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // account being edited, or null for create
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState(null);

  function load() {
    setLoading(true);
    apiClient
      .get('/accounting/accounts/tree', { params: { withBalances: 'true', includeInactive: showInactive ? 'true' : undefined } })
      .then((res) => setTree(res.data.items))
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }
  useEffect(load, [showInactive]);

  const rows = flatten(tree);

  function openCreate(parent) {
    setEditing(null);
    setFormError('');
    setForm({ ...EMPTY_FORM, ...(parent ? { type: parent.type, parentId: parent.id } : {}) });
    setFormOpen(true);
  }

  function openEdit(account) {
    setEditing(account);
    setFormError('');
    setForm({ code: account.code, name: account.name, type: account.type, parentId: account.parentId || '', description: account.description || '' });
    setFormOpen(true);
  }

  async function openDetail(account) {
    setError('');
    try {
      const res = await apiClient.get(`/accounting/accounts/${account.id}`);
      setDetail(res.data.item);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editing) {
        const body = { name: form.name, code: form.code, description: form.description || null };
        if (!editing.isSystem) body.parentId = form.parentId || null;
        await apiClient.patch(`/accounting/accounts/${editing.id}`, body);
        setNotice(`Account ${form.code} updated.`);
      } else {
        await apiClient.post('/accounting/accounts', {
          code: form.code,
          name: form.name,
          type: form.type,
          parentId: form.parentId || undefined,
          description: form.description || undefined,
        });
        setNotice(`Account ${form.code} created.`);
      }
      setFormOpen(false);
      load();
    } catch (err) {
      setFormError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(account) {
    setError('');
    setNotice('');
    try {
      await apiClient.patch(`/accounting/accounts/${account.id}`, { isActive: !account.isActive });
      setNotice(`Account ${account.code} ${account.isActive ? 'deactivated' : 'reactivated'}.`);
      setDetail(null);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function remove(account) {
    if (!window.confirm(`Delete account ${account.code} - ${account.name}?`)) return;
    setError('');
    try {
      await apiClient.delete(`/accounting/accounts/${account.id}`);
      setNotice(`Account ${account.code} deleted.`);
      setDetail(null);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  // Parent choices for the form: same type only, never the account itself.
  const parentOptions = flatten(tree).filter((a) => a.type === form.type && a.isActive && a.id !== editing?.id);

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Chart of Accounts</h4>
        <div className="d-flex align-items-center gap-3">
          <div className="form-check mb-0">
            <input id="showInactive" className="form-check-input" type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            <label htmlFor="showInactive" className="form-check-label small">Show inactive</label>
          </div>
          {canCreate && (
            <button className="btn btn-primary" onClick={() => openCreate(null)}>
              + New Account
            </button>
          )}
        </div>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState message="No accounts yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="text-end">Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={a.isActive ? '' : 'text-body-secondary'}>
                    <td>{a.code}</td>
                    <td style={{ paddingLeft: `${0.75 + a.depth * 1.5}rem` }}>
                      <button className="btn btn-link p-0 text-start" onClick={() => openDetail(a)}>
                        {a.name}
                      </button>
                      {a.isSystem && <span className="badge text-bg-light border ms-2">System</span>}
                      {!a.isActive && <span className="badge text-bg-secondary ms-2">Inactive</span>}
                    </td>
                    <td>{a.type}</td>
                    <td className="text-end">{formatCurrency(a.children?.length ? a.rolledUpBalance : a.balance)}</td>
                    <td className="text-end text-nowrap">
                      {canCreate && a.isActive && (
                        <button className="btn btn-sm btn-outline-secondary me-1" onClick={() => openCreate(a)}>
                          + Sub-account
                        </button>
                      )}
                      {canUpdate && (
                        <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(a)}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        show={formOpen}
        title={editing ? `Edit Account ${editing.code}` : 'New Account'}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setFormOpen(false)}>Cancel</button>
            <button type="submit" form="account-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <ErrorAlert message={formError} />
        <form id="account-form" onSubmit={handleSave}>
          <div className="mb-2">
            <label className="form-label">Code</label>
            <input className="form-control" required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Name</label>
            <input className="form-control" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label">Type</label>
            <select className="form-select" value={form.type} disabled={!!editing} onChange={(e) => setForm({ ...form, type: e.target.value, parentId: '' })}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {editing && <div className="form-text">The account type cannot be changed once created.</div>}
          </div>
          <div className="mb-2">
            <label className="form-label">Parent account</label>
            <select className="form-select" value={form.parentId} disabled={!!editing?.isSystem} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
              <option value="">(none - top level)</option>
              {parentOptions.map((a) => (
                <option key={a.id} value={a.id}>{`${'  '.repeat(a.depth)}${a.code} - ${a.name}`}</option>
              ))}
            </select>
          </div>
          <div className="mb-2">
            <label className="form-label">Description</label>
            <textarea className="form-control" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        </form>
      </Modal>

      <Modal
        show={!!detail}
        title={detail ? `${detail.code} - ${detail.name}` : ''}
        onClose={() => setDetail(null)}
        footer={
          detail && (
            <>
              {canUpdate && !detail.isSystem && (
                <button className="btn btn-outline-secondary" onClick={() => toggleActive(detail)}>
                  {detail.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              )}
              {canDelete && !detail.isSystem && (
                <button className="btn btn-outline-danger" onClick={() => remove(detail)}>Delete</button>
              )}
            </>
          )
        }
      >
        {detail && (
          <div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Type</span><span>{detail.type}</span></div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Parent</span><span>{detail.parent ? `${detail.parent.code} - ${detail.parent.name}` : '-'}</span></div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Status</span><span>{detail.isActive ? 'Active' : 'Inactive'}{detail.isSystem ? ' (system)' : ''}</span></div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Total debits</span><span>{formatCurrency(detail.totalDebit)}</span></div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Total credits</span><span>{formatCurrency(detail.totalCredit)}</span></div>
            <div className="d-flex justify-content-between fw-bold"><span>Balance</span><span>{formatCurrency(detail.balance)}</span></div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Journal lines</span><span>{detail.lineCount}</span></div>
            {detail.description && <div className="mt-2"><div className="text-body-secondary small">Description</div><div>{detail.description}</div></div>}
            {detail.children?.length > 0 && (
              <div className="mt-2">
                <div className="text-body-secondary small">Sub-accounts</div>
                <ul className="mb-0">{detail.children.map((c) => <li key={c.id}>{c.code} - {c.name}{c.isActive ? '' : ' (inactive)'}</li>)}</ul>
              </div>
            )}
            {(detail.isSystem || detail.lineCount > 0) && (
              <div className="alert alert-secondary py-2 small mt-3 mb-0">
                {detail.isSystem ? 'System accounts cannot be deactivated or deleted. ' : ''}
                {detail.lineCount > 0 ? 'An account with journal lines cannot be deleted; deactivate it once its balance is zero.' : ''}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
