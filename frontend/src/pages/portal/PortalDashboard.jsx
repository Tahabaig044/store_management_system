import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { usePortalAuth } from '../../portal/PortalAuthContext';
import portalApi from '../../portal/portalApi';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { formatCurrency } from '../../utils/currency';

const TABS = ['Overview', 'Optical Orders', 'Invoices', 'Appointments', 'Prescriptions'];

export default function PortalDashboard() {
  const { customer, logout } = usePortalAuth();
  const [tab, setTab] = useState('Overview');
  const [profile, setProfile] = useState(null);
  const [orders, setOrders] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [prescriptions, setPrescriptions] = useState([]);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [apptForm, setApptForm] = useState({ preferredDate: '', reason: '' });
  const [followUpMessage, setFollowUpMessage] = useState('');

  useEffect(() => {
    if (!customer) return;
    setLoading(true);
    Promise.all([
      portalApi.get('/portal/me'),
      portalApi.get('/portal/optical-orders'),
      portalApi.get('/portal/invoices'),
      portalApi.get('/portal/appointments'),
      portalApi.get('/portal/prescriptions'),
      portalApi.get('/portal/outstanding-balance'),
    ])
      .then(([me, o, i, a, p, b]) => {
        setProfile(me.data.customer);
        setOrders(o.data.items);
        setInvoices(i.data.items);
        setAppointments(a.data.items);
        setPrescriptions(p.data.items);
        setBalance(b.data);
      })
      .catch((e) => setError(extractErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [customer]);

  if (!customer) return <Navigate to="/portal/login" replace />;

  async function submitAppointmentRequest(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      const { data } = await portalApi.post('/portal/appointments/request', apptForm);
      setNotice(data.message);
      setApptForm({ preferredDate: '', reason: '' });
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function submitFollowUp(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      const { data } = await portalApi.post('/portal/follow-up', { message: followUpMessage });
      setNotice(data.message);
      setFollowUpMessage('');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function toggleWhatsappOptOut() {
    try {
      const { data } = await portalApi.put('/portal/communication-preferences', { whatsappOptOut: !profile?.communicationPreference?.whatsappOptOut });
      setProfile((p) => ({ ...p, communicationPreference: data.item }));
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div className="min-vh-100 bg-body-secondary">
      <header className="bg-body border-bottom px-3 py-2 d-flex justify-content-between align-items-center">
        <div>
          <strong>Customer Portal</strong>
          <div className="small text-body-secondary">{customer.name}</div>
        </div>
        <button className="btn btn-sm btn-outline-danger" onClick={logout}>Logout</button>
      </header>

      <div className="container py-3">
        <ul className="nav nav-pills mb-3 flex-wrap">
          {TABS.map((t) => (
            <li className="nav-item" key={t}>
              <button className={`nav-link ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
            </li>
          ))}
        </ul>

        <ErrorAlert message={error} />
        {notice && <div className="alert alert-success py-2 small">{notice}</div>}

        {loading ? <Spinner /> : (
          <>
            {tab === 'Overview' && (
              <div className="row g-3">
                <div className="col-md-6">
                  <div className="card p-3">
                    <h6>Outstanding Balance</h6>
                    {balance ? (
                      <>
                        <div className="h4">{formatCurrency(balance.totalOutstanding)}</div>
                        <div className="small text-body-secondary">Sales: {formatCurrency(balance.salesBalance)} &middot; Optical orders: {formatCurrency(balance.opticalBalance)}</div>
                      </>
                    ) : <div className="text-body-secondary small">No balance information.</div>}
                  </div>
                </div>
                <div className="col-md-6">
                  <div className="card p-3">
                    <h6>WhatsApp Notifications</h6>
                    <div className="form-check form-switch">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        checked={!profile?.communicationPreference?.whatsappOptOut}
                        onChange={toggleWhatsappOptOut}
                      />
                      <label className="form-check-label small">
                        {profile?.communicationPreference?.whatsappOptOut ? 'Notifications are off' : 'Notifications are on'}
                      </label>
                    </div>
                  </div>
                </div>
                <div className="col-md-6">
                  <div className="card p-3">
                    <h6>Request an Appointment</h6>
                    <form onSubmit={submitAppointmentRequest}>
                      <input className="form-control form-control-sm mb-2" type="date" value={apptForm.preferredDate} onChange={(e) => setApptForm({ ...apptForm, preferredDate: e.target.value })} />
                      <input className="form-control form-control-sm mb-2" placeholder="Reason (optional)" value={apptForm.reason} onChange={(e) => setApptForm({ ...apptForm, reason: e.target.value })} />
                      <button className="btn btn-sm btn-primary" type="submit">Request</button>
                    </form>
                  </div>
                </div>
                <div className="col-md-6">
                  <div className="card p-3">
                    <h6>Request a Callback</h6>
                    <form onSubmit={submitFollowUp}>
                      <textarea className="form-control form-control-sm mb-2" rows={2} required value={followUpMessage} onChange={(e) => setFollowUpMessage(e.target.value)} placeholder="What would you like us to call you about?" />
                      <button className="btn btn-sm btn-primary" type="submit">Send Request</button>
                    </form>
                  </div>
                </div>
              </div>
            )}

            {tab === 'Optical Orders' && (
              orders.length === 0 ? <EmptyState message="No optical orders yet." /> : (
                <div className="card"><div className="table-responsive"><table className="table mb-0 align-middle">
                  <thead><tr><th>Order #</th><th>Status</th><th>Total</th><th>Paid</th><th>Expected</th></tr></thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td>{o.orderNumber}</td>
                        <td><StatusBadge status={o.status} /></td>
                        <td>{formatCurrency(o.totalAmount)}</td>
                        <td>{formatCurrency(o.amountPaid)}</td>
                        <td>{o.expectedDeliveryDate ? new Date(o.expectedDeliveryDate).toLocaleDateString() : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div></div>
              )
            )}

            {tab === 'Invoices' && (
              invoices.length === 0 ? <EmptyState message="No invoices yet." /> : (
                <div className="card"><div className="table-responsive"><table className="table mb-0 align-middle">
                  <thead><tr><th>Invoice #</th><th>Date</th><th>Total</th><th>Paid</th><th>Status</th></tr></thead>
                  <tbody>
                    {invoices.map((s) => (
                      <tr key={s.id}>
                        <td>{s.invoiceNumber}</td>
                        <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                        <td>{formatCurrency(s.total)}</td>
                        <td>{formatCurrency(s.amountPaid)}</td>
                        <td><StatusBadge status={s.paymentStatus} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div></div>
              )
            )}

            {tab === 'Appointments' && (
              appointments.length === 0 ? <EmptyState message="No appointments yet." /> : (
                <div className="card"><div className="table-responsive"><table className="table mb-0 align-middle">
                  <thead><tr><th>Date</th><th>Doctor</th><th>Status</th></tr></thead>
                  <tbody>
                    {appointments.map((a) => (
                      <tr key={a.id}>
                        <td>{new Date(a.scheduledAt).toLocaleString()}</td>
                        <td>{a.doctor?.name || '-'}</td>
                        <td><StatusBadge status={a.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div></div>
              )
            )}

            {tab === 'Prescriptions' && (
              prescriptions.length === 0 ? <EmptyState message="No prescriptions on file." /> : (
                <div className="card"><div className="table-responsive"><table className="table mb-0 align-middle">
                  <thead><tr><th>Date</th><th>Doctor</th><th>OD (Sph/Cyl/Axis)</th><th>OS (Sph/Cyl/Axis)</th><th>PD</th></tr></thead>
                  <tbody>
                    {prescriptions.map((p) => (
                      <tr key={p.id}>
                        <td>{new Date(p.issueDate).toLocaleDateString()}</td>
                        <td>{p.doctor?.name || '-'}</td>
                        <td>{p.odSphere ?? '-'} / {p.odCylinder ?? '-'} / {p.odAxis ?? '-'}</td>
                        <td>{p.osSphere ?? '-'} / {p.osCylinder ?? '-'} / {p.osAxis ?? '-'}</td>
                        <td>{p.pd ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div></div>
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}
