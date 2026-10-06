import { getOfflineDb } from './db';
import { assertPaymentQueueableOffline } from './offlineBoundary';
import { decrementCachedStock, decrementCachedStockIfItems, incrementCachedStockIfReceiving, applyWarehouseStockMoveOptimistically, applySalesReturnEffect, applyPurchaseReturnEffect } from './pendingEffects';
import { assertReturnFits, assertApplicationFits, assertRefundFits } from './derivedViews';
import { syncLocalData } from './localData';
import { registerOutbox, extractRefs } from './syncCore';
import { processQueue, retryEntry, discardEntry, QUEUED_EVENT } from './syncCoordinator';

// Phase 2 offline architecture, generalized in slice 2 beyond just Sales.
//
// Design (unchanged from slice 1, now shared across every offline-capable
// entity):
// - Every offline-capable create is written to its own local outbox table
//   first, then synced - the user never waits on the network to save it.
// - Each queued item carries a client-generated idempotencyKey, created once
//   at queue time and never regenerated, so a retried sync (after a dropped
//   connection mid-request) can never create a duplicate record. The server
//   enforces this via a @@unique([tenantId, idempotencyKey]) constraint on
//   every model that accepts one.
// - Conflicts are never auto-resolved. If the server rejects an item (4xx),
//   it's marked 'conflict' (409) or 'failed' (other 4xx) and left for a
//   human to review via the sync status UI - never silently dropped.
// - Each outbox drains sequentially, oldest first, so entities that check
//   server-side invariants (like Sales checking stock) see a consistent
//   order of events.
//
// Known limitation: an offline-created record (e.g. a new Customer) cannot
// yet be referenced by another offline-created record (e.g. a Sale for that
// customer) in the same offline session, because the real server ID doesn't
// exist until it syncs. Referencing already-existing (previously synced)
// customers/suppliers/products while offline works fine.

const isQuotaError = (err) => [err?.name, err?.inner?.name].includes('QuotaExceededError');

function generateClientId() {
  return crypto.randomUUID();
}

// Builds an outbox (queue/list/sync/retry/discard/submit) for one entity type. Since Phase 3.2 an outbox
// only OWNS its table and knows how its entries become requests; ordering, dependencies, retry,
// conflict classification and recovery are the single coordinator's job (syncCoordinator.js), which
// every outbox registers with.
//
// `applyOptimisticEffect(db, payload)` is optional - used by entities whose creation has a side effect
// on the local stock copy (Sales deduct, Purchases add) so the POS/product views stay consistent
// between syncs (pendingEffects.js re-applies it on top of every fresh download while it is queued).
// `stampOccurredAt` records WHEN the event happened on the device, so the server can keep the original
// business time instead of the sync time.
function buildOutbox({ tableName, label, request, intentIdempotent = false, applyOptimisticEffect, validatePayload, stampOccurredAt = false, idempotent = true }) {
  registerOutbox({ tableName, label, request, intentIdempotent });

  async function queue(tenantId, payload) {
    const db = getOfflineDb(tenantId);
    // Phase 2.4: an operation outside the offline boundary is refused BEFORE it is stored. Since 3.3 the
    // check may also look at the local copy (does this return still fit what can be returned?).
    if (validatePayload) await validatePayload(payload, db);
    const clientId = generateClientId();
    // `_display` is what the screen needs to show the entry (names, numbers); it is not part of the request.
    const { _display: display, ...requestPayload } = payload;
    const finalPayload = { ...requestPayload };
    if (idempotent) finalPayload.idempotencyKey = payload.idempotencyKey || clientId;
    if (stampOccurredAt && !finalPayload.occurredAt) finalPayload.occurredAt = new Date().toISOString();
    const entry = {
      clientId,
      status: 'pending',
      createdAt: Date.now(),
      payload: finalPayload,
      dependsOn: [...extractRefs(finalPayload)],
      attempts: 0,
      failure: null,
      lastError: null,
      serverResult: null,
      ...(display ? { display } : {}),
    };

    try {
      await db.transaction('rw', db[tableName], db.products, db.warehouseStock, async () => {
        await db[tableName].add(entry);
        if (applyOptimisticEffect) await applyOptimisticEffect(db, entry.payload, entry);
      });
    } catch (err) {
      // A full device is the one storage failure a person can fix; say so instead of surfacing a raw error.
      // The transaction is atomic: nothing was half-written.
      if (isQuotaError(err)) throw Object.assign(new Error('This device is out of storage, so the transaction could not be saved. Free some space and try again - nothing was recorded.'), { code: 'STORAGE_FULL', cause: err });
      throw err;
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(QUEUED_EVENT, { detail: { tableName, clientId } }));
    return entry;
  }

  async function listPending(tenantId) {
    return getOfflineDb(tenantId)[tableName].orderBy('createdAt').toArray();
  }

  // Processes THIS outbox's entries (ignoring retry backoff - someone asked for it now), in order.
  function sync(tenantId) {
    return processQueue(tenantId, { only: [tableName], force: true });
  }

  const retry = (tenantId, clientId) => retryEntry(tenantId, tableName, clientId);
  const discard = (tenantId, clientId) => discardEntry(tenantId, tableName, clientId);

  // Convenience for form submit handlers: queue, then - if online - attempt to sync immediately and
  // return the final state (synced/conflict/failed/pending) so every caller need not re-implement it.
  async function submit(tenantId, payload) {
    const entry = await queue(tenantId, payload);
    if (navigator.onLine) {
      await sync(tenantId);
      return getOfflineDb(tenantId)[tableName].get(entry.clientId);
    }
    return entry;
  }

  return { queue, listPending, sync, retry, discard, submit };
}

