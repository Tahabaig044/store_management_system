import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { getOfflineDb } from './db';
import { describeFailure } from './syncCore';

const ENTITY_TABLES = [
  { key: 'sales', tableName: 'pendingSales', label: 'Sale' },
  { key: 'purchases', tableName: 'pendingPurchases', label: 'Purchase' },
  { key: 'expenses', tableName: 'pendingExpenses', label: 'Expense' },
  { key: 'customers', tableName: 'pendingCustomers', label: 'Customer' },
  { key: 'suppliers', tableName: 'pendingSuppliers', label: 'Supplier' },
  { key: 'opticalOrders', tableName: 'pendingOpticalOrders', label: 'Optical Order' },
  { key: 'reversals', tableName: 'pendingReversals', label: 'Sale Reversal' },
  { key: 'warehouseStockMoves', tableName: 'pendingWarehouseStockMoves', label: 'Warehouse Stock Move' },
  { key: 'payments', tableName: 'pendingPayments', label: 'Payment' },
  { key: 'quotations', tableName: 'pendingQuotations', label: 'Quotation' },
  { key: 'salesReturns', tableName: 'pendingSalesReturns', label: 'Sales Return' },
  { key: 'purchaseReturns', tableName: 'pendingPurchaseReturns', label: 'Purchase Return' },
  { key: 'creditNotes', tableName: 'pendingCreditNotes', label: 'Credit Note' },
  { key: 'debitNotes', tableName: 'pendingDebitNotes', label: 'Debit Note' },
  { key: 'creditRefunds', tableName: 'pendingCreditRefunds', label: 'Credit Note Refund' },
  { key: 'debitRefunds', tableName: 'pendingDebitRefunds', label: 'Debit Note Refund' },
  { key: 'creditApplications', tableName: 'pendingCreditApplications', label: 'Credit Note Application' },
  { key: 'debitApplications', tableName: 'pendingDebitApplications', label: 'Debit Note Application' },
];

// The single overall state the UI shows. Worst-news-first for things a person must act on; while a
// pass is running it says so; otherwise "pending" (waiting for network / a retry time) or "synced".
export function deriveSyncState({ conflictCount, failedCount, blockedCount, pendingCount, active, online }) {
  if (conflictCount > 0) return 'conflict';
  if (failedCount > 0) return 'failed';
  if (active && online) return 'syncing';
  if (blockedCount > 0) return 'blocked';
  if (pendingCount > 0) return online ? 'pending' : 'offline-pending';
  return 'synced';
}

const empty = { pendingCount: 0, conflictCount: 0, failedCount: 0, blockedCount: 0, syncingCount: 0, retryingCount: 0, active: false, lastSyncAt: null, items: [], state: 'synced' };

// Reactively reflects every offline outbox combined, so the sync status widget updates immediately
// whenever anything is queued, retried, resolved or synced anywhere in the app, without polling.
export function useSyncStatus(tenantId) {
  const [data, setData] = useState(empty);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    if (!tenantId) return undefined;
    const db = getOfflineDb(tenantId);

    const subscription = liveQuery(async () => {
      const perEntity = await Promise.all(
        ENTITY_TABLES.map(async ({ key, tableName, label }) => {
          const rows = await db[tableName].orderBy('createdAt').reverse().toArray();
          return rows.map((row) => ({ ...row, entityKey: key, entityLabel: label, tableName }));
        })
      );
      const items = perEntity.flat().sort((a, b) => b.createdAt - a.createdAt);

      const lastSyncTimestamps = await Promise.all(ENTITY_TABLES.map(({ tableName }) => db.meta.get(`lastSyncAt:${tableName}`)));
      const lastSyncAt = lastSyncTimestamps.reduce((max, row) => (row?.value && row.value > max ? row.value : max), null);
      const active = Boolean((await db.meta.get('syncActive'))?.value);

      // Which queued transaction a blocked one is waiting for, in words a person can act on.
      const byId = new Map(items.map((i) => [i.clientId, i]));
      const decorated = items.map((i) => ({
        ...i,
        guidance: describeFailure(i.failure),
        blockedOn: i.blockedBy ? byId.get(i.blockedBy) || null : null,
      }));

      const count = (status) => decorated.filter((i) => i.status === status).length;
      return {
        items: decorated,
        pendingCount: decorated.filter((i) => i.status === 'pending' || i.status === 'syncing').length,
        conflictCount: count('conflict'),
        failedCount: count('failed'),
        blockedCount: count('blocked'),
        syncingCount: count('syncing'),
        retryingCount: decorated.filter((i) => i.status === 'pending' && i.nextAttemptAt && i.nextAttemptAt > Date.now()).length,
        active,
        lastSyncAt,
      };
    }).subscribe({
      next: setData,
      error: (err) => console.error('Sync status live query failed:', err),
    });

    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      subscription.unsubscribe();
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [tenantId]);

  return { ...data, online, state: deriveSyncState({ ...data, online }) };
}
