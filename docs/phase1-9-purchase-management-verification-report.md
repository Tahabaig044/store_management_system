# PHASE 1.9 — PURCHASE MANAGEMENT: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-21
**Scope:** Purchase Management (Purchase Request → RFQ → Purchase Order → Goods Receipt → Purchase/Supplier Bill → Payment), building directly on Phase 1.8's discovery that Sales had genuine stock/reversal concurrency bugs.
**Test database:** local, throwaway Postgres (`akvisionflow_phase19`) via the portable Postgres instance at `D:\pgsql-portable`. No production database was touched.

---

## 1. Executive Summary

Phase 1.9 audited the complete existing procurement architecture (Purchase Request, RFQ, Purchase Order, Goods Receipt, and the direct Purchase model) before making any change, per the explicit instruction to verify — not assume — that Phase 0.1/0.3's branch-scope fixes remained intact. The audit found the same *class* of concurrency bug Phase 1.8 fixed for Sales (a "read current value → compute new value → blind SET" pattern) present in **four independent places** on the Purchase/GRN side, plus a genuine, previously-undetected RBAC gap (the entire RFQ module bypassed the centralized Phase 0.4 permission catalog), plus a **reproducible purchase-numbering collision** in the shared `nextSequenceNumber` utility, directly mirroring the Phase 1.8 Sales finding. All of these were fixed. Additive schema fields (`warehouseId` on Purchase/PurchaseOrder/PurchaseRequest/GoodsReceipt, `notes` on Purchase, `variantId` on PurchaseItem) were added, mirroring Sale's Phase 1.8 design exactly. 23 new backend tests were written, all 17 pre-existing procurement tests still pass unmodified, and the full regression suite (backend 569 tests, frontend 116 tests) passed except for the same documented transient PostgreSQL flake seen in Phase 1.8, which was diagnosed per the established protocol and confirmed non-deterministic/environmental, not a Phase 1.9 defect.

**Overall result: PHASE 1.9 — CLOSED WITH CONDITIONS.** See Section 39 for the exact justification.

---

## 2. Scope

In scope: Purchase Request, RFQ/Supplier Quotation, Purchase Order, Goods Receipt (GRN), and the direct Purchase model — their CRUD, status lifecycles, branch/warehouse/company/tenant authorization, concurrency safety, numbering safety, RBAC, search/filter/pagination, offline architecture (as it already exists), and regression against Optical/Medical/Supplier/Sales/Inventory/Accounting.

Explicitly out of scope (per the task's Scope Control section) and NOT implemented: the full Accounting/AP engine, Chart of Accounts, bank reconciliation, financial statements, a general-purpose Tax Engine, a rewritten shared sequence-numbering utility, a new offline sync engine, the Phase 1.10 Inventory Engine, and every other Phase 1.10–Phase 10 item named in the task. Where a cross-phase issue was discovered (the shared numbering utility's broader architectural gap), it is documented in Section 36 and deferred, not silently fixed at the root.

---

## 3. Existing Purchase/Procurement Architecture Audit

Read in full before any change: `purchaseRequests.routes.js` (144 lines), `rfqs.routes.js` (227 lines), `purchaseOrders.routes.js` (178 lines), `goodsReceipts.routes.js` (245 lines), `purchases.routes.js` (336 lines), `purchaseService.js` (135 lines), the relevant Prisma models (`PurchaseRequest`, `PurchaseRequestItem`, `RFQ`, `RFQItem`, `RFQSupplier`, `SupplierQuotation`, `SupplierQuotationItem`, `PurchaseOrder`, `PurchaseOrderItem`, `GoodsReceipt`, `GoodsReceiptItem`, `Purchase`, `PurchaseItem`), and `permissionCatalog.js`.

Findings confirmed the Phase 0.3 branch-scope fixes are intact: `assertBranchAccess`/`branchScopeWhere` are correctly applied on Purchase Request, Purchase Order, and Purchase read/write paths, and GRN correctly derives its branch scope from its linked Purchase Order. Nothing here was assumed correct merely because it previously existed — each authorization call site was individually re-verified against a live test (Section 9).

Two genuine defects were found during this read-only audit, before any test was run:

1. **RFQ RBAC gap**: `rfqs.routes.js` gated every route via a single router-level `requireRole(...INVENTORY_STAFF)` (with quotation-selection additionally gated by `requireRole(...MANAGEMENT)`). A targeted grep of `permissionCatalog.js` confirmed no `RFQ` resource existed in the centralized Phase 0.4 catalog at all — the only procurement module never migrated.
2. **Concurrency bug class** (same pattern Phase 1.8 fixed for Sales) present in: `purchaseService.js`'s shared `receivePurchaseStock` (used by both the immediate-receive-on-create path and the deferred `/receive` endpoint), `goodsReceipts.routes.js`'s `PurchaseOrderItem.receivedQuantity` update (the actual over-receiving guard, silently broken under concurrency), `goodsReceipts.routes.js`'s own `Product.stockQuantity` increment, and `purchases.routes.js`'s `/:id/return` endpoint (both a stock-decrement race and a double-return-status race). `purchases.routes.js`'s `/:id/pay` had an additional, distinct blind `amountPaid` accumulation race. `purchaseOrders.routes.js`'s `/:id/cancel`, `/:id/approve`, and `purchaseRequests.routes.js`'s `/:id/approve`/`/:id/reject`/`/:id/cancel` were all un-transacted check-then-blind-write status transitions with no atomic guard.

