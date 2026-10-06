import { createContext, useContext, useState, useCallback } from 'react';
import portalApi from './portalApi';

const PortalAuthContext = createContext(null);

export function PortalAuthProvider({ children }) {
  const [customer, setCustomer] = useState(() => {
    const raw = localStorage.getItem('akvf_portal_customer');
    return raw ? JSON.parse(raw) : null;
  });
  const [token, setToken] = useState(() => localStorage.getItem('akvf_portal_token'));
  const [tenantId, setTenantId] = useState(() => localStorage.getItem('akvf_portal_tenant') || '');

  const rememberTenant = useCallback((id) => {
    localStorage.setItem('akvf_portal_tenant', id);
    setTenantId(id);
  }, []);

  const requestOtp = useCallback(async (phone) => {
    await portalApi.post('/portal/auth/request-otp', { tenantId, phone });
  }, [tenantId]);

  const verifyOtp = useCallback(async (phone, code) => {
    const { data } = await portalApi.post('/portal/auth/verify-otp', { tenantId, phone, code });
    localStorage.setItem('akvf_portal_token', data.token);
    localStorage.setItem('akvf_portal_customer', JSON.stringify(data.customer));
    setToken(data.token);
    setCustomer(data.customer);
    return data.customer;
  }, [tenantId]);

  const logout = useCallback(() => {
    localStorage.removeItem('akvf_portal_token');
    localStorage.removeItem('akvf_portal_customer');
    setToken(null);
    setCustomer(null);
  }, []);

  return (
    <PortalAuthContext.Provider value={{ customer, token, tenantId, rememberTenant, requestOtp, verifyOtp, logout }}>
      {children}
    </PortalAuthContext.Provider>
  );
}

export function usePortalAuth() {
  const ctx = useContext(PortalAuthContext);
  if (!ctx) throw new Error('usePortalAuth must be used within PortalAuthProvider');
  return ctx;
}
