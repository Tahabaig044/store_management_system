import Dexie from 'dexie';

// Local offline store. Scoped per tenant AND - once a user is signed in (setOfflineScope) - per
// user: the database name carries both, so switching accounts on the same device/browser never
// mixes one shop's, or one cashier's/branch's, cached data or queued records with another's.
// Rows in a user's database were downloaded under THAT user's permissions and branch/warehouse
// access (see /api/offline), and its unsynced queue is only ever sent under that user's session.
//
// With no scope set (unit tests, code that runs before sign-in) the name is the tenant-only
// legacy name, unchanged.
let dbInstance = null;
let currentName = null;
let scope = null; // { tenantId, userId }

export function offlineDbName(tenantId) {
  return scope && scope.tenantId === tenantId && scope.userId ? `akvf_offline_${tenantId}__u_${scope.userId}` : `akvf_offline_${tenantId}`;
}

// Called by the auth layer on sign-in / session restore (sync, so the very first read after a
// browser restart already opens the right database) and with null on sign-out.
export function setOfflineScope(next) {
  scope = next && next.tenantId && next.userId ? { tenantId: next.tenantId, userId: next.userId } : null;
  if (dbInstance && dbInstance.name !== (scope ? offlineDbName(scope.tenantId) : dbInstance.name)) closeOfflineDb();
}

export function getOfflineScope() {
  return scope;
}

export function closeOfflineDb() {
  if (dbInstance) dbInstance.close();
  dbInstance = null;
  currentName = null;
}

