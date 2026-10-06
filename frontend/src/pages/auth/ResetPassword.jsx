import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import apiClient from '../../api/client';
import { ErrorAlert, extractErrorMessage } from '../../components/Feedback';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await apiClient.post('/auth/reset-password', { token, password });
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
          <h4 className="mb-1">Choose a new password</h4>
          {!token ? (
            <div className="alert alert-danger mt-3">This reset link is incomplete. Request a new one.</div>
          ) : done ? (
            <div className="alert alert-success mt-3">
              Password updated. <Link to="/login">Sign in</Link>
            </div>
          ) : (
            <>
              <p className="text-body-secondary mb-4">8-72 characters, with at least one letter and one number.</p>
              <ErrorAlert message={error} />
              <form onSubmit={handleSubmit}>
                <div className="mb-3">
                  <label htmlFor="reset-password" className="form-label">New password</label>
                  <input id="reset-password" type="password" className="form-control" required minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <div className="mb-3">
                  <label htmlFor="reset-confirm" className="form-label">Confirm new password</label>
                  <input id="reset-confirm" type="password" className="form-control" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </div>
                <button className="btn btn-primary w-100" disabled={loading}>
                  {loading ? 'Saving...' : 'Update password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
