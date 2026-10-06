import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

const CAN_MANAGE = ['TENANT_ADMIN', 'MANAGER'];

export default function Doctors() {
  const { user } = useAuth();
  const canManage = CAN_MANAGE.includes(user?.role);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', specialty: '', designation: '' });
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    apiClient.get('/doctors').then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function create() {
    setSaving(true);
    try {
      await apiClient.post('/doctors', form);
      setShowModal(false);
      setForm({ name: '', specialty: '', designation: '' });
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h4 className="mb-1">Doctors</h4>
          <div className="text-body-secondary small">Provider profiles used for appointment booking and clinical activity reporting.</div>
        </div>
        {canManage && <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>+ New Doctor</button>}
      </div>

      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No doctors yet." /> : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead><tr><th>Name</th><th>Specialty</th><th>Designation</th><th>Branch</th></tr></thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>{d.specialty}</td>
                    <td>{d.designation}</td>
                    <td>{d.branch?.name || 'All branches'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        show={showModal}
        title="New Doctor"
        onClose={() => setShowModal(false)}
        footer={<button className="btn btn-primary" disabled={!form.name || saving} onClick={create}>{saving ? 'Saving...' : 'Create'}</button>}
      >
        <div className="mb-3">
          <label className="form-label">Name</label>
          <input className="form-control" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="mb-3">
          <label className="form-label">Specialty</label>
          <input className="form-control" value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
        </div>
        <div className="mb-3">
          <label className="form-label">Designation</label>
          <input className="form-control" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