export function getOfflineDb(tenantId) {
  const name = offlineDbName(tenantId);
  if (dbInstance && currentName === name) return dbInstance;
  if (dbInstance) dbInstance.close();

  const db = new Dexie(name);

  // v1: Phase 2 slice 1 - offline POS/Sales only.
  db.version(1).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    pendingSales: 'clientId, status, createdAt',
    meta: 'key',
  });

  // v2: Phase 2 slice 2 - extends offline creation to Purchases, Expenses,
  // Customers, Suppliers, and Optical Orders. Every "pending*" table shares
  // the same shape (clientId, status, createdAt, payload, lastError,
  // serverResult) so they can all be driven by the same generic outbox logic
  // in syncEngine.js - see createOutbox().
  db.version(2).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    suppliers: 'id, name',
    expenseCategories: 'id, name',
    pendingSales: 'clientId, status, createdAt',
    pendingPurchases: 'clientId, status, createdAt',
    pendingExpenses: 'clientId, status, createdAt',
    pendingCustomers: 'clientId, status, createdAt',
    pendingSuppliers: 'clientId, status, createdAt',
    pendingOpticalOrders: 'clientId, status, createdAt',
    meta: 'key',
  });

  // v3: Phase 2 slice 3 - offline queueing for the Sale reversal action.
  // Unlike the "pending*" create tables, this queues an action against an
  // *existing* server record (identified by saleId in the payload) rather
  // than a new one - see createActionOutbox() in syncEngine.js.
  db.version(3).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    suppliers: 'id, name',
    expenseCategories: 'id, name',
    pendingSales: 'clientId, status, createdAt',
    pendingPurchases: 'clientId, status, createdAt',
    pendingExpenses: 'clientId, status, createdAt',
    pendingCustomers: 'clientId, status, createdAt',
    pendingSuppliers: 'clientId, status, createdAt',
    pendingOpticalOrders: 'clientId, status, createdAt',
    pendingReversals: 'clientId, status, createdAt',
    meta: 'key',
  });

  // v4: Phase 1.10 - offline queueing for direct warehouse stock moves
  // (receive/dispatch/adjust), another action outbox like pendingReversals -
  // see createActionOutbox()'s warehouseStockMovesOutbox in syncEngine.js.
  db.version(4).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    suppliers: 'id, name',
    expenseCategories: 'id, name',
    pendingSales: 'clientId, status, createdAt',
    pendingPurchases: 'clientId, status, createdAt',
    pendingExpenses: 'clientId, status, createdAt',
    pendingCustomers: 'clientId, status, createdAt',
    pendingSuppliers: 'clientId, status, createdAt',
    pendingOpticalOrders: 'clientId, status, createdAt',
    pendingReversals: 'clientId, status, createdAt',
    pendingWarehouseStockMoves: 'clientId, status, createdAt',
    meta: 'key',
  });

  // v5: Phase 1.11 - offline queueing for standalone customer/supplier
  // payments (POST /payments), a plain "create" outbox like pendingSales/
  // pendingPurchases - see paymentsOutbox in syncEngine.js.
  db.version(5).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    suppliers: 'id, name',
    expenseCategories: 'id, name',
    pendingSales: 'clientId, status, createdAt',
    pendingPurchases: 'clientId, status, createdAt',
    pendingExpenses: 'clientId, status, createdAt',
    pendingCustomers: 'clientId, status, createdAt',
    pendingSuppliers: 'clientId, status, createdAt',
    pendingOpticalOrders: 'clientId, status, createdAt',
    pendingReversals: 'clientId, status, createdAt',
    pendingWarehouseStockMoves: 'clientId, status, createdAt',
    pendingPayments: 'clientId, status, createdAt',
    meta: 'key',
  });

  // v6: Phase 1.14 - offline queueing for Quotation creation, a plain
  // "create" outbox like pendingSales/pendingPurchases/pendingPayments (see
  // quotationsOutbox in syncEngine.js). A Quotation has no stock or
  // financial effect of its own, so - unlike Sales Order/Quotation status
  // transitions and conversions, deliberately left online-only (see this
  // phase's report, Offline-First Verification) - queueing its creation is
  // exactly as safe as the existing Sale/Purchase/Expense outboxes.
  db.version(6).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    suppliers: 'id, name',
    expenseCategories: 'id, name',
    pendingSales: 'clientId, status, createdAt',
    pendingPurchases: 'clientId, status, createdAt',
    pendingExpenses: 'clientId, status, createdAt',
    pendingCustomers: 'clientId, status, createdAt',
    pendingSuppliers: 'clientId, status, createdAt',
    pendingOpticalOrders: 'clientId, status, createdAt',
    pendingReversals: 'clientId, status, createdAt',
    pendingWarehouseStockMoves: 'clientId, status, createdAt',
    pendingPayments: 'clientId, status, createdAt',
    pendingQuotations: 'clientId, status, createdAt',
    meta: 'key',
  });

  // v7: Phase 3.1 - the local read model grows from four tables to everything a terminal needs to
  // keep operating: the branches and warehouses this user may access and the per-warehouse stock
  // quantities. Nothing is dropped or renamed; existing rows and every outbox are untouched.
  // `meta` now also holds per-dataset version/freshness records ('dataset:<name>'), the access
  // scope the cache was downloaded for ('scope') and the cache schema version ('schemaVersion').
  db.version(7).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    suppliers: 'id, name',
    expenseCategories: 'id, name',
    branches: 'id',
    warehouses: 'id',
    warehouseStock: 'id, warehouseId, productId',
    pendingSales: 'clientId, status, createdAt',
    pendingPurchases: 'clientId, status, createdAt',
    pendingExpenses: 'clientId, status, createdAt',
    pendingCustomers: 'clientId, status, createdAt',
    pendingSuppliers: 'clientId, status, createdAt',
    pendingOpticalOrders: 'clientId, status, createdAt',
    pendingReversals: 'clientId, status, createdAt',
    pendingWarehouseStockMoves: 'clientId, status, createdAt',
    pendingPayments: 'clientId, status, createdAt',
    pendingQuotations: 'clientId, status, createdAt',
    meta: 'key',
  });

  // v8: Phase 3.3 - advanced offline transactions. Six read tables hold the selection lists a terminal
  // needs to make returns / notes / applications / refunds offline (returnable sales and purchases, open
  // documents, notes with credit left) and eight outboxes hold the work itself. Nothing existing changes.
  db.version(8).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    suppliers: 'id, name',
    expenseCategories: 'id, name',
    branches: 'id',
    warehouses: 'id',
    warehouseStock: 'id, warehouseId, productId',
    returnableSales: 'id',
    returnablePurchases: 'id',
    arDocuments: 'id',
    apDocuments: 'id',
    arNotes: 'id',
    apNotes: 'id',
    pendingSales: 'clientId, status, createdAt',
    pendingPurchases: 'clientId, status, createdAt',
    pendingExpenses: 'clientId, status, createdAt',
    pendingCustomers: 'clientId, status, createdAt',
    pendingSuppliers: 'clientId, status, createdAt',
    pendingOpticalOrders: 'clientId, status, createdAt',
    pendingReversals: 'clientId, status, createdAt',
    pendingWarehouseStockMoves: 'clientId, status, createdAt',
    pendingPayments: 'clientId, status, createdAt',
    pendingQuotations: 'clientId, status, createdAt',
    pendingSalesReturns: 'clientId, status, createdAt',
    pendingPurchaseReturns: 'clientId, status, createdAt',
    pendingCreditNotes: 'clientId, status, createdAt',
    pendingDebitNotes: 'clientId, status, createdAt',
    pendingCreditRefunds: 'clientId, status, createdAt',
    pendingDebitRefunds: 'clientId, status, createdAt',
    pendingCreditApplications: 'clientId, status, createdAt',
    pendingDebitApplications: 'clientId, status, createdAt',
    meta: 'key',
  });

  // v9: Phase 3.4 - read models for offline viewing (recent sales and purchases). Sealed like the other
  // personal data (secureStore.js). Nothing existing changes.
  db.version(9).stores({
    products: 'id, name, sku, barcode',
    customers: 'id, name',
    suppliers: 'id, name',
    expenseCategories: 'id, name',
    branches: 'id',
    warehouses: 'id',
    warehouseStock: 'id, warehouseId, productId',
    returnableSales: 'id',
    returnablePurchases: 'id',
    arDocuments: 'id',
    apDocuments: 'id',
    arNotes: 'id',
    salesHistory: 'id',
    purchasesHistory: 'id',
    apNotes: 'id',
    pendingSales: 'clientId, status, createdAt',
    pendingPurchases: 'clientId, status, createdAt',
    pendingExpenses: 'clientId, status, createdAt',
    pendingCustomers: 'clientId, status, createdAt',
    pendingSuppliers: 'clientId, status, createdAt',
    pendingOpticalOrders: 'clientId, status, createdAt',
    pendingReversals: 'clientId, status, createdAt',
    pendingWarehouseStockMoves: 'clientId, status, createdAt',
    pendingPayments: 'clientId, status, createdAt',
    pendingQuotations: 'clientId, status, createdAt',
    pendingSalesReturns: 'clientId, status, createdAt',
    pendingPurchaseReturns: 'clientId, status, createdAt',
    pendingCreditNotes: 'clientId, status, createdAt',
    pendingDebitNotes: 'clientId, status, createdAt',
    pendingCreditRefunds: 'clientId, status, createdAt',
    pendingDebitRefunds: 'clientId, status, createdAt',
    pendingCreditApplications: 'clientId, status, createdAt',
    pendingDebitApplications: 'clientId, status, createdAt',
    meta: 'key',
  });

  dbInstance = db;
  currentName = name;
  return db;
}

