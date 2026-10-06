// Phase 3.4: after a browser restart the protected offline data (customer/supplier records, history,
// open documents and notes) is sealed until the person types their password again. This is the prompt.
// Everything that does not depend on it - selling, the unsent queue, products and stock - keeps working.
import { useEffect, useState } from 'react';
import { unlock, cryptoAvailable } from '../offline/secureStore';
import { useSecureState } from '../offline/useSecureState';
import { syncLocalData } from '../offline/localData';
import { STORAGE_BROKEN_EVENT } from '../offline/reliability';

// The device's offline database could not be opened (corruption, or another tab holding an upgrade).
function useStorageBroken() {
  const [broken, setBroken] = useState(null);
  useEffect(() => {
    const on = (e) => setBroken(e.detail || {});
    window.addEventListener(STORAGE_BROKEN_EVENT, on);
    return () => window.removeEventListener(STORAGE_BROKEN_EVENT, on);
  }, []);
  return broken;
}

export default function OfflineUnlockBanner({ tenantId }) {
  const state = useSecureState(tenantId);
  const broken = useStorageBroken();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (broken) {
    return (
      <div className="alert alert-danger py-2 small mb-0 rounded-0" role="alert" data-testid="storage-broken">
        This device&apos;s offline storage could not be opened ({broken.message || broken.name}). Reload the page. If it keeps happening, sync from another device or contact support before clearing site data - anything not yet sent from this device would be lost.
      </div>
    );
  }
  if (!tenantId || state === 'unlocked') return null;
  if (state === 'unavailable' || !cryptoAvailable()) {
    return (
      <div className="alert alert-warning py-2 small mb-0 rounded-0" role="status" data-testid="secure-unavailable">
        This browser session cannot protect offline data (a secure connection is required), so customer records, history and open documents are not kept on this device.
      </div>
    );
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await unlock(tenantId, password);
      if (!res.ok) {
        setError(res.reason === 'wrong-password' ? 'That password does not open the offline data.' : 'Protected storage is not available here.');
      } else {
        setPassword('');
        syncLocalData(tenantId, { reason: 'unlock' }).catch(() => {});
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="alert alert-warning py-2 small mb-0 rounded-0 d-flex flex-wrap gap-2 align-items-center" onSubmit={submit} data-testid="secure-locked">
      <span>Offline customer records, history and documents are locked. Enter your password to unlock them.</span>
      <input type="password" autoComplete="current-password" aria-label="Password to unlock offline data" className="form-control form-control-sm" style={{ maxWidth: 220 }} value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="btn btn-sm btn-primary" disabled={busy || !password}>{busy ? 'Unlocking...' : 'Unlock'}</button>
      {error && <span className="text-danger" role="alert">{error}</span>}
    </form>
  );
}
