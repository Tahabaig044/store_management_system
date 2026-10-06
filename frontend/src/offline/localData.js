// Phase 3.1: the authoritative LOCAL DATA MODEL - how a terminal fills, versions, protects and
// refreshes its read copy of the data it needs to keep working without a network.
//
//   What is cached      products (+ stock), customers, suppliers, expense categories, branches,
//                       warehouses, per-warehouse stock - exactly what this user may read online
//                       (server-scoped by permission and branch/company/warehouse access).
//   Where it lives      the per-tenant, per-user IndexedDB (db.js). Reads never touch the network.
//   How it is filled    keyset-paged downloads (no 100-row truncation) from /api/offline/*, applied
//                       to the tables in ONE transaction, then the terminal's own queued-but-unsynced
//                       stock effects are re-applied on top (pendingEffects.js).
//   How it stays fresh  a cheap manifest check (dataset {count, maxUpdatedAt} versions) - only what
//                       changed is downloaded, as a delta. Triggers: sign-in/start, every 60 s while
//                       online and visible, window focus, the browser going online, and immediately
//                       after any successful stock-affecting request made from this app.
//   How staleness shows getFreshness(): per-dataset age against a TTL (stock is strict), plus
//                       "server has moved on" when the manifest disagrees.
//   Safety              access-scope or cache-schema change => the affected tables are purged and
//                       re-downloaded; sign-out purges the read tables (never the unsynced queue).
//
// What this file deliberately does NOT do: send anything to the server, resolve conflicts, or
// merge concurrent edits. That is the synchronization engine (Phase 3.2); the outboxes in
// syncEngine.js remain the only path for offline work.
import apiClient from '../api/client';
import { getOfflineDb, offlineDbName, READ_TABLES, SCOPE_DEPENDENT_TABLES } from './db';
import { applyPendingOverlay } from './pendingEffects';
import { isSealedTable, secureState, sealRows, readSealed } from './secureStore';

// Bump together with the server's SCHEMA_VERSION when a cached shape changes incompatibly.
export const LOCAL_SCHEMA_VERSION = 1;

// dataset name -> local table, freshness TTL, and whether a wrong number is an oversell risk.
export const DATASETS = {
  products: { table: 'products', ttlMs: 2 * 60 * 1000, stock: true },
  warehouseStock: { table: 'warehouseStock', ttlMs: 2 * 60 * 1000, stock: true },
  customers: { table: 'customers', ttlMs: 15 * 60 * 1000 },
  suppliers: { table: 'suppliers', ttlMs: 15 * 60 * 1000 },
  expenseCategories: { table: 'expenseCategories', ttlMs: 15 * 60 * 1000 },
  branches: { table: 'branches', ttlMs: 15 * 60 * 1000 },
  warehouses: { table: 'warehouses', ttlMs: 15 * 60 * 1000 },
  // Phase 3.3 selection lists (returns / notes / applications / refunds). Derived views on the server, so
  // they are always downloaded whole (no deltas) and are not part of the staleness warning.
  returnableSales: { table: 'returnableSales', ttlMs: 10 * 60 * 1000, full: true },
  returnablePurchases: { table: 'returnablePurchases', ttlMs: 10 * 60 * 1000, full: true },
  arDocuments: { table: 'arDocuments', ttlMs: 10 * 60 * 1000, full: true },
  apDocuments: { table: 'apDocuments', ttlMs: 10 * 60 * 1000, full: true },
  arNotes: { table: 'arNotes', ttlMs: 10 * 60 * 1000, full: true },
  apNotes: { table: 'apNotes', ttlMs: 10 * 60 * 1000, full: true },
  // Phase 3.4 read models for offline viewing (recent sales / purchases, 90 days).
  salesHistory: { table: 'salesHistory', ttlMs: 10 * 60 * 1000, full: true },
  purchasesHistory: { table: 'purchasesHistory', ttlMs: 10 * 60 * 1000, full: true },
};

const PAGE_SIZE = 500;
// A delta re-reads a little before the recorded server time so a row committed at the same instant
// the previous download was read is never missed (re-applying a row is harmless).
const DELTA_OVERLAP_MS = 2000;

const datasetKey = (name) => `dataset:${name}`;
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine);

// ---------------------------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------------------------

async function downloadDataset(name, updatedSince) {
  const items = [];
  let after;
  let serverTime;
  do {
    const { data } = await apiClient.get(`/offline/datasets/${name}`, { params: { limit: PAGE_SIZE, ...(after ? { after } : {}), ...(updatedSince ? { updatedSince } : {}) } });
    items.push(...data.items);
    serverTime = serverTime || data.serverTime; // the FIRST page's time: it precedes every row read
    after = data.nextCursor;
  } while (after);
  return { items, serverTime };
}

