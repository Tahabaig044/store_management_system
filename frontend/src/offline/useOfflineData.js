import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { getOfflineDb } from './db';
import { refTo } from './syncCore';
import { openRaw, subscribeSecure, secureVersion } from './secureStore';

// Re-render (and re-read) when the protected data is locked or unlocked.
function useSecureVersion() {
  const [v, setV] = useState(secureVersion());
  useEffect(() => subscribeSecure(() => setV(secureVersion())), []);
  return v;
}

// Reactive read from the local cache - re-renders automatically whenever the
// underlying IndexedDB table changes (optimistic stock decrement, a sync
// completing, or a fresh refreshCaches() pull), so the POS screen never shows
// a stale number just because it hasn't been told to re-fetch.
function useLiveTable(tenantId, tableName) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!tenantId) return undefined;
    const db = getOfflineDb(tenantId);
    const subscription = liveQuery(() => db[tableName].toArray()).subscribe({
      next: setRows,
      error: (err) => console.error(`Live query on ${tableName} failed:`, err),
    });
    return () => subscription.unsubscribe();
  }, [tenantId, tableName]);

  return rows;
}

export function useLiveProducts(tenantId) {
  return useLiveTable(tenantId, 'products');
}

// Customers/suppliers created on this terminal but not yet synced are usable straight away: they are
// listed under a "$ref:<clientId>" id (see syncCore.refTo), which the sync engine swaps for the real id
// - after the record itself has synced - when it sends anything that refers to them. Records that
// synced a moment ago but are not in the downloaded copy yet appear under their real id.
function useLiveWithPending(tenantId, tableName, pendingTable) {
  const [rows, setRows] = useState([]);
  const secureV = useSecureVersion();
  useEffect(() => {
    if (!tenantId) return undefined;
    const db = getOfflineDb(tenantId);
    const subscription = liveQuery(async () => {
      const [sealed, queued] = await Promise.all([db[tableName].toArray(), db[pendingTable].toArray()]);
      const cached = await openRaw(db, tableName, sealed); // customers/suppliers are stored sealed (secureStore.js)
      const known = new Set(cached.map((r) => r.id));
      const fromQueue = [];
      for (const e of queued) {
        if (e.status === 'synced') {
          const id = e.serverResult?.id;
          if (id && !known.has(id)) fromQueue.push({ ...e.payload, ...e.serverResult, _pendingSync: false });
        } else {
          fromQueue.push({ ...e.payload, id: refTo(e.clientId), _pendingSync: true });
        }
      }
      return [...cached, ...fromQueue];
    }).subscribe({
      next: setRows,
      error: (err) => console.error(`Live query on ${tableName} failed:`, err),
    });
    return () => subscription.unsubscribe();
  }, [tenantId, tableName, pendingTable, secureV]);
  return rows;
}

export function useLiveCustomers(tenantId) {
  return useLiveWithPending(tenantId, 'customers', 'pendingCustomers');
}

export function useLiveSuppliers(tenantId) {
  return useLiveWithPending(tenantId, 'suppliers', 'pendingSuppliers');
}

export function useLiveExpenseCategories(tenantId) {
  return useLiveTable(tenantId, 'expenseCategories');
}
