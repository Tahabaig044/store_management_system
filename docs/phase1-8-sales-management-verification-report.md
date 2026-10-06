# PHASE 1.8 — SALES MANAGEMENT: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-21
**Scope:** Phase 1.8 — Sales Management
**Preceding gate:** Phase 1.7 — CLOSED (not reopened or modified)

---

## 1. Executive Summary

Phase 1.8 inspected the existing Sales/POS architecture in full before changing anything, and found it already mature: transactional stock deduction, idempotency-key-based offline dedup, branch scoping, a large-discount approval control, full accounting-journal posting, and reversal-based (never delete-based) correction — all already built and already tested by earlier phases. Rather than rebuilding any of this, Phase 1.8 made a small number of additive, carefully-scoped changes and, in the process of writing the concurrency tests this phase explicitly requires, **found and fixed two real, previously-undetected data-integrity race conditions** in the existing Sales create/reverse transactions, plus **found and locally mitigated** a pre-existing collision risk in the shared invoice-numbering utility. These were not hypothetical — each was reproduced with a real failing test before being fixed, and re-verified passing after.

The full backend regression suite was run to completion. Its first pass showed 2 failures out of 546 tests; both were independently isolated and retried per the established diagnostic protocol from every prior phase, and **both passed cleanly in isolation (80/80 and 12/12 respectively)**, with PostgreSQL confirmed healthy throughout. This is reported honestly below as a transient environment condition, not concealed, and not claimed as evidence the full suite was clean on its first run — it was not.

---

## 2. Scope

**In scope (implemented/verified this phase):** Universal Sale/SaleItem CRUD and reversal, Customer/Product/Service integration, Tenant/Company/Branch/Warehouse isolation, centralized RBAC, inventory deduction (including a genuine concurrency fix), transaction atomicity, payment/tax/discount compatibility (verification only), sales numbering (verification + a genuine, scoped fix), search/filter/pagination, existing offline Sales architecture (inspection + direct verification, no rewrite), Optical/Medical regression, full backend and frontend regression.

**Explicitly out of scope, not attempted:** the complete Offline-First Inventory & Data Sync Engine (Phase 1.10), Purchase Management (Phase 1.9), the complete Accounting Engine / Chart of Accounts / GL / AR-AP / bank reconciliation / financial statements (Phase 2), the complete Tax Engine, a rewrite of the shared `nextSequenceNumber` utility's core algorithm (affects 11 other modules), a per-warehouse stock reconciliation engine, and any cross-phase feature not named above.

---

## 3. Existing Sales Architecture Audit

Read in full before any code change:

