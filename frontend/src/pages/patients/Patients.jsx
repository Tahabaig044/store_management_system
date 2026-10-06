import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { formatCurrency as money } from '../../utils/currency';

function EyeFields({ label, value, onChange }) {
  const v = value || {};
  const set = (field) => (e) => onChange({ ...v, [field]: e.target.value === '' ? undefined : Number(e.target.value) });
  return (
    <div className="row g-1 align-items-center mb-1">
      <div className="col-1 fw-semibold">{label}</div>
      <div className="col-2"><input type="number" step="0.25" className="form-control form-control-sm" placeholder="SPH" value={v.sphere ?? ''} onChange={set('sphere')} /></div>
      <div className="col-2"><input type="number" step="0.25" className="form-control form-control-sm" placeholder="CYL" value={v.cylinder ?? ''} onChange={set('cylinder')} /></div>
      <div className="col-2"><input type="number" className="form-control form-control-sm" placeholder="Axis" value={v.axis ?? ''} onChange={set('axis')} /></div>
      <div className="col-2"><input type="number" step="0.25" className="form-control form-control-sm" placeholder="ADD" value={v.add ?? ''} onChange={set('add')} /></div>
    </div>
  );
}

export default function Patients() {
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', gender: '', dateOfBirth: '' });
  const [saving, setSaving] = useState(false);

  const [selectedId, setSelectedId] = useState(searchParams.get('patientId') || null);
  const [view, setView] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState('');
  const [tab, setTab] = useState('overview');

  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient.get('/patients', { params: { page, pageSize, search: search || undefined } })
      .then((res) => { setItems(res.data.items); setTotal(res.data.total); })
      .catch((e) => setError(extractErrorMessage(e)))
      .finally(() => setLoading(false));
  }
  useEffect(load, [page, search]);

  function openPatient(id) {
    setSelectedId(id);
    setTab('overview');
    setViewLoading(true);
    setViewError('');
    apiClient.get(`/patients/${id}/360`).then((res) => setView(res.data)).catch((e) => setViewError(extractErrorMessage(e))).finally(() => setViewLoading(false));
  }
  useEffect(() => { if (selectedId) openPatient(selectedId); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function createPatient() {
    setSaving(true);
    try {
      await apiClient.post('/patients', { ...form, dateOfBirth: form.dateOfBirth || undefined });
      setShowModal(false);
      setForm({ name: '', phone: '', gender: '', dateOfBirth: '' });
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
          <h4 className="mb-1">Patients</h4>
          <div className="text-body-secondary small">Clinical patient profiles - each one extends an existing customer record.</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>+ Register Patient</button>
      </div>

      <input
        className="form-control mb-3"
        style={{ maxWidth: 320 }}
        placeholder="Search by name, phone, or patient #"
        value={search}
        onChange={(e) => { setPage(1); setSearch(e.target.value); }}
      />

      <div className="row g-3">
        <div className="col-lg-5">
          <ErrorAlert message={error} />
          {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No patients yet." /> : (
            <div className="card">
              <ul className="list-group list-group-flush">
                {items.map((p) => (
                  <li key={p.id} className={`list-group-item d-flex justify-content-between align-items-center ${selectedId === p.id ? 'active' : ''}`} role="button" onClick={() => openPatient(p.id)}>
                    <span>{p.customer.name}<div className="small text-body-secondary">{p.patientNumber} &middot; {p.customer.phone}</div></span>
                  </li>
                ))}
              </ul>
              <div className="card-footer"><Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} /></div>
            </div>
          )}
        </div>

        <div className="col-lg-7">
          {!selectedId ? (
            <EmptyState message="Select a patient to view their 360 profile." />
          ) : viewLoading ? (
            <Spinner />
          ) : viewError ? (
            <ErrorAlert message={viewError} />
          ) : view ? (
            <PatientDetail view={view} tab={tab} setTab={setTab} onRefresh={() => openPatient(selectedId)} />
          ) : null}
        </div>
      </div>

      <Modal
        show={showModal}
        title="Register Patient"
        onClose={() => setShowModal(false)}
        footer={<button className="btn btn-primary" disabled={!form.name || saving} onClick={createPatient}>{saving ? 'Saving...' : 'Register'}</button>}
      >
        <div className="mb-2"><label className="form-label">Name</label><input className="form-control" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="mb-2"><label className="form-label">Phone</label><input className="form-control" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
        <div className="row g-2">
          <div className="col-6">
            <label className="form-label">Gender</label>
            <select className="form-select" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
              <option value="">-</option><option value="M">Male</option><option value="F">Female</option><option value="Other">Other</option>
            </select>
          </div>
          <div className="col-6"><label className="form-label">Date of Birth</label><input type="date" className="form-control" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} /></div>
        </div>
      </Modal>
    </div>
  );
}

