// A deliberately separate axios instance from src/api/client.js. The
// Customer Portal uses its own token (stored under a different
// localStorage key so it can never collide with, or be confused for, a
// staff session) and must never be redirected to the staff /login page on
// a 401 - it has its own login route instead.
import axios from 'axios';
import { appPath, isAtAppPath } from '../utils/appPath';

const portalApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000/api',
});

portalApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('akvf_portal_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

portalApi.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('akvf_portal_token');
      localStorage.removeItem('akvf_portal_customer');
      if (!isAtAppPath('/portal/login')) {
        window.location.href = appPath('/portal/login');
      }
    }
    return Promise.reject(error);
  }
);

export default portalApi;
