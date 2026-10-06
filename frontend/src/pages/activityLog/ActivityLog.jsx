// Phase 1.15: the first-ever viewer for the existing AuditLog table
// (backend/src/modules/activityLog/activityLog.routes.js) - AuditLog itself
// has been written to since Phase 1.1 via logAudit(), but had no read API
// or frontend page before this phase. MANAGEMENT-only (AUDIT_LOG:VIEW).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';

export default function ActivityLog() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({ action: '', entity: '', entityId: '', search: searchParams.get('search') || '', from: '', to: '' });
  const [selected, setSelected] = useState(null);

  const pageSize = 25;

  function load() {
    setLoading(true);
    const params = { page, pageSize };
    if (filters.action) params.action = filters.action;
    if (filters.entity) params.entity = filters.entity;
    if (filters.entityId) params.entityId = filters.entityId;
    if (filters.search) params.search = filters.search;
    if (filters.from) params.from = new Date(filters.from).toISOString();
    if (filters.to) params.to = new Date(filters.to).toISOString();
    apiClient
      .get('/activity-log', { params })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, filters.action, filters.entity, filters.entityId, filters.search, filters.from, filters.to]);

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Activity Log</h4>
      </div>

      <div className="row g-2 mb-3">
        <div className="col-auto">
          <input className="form-control form-control-sm" placeholder="Action (e.g. SALE_CREATE)..." value={filters.action} onChange={(e) => { setPage(1); setFilters({ ...filters, action: e.target.value }); }} />
        </div>
        <div className="col-auto">
          <input className="form-control form-control-sm" placeholder="Entity type (e.g. Sale)..." value={filters.entity} onChange={(e) => { setPage(1); setFilters({ ...filters, entity: e.target.value }); }} />
        </div>
        <div className="col-auto">
          <input className="form-control form-control-sm" placeholder="Entity ID..." value={filters.entityId} onChange={(e) => { setPage(1); setFilters({ ...filters, entityId: e.target.value }); }} />
        </div>
        <div className="col-auto">
          <input className="form-control form-control-sm" placeholder="Search..." value={filters.search} onChange={(e) => { setPage(1); setFilters({ ...filters, search: e.target.value }); }} />
        </div>
        <div className="col-auto">
          <input type="date" className="form-control form-control-sm" value={filters.from} onChange={(e) => { setPage(1); setFilters({ ...filters, from: e.target.value }); }} />
        </div>
        <div className="col-auto">
          <input type="date" className="form-control form-control-sm" value={filters.to} onChange={(e) => { setPage(1); setFilters({ ...filters, to: e.target.value }); }} />
        </div>
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No activity recorded for this filter." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Branch</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id} role="button" onClick={() => setSelected(entry)}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td>{entry.user?.name || 'System'}</td>
                    <td><code className="small">{entry.action}</code></td>
                    <td>{entry.entity ? `${entry.entity} ${entry.entityId ? `(${entry.entityId.slice(0, 8)}...)` : ''}` : '-'}</td>
                    <td>{entry.branch?.name || '-'}</td>
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

      <Modal show={!!selected} title="Activity Detail" onClose={() => setSelected(null)}>
        {selected && (
          <div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Date</span>
              <span>{new Date(selected.createdAt).toLocaleString()}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Actor</span>
              <span>{selected.user?.name || 'System'} {selected.user?.role ? `(${selected.user.role})` : ''}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Action</span>
              <span>{selected.action}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Entity</span>
              <span>{selected.entity || '-'} {selected.entityId || ''}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">Branch</span>
              <span>{selected.branch?.name || '-'}</span>
            </div>
            <div className="d-flex justify-content-between">
              <span className="text-body-secondary">IP Address</span>
              <span>{selected.ipAddress || '-'}</span>
            </div>
            {selected.metadata && (
              <div className="mt-2">
                <div className="text-body-secondary small">Metadata</div>
                <pre className="small bg-body-secondary p-2 rounded" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(selected.metadata, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
