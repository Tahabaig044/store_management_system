// Phase 3.2: the pure decisions of the synchronization engine - kept free of I/O so each rule can be
// tested exactly. The processing loop that uses them is syncCoordinator.js; the queues themselves
// (tables, idempotency keys, optimistic effects) are the Phase 2 outboxes in syncEngine.js.

// ---------------------------------------------------------------------------------------------
// Registry: every outbox registers how its entries become HTTP requests, so ONE coordinator can
// process all of them in a single, ordered pass (instead of each outbox draining on its own).
// ---------------------------------------------------------------------------------------------
const registry = new Map(); // tableName -> { tableName, label, request(payload) -> {path, body?}, intentIdempotent }

export function registerOutbox(def) {
  registry.set(def.tableName, def);
}
export const getRegistered = (tableName) => registry.get(tableName);
export const registeredTables = () => [...registry.keys()];

// ---------------------------------------------------------------------------------------------
// Dependencies between queued operations
// ---------------------------------------------------------------------------------------------
// A queued record can refer to another QUEUED record whose real id does not exist yet (a sale for a
// customer created offline, a payment for an offline sale, the reversal of one). It writes the
// reference as the string "$ref:<clientId>"; the coordinator sends nothing that depends on an
// entry until that entry has synced, then substitutes the real server id.
const REF_PREFIX = '$ref:';
// A reference may point INTO the dependency's server reply with "#path" - e.g. "$ref:<saleClientId>#items.0.id"
// is the real id of the first line of an offline sale (needed to return part of it).
export const refTo = (clientId, path) => `${REF_PREFIX}${clientId}${path ? `#${path}` : ''}`;
const isRef = (v) => typeof v === 'string' && v.startsWith(REF_PREFIX);
const refId = (v) => v.slice(REF_PREFIX.length).split('#')[0];
const refPath = (v) => (v.includes('#') ? v.slice(v.indexOf('#') + 1) : '');

export function extractRefs(value, out = new Set()) {
  if (isRef(value)) out.add(refId(value));
  else if (Array.isArray(value)) value.forEach((v) => extractRefs(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => extractRefs(v, out));
  return out;
}

// Returns a copy of `value` with every reference replaced by lookup(clientId) (the real id).
export function resolveRefs(value, lookup) {
  if (isRef(value)) {
    const target = lookup(refId(value), refPath(value));
    return target;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, lookup));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, lookup)]));
  return value;
}

// ---------------------------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------------------------
// Failing to REACH the server (offline, DNS, connection reset) is never counted: the queue simply
// waits for the network. A server that answers with a transient error (5xx, 408, 429) is retried
// with bounded exponential backoff; after MAX_SERVER_ATTEMPTS the item becomes a visible 'failed'
// item awaiting a person - it is never dropped.
export const MAX_SERVER_ATTEMPTS = 8;
const BASE_DELAY_MS = 5000;
const CAP_DELAY_MS = 5 * 60 * 1000;

export function backoffMs(attempts, random = Math.random) {
  const raw = Math.min(BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0), CAP_DELAY_MS);
  return Math.round(raw * (0.8 + 0.4 * random())); // +/-20% jitter so terminals do not retry in lockstep
}

// ---------------------------------------------------------------------------------------------
// Deterministic classification of a failed request
// ---------------------------------------------------------------------------------------------
// The server sends a stable `code` with every rejection (backend utils/errors.js). The decision uses
// the HTTP status and that code - never message text - so the same rejection always lands in the
// same state:
//   'network'  could not reach the server            -> wait, do not count, stop this pass
//   'auth'     401                                   -> pause the whole queue until signed in again
//   'server'   5xx / 408 / 425 / 429                 -> retry with backoff (bounded)
//   'success'  409 ALREADY_APPLIED on an action whose INTENT is idempotent (a reversal that was
//              already applied - by an earlier attempt whose reply was lost, or by anyone else)
//   'conflict' the server state moved on (stock, document status, period, balance, missing record)
//              -> visible conflict a person resolves; never auto-overwritten
//   'failed'   permanent rejection (validation, permission)
const CONFLICT_CODES = new Set(['STOCK_INSUFFICIENT', 'ALREADY_APPLIED', 'DOCUMENT_NOT_OPEN', 'PERIOD_CLOSED', 'BALANCE_CHANGED', 'RETURN_EXCEEDS', 'DUPLICATE', 'NOT_FOUND', 'CONFLICT']);

