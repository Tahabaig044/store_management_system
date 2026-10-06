# PHASE 1.14 — QUOTATIONS & ORDERS: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-22
**Scope:** Universal Customer Quotations, Sales Orders, and their conversions (Quotation → Sales Order → Sale/Invoice); verification of the existing Purchase Request → RFQ → Purchase Order → Goods Receipt chain.
**Test database:** local, throwaway Postgres (`akvisionflow_phase114`) via the portable Postgres instance at `D:\pgsql-portable`. No production database was touched.

---

## 1. Executive Summary

Phase 1.14 began with a full audit of the existing quotation/order/procurement architecture before any code was written. The audit found that **no customer-facing Quotation or Sales Order model existed anywhere** — the only pre-existing "Quotation" was `SupplierQuotation`, a procurement-side RFQ response from a *supplier* (Phase 5), architecturally unrelated and untouched by this phase. `Sale` (the existing completed-transaction/invoice record) is not a pre-fulfillment order — it has no draft/confirmed/processing lifecycle and no quotation-to-order concept. This genuinely new capability was built additively, mirroring the exact `PurchaseRequest → RFQ → PurchaseOrder → GoodsReceipt → Purchase` conversion pattern already proven in Phase 1.9, applied to the sales side: `Quotation → SalesOrder → Sale`, each conversion a one-way, guarded status transition that creates a genuinely new row referencing its source by id, never duplicating the source's own effects.

Two new models were added — `Quotation`/`QuotationItem` and `SalesOrder`/`SalesOrderItem` — plus a `fulfilledQuantity` running-total column on `SalesOrderItem` (and a `salesOrderId`/`salesOrderItemId` traceability pair on `Sale`/`SaleItem`), following the exact atomic-conditional-update guard pattern established in Phase 1.8–1.13 to prevent over-fulfillment under concurrency — directly verified against the task's own worked example (a 100-unit order, concurrent fulfillments of 70 and 50, never exceeding 100). Neither Quotation nor SalesOrder carries a `JournalSourceType` value at all — by construction, creating either can never post a journal entry or touch stock. Only `SalesOrder`'s `POST /:id/convert` ever creates a financial/inventory effect, and it does so by creating one **ordinary** `Sale` (reusing Sale's own atomic stock-deduction and journal-posting shape line-for-line, not a parallel invoicing engine) for some or all of the order's remaining quantity — every existing Sale feature (return, reverse, pay, reporting) works on the result unchanged.

A real bug was caught by this phase's own test suite (not by inspection): the lazy auto-expiry check for a stale `SENT` quotation was originally performed *inside* the same transaction that a subsequent failed accept/reject/convert attempt would then abort — since Prisma rolls back an entire transaction on any throw, the expiry flip itself was silently undone along with it. Fixed by committing the expiry check as its own independent statement before the main transaction opens (Section 22).

Frontend work was scoped additively and is entirely new: two genuinely new pages, `Quotations.jsx` and `SalesOrders.jsx` (no prior UI for either existed), covering create/list/filter/pagination and every lifecycle action. Quotation creation was also given offline-outbox support (safe, since it has zero stock/financial effect); every lifecycle transition and both conversions remain online-only, a deliberate, disclosed decision (Section 19).

**Overall result: PHASE 1.14 — CLOSED WITH CONDITIONS.** See Section 30 for the exact justification.

---

## 2. Existing Architecture Audit

Read in full before any code was written: `schema.prisma`'s `Sale`/`SaleItem` models, the full Phase 5 procurement section (`PurchaseRequest`, `RFQ`, `SupplierQuotation`, `PurchaseOrder`, `GoodsReceipt` and their items), `backend/src/modules/procurement/{purchaseRequests,rfqs,purchaseOrders,goodsReceipts}.routes.js`, `backend/src/modules/sales/sales.routes.js`, `accounting/ledger.js`, `utils/sequenceNumber.js`, `utils/idempotency.js`, `permissionCatalog.js`, `frontend/src/offline/syncEngine.js`/`db.js`, `frontend/src/pages/procurement/Procurement.jsx`, and `docs/phase1-9-purchase-management-verification-report.md`.

Confirmed, not assumed:
- **No `Quotation` (customer-facing) or `SalesOrder`/`Order` model existed anywhere** — an exhaustive grep of `schema.prisma`, `backend/src/modules/**`, and `frontend/src/**` for these names returned matches only for the unrelated, procurement-side `SupplierQuotation`.
- **`Sale` is genuinely distinct from a Sales Order** — it is a completed-transaction/invoice record with only a `COMPLETED`/`REVERSED` status, no pre-fulfillment concept, and no existing quotation/order-conversion path. Building `SalesOrder` as a new, separate upstream model that converts into an ordinary `Sale` is additive, not duplicative.
- **The full Purchase Request → RFQ → Purchase Order → Goods Receipt → Purchase chain already exists and works** (Phase 1.9, confirmed `CLOSED WITH CONDITIONS`): `PurchaseRequest.status`/`RFQ.status` (informal string enum)/`PurchaseOrder.status` share the `ProcurementStatus` enum; `RFQ`'s `POST /:id/quotations/:quotationId/select` is the RFQ→PO conversion (copies the winning `SupplierQuotation`'s totals into a new `PurchaseOrder`, linked via `sourceQuotationId @unique`); `GoodsReceipt` is the PO→Purchase conversion, tracking `PurchaseOrderItem.receivedQuantity` for partial receiving with an atomic conditional-update guard. This is the exact precedent this phase's `Quotation`→`SalesOrder`→`Sale` chain mirrors.
- **Phase 1.9's own report discloses**: the shared `nextSequenceNumber` utility's collision risk applies unmitigated to `PurchaseRequest`/`RFQ`/`PurchaseOrder`/`GoodsReceipt` (no bounded-retry wrapper on those, unlike `Sale`/`Purchase`); no offline outbox exists for `PurchaseOrder` or `GoodsReceipt`; `PurchaseOrderItem` has no per-line tax (only `SupplierQuotationItem` does); and "RFQ has no dedicated frontend screen" (Procurement.jsx explicitly only covers Purchase Requests/Purchase Orders/Goods Receipts). None of these are this phase's scope to fix (the task explicitly says "Do NOT rebuild Phase 1.9 Purchase Management. Only fix issues that are necessary for Phase 1.14 document/order consistency") and none were found to interact with or block this phase's own new work, so none were touched.
- **The shared `nextSequenceNumber` (Phase 0.6) and `findExistingByIdempotencyKey` (idempotency) utilities** are the correct, established tools to reuse for `Quotation`/`SalesOrder` numbering and idempotency — confirmed via direct inspection of every module that already uses them, no parallel mechanism invented.
- **`PermissionAction` is a fixed Prisma enum** (`VIEW/CREATE/UPDATE/DELETE/APPROVE/REVERSE/EXPORT`) — this phase reuses `APPROVE`/`REVERSE` for lifecycle semantics (Section 18) rather than repeating Phase 1.13's discovered mistake of inventing new action names.
- **No duplicate or parallel quotation/order implementation exists anywhere else in the codebase.**