// A "create a new top-level record" outbox: POST the payload to a fixed path.
function createOutbox({ tableName, label, apiPath, ...rest }) {
  return buildOutbox({ tableName, label, request: (payload) => ({ path: apiPath, body: payload }), ...rest });
}

// An outbox for an action against an *existing* server record (e.g. reversing a sale), or one that
// needs a per-entry URL. `includeBody` posts the payload (with a client idempotency key) as the body;
// without it the request has no body and the server identifies the target by the id in the URL. Such
// an action is guarded by an atomic server-side state check rather than a key, so replaying it after a
// lost reply is answered "already applied" - see `intentIdempotent` in syncCore.classifyFailure.
function createActionOutbox({ tableName, label, buildPath, includeBody = false, intentIdempotent = false, ...rest }) {
  return buildOutbox({
    tableName,
    label,
    request: (payload) => ({ path: buildPath(payload), body: includeBody ? payload : undefined }),
    intentIdempotent,
    idempotent: includeBody,
    ...rest,
  });
}

const salesOutbox = createOutbox({ tableName: 'pendingSales', label: 'Sale', apiPath: '/sales', applyOptimisticEffect: decrementCachedStock, stampOccurredAt: true });
const purchasesOutbox = createOutbox({
  tableName: 'pendingPurchases',
  label: 'Purchase',
  apiPath: '/purchases',
  stampOccurredAt: true,
  applyOptimisticEffect: incrementCachedStockIfReceiving,
});
const expensesOutbox = createOutbox({ tableName: 'pendingExpenses', label: 'Expense', apiPath: '/expenses', stampOccurredAt: true });
// Phase 1.11: standalone customer/supplier payments (POST /payments) are a
// plain "create a new top-level record" case like Sales/Purchases/Expenses -
// no per-target URL needed (createActionOutbox, used for warehouse stock
// moves, would be the wrong tool here), so this reuses createOutbox exactly
// as-is. No frontend screen creates a standalone payment yet (payments are
// still primarily surfaced via Customer/Supplier history and Sale's/
// Purchase's own :id/pay), so this outbox exists and is directly tested but
// unused by any UI so far - see this phase's report, Deferred Items.
const paymentsOutbox = createOutbox({ tableName: 'pendingPayments', label: 'Payment', apiPath: '/payments', validatePayload: assertPaymentQueueableOffline, stampOccurredAt: true });
const customersOutbox = createOutbox({ tableName: 'pendingCustomers', label: 'Customer', apiPath: '/customers' });
// Phase 1.14: Quotation creation has no stock or financial effect of its
// own (unlike Sale/Purchase), so it is exactly as safe to queue offline as
// the existing Expense/Customer/Payment outboxes - a plain "create" case,
// no applyOptimisticEffect needed. Sales Order creation, and every
// Quotation/SalesOrder status transition and conversion action, are
// deliberately NOT given offline support (see this phase's report,
// Offline-First Verification) - those are multi-step, guard-dependent
// operations more like the Returns/Credit/Debit Notes Phase 1.13 also left
// online-only, not simple single-entity creates.
const quotationsOutbox = createOutbox({ tableName: 'pendingQuotations', label: 'Quotation', apiPath: '/quotations' });
const suppliersOutbox = createOutbox({ tableName: 'pendingSuppliers', label: 'Supplier', apiPath: '/suppliers' });
const opticalOrdersOutbox = createOutbox({ tableName: 'pendingOpticalOrders', label: 'Optical Order', apiPath: '/optical-orders', applyOptimisticEffect: decrementCachedStockIfItems });
const reversalsOutbox = createActionOutbox({
  tableName: 'pendingReversals',
  label: 'Sale Reversal',
  intentIdempotent: true,
  buildPath: (payload) => `/sales/${payload.saleId}/reverse`,
});
// Phase 1.10: a single generic outbox for all three direct warehouse
// stock-move endpoints (receive/dispatch/adjust) - the payload's own
// `action` field picks the URL, so this doesn't need three near-identical
// outboxes. `includeBody: true` posts the payload (productId/quantity/note/
// idempotencyKey) as the request body and attaches a client-generated
// idempotencyKey at queue time, matching the server's new Phase 1.10
// idempotency support on these endpoints.
const warehouseStockMovesOutbox = createActionOutbox({
  tableName: 'pendingWarehouseStockMoves',
  label: 'Warehouse Stock Move',
  stampOccurredAt: true,
  buildPath: (payload) => `/warehouses/${payload.warehouseId}/${payload.action}`,
  includeBody: true,
  applyOptimisticEffect: applyWarehouseStockMoveOptimistically,
});

