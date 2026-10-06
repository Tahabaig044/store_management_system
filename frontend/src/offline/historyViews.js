// Phase 3.4: what a terminal can SHOW with no network - recent sales and purchases, a customer's or
// supplier's statement, a sales summary, and receivables/payables aging - computed on the device from the
// downloaded read models (salesHistory, purchasesHistory, arDocuments/apDocuments, arNotes/apNotes) plus
// this terminal's own queued work.
//
// These are VIEWS, "as of the last download" (the freshness is returned with every one so the screen can
// say so). They are never a source of truth for accounting: the ledger and the official reports stay on
// the server, and nothing here writes anything. Queued-but-unsynced entries are included and clearly
// marked, so a cashier sees the sale they just made without waiting for it to reach the server.
import { getOfflineDb } from './db';
import { readSealed } from './secureStore';
import { getOpenDocuments, getOpenNotes } from './derivedViews';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const LIVE_OR_REFUSED = ['pending', 'syncing', 'blocked', 'conflict', 'failed'];
const day = (d) => new Date(d).toISOString().slice(0, 10);

const saleTotal = (p) => round2((p.items || []).reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice) - Number(l.discount || 0), 0) - Number(p.discount || 0) + Number(p.tax || 0));
const purchaseTotal = (p) => round2((p.items || []).reduce((s, l) => s + Number(l.quantity) * Number(l.unitCost), 0));

async function datasetInfo(db, name) {
  const v = (await db.meta.get(`dataset:${name}`))?.value;
  return { lastCheckedAt: v?.lastCheckedAt ?? null, everDownloaded: Boolean(v) };
}

// A queued (not yet accepted) entry, shaped like a history row.
const queuedRow = (kind, e, customers, suppliers) => {
  const p = e.payload;
  const partyId = kind === 'sale' ? p.customerId : p.supplierId;
  const party = (kind === 'sale' ? customers : suppliers).find((x) => x.id === partyId);
  return {
    id: `$ref:${e.clientId}`,
    number: 'Not synced yet',
    partyId: partyId || null,
    partyName: party?.name || (partyId ? null : kind === 'sale' ? 'Walk-in' : null),
    date: p.occurredAt || new Date(e.createdAt).toISOString(),
    status: e.status === 'conflict' || e.status === 'failed' ? 'REFUSED' : 'QUEUED',
    paymentMethod: p.paymentMethod || null,
    total: kind === 'sale' ? saleTotal(p) : purchaseTotal(p),
    amountPaid: Number(p.amountPaid || 0),
    itemCount: (p.items || []).length,
    queued: true,
    queueStatus: e.status,
  };
};

async function history(tenantId, kind, { from, to, search, status } = {}) {
  const db = getOfflineDb(tenantId);
  const table = kind === 'sale' ? 'salesHistory' : 'purchasesHistory';
  const pendingTable = kind === 'sale' ? 'pendingSales' : 'pendingPurchases';
  // Every Dexie read starts in this tick (a liveQuery only tracks reads made before its first crypto await).
  const [server, queued, customers, suppliers, info] = await Promise.all([
    readSealed(db, table),
    db[pendingTable].where('status').anyOf(LIVE_OR_REFUSED).toArray(),
    kind === 'sale' ? readSealed(db, 'customers') : Promise.resolve([]),
    kind === 'purchase' ? readSealed(db, 'suppliers') : Promise.resolve([]),
    datasetInfo(db, table),
  ]);
  let rows = [...queued.map((e) => queuedRow(kind, e, customers, suppliers)), ...server];
  if (from) rows = rows.filter((r) => day(r.date) >= from);
  if (to) rows = rows.filter((r) => day(r.date) <= to);
  if (status) rows = rows.filter((r) => r.status === status);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => `${r.number} ${r.partyName || ''}`.toLowerCase().includes(q));
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { rows, ...info, queuedCount: queued.length };
}
export const getSalesHistory = (tenantId, filters) => history(tenantId, 'sale', filters);
export const getPurchasesHistory = (tenantId, filters) => history(tenantId, 'purchase', filters);