---

## 4. Backend Changes

- `backend/src/constants/permissionCatalog.js` — added the `RFQ` resource (`VIEW`/`CREATE`/`UPDATE`, role `INVENTORY_STAFF`), following the existing pattern of every other procurement resource.
- `backend/src/modules/procurement/rfqs.routes.js` — migrated list/detail/create/quotation-entry/compare from the router-level legacy `requireRole(...INVENTORY_STAFF)` to per-route `requirePermission('RFQ', ...)`. Quotation *selection* (`/:id/quotations/:quotationId/select`) deliberately kept on its existing `requireRole(...MANAGEMENT)` gate, consistent with the already-accepted incremental-migration precedent used elsewhere (e.g. PurchaseOrder's own `reject`/`cancel`).
- `backend/src/modules/purchases/purchaseService.js` — `receivePurchaseStock` now uses an atomic `{ increment }` for `Product.stockQuantity` instead of a blind read-then-SET. Fixes both call sites (immediate-receive-on-create and deferred `/receive`) with one change.
- `backend/src/modules/procurement/goodsReceipts.routes.js` — (a) the per-line over-receiving guard is now an atomic, transaction-scoped `updateMany` on `PurchaseOrderItem.receivedQuantity` guarded by `lte: quantity - totalThisLine`, checked via `count === 0`; (b) `Product.stockQuantity` now uses `{ increment }`; (c) the PO status rollup (`PARTIALLY_RECEIVED`/`RECEIVED`) is now a guarded `updateMany` restricted to `status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] }`, so a GRN can no longer resurrect a cancelled PO's status; (d) added optional `warehouseId` (validated via `assertWarehouseAccess`, falling back to the linked PO's own `warehouseId`).
- `backend/src/modules/purchases/purchases.routes.js` — (a) `/:id/return` now atomically guards both the status flip (`updateMany` on `status: 'RECEIVED'`) and the stock decrement (`updateMany` with a `gte` guard, mirroring Sale's create-time deduction guard); (b) `/:id/pay` now atomically guards the `amountPaid` accumulation via a computed `lte` threshold; (c) the create endpoint gained `warehouseId`/`notes` (Purchase) and `variantId` (PurchaseItem), all validated the same way Sale's Phase 1.8 fields were; (d) the create endpoint's `purchaseNumber` generation is now wrapped in a bounded retry loop (see Section 21); (e) `GET /` gained `paymentStatus`/`supplierId`/`branchId`/`warehouseId` filters.
- `backend/src/modules/procurement/purchaseOrders.routes.js` — `approve`/`reject`/`cancel` converted from check-then-blind-write to atomic guarded `updateMany` status transitions; `approve`/`reject` gained the previously-missing `assertBranchAccess` call (defense-in-depth, matching `cancel`'s existing behavior); create endpoint gained `warehouseId`.
- `backend/src/modules/procurement/purchaseRequests.routes.js` — same atomic-transition treatment for `approve`/`reject`/`cancel`, same `assertBranchAccess` addition to `approve`/`reject`; create endpoint gained `warehouseId`.

No changes were made to `purchaseOrders.routes.js`'s or `purchaseRequests.routes.js`'s `reject` legacy `requireRole(...MANAGEMENT)` gate, and no changes were made to the shared `nextSequenceNumber` utility itself (see Section 21).

---

## 5. Frontend Changes

`frontend/src/pages/purchases/Purchases.jsx` and `frontend/src/pages/procurement/Procurement.jsx` were read in full. Both were confirmed already industry-neutral (no Optical/Medical/frame/lens/prescription fields anywhere in either file). Per the same precedent set in Phase 1.8 (Pos.jsx was deliberately left unmodified), neither primary transactional-creation form was modified to add a `warehouseId` selector — the backend fully supports it via the API, but no UI gap rose to the level of a defect requiring a fix, and RFQ already has a disclosed, pre-existing "no screen yet" comment in `Procurement.jsx` that Phase 1.9 does not attempt to close (out of scope — a UI build-out, not a Purchase Management correctness issue).

`frontend/src/offline/syncEngine.test.js` was extended with 4 new tests directly verifying the pre-existing `OUTBOXES.purchases` outbox (queue/sync/conflict/network-failure), mirroring the Phase 1.7 pattern used for the Supplier outbox. No frontend production code was changed.

---

## 6. Database Changes

One additive migration, `20260921020000_phase1_9_purchase_management`, generated via the established non-interactive `prisma migrate diff --script` workflow and verified to apply cleanly on top of the full existing migration history against a fresh scratch database before being copied into the real project:

```sql
ALTER TABLE "goods_receipts" ADD COLUMN "warehouseId" TEXT;
ALTER TABLE "purchase_items" ADD COLUMN "variantId" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "warehouseId" TEXT;
ALTER TABLE "purchase_requests" ADD COLUMN "warehouseId" TEXT;
ALTER TABLE "purchases" ADD COLUMN "notes" TEXT, ADD COLUMN "warehouseId" TEXT;
-- + 5 corresponding foreign keys (all ON DELETE SET NULL, nullable/optional)
```

No column was dropped, renamed, or made non-nullable. No existing data is affected. `npx prisma validate` passed on the full schema before migration generation; `npx prisma generate` completed cleanly against the real project afterward.

---

## 7. Supplier Integration — PASS

Purchase/PurchaseOrder/PurchaseRequest/GRN all continue to reference the existing tenant-scoped `Supplier` model with no changes to the Supplier model itself. Cross-tenant supplier references are rejected (`tests/procurement.test.js`: "a PO cannot be created against another tenant's supplier"). Supplier procurement history (Section 22) reuses this same relationship, not a new one.

---

## 8. Product/Variant Integration — PASS

Purchase/PurchaseOrder/PurchaseRequest/GRN continue to reference the existing universal `Product` model (no Optical/Medicine-specific fields touched or added). `PurchaseItem.variantId` (new, optional) was added mirroring `SaleItem.variantId` exactly — validated so a variant must belong to the given product (`purchaseManagement.test.js`: "a variantId that does not belong to the given product is rejected" — 404). Deliberately not added to `PurchaseRequestItem`/`RFQItem`/`PurchaseOrderItem`/`SupplierQuotationItem`/`GoodsReceiptItem` — the task's "Purchase Line" field list maps to the final transactional Purchase/PurchaseItem record, the same role Sale/SaleItem played in Phase 1.8, not every earlier-stage procurement document.

---

## 9. Tenant/Company/Branch/Warehouse Isolation — PASS

Directly tested, not assumed:
- Tenant isolation: a purchase, a GRN, a purchase request/RFQ/PO created under Tenant A all return 404 (not 403 — existence itself is hidden) to Tenant B, both for direct `GET`s and in list results (`procurement.test.js`, `purchaseManagement.test.js`).
- Branch isolation: `assertBranchAccess` is enforced on Purchase/PurchaseOrder/PurchaseRequest reads and writes; a STORE_KEEPER restricted to one branch cannot create a purchase or PO attributed to another branch's warehouse (`purchaseManagement.test.js`: "a STORE_KEEPER restricted to one branch cannot create a purchase attributed to a warehouse in another branch" — 403).
- Warehouse isolation (new in Phase 1.9): a `warehouseId` belonging to another tenant is rejected with 404 on both direct Purchase and PurchaseOrder create; GRN's `warehouseId` (falling back to its PO's) is validated the same way.
- Company-scope: unaffected by Phase 1.9 (no changes to the Company/multi-company access layer); Phase 0.4's existing company-scope tests (`permissionsArchitecture.test.js`) continue to pass unmodified (33/33).

---

## 10. RBAC/Permissions — PASS

The RFQ gap identified in Section 3 was closed (Section 4). Verified directly:
- A STORE_KEEPER (`INVENTORY_STAFF`) can list/create RFQs and submit quotations via the new `RFQ` permission, not a hardcoded role check.
- A CASHIER (not `INVENTORY_STAFF`) is blocked (403) from both listing and creating RFQs.
- Quotation selection remains MANAGEMENT-only (403 for a STORE_KEEPER), unchanged.
- All pre-existing PURCHASE/PURCHASE_REQUEST/PURCHASE_ORDER/GOODS_RECEIPT permission behavior (already centralized before Phase 1.9) continues to pass unmodified — confirmed by the full `permissionsArchitecture.test.js` suite (33/33, including its dedicated "PURCHASE" and "PURCHASE_REQUEST" condition-closure cases).
- `approve`/`reject` on both PurchaseOrder and PurchaseRequest gained the previously-missing `assertBranchAccess` defense-in-depth call.

---

## 11. Purchase Request — PASS

CRUD, approval, rejection, and cancellation all re-verified against a live test database. Status transitions (`PENDING_APPROVAL` → `APPROVED`/`REJECTED`/`CANCELLED`) are now atomic guarded transitions (Section 4), closing a genuine double-approve/double-reject/double-cancel race that existed before Phase 1.9 (not previously tested). `warehouseId` added and validated. All 3 pre-existing Purchase Request tests in `procurement.test.js` pass unmodified.

---

## 12. RFQ and Supplier Quotations — PASS

RFQ creation, supplier invitation, quotation entry (including the "supplier not invited" rejection), side-by-side comparison with lowest-price/fastest-delivery recommendation, and quotation selection (closing the RFQ, rejecting other quotations, creating the resulting PO) all re-verified — all 5 pre-existing RFQ tests in `procurement.test.js` pass unmodified, plus 3 new tests specifically verifying the RBAC migration (Section 10). RFQ never crosses tenant/company/branch boundaries (unchanged; each read/write is tenant-scoped as before).

---

## 13. Purchase Order Lifecycle & Status Transitions — PASS (bugs found and fixed)

CRUD, supplier/branch/warehouse linkage, and the approval-threshold auto-approve/require-approval logic all re-verified (2 pre-existing threshold tests pass unmodified). Invalid transitions are correctly rejected: receiving against a `CANCELLED` PO returns 409 (`purchaseManagement.test.js`: "cannot receive against a CANCELLED purchase order"); receiving against a still-`PENDING_APPROVAL` PO returns 409 (pre-existing test, still passes). The genuine `approve`/`reject`/`cancel` concurrency bugs found in Section 3 are fixed and directly verified under a real race (Section 17).

---

## 14. Goods Receipt (GRN) & Inventory Integration — PASS (critical bugs found and fixed)

This is where Phase 1.9's most significant findings live. Before this phase, GRN creation validated over-receiving with a pre-check read *outside* the transaction and then applied a blind `receivedQuantity` SET *inside* the transaction using the same stale read — a lost-update race identical in shape to Phase 1.8's Sale stock-overselling bug. The same blind-SET pattern existed separately for `Product.stockQuantity`. Both are now atomic (Section 4) and directly verified under real concurrent HTTP requests (Section 17), not simulated.

Inventory integration itself: a GRN increases stock and records an `InventoryTransaction` (`type: 'PURCHASE_RECEIVE'`) transactionally — no partial stock update and no partially-finalized GRN on failure (the whole GRN, including its auto-generated Purchase/supplier-invoice record and journal entry, lives in one `prisma.$transaction`). Rejected/damaged quantities correctly never enter stock or cost (pre-existing test, still passes). GRN correctly references its PO, and now also its warehouse (Section 9). The GRN's idempotency-key deduplication (pre-existing) continues to work unmodified.

Per the task's explicit instruction, the complete Phase 1.10 Inventory Engine was NOT built — GRN continues to use the existing `Product.stockQuantity`/`InventoryTransaction` primitives exactly as before, now made concurrency-safe rather than replaced.

---

## 15. Partial Receiving (Ordered/Received/Remaining) — PASS

Directly tested per the task's explicit example: a PO for 100 units, received via two separate GRNs of 40 then 60, correctly tracks Ordered=100 throughout, Received=40 then 100, Remaining=60 then 0, and the PO status transitions `APPROVED` → `PARTIALLY_RECEIVED` → `RECEIVED` (`purchaseManagement.test.js`: "PO qty=100: first GRN receives 40, second GRN receives 60 -> Ordered=100, Received=100, Remaining=0"). A third, over-receiving GRN attempt against an already-fully-received line is rejected (pre-existing test, still passes). Received can never exceed Ordered under sequential use; Section 17 additionally proves this holds under concurrent use.

---

## 16. Transaction/Rollback Safety — PASS

GRN creation, direct Purchase creation, `/return`, and `/pay` are each wrapped in a single `prisma.$transaction` — an error at any point (a nonexistent product, an over-receiving attempt, an insufficient-stock return) rolls back everything in that request, including any stock/PO-item/journal changes already applied earlier in the same transaction. This was true before Phase 1.9 for the transaction boundaries themselves; what Phase 1.9 fixed was *what happens inside* those boundaries (the blind-write races), not the boundaries.

---

## 17. Purchase Concurrency Testing — PASS (multiple real bugs found and fixed)

Following Phase 1.8's methodology exactly: real concurrent HTTP requests via `Promise.all` against a real Express app and real Postgres transactions, not simulated. All of the following are new tests in `purchaseManagement.test.js`, all passing after the fixes in Section 4:

- **The task's named example, verified exactly**: PO qty=100, Terminal A receives 70, Terminal B receives 50 simultaneously → exactly one request succeeds (201), the other is cleanly rejected (409); final `receivedQuantity` is never > 100; stock reflects exactly the winning GRN's quantity, never both.
- The complementary "sum fits" case: two simultaneous GRNs of 40 and 60 against the same 100-unit line → both succeed, final received is exactly 100, stock reflects both increments (none lost).
- A concurrent double-approve of the same pending PO → exactly one wins (200/409).
- A concurrent cancel racing a concurrent receive on the same PO → the two outcomes are mutually exclusive and internally consistent (either the PO ends CANCELLED and the GRN did not silently apply stock, or the GRN succeeded and the PO is fully, correctly RECEIVED) — never a corrupted middle state.
- A concurrent double-return of the same purchase → exactly one wins, stock is reversed exactly once (not zero, not twice).
- Two concurrent payments whose sum would exceed the purchase total → exactly one is accepted; a sum that fits → both are accepted and sum correctly.

All of these failure modes were confirmed to exist (via direct code reading, then via the fixes' absence causing failures before the fix was applied during development) before being fixed — this is not a defensive test suite written against already-correct code.

---

## 18. Purchase Return/Reversal — PASS (bugs found and fixed)

`/:id/return` reverses stock (with the existing `allowNegativeStock` setting respected) and mirrors the original journal entry, exactly as before. The two genuine bugs found in Section 3 (blind stock decrement, unguarded double-return status race) are fixed via the same atomic-conditional-update pattern used for Sale's stock deduction and reversal guard in Phase 1.8. `accounting.test.js`'s pre-existing "a purchase return reverses stock and posts a mirrored entry" and "purchase return is restricted to MANAGEMENT roles" tests both pass unmodified (verified via isolated retry, Section 35).

---

## 19. Purchase Payments & Payments Compatibility — PASS (bug found and fixed; broader engine verification only)

`/:id/pay`'s blind `amountPaid` read-then-write race (Section 3) is fixed via an atomic conditional `updateMany`. Directly verified under concurrency (Section 17). The broader `Payment` model and its accounting-journal integration (advance payments, receipt-time payment, Accounts Payable clearing) are unchanged and re-verified via the existing `accounting.test.js` suite (27/27 via isolated retry) — no GL/AP engine was built or modified, per the explicit scope instruction.

---

## 20. Tax/Discount Compatibility — PASS (verification only)

Purchase/PurchaseOrder/GRN continue to use the existing per-line/header discount and tax fields exactly as before; GRN's discount/tax proration logic (splitting a PO's header discount/tax across partial GRNs by cost share) was read and is unchanged. No general-purpose Tax Engine was built, per the explicit scope instruction.

---

## 21. Purchase Numbering — CONDITION

Per the task's explicit instruction to audit Purchase numbering for the same collision class Phase 1.8 found in Sales: a standalone concurrency probe (15 simultaneous `POST /purchases` requests for the same tenant, mirroring Phase 1.8's `debug-race.js` methodology) reproduced a **real, deterministic collision** in the shared `nextSequenceNumber` utility — 10 of 15 concurrent creates failed with a clean 409 "already exists" (a `purchaseNumber` unique-constraint violation, not a genuine business conflict).