function PatientDetail({ view, tab, setTab, onRefresh }) {
  const TABS = ['overview', 'appointments', 'examinations', 'prescriptions', 'orders'];
  return (
    <div className="card">
      <div className="card-header">
        <div className="d-flex justify-content-between align-items-center">
          <div>
            <strong>{view.patient.customer.name}</strong>
            <span className="text-body-secondary small ms-2">{view.patient.patientNumber}</span>
          </div>
          <span className={`badge text-bg-${view.outstandingBalance > 0 ? 'danger' : 'success'}`}>Balance: {money(view.outstandingBalance)}</span>
        </div>
        <ul className="nav nav-pills mt-2 flex-wrap gap-1">
          {TABS.map((t) => (
            <li className="nav-item" key={t}><button className={`nav-link nav-link-sm ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)} style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}>{t}</button></li>
          ))}
        </ul>
      </div>
      <div className="card-body" style={{ maxHeight: 500, overflowY: 'auto' }}>
        {tab === 'overview' && (
          <div className="small">
            <div><strong>Phone:</strong> {view.patient.customer.phone}</div>
            <div><strong>Gender:</strong> {view.patient.gender || '-'}</div>
            <div><strong>DOB:</strong> {view.patient.dateOfBirth ? new Date(view.patient.dateOfBirth).toLocaleDateString() : '-'}</div>
            <div><strong>Emergency Contact:</strong> {view.patient.emergencyContactName} {view.patient.emergencyContactPhone}</div>
            <div><strong>Allergies:</strong> {view.patient.allergies || 'None recorded'}</div>
          </div>
        )}
        {tab === 'appointments' && (
          view.appointments.length === 0 ? <EmptyState message="No appointments." /> : (
            <ul className="list-group list-group-flush">
              {view.appointments.map((a) => (
                <li key={a.id} className="list-group-item d-flex justify-content-between">
                  <span>{new Date(a.scheduledAt).toLocaleString()} {a.doctor && `- ${a.doctor.name}`}</span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )
        )}
        {tab === 'examinations' && <ExaminationsTab view={view} onRefresh={onRefresh} />}
        {tab === 'prescriptions' && <PrescriptionsTab view={view} onRefresh={onRefresh} />}
        {tab === 'orders' && (
          view.opticalOrders.length === 0 ? <EmptyState message="No optical orders." /> : (
            <ul className="list-group list-group-flush">
              {view.opticalOrders.map((o) => (
                <li key={o.id} className="list-group-item d-flex justify-content-between">
                  <span>{o.orderNumber}</span>
                  <span><StatusBadge status={o.status} /> <span className="ms-2">{money(o.totalAmount)}</span></span>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}

function ExaminationsTab({ view, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [od, setOd] = useState({});
  const [os, setOs] = useState({});
  const [pd, setPd] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/examinations', { patientId: view.patient.id, od, os, pd: pd ? Number(pd) : undefined, diagnosis });
      setShowForm(false);
      setOd({}); setOs({}); setPd(''); setDiagnosis('');
      onRefresh();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between mb-2">
        <span className="fw-semibold small">Examination History</span>
        <button className="btn btn-sm btn-outline-primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ New Examination'}</button>
      </div>
      {showForm && (
        <div className="border rounded p-2 mb-3">
          <ErrorAlert message={error} />
          <EyeFields label="OD" value={od} onChange={setOd} />
          <EyeFields label="OS" value={os} onChange={setOs} />
          <div className="row g-1 mb-2">
            <div className="col-2"><input className="form-control form-control-sm" placeholder="PD" value={pd} onChange={(e) => setPd(e.target.value)} /></div>
            <div className="col-10"><input className="form-control form-control-sm" placeholder="Diagnosis / notes" value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} /></div>
          </div>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save Examination'}</button>
        </div>
      )}
      {view.examinations.length === 0 ? <EmptyState message="No examinations recorded." /> : (
        <ul className="list-group list-group-flush">
          {view.examinations.map((e) => (
            <li key={e.id} className="list-group-item small">
              <div className="d-flex justify-content-between"><span>{new Date(e.examDate).toLocaleDateString()} {e.doctor && `- ${e.doctor.name}`}</span></div>
              <div className="text-body-secondary">OD: {e.odSphere ?? '-'}/{e.odCylinder ?? '-'} x{e.odAxis ?? '-'} &middot; OS: {e.osSphere ?? '-'}/{e.osCylinder ?? '-'} x{e.osAxis ?? '-'}</div>
              {e.diagnosis && <div>{e.diagnosis}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PrescriptionsTab({ view, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [od, setOd] = useState({});
  const [os, setOs] = useState({});
  const [pd, setPd] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [orderingFrom, setOrderingFrom] = useState(null);
  const [orderAmount, setOrderAmount] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/clinical-prescriptions', { patientId: view.patient.id, od, os, pd: pd ? Number(pd) : undefined });
      setShowForm(false);
      setOd({}); setOs({}); setPd('');
      onRefresh();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function createOrder(rx) {
    setError('');
    try {
      await apiClient.post('/optical-orders', {
        customerId: view.patient.customerId,
        patientId: view.patient.id,
        clinicalPrescriptionId: rx.id,
        totalAmount: Number(orderAmount || 0),
      });
      setOrderingFrom(null);
      setOrderAmount('');
      onRefresh();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between mb-2">
        <span className="fw-semibold small">Prescription History</span>
        <button className="btn btn-sm btn-outline-primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ New Prescription'}</button>
      </div>
      <ErrorAlert message={error} />
      {showForm && (
        <div className="border rounded p-2 mb-3">
          <EyeFields label="OD" value={od} onChange={setOd} />
          <EyeFields label="OS" value={os} onChange={setOs} />
          <div className="row g-1 mb-2"><div className="col-2"><input className="form-control form-control-sm" placeholder="PD" value={pd} onChange={(e) => setPd(e.target.value)} /></div></div>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save Prescription'}</button>
        </div>
      )}
      {view.prescriptions.length === 0 ? <EmptyState message="No prescriptions recorded." /> : (
        <ul className="list-group list-group-flush">
          {view.prescriptions.map((rx) => (
            <li key={rx.id} className="list-group-item small">
              <div className="d-flex justify-content-between align-items-center">
                <span>
                  v{rx.version} - {new Date(rx.issueDate).toLocaleDateString()} {!rx.isActive && <span className="badge text-bg-secondary ms-1">Superseded</span>}
                </span>
                {rx.isActive && (
                  orderingFrom === rx.id ? (
                    <div className="d-flex gap-1">
                      <input type="number" className="form-control form-control-sm" style={{ width: 90 }} placeholder="Amount" value={orderAmount} onChange={(e) => setOrderAmount(e.target.value)} />
                      <button className="btn btn-sm btn-success" onClick={() => createOrder(rx)}>Confirm</button>
                    </div>
                  ) : (
                    <button className="btn btn-sm btn-outline-success" onClick={() => setOrderingFrom(rx.id)}>Create Optical Order</button>
                  )
                )}
              </div>
              <div className="text-body-secondary">OD: {rx.odSphere ?? '-'}/{rx.odCylinder ?? '-'} &middot; OS: {rx.osSphere ?? '-'}/{rx.osCylinder ?? '-'} &middot; PD: {rx.pd ?? '-'}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
