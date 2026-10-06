import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import apiClient from '../api/client';
import { setOfflineScope, getOfflineDb, closeOfflineDb, adoptLegacyDatabase } from '../offline/db';
import { purgeReadCaches, syncLocalData } from '../offline/localData';
import { unlock as unlockSecure, lock as lockSecure } from '../offline/secureStore';

// Phase 3.1: the offline database is scoped to tenant + user. Set synchronously wherever a session
// becomes known (including restore after a browser restart) so the first local read already opens
// the right database.
// `authEpoch` orders sign-in/sign-out: the asynchronous clean-up after a sign-out must never undo the
// scope of a sign-in that happened while it was still running.
let authEpoch = 0;
function scopeFor(user) {
  authEpoch += 1;
  setOfflineScope(user ? { tenantId: user.tenantId, userId: user.id } : null);
}

// Sign-in has just proved the password, so it can open (or, if it no longer fits, replace) the key that seals
// this user's personal offline data (offline/secureStore.js). Never blocks or fails a sign-in: without a key
// the protected datasets are simply not stored, and the person can still unlock later.
async function openProtectedStorage(user, password) {
  if (!user?.tenantId || !password) return;
  try {
    await unlockSecure(user.tenantId, password, { authoritative: true });
    syncLocalData(user.tenantId, { reason: 'unlock' }).catch(() => {});
  } catch (err) {
    console.warn('Protected offline storage could not be opened:', err);
  }
}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('akvf_user');
    const restored = raw ? JSON.parse(raw) : null;
    scopeFor(restored);
    return restored;
  });

  // Work queued before per-user databases existed moves into this user's database once.
  useEffect(() => {
    if (user?.tenantId) adoptLegacyDatabase(user.tenantId).catch((err) => console.warn('Legacy offline data adoption failed:', err));
  }, [user?.tenantId, user?.id]);
  const [token, setToken] = useState(() => localStorage.getItem('akvf_token'));
  // Phase 0.2: tenant record (includes enabledIndustryPacks), so screens like
  // Products can decide which industry-specific fields to show. See
  // docs/phase0-2-frontend-ui-architecture.md.
  const [tenant, setTenant] = useState(() => {
    const raw = localStorage.getItem('akvf_tenant');
    return raw ? JSON.parse(raw) : null;
  });
  // Phase 0.4: "effective permissions" for the current role - a flat list of
  // "RESOURCE:ACTION" strings (e.g. "PRODUCT:CREATE"), used only to hide
  // unauthorized actions in the UI. This is a UX convenience, refreshed at
  // login exactly like `user`/`tenant` already are - the backend's
  // requirePermission() middleware remains the actual, authoritative check
  // on every request regardless of what this array says.
  const [permissions, setPermissions] = useState(() => {
    const raw = localStorage.getItem('akvf_permissions');
    return raw ? JSON.parse(raw) : [];
  });

  const login = useCallback(async (email, password) => {
    const { data } = await apiClient.post('/auth/login', { email, password });
    localStorage.setItem('akvf_token', data.token);
    localStorage.setItem('akvf_user', JSON.stringify(data.user));
    if (data.tenant) localStorage.setItem('akvf_tenant', JSON.stringify(data.tenant));
    localStorage.setItem('akvf_permissions', JSON.stringify(data.permissions || []));
    scopeFor(data.user);
    await openProtectedStorage(data.user, password);
    setToken(data.token);
    setUser(data.user);
    setTenant(data.tenant || null);
    setPermissions(data.permissions || []);
    return data.user;
  }, []);

  const registerTenant = useCallback(async (payload) => {
    const { data } = await apiClient.post('/auth/register-tenant', payload);
    localStorage.setItem('akvf_token', data.token);
    localStorage.setItem('akvf_user', JSON.stringify(data.user));
    if (data.tenant) localStorage.setItem('akvf_tenant', JSON.stringify(data.tenant));
    localStorage.setItem('akvf_permissions', JSON.stringify(data.permissions || []));
    scopeFor(data.user);
    await openProtectedStorage(data.user, payload.password);
    setToken(data.token);
    setUser(data.user);
    setTenant(data.tenant || null);
    setPermissions(data.permissions || []);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    // Sign-out removes this user's read copy of shop data from the device, but NEVER their unsynced
    // queue: work recorded offline is still theirs to send when they sign back in.
    const leaving = (() => {
      try { return JSON.parse(localStorage.getItem('akvf_user') || 'null'); } catch { return null; }
    })();
    const epoch = (authEpoch += 1);
    lockSecure(); // the key is forgotten at once; what it sealed stays on disk, unreadable
    if (leaving?.tenantId) {
      // Purge FIRST (while this user's database is the open one), then release it - unless somebody
      // signed in again meanwhile, whose scope must not be undone.
      purgeReadCaches(getOfflineDb(leaving.tenantId))
        .catch(() => {})
        .finally(() => {
          if (epoch === authEpoch) {
            closeOfflineDb();
            setOfflineScope(null);
          }
        });
    } else {
      setOfflineScope(null);
    }
    localStorage.removeItem('akvf_token');
    localStorage.removeItem('akvf_user');
    localStorage.removeItem('akvf_tenant');
    localStorage.removeItem('akvf_permissions');
    setToken(null);
    setUser(null);
    setTenant(null);
    setPermissions([]);
  }, []);

  const hasPermission = useCallback((key) => permissions.includes(key), [permissions]);

  // Phase 0.5: mirrors hasPermission's pattern for industry-module
  // activation - a UX convenience only, the backend's requireModule()
  // middleware remains the actual, authoritative check on every request.
  const hasModule = useCallback(
    (industryPackKey) => (tenant?.enabledIndustryPacks || []).includes(industryPackKey),
    [tenant]
  );

  // Re-fetches the current user/tenant/permissions - used after an action
  // that changes them server-side without a full re-login, e.g. toggling a
  // module on the Modules settings screen (see pages/settings/Modules.jsx).
  const refreshMe = useCallback(async () => {
    const { data } = await apiClient.get('/auth/me');
    localStorage.setItem('akvf_user', JSON.stringify(data.user));
    if (data.tenant) localStorage.setItem('akvf_tenant', JSON.stringify(data.tenant));
    localStorage.setItem('akvf_permissions', JSON.stringify(data.permissions || []));
    setUser(data.user);
    setTenant(data.tenant || null);
    setPermissions(data.permissions || []);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, tenant, permissions, hasPermission, hasModule, refreshMe, login, registerTenant, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