// ---------------------------------------------------------------------------------------------
// Phase 3.3: returns, credit/debit notes, note applications and refunds.
// Each is idempotent on its key, carries the time it really happened (occurredAt), and every server
// guard (returnedQuantity, stock, note credit, document balance) is an atomic conditional update - so a
// stale request is refused as a visible conflict, never over-applied. Applications and refunds may name
// a note that is itself still queued ("$ref:"), which the coordinator sends first.
// ---------------------------------------------------------------------------------------------
const salesReturnsOutbox = createOutbox({ tableName: 'pendingSalesReturns', label: 'Sales Return', apiPath: '/sales-returns', stampOccurredAt: true, applyOptimisticEffect: applySalesReturnEffect, validatePayload: (p, db) => assertReturnFits(db, 'sale', p) });
const purchaseReturnsOutbox = createOutbox({ tableName: 'pendingPurchaseReturns', label: 'Purchase Return', apiPath: '/purchase-returns', stampOccurredAt: true, applyOptimisticEffect: applyPurchaseReturnEffect, validatePayload: (p, db) => assertReturnFits(db, 'purchase', p) });
const creditNotesOutbox = createOutbox({ tableName: 'pendingCreditNotes', label: 'Credit Note', apiPath: '/credit-notes', stampOccurredAt: true, validatePayload: assertNoteQueueable });
const debitNotesOutbox = createOutbox({ tableName: 'pendingDebitNotes', label: 'Debit Note', apiPath: '/debit-notes', stampOccurredAt: true, validatePayload: assertNoteQueueable });
const refundOf = ({ noteId: _noteId, ...body }) => body; // the note is in the URL, not the body
const creditRefundsOutbox = buildOutbox({ tableName: 'pendingCreditRefunds', label: 'Credit Note Refund', request: (p) => ({ path: `/credit-notes/${p.noteId}/refund`, body: refundOf(p) }), stampOccurredAt: true, validatePayload: (p, db) => assertRefundFits(db, 'credit', p) });
const debitRefundsOutbox = buildOutbox({ tableName: 'pendingDebitRefunds', label: 'Debit Note Refund', request: (p) => ({ path: `/debit-notes/${p.noteId}/refund`, body: refundOf(p) }), stampOccurredAt: true, validatePayload: (p, db) => assertRefundFits(db, 'debit', p) });
const creditApplicationsOutbox = createOutbox({ tableName: 'pendingCreditApplications', label: 'Credit Note Application', apiPath: '/receivables/note-applications', stampOccurredAt: true, validatePayload: (p, db) => assertApplicationFits(db, 'credit', p) });
const debitApplicationsOutbox = createOutbox({ tableName: 'pendingDebitApplications', label: 'Debit Note Application', apiPath: '/payables/note-applications', stampOccurredAt: true, validatePayload: (p, db) => assertApplicationFits(db, 'debit', p) });

