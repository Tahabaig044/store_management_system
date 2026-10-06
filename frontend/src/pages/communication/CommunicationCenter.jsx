import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import DeliveryUnavailableBanner from '../../components/DeliveryUnavailableBanner';

const CAN_SEND = ['TENANT_ADMIN', 'MANAGER'];

export default function CommunicationCenter() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [filters, setFilters] = useState({ status: '', channel: '', event: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showSend, setShowSend] = useState(false);
  const [form, setForm] = useState({ customerId: '', templateId: '', body: '' });
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    Promise.all([
      apiClient.get('/communication/messages', { params }),
      apiClient.get('/communication/messages/stats'),
    ])
      .then(([list, s]) => {
        setItems(list.data.items);
        setStats(s.data);
      })
      .catch((e) => setError(extractErrorMessage(e)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [filters.status, filters.channel, filters.event]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    apiClient.get('/customers', { params: { pageSize: 200 } }).then((res) => setCustomers(res.data.items || []));
    apiClient.get('/communication/templates').then((res) => setTemplates(res.data.items || []));
  }, []);

  async function sendMessage() {
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/communication/messages', {
        customerId: form.customerId,
        templateId: form.templateId || undefined,
        body: form.templateId ? undefined : form.body,
        idempotencyKey: crypto.randomUUID(),
      });
      setShowSend(false);
      setForm({ customerId: '', templateId: '', body: '' });
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function retry(id) {
    setError('');
    try {
      await apiClient.post(`/communication/messages/${id}/retry`);
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  return (
    <div>
      <DeliveryUnavailableBanner />
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Communication Center</h4>
        {CAN_SEND.includes(user?.role) && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowSend(true)}>+ Send Message</button>
        )}
      </div>

      {stats && (
        <div className="row g-3 mb-3">
          <div className="col-6 col-md-3">
            <div className="card p-3"><div className="text-body-secondary small">Total</div><div className="h4 mb-0">{stats.total}</div></div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card p-3"><div className="text-body-secondary small">Sent</div><div className="h4 mb-0">{(stats.byStatus.SENT || 0) + (stats.byStatus.DELIVERED || 0) + (stats.byStatus.READ || 0)}</div></div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card p-3"><div className="text-body-secondary small">Queued</div><div className="h4 mb-0">{stats.byStatus.QUEUED || 0}</div></div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card p-3"><div className="text-body-secondary small">Failed</div><div className="h4 mb-0 text-danger">{stats.byStatus.FAILED || 0}</div></div>
          </div>
        </div>
      )}

      <div className="d-flex gap-2 mb-3 flex-wrap">
        <select className="form-select form-select-sm w-auto" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All statuses</option>
          {['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="form-select form-select-sm w-auto" value={filters.channel} onChange={(e) => setFilters({ ...filters, channel: e.target.value })}>
          <option value="">All channels</option>
          {['WHATSAPP', 'IN_APP', 'EMAIL'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No messages." /> : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead><tr><th>Date</th><th>Customer</th><th>Channel</th><th>Event</th><th>Status</th><th>Body</th><th></th></tr></thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id}>
                    <td>{new Date(m.queuedAt).toLocaleString()}</td>
                    <td>{m.customer?.name || '-'}</td>
                    <td>{m.channel}</td>
                    <td className="small text-body-secondary">{m.sourceEventType || 'MANUAL'}</td>
                    <td><StatusBadge status={m.status} /></td>
                    <td className="small" style={{ maxWidth: 280 }}>{m.body}</td>
                    <td>
                      {m.status === 'FAILED' && CAN_SEND.includes(user?.role) && (
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => retry(m.id)}>Retry</button>
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
        show={showSend}
        title="Send WhatsApp Message"
        onClose={() => setShowSend(false)}
        footer={<button className="btn btn-primary" disabled={!form.customerId || (!form.templateId && !form.body) || saving} onClick={sendMessage}>{saving ? 'Sending...' : 'Send'}</button>}
      >
        <div className="mb-3">
          <label className="form-label">Customer</label>
          <select className="form-select" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
            <option value="">Select a customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` (${c.phone})` : ''}</option>)}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Template (optional)</label>
          <select className="form-select" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value, body: e.target.value ? '' : form.body })}>
            <option value="">Custom message</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {!form.templateId && (
          <div className="mb-3">
            <label className="form-label">Message</label>
            <textarea className="form-control" rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </div>
        )}
      </Modal>
    </div>
  );
}
