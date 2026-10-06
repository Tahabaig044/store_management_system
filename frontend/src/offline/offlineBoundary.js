// Phase 2.4: the exact offline boundary for accounting operations.
//
// The offline engine (syncEngine.js) only ever QUEUES an operation when replaying it later
// - possibly twice, possibly after other devices have changed the same records - can
// neither double-apply nor silently change meaning. Everything else stays online-only.
// This file is the single, testable statement of that boundary; docs/phase2-4-... mirrors it.

// Queueable offline. Each carries a client-generated idempotencyKey (the server dedupes on
// it) and every server-side guard is an atomic conditional update, so a replay is either
// applied once or rejected (409/422 -> 'conflict'/'failed', never auto-resolved).
export const OFFLINE_SAFE = {
  sales: 'Creates one sale + its ledger entry; stock and duplicate guards are server-side.',
  purchases: 'Creates one purchase (+ receipt/advance entry); idempotent on its key.',
  expenses: 'Creates one expense + ledger entry; idempotent on its key.',
  payments: 'Only with EXPLICIT allocations to named documents: a stale balance is rejected (422), never mis-applied.',
  customers: 'Master data only - no ledger effect.',
  suppliers: 'Master data only - no ledger effect.',
  quotations: 'Document only - no ledger effect.',
  opticalOrders: 'Creates one order (+ its ledger entry); idempotent on its key.',
  reversals: 'Sale reversal is guarded by an atomic status flip: a replay or a second device gets 409, never a second effect.',
  warehouseStockMoves: 'Idempotent stock move; its inventory entry is posted at SYNC time and valued at the cost then current.',
  // Phase 3.3 - moved here from NEVER_OFFLINE once the server made each of them replay-safe: an idempotency key
  // (a duplicate resolves to the original), the original event time on the record AND its ledger date, and
  // atomic conditional guards (returnedQuantity / stock / note credit / document balance) so a stale
  // request is a coded, visible conflict and can never over-return or over-spend.
  salesReturns: 'Partial return of a completed sale (goods restocked, credit note or - for a walk-in sale - a cash refund). Guarded by returnedQuantity; over-return is RETURN_EXCEEDS.',
  purchaseReturns: 'Partial return to a supplier (stock leaves, debit note). Guarded by returnedQuantity and available stock.',
  creditNotes: 'Issues one credit note + its ledger entry; no dependency on other documents. Idempotent.',
  debitNotes: 'Issues one debit note + its ledger entry; no dependency on other documents. Idempotent.',
  creditRefunds: 'Pays out part of the remaining credit on a note; guarded by an atomic check under the note lock. Idempotent.',
  debitRefunds: 'Receives part of the remaining value of a debit note; same guard. Idempotent.',
  creditApplications: 'Applies EXPLICIT amounts of a credit note to named invoices; a stale balance is BALANCE_CHANGED, never mis-applied.',
  debitApplications: 'Applies EXPLICIT amounts of a debit note to named purchases; same guard.',
};

// Never queued offline: the outcome depends on live balances/state that another device or the
// server may have changed, or the operation is a privileged, ledger-wide control.
export const NEVER_OFFLINE = [
  'manual journal entry (create / post / cancel / reverse)',
  'opening balances',
  'payment with autoAllocate (which documents it settles is decided by server state at sync time)',
  'payment reversal',
  'credit / debit note application REVERSAL, and credit / debit note cancel',
  'whole-purchase return (no line-level guard) and every return REVERSAL',
  'editing a record the server has already accepted (only unaccepted queue entries are editable)',
  'sale/purchase :id/pay (no idempotency key is carried by the generic action outbox)',
  'account create / edit / deactivate / delete',
  'accounting period close',
  'inventory valuation adjustments outside the warehouse stock-move outbox',
];

// Payload guard used by the payments outbox.
export function assertPaymentQueueableOffline(payload) {
  if (payload?.autoAllocate) {
    throw new Error('An auto-allocated payment cannot be queued offline: which invoices it settles depends on the server balances at sync time. Choose the invoices explicitly.');
  }
  if (!Array.isArray(payload?.allocations) || payload.allocations.length === 0) {
    throw new Error('An offline payment must name the documents it settles (explicit allocations).');
  }
}