// Tables that hold a read copy of server data (as opposed to unsynced work). Cleared on sign-out /
// scope change; the pending* outboxes are never cleared by these paths.
export const SELECTION_TABLES = ['returnableSales', 'returnablePurchases', 'arDocuments', 'apDocuments', 'arNotes', 'apNotes', 'salesHistory', 'purchasesHistory'];
export const READ_TABLES = ['products', 'customers', 'suppliers', 'expenseCategories', 'branches', 'warehouses', 'warehouseStock', ...SELECTION_TABLES];
// Tables whose contents depend on the user's branch/warehouse access (not just the tenant).
export const SCOPE_DEPENDENT_TABLES = ['branches', 'warehouses', 'warehouseStock', ...SELECTION_TABLES];

const LEGACY_TABLES = ['pendingSales', 'pendingPurchases', 'pendingExpenses', 'pendingCustomers', 'pendingSuppliers', 'pendingOpticalOrders', 'pendingReversals', 'pendingWarehouseStockMoves', 'pendingPayments', 'pendingQuotations'];
// (The Phase 3.3 outboxes never existed in a tenant-only database, so there is nothing of them to adopt.)

// One-time adoption of work queued before per-user databases existed: the tenant-only database's
// unsynced entries (never its read caches) move into the first user's database and the old one is
// deleted, so nothing queued on a terminal is lost by the upgrade. Runs at most once per tenant.
export async function adoptLegacyDatabase(tenantId) {
  if (!scope || scope.tenantId !== tenantId) return 0;
  const legacyName = `akvf_offline_${tenantId}`;
  if (!(await Dexie.exists(legacyName))) return 0;
  const legacy = new Dexie(legacyName);
  let moved = 0;
  try {
    await legacy.open();
    const target = getOfflineDb(tenantId);
    for (const table of LEGACY_TABLES) {
      if (!legacy.tables.some((t) => t.name === table)) continue;
      const rows = await legacy.table(table).toArray();
      const keep = rows.filter((r) => r.status !== 'synced');
      if (keep.length) await target[table].bulkPut(keep);
      moved += keep.length;
    }
  } finally {
    legacy.close();
  }
  await Dexie.delete(legacyName);
  return moved;
}
