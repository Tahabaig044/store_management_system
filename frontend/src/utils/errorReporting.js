// Phase 7.3: previously a frontend crash had no reporting path at all - it
// vanished into the browser console of whichever single user happened to hit
// it. Reports to the backend's new POST /api/client-errors, which reuses the
// exact same captureException()/ALERT_WEBHOOK_URL mechanism backend errors
// already go through - no new third-party SDK, no credentials this
// environment doesn't have.
//
// Deliberately plain `fetch`, not the shared apiClient - error reporting must
// never itself depend on axios/interceptors/auth state, since the very thing
// that broke might be exactly that. Always a fire-and-forget best effort:
// reporting a crash must never itself throw or block the UI.
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

// A per-session cap: a render loop that crashes repeatedly must not turn into
// an unbounded flood against the backend's own rate limiter.
const MAX_REPORTS_PER_SESSION = 20;
let reportCount = 0;
const seenMessages = new Set();

export function reportClientError({ message, stack, source = 'window-error' }) {
  try {
    if (!message) return;
    if (seenMessages.has(message)) return; // same error already reported once this session
    if (reportCount >= MAX_REPORTS_PER_SESSION) return;
    seenMessages.add(message);
    reportCount += 1;

    fetch(`${API_BASE}/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: String(message).slice(0, 500),
        stack: stack ? String(stack).slice(0, 4000) : undefined,
        url: typeof window !== 'undefined' ? window.location.href.slice(0, 500) : undefined,
        source,
      }),
      keepalive: true,
    }).catch(() => {
      // The network itself may be the problem - reporting must never throw.
    });
  } catch {
    // Never let error reporting become one more source of errors.
  }
}

// Installed once, at app startup: catches uncaught exceptions and unhandled
// promise rejections that occur outside React's own render tree (network
// code, event handlers, async callbacks) - the React ErrorBoundary
// (components/ErrorBoundary.jsx) covers render-time errors, which these
// listeners do not see.
export function installGlobalErrorReporting() {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    reportClientError({ message: event.message, stack: event.error?.stack, source: 'window-error' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportClientError({
      message: reason?.message || String(reason),
      stack: reason?.stack,
      source: 'unhandled-rejection',
    });
  });
}