// One party's statement. `side` 'credit' = a customer (they owe us), 'debit' = a supplier (we owe them).
// Balance = what they still owe on open documents minus credit still held on notes (for a customer; the
// mirror image for a supplier). Every figure is the last downloaded one, adjusted by what this terminal has
// queued, and is labelled as such.
export async function getPartyStatement(tenantId, side, partyId) {
  const db = getOfflineDb(tenantId);
  const kind = side === 'credit' ? 'sale' : 'purchase';
  const hist = await history(tenantId, kind);
  const [docs, notes] = await Promise.all([getOpenDocuments(tenantId, side), getOpenNotes(tenantId, side)]);
  const partyRows = hist.rows.filter((r) => r.partyId === partyId);
  const openDocs = docs.filter((d) => d.partyId === partyId);
  const partyNotes = notes.filter((n) => n.partyId === partyId);
  const owed = round2(openDocs.reduce((s, d) => s + d.balance, 0));
  const credit = round2(partyNotes.reduce((s, n) => s + n.available, 0));
  const info = await datasetInfo(db, side === 'credit' ? 'arDocuments' : 'apDocuments');
  return {
    lines: partyRows.map((r) => ({ id: r.id, date: r.date, number: r.number, status: r.status, total: r.total, paid: r.amountPaid, outstanding: r.status === 'COMPLETED' || r.status === 'RECEIVED' || r.queued ? round2(Math.max(r.total - r.amountPaid, 0)) : 0, queued: Boolean(r.queued) })),
    openDocuments: openDocs,
    notes: partyNotes,
    owed,
    credit,
    balance: round2(owed - credit),
    asOf: info.lastCheckedAt,
    everDownloaded: info.everDownloaded,
  };
}

// Sales summary for a period: totals by day and by payment method. Reversed sales are excluded; queued sales
// are counted separately so the figure can be read as "on the server" vs "still on this terminal".
export async function getSalesSummary(tenantId, { from, to } = {}) {
  const { rows, lastCheckedAt, everDownloaded } = await history(tenantId, 'sale', { from, to });
  const byDay = new Map();
  const byMethod = new Map();
  let accepted = { count: 0, total: 0, paid: 0 };
  let queued = { count: 0, total: 0, paid: 0 };
  for (const r of rows) {
    if (r.status === 'REVERSED' || r.status === 'CANCELLED' || r.status === 'REFUSED') continue;
    const bucket = r.queued ? queued : accepted;
    bucket.count += 1;
    bucket.total = round2(bucket.total + r.total);
    bucket.paid = round2(bucket.paid + r.amountPaid);
    const d = day(r.date);
    byDay.set(d, round2((byDay.get(d) || 0) + r.total));
    const m = r.paymentMethod || 'other';
    byMethod.set(m, round2((byMethod.get(m) || 0) + r.amountPaid));
  }
  return {
    accepted,
    queued,
    byDay: [...byDay.entries()].sort().map(([date, total]) => ({ date, total })),
    byMethod: [...byMethod.entries()].sort().map(([method, paid]) => ({ method, paid })),
    asOf: lastCheckedAt,
    everDownloaded,
  };
}

// Aging of open invoices (side 'credit') or purchases (side 'debit') by how long ago they were made.
export const AGING_BUCKETS = [{ label: '0-30', max: 30 }, { label: '31-60', max: 60 }, { label: '61-90', max: 90 }, { label: '90+', max: Infinity }];
export async function getAging(tenantId, side, asOf = Date.now()) {
  const docs = await getOpenDocuments(tenantId, side);
  const info = await datasetInfo(getOfflineDb(tenantId), side === 'credit' ? 'arDocuments' : 'apDocuments');
  const buckets = AGING_BUCKETS.map((b) => ({ label: b.label, total: 0, count: 0 }));
  const parties = new Map();
  for (const d of docs) {
    const age = Math.max(Math.floor((asOf - new Date(d.date).getTime()) / 86400000), 0);
    const i = AGING_BUCKETS.findIndex((b) => age <= b.max);
    buckets[i].total = round2(buckets[i].total + d.balance);
    buckets[i].count += 1;
    const p = parties.get(d.partyId || 'none') || { partyId: d.partyId, partyName: d.partyName || 'Unknown', total: 0 };
    p.total = round2(p.total + d.balance);
    parties.set(d.partyId || 'none', p);
  }
  return { buckets, total: round2(buckets.reduce((s, b) => s + b.total, 0)), parties: [...parties.values()].sort((a, b) => b.total - a.total), asOf: info.lastCheckedAt, everDownloaded: info.everDownloaded };
}
