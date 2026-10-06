// Phase 3.3: editing a queued transaction, and fixing a conflicted one by editing it.
//
// The rule that makes this safe: only work that has NOT been accepted by the server can be edited.
//   - 'pending' / 'conflict' / 'failed' / 'blocked' entries: nothing of them exists on the server, so
//     changing what will be sent changes nothing that already happened.
//   - 'synced' / 'syncing': never. A synced record is the server's (editing it would need version
//     tokens and merge rules - not offered; correct it online, or reverse and re-enter).
//   - `maybeApplied`: a send that ended WITHOUT an answer (dropped reply, 5xx, crash) may have been
//     applied. Replaying it with the same idempotency key would return the ORIGINAL record and
//     silently ignore any edit, so such an entry must first be replayed ("Check") until the server
//     answers definitively; only a definitive rejection makes it editable.
// What an edit may NOT change: the idempotency key, the original event time (except as an explicit,
// logged correction of a closed-period conflict), and which record it is (the outbox).
// Every edit is logged on the entry (revisions: who-knows-what changed, when, and which conflict it
// resolved) - nothing is edited silently.
import { getOfflineDb } from './db';
import { extractRefs } from './syncCore';
import { applyPendingOverlay } from './pendingEffects';
import { QUEUED_EVENT } from './syncCoordinator';
import { PAYMENT_METHODS } from '../constants/paymentMethods';

export const EDITABLE_STATUSES = ['pending', 'conflict', 'failed', 'blocked'];
const MAX_REVISIONS = 20;

// ---------------------------------------------------------------------------------------------
// What can be edited, per outbox
// ---------------------------------------------------------------------------------------------
// type: number | text | textarea | select | party | boolean. `lines` describes a repeated group.
const method = { key: 'paymentMethod', label: 'Payment method', type: 'select', options: PAYMENT_METHODS };
const refundMethod = { key: 'method', label: 'Refund method', type: 'select', options: PAYMENT_METHODS };