Per the task's explicit instruction ("do NOT silently rewrite the entire utility... if a safe Purchase-specific mitigation is necessary and within scope, implement it"), the Purchase create endpoint's transaction was wrapped in the same bounded retry loop Phase 1.8 used for Sale's `invoiceNumber` (`MAX_PURCHASE_NUMBER_RETRIES = 5`, retrying only on a P2002 targeting `purchaseNumber`). After this fix:
- At realistic concurrency (3 simultaneous requests, 10 independent trials = 30 requests): **0 failures**.
- At the original extreme-stress level (15 simultaneous requests): failures dropped from 10/15 to 2/15 — a bounded retry is a probabilistic mitigation, not a mathematical guarantee, and this residual is disclosed rather than hidden.

The shared `nextSequenceNumber` utility itself was **not** modified — this fix is local to Purchase's own create endpoint, exactly mirroring the Sale precedent. The utility's broader architectural issue (used unchanged by 10+ other modules: PurchaseOrder, PurchaseRequest, RFQ, GoodsReceipt, StockTransfer, OpticalOrder, Patient, JournalEntry, and others) remains and is carried forward as a documented, deferred cross-cutting concern (Section 36) — not silently fixed. PurchaseOrder's and GoodsReceipt's own `nextSequenceNumber` calls (`PO-`, `GRN-` prefixes) were not separately load-tested in this phase; they share the identical underlying risk and are named explicitly in Section 36 so this is not concealed.

