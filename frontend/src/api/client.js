import axios from 'axios';
import { appPath, isAtAppPath } from '../utils/appPath';

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000/api',
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('akvf_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Phase 3.1: a successful write that can change stock tells the offline layer to refresh its local
// stock copy right away (it listens; this file imports nothing from it, so there is no cycle).
const STOCK_AFFECTING = new RegExp('/(products|sales|purchases|warehouses|stock-transfers|sales-returns|purchase-returns|goods-receipts|sales-orders|optical-orders|inventory)(/|$)');
function announceStockMutation(res) {
  const method = (res.config?.method || 'get').toLowerCase();
  if (method === 'get' || typeof window === 'undefined') return;
  const url = String(res.config?.url || '');
  if (STOCK_AFFECTING.test(url)) window.dispatchEvent(new CustomEvent('akvf:stock-mutated', { detail: { url, method } }));
}

apiClient.interceptors.response.use(
  (res) => {
    announceStockMutation(res);
    return res;
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('akvf_token');
      localStorage.removeItem('akvf_user');
      if (!isAtAppPath('/login')) {
        window.location.href = appPath('/login');
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
