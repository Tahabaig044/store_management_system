# PHASE 1.10 — INVENTORY & STOCK MANAGEMENT + OFFLINE-FIRST DATA SYNC ENGINE: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-21
**Scope:** Universal Inventory & Stock Management, and the Offline-First Inventory & Data Synchronization Engine.
**Test database:** local, throwaway Postgres (`akvisionflow_phase110`) via the portable Postgres instance at `D:\pgsql-portable`. No production database was touched.

---

## 1. Executive Summary

Phase 1.10 audited the complete existing inventory architecture before making any change, per the explicit instruction not to assume the offline mechanism or the atomic-mutation guarantees already existed just because earlier phases (1.8 Sales, 1.9 Purchase) had fixed similar bugs elsewhere. The audit found the SAME class of concurrency bug already fixed for Sales/Purchase present in **three additional, previously-unaudited places**: `adjustWarehouseStock` (the single function Stock Transfer and direct Warehouse receive/dispatch/adjust both depend on), Stock Transfer's `approve`/`reject`/`cancel`/`dispatch`/`receive` status transitions, and a second, entirely separate, also-unsafe stock-adjustment endpoint on `products.routes.js` (`/adjust-stock`) that duplicates `warehouses.routes.js`'s `/adjust`. All were fixed with the same atomic-conditional-update pattern established in Phase 1.8/1.9. None of the three direct stock-movement endpoints (`receive`/`dispatch`/`adjust`) had idempotency-key support at all; this was added.

On the offline side, the audit found a working, already-tested outbox/sync architecture (Sales, Purchases, Expenses, Customers, Suppliers, Optical Orders, Sale Reversal) but **zero offline capability for any inventory-specific mutation** (Stock Transfer, Stock Adjustment) — this was the literal, direct gap Phase 1.10 exists to close. A new outbox (`warehouseStockMoves`) was added by extending the existing `createActionOutbox` factory (not by building a parallel sync engine), wired into the one screen that already exposes direct stock receive/dispatch, and a stale-cache-detection helper was added on top of the existing `lastCacheRefresh` marker. Bidirectional sync, conflict handling, stale-stock detection, and multi-terminal reconciliation were all directly tested — not assumed from Sales/Customer/Supplier coverage.

Product-variant-level stock tracking and unit-conversion-aware inventory math were found to be **not implemented anywhere in the codebase** (pre-existing, not introduced by this phase) and are explicitly documented as deferred rather than built now, per the task's own instruction against inventing large cross-cutting changes mid-phase.

**Overall result: PHASE 1.10 — CLOSED WITH CONDITIONS.** See Section 48 for the exact justification.

---

## 2. Scope

In scope: WarehouseStock, StockMovement (the existing `InventoryTransaction` ledger), Stock Transfer, Stock Adjustment, their concurrency safety, RBAC, tenant/company/branch/warehouse isolation, and the offline-first architecture for inventory specifically (local cache, outbox, bidirectional sync, stale detection, conflict resolution, idempotency, multi-terminal reconciliation, tenant-isolated local storage).

Explicitly out of scope and NOT implemented, per the task's Strict Scope Control section: Payments & Receipts, Expenses, Returns/Credit-Debit Notes as a separate module, Quotations & Orders, a new Notifications module, Universal Search, Core Reports, a separate Core Regression/Security phase, Accounting/ERP/Configuration/Industry Engine/Branding/AI/Integrations/Mobile/Platform phases, a full reservation engine, AI-based reorder forecasting, and a Mobile Barcode module. Where a cross-cutting issue was found (product-variant stock, unit conversion, the dual adjustment endpoints, Sale/Purchase not feeding WarehouseStock), it is documented in Sections 44/45 and deferred, not silently implemented.

---

## 3. Existing Inventory Architecture Audit

Read in full before any change: `warehouseStock.js` (83 lines), `warehouses.routes.js` (328 lines), `stockTransfers.routes.js` (324 lines), `products.routes.js`'s stock-related sections, the relevant Prisma models (`Product`, `ProductVariant`, `WarehouseStock`, `StockTransfer`, `StockTransferItem`, `InventoryTransaction`), `permissionCatalog.js`, `syncEngine.js`, `db.js`, `useOfflineData.js`, `useSyncStatus.js`, and the existing test coverage (`multiBranch.test.js`, `branchWarehouseManagement.test.js`).

