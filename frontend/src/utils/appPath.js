// The app is served under a base path (/BizOS/, see vite.config.js), and the router's basename is that
// same value. A hard browser navigation (window.location) bypasses the router, so it has to carry the
// base path itself: a bare '/login' is outside the app and renders nothing.
export function appPath(path = '/') {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

// True when the browser is already at (or below) the given in-app path.
export function isAtAppPath(path) {
  return window.location.pathname.startsWith(appPath(path));
}