// Applies one dataset's rows. A full download replaces the table; a delta upserts, and drops rows
// the server reports as deactivated.
// Stock rows also remember the authoritative server number (`_baseStock`) so the queued-work overlay
// can be re-applied idempotently (see pendingEffects.js).
function withBase(name, row) {
  if (name === 'products') return { ...row, _baseStock: Number(row.stockQuantity) };
  if (name === 'warehouseStock') return { ...row, _baseStock: Number(row.quantity) };
  return row;
}

// Turns downloaded rows into what will be written: the delta split (rows the server deactivated vs live), the
// stock base, and - for personal/financial datasets - sealing (secureStore.js). Done BEFORE the write
// transaction, because a Dexie transaction cannot wait on WebCrypto.
async function prepareDataset(db, name, { items: rawItems, delta }) {
  const items = rawItems.map((r) => withBase(name, r));
  const table = DATASETS[name].table;
  const dead = delta ? items.filter((r) => r.isActive === false).map((r) => r.id) : [];
  const live = delta ? items.filter((r) => r.isActive !== false) : items;
  return { dead, live: isSealedTable(table) ? await sealRows(db, table, live) : live, delta };
}

// A full download replaces the table; a delta upserts, and drops rows the server reports as deactivated.
async function applyPrepared(db, name, { dead, live, delta }) {
  const table = db[DATASETS[name].table];
  if (!delta) await table.clear();
  if (dead.length) await table.bulkDelete(dead);
  if (live.length) await table.bulkPut(live);
}

// ---------------------------------------------------------------------------------------------
// The sync itself (read-only against the server)
// ---------------------------------------------------------------------------------------------

const runs = new Map(); // tenantId -> { current, queued }

// Brings this terminal's local read copy up to date. Never blocks the UI and never throws: offline,
// forbidden datasets and server errors are reported in the result, and whatever is already stored
// keeps being served.
//
// Concurrent callers do not each hit the server: while a run is in progress, callers share ONE
// follow-up run. (Joining the running one would be wrong - its manifest may predate the very change
// that prompted the call, e.g. a stock adjustment made a moment ago.)
export function syncLocalData(tenantId, { datasets, reason = 'manual' } = {}) {
  if (!tenantId) return Promise.resolve({ ok: false, skipped: 'no-tenant' });
  // One run per DATABASE (tenant + signed-in user), not per tenant: a run started for the previous user must
  // never be joined - and its result never mistaken for a sync - by the next one.
  const runKey = offlineDbName(tenantId);
  let s = runs.get(runKey);
  if (!s) {
    s = { current: null, queued: null };
    runs.set(runKey, s);
  }
  if (!s.current) {
    s.current = doSync(tenantId, { datasets, reason }).finally(() => {
      s.current = null;
    });
    return s.current;
  }
  if (!s.queued) {
    s.queued = s.current.then(() => {
      s.queued = null;
      return syncLocalData(tenantId, { reason });
    });
  }
  return s.queued;
}

// Never rejects (see syncLocalData): a database closed underneath a run - sign-out, user switch - ends
// that run quietly; whatever it had not yet written is simply downloaded by the next run.
async function doSync(tenantId, opts) {
  try {
    return await doSyncInner(tenantId, opts);
  } catch (err) {
    if (err?.name === 'DatabaseClosedError' || err?.name === 'InvalidStateError') return { ok: false, skipped: 'database-closed' };
    throw err;
  }
}

