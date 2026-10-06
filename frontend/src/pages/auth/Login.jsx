import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, extractErrorMessage } from '../../components/Feedback';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
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
          <h4 className="mb-1">BizOS</h4>
          <p className="text-body-secondary mb-0">Business Operating System</p>
          <p className="text-body-secondary mb-4 small">by OSNUVORA</p>
          <ErrorAlert message={error} />
          <form onSubmit={handleSubmit}>
            <div className="mb-3">
              <label htmlFor="login-email" className="form-label">Email</label>
              <input id="login-email" type="email" className="form-control" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="mb-3">
              <label htmlFor="login-password" className="form-label">Password</label>
              <input
                id="login-password"
                type="password"
                className="form-control"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button className="btn btn-primary w-100" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
          <p className="text-center mt-3 mb-0 small">
            <Link to="/forgot-password">Forgot password?</Link>
          </p>
          <p className="text-center mt-2 mb-0 small">
            New business? <Link to="/register">Create your account</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
