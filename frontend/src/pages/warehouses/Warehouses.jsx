import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { OUTBOXES } from '../../offline/syncEngine';
import { formatCurrency as money } from '../../utils/currency';

// Warehouse/store management + location-aware stock. A single-branch shop
// that never visits this page keeps working exactly as before Phase 6 -
// nothing here is required setup.

export default function Warehouses() {
  const { user, hasPermission } = useAuth();
  const tenantId = user?.tenantId;
  const canManage = hasPermission('WAREHOUSE:CREATE') || hasPermission('WAREHOUSE:UPDATE');

  const [items, setItems] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState(null);
  const [form, setForm] = useState({ name: '', code: '', branchId: '', isCentral: false, isDefault: false });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const [selected, setSelected] = useState(null);
  const [stock, setStock] = useState(null);
  const [stockLoading, setStockLoading] = useState(false);
  const [moveForm, setMoveForm] = useState({ productId: '', quantity: '', note: '' });
  const [moveError, setMoveError] = useState('');

  function load() {
    setLoading(true);
    apiClient.get('/warehouses').then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(load, []);
  useEffect(() => { apiClient.get('/branches').then((res) => setBranches(res.data.items || [])); }, []);

  function openCreate() {
    setEditingWarehouse(null);
    setForm({ name: '', code: '', branchId: '', isCentral: false, isDefault: false });
    setShowModal(true);
  }

  function openEdit(w) {
    setEditingWarehouse(w);
    setForm({ name: w.name || '', code: w.code || '', branchId: w.branchId || '', isCentral: w.isCentral, isDefault: w.isDefault });
    setShowModal(true);
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (editingWarehouse) {
        await apiClient.patch(`/warehouses/${editingWarehouse.id}`, { name: form.name, code: form.code, isDefault: form.isDefault || undefined });
        setNotice('Warehouse updated.');
      } else {
        await apiClient.post('/warehouses', { ...form, branchId: form.branchId || undefined });
        setNotice('Warehouse created.');
      }
      setShowModal(false);
      setEditingWarehouse(null);
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(w) {
    setError('');
    try {
      await apiClient.patch(`/warehouses/${w.id}`, { isDefault: true });
      setNotice(`${w.name} is now the default warehouse.`);
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  function viewStock(w) {
    setSelected(w);
    setStockLoading(true);
    apiClient.get(`/warehouses/${w.id}/stock`).then((res) => setStock(res.data)).catch((e) => setError(extractErrorMessage(e))).finally(() => setStockLoading(false));
  }

  // Phase 1.10: goes through the offline outbox instead of a direct
  // apiClient call, so receiving/dispatching stock keeps working (queued
  // locally) when this terminal loses connectivity - same pattern already
  // used by Sales (Pos.jsx) and Purchases (Purchases.jsx). The per-warehouse
  // stock LIST itself (below) still requires a live connection to refresh -
  // that's a real, disclosed limitation (see this phase's verification
  // report, Offline Cache Freshness section), not something this queuing
  // alone can solve.
  async function move(action) {
    setMoveError('');
    try {
      const entry = await OUTBOXES.warehouseStockMoves.submit(tenantId, {
        warehouseId: selected.id,
        action,
        productId: moveForm.productId,
        quantity: Number(moveForm.quantity),
        note: moveForm.note || undefined,
      });
      if (entry.status === 'conflict' || entry.status === 'failed') {
        setMoveError(`Could not save: ${entry.lastError}`);
        return;
      }
      setMoveForm({ productId: '', quantity: '', note: '' });
      if (entry.status === 'synced') {
        viewStock(selected);
      } else {
        setNotice("Saved on this device - will appear in the warehouse stock list once it's synced (you're offline).");
      }
    } catch (e) {
      setMoveError(extractErrorMessage(e));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h4 className="mb-1">Warehouses</h4>
          <div className="text-body-secondary small">Location-aware stock - each warehouse tracks its own quantities on top of the total shown everywhere else.</div>
        </div>
        {canManage && <button className="btn btn-primary btn-sm" onClick={openCreate}>+ New Warehouse</button>}
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No warehouses yet - Product totals are used tenant-wide until you create one." /> : (
        <div className="row g-3">
          <div className="col-md-5">
            <div className="card">
              <ul className="list-group list-group-flush">
                {items.map((w) => (
                  <li key={w.id} className={`list-group-item d-flex justify-content-between align-items-center ${selected?.id === w.id ? 'active' : ''}`}>
                    <span role="button" onClick={() => viewStock(w)}>
                      {w.name} {w.code && <span className="text-body-secondary small">({w.code})</span>}
                      {w.isCentral && <span className="badge text-bg-info-subtle text-info-emphasis ms-2">Central</span>}
                      {w.isDefault && <span className="badge text-bg-primary ms-2">Default</span>}
                    </span>
                    <span className="d-flex align-items-center gap-2">
                      <span className="text-body-secondary small">{w.branch?.name || 'Unassigned'}</span>
                      {canManage && (
                        <>
                          <button className="btn btn-sm btn-outline-primary" onClick={(e) => { e.stopPropagation(); openEdit(w); }}>Edit</button>
                          {!w.isDefault && (
                            <button className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); makeDefault(w); }}>Set Default</button>
                          )}
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="col-md-7">
            {!selected ? (
              <EmptyState message="Select a warehouse to view its stock." />
            ) : stockLoading ? (
              <Spinner />
            ) : (
              <div className="card">
                <div className="card-header d-flex justify-content-between">
                  <span>{selected.name} Stock</span>
                  <span className="badge text-bg-secondary">{money(stock?.totalValue)}</span>
                </div>
                <div className="table-responsive">
                  <table className="table table-sm mb-0">
                    <thead><tr><th>Product</th><th className="text-end">Qty</th><th></th></tr></thead>
                    <tbody>
                      {stock?.items.map((i) => (
                        <tr key={i.productId} className={i.lowStock ? 'table-warning' : ''}>
                          <td>{i.name}</td>
                          <td className="text-end">{i.quantity}</td>
                          <td>{i.lowStock && <span className="badge text-bg-warning-subtle text-warning-emphasis">Low</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {canManage && (
                  <div className="card-body border-top">
                    <ErrorAlert message={moveError} />
                    <div className="row g-2 align-items-end">
                      <div className="col-5">
                        <label className="form-label small mb-1">Product</label>
                        <select className="form-select form-select-sm" value={moveForm.productId} onChange={(e) => setMoveForm({ ...moveForm, productId: e.target.value })}>
                          <option value="">Select</option>
                          {stock?.items.map((i) => <option key={i.productId} value={i.productId}>{i.name}</option>)}
                        </select>
                      </div>
                      <div className="col-3">
                        <label className="form-label small mb-1">Qty</label>
                        <input type="number" min="1" className="form-control form-control-sm" value={moveForm.quantity} onChange={(e) => setMoveForm({ ...moveForm, quantity: e.target.value })} />
                      </div>
                      <div className="col-4 d-flex gap-1">
                        <button className="btn btn-sm btn-outline-success flex-grow-1" disabled={!moveForm.productId || !moveForm.quantity} onClick={() => move('receive')}>Receive</button>
                        <button className="btn btn-sm btn-outline-danger flex-grow-1" disabled={!moveForm.productId || !moveForm.quantity} onClick={() => move('dispatch')}>Dispatch</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal
        show={showModal}
        title={editingWarehouse ? 'Edit Warehouse' : 'New Warehouse'}
        onClose={() => setShowModal(false)}
        footer={<button className="btn btn-primary" disabled={!form.name || saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>}
      >
        <div className="mb-3">
          <label className="form-label">Name</label>
          <input className="form-control" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="mb-3">
          <label className="form-label">Code</label>
          <input className="form-control" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </div>
        {!editingWarehouse && (
          <div className="mb-3">
            <label className="form-label">Branch (leave blank for a central warehouse)</label>
            <select className="form-select" value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
              <option value="">Central / Head Office</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="warehouse-is-default"
            checked={form.isDefault}
            disabled={form.isDefault}
            onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
          />
          <label className="form-check-label" htmlFor="warehouse-is-default">
            Make this the default warehouse
          </label>
        </div>
      </Modal>
    </div>
  );
}
