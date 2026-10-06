import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'bootstrap/dist/css/bootstrap.min.css';
import './index.css';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { installGlobalErrorReporting } from './utils/errorReporting.js';

// Phase 7.3: reports uncaught exceptions/rejections outside React's render
// tree; ErrorBoundary below covers render-time crashes - together they're the
// first frontend error visibility this app has ever had.
installGlobalErrorReporting();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // Registered under BASE_URL (/BizOS/) so the worker's default scope
    // matches where the app actually lives, not the domain root.
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`).catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}
