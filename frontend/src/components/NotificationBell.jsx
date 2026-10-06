import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiBell } from 'react-icons/fi';
import apiClient from '../api/client';

const POLL_MS = 30000;

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const ref = useRef(null);

  function loadCount() {
    apiClient.get('/notifications/unread-count').then((res) => setUnreadCount(res.data.count)).catch(() => {});
  }

  useEffect(() => {
    loadCount();
    const id = setInterval(loadCount, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      apiClient.get('/notifications', { params: { pageSize: 10 } }).then((res) => setItems(res.data.items)).catch(() => {});
    }
  }

  async function markRead(id) {
    await apiClient.patch(`/notifications/${id}/read`).catch(() => {});
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    loadCount();
  }

  async function markAllRead() {
    await apiClient.post('/notifications/mark-all-read').catch(() => {});
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
  }

  return (
    <div className="position-relative" ref={ref}>
      <button className="btn btn-sm btn-outline-secondary position-relative" onClick={toggle}>
        <FiBell size={14} />
        {unreadCount > 0 && (
          <span className="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger" style={{ fontSize: '0.6rem' }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="card shadow-sm position-absolute end-0 mt-2" style={{ width: 320, zIndex: 1050, maxHeight: 400, overflowY: 'auto' }}>
          <div className="d-flex justify-content-between align-items-center px-3 py-2 border-bottom">
            <strong className="small">Notifications</strong>
            {unreadCount > 0 && <button className="btn btn-link btn-sm p-0" onClick={markAllRead}>Mark all read</button>}
          </div>
          {items.length === 0 ? (
            <div className="text-center text-body-secondary small py-4">No notifications.</div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                className={`btn text-start px-3 py-2 border-bottom rounded-0 ${n.isRead ? '' : 'bg-body-secondary'}`}
                onClick={() => markRead(n.id)}
              >
                <div className="small fw-semibold">{n.title}</div>
                {n.body && <div className="small text-body-secondary">{n.body}</div>}
                <div className="text-body-secondary" style={{ fontSize: '0.68rem' }}>{new Date(n.createdAt).toLocaleString()}</div>
              </button>
            ))
          )}
          <Link to="/notifications" className="d-block text-center small py-2 border-top" onClick={() => setOpen(false)}>
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