---

## 3. Quotation Architecture

`backend/src/modules/quotations/quotations.routes.js` (new module): `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/send`, `POST /:id/accept`, `POST /:id/reject`, `POST /:id/cancel`, `POST /:id/expire`, `POST /:id/convert`.

`Quotation` carries every field the task's Section 2 requires: `quotationNumber` (`QT-######` via the shared numbering utility), `customerId`, `quotationDate`, `validUntil`, `status`, `branchId`/`warehouseId` (optional, mirroring `Sale`'s identical pattern), `subtotal`/`discount`/`tax`/`total` (server-computed, never trusted from the client), `notes`, `terms` (a single free-text field, mirroring the existing lightweight `Sale.notes`/`Customer.notes` convention rather than a structured terms-template system), and `salesPersonId` (defaults to the creating user; a single "who this belongs to" field, mirroring `Sale.cashierId`'s identical role — not a separate createdBy+salesperson pair, since nothing else in the codebase tracks those as distinct). `QuotationItem` carries `productId`, optional `variantId`, `quantity`, `unitPrice`, `discount`, and — deliberately, unlike `SaleItem`/`PurchaseItem` — a per-line **`tax`** field, mirroring the existing `SupplierQuotationItem`'s identical per-line tax/discount precedent (a quotation is exactly the kind of document that needs to itemize tax per line for the customer). No Optical/Medical-specific field exists anywhere on either model, verified directly by a regression test asserting an unexpected `prescriptionId` sent to `POST /quotations` is silently ignored.

---

## 4. Quotation Lifecycle

`QuotationStatus { DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED, CANCELLED, CONVERTED }` — exactly the seven states the task named, no extra state invented. Every transition is an atomic conditional `updateMany` guarded on the expected current status, checking `result.count` as the sole authoritative signal (never a read-then-write):

- `DRAFT → SENT` (`POST /:id/send`, `QUOTATION:UPDATE`)
- `SENT → ACCEPTED` (`POST /:id/accept`, `QUOTATION:APPROVE`)
- `SENT → REJECTED` (`POST /:id/reject`, `QUOTATION:REVERSE`)
- `DRAFT|SENT → CANCELLED` (`POST /:id/cancel`, `QUOTATION:REVERSE`)
- `SENT → EXPIRED`, lazily, the moment a stale (`validUntil` passed) quotation is the target of an accept/reject/convert attempt, or explicitly via `POST /:id/expire` — there is no background job/cron anywhere in this codebase to schedule automatic expiry against, so a lazy, on-demand check is the correct, minimal mechanism, not an invented scheduler.
- `ACCEPTED → CONVERTED` (`POST /:id/convert`, Section 5)

Verified directly: `accept`/`reject`/`send`/`cancel` from an invalid starting state are all rejected with `409`; a cancelled/rejected/expired quotation cannot be converted; editing (`PATCH /:id`) is restricted to `DRAFT` and to non-financial fields only (`notes`/`terms`/`validUntil` — a `.strict()` schema rejects any attempt to change `total` or line items, returning `422`) — once sent, a quotation's pricing must stay a stable, auditable snapshot of what the customer was actually shown.

---

## 5. Quotation → Sales Order

`POST /quotations/:id/convert`, gated on `SALES_ORDER:CREATE` (the permission for the document actually being created here, not a separate `QUOTATION:CONVERT` action — mirrors the precedent Phase 1.13 established for `SalesReturn`/`PurchaseReturn` auto-issuing a linked `CreditNote`/`DebitNote` under a single `CREATE` permission).

Conversion preserves customer, items, quantities, pricing (`unitPrice`/`discount` per line), and the quotation's own aggregate `tax`/`total` exactly, and references the source quotation via `SalesOrder.sourceQuotationId` (`@unique` — a given quotation can produce at most one Sales Order at the database level, a second line of defense beyond the atomic status-flip guard). `QuotationItem`'s per-line `tax` is deliberately **not** copied onto `SalesOrderItem` (which has no per-line tax field, mirroring `PurchaseOrderItem`'s identical shape despite also following a per-line-tax-having `SupplierQuotationItem`) — the quotation's own aggregate `tax` is copied straight across instead, exactly mirroring how `PurchaseOrder.tax` is copied straight from the winning `SupplierQuotation.tax` at RFQ-selection time.

Duplicate conversion is prevented by an atomic `updateMany({where:{status:'ACCEPTED'}, data:{status:'CONVERTED'}})` guard: of two concurrent conversion requests for the same quotation, only one can ever flip the status; the other sees `count: 0` and fails cleanly with `409`, never reaching `SalesOrder` creation — verified directly with real concurrent HTTP requests, confirming exactly one `SalesOrder` row exists afterward. Idempotency-key-based retry deduplication is also supported and verified. **Partial conversion (splitting one quotation across multiple Sales Orders) is not implemented** — this is a disclosed, deliberate 1:1 design choice consistent with the identical precedent already set by `RFQ → PurchaseOrder`'s own 1:1 `sourceQuotationId @unique` conversion, not an oversight (Section 27).

---

## 6. Sales Order Architecture

`backend/src/modules/salesOrders/salesOrders.routes.js` (new module): `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/confirm`, `POST /:id/cancel`, `POST /:id/convert`.

`SalesOrder` carries every field the task's Section 5 requires: `orderNumber` (`SO-######`), `customerId`, `createdAt`/`updatedAt`, items, `subtotal`/`discount`/`tax`/`total`, `status`, `branchId`/`warehouseId`, `salesPersonId`, `notes`, and `sourceQuotationId` (nullable — a Sales Order can also be created directly, without ever going through a quotation, exactly like `PurchaseOrder` can be created directly without an RFQ). `SalesOrderStatus { DRAFT, CONFIRMED, PROCESSING, COMPLETED, CANCELLED }` — exactly the five states the task named, no extra state invented (no separate "Draft→Confirmed" approval workflow beyond the single `APPROVE`-gated confirm action, since none was asked for). `DRAFT → CONFIRMED` (`POST /:id/confirm`, `SALES_ORDER:APPROVE`) is required before any fulfillment; `CANCELLED` is reachable from `DRAFT`/`CONFIRMED`/`PROCESSING` and gated to `MANAGEMENT` (`SALES_ORDER:REVERSE`), mirroring `SALES_RETURN`/`PURCHASE_RETURN`'s identical "undoing a real commitment is a privileged action" precedent. Editing (`PATCH /:id`) is restricted to `DRAFT` only.

---

## 7. Sales Order → Sale/Invoice

`POST /sales-orders/:id/convert`, gated on `SALE:CREATE` (the permission for the document actually being created), accepts an optional `items: [{salesOrderItemId, quantity}]` array for **partial fulfillment** (omitted entirely fulfills every line's full remaining quantity — the common case) plus optional `amountPaid`/`paymentMethod`/`idempotencyKey`.

The created `Sale` is an **ordinary Sale row**, produced by re-running Sale's own exact create-transaction shape (atomic conditional stock deduction, `InventoryTransaction` recording, optional `Payment` creation, and the identical `{Dr Cash/Receivable, Cr Revenue/Tax, Dr COGS/Cr Inventory}` journal-posting logic from `sales.routes.js`) rather than calling a shared/parallel invoicing function — the same "each module builds its own transaction from shared ledger primitives" convention already used by `SalesReturn`/`PurchaseReturn`/`CreditNote`/`DebitNote` in Phase 1.13. It carries a new `salesOrderId` FK (mirrors `Purchase.purchaseOrderId`'s identical Phase 1.9 role) and each `SaleItem` carries a new `salesOrderItemId` FK for line-level traceability (mirrors `GoodsReceiptItem.purchaseOrderItemId`'s identical role, applied directly on `SaleItem` rather than via a separate intermediate "fulfillment record" model, since a Sale — unlike a GRN — already *is* the real financial/inventory event). Every existing Sale feature (return via `SalesReturn`, whole-sale reverse, `:id/pay`, every sales report) works on the resulting Sale completely unchanged, verified directly.

Preserved from the order: customer, items, quantities (of the converted portion), `unitPrice`, a proportional share of each line's `discount`, and — since `SalesOrderItem` has no per-line tax (Section 5) — a proportional share of the order's own aggregate `tax` based on the converted subtotal fraction, the exact pattern Phase 1.13 established for partial-return tax allocation, applied consistently again here.

---

## 8. Quantity Tracking

`SalesOrderItem.fulfilledQuantity` (`@default(0)`) is the running total, guarded by the identical atomic-conditional-update pattern established in Phase 1.9 (`PurchaseOrderItem.receivedQuantity`) and reused again in Phase 1.13 (`SaleItem.returnedQuantity`/`PurchaseItem.returnedQuantity`):

```js
const claim = await tx.salesOrderItem.updateMany({
  where: { id: orderItem.id, fulfilledQuantity: { lte: Number(orderItem.quantity) - line.quantity + 0.0001 } },
  data: { fulfilledQuantity: { increment: line.quantity } },
});
if (claim.count === 0) throw new ConflictError(/* ... */);
```

`ordered − fulfilled = remaining` is exposed directly on every `GET` of a Sales Order and its items, and the server never allows `fulfilled > ordered` — enforced authoritatively at the database level by this guard, not merely by an application-level pre-check (a friendly, non-authoritative pre-check runs first for the fast, common case). After each conversion, the order's own status rolls up to `PROCESSING` (some lines still remaining) or `COMPLETED` (every line fully fulfilled), guarded so the rollup only applies while the order is still in a fulfillable state — the same disclosed, narrow, best-effort, non-linearizable-against-other-lines rollup pattern already used and disclosed for `GoodsReceipt`'s identical `PurchaseOrder` status rollup in Phase 1.9.

---

## 9. Purchase Request/RFQ/PO Verification

Not rebuilt, not modified. Verified via the full regression run (Section 24): `purchaseManagement.test.js` and `procurement.test.js` — covering `PurchaseRequest` creation/approval/rejection, RFQ creation and supplier-quotation comparison/selection, `PurchaseOrder` creation (direct and via RFQ selection)/approval, and `GoodsReceipt` partial/full receiving with its own concurrency guards — all pass unchanged. No document reference, quantity-tracking field, numbering scheme, or approval behavior in this chain was touched by this phase. This satisfies the task's explicit instruction to verify, not rebuild, Phase 1.9.

---

## 10. Document Relationships

Traceability is a direct-FK chain at every step, deliberately avoiding the polymorphic `sourceType`/`sourceId` pattern this codebase already uses only for its `JournalEntry`/`InventoryTransaction` ledger tables (where genuine polymorphism across many document types is unavoidable) — a Quotation/SalesOrder/Sale chain has a small, fixed set of relationships, so a standardized, typed FK is both simpler and safer:

```
Quotation --(sourceQuotationId, unique)--> SalesOrder --(salesOrderId)--> Sale --(existing) --> Payment
                                                 |
                                          SalesOrderItem --(salesOrderItemId)--> SaleItem
```

Every downstream document retains its source reference (`SalesOrder.sourceQuotationId`, `Sale.salesOrderId`, `SaleItem.salesOrderItemId`), and every source exposes its converted-quantity/remaining-quantity state (`QuotationItem` has none needed, since conversion is 1:1/all-or-nothing; `SalesOrderItem.fulfilledQuantity` for the genuinely partial Sales-Order-to-Sale step). This mirrors the existing `PurchaseOrder.sourceQuotationId`/`Purchase.purchaseOrderId`/`GoodsReceiptItem.purchaseOrderItemId` pattern (Phase 1.9) exactly, rather than inventing a new relationship convention.

---

## 11. Inventory Integration

Verified directly, by construction and by test:

- **Quotation creation never reduces stock** — confirmed by a test that creates a 50-unit quotation and a 50-unit direct Sales Order and asserts `Product.stockQuantity` is byte-for-byte unchanged afterward.
- **Sales Order creation does not reserve stock.** The audit found no existing stock-reservation mechanism anywhere in the codebase (`PurchaseOrder` creation doesn't reserve either — stock only ever moves at `GoodsReceipt` time), so this phase does not invent one for Sales Orders either, per the task's explicit instruction ("If stock reservation is not currently implemented, document it as a future enhancement rather than creating a partial unsafe implementation" — Section 26).
- **Fulfillment (Sales Order → Sale) uses the existing inventory engine exactly** — the identical atomic conditional `Product.stockQuantity` decrement guard from `sales.routes.js`, respecting the tenant's `allowNegativeStock` setting, with one `InventoryTransaction` (`type: SALE_DEDUCTION`, `reference` = the new Sale's own id) per line, per conversion — never duplicated, verified directly.
- As with `Sale.warehouseId`/`SalesOrder.warehouseId` (and every other document since Phase 1.9/1.10), warehouse fields remain attribution/authorization-only and do not drive a per-`WarehouseStock` adjustment — an existing, disclosed limitation carried forward unchanged, not introduced by this phase.

---

## 12. Accounting Integration

Verified directly, by construction and by test:

- **Neither `Quotation` nor `SalesOrder` has a `JournalSourceType` enum value at all** — the strongest possible guarantee that creating either can never post a journal entry, since no create handler could even reference a valid `sourceType` to try. Confirmed by a test asserting zero `JournalEntry` rows exist by `sourceId` for a freshly created quotation and sales order.
- **`SalesOrder → Sale` conversion posts exactly the same journal shape as a direct Sale creation** (`Dr Cash/Receivable, Cr Revenue/Tax Payable, Dr COGS/Cr Inventory` as applicable), reusing `postJournalEntry`/`getSystemAccountId`/`getMoneyAccountId` directly — no parallel accounting engine. Verified balanced (total debits = total credits) on every conversion, and verified never duplicated across a two-step partial conversion (two separate `Sale` rows, two separate, individually-balanced journal entries, `sourceId` distinguishing them).
- No closed-period-protection or reversal-behavior change was needed — the created Sale is reversed exactly like any other Sale, via the pre-existing, unmodified `POST /sales/:id/reverse`.

---

## 13. Payment Integration

Verified directly: creating or sending a Quotation, and creating or confirming a Sales Order, never creates a `Payment` row (grepped/tested for by id). A conversion's optional `amountPaid` creates a `Payment` using the exact same code path as a direct `Sale` creation's own `amountPaid` handling (Phase 1.11 payment architecture, unmodified) — verified directly that the resulting `Payment.saleId` points at the new Sale and its amount is reflected in `Sale.paymentStatus`. No duplicate payment, no payment against a non-existent downstream document, and no payment exceeding the sale total are all enforced by the same, pre-existing Sale-side rules — nothing new was built here.

---

## 14. Numbering

Both new document types (`QT-######`, `SO-######`) use the existing, unmodified shared `nextSequenceNumber` utility, wrapped in the same 8-retry bounded-retry-the-whole-transaction pattern established since Phase 1.11/1.12/1.13. No change was made to the shared utility itself.

Direct concurrency probes (mirroring the exact methodology of every prior phase's numbering audit):

| Document type | Extreme (15-way, 1 trial) | Realistic (3-way, 10 trials) |
|---|---|---|
| Quotation (QT) | 3 failures, **0 duplicates, 0 server errors** | 0 failures, 0 duplicates, 0 server errors |

This is the identical pattern found in every phase since 1.8: realistic concurrency is always fully safe; extreme (15-way) concurrency still shows some requests exhausting all 8 retries and failing outright (never a duplicate number, never an unhandled server error) — a disclosed, pre-existing residual limitation of the shared utility, not something this phase introduced or attempted to fix. `SalesOrder` (SO) numbering was verified under realistic 8-way concurrency as part of the main automated suite (0 duplicates, 0 server errors) and shares the exact same code path as Quotation, so a separate extreme-scale probe for it was not run — the same proportionality decision Phase 1.13 made for `PurchaseReturn`/`DebitNote` numbering relative to `SalesReturn`/`CreditNote`.

---

## 15. Idempotency

`Quotation` creation, `SalesOrder` creation, and both conversion endpoints (`Quotation → SalesOrder`, `SalesOrder → Sale`) all accept an optional `idempotencyKey`, checked via the existing, unmodified `findExistingByIdempotencyKey` utility and enforced by a `@@unique([tenantId, idempotencyKey])` constraint on both new models (`Sale`'s own existing idempotency key is what protects the fulfillment conversion, since its result *is* a Sale) — the exact same architecture used by every prior phase, not a new mechanism. A retried request with the same key returns the already-created result (`200`, `deduplicated: true`) rather than creating a second document or applying a second financial/inventory effect — verified directly for quotation create, sales order create, and quotation→order conversion, including confirming only one downstream row exists in the database afterward, not merely that the HTTP response looked deduplicated.

---

## 16. Concurrency Testing

All scenarios below use real, concurrent HTTP requests (`Promise.all` against a live Express app and a real Postgres database, `--runInBand` Jest, no database mocking):

- **A. Concurrent Quotation → Sales Order conversion**: two requests convert the same accepted quotation. Result: exactly one succeeds (`201`), the other fails (`409`); exactly one `SalesOrder` row exists afterward (verified against the database, not just HTTP status).
- **B. Concurrent Sales Order → Sale conversion (exact task scenario)**: a 100-unit order, concurrent fulfillment of 70 and 50 units. Result: exactly one request succeeds; the loser is rejected either at the pre-check (`422`) or the atomic in-transaction guard (`409`) depending on request-interleaving timing — both are correct "prevented" outcomes (the identical, already-disclosed timing nuance from Phase 1.13's own equivalent test). `fulfilledQuantity` never exceeds 100, and exactly one `Sale` (and one balanced `SALE` journal entry) exists for the winner — no duplicate inventory movement or accounting posting.
- **C. Exact-fit concurrent fulfillment**: 100-unit order, concurrent 40 and 60: both succeed, final `fulfilledQuantity` is exactly 100, two separate `Sale` rows exist.
- **D. Concurrent Quotation numbering**: Section 14.
- **E. Concurrent Sales Order numbering**: Section 14.
- **F. Duplicate idempotent requests**: Section 15.

All of the above are asserted directly against database state afterward (exact `fulfilledQuantity` values, exact row counts, exact journal-entry counts), not merely HTTP status codes.

---

## 17. Tenant/Company/Branch/Warehouse Isolation

Every new endpoint scopes its query by `tenantId`, and cross-tenant access to a Quotation or Sales Order returns `404` (never `403`, which would leak existence) — verified directly: Tenant B cannot view, convert, or fulfill Tenant A's quotation/sales order. Branch access is enforced via the existing, unmodified `assertBranchAccess` on every read and write (verified: a branch-restricted user is rejected `403` creating a quotation for a branch outside their access); warehouse access via the existing `assertWarehouseAccess` (verified: `403` for an out-of-scope warehouse on Sales Order creation). Company isolation is enforced **transitively** via branch (`Branch.companyId`) — `Quotation`/`SalesOrder` carry no direct `companyId` field, exactly like `Sale`/`Purchase`/every other transactional document in this codebase — so a user without access to a branch's company can never reach a document scoped to that branch, covered by the same branch-scoping tests rather than a separate, redundant company-specific test path. No new isolation mechanism was invented; all of this reuses `branchScopeWhere`/`assertBranchAccess`/`assertWarehouseAccess` from the existing `middleware/branchScope.js`.

---

## 18. RBAC

Two new resources added to the centralized Phase 0.4 permission catalog — `QUOTATION` and `SALES_ORDER` — using only the existing, fixed `PermissionAction` enum values, avoiding the exact "invented ad-hoc action name" mistake caught and fixed in Phase 1.13:

- `QUOTATION`: `VIEW`/`CREATE`/`UPDATE` (all `SALES_STAFF`), `APPROVE` (reused for recording the customer's **acceptance**), `REVERSE` (reused for **rejection**/**cancellation**) — both `SALES_STAFF`, since accepting/rejecting/cancelling a not-yet-converted quotation is a low-stakes, routine sales action, not a privileged one.
- `SALES_ORDER`: `VIEW`/`CREATE`/`UPDATE`/`APPROVE` (reused for **confirm**, `SALES_STAFF`), `REVERSE` (reused for **cancel**, `MANAGEMENT` — mirroring `SALES_RETURN`/`PURCHASE_RETURN`'s identical "undoing a real commitment is privileged" precedent).

Converting a Quotation into a Sales Order is gated on `SALES_ORDER:CREATE` (not a separate `QUOTATION:CONVERT` action); fulfilling a Sales Order into a Sale is gated on `SALE:CREATE` (not a separate `SALES_ORDER:CONVERT` action) — in both cases, the permission for the document actually being created, mirroring the identical precedent Phase 1.13 established for return-issued Credit/Debit Notes. No approval workflow was introduced merely because a permission exists — there is no separate "pending approval" state for a Sales Order beyond the single Draft→Confirmed step the task itself named.

Verified directly: a `RECEPTIONIST` (no `QUOTATION:CREATE`) is rejected `403` creating a quotation; a `CASHIER` succeeds; cancelling a Sales Order is verified `MANAGEMENT`-only; converting a quotation is verified to require `SALES_ORDER:CREATE` specifically (a `RECEPTIONIST`, lacking both `QUOTATION` and `SALES_ORDER` grants, is rejected on convert exactly as on create).

---

## 19. Offline-First Verification

**Quotation creation** was given offline outbox support (`OUTBOXES.quotations`, a plain `createOutbox` instance registered in `syncEngine.js`, backed by a new `pendingQuotations` Dexie table, `db.js` v6) — genuinely safe to do so, since a Quotation has **zero** stock or financial effect of its own (Section 11/12), making it at least as safe as the already-offline-capable `Sale`/`Purchase`/`Expense`/`Payment` creation outboxes; its own `@@unique([tenantId, idempotencyKey])` constraint is the same double-application guard those already rely on.

**Deliberately not extended to**: every Quotation lifecycle action (send/accept/reject/cancel/expire), Sales Order creation, every Sales Order lifecycle action (confirm/cancel), and both conversions (Quotation→SalesOrder, SalesOrder→Sale). This mirrors the exact reasoning Phase 1.13 applied to Returns/Credit/Debit Notes: these are multi-step, atomic-guard-dependent operations (a quantity or status-flip claim, potentially a real Sale/journal/stock effect), a materially different and riskier offline-replay profile than a simple single-entity create — building unsafe offline behavior for them was explicitly prohibited by the task, and no attempt was made to force a fit with the existing `createOutbox`/`createActionOutbox` factories. All of it requires connectivity today, exactly like `PurchaseOrder`/`GoodsReceipt`'s own approve/receive actions have required since Phase 1.9. This is a considered, disclosed scope boundary (Section 27), not an oversight.

---

## 20. Frontend

Both new pages (no prior UI for either existed anywhere):

- **`frontend/src/pages/quotations/Quotations.jsx`**: list with customer/status/search filters and pagination; a multi-line create form (product/quantity/unit price/discount/tax per line, valid-until date, notes, terms) submitted through the new offline-capable `OUTBOXES.quotations`; a detail view showing every item, computed totals, and permission-gated Send/Accept/Reject/Cancel/Convert-to-Sales-Order actions, each calling its corresponding backend endpoint and refreshing state.
- **`frontend/src/pages/salesOrders/SalesOrders.jsx`**: list with customer/status/search filters and pagination; a direct-creation form; a detail view showing ordered/fulfilled/remaining quantity per line, the source quotation (if any), every Sale already created from this order, and permission-gated Confirm/Cancel/Fulfill actions — the Fulfill action lets the user enter a partial quantity per line (defaulting to 0, capped at each line's own remaining quantity) plus an optional amount-to-collect-now, submitting to `POST /:id/convert`.
- Both pages were registered as new routes (`/quotations`, `/sales-orders`, each `ProtectedRoute`-gated on the matching `:VIEW` permission) in `App.jsx`, and added to the sidebar navigation in `Layout.jsx`.
- No Optical/Medical-specific field, assumption, or terminology appears anywhere in either page — consistent with the backend's own industry-neutrality (Section 3).
- Existing Purchase-side UI (`Procurement.jsx`, `Purchases.jsx`) was left completely untouched, per the task's explicit instruction to preserve Phase 1.9's existing functionality.

**Testing limitation, disclosed transparently, identical to Phase 1.13's**: this environment has no browser-automation tool available, so the new pages could not be visually exercised in a live browser. In its place: `npm run build` and `npm run lint` both succeed cleanly (lint exits 0; the two new pages produce only the same pre-existing, codebase-wide `set-state-in-effect` warning style already present in every other list page); the full existing frontend test suite (136 tests, 30 files) was re-run and passes unmodified; and every API response shape the new pages depend on (`GET /quotations`, `GET /quotations/:id`, `GET /sales-orders`, `GET /sales-orders/:id`) was cross-checked against the actual route handlers' `include`/`select` clauses to confirm every field referenced in the JSX is genuinely present.

---

## 21. Search/Filter/Pagination

`GET /quotations` supports `customerId`, `status`, `search` (quotation number, case-insensitive), `from`/`to` (by `quotationDate`), and `branchId` (access-checked), plus the shared `parsePagination` utility. `GET /sales-orders` supports the same shape plus `sourceQuotationId` and `warehouseId` (access-checked). This mirrors the exact filter-shape convention established by every prior phase's list endpoint.

---

## 22. Reporting

A new `GET /api/reports/quotations-orders` endpoint (added to the existing, general — not journal-derived — `reports.routes.js`, which already hosts non-accounting descriptive reports like `/expenses` and `/profit-loss`; this was deliberately **not** added to `accounting/reports.routes.js`, whose own header comment states every report there is derived exclusively from `JournalEntry`/`JournalLine` so it can never drift from the ledger — a Quotation/SalesOrder report cannot be journal-derived at all, since neither ever posts one, Section 12). It returns, all tenant/branch-scoped and date-range-filterable: Quotation counts and total value grouped by status (Draft/Sent/Accepted/Rejected/Expired/Cancelled/Converted); a single, tenant-wide **descriptive** conversion rate (converted ÷ every quotation that reached a final, decided outcome — explicitly not a per-salesperson or per-customer ranking, per the task's explicit prohibition on "business-performance rankings or unrelated analytics"); Sales Order counts and total value grouped by status; and aggregate outstanding (ordered-minus-fulfilled) and fulfilled quantity across all non-cancelled orders. Verified directly with a test exercising every status bucket. No frontend UI tile was built for this report in this phase — a deliberate, disclosed proportionality decision (Section 27), consistent with Phase 1.13 also not building dedicated report UI.

---

## 23. Security

- Every new endpoint requires authentication and an active tenant context, exactly like every other module.
- Every write endpoint validates its request body with a Zod schema before touching the database; unrecognized or malformed input is rejected with `422`.
- Cross-tenant access returns `404` everywhere (Section 17), never leaking existence via `403`.
- Financial totals (`subtotal`/`discount`/`tax`/`total`) are always server-computed from the submitted line items — verified directly with a test that sends a fabricated `total: 999999` and confirms the server-computed value is what's actually stored.
- Duplicate conversion, over-fulfillment, and duplicate numbering are all prevented by atomic, transaction-scoped guards, not application-level checks alone (Section 8/16).
- **Bug 1 (caught by this phase's own test suite)**: the lazy quotation-expiry flip was originally performed inside the same transaction as a subsequent accept/reject/convert attempt that could then throw and roll the whole transaction back — silently undoing the expiry flip itself. Fixed by committing the expiry check as an independent statement, using the top-level `prisma` client, *before* the guarded transaction opens.
- **Bug 2 (caught by direct code review, before any test ran)**: three call sites inside `prisma.$transaction(async (tx) => ...)` callbacks in the initial draft of `quotations.routes.js` called `assertBranchAccess(prisma, ...)` instead of `assertBranchAccess(tx, ...)` — the exact connection-pool-exhaustion class of bug first documented and fixed in Phase 1.11. Caught and fixed before the test suite was even written, by directly re-reading every transaction callback against that known failure mode.
- **Bug 3 (test-authoring, caught by the first test run, not a product defect)**: a concurrent-fulfillment test initially asserted the losing request would always return `422`; it returned `409` on one run. Root cause: the loser can legitimately be rejected either at the friendly pre-check or the atomic in-transaction guard depending on request-interleaving timing — the identical, already-disclosed nuance from Phase 1.13's equivalent test. Fixed by relaxing the assertion to accept either status for the loser, while still asserting exactly one request succeeds.

No other error was found during this phase's implementation or testing.

---

## 24. Regression Testing

Full backend suite (`npx jest --runInBand`, all 32 suites, no file filter), against the `akvisionflow_phase114` database:

- **Initial full-suite run**: 702 tests, 662 passed, 40 failed across 7 suites (`clinical.test.js`, `accounting.test.js`, `mobileDashboard.test.js`, `tenantCompanyManagement.test.js`, `branchWarehouseManagement.test.js`, `productArchitecture.test.js`, `api.test.js`). **`quotationsAndOrders.test.js` itself passed cleanly in this same full-suite run.**
- Root cause, confirmed by the actual error message: `FATAL: sorry, too many clients already` — genuine Postgres connection-pool exhaustion during the heavy, fully-sequential 32-suite run, not the previously-documented "Can't reach database server" timing flake, though the same underlying class of issue (a connection-resource ceiling under load, now more visible as the test suite has grown to 32 files across 14 phases). Confirmed Postgres was healthy immediately afterward (`pg_isready` normal; `max_connections=100`, only 6 active connections moments later) — **no code was changed** in response.
- **Isolated retry of all 7 affected suites together**: **121/121 passed, fully clean.**

This is disclosed with full transparency as a new manifestation of the same class of environment-level flakiness documented in every prior phase's report (Phase 0.2 onward), not a defect introduced by this phase's changes — none of the 7 affected suites touch Quotation/SalesOrder code at all. Per the established protocol, both the full-suite and isolated results are reported here rather than only the passing retry.

Full frontend suite (`npx vitest run`): **136/136 tests passed across 30 files**, unchanged. `npm run lint` (oxlint) exits `0`. `npm run build` (vite) succeeds cleanly.

---

## 25. Tests Added

`backend/tests/quotationsAndOrders.test.js` — **38 tests**, covering: Quotation CRUD and server-side pricing (including a test that a fabricated client-supplied total is ignored); full Quotation lifecycle (Draft→Sent→Accepted, Sent→Rejected, Draft/Sent→Cancelled, Sent→Expired via both lazy-check and explicit endpoint, and every invalid/duplicate transition rejection); Quotation→SalesOrder conversion (preserving customer/items/pricing, duplicate-conversion prevention, concurrent double-conversion, idempotency); Sales Order CRUD and lifecycle (Draft→Confirmed→Cancelled, edit-restricted-to-Draft); SalesOrder→Sale conversion (full and partial, quantity tracking, over-fulfillment rejection, rejecting conversion of an unconfirmed order, payment-at-conversion-time); the mandatory concurrent 100/70/50 fulfillment scenario plus an exact-fit 40/60 scenario; numbering-under-concurrency for both document types; creation idempotency for both; RBAC (create/cancel/convert, authorized vs. unauthorized roles); tenant/branch/warehouse isolation; inventory and accounting correctness (including that neither Quotation nor SalesOrder creation ever posts a journal entry or touches stock); the new reporting endpoint; and an Optical/Medical-neutrality regression test.

---

## 26. Full Test Results

| Suite | Result |
|---|---|
| `tests/quotationsAndOrders.test.js` (new) | **38/38 passed** |
| Full backend suite, initial run | 662/702 passed (40 failures, all the connection-pool-exhaustion flake — Section 24) |
| Full backend suite, isolated retry of the 7 affected files | **121/121 passed** |
| Frontend suite (`vitest run`) | **136/136 passed**, 30/30 files |
| Frontend lint (`oxlint`) | exit 0 |
| Frontend build (`vite build`) | succeeds cleanly |
| Numbering probe — Quotation, extreme (15-way) | 3 failures, 0 duplicates, 0 server errors |
| Numbering probe — Quotation, realistic (3-way × 10) | 0 failures, 0 duplicates, 0 server errors |

---

## 27. Known Limitations

1. **No stock reservation for Sales Orders** — a confirmed Sales Order does not reserve/hold stock against future fulfillment; stock is only ever checked/deducted at actual fulfillment (Sale-conversion) time, exactly mirroring `PurchaseOrder`'s own identical non-reserving behavior. Disclosed per the task's own instruction, not invented as a partial/unsafe implementation.
2. **Quotation→SalesOrder conversion is 1:1 only** — no partial conversion (splitting one quotation across multiple orders) exists, mirroring the identical `RFQ→PurchaseOrder` 1:1 precedent.
3. **Offline-first is not supported** for any Quotation/SalesOrder lifecycle action or either conversion (Section 19) — only Quotation *creation* is offline-capable. A deliberate, disclosed decision, not an oversight.
4. **No dedicated frontend UI for the new reporting endpoint** (Section 22) — the data is available via `GET /api/reports/quotations-orders`, just not yet surfaced as a report-page tile.
5. **Proportional, not per-line, tax allocation** when a SalesOrder (with only aggregate tax) converts into a Sale — the same class of approximation Phase 1.13 disclosed for partial-return tax, applied consistently again here.
6. **Extreme-concurrency (15-way) numbering collisions remain possible** at the shared 8-retry ceiling (Section 14) — the same pre-existing, disclosed characteristic of `nextSequenceNumber` found in every phase since 1.11, not newly introduced here.
7. **No visual, live-browser verification of the new frontend pages** was possible in this environment (Section 20) — verified instead via build/lint/existing-test success and a field-by-field cross-check of API response shapes.
8. **The Sales Order status rollup after a conversion has the same narrow, disclosed non-linearizable edge case** as `GoodsReceipt`'s identical `PurchaseOrder` rollup (Phase 1.9): two concurrent conversions touching *different* lines of the same multi-line order could each compute the rollup against a slightly stale snapshot of the other's just-committed line. This is the same accepted, pre-existing limitation, not a new one.

---

## 28. Deferred Items

- Stock reservation for confirmed Sales Orders, if a future phase determines the business need outweighs the added complexity (Section 27.1).
- Partial Quotation→SalesOrder conversion (Section 27.2).
- A safe, purpose-built offline design for Quotation/SalesOrder lifecycle actions and conversions, if warranted (Section 27.3).
- A frontend report-page tile surfacing `GET /api/reports/quotations-orders` (Section 27.4).
- Per-line tax tracking on `SalesOrderItem`/`SaleItem` (a pre-existing, cross-cutting gap, not specific to this phase — Section 27.5).
- Visual/browser-based UI verification of the new frontend pages, once a browser-automation tool is available in this environment.
- A dedicated RFQ frontend screen (Phase 1.9's own, still-open, pre-existing disclosed gap — out of this phase's scope, not touched).

---

## 29. Files Changed

**Backend (new):**
- `backend/prisma/migrations/20260922010000_phase1_14_quotations_orders/migration.sql`
- `backend/src/modules/quotations/quotations.routes.js`
- `backend/src/modules/salesOrders/salesOrders.routes.js`
- `backend/tests/quotationsAndOrders.test.js`

**Backend (modified):**
- `backend/prisma/schema.prisma` — `Quotation`/`QuotationItem`/`SalesOrder`/`SalesOrderItem` models; `QuotationStatus`/`SalesOrderStatus` enums; `Sale.salesOrderId`/`SaleItem.salesOrderItemId`; back-relations on `Tenant`/`Branch`/`Warehouse`/`Customer`/`Product`/`ProductVariant`/`User`.
- `backend/src/constants/permissionCatalog.js` — new `QUOTATION`/`SALES_ORDER` resources (29 new grants).
- `backend/src/app.js` — mounted the 2 new route modules under `/api/quotations`, `/api/sales-orders`.
- `backend/src/modules/reports/reports.routes.js` — new `GET /quotations-orders` descriptive report endpoint.

**Frontend (new):**
- `frontend/src/pages/quotations/Quotations.jsx`
- `frontend/src/pages/salesOrders/SalesOrders.jsx`

**Frontend (modified):**
- `frontend/src/App.jsx` — new `/quotations`/`/sales-orders` routes.
- `frontend/src/components/Layout.jsx` — new sidebar navigation entries.
- `frontend/src/offline/db.js` — new `pendingQuotations` Dexie table (v6).
- `frontend/src/offline/syncEngine.js` — new `quotations` outbox entry.

---

## 30. Final Verdict

**PHASE 1.14 — CLOSED WITH CONDITIONS**

Justification: the core, task-mandated capability — a fully industry-neutral Quotation with the complete lifecycle the task named, a genuinely new Sales Order distinct from the existing Sale, and both conversions (Quotation→SalesOrder, SalesOrder→Sale) with correct, concurrency-safe duplicate-conversion and over-fulfillment prevention (verified against the task's own exact 100/70/50 worked example) — is fully implemented, thoroughly tested with real concurrent HTTP requests against a real database, and free of any known correctness defect. The existing Purchase Request→RFQ→Purchase Order→Goods Receipt chain was verified, not rebuilt, and passes unchanged. RBAC, tenant/branch/warehouse isolation, idempotency, and numbering all follow established, unmodified architectural precedent. Two real bugs were caught and fixed during this phase's own development (the expiry-rollback transaction bug and the `assertBranchAccess(prisma,...)` inside a transaction bug) — both before or via this phase's own test suite, not discovered in production. Regression testing found zero failures attributable to this phase's changes (the only failures observed are a connection-pool-exhaustion flake affecting seven unrelated suites, confirmed to clear completely on isolated retry).

The "conditions" are the disclosed items in Section 27: no stock reservation exists for Sales Orders (mirrors existing Purchase Order behavior, not a gap introduced here); Quotation→SalesOrder conversion is 1:1 only (mirrors existing RFQ→PO behavior); offline-first covers only Quotation creation, not any lifecycle action or conversion; the new reporting endpoint has no frontend UI yet; and the new frontend pages could not be visually verified in a live browser in this environment, only through build/lint/existing-test success and a manual response-shape cross-check. None of these conditions represent an incorrect or unsafe behavior — each is a scoped, transparently-documented boundary consistent with the task's own instruction to disclose limitations rather than either silently omit them or over-build beyond what was asked.

**STOP. Phase 1.15 has not been started.** Awaiting Product Owner review of this report.
