// Phase 1.5: universal Unit of Measure catalog management - mirrors
// Categories.jsx/Brands.jsx's shape, extended with an optional conversion
// relationship (baseUnit + conversionFactor). Industry-neutral: no
// hard-coded suggestions or industry-specific units anywhere on this screen.
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

const emptyForm = { name: '', code: '', baseUnitId: '', conversionFactor: '' };

export default function Units() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('UNIT:CREATE') || hasPermission('UNIT:UPDATE') || hasPermission('UNIT:DELETE');

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
  const [editingUnit, setEditingUnit] = useState(null);
  const [allUnits, setAllUnits] = useState([]);
  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/units', { params: { page, pageSize, search: search || undefined, includeInactive: showInactive || undefined } })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, showInactive]);
  useEffect(() => {
    apiClient.get('/units', { params: { pageSize: 100 } }).then((res) => setAllUnits(res.data.items));
  }, [items]);

  function openCreate() {
    setEditingUnit(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(u) {
    setEditingUnit(u);
    setForm({ name: u.name || '', code: u.code || '', baseUnitId: u.baseUnitId || '', conversionFactor: u.conversionFactor ?? '' });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingUnit(null);
    setForm(emptyForm);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        name: form.name,
        code: form.code || undefined,
        baseUnitId: form.baseUnitId || null,
        conversionFactor: form.baseUnitId && form.conversionFactor ? Number(form.conversionFactor) : null,
      };
      if (editingUnit) {
        await apiClient.patch(`/units/${editingUnit.id}`, payload);
        closeModal();
        setNotice('Unit updated.');
        load();
      } else {
        await apiClient.post('/units', payload);
        closeModal();
        setPage(1);
        setNotice('Unit created.');
        load();
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(u) {
    setError('');
    try {
      if (u.isActive) {
        await apiClient.delete(`/units/${u.id}`);
      } else {
        await apiClient.patch(`/units/${u.id}`, { isActive: true });
      }
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Units of Measure</h4>
        {canManage && (
          <button className="btn btn-primary" onClick={openCreate}>
            + New Unit
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
              id="showInactiveUnits"
              checked={showInactive}
              onChange={(e) => {
                setPage(1);
                setShowInactive(e.target.checked);
              }}
            />
            <label className="form-check-label" htmlFor="showInactiveUnits">
              Show deactivated
            </label>
          </div>
        )}
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No units yet." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Code</th>
                  <th>Conversion</th>
                  <th className="text-end">Products</th>
                  {showInactive && <th>Status</th>}
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((u) => (
                  <tr key={u.id} className={!u.isActive ? 'opacity-50' : ''}>
                    <td>{u.name}</td>
                    <td className="text-body-secondary">{u.code || '-'}</td>
                    <td className="text-body-secondary">
                      {u.baseUnit ? `1 ${u.name} = ${Number(u.conversionFactor)} ${u.baseUnit.name}` : '-'}
                    </td>
                    <td className="text-end">{u.productCount ?? 0}</td>
                    {showInactive && (
                      <td>
                        <span className={`badge text-bg-${u.isActive ? 'success' : 'secondary'}`}>
                          {u.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                    )}
                    {canManage && (
                      <td className="d-flex gap-1">
                        <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(u)}>
                          Edit
                        </button>
                        <button
                          className={`btn btn-sm btn-outline-${u.isActive ? 'danger' : 'success'}`}
                          onClick={() => toggleActive(u)}
                        >
                          {u.isActive ? 'Deactivate' : 'Activate'}
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
        title={editingUnit ? 'Edit Unit' : 'New Unit'}
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="unit-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="unit-form">
          <div className="mb-2">
            <label className="form-label" htmlFor="unit-name">Name</label>
            <input id="unit-name" className="form-control" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="unit-code">Code</label>
            <input id="unit-code" className="form-control" placeholder="e.g. pcs, kg, box" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label" htmlFor="unit-base-unit">Base Unit (optional, for conversion)</label>
            <select
              id="unit-base-unit"
              className="form-select"
              value={form.baseUnitId}
              onChange={(e) => setForm({ ...form, baseUnitId: e.target.value })}
            >
              <option value="">None</option>
              {allUnits
                .filter((u) => u.id !== editingUnit?.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </div>
          {form.baseUnitId && (
            <div className="mb-2">
              <label className="form-label" htmlFor="unit-conversion-factor">Conversion Factor (1 of this unit = ? base units)</label>
              <input
                id="unit-conversion-factor"
                type="number"
                step="0.0001"
                min="0"
                className="form-control"
                required
                value={form.conversionFactor}
                onChange={(e) => setForm({ ...form, conversionFactor: e.target.value })}
              />
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
