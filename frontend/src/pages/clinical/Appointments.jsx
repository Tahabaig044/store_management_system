import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';

const NEXT_ACTIONS = {
  SCHEDULED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ARRIVED', 'CANCELLED', 'NO_SHOW'],
  ARRIVED: ['IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED'],
};

export default function Appointments() {
  const [tab, setTab] = useState('today');
  const [queue, setQueue] = useState(null);
  const [items, setItems] = useState([]);
  const [patients, setPatients] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ patientId: '', doctorId: '', scheduledAt: '', durationMinutes: 30, appointmentType: '' });
  const [saving, setSaving] = useState(false);

  function loadToday() {
    setLoading(true);
    apiClient.get('/appointments/today').then((res) => setQueue(res.data)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  function loadUpcoming() {
    setLoading(true);
    apiClient.get('/appointments').then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(() => {
    if (tab === 'today') loadToday(); else loadUpcoming();
  }, [tab]);
  useEffect(() => {
    apiClient.get('/patients', { params: { pageSize: 200 } }).then((res) => setPatients(res.data.items || []));
    apiClient.get('/doctors').then((res) => setDoctors(res.data.items || []));
  }, []);

  async function create() {
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/appointments', { ...form, doctorId: form.doctorId || undefined, idempotencyKey: crypto.randomUUID() });
      setShowModal(false);
      setForm({ patientId: '', doctorId: '', scheduledAt: '', durationMinutes: 30, appointmentType: '' });
      if (tab === 'today') loadToday(); else loadUpcoming();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(id, status) {
    try {
      await apiClient.patch(`/appointments/${id}/status`, { status });
      if (tab === 'today') loadToday(); else loadUpcoming();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  const rows = tab === 'today' ? queue?.items || [] : items;

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h4 className="mb-1">Appointments</h4>
          <div className="text-body-secondary small">
            {tab === 'today' && queue && <>Waiting: {queue.waitingCount} &middot; In progress: {queue.inProgressCount} &middot; Completed: {queue.completedCount}</>}
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>+ Book Appointment</button>
      </div>

      <ul className="nav nav-pills mb-3">
        <li className="nav-item"><button className={`nav-link ${tab === 'today' ? 'active' : ''}`} onClick={() => setTab('today')}>Today's Queue</button></li>
        <li className="nav-item"><button className={`nav-link ${tab === 'upcoming' ? 'active' : ''}`} onClick={() => setTab('upcoming')}>All Appointments</button></li>
      </ul>

      <ErrorAlert message={error} />
      {loading ? <Spinner /> : rows.length === 0 ? <EmptyState message="No appointments." /> : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead><tr><th>Token</th><th>Time</th><th>Patient</th><th>Doctor</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>{a.tokenNumber}</td>
                    <td>{new Date(a.scheduledAt).toLocaleString()}</td>
                    <td><Link to={`/patients?patientId=${a.patientId}`}>{a.patient?.customer?.name}</Link></td>
                    <td>{a.doctor?.name || '-'}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td className="d-flex gap-1">
                      {(NEXT_ACTIONS[a.status] || []).map((next) => (
                        <button key={next} className="btn btn-sm btn-outline-secondary" onClick={() => setStatus(a.id, next)}>{next.replace('_', ' ')}</button>
                      ))}
                      {a.status === 'COMPLETED' && a.patient?.customer?.id && (
                        <Link
                          className="btn btn-sm btn-outline-primary"
                          to={`/pos?appointmentId=${a.id}&customerId=${a.patient.customer.id}`}
                        >
                          Bill Visit
                        </Link>
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
        show={showModal}
        title="Book Appointment"
        onClose={() => setShowModal(false)}
        footer={<button className="btn btn-primary" disabled={!form.patientId || !form.scheduledAt || saving} onClick={create}>{saving ? 'Booking...' : 'Book'}</button>}
      >
        <div className="mb-3">
          <label className="form-label">Patient</label>
          <select className="form-select" value={form.patientId} onChange={(e) => setForm({ ...form, patientId: e.target.value })}>
            <option value="">Select a patient</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.customer.name} ({p.patientNumber})</option>)}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Doctor (optional)</label>
          <select className="form-select" value={form.doctorId} onChange={(e) => setForm({ ...form, doctorId: e.target.value })}>
            <option value="">Unassigned</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Date &amp; Time</label>
          <input type="datetime-local" className="form-control" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
        </div>
        <div className="mb-3">
          <label className="form-label">Type</label>
          <input className="form-control" placeholder="e.g. Eye Exam, Follow-up" value={form.appointmentType} onChange={(e) => setForm({ ...form, appointmentType: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