export function classifyFailure(err, { intentIdempotent = false } = {}) {
  const res = err?.response;
  if (!res) return { action: 'network', message: err?.message || 'Network unreachable' };
  const status = res.status;
  const code = res.data?.code;
  const message = res.data?.error || `Request failed (${status})`;
  // `details` = the machine-readable facts behind the conflict (stock actually available, quantity still
  // returnable...) - what an edit-and-retry suggestion is computed from.
  const failure = { status, code: code || null, message, details: res.data?.details && !res.data.details.fieldErrors ? res.data.details : null, at: Date.now() };

  if (status === 401) return { action: 'auth', ...failure, kind: 'AUTH' };
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { action: 'server', ...failure, kind: 'SERVER_ERROR' };
  if (status === 409) {
    if (code === 'ALREADY_APPLIED' && intentIdempotent) return { action: 'success', ...failure, kind: 'ALREADY_APPLIED' };
    return { action: 'conflict', ...failure, kind: code || 'CONFLICT' };
  }
  if (status === 404) return { action: 'conflict', ...failure, kind: 'NOT_FOUND' };
  if (status === 422 && (code === 'BALANCE_CHANGED' || code === 'STOCK_INSUFFICIENT' || code === 'RETURN_EXCEEDS')) return { action: 'conflict', ...failure, kind: code };
  if (status === 403) return { action: 'failed', ...failure, kind: 'FORBIDDEN' };
  if (CONFLICT_CODES.has(code)) return { action: 'conflict', ...failure, kind: code };
  return { action: 'failed', ...failure, kind: code || 'REJECTED' };
}

// What to tell the person, and what they may do about it.
const GUIDE = {
  STOCK_INSUFFICIENT: { title: 'Not enough stock on the server', advice: 'Stock was used elsewhere while this terminal was offline. Retry once stock is available, or discard it and record the sale again with what is actually in stock.' },
  ALREADY_APPLIED: { title: 'Already applied on the server', advice: 'This document was already reversed or returned. It can be discarded.' },
  DOCUMENT_NOT_OPEN: { title: 'The document changed on the server', advice: 'The document this refers to is no longer open (for example it was reversed). Review it, then discard.' },
  PERIOD_CLOSED: { title: 'Accounting period is closed', advice: 'The date this happened falls in a closed accounting period. Ask an administrator to reopen it, then retry - or discard.' },
  RETURN_EXCEEDS: { title: 'More was returned than can still be returned', advice: 'Another terminal (or an earlier return) already took back part of this. Edit the quantity to what is still returnable, then retry.' },
  BALANCE_CHANGED: { title: 'The balance changed on the server', advice: 'The amount no longer fits what is owed. Check the document, then discard and re-enter.' },
  DUPLICATE: { title: 'A record with these details already exists', advice: 'Nothing was created twice. Review the existing record, then discard.' },
  NOT_FOUND: { title: 'A record it refers to no longer exists', advice: 'It was deleted or deactivated on the server. Discard it.' },
  CONFLICT: { title: 'Rejected because the server state changed', advice: 'Review, then retry or discard.' },
  FORBIDDEN: { title: 'Not permitted', advice: 'Your account may not do this. Ask an administrator, or discard.' },
  SERVER_ERROR: { title: 'The server kept failing', advice: 'Retry later. Nothing was lost.' },
  DEPENDENCY_DISCARDED: { title: 'Waiting record was discarded', advice: 'This depends on a record that was discarded, so it cannot be sent. Discard it too, or re-enter both.' },
  CORRUPT: { title: 'This entry is damaged', advice: 'It cannot be sent. Discard it and enter it again.' },
  REJECTED: { title: 'Rejected by the server', advice: 'The data was not accepted. Correct and re-enter it, or discard.' },
  VALIDATION: { title: 'Rejected by the server', advice: 'The data was not accepted. Correct and re-enter it, or discard.' },
};

export function describeFailure(failure) {
  if (!failure) return null;
  const g = GUIDE[failure.kind] || GUIDE[failure.code] || GUIDE.REJECTED;
  // Retrying makes sense when the cause may clear by itself (stock arrives, period reopened, server recovers).
  const retryable = ['STOCK_INSUFFICIENT', 'PERIOD_CLOSED', 'SERVER_ERROR', 'CONFLICT', 'FORBIDDEN', 'REJECTED', 'VALIDATION', 'BALANCE_CHANGED'].includes(failure.kind);
  // Editing is the fix when the request itself no longer fits reality (never for a server hiccup or a
  // permission problem).
  const editable = !['SERVER_ERROR', 'FORBIDDEN', 'ALREADY_APPLIED', 'DEPENDENCY', 'DEPENDENCY_DISCARDED', 'CORRUPT'].includes(failure.kind);
  return { title: g.title, advice: g.advice, detail: failure.message, retryable, editable };
}