This is the primary reason Phase 1.9 closes **WITH CONDITIONS** rather than cleanly (see Section 39).

---

## 22. Supplier + Procurement History — PASS

Suppliers continue to be retrievable with their purchase/PO/GRN history via the existing tenant-scoped relations (unchanged from before Phase 1.9) — no new Accounts Payable ledger, aging report, or outstanding-balance engine was built, per the explicit scope instruction. `Purchase.amountPaid`/`paymentStatus` continue to serve as the existing, sufficient signal for "outstanding amount" at the individual-purchase level.

---

## 23. Search/Filtering/Pagination — PASS

`GET /purchases` gained `paymentStatus`, `supplierId`, `branchId` (access-checked), and `warehouseId` (access-checked) filters, mirroring Sale's Phase 1.8 filter set and reusing the existing shared `parsePagination` utility (no duplication). Directly tested (`purchaseManagement.test.js`: "filters /api/purchases by supplierId and paymentStatus").

---

## 24. Offline-First Purchase Architecture — PASS (inspected, verified, not rewritten)

`frontend/src/offline/syncEngine.js` was re-read directly in this phase (not assumed from memory). Confirmed: `OUTBOXES.purchases` already exists, built on the shared `createOutbox` factory, posting to `/purchases` with an `applyOptimisticEffect` (`incrementCachedStockIfReceiving`) that only bumps the cached product stock when the queued payload has `receiveImmediately: true`. This is the ONLY offline-capable procurement entry point — **PurchaseOrder and GoodsReceipt have no offline outbox at all**; creating/receiving against a PO requires a live connection. This gap is documented here rather than glossed over.

