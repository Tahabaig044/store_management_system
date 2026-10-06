import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../../api/client';
import { ErrorAlert, extractErrorMessage } from '../../components/Feedback';

export default function ForgotPassword() {
  const [emailEnabled, setEmailEnabled] = useState(null); // null = still checking
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiClient
      .get('/auth/config')
      .then((res) => setEmailEnabled(Boolean(res.data.passwordResetByEmail)))
      .catch(() => setEmailEnabled(false));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await apiClient.post('/auth/forgot-password', { email });
      setDone(true);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="d-flex align-items-center justify-content-center vh-100 bg-body-tertiary">
      <div className="card shadow-sm" style={{ width: '380px' }}>
        <div className="card-body p-4">
          <h4 className="mb-1">Reset your password</h4>
          {emailEnabled === false ? (
            <p className="text-body-secondary mb-4" data-testid="no-email-reset">
              Password reset by email is not set up on this system. Ask your business administrator to send you a
              reset link (Users &rarr; Reset link).
            </p>
          ) : done ? (
            <div className="alert alert-success mt-3">
              If an account exists for that email, a reset link has been sent. It is valid for 1 hour.
            </div>
          ) : (
            <>
              <p className="text-body-secondary mb-4">Enter your account email and we will send you a reset link.</p>
              <ErrorAlert message={error} />
              <form onSubmit={handleSubmit}>
                <div className="mb-3">
                  <label htmlFor="forgot-email" className="form-label">Email</label>
                  <input id="forgot-email" type="email" className="form-control" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <button className="btn btn-primary w-100" disabled={loading || emailEnabled === null}>
                  {loading ? 'Sending...' : 'Send reset link'}
                </button>
              </form>
            </>
          )}
          <p className="text-center mt-3 mb-0 small">
            <Link to="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