async function doSyncInner(tenantId, { datasets }) {
  if (!isOnline()) return { ok: false, skipped: 'offline' };
  const db = getOfflineDb(tenantId);
  let manifest;
  try {
    manifest = (await apiClient.get('/offline/manifest')).data;
  } catch (err) {
    return { ok: false, skipped: 'manifest-unreachable', error: err?.message };
  }

  await reconcileScope(db, manifest);

  const wanted = (datasets || Object.keys(DATASETS)).filter((n) => DATASETS[n] && manifest.datasets[n]);
  const result = { ok: true, downloaded: [], unchanged: [], errors: [], locked: [], forbidden: Object.keys(DATASETS).filter((n) => !manifest.datasets[n]) };

  for (const name of wanted) {
    const server = manifest.datasets[name];
    const local = (await db.meta.get(datasetKey(name)))?.value;
    const upToDate = local && local.count === server.count && sameJson(local.maxUpdatedAt, server.maxUpdatedAt);
    try {
      if (upToDate) {
        await db.meta.put({ key: datasetKey(name), value: { ...local, lastCheckedAt: Date.now(), stale: false } });
        result.unchanged.push(name);
        continue;
      }
      const delta = Boolean(local?.serverTime) && !DATASETS[name].full;
      const since = delta ? new Date(new Date(local.serverTime).getTime() - DELTA_OVERLAP_MS).toISOString() : undefined;
      // Personal/financial datasets are only ever stored sealed. With no key (signed in but not unlocked, or
      // no WebCrypto) they are not downloaded at all - fail closed, never written in the clear.
      if (isSealedTable(DATASETS[name].table) && secureState(db) !== 'unlocked') {
        result.locked.push(name);
        continue;
      }
      const { items, serverTime } = await downloadDataset(name, since);
      const prepared = await prepareDataset(db, name, { items, delta });
      await db.transaction('rw', db[DATASETS[name].table], db.meta, async () => {
        await applyPrepared(db, name, prepared);
        await db.meta.put({
          key: datasetKey(name),
          value: { serverTime, maxUpdatedAt: server.maxUpdatedAt, count: server.count, lastCheckedAt: Date.now(), lastChangedAt: Date.now(), stale: false },
        });
      });
      result.downloaded.push(name);
    } catch (err) {
      result.errors.push({ name, error: err?.message });
    }
  }

  // The server numbers know nothing about work still queued on this terminal - put it back.
  if (result.downloaded.length) await applyPendingOverlay(db);
  if (result.errors.length) result.ok = false;
  return result;
}

// Detects a change of who/what this cache was downloaded for, and discards what no longer applies.
async function reconcileScope(db, manifest) {
  const stored = (await db.meta.get('scope'))?.value;
  const storedSchema = (await db.meta.get('schemaVersion'))?.value;
  const sc = manifest.scope;
  const schemaChanged = storedSchema !== undefined && storedSchema !== manifest.schemaVersion;
  const identityChanged = stored && (stored.tenantId !== sc.tenantId || stored.userId !== sc.userId);
  const accessChanged = stored && (!sameJson(stored.branchIds, sc.branchIds) || !sameJson(stored.warehouseIds, sc.warehouseIds) || stored.role !== sc.role);

  if (schemaChanged || identityChanged) await purgeReadCaches(db);
  else if (accessChanged) await purgeTables(db, SCOPE_DEPENDENT_TABLES, SCOPE_DEPENDENT_TABLES);
  await db.meta.bulkPut([
    { key: 'scope', value: sc },
    { key: 'schemaVersion', value: manifest.schemaVersion },
  ]);
}

async function purgeTables(db, tables, datasetNames) {
  await db.transaction('rw', ...tables.map((t) => db[t]), db.meta, async () => {
    for (const t of tables) await db[t].clear();
    for (const name of datasetNames) await db.meta.delete(datasetKey(name));
  });
}

// Removes every read copy (and its version records) but NEVER the unsynced outboxes: work queued
// by this user must survive sign-out and be sent when they sign back in.
export async function purgeReadCaches(db) {
  await purgeTables(db, READ_TABLES, Object.keys(DATASETS));
  await db.meta.delete('scope');
  // The log of discarded work keeps what was discarded (it may hold names and amounts): a month is enough to
  // notice a mistake, and the record does not linger on a device after its user has signed out.
  const log = (await db.meta.get('discardLog'))?.value;
  if (log?.length) {
    const kept = log.filter((l) => Date.now() - l.at < 30 * 24 * 60 * 60 * 1000);
    if (kept.length !== log.length) await db.meta.put({ key: 'discardLog', value: kept });
  }
}

// ---------------------------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------------------------

// Per-dataset age and staleness. `stale` = never downloaded, older than its TTL, or (when the
// caller knows) flagged because the server moved on. Stock datasets are the ones that matter for
// overselling: `stockStale` is what the UI should warn about.
export function computeFreshness(rows, now = Date.now()) {
  const byName = Object.fromEntries(rows.map((r) => [r.key.slice('dataset:'.length), r.value]));
  const datasets = {};
  for (const [name, def] of Object.entries(DATASETS)) {
    const v = byName[name];
    const lastCheckedAt = v?.lastCheckedAt ?? null;
    datasets[name] = {
      lastCheckedAt,
      lastChangedAt: v?.lastChangedAt ?? null,
      ageMs: lastCheckedAt === null ? null : now - lastCheckedAt,
      count: v?.count ?? null,
      stale: lastCheckedAt === null || now - lastCheckedAt > def.ttlMs || Boolean(v?.stale),
      stock: Boolean(def.stock),
    };
  }
  const checked = Object.values(datasets).map((d) => d.lastCheckedAt).filter((x) => x !== null);
  const stockDatasets = Object.values(datasets).filter((d) => d.stock && d.lastCheckedAt !== null);
  return {
    datasets,
    everSynced: checked.length > 0,
    lastCheckedAt: checked.length ? Math.max(...checked) : null,
    stockCheckedAt: stockDatasets.length ? Math.min(...stockDatasets.map((d) => d.lastCheckedAt)) : null,
    stockStale: datasets.products.stale || (datasets.warehouseStock.lastCheckedAt !== null && datasets.warehouseStock.stale),
    anyStale: Object.entries(datasets).some(([n, d]) => !DATASETS[n].full && d.stale),
  };
}