export const EDIT_SPECS = {
  pendingSales: {
    label: 'Sale',
    fields: [
      { key: 'customerId', label: 'Customer', type: 'party', party: 'customers' },
      method,
      { key: 'discount', label: 'Discount', type: 'number', min: 0 },
      { key: 'tax', label: 'Tax', type: 'number', min: 0 },
      { key: 'amountPaid', label: 'Amount paid', type: 'number', min: 0 },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    lines: { key: 'items', label: 'Items', minLines: 1, columns: [
      { key: 'quantity', label: 'Qty', type: 'number', min: 0, positive: true },
      { key: 'unitPrice', label: 'Unit price', type: 'number', min: 0 },
      { key: 'discount', label: 'Discount', type: 'number', min: 0 },
    ] },
  },
  pendingPurchases: {
    label: 'Purchase',
    fields: [
      { key: 'supplierId', label: 'Supplier', type: 'party', party: 'suppliers' },
      method,
      { key: 'amountPaid', label: 'Amount paid', type: 'number', min: 0 },
      { key: 'receiveImmediately', label: 'Received now', type: 'boolean' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    lines: { key: 'items', label: 'Items', minLines: 1, columns: [
      { key: 'quantity', label: 'Qty', type: 'number', min: 0, positive: true },
      { key: 'unitCost', label: 'Unit cost', type: 'number', min: 0 },
    ] },
  },
  pendingExpenses: {
    label: 'Expense',
    fields: [
      { key: 'amount', label: 'Amount', type: 'number', min: 0, positive: true },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'method', label: 'Payment method', type: 'select', options: PAYMENT_METHODS },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  pendingPayments: {
    label: 'Payment',
    fields: [{ key: 'method', label: 'Method', type: 'select', options: PAYMENT_METHODS }, { key: 'note', label: 'Note', type: 'text' }],
    // The total is always the sum of the allocations - it is derived, never typed twice.
    lines: { key: 'allocations', label: 'Applied to', minLines: 1, columns: [{ key: 'amount', label: 'Amount', type: 'number', min: 0, positive: true }] },
    derive: (p) => ({ ...p, amount: round2((p.allocations || []).reduce((s, a) => s + Number(a.amount || 0), 0)) }),
  },
  pendingCustomers: { label: 'Customer', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }, { key: 'address', label: 'Address', type: 'text' }] },
  pendingSuppliers: { label: 'Supplier', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }, { key: 'address', label: 'Address', type: 'text' }] },
  pendingWarehouseStockMoves: { label: 'Warehouse stock move', fields: [{ key: 'quantity', label: 'Quantity', type: 'number', positive: true }, { key: 'note', label: 'Note', type: 'text' }] },
  pendingSalesReturns: {
    label: 'Sales return',
    fields: [{ key: 'reason', label: 'Reason', type: 'text' }, { key: 'notes', label: 'Notes', type: 'textarea' }, { key: 'issueCreditNote', label: 'Issue a credit note', type: 'boolean' }],
    lines: { key: 'items', label: 'Returned items', minLines: 1, columns: [{ key: 'quantity', label: 'Qty', type: 'number', min: 0, positive: true }] },
  },
  pendingPurchaseReturns: {
    label: 'Purchase return',
    fields: [{ key: 'reason', label: 'Reason', type: 'text' }, { key: 'notes', label: 'Notes', type: 'textarea' }, { key: 'issueDebitNote', label: 'Issue a debit note', type: 'boolean' }],
    lines: { key: 'items', label: 'Returned items', minLines: 1, columns: [{ key: 'quantity', label: 'Qty', type: 'number', min: 0, positive: true }] },
  },
  pendingCreditNotes: { label: 'Credit note', fields: [{ key: 'amount', label: 'Amount', type: 'number', positive: true }, { key: 'tax', label: 'Tax', type: 'number', min: 0 }, { key: 'reason', label: 'Reason', type: 'text', required: true }, { key: 'notes', label: 'Notes', type: 'textarea' }] },
  pendingDebitNotes: { label: 'Debit note', fields: [{ key: 'amount', label: 'Amount', type: 'number', positive: true }, { key: 'tax', label: 'Tax', type: 'number', min: 0 }, { key: 'reason', label: 'Reason', type: 'text', required: true }, { key: 'notes', label: 'Notes', type: 'textarea' }] },
  pendingCreditRefunds: { label: 'Credit note refund', fields: [{ key: 'amount', label: 'Amount', type: 'number', positive: true }, refundMethod] },
  pendingDebitRefunds: { label: 'Debit note refund', fields: [{ key: 'amount', label: 'Amount', type: 'number', positive: true }, refundMethod] },
  pendingCreditApplications: { label: 'Credit note application', lines: { key: 'allocations', label: 'Applied to', minLines: 1, columns: [{ key: 'amount', label: 'Amount', type: 'number', positive: true }] } },
  pendingDebitApplications: { label: 'Debit note application', lines: { key: 'allocations', label: 'Applied to', minLines: 1, columns: [{ key: 'amount', label: 'Amount', type: 'number', positive: true }] } },
};
// Deliberately NOT editable: pendingReversals (an action on an existing record - discard and redo),
// pendingOpticalOrders / pendingQuotations (multi-part clinical documents - discard and re-enter).

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const isEditableTable = (table) => Boolean(EDIT_SPECS[table]);

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------
const blank = (v) => v === '' || v === null || v === undefined;

function checkValue(def, value, label) {
  if (def.type === 'number') {
    // An optional number may simply be absent (a POS sale carries no discount/tax unless entered).
    if (blank(value) && !def.required && !def.positive) return null;
    if (blank(value) || Number.isNaN(Number(value))) return `${label} must be a number`;
    const n = Number(value);
    if (def.positive && !(n > 0)) return `${label} must be greater than zero`;
    if (def.min !== undefined && n < def.min) return `${label} cannot be less than ${def.min}`;
  }
  if (def.required && (value === '' || value === null || value === undefined)) return `${label} is required`;
  if (def.type === 'select' && value !== undefined && value !== null && def.options && !def.options.some((o) => o.value === value)) return `${label} is not a valid choice`;
  return null;
}

export function validateEdit(table, payload) {
  const spec = EDIT_SPECS[table];
  const errors = [];
  for (const f of spec.fields || []) {
    const e = checkValue(f, payload[f.key], f.label);
    if (e && !(payload[f.key] === undefined && !f.required && f.type !== 'number')) errors.push(e);
  }
  if (spec.lines) {
    const lines = payload[spec.lines.key];
    if (!Array.isArray(lines) || lines.length < spec.lines.minLines) errors.push(`${spec.lines.label}: at least ${spec.lines.minLines} line is required`);
    else lines.forEach((line, i) => spec.lines.columns.forEach((c) => { const e = checkValue(c, line[c.key], `${spec.lines.label} #${i + 1} ${c.label}`); if (e) errors.push(e); }));
  }
  if (table === 'pendingSales') {
    const total = (payload.items || []).reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice) - Number(l.discount || 0), 0) - Number(payload.discount || 0) + Number(payload.tax || 0);
    if (Number(payload.amountPaid || 0) > round2(Math.max(total, 0)) + 0.005) errors.push('Amount paid cannot exceed the sale total');
  }
  if (table === 'pendingPurchases') {
    const total = (payload.items || []).reduce((s, l) => s + Number(l.quantity) * Number(l.unitCost), 0);
    if (Number(payload.amountPaid || 0) > round2(total) + 0.005) errors.push('Amount paid cannot exceed the purchase total');
  }
  return errors;
}