function assertNoteQueueable(payload) {
  if (!payload.customerId && !payload.supplierId) throw new Error('Choose who the note is for.');
  if (!(Number(payload.amount) > 0)) throw new Error('The amount must be greater than zero.');
  if (!payload.reason || !String(payload.reason).trim()) throw new Error('A reason is required.');
}

export const OUTBOXES = {
  sales: salesOutbox,
  purchases: purchasesOutbox,
  expenses: expensesOutbox,
  customers: customersOutbox,
  suppliers: suppliersOutbox,
  opticalOrders: opticalOrdersOutbox,
  reversals: reversalsOutbox,
  warehouseStockMoves: warehouseStockMovesOutbox,
  payments: paymentsOutbox,
  quotations: quotationsOutbox,
  salesReturns: salesReturnsOutbox,
  purchaseReturns: purchaseReturnsOutbox,
  creditNotes: creditNotesOutbox,
  debitNotes: debitNotesOutbox,
  creditRefunds: creditRefundsOutbox,
  debitRefunds: debitRefundsOutbox,
  creditApplications: creditApplicationsOutbox,
  debitApplications: debitApplicationsOutbox,
};

// Backwards-compatible named exports (slice 1 API surface, used by Pos.jsx).
export const queueSale = salesOutbox.queue;
export const listPendingSales = salesOutbox.listPending;
export const syncPendingSales = salesOutbox.sync;
export const retryPendingSale = salesOutbox.retry;
export const discardPendingSale = salesOutbox.discard;

// Runs every entity's outbox. Safe to call opportunistically (on reconnect,
// on mount, or from a manual "Sync Now") - each outbox no-ops if its queue
// is empty.
export async function syncAll(tenantId) {
  return processQueue(tenantId, { force: true });
}

// Phase 3.1: the local read cache (products, customers, suppliers, expense categories, branches,
// warehouses, per-warehouse stock) is now owned by localData.js - versioned, paged (no truncation),
// scope-checked and stock-aware. These names stay exported from here so every existing caller and
// test keeps working unchanged.
export { getCacheFreshness, getCachedProducts, getCachedCustomers, getCachedSuppliers, getCachedExpenseCategories } from './localData';

// Non-blocking, de-duplicated, cheap when nothing changed: compares the server's dataset versions
// and only downloads what is different. Resolves (never rejects) offline.
export async function refreshCaches(tenantId) {
  return syncLocalData(tenantId, { reason: 'refreshCaches' });
}