export async function getFreshness(tenantId, now = Date.now()) {
  const rows = await getOfflineDb(tenantId).meta.where('key').startsWith('dataset:').toArray();
  return computeFreshness(rows, now);
}

// Back-compat for the original (Phase 1.10) API: one timestamp + one staleness flag.
export async function getCacheFreshness(tenantId, staleAfterMs = 5 * 60 * 1000) {
  const f = await getFreshness(tenantId);
  const lastRefreshAt = f.lastCheckedAt;
  return { lastRefreshAt, isStale: lastRefreshAt === null || Date.now() - lastRefreshAt > staleAfterMs };
}

// Marks the stock datasets as "the server may have moved on" without downloading (used when a
// terminal learns of a change it cannot fetch right now, e.g. it just went offline mid-refresh).
export async function markStockPossiblyStale(tenantId) {
  const db = getOfflineDb(tenantId);
  for (const name of ['products', 'warehouseStock']) {
    const row = await db.meta.get(datasetKey(name));
    if (row) await db.meta.put({ key: row.key, value: { ...row.value, stale: true } });
  }
}

// ---------------------------------------------------------------------------------------------
// Reads (always local - never the network)
// ---------------------------------------------------------------------------------------------

export const getCachedProducts = (tenantId) => getOfflineDb(tenantId).products.toArray();
// Personal data: opened from its sealed form (empty while locked).
export const getCachedCustomers = (tenantId) => readSealed(tenantId, 'customers');
export const getCachedSuppliers = (tenantId) => readSealed(tenantId, 'suppliers');
export const getCachedExpenseCategories = (tenantId) => getOfflineDb(tenantId).expenseCategories.toArray();
export const getCachedBranches = (tenantId) => getOfflineDb(tenantId).branches.toArray();
export const getCachedWarehouses = (tenantId) => getOfflineDb(tenantId).warehouses.toArray();
export const getCachedWarehouseStock = (tenantId, warehouseId) => {
  const t = getOfflineDb(tenantId).warehouseStock;
  return warehouseId ? t.where('warehouseId').equals(warehouseId).toArray() : t.toArray();
};

// ---------------------------------------------------------------------------------------------
// Keeping it fresh while online
// ---------------------------------------------------------------------------------------------

export const STOCK_MUTATED_EVENT = 'akvf:stock-mutated';
const KEEP_FRESH_INTERVAL_MS = 60 * 1000;
const STOCK_DEBOUNCE_MS = 300;

// Starts the background keeper for a signed-in terminal; returns a stop function. Every trigger is
// fire-and-forget: none of them can delay or fail anything the user is doing.
export function startLocalDataKeeper(tenantId) {
  if (!tenantId || typeof window === 'undefined') return () => {};
  const kick = (reason, datasets) => {
    if (isOnline() && document.visibilityState !== 'hidden') syncLocalData(tenantId, { reason, datasets }).catch(() => {});
  };

  let stockTimer = null;
  const onStockMutated = () => {
    clearTimeout(stockTimer);
    stockTimer = setTimeout(() => kick('stock-mutated', ['products', 'warehouseStock']), STOCK_DEBOUNCE_MS);
  };
  const onOnline = () => kick('online');
  const onOffline = () => markStockPossiblyStale(tenantId).catch(() => {});
  const onVisible = () => { if (document.visibilityState === 'visible') kick('visible'); };

  window.addEventListener(STOCK_MUTATED_EVENT, onStockMutated);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  const interval = setInterval(() => kick('interval'), KEEP_FRESH_INTERVAL_MS);
  kick('start');

  return () => {
    clearTimeout(stockTimer);
    clearInterval(interval);
    window.removeEventListener(STOCK_MUTATED_EVENT, onStockMutated);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
