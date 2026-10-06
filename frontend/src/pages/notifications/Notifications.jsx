// Phase 1.15: a full notification history page - the existing NotificationBell
// dropdown only ever shows the latest 10, with no filters/pagination. This
// page is additive, reusing the exact same /api/notifications endpoints
// (list, unread-count, mark-read, mark-all-read) plus the two new ones this
// phase added (GET /:id detail is not surfaced separately here since the
// list row already shows everything; DELETE /:id for dismiss).
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Pagination from '../../components/Pagination';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';

export default function Notifications() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ unreadOnly: false, type: '', priority: '' });

  const pageSize = 20;

  function load() {
    setLoading(true);
    const params = { page, pageSize };
    if (filters.unreadOnly) params.unreadOnly = 'true';
    if (filters.type) params.type = filters.type;
    if (filters.priority) params.priority = filters.priority;
    apiClient
      .get('/notifications', { params })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
        setUnreadCount(res.data.unreadCount);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, filters.unreadOnly, filters.type, filters.priority]);

  async function markRead(id) {
    try {
      await apiClient.patch(`/notifications/${id}/read`);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function markAllRead() {
    try {
      await apiClient.post('/notifications/mark-all-read');
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function dismiss(id) {
    try {
      await apiClient.delete(`/notifications/${id}`);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Notifications</h4>
        {unreadCount > 0 && (
          <button className="btn btn-outline-secondary btn-sm" onClick={markAllRead}>
            Mark all read ({unreadCount})
          </button>
        )}
      </div>

      <div className="row g-2 mb-3">
        <div className="col-auto">
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="unreadOnly"
              checked={filters.unreadOnly}
              onChange={(e) => { setPage(1); setFilters({ ...filters, unreadOnly: e.target.checked }); }}
            />
            <label className="form-check-label" htmlFor="unreadOnly">Unread only</label>
          </div>
        </div>
        <div className="col-auto">
          <select className="form-select form-select-sm" value={filters.priority} onChange={(e) => { setPage(1); setFilters({ ...filters, priority: e.target.value }); }}>
            <option value="">All Priorities</option>
            <option value="LOW">Low</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
          </select>
        </div>
        <div className="col-auto">
          <input
            className="form-control form-control-sm"
            placeholder="Filter by type (e.g. EXPENSE_CREATED)..."
            value={filters.type}
            onChange={(e) => { setPage(1); setFilters({ ...filters, type: e.target.value }); }}
          />
        </div>
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No notifications." />
      ) : (
        <div className="card">
          <div className="list-group list-group-flush">
            {items.map((n) => (
              <div key={n.id} className={`list-group-item d-flex justify-content-between align-items-start ${n.isRead ? '' : 'bg-body-secondary'}`}>
                <div>
                  <div className="fw-semibold">
                    {n.title}
                    {n.priority !== 'NORMAL' && <span className="badge text-bg-secondary ms-2">{n.priority}</span>}
                  </div>
                  {n.body && <div className="text-body-secondary small">{n.body}</div>}
                  <div className="text-body-secondary" style={{ fontSize: '0.75rem' }}>
                    {new Date(n.createdAt).toLocaleString()} - {n.type}
                    {n.readAt && ` - read ${new Date(n.readAt).toLocaleString()}`}
                  </div>
                </div>
                <div className="d-flex gap-1">
                  {!n.isRead && (
                    <button className="btn btn-sm btn-outline-primary" onClick={() => markRead(n.id)}>Mark read</button>
                  )}
                  <button className="btn btn-sm btn-outline-secondary" onClick={() => dismiss(n.id)}>Dismiss</button>
                </div>
              </div>
            ))}
          </div>
          <div className="card-footer">
            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </div>
        </div>
      )}
    </div>
  );
}