---

## 25. Direct Offline Purchase Tests

4 new tests were added directly against `OUTBOXES.purchases` (not inferred from the Sales outbox, per the explicit instruction), mirroring the Phase 1.7 Supplier-outbox pattern: queuing with a client-generated idempotency key, a full sync round-trip storing the new `warehouseId`/`notes` fields, a 409-numbering-collision being marked `conflict` (not `failed`, and never auto-resolved), and a network error leaving the item `pending` for retry. Combined with the pre-existing `applyOptimisticEffect` test ("purchases only increment cached stock when receiveImmediately is true"), `syncEngine.test.js` now has 5 Purchase-specific tests plus full coverage of the generic `createOutbox` behaviors (queue/sync/conflict/retry/discard/syncAll) that `purchases` shares by construction with every other entity built on the same factory. Full file: 26/26 passing.

---

## 26. Offline Stock Safety / Limitations

Per the explicit instruction not to claim Phase 1.9 solves bidirectional inventory sync (Phase 1.10's job): the optimistic cache increment applied when an offline purchase is queued with `receiveImmediately: true` is a client-side, single-device estimate only — it does not reconcile against other devices' concurrent offline changes, and a device that has been offline for a while may show stale stock until it reconnects and syncs. This limitation already existed before Phase 1.9 (it was not introduced by this phase) and is restated here explicitly rather than left implicit, per the task's instruction.

---

## 27. Optical Regression — PASS

`moduleArchitecture.test.js`'s Optical-disabled/enabled scenarios and the Optical order + clinical workflow end-to-end test are unaffected by Phase 1.9 (no shared code paths were touched other than the universal Purchase/Product/Inventory primitives, which Optical does not depend on for its own order flow). Not independently re-run in full in this phase (no Optical-specific Purchase interaction exists to regress); covered transitively by the full backend regression (Section 30).

---

## 28. Medical Regression — PASS

Same reasoning as Section 27 — Medicine-industry Product/Sale/Purchase paths are universal, not Optical/Medical-specific, and Phase 1.9 added no industry-specific fields anywhere (directly verified: `purchaseManagement.test.js`'s "creating a purchase never accepts or requires any Optical/Medical-specific field" test explicitly posts `frameBrand`/`lensType`/`prescriptionId` on a purchase and confirms none of them are persisted or echoed back).

---

## 29. Existing Supplier/Sales/Inventory/Accounting Regression — PASS

- `supplierManagement.test.js` (Phase 1.7): full suite passes.
- `salesManagement.test.js` (Phase 1.8): full suite passes — confirms Phase 1.8's Sale-side fixes remain intact and unaffected by Phase 1.9's changes.
- `accounting.test.js`: full suite passes (via isolated retry, Section 35) — confirms Purchase/GRN's journal-posting behavior (immediate receipt, deferred receipt, advance payment, return reversal) is unaffected.
- `procurement.test.js` (pre-existing, Phase 5): all 17 tests pass unmodified, confirming the Phase 1.9 fixes are additive/behavior-preserving for every already-correct scenario.

---

## 30. Full Backend Regression

**Full regression initial result:** 27 test suites run, 25 passed, 2 failed; 569 tests total, 567 passed, 2 failed. Both failures were `Can't reach database server at 127.0.0.1:5432` errors surfacing through unrelated endpoints (`tests/ai.test.js`'s `/api/ai/assistant/ask` test, and `tests/accounting.test.js`'s Command Center integration test) — the same documented transient connection-pool/timing flake observed in every phase since 0.2 and explicitly called out in Phase 1.8's report. See Section 35 for the isolated diagnostic retry and Section 39 for how this is interpreted.

---

## 31. Full Frontend Regression — PASS

`npx vitest run` (full suite, all files): **29 test files passed, 116 tests passed, 0 failed.** Includes the newly-extended `syncEngine.test.js` (26/26) and the pre-existing `Procurement.test.jsx` (2/2), unmodified.

---

## 32. Lint — PASS

`npm run lint` (oxlint, frontend): exit code 0. All output is pre-existing warnings (`react(set-state-in-effect)`, `react(only-export-components)`, one `react-hooks(exhaustive-deps)`) already present across the majority of the codebase's list pages before Phase 1.9, including `Purchases.jsx` itself and `Procurement.jsx` (3 occurrences) — none newly introduced by this phase, since no frontend production code was modified. The backend has no configured lint script (consistent with every prior phase's reports).

---

## 33. Build — PASS

`npm run build` (frontend, `vite build`): succeeded in 2.60s, producing `dist/index.html`, `dist/assets/index-*.css` (236.80 kB), `dist/assets/index-*.js` (732.23 kB). The only warning is the pre-existing "chunk larger than 500kB" advisory, unrelated to and unaffected by Phase 1.9.

---

## 34. Permission-Key Verification — PASS

`tests/permissionsArchitecture.test.js`: **33/33 passed**, including its "TENANT_ADMIN can list the full permission catalog" test (confirming the new `RFQ` resource is correctly seeded and surfaced) and all pre-existing PURCHASE/PURCHASE_REQUEST condition-closure cases, unmodified. `npm run seed:permissions` was re-run against the fresh Phase 1.9 test database before any test executed, confirming the new `RFQ` permission grants seed correctly (88 permissions, 286 role-permission grants ensured — up from the pre-Phase-1.9 catalog by exactly the 3 new RFQ actions × their role grants).

---

## 35. Transient Regression Flake Diagnostic

Following the exact protocol established and mandated in Phase 1.8:

1. **Recorded exact failures** (Section 30): `tests/ai.test.js` — "a conversation created in tenant A is invisible to tenant B" (expected 201, got 500); `tests/accounting.test.js` — "cashBalance/bankBalance reflect actual ledger activity..." (`TypeError: Cannot read properties of undefined (reading 'cashBalance')`, downstream of the same underlying `Can't reach database server` error on the Command Center endpoint).
2. **Postgres health confirmed** before retrying: `pg_ctl status` → server running, no restart needed.
3. **No code, schema, migration, test, or configuration changes were made between the full-suite failure and the isolated retries.**
4. **Isolated retry, `tests/ai.test.js` alone:** 23/23 passed.
5. **Isolated retry, `tests/accounting.test.js` alone:** 27/27 passed, including the exact test that failed in the full run.

Both isolated retries reproduced zero failures. This matches the previously documented transient local-Postgres connection-timing flake under full-suite load (same signature: `Can't reach database server`, same class of heavy dashboard-aggregation endpoint, same non-reproducibility in isolation) seen in Phase 1.8 and every phase since 0.2. **This is not concealed**: the full-suite run did fail 2/569, and that fact is stated plainly in Section 30 rather than omitted.

---

## 36. Known Limitations

- **Shared `nextSequenceNumber` utility** (Phase 0.6): still generates numbers from a plain per-tenant row count, still not guaranteed gap-free or collision-free under concurrent creates. Phase 1.9 added a local, bounded (5-retry) mitigation to Purchase's own create endpoint only (Section 21), mirroring Sale's Phase 1.8 fix. `PurchaseOrder`, `PurchaseRequest`, `RFQ`, and `GoodsReceipt` still call the shared utility directly with no retry wrapper — they were not independently load-tested for this collision in this phase, and share the identical underlying risk. A full fix (e.g., a database sequence or an atomic upsert-based counter) would need to touch the one shared utility used by 12+ modules and is explicitly deferred, as instructed.
- **Purchase-numbering retry is probabilistic, not absolute**: at extreme concurrency (15 simultaneous creates for one tenant) 2/15 still failed after the fix; at realistic concurrency (3 simultaneous, repeated) it was 0/30. This is disclosed, not hidden.
- **No offline outbox for PurchaseOrder or GoodsReceipt** — only direct Purchase creation is offline-capable (Section 24). Receiving against a PO, approving a PO, or creating an RFQ all require connectivity.
- **The GRN → PO status rollup is a narrow, disclosed best-effort guard**, not perfectly linearizable against a second concurrent GRN touching *other* lines of the same PO (Section 4) — it prevents a cancelled PO from being resurrected, but two GRNs racing on different lines of the same multi-line PO could each compute the aggregate `fullyReceived` flag from a slightly stale read of the other's line. The per-line received-quantity guarantee (the actual over-receiving protection) is unaffected by this; only the PO's own status *label* has this narrow residual risk.
- **The legacy Product Optical/Medicine dual-write architecture** (flagged in Phase 1.4/1.5 as an accepted future backlog item) was not touched, per the explicit instruction reaffirmed for this phase.
- **RFQ has no dedicated frontend screen** — a pre-existing, disclosed gap (`Procurement.jsx`'s own code comment), not created or worsened by Phase 1.9, and not closed by it either (out of scope: a UI build-out, not a correctness fix).
- **No Accounts Payable/GL/Chart-of-Accounts/bank-reconciliation/financial-statements/Tax Engine was built** — by explicit design (Phase 2 scope).

---

## 37. Security Review

- Every new/modified route continues to sit behind `authenticate` + `requireTenant`, and either `requirePermission` (centralized, now including the newly-migrated RFQ) or an already-accepted legacy `requireRole` for the small set of not-yet-migrated actions (unchanged from before this phase).
- Every new `warehouseId` input is validated server-side via `assertWarehouseAccess` — never trusted from the client, and never enforced only in the UI. Directly tested: a warehouse belonging to another tenant is rejected (404); a warehouse outside a restricted user's branch is rejected (403).
- No new endpoint accepts a client-supplied `tenantId`, `receivedQuantity` override, or `status` field that could bypass the atomic guards added in this phase.
- All new atomic-update guards use `count === 0` (never a stale in-memory boolean) as the sole authoritative success/failure signal, consistent with the Phase 1.8 pattern.
- No secrets, credentials, or production connection strings were introduced or logged.

---

## 38. Acceptance Criteria Checklist

| # | Criterion | Result |
|---|---|---|
| 1 | Existing procurement architecture audited before any change | PASS |
| 2 | Phase 0.3 branch-scope fixes verified intact, not assumed | PASS |
| 3 | No duplication of Purchase Request/RFQ/PO/GRN architecture | PASS |
| 4 | Universal Purchase Lifecycle supported; direct purchase still possible | PASS |
| 5 | Full Accounting/AP engine NOT built | PASS (deferred, Phase 2) |
| 6 | Purchase Header/Line fields match the requested shape (additive) | PASS |
| 7 | No frame/lens/prescription/medicine-only fields on Universal Purchase | PASS |
| 8 | Tenant isolation (cannot view another tenant's purchase) | PASS |
| 9 | Company isolation | PASS (unchanged, re-verified) |
| 10 | Branch isolation (cannot create/view across branches) | PASS |
| 11 | Warehouse isolation (cannot receive into unauthorized warehouse) | PASS |
| 12 | Backend authorization mandatory, not frontend-only | PASS |
| 13 | PO CRUD, status transitions, invalid-transition rejection | PASS |
| 14 | Partial receiving: Ordered/Received/Remaining tracked correctly | PASS |
| 15 | Multiple GRNs against the same PO tracked correctly | PASS |
| 16 | Received never exceeds Ordered (sequential) | PASS |
| 17 | Received never exceeds Ordered (concurrent, named 70+50 example) | PASS (bug found and fixed) |
| 18 | GRN validates quantities, references supplier/PO/branch/warehouse | PASS |
| 19 | GRN updates inventory transactionally, no partial state on failure | PASS |
| 20 | GRN creates stock movement, maintains audit trail | PASS |
| 21 | Inventory increase/restore correct, atomic, no cross-warehouse leakage | PASS |
| 22 | Concurrent receiving (named example) does not over-finalize | PASS (bug found and fixed) |
| 23 | Concurrent cancellation/reversal tested | PASS |
| 24 | Purchase numbering audited for collision/race safety | CONDITION (found, locally mitigated, shared utility issue deferred) |
| 25 | Purchase Request functionality verified | PASS |
| 26 | RFQ never crosses tenant/company/branch boundaries | PASS |
| 27 | Supplier + procurement history retrievable; no full AP engine built | PASS |
| 28 | Payments/Tax/Discount compatibility verified, no new engine built | PASS |
| 29 | Search/Filtering/Pagination reuse shared utilities | PASS |
| 30 | RBAC uses centralized Phase 0.4 architecture exclusively | PASS (RFQ gap found and fixed) |
| 31 | Frontend inspected before modification; no hardcoded fields | PASS |
| 32 | Offline Purchase architecture inspected and directly tested | PASS |
| 33 | No offline claims made without direct testing | PASS |
| 34 | Offline stock-freshness limitations documented | PASS |
| 35 | Activity Log reused, not reinvented | PASS (unchanged) |
| 36 | Full regression executed and honestly reported | PASS |
| 37 | Transient flake diagnosed per established protocol, not concealed | PASS |
| 38 | Database safety (test-only, additive migrations) | PASS |
| 39 | Scope discipline (no Phase 1.10+ work performed) | PASS |
| 40 | Architectural discipline (reused existing services/utilities) | PASS |

---

## 39. Final Status

**PHASE 1.9 — CLOSED WITH CONDITIONS**

Justification: every explicitly-required capability was implemented, tested, and verified with real (not simulated) concurrent-request tests, including the task's two named worked examples (the 70+50-against-100 GRN over-receiving scenario and the general numbering-collision audit). Four genuine, previously-undetected concurrency bugs and one genuine RBAC gap were found and fixed, mirroring Phase 1.8's Sales findings almost exactly, and one genuine, reproducible purchase-numbering collision was found and locally mitigated (not silently rewritten at the shared-utility root, per explicit instruction).

The CONDITIONS are:
1. **Environmental**: the full backend regression suite experienced the same documented transient PostgreSQL connection-timing flake seen in Phase 1.8 (2/569 failed), and both affected tests passed cleanly on isolated retry with no code changes — this is a test-run/environment condition, not a deterministic Phase 1.9 application defect.
2. **Disclosed architectural residuals**: the shared `nextSequenceNumber` utility's broader collision risk remains unresolved outside of Purchase's own local mitigation (deferred, as instructed); the bounded numbering retry is probabilistic, not absolute, under extreme concurrency; PurchaseOrder/GoodsReceipt have no offline outbox; the GRN→PO status rollup has a narrow, disclosed non-linearizability that does not affect the core over-receiving guarantee.

None of these conditions are concealed defects — each is a directly-tested, explicitly-documented, and reasonably-scoped-out limitation consistent with the task's own instructions not to silently fix unrelated architectural issues or exceed Phase 1.9's boundaries.

---

**STOP. Phase 1.10 has not been started. No future-phase work was proactively implemented. Awaiting Product Owner approval before proceeding.**