Key architectural facts confirmed, not assumed:
- **`Product.stockQuantity`** is the tenant-wide authoritative total used by Sale/Purchase/GRN/Return (Phase 1.8/1.9) - unchanged, untouched by this phase.
- **`WarehouseStock`** is a per-(warehouse, product) breakdown, kept in sync with `Product.stockQuantity` by exactly one function, `adjustWarehouseStock` - the single place any warehouse-scoped stock change must go through, per its own doc comment. Confirmed this is used only by `stockTransfers.routes.js` (dispatch/receive) and `warehouses.routes.js` (receive/dispatch/adjust) - Sale and Purchase/GRN do **not** call it (Section 9/10).
- **`InventoryTransaction`** is the existing stock-movement ledger (`StockMovement` in the task's own vocabulary), with `InventoryTxnType` already covering `OPENING_STOCK`, `PURCHASE_RECEIVE`, `SALE_DEDUCTION`, `SALE_REVERSAL`, `ADJUSTMENT_IN`/`OUT`, `PURCHASE_RETURN`, `TRANSFER_DISPATCH`/`RECEIVE` - no new movement type was needed or added.
- **Stock Transfer** (Request → Approve/Reject → Dispatch → Receive → Completed, with short/damaged quantity tracking, an approval threshold, and idempotent create) already exists in full and is already extensively tested (`multiBranch.test.js`).
- **Stock Adjustment** already exists as **two separate, duplicate implementations**: `POST /warehouses/:id/adjust` (warehouse-scoped, approval-threshold-gated) and `POST /products/:id/adjust-stock` (tenant-wide, no warehouse concept). Both pre-date this phase; neither was concurrency-safe (Section 6).
- **RBAC**: `WAREHOUSE` and `STOCK_TRANSFER` permission resources already exist in the centralized Phase 0.4 catalog and are already correctly used everywhere in both route files - no RBAC gap analogous to Phase 1.9's RFQ finding exists here.
- **Offline**: `OUTBOXES` (Sales, Purchases, Expenses, Customers, Suppliers, Optical Orders, Sale Reversal) already exist on the shared `createOutbox`/`createActionOutbox` factories. `refreshCaches()` already performs a full-replace pull of products/customers/suppliers/expense-categories and stamps `meta.lastCacheRefresh`. **No outbox existed for Stock Transfer or Stock Adjustment at all** before this phase.
- **Product variants**: `ProductVariant.stockQuantity` exists as a field but is set only via a direct admin `PATCH` - it is never read or written by Sale, Purchase, Transfer, or Adjustment anywhere in the codebase (confirmed by grep, not assumption).
- **Unit conversion**: `UnitOfMeasure.baseUnitId`/`conversionFactor` (Phase 1.5) exist only in the unit catalog's own CRUD; no inventory quantity calculation anywhere applies a conversion factor.
- **`GET /api/inventory/transactions`** (`inventory.routes.js`) - a separate, tenant-wide (not warehouse-scoped-only) `InventoryTransaction` listing endpoint backing the Stock Movement Report, distinct from `GET /warehouses/:id/history`. Read-only, so it carries none of the concurrency risk this phase focuses on; it remains on the legacy `requireRole(...INVENTORY_STAFF)` pattern rather than a centralized `requirePermission` call (no bare `INVENTORY` resource exists in the permission catalog) - consistent with the same accepted, already-disclosed incremental-RBAC-migration precedent seen elsewhere in the codebase, not a new gap introduced or left uniquely unaddressed by this phase.

---

## 4. Database Changes

One additive migration, `20260921030000_phase1_10_inventory_stock_management`, generated via the established non-interactive `prisma migrate diff --script` workflow and verified to apply cleanly on top of the full existing migration history against a fresh scratch database before being copied into the real project:

```sql
ALTER TABLE "inventory_transactions" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "inventory_transactions_tenantId_idempotencyKey_key" ON "inventory_transactions"("tenantId", "idempotencyKey");
```

No column was dropped, renamed, or made non-nullable; no existing data is affected. `npx prisma validate` passed before migration generation; `npx prisma generate` completed cleanly against the real project afterward. No `StockMovement`, `WarehouseStock`, or new stock table was created - the existing `InventoryTransaction`/`WarehouseStock` models were reused exactly, per the explicit instruction not to duplicate the inventory engine.

---

## 5. Inventory Model

Verified the model matches Tenant → Company → Branch → Warehouse → Product/Variant → Stock: `Warehouse.companyId`/`branchId` (Phase 1.3), `WarehouseStock.warehouseId`/`productId` with `quantity`/`lowStockThreshold`/`reorderLevel`/`updatedAt` all already present and unchanged. No `reserved`/`available` split exists (Section 10 - not built, since no existing architecture required it; documented as a future enhancement per the task's own instruction). `WarehouseStock` has no `variantId` column - variant-level warehouse stock does not exist (Section 11/44).

---

## 6. Stock Movement

The existing `InventoryTransaction` ledger is used unchanged as the movement record for every stock-changing operation covered by this phase (receive/dispatch/adjust/transfer-dispatch/transfer-receive). Every atomic-mutation fix in this phase (Section 13) preserves the existing "no stock change without a movement" invariant - verified directly: every test in `tests/inventoryStockManagement.test.js` that mutates stock also asserts on the resulting `WarehouseStock`/`Product` state, and the existing `multiBranch.test.js` suite already asserts on `warehouseId`-scoped `InventoryTransaction` history via `GET /warehouses/:id/history`. A second, tenant-wide read of the same ledger exists at `GET /api/inventory/transactions` (Section 3) for the Stock Movement Report - unchanged, read-only, verified to exist rather than overlooked. No new movement type was added; `idempotencyKey` (Section 4) is the only schema addition to this ledger.

---

## 7. Stock Adjustment

Both pre-existing adjustment implementations were extended, not replaced or merged (per the explicit instruction to extend existing workflows rather than rebuild them):
- `POST /warehouses/:id/adjust` (warehouse-scoped, requires a `note`, approval-threshold-gated) - fixed for atomicity (Section 13), gained `idempotencyKey`.
- `POST /products/:id/adjust-stock` (tenant-wide, no warehouse concept) - fixed for atomicity, gained `idempotencyKey`.

These two endpoints' continued duplication (identical purpose, different scope, no shared code) is a genuine, disclosed architectural finding, not silently resolved in this phase (Section 45 - a consolidation is a larger, riskier change than concurrency-safety scope permits). Every adjustment still requires a reason (`note`, mandatory on the warehouse-scoped endpoint), records the actor (`createdById`), the warehouse (where applicable), the product, and the quantity, and always creates an `InventoryTransaction` - no silent quantity editing exists anywhere in either endpoint.

---

## 8. Stock Transfer

The full Request → Approve/Reject → Dispatch → Receive → Completed lifecycle, source/destination warehouse validation, permission checks, and idempotent create all pre-date this phase and are unchanged. What Phase 1.10 fixed: `approve`/`reject`/`cancel`/`dispatch`/`receive` were all check-then-blind-write (a pre-transaction status read, then an unconditioned update) - now every transition is an atomic, guarded `updateMany`, with `dispatch`/`receive` claiming their status transition **first, inside the transaction**, before touching any stock (Section 13). The entire dispatch/receive operation remains one `prisma.$transaction` - a failure on any line rolls back the whole thing, including the just-claimed status transition. Directly tested: same-branch and cross-branch transfer (pre-existing, re-verified), unauthorized destination (pre-existing, re-verified via `assertWarehouseAccess`), insufficient stock (pre-existing, re-verified), concurrent transfer (new, Section 14), duplicate transfer submission (pre-existing idempotencyKey test, re-verified).

---

## 9. Sales Integration

Directly re-verified (not assumed): a Sale still deducts `Product.stockQuantity` exactly as Phase 1.8 built and fixed it, and reversal still restores it exactly as fixed. **New finding, directly tested and explicitly documented**: a Sale carrying a `warehouseId` does **not** touch `WarehouseStock` at all (`tests/inventoryStockManagement.test.js`: "a Sale deducts Product.stockQuantity but does NOT touch WarehouseStock, even when a warehouseId is supplied") - this was already true and already disclosed as attribution-only in Phase 1.8's own report; Phase 1.10 does not change it, per the explicit instruction not to rewrite Sales in this phase, and instead documents the gap precisely (Section 45).

---

## 10. Purchase Integration

Directly re-verified: a Purchase with `receiveImmediately: true` still increments `Product.stockQuantity` exactly as Phase 1.9 built and fixed it; GRN's atomic over-receiving guard (Phase 1.9) is unaffected by this phase's changes (re-verified via the full `procurement.test.js`/`purchaseManagement.test.js` suites, 17/17 and 23/23 unmodified). **Same documented gap as Sales**: a Purchase's `warehouseId` does not drive a `WarehouseStock` update either (`tests/inventoryStockManagement.test.js`: "a Purchase (receiveImmediately) increments Product.stockQuantity but does NOT touch WarehouseStock") - confirmed, not assumed, and not rewritten in this phase.

---

## 11. Product Variant Support

**Finding**: variant-level stock is not integrated into the inventory engine anywhere in the codebase. `ProductVariant.stockQuantity` is a manually-editable field with no automatic adjustment from Sale, Purchase, Transfer, or Adjustment, and `WarehouseStock` has no `variantId` column at all - a warehouse's stock is tracked per-product only, never per-variant. Building genuine variant-level inventory (a new variant-aware stock table, and rewiring Sale/Purchase/Transfer/Adjustment to branch on variant vs. parent product) would be a large, cross-cutting change touching the already-closed Phase 1.8/1.9 mutation logic - explicitly out of scope for "verify... do not blindly rewrite." This is documented as a known limitation (Section 44), not silently built or silently ignored.

---

## 12. Unit Conversion

**Finding**: `baseUnitId`/`conversionFactor` exist only in the `UnitOfMeasure` catalog's own CRUD (Phase 1.5); no inventory quantity calculation anywhere in Sale, Purchase, WarehouseStock, or InventoryTransaction applies a conversion factor - every quantity field is stored and interpreted in the product's own stated unit, with no cross-unit math. Implementing the task's own worked example (2 Boxes purchased → 20 Pieces in inventory) would require rewiring every quantity field across two already-closed phases and would risk conflicting with existing data and assumptions, exactly what the task instructs against. Documented as a known limitation (Section 44), not implemented.

---

## 13. Concurrency Protection

Three genuine, previously-unfixed concurrency bugs were found and fixed, all via the same atomic-conditional-update pattern (`updateMany` with a guard, checking `count === 0` as the sole authoritative signal) established in Phase 1.8/1.9:
1. `adjustWarehouseStock` (`warehouseStock.js`) - `WarehouseStock.quantity` was a blind read-then-write; now an atomic `{ increment }` for increases/explicitly-allowed decreases, and a guarded conditional `updateMany` for ordinary decreases.
2. `products.routes.js`'s `/adjust-stock` - `Product.stockQuantity` was a blind read-then-write; same fix pattern applied.
3. `stockTransfers.routes.js`'s `approve`/`reject`/`cancel`/`dispatch`/`receive` - all were check-then-blind-write status transitions; all now atomic guarded transitions, with `dispatch`/`receive` claiming the transition first, inside the transaction, before any stock mutation.

`idempotencyKey` support (new `InventoryTransaction.idempotencyKey`, Section 4) was added to `/warehouses/:id/receive`, `/dispatch`, `/adjust`, and `/products/:id/adjust-stock`, mirroring the existing Purchase/Sale/StockTransfer/GoodsReceipt pattern - none of these four endpoints had any duplicate-submission protection before this phase.

---

## 14. Concurrent Test Results

All of the following used real concurrent HTTP requests via `Promise.all` against the real Express app and a real Postgres transaction - not simulated, not sequential calls to the same function. Full detail (initial stock, requests, expected/actual result, final stock, movements) is in `tests/inventoryStockManagement.test.js`; summarized here:

| Case | Scenario | Initial | Concurrent requests | Result | Final state |
|---|---|---|---|---|---|
| C | Warehouse dispatch race | stock=10 | dispatch 7, dispatch 6 | one 200, one 409 | stock ∈ {3,4}, never negative, Product/WarehouseStock always match |
| C | Warehouse adjustment, sum fits | stock=10 | adjust -4, adjust -6 | both 200 | stock=0 |
| C | Product-level adjust-stock race | stock=10 | -7, -6 | one 200, one 422 | stock ∈ {3,4} |
| D | Two different transfers draining one source | stock=10 | dispatch 7 (transfer 1), dispatch 6 (transfer 2) | one 200, one 409 | source stock ∈ {3,4} |
| D | Double-dispatch of the SAME transfer | source=10, transfer qty=4 | dispatch, dispatch | one 200, one 409 | source stock=6 (not 2) |
| D | Double-receive of the SAME transfer | dest=0, transfer qty=5 | receive, receive | one 200, one 409 | dest stock=5 (not 10) |
| E-equivalent | Double-approve of the SAME transfer | PENDING_APPROVAL | approve, approve | one 200, one 409 | approved exactly once |

Case A (concurrent Sales, stock=5, sell 4 and 3) and Case B (concurrent Purchase receiving, PO qty=100, receive 70 and 50) are Phase 1.8's and Phase 1.9's own findings and fixes respectively - re-verified as still passing via the full `salesManagement.test.js` (unmodified) and `purchaseManagement.test.js` (unmodified) suites in this phase's full regression (Section 39), not re-derived here.

---

## 15. RBAC

No RBAC gap was found (unlike Phase 1.9's RFQ finding) - `WAREHOUSE` (`VIEW`/`CREATE`/`UPDATE`/`APPROVE`) and `STOCK_TRANSFER` (`VIEW`/`CREATE`/`UPDATE`/`APPROVE`) already existed in the centralized catalog and are already used correctly by every route in both files. No new permission key was introduced. Re-verified via the full `permissionsArchitecture.test.js` suite (33/33, unmodified) and the existing `multiBranch.test.js` role-boundary tests (56/56 across the file group, unmodified).

---

## 16. Tenant/Company/Branch/Warehouse Isolation

Directly re-verified: `assertWarehouseAccess`/`getAccessibleWarehouseIds`/`assertEitherWarehouseAccess` are enforced on every route touched in this phase, unchanged in their own logic. New test: an `idempotencyKey` used by Tenant A never falsely deduplicates a request from Tenant B (`tests/inventoryStockManagement.test.js`: "an idempotencyKey used by Tenant A does not dedupe a request from Tenant B") - proves the new `@@unique([tenantId, idempotencyKey])` constraint is correctly tenant-scoped, not global. Cross-tenant/cross-branch/cross-company isolation for Warehouse/StockTransfer itself is unchanged and re-verified via `multiBranch.test.js`.

---

## 17. Offline-First Architecture

The existing outbox/sync architecture (`createOutbox`, `createActionOutbox`, per-tenant Dexie database, client-generated idempotency keys, never-auto-resolved conflicts) was extended, not replaced. `createActionOutbox` gained two additive, opt-in parameters - `includeBody` (POST a body and attach an idempotencyKey at queue time) and `applyOptimisticEffect` (mirroring `createOutbox`'s existing option) - both defaulting to their old behavior exactly, verified by the full pre-existing `syncEngine.test.js` suite passing unmodified (26/26 before, 33/33 after) including the specific reversal-outbox test that asserts the exact single-argument `apiClient.post` call shape. A new outbox, `warehouseStockMoves`, was built on this extended factory and wired into `Warehouses.jsx`'s existing Receive/Dispatch controls - no parallel sync engine, no duplicate outbox implementation.

---

## 18. Local Cache

Unchanged: `products`/`customers`/`suppliers`/`expenseCategories` are cached via `refreshCaches()`'s full-replace pull, tenant-scoped by Dexie database name (`akvf_offline_${tenantId}`). No new cache table was added for inventory specifically - the existing `products` cache (which already carries `stockQuantity`) is what a stock-aware offline screen would read from; Warehouse-level (`WarehouseStock`) detail views remain online-only (Section 44/45 - documented, not solved in this phase).

---

## 19. Outbox

New: `pendingWarehouseStockMoves` (Dexie schema v4, `db.js`), backing the new `warehouseStockMoves` outbox. Directly tested (`syncEngine.test.js`, "warehouse stock move outbox" describe block, 3 tests): queues with a client-generated idempotency key and posts to the action-specific `/warehouses/:warehouseId/:action` URL with a body; a dispatch optimistically decrements cached product stock at queue time while a receive/adjust increments it; a 409 insufficient-stock conflict at sync time is marked `conflict`, not `failed`. Registered in `useSyncStatus.js`'s `ENTITY_TABLES` so the existing global sync-status widget picks it up automatically - no new UI component was needed for this.

---

## 20. Cloud Synchronization

LOCAL → CLOUD: the existing outbox drain (`runSync`), now also covering warehouse stock moves, is unchanged in mechanism - sequential, oldest-first, per-tenant. Directly re-verified for the new outbox (Section 19) and unchanged for every existing one (full `syncEngine.test.js` suite, 33/33).

---

## 21. Cloud→Local Synchronization

Confirmed this already exists as `refreshCaches()` - a full-replace pull, not a push or a partial diff. This is periodic/on-demand (called on page mount, "if online"), not real-time - stated accurately here and in the UI-facing report language, per the explicit instruction not to claim real-time sync for a periodic/eventual mechanism. Directly tested as part of the multi-terminal narrative (Section 28): after a conflict, a fresh `refreshCaches()` pull correctly replaces the stale local product figure with the server's true current one.

---

## 22. Stale Stock Detection

New: `getCacheFreshness(tenantId, staleAfterMs = 5min)`, built directly on the existing `meta.lastCacheRefresh` marker `refreshCaches()` already wrote - no new sync-cursor/version-token protocol was invented, per the explicit instruction to prefer the simplest mechanism compatible with the existing system. Directly tested (`syncEngine.test.js`, "Stale cache detection"): reports stale when the cache has never been refreshed; reports fresh immediately after a refresh; reports stale once a caller-supplied threshold has elapsed (proven with a 0ms threshold, showing the check is genuinely time-sensitive, not a constant). This is a whole-cache-level signal (not per-product), an intentional, disclosed simplification (Section 44).

---

## 23. Conflict Detection

The existing mechanism - a synced mutation that the server rejects with 4xx is detected via the outbox's own error handling, distinguishing 409 (`conflict`) from other 4xx (`failed`) from network/5xx (stays `pending` for retry) - was re-verified as the correct detection mechanism for inventory specifically, not assumed from Sales. New test: an insufficient-stock 409 on a queued warehouse dispatch is correctly detected and marked `conflict` (`syncEngine.test.js`). The server-side atomic guards (Section 13) are what make this detection meaningful - without them, a racing mutation could have silently "succeeded" against a stale precondition instead of surfacing a real conflict.

---

## 24. Conflict Resolution

The existing, already-working policy - **server-authoritative rejection, surfaced as an explicit `conflict` state, never auto-resolved** - was verified as the deterministic policy for inventory conflicts specifically, via the mandatory multi-terminal narrative test (Section 28): Terminal B's offline sale of 7, based on a stale cached stock of 10, is rejected outright (not partially accepted, not silently corrected) when the cloud's true current stock (4) cannot honor it. This matches the task's own listed strategy ("transaction rejection... conflict state requiring user action") and is not a new policy invented for this phase - it is the same policy Phase 1.8/1.9 already established for Sales/Purchase, now explicitly proven for the inventory-conflict shape too.

---

## 25. Idempotency

Every offline-capable inventory mutation carries a client-generated `idempotencyKey`, generated once at queue time and never regenerated (unchanged mechanism). New server-side idempotency was added for the three direct stock-movement endpoints and `/adjust-stock` (Section 13), each backed by the new `InventoryTransaction.idempotencyKey` unique constraint. Directly tested: a retried `/adjust`, `/receive`, and `/adjust-stock` submission with the same key is deduplicated exactly once, not double-applied (`tests/inventoryStockManagement.test.js`, 3 tests) - proven with real duplicate HTTP requests, not inferred.

---

## 26. Interrupted Sync Recovery

The outbox's durability comes from Dexie/IndexedDB itself - a queued entry is written to local storage before any network call, and its `status` field (`pending`/`syncing`/`conflict`/`failed`) is the sole source of truth for what still needs to happen. This was re-verified for the new outbox via its existing generic behaviors (network failure leaves an item `pending` for retry; `retry()` resets a `conflict` back to `pending` and re-attempts). **Not directly tested in this phase**: a literal process/browser kill mid-sync (not practically simulable inside this test harness) - the underlying guarantee (a `pending`/`syncing` entry is never silently dropped, because nothing removes a row from the table except `discard()` or a successful sync) was verified by code inspection and by the existing durability tests, not by an actual kill-and-restart. Marked **CONDITION** for this specific sub-item (Section 47).

---

## 27. Sync Ordering

Confirmed: `runSync` drains each outbox `sortBy('createdAt')`, oldest first, and a failed/network-error item stops the drain for everything after it in that SAME outbox (already tested: "leaves the failed item and everything after it pending, without attempting later items"). No cross-entity ordering dependency exists in the current offline-capable surface area (Sales, Purchases, Expenses, Customers, Suppliers, Optical Orders, Sale Reversal, and now Warehouse Stock Moves are each independent top-level mutations) - the pre-existing, already-disclosed limitation ("an offline-created record cannot yet be referenced by another offline-created record in the same offline session") continues to apply and is restated here rather than silently carried forward.

---

## 28. Multi-Terminal Reconciliation

**Mandatory, directly executed** (`syncEngine.test.js`, "Multi-terminal stale-stock conflict narrative"): modeled as two independent request/cache sequences sharing one tenant and one product - the realistic shape of two physical terminals in production, each with its own separate IndexedDB (a single Node test process cannot literally instantiate two independent browser IndexedDB instances for the same tenantId against this module's own per-tenant singleton cache, so this is stated explicitly rather than glossed over). The scenario: Terminal B caches stock=10 and goes offline; Terminal A (a separate, real backend request) sells enough that true stock drops to 4; Terminal B, still offline, queues a sale for 7 against its stale 10; on reconnect, the sync is rejected as a 409 conflict (not silently applied, not silently dropped); Terminal B's cache is shown to still reflect its own optimistic decrement until it explicitly refreshes, at which point it converges to the server's true value (4). This proves: stale state is detected, the cloud is never blindly overwritten, the conflict is handled deterministically, no silent stock corruption occurs, and final state converges. The equivalent guarantee on the SERVER side - that it never applies a stale quantity regardless of which "terminal" asked - is proven by the real-concurrent-request tests in Section 14 and the Phase 1.8/1.9 suites.

---

## 29. Offline Cache Security

**Tenant isolation (Section 44 of the task, mandatory)**: directly tested (`syncEngine.test.js`, "Offline cache tenant isolation") - Tenant A's cached products are never visible when the same code path is asked for Tenant B's cache, because `getOfflineDb` opens a database named by `tenantId`; two different tenant IDs are two entirely separate IndexedDB databases with no shared storage. **Server-side revalidation**: every outbox item, new and old, POSTs to the SAME authenticated, permission-checked, tenant/branch/warehouse-scoped route used for an online request - there is no separate "trust the client" bulk-sync endpoint, so a synced mutation is revalidated by construction, not by any special-cased logic added for offline. No cached permissions, prices, or authorization decisions are ever sent to or trusted from the client during sync.

---

## 30. Frontend UX

`Warehouses.jsx`'s existing Receive/Dispatch controls now route through the offline outbox (Section 17/19): a `synced` result refreshes the on-screen stock list as before; a `pending` result shows "Saved on this device - will appear in the warehouse stock list once it's synced (you're offline)"; a `conflict`/`failed` result shows "Could not save: <reason>". No new sync-status UI component was built - the existing global sync-status widget (`useSyncStatus.js`) already picks up the new outbox automatically once registered in its `ENTITY_TABLES` list. Per the explicit "use existing design system, don't overcomplicate" instruction, no new Stock Transfer/Adjustment creation screens or stale-badge UI were built in this pass; `getCacheFreshness()` (Section 22) is available for a future screen to consume but is not yet wired into any component - documented in Section 45, not silently omitted.

---

## 31. Error Handling

Every new atomic guard throws a clean, existing error type (`ConflictError` → 409, `ValidationError` → 422/400) rather than letting a race surface as an unhandled 500 - verified directly by every concurrency test in Section 14 asserting an exact status code pair, never a 500. Idempotent replays return 200 with `deduplicated: true`, matching the existing Purchase/Sale/GRN/StockTransfer pattern exactly.

---

## 32. Transaction Safety

Every stock-changing operation touched in this phase (`adjustWarehouseStock`'s callers, StockTransfer dispatch/receive) remains inside one `prisma.$transaction` - the atomic status claim, the per-line stock mutations, and the movement record all commit or roll back together. Verified by the existing rollback-safety precedent (Phase 1.8/1.9) and by this phase's own concurrency tests, which show a rejected concurrent request leaves zero partial trace (no orphaned `InventoryTransaction`, no partially-applied `WarehouseStock`).

---

## 33. Sales Regression

`salesManagement.test.js` (Phase 1.8): full suite passes unmodified in this phase's full regression (Section 39) - confirms Phase 1.8's Sale-side fixes remain intact and unaffected by Phase 1.10's changes to `warehouseStock.js`/`stockTransfers.routes.js`/`products.routes.js`.

---

## 34. Purchase Regression

`procurement.test.js` (17/17) and `purchaseManagement.test.js` (23/23), both from Phase 1.9, pass unmodified in this phase's full regression - confirms GRN's atomic over-receiving guard and Purchase's return/pay atomic fixes are unaffected.

---

## 35. Supplier Regression

`supplierManagement.test.js` (Phase 1.7): full suite passes unmodified.

---

## 36. Customer Regression

`customerManagement.test.js` (Phase 1.6): full suite passes unmodified.

---

## 37. Optical Regression

`moduleArchitecture.test.js`'s Optical-disabled/enabled scenarios and Optical order + clinical workflow end-to-end test pass unmodified - Optical's own order flow does not depend on any code path touched in this phase.

---

## 38. Medical Regression

No Medicine-specific inventory fields exist to regress against (Section 34 of the task's own audit list - batch/expiry remain Product-level fields, untouched by this phase); Medicine's Product/Sale/Purchase paths are the same universal paths re-verified in Sections 33/34.

---

## 39. Full Backend Results

**Full regression initial result:** 28 test suites run, 26 passed, 2 failed; 583 tests total, 581 passed, 2 failed. Both failures were `Can't reach database server at 127.0.0.1:5432` errors surfacing through unrelated, pre-existing heavy dashboard-aggregation endpoints (`tests/business.test.js`'s Command Center test, `tests/mobileDashboard.test.js`'s summary test) - the same documented transient connection-pool/timing flake observed in every phase since 0.2 and explicitly reported in Phase 1.8/1.9. Following the established diagnostic protocol: Postgres health was confirmed healthy (`pg_ctl status`), no code/schema/test changes were made between the failure and the retry, and both files were retried in isolation - `mobileDashboard.test.js`: **12/12 passed**; `business.test.js`: **80/80 passed**, including the exact test that failed in the full run. This is not concealed: the full-suite run did fail 2/583, stated here plainly.

---

## 40. Full Frontend Results

`npx vitest run` (full suite): **29 test files passed, 126 tests passed, 0 failed** - includes the extended `syncEngine.test.js` (33/33) and `Warehouses.test.jsx` (6/6, 3 pre-existing + 3 new).

---

## 41. Lint

`npm run lint` (oxlint): exit code 0. All output is pre-existing warning classes (`react(set-state-in-effect)`, `react(only-export-components)`) already present across most of the codebase's list pages before this phase, including the exact same single warning already present in `Warehouses.jsx` prior to this phase's edits - none newly introduced.

---

## 42. Build

`npm run build` (`vite build`): succeeded in 3.90s, producing `dist/index.html`, `dist/assets/index-*.css` (236.80 kB), `dist/assets/index-*.js` (733.75 kB, a negligible increase from Phase 1.9's 732.23 kB reflecting the new outbox/test code). The only warning is the pre-existing "chunk larger than 500kB" advisory, unrelated to this phase.

---

## 43. Permission-Key Parity

`tests/permissionsArchitecture.test.js`: **33/33 passed**, unmodified. No new permission key was introduced in this phase (`WAREHOUSE`/`STOCK_TRANSFER` already existed and were reused as-is) - there is nothing new to seed or verify for parity beyond confirming the existing catalog and its frontend `hasPermission('WAREHOUSE:...')` checks in `Warehouses.jsx` continue to work, which the full frontend/backend regression already confirms.

---

## 44. Known Limitations

- **Sale/Purchase do not update WarehouseStock.** A `warehouseId` on Sale/Purchase remains attribution-only (an already-disclosed Phase 1.8/1.9 design decision) - directly re-confirmed by test in this phase (Sections 9/10). The per-warehouse breakdown (`WarehouseStock`) is only kept accurate for stock that has moved through Transfer or direct Warehouse receive/dispatch/adjust; a warehouse's `WarehouseStock` row can diverge from the reality of what was actually sold/purchased "at" that warehouse. This is the single most consequential architectural gap in the current Universal Inventory Model and is stated plainly, not minimized.
- **Two separate, duplicate stock-adjustment endpoints exist** (`/warehouses/:id/adjust` and `/products/:id/adjust-stock`) with different scopes and no shared code - both are now individually concurrency-safe and idempotent, but the duplication itself was not consolidated (Section 45).
- **Product-variant stock is not integrated into the inventory engine anywhere** - a manually-editable field only, never adjusted by any transactional flow (Section 11).
- **Unit conversion is not applied anywhere in inventory math** - `baseUnitId`/`conversionFactor` exist only in the catalog, unused by any quantity calculation (Section 12).
- **Cloud→Local sync is periodic/on-demand, not real-time push.** `refreshCaches()` must be explicitly called (typically on page mount, "if online"); a terminal that stays on one screen for a long time without navigating will not automatically learn of a cloud stock change until its next pull. Stated accurately per the task's own instruction against overclaiming real-time behavior.
- **Stale-cache detection is whole-cache-level, not per-item** - `getCacheFreshness()` answers "how old is my entire local snapshot," not "is this specific product's cached quantity still accurate." A per-item version/ETag scheme was deliberately not built, as the simpler, existing-marker-based approach was judged sufficient and lower-risk.
- **No offline outbox exists for Stock Transfer** - only direct Warehouse receive/dispatch/adjust and the pre-existing Sales/Purchase/etc. entities are offline-capable. Transfer's multi-step approval lifecycle was judged too complex to safely make offline in this pass, mirroring the Phase 1.9 precedent of not giving PurchaseOrder/GRN an offline outbox either.
- **Interrupted sync recovery** was verified by code inspection and by the existing durability/retry tests, not by an actual process-kill-and-restart (not practically simulable in this test harness) - see Section 26/47.
- **`getCacheFreshness()` is not yet wired into any UI component** - it exists and is tested, but no stale-badge screen consumes it yet (Section 45).

---

## 45. Deferred Items

- Consolidating the two duplicate stock-adjustment endpoints into one.
- Wiring Sale/Purchase's `warehouseId` into actual `WarehouseStock` adjustment (a materially larger change spanning three already-closed phases).
- Variant-level `WarehouseStock` (a new column/table plus rewiring every mutation path).
- Unit-conversion-aware inventory math.
- A reservation/available-stock engine (no existing architecture requires one).
- An offline outbox for Stock Transfer's dispatch/receive steps.
- A per-item (not whole-cache) staleness indicator, and wiring `getCacheFreshness()` into a UI component.
- AI-based reorder forecasting and automated purchasing recommendations (explicitly Phase 7's domain).
- A dedicated Mobile Barcode module (explicitly Phase 9's domain).

None of these were silently implemented; each is named here so a future phase can pick it up deliberately.

---

## 46. Security Review

- Every new/modified route remains behind `authenticate` + `requireTenant` + the existing `requirePermission('WAREHOUSE'|'STOCK_TRANSFER', ...)` checks - no new gap was introduced.
- Every new atomic guard uses `count === 0` (never a stale in-memory boolean) as the sole authoritative success/failure signal, consistent with the Phase 1.8/1.9 pattern.
- The new `idempotencyKey` is tenant-scoped by the `@@unique([tenantId, idempotencyKey])` constraint - directly tested to confirm one tenant's key can never dedupe another tenant's request (Section 16).
- Offline local storage is tenant-scoped by IndexedDB database name - directly tested (Section 29) to confirm no cross-tenant cache leakage on a device/context switch.
- No cached permission, price, branch, or warehouse value is ever trusted at sync time - every synced mutation is revalidated by the same route used for an online request.
- No secrets, credentials, or production connection strings were introduced or logged.

---

## 47. Acceptance Criteria Matrix

| # | Criterion | Result |
|---|---|---|
| 1 | Existing inventory architecture audited | PASS |
| 2 | Inventory stock model verified | PASS |
| 3 | Stock movement ledger verified | PASS |
| 4 | Atomic stock mutation verified | PASS (3 real bugs found and fixed) |
| 5 | Concurrent sales tested | PASS (Phase 1.8, re-verified via regression) |
| 6 | Concurrent purchase receiving tested | PASS (Phase 1.9, re-verified via regression) |
| 7 | Concurrent adjustment tested | PASS (bug found and fixed) |
| 8 | Concurrent transfer tested | PASS (bug found and fixed) |
| 9 | Concurrent reversal tested | PASS (Sale reversal Phase 1.8; transfer double-dispatch/receive/approve equivalent, new) |
| 10 | Stock transfer verified | PASS |
| 11 | Stock adjustment verified | PASS |
| 12 | Product variant stock verified | DEFERRED (not integrated into the engine; documented) |
| 13 | Unit conversion verified | DEFERRED (not applied anywhere; documented) |
| 14 | Negative stock policy documented | PASS (documented, including a real inconsistency between endpoints) |
| 15 | Low-stock logic verified | PASS (pre-existing `lowStockOnly`/`lowStock` flags, unchanged) |
| 16 | Search/filter verified | PASS (unchanged, reuses shared utilities) |
| 17 | Stock history verified | PASS (unchanged `InventoryTransaction`/`GET /warehouses/:id/history`) |
| 18 | Tenant isolation verified | PASS |
| 19 | Company isolation verified | PASS (unchanged, re-verified) |
| 20 | Branch isolation verified | PASS |
| 21 | Warehouse isolation verified | PASS |
| 22 | RBAC verified | PASS (no gap found) |
| 23 | Sales integration verified | PASS (integration confirmed; WarehouseStock gap documented) |
| 24 | Purchase integration verified | PASS (integration confirmed; WarehouseStock gap documented) |
| 25 | Stock movement idempotency verified | PASS |
| 26 | Transaction rollback verified | PASS |
| 27 | Local inventory cache verified | PASS |
| 28 | Offline inventory transaction verified | PASS (warehouse receive/dispatch) |
| 29 | Offline outbox verified | PASS (new `warehouseStockMoves` outbox) |
| 30 | Local→cloud sync verified | PASS |
| 31 | Cloud→local sync verified | PASS (periodic/on-demand, accurately described) |
| 32 | Stale stock detection verified | PASS (whole-cache-level) |
| 33 | Conflict detection verified | PASS |
| 34 | Conflict resolution verified | PASS (server-authoritative rejection, deterministic) |
| 35 | Duplicate sync protection verified | PASS |
| 36 | Interrupted sync recovery verified | CONDITION (durability verified by inspection + existing tests, not an actual kill-and-restart) |
| 37 | Sync ordering verified | PASS (FIFO within an outbox; no cross-entity dependency exists in current scope) |
| 38 | Multi-terminal reconciliation verified | PASS (executed as two independent request/cache sequences sharing one tenant, explicitly justified) |
| 39 | Terminal convergence verified | PASS |
| 40 | Offline cache tenant isolation verified | PASS |
| 41 | Server-side revalidation verified | PASS |
| 42 | Network failure retry verified | PASS (pre-existing, re-verified) |
| 43 | Sales regression passed | PASS |
| 44 | Purchase regression passed | PASS |
| 45 | Supplier regression passed | PASS |
| 46 | Customer regression passed | PASS |
| 47 | Optical regression passed | PASS |
| 48 | Medical regression passed | PASS |
| 49 | Full backend regression executed | PASS (581/583, 2 documented transient flakes, isolated retries clean) |
| 50 | Full frontend regression executed | PASS (126/126) |
| 51 | Lint passed | PASS |
| 52 | Build passed | PASS |
| 53 | Permission parity passed | PASS |

---

## 48. Final Status

**PHASE 1.10 — CLOSED WITH CONDITIONS**

Justification: every mandatory concurrency scenario (Cases C, D, and the transfer-equivalent of Case E) was directly tested with real concurrent HTTP requests and found to have genuine, previously-unfixed bugs, all of which are now fixed and verified. Idempotency, offline capability, stale-stock detection, conflict detection/resolution, multi-terminal reconciliation, and offline-cache tenant isolation were all directly tested against the actual inventory surface area - not claimed by analogy to Sales/Customer/Supplier coverage, per the task's explicit and repeated instruction. Bidirectional sync works and was verified in both directions. Conflict handling is deterministic and server-authoritative, and was proven with a real conflict scenario, not merely asserted. No case was found where stock corruption is possible, where tenant/branch/warehouse isolation fails, or where a duplicate sync can mutate stock twice - the criteria that would mandate NOT READY are not met.

The CONDITIONS are:
1. **Environmental**: the full backend regression suite experienced the same documented transient PostgreSQL connection-timing flake seen in every phase since 0.2 (2/583 failed), and both affected tests passed cleanly on isolated retry with no code changes - a test-run/environment condition, not a deterministic Phase 1.10 application defect.
2. **Disclosed architectural residuals** (Section 44): Sale/Purchase's `warehouseId` remains attribution-only and does not feed `WarehouseStock` (a carried-forward, already-disclosed Phase 1.8/1.9 design decision, not newly introduced); two duplicate stock-adjustment endpoints remain unconsolidated; product-variant stock and unit conversion are not integrated into the inventory engine anywhere; Cloud→Local sync is periodic, not real-time; Stock Transfer has no offline outbox; interrupted-sync recovery was verified by inspection and existing tests rather than an actual process kill.

None of these conditions represent a concealed defect, corrupted stock, a broken isolation boundary, or non-deterministic conflict handling - each is a directly-tested, explicitly-documented, and reasonably-scoped-out limitation, consistent with the task's own instructions not to silently fix unrelated architectural issues or exceed Phase 1.10's boundaries.

---

**STOP. Phase 1.11 has not been started. No future-phase work was proactively implemented. Awaiting Product Owner approval before proceeding.**
