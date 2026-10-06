// Phase 3.3: what can still be returned / settled / refunded, as this terminal sees it RIGHT NOW.
//
// The server-downloaded selection lists (returnableSales, arDocuments, arNotes, ...) know nothing about
// work still waiting in this terminal's queue. These views subtract that queued work at READ time, so a
// second return of the same goods, a second application of the same credit, or a refund of credit that
// is already promised to an invoice is refused on the spot instead of at sync time. They never write:
// the stored lists stay exactly what the server said (the same idea as the stock overlay).
//
// This is a courtesy check, not the guarantee. The server re-checks every one of these with atomic
// conditional updates (another terminal may have used the same goods/credit meanwhile); a request that
// no longer fits comes back as a visible conflict the person edits or discards.
import { getOfflineDb } from './db';
import { readSealed, secureState } from './secureStore';

const LOCKED_MESSAGE = 'The protected offline data is locked. Enter your password to unlock it, then try again.';
const assertUnlocked = (db) => { if (secureState(db) !== 'unlocked') throw new Error(LOCKED_MESSAGE); };

// Entries that may still reach the server and consume the goods/credit they name. conflict/failed ones
// were rejected (no effect), synced ones are already inside the downloaded numbers.
const LIVE = ['pending', 'syncing', 'blocked'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const live = (db, table) => db[table].where('status').anyOf(LIVE).toArray();
const sum = (xs) => xs.reduce((s, x) => s + Number(x || 0), 0);

// ---- returns ------------------------------------------------------------------------------------
const RETURNS = {
  sale: { rows: 'returnableSales', pending: 'pendingSalesReturns', docKey: 'saleId', lineKey: 'saleItemId' },
  purchase: { rows: 'returnablePurchases', pending: 'pendingPurchaseReturns', docKey: 'purchaseId', lineKey: 'purchaseItemId' },
};

async function returnable(db, kind) {
  const cfg = RETURNS[kind];
  const [docs, queued] = await Promise.all([readSealed(db, cfg.rows), live(db, cfg.pending)]);
  const taken = new Map(); // line id -> quantity already promised by queued returns
  for (const q of queued) for (const l of q.payload.items || []) taken.set(l[cfg.lineKey], (taken.get(l[cfg.lineKey]) || 0) + Number(l.quantity));
  return docs
    .map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, queuedQuantity: taken.get(i.id) || 0, remaining: round2(i.quantity - i.returnedQuantity - (taken.get(i.id) || 0)) })) }))
    .filter((d) => d.items.some((i) => i.remaining > 0.0001))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
export const getReturnableSales = (tenantId) => returnable(getOfflineDb(tenantId), 'sale');
export const getReturnablePurchases = (tenantId) => returnable(getOfflineDb(tenantId), 'purchase');

// ---- notes and documents ----------------------------------------------------------------------
export const SIDES = {
  credit: { docs: 'arDocuments', notes: 'arNotes', pendingNotes: 'pendingCreditNotes', apps: 'pendingCreditApplications', refunds: 'pendingCreditRefunds', partyKey: 'customerId' },
  debit: { docs: 'apDocuments', notes: 'apNotes', pendingNotes: 'pendingDebitNotes', apps: 'pendingDebitApplications', refunds: 'pendingDebitRefunds', partyKey: 'supplierId' },
};
export const isSide = (side) => Boolean(SIDES[side]);

// Notes with credit left = downloaded notes + notes queued on this terminal (not synced yet, so they
// carry a $ref: id that the applications/refunds queued against them point at), minus everything
// already queued against either. A note's spendable credit is amount + tax (what the server stores).
async function openNotes(db, side) {
  const cfg = SIDES[side];
  const [server, queuedNotes, apps, refunds] = await Promise.all([readSealed(db, cfg.notes), live(db, cfg.pendingNotes), live(db, cfg.apps), live(db, cfg.refunds)]);
  const used = new Map();
  const spend = (id, amount) => used.set(id, (used.get(id) || 0) + Number(amount || 0));
  for (const a of apps) spend(a.payload.noteId, sum((a.payload.allocations || []).map((x) => x.amount)));
  for (const r of refunds) spend(r.payload.noteId, r.payload.amount);
  const fromServer = server.map((n) => ({ ...n, queuedUse: used.get(n.id) || 0, available: round2(n.available - (used.get(n.id) || 0)) }));
  const fromQueue = queuedNotes.map((q) => {
    const id = `$ref:${q.clientId}`;
    return { id, number: 'Not synced yet', partyId: q.payload[cfg.partyKey], partyName: q.display?.partyName || null, amount: Number(q.payload.amount) + Number(q.payload.tax || 0), queuedUse: used.get(id) || 0, available: round2(Number(q.payload.amount) + Number(q.payload.tax || 0) - (used.get(id) || 0)), reason: q.payload.reason, queued: true };
  });
  return [...fromServer, ...fromQueue].filter((n) => n.available > 0.005);
}

