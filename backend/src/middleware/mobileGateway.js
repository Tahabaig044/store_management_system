// Phase 4.3 - the allow-list that lets an Owner/Management MOBILE token reach a small set of EXISTING API endpoints.
//
// Why an allow-list on the existing routes instead of mobile copies of them: the customer, product, sale, purchase,
// approval... endpoints already contain the business rules (validation, permission checks, branch scope, atomic
// guards, audit). The mobile app calls those very routes, so there is exactly one implementation of each rule and
// the phone can never drift from the web. What is NEW here is only the door: a mobile token (typ:'mobile') is
// refused everywhere EXCEPT for the exact method + path patterns below. Everything behind the door - requireTenant,
// requirePermission, branch scope, the handler itself - runs unchanged, for the token's real role.
//
// Adding a line here is a security decision: it exposes an existing endpoint to a phone. Keep it to reads
// (search, lists, details) and to approvals whose handlers are atomic and idempotent by status.
const ID = '[0-9a-fA-F-]{36}';
const re = (path) => new RegExp(`^${path}/?$`);

const ALLOWED = [
  // ---- browse / search / details (GET only) --------------------------------------------------------------
  ['GET', re('/customers')],
  ['GET', re(`/customers/${ID}`)],
  ['GET', re(`/customers/${ID}/history`)],
  ['GET', re('/suppliers')],
  ['GET', re(`/suppliers/${ID}`)],
  ['GET', re(`/suppliers/${ID}/ledger`)],
  ['GET', re('/products')],
  ['GET', re(`/products/${ID}`)],
  ['GET', re('/warehouses')],
  ['GET', re(`/warehouses/${ID}/stock`)],
  ['GET', re('/sales')],
  ['GET', re(`/sales/${ID}`)],
  ['GET', re('/purchases')],
  ['GET', re(`/purchases/${ID}`)],
  ['GET', re('/procurement/purchase-requests')],
  ['GET', re(`/procurement/purchase-requests/${ID}`)],
  ['GET', re('/procurement/purchase-orders')],
  ['GET', re(`/procurement/purchase-orders/${ID}`)],
  ['GET', re('/stock-transfers')],
  ['GET', re(`/stock-transfers/${ID}`)],
  // ---- approvals (each handler flips a status atomically, so a repeat or a race is a clean 409) ----------
  ['POST', re(`/procurement/purchase-requests/${ID}/approve`)],
  ['POST', re(`/procurement/purchase-requests/${ID}/reject`)],
  ['POST', re(`/procurement/purchase-orders/${ID}/approve`)],
  ['POST', re(`/procurement/purchase-orders/${ID}/reject`)],
  ['POST', re(`/stock-transfers/${ID}/approve`)],
  ['POST', re(`/stock-transfers/${ID}/reject`)],
];

// `originalUrl` is what the client asked for (e.g. "/api/customers?search=ann"); the query string never matters.
function isMobileAllowed(method, originalUrl) {
  const full = String(originalUrl || '').split('?')[0];
  if (!full.startsWith('/api/')) return false; // every real request carries the /api prefix
  const path = full.slice('/api'.length);
  return ALLOWED.some(([m, pattern]) => m === String(method).toUpperCase() && pattern.test(path));
}

module.exports = { isMobileAllowed, MOBILE_ALLOWED_COUNT: ALLOWED.length };
