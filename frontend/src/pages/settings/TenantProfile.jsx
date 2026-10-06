// Phase 1.1: lets any signed-in user view the tenant's business profile
// (name, contact details, currency/timezone, tax IDs), and lets a
// TENANT_ADMIN edit it - the UI for GET/PATCH /api/tenant. Mirrors
// Modules.jsx's shape (load -> form -> save, permission-gated editing).
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

const emptyForm = {
  businessName: '',
  email: '',
  phone: '',
  address: '',
  logoUrl: '',
  currency: '',
  timezone: '',
  ntn: '',
  strn: '',
};

export default function TenantProfile() {
  const { hasPermission, refreshMe } = useAuth();
  const canUpdate = hasPermission('TENANT:UPDATE');

  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await apiClient.get('/tenant');
      const t = data.tenant;
      setForm({
        businessName: t.businessName || '',
        email: t.email || '',
        phone: t.phone || '',
        address: t.address || '',
        logoUrl: t.logoUrl || '',
        currency: t.currency || '',
        timezone: t.timezone || '',
        ntn: t.ntn || '',
        strn: t.strn || '',
      });
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await apiClient.patch('/tenant', form);
      setNotice('Business profile updated.');
      await Promise.all([load(), refreshMe()]);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  const field = (key, label, opts = {}) => (
    <div className="mb-2" key={key}>
      <label className="form-label">{label}</label>
      <input
        className="form-control"
        type={opts.type || 'text'}
        value={form[key]}
        disabled={!canUpdate}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </div>
  );

  return (
    <div>
      <div className="mb-4">
        <h4 className="mb-1">Business Profile</h4>
        <div className="text-body-secondary small">
          Your business's identity and contact details, used across invoices, reports, and the app header.
          {!canUpdate && ' Only a tenant administrator can change this.'}
        </div>
      </div>

      {error && <ErrorAlert message={error} />}
      {notice && <div className="alert alert-info py-2">{notice}</div>}

      <form onSubmit={handleSave} className="card">
        <div className="card-body" style={{ maxWidth: 520 }}>
          {field('businessName', 'Business Name')}
          {field('email', 'Email', { type: 'email' })}
          {field('phone', 'Phone')}
          {field('address', 'Address')}
          {field('logoUrl', 'Logo URL')}
          <div className="row">
            <div className="col-6">{field('currency', 'Currency')}</div>
            <div className="col-6">{field('timezone', 'Timezone')}</div>
          </div>
          <div className="row">
            <div className="col-6">{field('ntn', 'NTN')}</div>
            <div className="col-6">{field('strn', 'STRN')}</div>
          </div>
        </div>
        {canUpdate && (
          <div className="card-footer text-end">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