// Open invoices/purchases (unpaid balance) minus what queued applications will settle.
async function openDocuments(db, side) {
  const cfg = SIDES[side];
  const [docs, apps] = await Promise.all([readSealed(db, cfg.docs), live(db, cfg.apps)]);
  const settled = new Map();
  for (const a of apps) for (const x of a.payload.allocations || []) settled.set(x.documentId, (settled.get(x.documentId) || 0) + Number(x.amount));
  return docs.map((d) => ({ ...d, queuedSettlement: settled.get(d.id) || 0, balance: round2(d.balance - (settled.get(d.id) || 0)) })).filter((d) => d.balance > 0.005);
}
export const getOpenNotes = (tenantId, side) => openNotes(getOfflineDb(tenantId), side);
export const getOpenDocuments = (tenantId, side) => openDocuments(getOfflineDb(tenantId), side);

// ---- pre-queue validation (a courtesy: the server is authoritative) ------------------------------
export async function assertReturnFits(db, kind, payload) {
  assertUnlocked(db);
  const cfg = RETURNS[kind];
  const doc = (await returnable(db, kind)).find((d) => d.id === payload[cfg.docKey]);
  if (!doc) {
    const known = (await readSealed(db, cfg.rows)).find((d) => d.id === payload[cfg.docKey]);
    throw new Error(known ? 'Everything on this document is already returned or waiting to be returned.' : 'This document is not in the local list, so the return cannot be checked. Go online once to download it, then try again.');
  }
  const wanted = new Map();
  for (const line of payload.items || []) {
    if (!(Number(line.quantity) > 0)) throw new Error('Return quantity must be greater than zero.');
    wanted.set(line[cfg.lineKey], (wanted.get(line[cfg.lineKey]) || 0) + Number(line.quantity));
  }
  for (const [lineId, q] of wanted) {
    const item = doc.items.find((i) => i.id === lineId);
    if (!item) throw new Error('A returned line does not belong to that document.');
    if (q > item.remaining + 0.0001) throw new Error(`Only ${item.remaining} of ${item.name || 'this item'} can still be returned.`);
  }
}

// Application: every allocation within its document's open balance and the total within the note's credit.
export async function assertApplicationFits(db, side, payload) {
  assertUnlocked(db);
  const [notes, docs] = await Promise.all([openNotes(db, side), openDocuments(db, side)]);
  const note = notes.find((n) => n.id === payload.noteId);
  if (!note) throw new Error('That note has no credit left to apply (or it is not in the local list).');
  const total = sum((payload.allocations || []).map((a) => a.amount));
  if (total > note.available + 0.005) throw new Error(`Only ${note.available.toFixed(2)} of credit is left on that note.`);
  const seen = new Set();
  for (const a of payload.allocations || []) {
    if (!(Number(a.amount) > 0)) throw new Error('Each amount must be greater than zero.');
    if (seen.has(a.documentId)) throw new Error('The same document is listed twice.');
    seen.add(a.documentId);
    const doc = docs.find((d) => d.id === a.documentId);
    if (!doc) throw new Error('A selected document is no longer open (or not in the local list).');
    if (Number(a.amount) > doc.balance + 0.005) throw new Error(`Only ${doc.balance.toFixed(2)} is still owed on ${doc.number}.`);
  }
}

export async function assertRefundFits(db, side, payload) {
  assertUnlocked(db);
  const note = (await openNotes(db, side)).find((n) => n.id === payload.noteId);
  if (!note) throw new Error('That note has no credit left to refund (or it is not in the local list).');
  if (!(Number(payload.amount) > 0)) throw new Error('Refund amount must be greater than zero.');
  if (Number(payload.amount) > note.available + 0.005) throw new Error(`Only ${note.available.toFixed(2)} of credit is left on that note.`);
}
