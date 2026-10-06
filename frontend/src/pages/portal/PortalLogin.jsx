import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePortalAuth } from '../../portal/PortalAuthContext';
import { extractErrorMessage } from '../../components/Feedback';
import portalApi from '../../portal/portalApi';

// Reached via a tenant-specific link (e.g. shared by the shop as
// /portal/login?tenant=<tenantId>) since there is no per-tenant subdomain
// in this deployment - the tenant id is remembered locally so the customer
// doesn't need to re-enter that link on every visit.
export default function PortalLogin() {
  const { tenantId, rememberTenant, requestOtp, verifyOtp, customer } = usePortalAuth();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const navigate = useNavigate();

  // Sign-in is by a code sent over WhatsApp; if this installation cannot send one, say so instead of
  // asking the customer to wait for a message that will never arrive.
  useEffect(() => {
    portalApi
      .get('/auth/config')
      .then((res) => setUnavailable(res.data.portalLoginAvailable === false))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = searchParams.get('tenant');
    if (t) rememberTenant(t);
  }, [searchParams, rememberTenant]);

  useEffect(() => {
    if (customer) navigate('/portal', { replace: true });
  }, [customer, navigate]);

  async function sendCode(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await requestOtp(phone);
      setInfo('If this number is on file with us, a verification code has been sent via WhatsApp.');
      setStep('code');
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await verifyOtp(phone, code);
      navigate('/portal');
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!tenantId) {
    return (
      <div className="d-flex align-items-center justify-content-center vh-100 bg-body-secondary">
        <div className="card p-4" style={{ maxWidth: 420 }}>
          <p className="mb-0 text-body-secondary">This portal link is missing shop information. Please use the link provided by your optical shop or clinic.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="d-flex align-items-center justify-content-center vh-100 bg-body-secondary">
      <div className="card p-4 shadow-sm" style={{ width: 380 }}>
        <h5 className="mb-1">Customer Portal</h5>
        <p className="text-body-secondary small mb-4">View your orders, appointments, and account - no password needed.</p>

        {error && <div className="alert alert-danger py-2 small">{error}</div>}
        {info && <div className="alert alert-info py-2 small">{info}</div>}

        {unavailable ? (
          <div className="alert alert-warning small mb-0" data-testid="portal-unavailable">
            Portal sign-in is not available right now. Please contact the shop directly.
          </div>
        ) : step === 'phone' ? (
          <form onSubmit={sendCode}>
            <div className="mb-3">
              <label className="form-label">Phone Number</label>
              <input className="form-control" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 03001234567" />
            </div>
            <button className="btn btn-primary w-100" type="submit" disabled={busy}>{busy ? 'Sending...' : 'Send Code'}</button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <div className="mb-3">
              <label className="form-label">Verification Code</label>
              <input className="form-control" required maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" />
            </div>
            <button className="btn btn-primary w-100 mb-2" type="submit" disabled={busy}>{busy ? 'Verifying...' : 'Verify & Continue'}</button>
            <button type="button" className="btn btn-link w-100 btn-sm" onClick={() => setStep('phone')}>Use a different number</button>
          </form>
        )}
      </div>
    </div>
  );
}