// Leaf-level differences between two payloads, as [{path, from, to}] - the audit trail of an edit.
export function diffPayload(before, after, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const a = before?.[k];
    const b = after?.[k];
    if (a && b && typeof a === 'object' && typeof b === 'object') out.push(...diffPayload(a, b, path));
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, from: a ?? null, to: b ?? null });
  }
  return out;
}

// A cleared optional number is absent, not an empty string the server would reject.
export function normalizePayload(table, payload) {
  const spec = EDIT_SPECS[table];
  const out = clone(payload);
  for (const f of spec.fields || []) if (f.type === 'number' && blank(out[f.key]) && !f.positive && !f.required) delete out[f.key];
  if (spec.lines) {
    for (const line of out[spec.lines.key] || []) for (const c of spec.lines.columns) if (c.type === 'number' && blank(line[c.key]) && !c.positive && !c.required) delete line[c.key];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Can this entry be edited right now?
// ---------------------------------------------------------------------------------------------
export function editability(table, entry) {
  if (!isEditableTable(table)) return { ok: false, reason: 'This kind of transaction cannot be edited - discard it and enter it again.' };
  if (entry.status === 'synced') return { ok: false, reason: 'It was already accepted by the server. Correct it online, or reverse it and enter it again.' };
  if (entry.status === 'syncing') return { ok: false, reason: 'It is being sent right now.' };
  if (!EDITABLE_STATUSES.includes(entry.status)) return { ok: false, reason: 'It cannot be edited in its current state.' };
  if (entry.maybeApplied) {
    return { ok: false, needsCheck: true, reason: 'The last attempt got no answer, so the server may already have it. Use "Check" first - once the server answers, it can be edited if it was not accepted.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Suggested fix for a conflict, computed from the server's own facts (never guessed)
// ---------------------------------------------------------------------------------------------
const clone = (v) => JSON.parse(JSON.stringify(v));
const saleTotal = (p) => (p.items || []).reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice) - Number(l.discount || 0), 0) - Number(p.discount || 0) + Number(p.tax || 0);

export function suggestEdit(table, entry) {
  const f = entry.failure;
  if (!f || !f.details) {
    if (f?.kind === 'PERIOD_CLOSED' && entry.payload.occurredAt) {
      return { payload: { ...clone(entry.payload), occurredAt: new Date().toISOString() }, summary: 'Record it with today\'s date instead of the original date', changesEventTime: true };
    }
    return null;
  }
  const next = clone(entry.payload);
  const d = f.details;

  if (f.kind === 'STOCK_INSUFFICIENT') {
    if (table === 'pendingSales' && d.productId) {
      const idx = next.items.findIndex((l) => l.productId === d.productId);
      if (idx < 0) return null;
      const before = Number(next.items[idx].quantity);
      const available = Math.max(Math.floor(Number(d.available) * 100) / 100, 0);
      if (available >= before) return null;
      const wasPaidInFull = Number(next.amountPaid || 0) >= round2(saleTotal(entry.payload)) - 0.005;
      if (available === 0) next.items.splice(idx, 1);
      else next.items[idx].quantity = available;
      if (next.items.length === 0) return { payload: null, summary: `${d.name || 'The product'} is out of stock and it was the only item - discard this sale`, discard: true };
      if (wasPaidInFull) next.amountPaid = round2(Math.max(saleTotal(next), 0));
      return { payload: next, summary: available === 0 ? `Remove ${d.name || 'the product'} (none in stock)` : `Reduce ${d.name || 'the product'} from ${before} to ${available}` };
    }
    if (table === 'pendingWarehouseStockMoves' && Number(d.available) >= 0) {
      const available = Number(d.available);
      if (available === 0) return { payload: null, summary: 'Nothing is available to move - discard this move', discard: true };
      next.quantity = Math.min(Number(next.quantity), available);
      return { payload: next, summary: `Reduce the quantity to the ${available} that is available` };
    }
    return null;
  }

  if (f.kind === 'RETURN_EXCEEDS' && d.remaining !== undefined) {
    const idx = next.items.findIndex((l) => l.saleItemId === d.saleItemId || l.purchaseItemId === d.purchaseItemId);
    if (idx < 0) return null;
    const remaining = Math.max(Number(d.remaining), 0);
    if (remaining === 0) next.items.splice(idx, 1);
    else next.items[idx].quantity = Math.min(Number(next.items[idx].quantity), remaining);
    if (next.items.length === 0) return { payload: null, summary: 'Everything on this return was already returned - discard it', discard: true };
    return { payload: next, summary: remaining === 0 ? 'Remove the line that was already fully returned' : `Reduce the returned quantity to the ${remaining} still returnable` };
  }

  if (f.kind === 'BALANCE_CHANGED') {
    const isRefund = table === 'pendingCreditRefunds' || table === 'pendingDebitRefunds';
    const isApplication = table === 'pendingCreditApplications' || table === 'pendingDebitApplications';
    if (isRefund && d.available !== undefined) {
      const available = Math.max(Number(d.available), 0);
      if (available <= 0.005) return { payload: null, summary: 'No credit is left on this note - discard the refund', discard: true };
      next.amount = Math.min(Number(next.amount), available);
      return { payload: next, summary: `Refund the ${available} that is left on the note` };
    }
    if (isApplication && d.documentId && d.balance !== undefined) {
      const idx = next.allocations.findIndex((a) => a.documentId === d.documentId);
      if (idx < 0) return null;
      const balance = Math.max(Number(d.balance), 0);
      if (balance <= 0.005) next.allocations.splice(idx, 1);
      else next.allocations[idx].amount = Math.min(Number(next.allocations[idx].amount), balance);
      if (next.allocations.length === 0) return { payload: null, summary: 'That document was settled meanwhile and it was the only one - discard this application', discard: true };
      return { payload: next, summary: balance <= 0.005 ? 'Remove the document that was settled meanwhile' : `Apply only the ${balance} that is still owed on that document` };
    }
    if (isApplication && d.available !== undefined) {
      let room = Math.max(Number(d.available), 0);
      const kept = [];
      for (const a of next.allocations) {
        const take = Math.min(Number(a.amount), room);
        if (take > 0.005) kept.push({ ...a, amount: round2(take) });
        room = round2(room - take);
      }
      if (kept.length === 0) return { payload: null, summary: 'No credit is left on this note - discard the application', discard: true };
      next.allocations = kept;
      return { payload: next, summary: `Apply only the ${round2(Number(d.available))} of credit that is left on the note` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Applying an edit
// ---------------------------------------------------------------------------------------------
export async function updateQueuedEntry(tenantId, table, clientId, nextPayload, { note, allowEventTimeChange = false } = {}) {
  const db = getOfflineDb(tenantId);
  const entry = await db[table].get(clientId);
  if (!entry) throw new Error('That transaction no longer exists.');
  const can = editability(table, entry);
  if (!can.ok) throw new Error(can.reason);

  const spec = EDIT_SPECS[table];
  let payload = normalizePayload(table, clone(nextPayload));
  if (spec.derive) payload = spec.derive(payload);
  // Identity of the operation never changes through an edit.
  payload.idempotencyKey = entry.payload.idempotencyKey;
  if (entry.payload.occurredAt !== undefined && !allowEventTimeChange) payload.occurredAt = entry.payload.occurredAt;
  if (payload._display) delete payload._display;

  const errors = validateEdit(table, payload);
  if (errors.length) throw new Error(errors.join('; '));

  const changes = diffPayload(entry.payload, payload);
  if (changes.length === 0) throw new Error('Nothing was changed.');
  if (!allowEventTimeChange && changes.some((c) => c.path === 'occurredAt')) throw new Error('The time this happened cannot be edited.');

  const revision = { at: Date.now(), changes, note: note || null, resolved: entry.failure ? { kind: entry.failure.kind, message: entry.failure.message } : null, eventTimeChanged: changes.some((c) => c.path === 'occurredAt') };
  await db[table].update(clientId, {
    payload,
    dependsOn: [...extractRefs(payload)],
    status: 'pending',
    attempts: 0,
    failure: null,
    lastError: null,
    nextAttemptAt: null,
    blockedBy: null,
    editedAt: revision.at,
    revisions: [revision, ...(entry.revisions || [])].slice(0, MAX_REVISIONS),
  });
  // The queued effect (stock, returnable quantity...) changed: recompute the local view from the base.
  await applyPendingOverlay(db);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(QUEUED_EVENT, { detail: { tableName: table, clientId, edited: true } }));
  return db[table].get(clientId);
}