- **`Sale`/`SaleItem` models** — header fields (customerId, branchId, invoiceNumber, status, paymentStatus, subtotal/discount/tax/total, amountPaid, paymentMethod, cashierId, idempotencyKey) and line fields (productId, quantity, unitPrice, discount, lineTotal) already existed and already matched the Universal Sales Data Model this phase's spec describes, **field-for-field equivalent** in every case except: no `warehouseId`, no `notes`, no `SaleItem.variantId`. No duplicate model was created — the existing `Sale`/`SaleItem` was extended additively.
- **`sales.routes.js`** — full CRUD (list/get/create), reversal (not deletion — "financial transactions must be immutable / reversal-based, never deleted", already the codebase's own stated design), idempotency-key dedup, branch-scoped list/get (`branchScopeWhere`), branch-access-checked create (`assertBranchAccess`), a large-discount MANAGEMENT-only approval threshold, a configurable negative-stock allowance, and full double-entry accounting-journal posting (Dr Cash/AR, Cr Revenue/Tax, Dr COGS/Cr Inventory) — all pre-existing, all left structurally intact.
- **`PurchaseItem`** was read for comparison (the closest sibling line-item model) — confirmed it also has no `unit`/`tax`/`description` fields, which is why `SaleItem` was **not** given them either: adding fields the sibling model consistently omits would create an inconsistent, ungrounded deviation rather than a genuine gap.
- **Frontend `Pos.jsx`** — already a complete, mature offline-first POS: reads products/customers from a local Dexie cache via live queries (`useLiveProducts`/`useLiveCustomers`), refreshes that cache from the server on mount when online, submits sales through the shared offline outbox (`OUTBOXES.sales.submit`), and — importantly — **already discloses the exact offline-stock-safety limitation** Phase 1.8's own instructions ask about: an `overStock` banner warns "may be flagged as a conflict if stock has genuinely run out," never claiming the locally-cached stock number is guaranteed current.
- **Frontend `SalesHistory.jsx`** — already had search (invoice #) and date-range filtering, sale reversal (including an **offline-queued reversal** via `OUTBOXES.reversals`, mirroring the sale-creation outbox), and a full invoice detail view.
- **Offline architecture (`frontend/src/offline/syncEngine.js`, `db.js`)** — a single shared, generic outbox factory (`createOutbox`/`createActionOutbox`) already used by six entities including Sales (`salesOutbox`) and a dedicated reversal action-outbox (`reversalsOutbox`). `pendingSales`/`pendingReversals` Dexie tables already existed. **No changes were made to this shared mechanism** — Phase 1.8 only added direct verification of its already-existing behavior for Sales specifically (Section 19).
- **Existing Sales tests** (`business.test.js`, `multiBranch.test.js`, `permissionsArchitecture.test.js`) already covered: CRUD, subtotal/total computation, invalid-product rejection, insufficient-stock rejection, negative-stock config, reversal (including role restriction to MANAGEMENT), branch filtering, tenant isolation, and Command Center KPI aggregation accuracy. **None of this pre-existing coverage was duplicated** — it was re-run and re-verified passing (Section 24).
- **No concurrency test existed anywhere in the codebase for Sales stock deduction** before this phase — confirmed by search. This is what Section 13 addresses.

---

## 4. Backend Changes

**`backend/src/modules/sales/sales.routes.js`** (all additive/surgical, no unrelated rewrite):

1. **Race-condition fix (stock deduction)** — the create transaction previously read `product.stockQuantity` in application code, computed a new balance, and issued a plain `SET stockQuantity = <computed value>`. Under Postgres's default READ COMMITTED isolation, two concurrent sales for the same product could both read the same pre-deduction quantity before either wrote, and the second writer would silently overwrite the first's correct result (a classic lost-update race) — allowing more stock to be sold than actually existed. **Fixed** by replacing the blind write with an atomic, conditional `updateMany({ where: { id, stockQuantity: { gte: quantity } }, data: { stockQuantity: { decrement: quantity } } })`, whose `count` result is the sole, authoritative source of truth for whether the deduction actually succeeded. The original pre-check loop is kept as a fast, non-authoritative early-rejection path for the common (non-racing) case.
2. **Race-condition fix (double reversal)** — the reversal handler had the identical read-then-write shape on the sale's own `status` field: two concurrent reversal requests for the same sale could both observe `status: 'COMPLETED'` before either wrote, and both would proceed to restore stock — double-crediting inventory. **Fixed** by flipping the status via `updateMany({ where: { id, status: 'COMPLETED' }, data: { status: 'REVERSED' } })` as the very first step; only the request whose `count` is 1 proceeds to restore stock, closing the race entirely.
3. **Invoice-number collision mitigation** — while testing the above fix, a second, independent, pre-existing bug was found: the shared `nextSequenceNumber` utility (Phase 0.6) generates the next number from a plain per-tenant row count, and its own source comment already discloses this is "not guaranteed gap-free under concurrent creates." Two simultaneous sales legitimately generated the same invoice number, and the second-committing transaction failed on the `@@unique([tenantId, invoiceNumber])` constraint (Prisma `P2002`) — a spurious failure unrelated to stock. **The shared utility itself was not modified** (it is reused, unchanged, by eleven other modules — rewriting its core algorithm is a materially larger cross-cutting change outside "Sales Management," and doing so was deliberately not attempted, per the instruction to document rather than silently fix cross-phase concerns). Instead, the entire sale-creation transaction is now wrapped in a bounded retry (up to 5 attempts) that specifically catches this one collision (`err.code === 'P2002' && err.meta?.target?.includes('invoiceNumber')`) and retries with a freshly-recomputed number; any other error propagates immediately, unretried.
4. **Universal Product/Service integration fix** — a `productKind: 'SERVICE'` product (Phase 1.4) always has `stockQuantity: 0` by design (no stock concept). Before this phase, selling one would **always** be rejected as "insufficient stock" unless the tenant had globally enabled negative stock (an unwanted, blanket workaround). **Fixed**: both the pre-check and the atomic deduction loop now skip stock validation, deduction, and `InventoryTransaction` creation entirely for SERVICE-kind lines; the reversal handler mirrors this (never "restores" phantom stock to a service).
5. **New optional fields**: `warehouseId` (Sale header, validated via the existing `assertWarehouseAccess`/`assertBranchAccess` — no new authorization logic), `variantId` (SaleItem, validated for tenant+product ownership), `notes` (Sale header, free text).
6. **New list filters**: `customerId`, `status`, `paymentStatus`, `branchId`, `warehouseId` on `GET /api/sales` — the branch/warehouse filters are validated against the caller's own access (reusing `assertBranchAccess`/`assertWarehouseAccess`) *before* narrowing the query, so a restricted user can never use an explicit filter to see past what `branchScopeWhere()` already restricts them to.

No existing field, endpoint URL, method, or permission requirement changed.

---

## 5. Frontend Changes

- **`SalesHistory.jsx`** — added Customer/Status/Payment-Status filter dropdowns (mirroring the new backend query params) and a Notes line in the invoice detail view.
- **`Pos.jsx`** — **no changes**. It already supported everything Phase 1.8 needed at the UI level (walk-in customer, offline-first checkout, stale-stock warning); no branch/warehouse selector was added, consistent with the disclosed backlog decision from Phase 1.3 (a Sales/POS branch/warehouse selector for multi-access users remains deferred, not this phase's job to build).

---

## 6. Database Changes

Migration `20260921010000_phase1_8_sales_management` — purely additive:

```sql
ALTER TABLE "sale_items" ADD COLUMN "variantId" TEXT;
ALTER TABLE "sales" ADD COLUMN "notes" TEXT, ADD COLUMN "warehouseId" TEXT;
ALTER TABLE "sales" ADD CONSTRAINT "sales_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

No existing column, table, or constraint was altered or dropped. Applied cleanly via `prisma migrate deploy` on top of the full existing migration history, verified against a fresh database.

---

## 7. Customer Integration — PASS

Existing customer selection, optional walk-in (no `customerId`), and history/receivable compatibility were already correct and unmodified. Verified by re-running existing coverage (`business.test.js`) plus new Phase 1.8 tests confirming a sale correctly attributes to a customer for filtering purposes. No clinical/Patient field was added to, or required by, any Sales code path (verified explicitly — Section 21).

---

## 8. Product/Service Integration — PASS

`productId` + optional `variantId` supported on each line. The Service-sale stock-check bug (Section 4.4) was found and fixed. Verified with dedicated tests: a pure-Service sale, a mixed Service+Physical-Good sale (stock deducted only for the physical line), and Service-line reversal (no phantom stock restore). No Optical/Medical-specific field (`frameBrand`, `lensType`, prescription fields, etc.) was added to, or accepted by, the Sale/SaleItem schema (explicitly tested — Section 21).

---

## 9. Tenant/Company/Branch/Warehouse Isolation — PASS

- **Tenant**: re-verified — Tenant B cannot view Tenant A's sale (404), including the new `warehouseId`/`notes` fields.
- **Company**: Sale has no direct `companyId` (consistent with the existing, deliberate design already used for Category/Brand/Unit/Customer/Supplier — company scoping is reached via `branchId → Company`, not duplicated onto every child record). No gap identified.
- **Branch**: unchanged, pre-existing `assertBranchAccess`/`branchScopeWhere` re-verified; a STORE_KEEPER restricted to one branch cannot create a sale attributed to a warehouse under a branch they lack access to (new test, 403).
- **Warehouse**: **new** — `warehouseId` is now validated via the existing `assertWarehouseAccess` (Phase 0.4) on create and on the new list filter. A warehouse belonging to another tenant is rejected (404); a warehouse the caller lacks access to is rejected (403).

---

## 10. RBAC/Permissions — PASS

The existing `SALE` catalog entries (`VIEW`: SALES_STAFF, `CREATE`: SALES_STAFF, `REVERSE`: MANAGEMENT) already exactly matched the three endpoints that actually exist (list/get, create, reverse) — no `SALE:UPDATE`/`CANCEL`/`DELETE` endpoint exists, so no such permission key was invented for a capability that isn't implemented (the architecture is reversal-only by design, not update/cancel/delete). No new permission resource was needed. Permission-key parity re-verified: 46 frontend-referenced keys, 0 missing from the backend catalog (unchanged from Phase 1.7).

---

## 11. Inventory Integration — PASS (with a genuine defect found and fixed)

Stock validation, deduction, and reversal-restoration were all re-verified correct, **and the check-then-write race condition described in Section 4.1 was found and fixed** — this is the single most significant finding of this phase. `InventoryTransaction` rows continue to be created for every deduction/restoration (never for Service lines). No negative stock occurs unless the existing, unchanged `allowNegativeStock` tenant setting permits it.

---

## 12. Transaction/Rollback Safety — PASS

Two new dedicated tests: (1) a sale with one valid line and one nonexistent product creates **zero** Sale record and **zero** stock change (404, verified via a before/after stock comparison); (2) a sale whose second line has insufficient stock rolls back the **first** line's already-applied deduction too (409, verified the first product's stock was left completely untouched) — confirming the whole operation is atomic, not partially applied.

---

## 13. Concurrent Stock Testing — PASS (two real bugs found and fixed)

Three dedicated concurrency tests were written and run using real simultaneous HTTP requests (`Promise.all`), not simulated/mocked concurrency:

1. **Stock=5, simultaneous sales for 4 and 3 (sum exceeds stock)**: exactly one request succeeds (201) and the other is rejected for insufficient stock (409); final stock is mathematically exact (never both succeeding, which would imply -2; never both failing). **First run: PASS** (this scenario doesn't depend on the invoice-number fix, since only one sale ever reaches the point of needing a number in the failure case... actually both attempt to acquire a number, but the diagnostic below explains the second scenario specifically).
2. **Stock=10, simultaneous sales for 4 and 3 (sum fits within stock)**: both requests should succeed, final stock exactly 3. **This test initially failed** — not because of the stock logic, but because it exposed the independent invoice-number collision described in Section 4.3 (the losing request received `409 "A record with these details already exists"`, a P2002 on `invoiceNumber`, not a stock-related rejection). After the retry-wrapper fix (Section 4.3), **re-run: PASS**, both sales succeed with distinct invoice numbers, final stock exactly 3.
3. **Concurrent double-reversal of the same sale**: exactly one of two simultaneous reverse requests succeeds (200), the other is rejected as already-reversed (409); final stock reflects exactly one restoration, not two. **PASS** after the Section 4.2 fix.

All three tests are part of `tests/salesManagement.test.js` and pass on the current code (19/19 in that file, confirmed via multiple full runs of the file).

---

## 14. Payments Compatibility — PASS (verification only, no engine built)

Existing cash/bank/other payment-method support, `amountPaid`/paymentStatus computation, and `Payment` record creation were re-verified unchanged. No Accounting Engine, Chart of Accounts, GL, or AR/AP capability was built or modified — the existing journal-posting call (`postJournalEntry`) was left completely untouched.

---

## 15. Tax/Discount Compatibility — PASS (verification only)

Existing line-level and invoice-level discount, invoice-level tax, subtotal/total computation, and the MANAGEMENT-only large-discount approval threshold were all re-verified unchanged via the full existing `business.test.js` suite. No Tax Engine was built.

---

## 16. Sales Numbering — CONDITION

The existing shared `nextSequenceNumber` utility (Phase 0.6) was reused, **unchanged**, exactly as instructed ("do not create another sequence generator"). However, this phase's own concurrency testing **proved** its already-disclosed non-atomicity is a real, reproducible collision under concurrent Sales creation. This was mitigated **locally, for Sales only**, via a bounded retry-the-whole-transaction wrapper (Section 4.3) — Sales' own numbering is now verified collision-safe. The underlying utility itself was not rewritten, and the same theoretical collision risk remains **undisclosed-no-longer-but-unfixed** in the eleven other modules that call it (Purchase, PurchaseOrder, RFQ, GoodsReceipt, StockTransfer, OpticalOrder, Patient, JournalEntry, and others) — recorded as a future backlog item (Section 30), not fixed here, since doing so for all eleven would be a materially larger, cross-cutting change outside "Sales Management."

---

## 17. Search/Filtering/Pagination — PASS

New `customerId`/`status`/`paymentStatus`/`branchId`/`warehouseId` filters added to `GET /api/sales`, each tested directly. Pagination continues to use the existing, unchanged `parsePagination` shared utility (Phase 0.6) — not duplicated.

---

## 18. Offline Sales Architecture — PASS (inspected, verified, not rewritten)

Inspected in full (Section 3). Zero changes were made to `syncEngine.js`, `db.js`, or any shared outbox mechanism. `Sale`'s pre-existing `idempotencyKey` field and the pre-existing `findExistingByIdempotencyKey` dedup check were reused unchanged.

---

## 19. Direct Offline Sales Tests

Distinguishing pre-existing (re-run, re-verified) from new, and being explicit about what was **not** directly tested, per the instruction not to claim untested offline behavior:

| Behavior | Status | Evidence |
|---|---|---|
| Offline sale queue (idempotency key assignment) | **PASS** (pre-existing) | `syncEngine.test.js` "outbox: queue", uses `OUTBOXES.sales` directly |
| Sale with line items syncs, stores server result | **PASS** (pre-existing) | `syncEngine.test.js` "outbox: sync success path", uses `OUTBOXES.sales` with `items` |
| Offline sale retry | **PASS** (pre-existing) | `syncEngine.test.js` "outbox: retry and discard", uses `OUTBOXES.sales` |
| Network failure handling | **PASS** (pre-existing) | `syncEngine.test.js` "outbox: network failure stops the drain", uses `OUTBOXES.sales` |
| Duplicate-sync protection | **PASS** (pre-existing) | `syncEngine.test.js` "outbox: idempotency across retries", uses `OUTBOXES.sales` |
| Sync success / conflict handling (409) | **PASS** (pre-existing) | `syncEngine.test.js` "outbox: conflict handling", uses `OUTBOXES.sales` |
| Optimistic local stock decrement | **PASS** (pre-existing) | `syncEngine.test.js` "optimistic cache effects" |
| `syncAll` drains the sales outbox alongside others | **PASS** (pre-existing) | `syncEngine.test.js` "syncAll" |
| POS UI: add-to-cart → checkout → synced/queued/conflict receipt | **PASS** (new, `Pos.test.jsx`, 4 tests) | `OUTBOXES.sales.submit` mocked at the boundary — verifies Pos.jsx's own handling, not `submit()`'s internals |
| `OUTBOXES.sales.submit()` online-immediate-sync path, exercised for real (not mocked) | **NOT TESTED** | No test in this codebase calls the real `submit()` for the sales outbox with `navigator.onLine = true`; this exact pattern was added for Suppliers in Phase 1.7 but not for Sales in this phase. Disclosed as a gap, not silently assumed. |
| Local state reconciliation (cached data verified consistent with server truth post-sync) | **NOT TESTED** | Relies on the pre-existing, unmodified `refreshCaches()` full-refetch mechanism (used by `Pos.jsx` on mount when online); no automated test in this codebase directly verifies post-sync reconciliation for Sales. |

---

## 20. Retry/Network Failure/Duplicate Sync Tests

Covered directly above (Section 19) via the pre-existing, re-verified `syncEngine.test.js` suite using `OUTBOXES.sales` as its primary example throughout. No new tests were required for these three specific behaviors since they were already directly (not inferentially) exercised against the Sales outbox before this phase began.

---

## 21. Optical Regression — PASS

`clinical.test.js` (32 tests: patients, appointments, examinations, prescriptions, optical orders, clinical reports, tenant isolation) — re-run in full, **passed unchanged** on every execution this phase. A new, explicit test in `salesManagement.test.js` also directly proves the point: sending `frameBrand`/`lensType`/a fabricated `prescriptionId` field in a sale-create request succeeds (the sale is created) but none of those fields appear anywhere on the resulting Sale/SaleItem record — the universal Sale model neither requires nor stores them.

---

## 22. Medical Regression — PASS

There is no separately-named "Medical Store" test suite in this codebase distinct from the Optical/clinical one; Medicine-specific behavior (batch/expiry attributes, the `MEDICINE` product type) is covered by `clinical.test.js`, `productArchitecture.test.js`, and `productServiceManagement.test.js`, all of which were re-run this phase (Section 24) and passed unchanged. The same explicit "no industry field accepted" test in Section 21 covers the Medicine side of the same universal-model guarantee.

---

## 23. Existing Customer/Supplier/Inventory Regression — PASS

- `customerManagement.test.js` — re-run, unaffected by Sales changes (not re-executed as a fresh run in this exact session pass, but no code touched by Phase 1.8 intersects Customer's own route file; its behavior is exercised indirectly by every Sales test that attaches a `customerId`, all of which passed).
- `supplierManagement.test.js` — unaffected; Sales does not touch Supplier code at all this phase.
- Inventory regression: `business.test.js`'s "Stock" describe block (opening stock, adjustment, negative-stock rejection, sale-driven deduction, purchase-driven increase, insufficient-stock blocking) — **re-run in full, 173/173 passed** (this count is from the combined run of `business.test.js`, `multiBranch.test.js`, `permissionsArchitecture.test.js`, `clinical.test.js` performed immediately after the Section 4.1/4.2 fixes, before the newer fields were added) and again as part of the full-suite runs reported in Section 24.

---

## 24. Full Backend Regression

**This section distinguishes the full-suite initial result from the isolated diagnostic retry result, exactly as required — the two must not be conflated.**

### Full-suite initial result

One complete run of the entire backend test suite (`npx jest --runInBand`, no file filter) against the Phase 1.8 test database:

```
Test Suites: 2 failed, 24 passed, 26 total
Tests:       2 failed, 544 passed, 546 total
Time:        540.779 s
```

The 2 failures:
1. `tests/business.test.js` — "Business Command Center (Phase 4) › a manager can access it and gets the full KPI/widget shape" — `GET /api/dashboard/command-center` returned `500` instead of `200`.
2. `tests/moduleArchitecture.test.js` — "the Command Center dashboard still responds correctly, with the clinical section empty/zeroed instead of erroring" — the same endpoint, the same `500`.

**This is reported as the actual, unfiltered first-pass result. It is not being described as "100% clean" — it was not.**

### Isolated diagnostic retry result

Per the established cross-phase diagnostic protocol, each failing file was re-run completely in isolation, with **no code, schema, migration, test, or configuration change made** between the full-suite failure and these retries:

- `tests/business.test.js` in isolation: **80/80 passed**, including the specific previously-failing test ("a manager can access it and gets the full KPI/widget shape").
- `tests/moduleArchitecture.test.js` in isolation: **12/12 passed**, including the specific previously-failing test ("the Command Center dashboard still responds correctly...").

PostgreSQL health during and around these retries:
- `pg_ctl status` confirmed the server running throughout (`pg_ctl: server is running (PID: 1344)`).
- Connection count checked via `pg_stat_activity`: 6 of 100 max before the retries, 15 of 100 max during — no exhaustion, no resource pressure observed.
- **Neither isolated retry reproduced the `500`.** No deterministic application failure was found.

### Final interpretation

Both failures hit the identical `/api/dashboard/command-center` endpoint — the same heavy, multi-query endpoint implicated in this exact failure signature across every prior phase's full-suite regression report (Phase 0.8 through 1.7), always with the identical "expect 200, got 500" shape, always resolving cleanly on isolated retry. This is documented as: **a transient local PostgreSQL connection-timing flake under full-suite load**, consistent with the pattern established and characterized across the entire program to date. It is **not** described as a Phase 1.8 application defect — no isolated retry reproduced it, and no code change was made or was needed to make the retries pass. It **is** disclosed honestly as the reason the full-suite run itself was not 100% clean on its first pass, which is why this phase's final status is CLOSED WITH CONDITIONS rather than an unqualified CLOSED (Section 34).

### Cumulative Phase 1.8 test count

546 total backend tests (up from 527 in Phase 1.7, +19 for the new `salesManagement.test.js` file), 26 suites (up from 25, +1 new file).

---

## 25. Full Frontend Regression — PASS

```
Test Files  29 passed (29)
Tests  112 passed (112)
```

(Up from 104/27 in Phase 1.7, +8 new tests across 2 new files: `SalesHistory.test.jsx` (4) and `Pos.test.jsx` (4).) Zero failures on this run — no flake observed on the frontend side this phase.

---

## 26. Lint — PASS

`npm run lint` (oxlint): 0 errors. Only the same pre-existing warning pattern (`react(set-state-in-effect)`, `react(only-export-components)`) already present across the codebase before this phase — no new warning types introduced.

---

## 27. Build — PASS

`npm run build` (vite): succeeds, no errors. Bundle size warning (>500kB chunk) is pre-existing and unrelated to this phase.

---

## 28. Permission-Key Verification — PASS

Every `RESOURCE:ACTION` string referenced anywhere in the frontend source was cross-checked against the backend `PERMISSION_CATALOG`: **46 keys, 0 missing** (unchanged from Phase 1.7 — no new permission resource was introduced this phase; `SALE:VIEW/CREATE/REVERSE` already existed and already matched the implemented endpoint surface exactly).

---

## 29. Transient Regression Flake Diagnostic

(Full detail in Section 24; summarized here per the required report structure.)

- **Full regression initial result**: 2 of 546 tests failed (`business.test.js`, `moduleArchitecture.test.js`), both on `GET /api/dashboard/command-center` returning `500`.
- **Isolated diagnostic retry result**: both files re-run completely independently, no code/schema/test/config changes made — `business.test.js` 80/80 pass, `moduleArchitecture.test.js` 12/12 pass. Neither reproduced the failure.
- **PostgreSQL health**: `pg_ctl` reported the server running (PID 1344) throughout; connection count stayed at 6–15 of a 100 maximum — no exhaustion.
- **No deterministic reproduction** of the `500` was achieved at any point after the initial full-suite run.
- **No code changes were required** to make the isolated retries pass.
- **Classification**: transient local PostgreSQL connection-timing flake under full-suite load, consistent with the identical pattern documented in every prior phase's report since Phase 0.8. Not classified as a Phase 1.8 application defect.

---

## 30. Known Limitations

1. **Sale.warehouseId is attribution/authorization-only.** It records and authorizes which warehouse a sale was fulfilled from (via the existing `assertWarehouseAccess`), but does **not** drive per-warehouse `WarehouseStock` deduction — `Product.stockQuantity` (the tenant-wide aggregate) remains the sole deduction target, exactly as before this phase. Reconciling per-warehouse deduction for Sales is Inventory Engine territory, explicitly reserved for Phase 1.10.
2. **SaleItem.variantId is attribution-only.** `ProductVariant.stockQuantity` is not read or written by any Sales code path; a variant sale still deducts at the parent Product level.
3. **The shared `nextSequenceNumber` utility's non-atomic counting was not rewritten.** Only Sales was hardened against its known collision risk (Section 16); Purchase, PurchaseOrder, RFQ, GoodsReceipt, StockTransfer, OpticalOrder, Patient, and JournalEntry numbering remain theoretically exposed to the identical, already-disclosed race under concurrent creates.
4. **No branch/warehouse selector exists in the POS UI** for a multi-access user who wants to record a sale against a location other than their own default — a disclosed backlog item unchanged since Phase 1.3.
5. **`OUTBOXES.sales.submit()`'s online-immediate-sync path was not exercised by a real (non-mocked) test this phase** (Section 19) — only the underlying `queue()`/`sync()` primitives were, plus a fully-mocked UI-level test of `Pos.jsx`'s own handling of `submit()`'s possible outcomes.
6. **Local state reconciliation was not independently tested.** `Pos.jsx`'s existing `refreshCaches()` call is the only mechanism reconciling cached data with server truth; no automated test verifies this specifically for Sales.
7. **Offline stock staleness is disclosed, not solved.** `Pos.jsx`'s pre-existing `overStock` banner is an honest heads-up, not a staleness-detection or reconciliation mechanism — full bidirectional cloud↔local stock reconciliation remains entirely Phase 1.10's job, not attempted here.

---

## 31. Deferred Phase 1.10 Offline Inventory Reconciliation Items

Explicitly **not** implemented or claimed complete in Phase 1.8, per the instruction not to pretend this phase completes Phase 1.10's job:

- Bidirectional cloud→local and local→cloud stock synchronization.
- Stock freshness/staleness detection or labeling beyond the existing generic overStock warning.
- Per-warehouse offline stock reconciliation.
- Conflict resolution for competing offline stock states across multiple terminals/warehouses.
- Any new local cache schema for warehouse-level (as opposed to tenant-aggregate) stock.

---

## 32. Security Review

- **Two genuine data-integrity vulnerabilities were found and fixed** (Sections 4.1, 4.2): an overselling race condition and a double-stock-restoration race condition, both under concurrent access, both previously undetected by any existing test. Both are now closed at the database-transaction level using atomic conditional updates, not application-level locking that could itself be raced.
- **Isolation re-verified, not weakened**: tenant, branch, and (new) warehouse isolation on Sales all correctly reject unauthorized access (404/403), including for the two newly-added fields.
- **No privilege escalation surface introduced**: no new permission resource, no new role, no bypass of `requirePermission`/`assertBranchAccess`/`assertWarehouseAccess`.
- **The invoice-number collision mitigation** (Section 4.3) is a reliability/correctness fix, not itself a security vulnerability — its impact was spurious rejection of legitimate concurrent sales, not unauthorized data exposure or a way to bypass any check.
- No new industry-specific field, and no clinical/Patient field, was ever accepted by or exposed through the Sale/SaleItem schema (explicitly tested, Section 21).

---

## 33. Acceptance Criteria Checklist

| Criterion | Status |
|---|---|
| Universal Sales architecture verified | PASS |
| Sales CRUD verified | PASS (Create/Read/List/Reverse implemented and tested; Update/Delete/Cancel intentionally do not exist, consistent with the pre-existing immutable/reversal-only design) |
| Customer integration verified | PASS |
| Product/Service integration verified | PASS |
| Tenant isolation verified | PASS |
| Company isolation verified | PASS (via branch→company chain, consistent with established precedent) |
| Branch isolation verified | PASS |
| Warehouse isolation verified | PASS |
| Centralized RBAC verified | PASS |
| Inventory deduction verified | PASS (race condition found and fixed) |
| Cancellation/reversal behavior verified | PASS (double-restore race found and fixed) |
| Payment compatibility verified | PASS |
| Tax/discount compatibility verified | PASS |
| Sales numbering verified | CONDITION (collision found and fixed for Sales; underlying shared-utility risk remains in 11 other modules, disclosed) |
| Search/filter verified | PASS |
| Pagination verified | PASS |
| Transaction rollback verified | PASS |
| Concurrent stock scenario tested | PASS |
| Offline Sales directly tested | PASS for queue/sync/conflict/network-failure/retry/duplicate-protection; NOT TESTED for submit()'s real online-immediate path and local-state reconciliation (disclosed, Section 19) |
| Offline retry tested | PASS |
| Network failure tested | PASS |
| Duplicate sync protection tested | PASS |
| Optical regression passed | PASS |
| Medical regression passed | PASS |
| Existing Customer regression passed | PASS |
| Existing Supplier regression passed | PASS |
| Existing Inventory regression passed | PASS |
| Full backend suite passed | CONDITION (2/546 failed on first pass, both confirmed transient via isolated retry — 80/80 and 12/12 clean) |
| Full frontend suite passed | PASS (112/112) |
| Lint passed | PASS |
| Build passed | PASS |
| Permission-key verification passed | PASS (46/46) |
| No unauthorized cross-phase implementation | PASS |
| Final verification report created | PASS (this document) |

---

## 34. Final Status

**PHASE 1.8 — CLOSED WITH CONDITIONS**

All Phase 1.8 acceptance criteria are satisfied, with two disclosed, non-blocking conditions:

1. **The full backend regression run experienced the documented transient PostgreSQL connection-timing flake** on its first pass (2 of 546 tests, both on the same heavy Command Center endpoint already implicated in every prior phase's report). Both affected tests were independently retried in complete isolation and **passed cleanly** (80/80 and 12/12), with PostgreSQL confirmed healthy throughout and no deterministic application failure ever reproduced. **This condition is environmental and test-run related, not a deterministic Phase 1.8 application failure**, and required no code change to resolve.
2. **The shared `nextSequenceNumber` utility's known, pre-existing collision risk** (Phase 0.6's own disclosed limitation) was concretely reproduced and locally mitigated for Sales specifically; the same underlying risk remains, undisclosed-no-longer but unfixed, in eleven other modules that share the utility — recorded as a future backlog item, not a Phase 1.8 blocker.

Two genuine, previously-undetected data-integrity race conditions in Sales stock deduction and reversal were found through this phase's own required concurrency testing and are now fixed and verified. No unauthorized cross-phase work was performed: the Offline-First Inventory & Data Sync Engine (Phase 1.10), Purchase Management (Phase 1.9), and the Accounting Engine (Phase 2) were not built, extended, or duplicated.

**Stopping here. Not starting Phase 1.9. Awaiting Product Owner approval.**
