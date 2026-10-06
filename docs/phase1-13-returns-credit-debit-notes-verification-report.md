# PHASE 1.13 — RETURNS, CREDIT & DEBIT NOTES: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-22
**Scope:** Universal Sales Returns, Purchase Returns, Customer Credit Notes, and Supplier Debit Notes — partial/full returns, refunds, inventory/accounting/payment integration, RBAC, isolation, concurrency, idempotency, numbering, offline-first, search/filter/reporting, and frontend.
**Test database:** local, throwaway Postgres (`akvisionflow_phase113`) via the portable Postgres instance at `D:\pgsql-portable`. No production database was touched.

---

## 1. Executive Summary

Phase 1.13 began with a full audit of the existing returns/reversal/refund architecture before any code was written. The audit confirmed that **no partial, line-item-level return capability existed anywhere**: Sale had only a whole-invoice `POST /:id/reverse` (Phase 1.8) and Purchase had only a whole-document `POST /:id/return` (Phase 1.9) — both all-or-nothing, both leaving the original document's individual line quantities untouched. There was no `CreditNote`, `DebitNote`, or refund model of any kind in the schema. This genuinely new capability was built additively, without touching or duplicating either existing whole-document operation.

Four new models were added — `SalesReturn`/`SalesReturnItem`, `PurchaseReturn`/`PurchaseReturnItem`, `CreditNote`, `DebitNote` — plus a `returnedQuantity` running-total column on `SaleItem`/`PurchaseItem`, following the exact atomic-conditional-update guard pattern established in Phase 1.8–1.12 (`updateMany` with a `lte` guard, checking `result.count`) to prevent over-returning under concurrency — directly verified against the task's own worked example (a 100-unit sale, concurrent returns of 70 and 50, never exceeding 100). A `SalesReturn`/`PurchaseReturn` creation posts exactly **one** combined journal entry (inventory/COGS leg + revenue-or-payable/tax/receivable leg together) and, by default, atomically issues its own linked `CreditNote`/`DebitNote` in the same transaction — a deliberate design choice to eliminate any risk of double-posting. Refunds reuse the existing Payment model (a new `creditNoteId`/`debitNoteId` foreign key, no new payment engine), with the same atomic-accumulation-guard pattern used for `Sale.amountPaid`/`Purchase.amountPaid` applied to `CreditNote.refundedAmount`/`DebitNote.refundedAmount`.

Frontend work was scoped additively: the existing Sales History and Purchases pages each gained a new, permission-gated "Return" row action (a modal for selecting per-line return quantities), and two genuinely new pages (`CreditNotes.jsx`, `DebitNotes.jsx` — no prior UI for either existed) were added for standalone creation, listing/filtering, cancellation, and refunds.

Offline-first support was deliberately **not** extended to any of the four new document types or actions — this is disclosed as a considered limitation, not an oversight (Section 18).

**Overall result: PHASE 1.13 — CLOSED WITH CONDITIONS.** See Section 29 for the exact justification.

---

## 2. Existing Architecture Audit

Read in full before any code was written: the `Sale`/`SaleItem`/`Purchase`/`PurchaseItem`/`Payment` Prisma models, `sales.routes.js` (Sale's own `POST /:id/reverse`), `purchases.routes.js` (Purchase's own `POST /:id/return` and `POST /:id/pay`), `accounting/ledger.js` (`postJournalEntry`, `reverseJournalEntry`, `getSystemAccountId`, `getMoneyAccountId`), `utils/sequenceNumber.js`, `utils/idempotency.js`, the full `permissionCatalog.js`, `frontend/src/offline/syncEngine.js` and `db.js`, `frontend/src/pages/sales/SalesHistory.jsx`, `frontend/src/pages/purchases/Purchases.jsx`, and every prior phase's verification report (1.8 through 1.12) for established precedent.

Confirmed, not assumed:
- **No `CreditNote`, `DebitNote`, `SalesReturn`, or `PurchaseReturn` model existed anywhere** in `schema.prisma` — grepped for all four names with zero matches before starting.
- **Sale's `POST /:id/reverse` and Purchase's `POST /:id/return` are both whole-document-only** — they flip the entire document's status, restore/remove the *entire* original quantity of every line, and reverse the *entire* original journal entry. Neither has any per-line, partial-quantity capability, and neither was modified by this phase.
- **No CreditNote/DebitNote frontend code existed anywhere** in `frontend/src` (confirmed by an exhaustive grep for `CreditNote|DebitNote|credit-note|debit-note` returning zero matches before this phase's frontend work began).
- **The atomic-conditional-update-with-`.count`-guard pattern** (Phase 1.8's `PurchaseOrderItem.receivedQuantity` guard, reused in every phase since) is the correct, established tool for preventing `SaleItem`/`PurchaseItem` over-returning under concurrency — no new concurrency-control mechanism needed to be invented.
- **The offline outbox architecture** (`createOutbox`/`createActionOutbox` in `syncEngine.js`) already has a documented precedent for *not* extending offline support to complex, multi-step operations: `docs/phase1-9-purchase-management-verification-report.md` explicitly states no outbox exists for `PurchaseOrder`/`GoodsReceipt`, reasoning that receiving/approving requires connectivity. This precedent directly informed Section 18's decision.
- **`PermissionAction` is a fixed Prisma enum** (`VIEW/CREATE/UPDATE/DELETE/APPROVE/REVERSE/EXPORT`), not a free string — discovered when an initial seed attempt using ad-hoc `CANCEL`/`REFUND` action names failed (Section 22, error 1).
- **No duplicate or parallel returns/credit-note/debit-note implementation exists anywhere else in the codebase.**

---

## 3. Sales Return Implementation

`backend/src/modules/salesReturns/salesReturns.routes.js` (new module): `GET /` (filters: `saleId`, `customerId`, `status`, `from`/`to`, `search`), `GET /:id`, `POST /`, `POST /:id/reverse`.

`POST /` accepts `{ saleId, items: [{ saleItemId, quantity }], reason?, notes?, branchId?, warehouseId?, issueCreditNote=true, idempotencyKey? }`. It validates the sale exists, is not `REVERSED`, and that the caller has branch/warehouse access; a friendly pre-check estimates remaining quantity per line before opening a transaction (fast-fail for the common case), but the **authoritative** guard is the atomic `SaleItem.updateMany` inside the transaction (Section 12). For each line it computes `lineTotal`, accumulates `subtotal` and (for non-`SERVICE` products) `cogs`, generates a `returnNumber` (`SRT-######`) via the shared `nextSequenceNumber` utility with an 8-retry bounded wrapper (Section 15), creates the `SalesReturn` + `SalesReturnItem` rows, then applies the deferred stock increments and posts one combined journal entry (Section 9). A partial return can be submitted multiple times against the same sale, correctly accumulating `returnedQuantity`, and a return exceeding the true remaining quantity — whether checked at once or split across several prior returns — is rejected with 422.

`POST /:id/reverse` is gated to `SALES_RETURN:REVERSE` (MANAGEMENT). It atomically flips `status: COMPLETED -> REVERSED` (guarded against double-reversal — Section 12), decrements `SaleItem.returnedQuantity` back, reverses the stock increment (respecting the tenant's `allowNegativeStock` setting), marks the linked `CreditNote` `CANCELLED` if one exists, and reverses the journal entry via `reverseJournalEntry`. It is rejected (409) if the linked credit note has already been partially or fully refunded — reversing the return without first reversing a real cash refund would corrupt both the ledger and the customer's balance.

---

## 4. Purchase Return Implementation

`backend/src/modules/purchaseReturns/purchaseReturns.routes.js` (new module) mirrors Section 3 exactly for the supplier side: `purchaseId`/`purchaseItemId`/`unitCost` in place of the sale equivalents, stock **decrements** (atomically guarded against going negative unless `allowNegativeStock` is set) instead of increments, `returnNumber` prefixed `PRT-######`, and a linked `DebitNote` (`issueDebitNote`, default `true`) instead of a `CreditNote`. Only a `RECEIVED` purchase can be returned against; a return against a `DRAFT` (not yet received) or already-fully-returned-and-status-flipped purchase is rejected. Its `POST /:id/reverse` restores stock **up** (increment), decrements `returnedQuantity` back, cancels the linked `DebitNote`, and reverses the journal entry with `sourceType: PURCHASE_RETURN_REVERSAL` — the exact mirror image of Section 3.

A self-caught internal-consistency bug during implementation (not surfaced by a failing test, found by direct code review comparing the create and reverse paths) is documented in Section 22.

---

## 5. Credit Note

`backend/src/modules/creditNotes/creditNotes.routes.js` (new module): `GET /`, `GET /:id`, `POST /` (standalone), `POST /:id/cancel`, `POST /:id/refund`.

The overwhelming majority of credit notes are created **automatically** as a side effect of a Sales Return (Section 3) — `POST /credit-notes` is exclusively for the standalone case (a goodwill/price adjustment with no physical return involved), and posts its own journal entry (`{Dr SALES_REVENUE, Dr TAX_PAYABLE if tax>0, Cr ACCOUNTS_RECEIVABLE}`) since there is no return entry to combine with. `POST /:id/cancel` is deliberately scoped to standalone notes only: a note with `salesReturnId` set is rejected with a message directing the caller to reverse the sales return instead — this mirrors Phase 1.11's identical, already-established scoping of `POST /payments/:id/reverse` to allocation-carrying standalone payments only, applied here for the same underlying reason (the return's own combined journal entry, not the note's, is what must be reversed). A note that has already been partially or fully refunded cannot be cancelled (409) — its financial effect is no longer purely reversible by a simple status flip.

---

## 6. Debit Note

`backend/src/modules/debitNotes/debitNotes.routes.js` (new module) mirrors Section 5 exactly for the supplier side: standalone creation posts `{Dr ACCOUNTS_PAYABLE, Cr INVENTORY, Cr INPUT_TAX if tax>0}`; `POST /:id/cancel` is scoped to standalone notes only (rejecting one with `purchaseReturnId` set); a refunded note cannot be cancelled.

---

## 7. Refund Behaviour

`POST /credit-notes/:id/refund` and `POST /debit-notes/:id/refund` both reuse the **existing** `Payment` model exclusively — no new payment engine was built. A refund creates a `Payment` row (`creditNoteId`/`debitNoteId` foreign key, a new but purely additive column on `Payment`) with `direction: 'OUT'` for a customer credit-note refund (money leaving the business) and `direction: 'IN'` for a supplier debit-note refund (money the supplier pays back) — the two directions are clearly distinguishable in every query and report. The atomic accumulation guard on `refundedAmount` (`updateMany` with an `lte` guard, mirroring `Sale.amountPaid`'s identical pattern) prevents both a single over-refund and a concurrent double-refund from exceeding the note's total amount (verified directly under concurrency — Section 14). A refund never happens automatically; it is always a distinct, explicit action, so credit-note-only vs. cash-refund outcomes remain fully distinguishable in every report. Duplicate refund submission is prevented via the existing idempotency-key mechanism (Section 13).

**Boundary explicitly not built**: there is no automatic "refund the original payment method" workflow, no partial-refund-across-multiple-payment-instruments splitting, and no refund approval workflow — a refund is a single manual action by a MANAGEMENT-role user for a specific amount and method. This matches the task's own framing ("document the boundary if full refund workflows require accounting capability not yet built") and is listed again in Section 27.

---

## 8. Inventory Integration

Both `SalesReturn` and `PurchaseReturn` creation defer their `Product.stockQuantity` mutation and `InventoryTransaction` creation until *after* the return's own row exists, specifically so the transaction's `reference` field can point at the return's own id (not the original Sale's/Purchase's id) — this correction is documented as a self-caught bug in Section 22. Stock changes are atomic and conditionally guarded: a sales return increments stock unconditionally (returning goods always increases available stock); a purchase return decrements stock only if sufficient quantity exists, unless the tenant's `allowNegativeStock` setting permits going negative — the identical guard pattern used everywhere else in the codebase for stock decrements. `SERVICE`-kind products are correctly excluded from any stock mutation on both the create and reverse paths. As with `Sale.warehouseId`/`Purchase.warehouseId` since Phase 1.9/1.10, `SalesReturn.warehouseId`/`PurchaseReturn.warehouseId` are attribution/authorization-only and do not drive a per-`WarehouseStock` adjustment — only `Product.stockQuantity` is the real mutation target. This is an existing, disclosed limitation carried forward unchanged, not introduced by this phase.

Verified directly (`tests/returnsCreditDebitNotes.test.js`, "Inventory & Journal correctness"): an `InventoryTransaction` of type `SALES_RETURN` is recorded with the correct quantity and a `reference` equal to the return's own id; a full round-trip (sale → partial return → reverse) restores stock to exactly its pre-return value at every step, verified via direct product-stock reads, not assumption.

---

## 9. Accounting Integration

A `SalesReturn`/`PurchaseReturn` creation posts **exactly one** `JournalEntry` combining both legs — inventory/COGS *and* (if a credit/debit note is issued, the default) revenue/tax/receivable-or-payable — rather than one entry for the return and a second for the auto-issued note. This was a deliberate architectural decision (documented in the schema's own module-header comment) specifically to eliminate any risk of double-posting the same financial event twice. A standalone `CreditNote`/`DebitNote` (no linked return) posts its own separate entry, since there is no return entry to combine with in that case. Two existing `JournalSourceType` values (`PURCHASE_RETURN`, and `InventoryTxnType.PURCHASE_RETURN`) were deliberately **reused** for the new `PurchaseReturn` model rather than duplicated with a new name, since they already correctly label the same real-world event; the new model's own id (not the old whole-purchase-return path's id) is what distinguishes the two in reports. For Sales, a genuinely new `SALES_RETURN` type was required, since the existing `SALE_REVERSAL` specifically means "undo the entire sale" — a different concept.

Verified directly: every posted journal entry for a sales return, purchase return, standalone credit note, standalone debit note, and every refund/cancel/reverse action is balanced (total debits = total credits, asserted to two decimal places) and correctly reversed by its own dedicated `*_REVERSAL`/`*_CANCEL`/`*_REFUND` source type on the corresponding undo action — never overwriting or duplicating the original entry. Reversing a return correctly reverses **only** that return's own combined entry, verified by locating the entry via `sourceType + sourceId` (not by memo text or ordering).

Proportional tax allocation for partial returns (`original_tax * (returned_subtotal / original_subtotal)`, rounded) is used rather than per-line tax precision, since no per-line tax tracking exists anywhere else in the codebase to begin with — this is a disclosed simplification (Section 26), not a silent approximation.

---

## 10. Payment Integration

The full chain — Sale → Payment → SalesReturn → CreditNote → Refund (and the mirror-image Purchase → Payment → PurchaseReturn → DebitNote → Refund) — was verified end-to-end via both an integrated smoke test and the automated suite. No new payment engine, payment-allocation model, or payment-status enum was introduced; refunds are ordinary `Payment` rows distinguished by their new `creditNoteId`/`debitNoteId` foreign key and `direction`. A refund never happens automatically as a side effect of return creation or reversal — it is always an explicit, separate action, so a credit-note-only outcome (customer holds a credit, no cash moved) and a cash-refund outcome remain unambiguous in every downstream report and in the ledger itself. Double-refund and over-refund are both prevented by the same atomic guard described in Section 7, verified directly under real concurrent HTTP requests (Section 14).

---

## 11. Lifecycle/State Management

Three deliberately minimal state machines were introduced — no unnecessary states were added, per the task's explicit instruction:

- **`SalesReturn`/`PurchaseReturn`**: `ReturnStatus { COMPLETED, REVERSED }`. A return is created already-`COMPLETED` (there is no draft/pending-approval concept for a return in the existing codebase to mirror, and the task explicitly warned against inventing an approval workflow merely because a permission exists) and can only transition once, atomically, to `REVERSED`.
- **`CreditNote`/`DebitNote`**: `CreditNoteStatus`/`DebitNoteStatus { ISSUED, CANCELLED }`. Refunding does **not** change status away from `ISSUED` — a partially-refunded note is still `ISSUED` with a non-zero `refundedAmount`, exactly mirroring how `Sale`/`Purchase` track partial payment via `amountPaid` without a separate "partially paid" status enum value.

Every transition is (a) validated via an atomic `updateMany` with a `where: { status: <expected> }` guard, never a read-then-write, (b) permission-controlled (`REVERSE` action, MANAGEMENT-only), (c) tenant- and branch-scoped via `assertBranchAccess`, and (d) rejected with 409 on an invalid or duplicate transition (verified directly under concurrency in Section 14, "double-reversal protection").

---

## 12. Quantity & Financial Validation

The authoritative over-return guard is the atomic conditional `updateMany`:

```js
const claim = await tx.saleItem.updateMany({
  where: { id: saleItem.id, returnedQuantity: { lte: Number(saleItem.quantity) - line.quantity + 0.0001 } },
  data: { returnedQuantity: { increment: line.quantity } },
});
if (claim.count === 0) throw new ConflictError(/* ... */);
```

identical in structure (and epsilon tolerance, for `Decimal`/floating-point safety) to the guard Phase 1.8 established for `PurchaseOrderItem.receivedQuantity` and every phase since has reused for its own accumulating-quantity or accumulating-amount field. A friendly pre-check outside the transaction gives a fast, clear 422 for the common single-request case; the in-transaction guard is what actually prevents a race (Section 14). The same guard, applied to `Decimal` amount fields instead of quantities, protects `CreditNote.refundedAmount`/`DebitNote.refundedAmount` against over-refunding. Financial totals (`subtotal`, `tax`, `total`) are always server-computed from the return's own lines and the original document's proportional tax share — never accepted from the client.

---

## 13. Idempotency

All four new creation endpoints (`SalesReturn`, `PurchaseReturn`, standalone `CreditNote`, standalone `DebitNote`) and both refund endpoints accept an optional `idempotencyKey`, checked via the existing, unmodified `findExistingByIdempotencyKey` utility and enforced by a `@@unique([tenantId, idempotencyKey])` database constraint on each new model — the exact same architecture used by every prior phase, not a new mechanism. A retried `POST /sales-returns` or `POST /credit-notes/:id/refund` with the same key returns the already-created result (`200`, `deduplicated: true`) rather than creating a second document or applying a second financial effect — verified directly (`tests/returnsCreditDebitNotes.test.js`, "Idempotency on creation" and the refund-deduplication test), including confirming the underlying `returnedQuantity`/`refundedAmount` was only incremented once, not twice.

---

## 14. Concurrency Testing

All concurrency scenarios below use real, concurrent HTTP requests (`Promise.all` against a live Express app and a real Postgres database, `--runInBand` Jest with no test-level mocking of the database) — never simulated or sequential-with-a-delay approximations.

- **Sales Return, exact task scenario**: a 100-unit sale, concurrent `POST /sales-returns` for 70 and 50 units. Result: exactly one request succeeds (`201`), the other is rejected — either `422` (pre-check, if the requests happen to interleave sequentially) or `409` (the atomic in-transaction guard, a true collision); which one occurs is a timing detail with no product-behavior significance, so the test accepts either. `SaleItem.returnedQuantity` never exceeds 100, and exactly one `SalesReturn` row and one `SALES_RETURN` journal entry exist for the sale — verified directly against the database, not inferred from HTTP status alone.
- **Sales Return, exact-fit scenario**: a 100-unit sale, concurrent returns of 40 and 60 (sum exactly 100): both succeed, final `returnedQuantity` is exactly 100.
- **Purchase Return, identical scenario**: a 100-unit purchase, concurrent returns of 70 and 50: exactly one succeeds, `returnedQuantity` never exceeds 100.
- **Concurrent refund**: two concurrent `POST /credit-notes/:id/refund` requests (70 and 60) against a 100-amount note: exactly one succeeds, `refundedAmount` never exceeds 100.
- **Concurrent double-reversal**: two concurrent `POST /sales-returns/:id/reverse` requests against the same return: exactly one succeeds (`200`), the other is rejected (`409`), and `SaleItem.returnedQuantity` is restored exactly once (not decremented twice into a negative/incorrect value).
- **Concurrent numbering** (Section 15): both extreme (15-way) and realistic (3-way × 10 trials) concurrent creation of `SalesReturn`s and standalone `CreditNote`s.

All of the above are asserted not just on HTTP status codes but directly against database state afterward (exact `returnedQuantity`/`refundedAmount` values, exact row counts, exact journal-entry counts) — the same "genuine verification, not status-code-only" standard applied in every prior phase.

---

## 15. Numbering

All four new document types (`SRT-######`, `PRT-######`, `CN-######`, `DN-######`) use the existing, unmodified shared `nextSequenceNumber` utility, wrapped in the same 8-retry bounded-retry-the-whole-transaction pattern established in Phase 1.11/1.12 (found necessary there after the original Phase 1.8/1.9 5-retry count proved insufficient for higher-contention document types). No change was made to the shared utility itself, per the task's explicit instruction.

Direct concurrency probes (mirroring the exact methodology of every prior phase's numbering audit) for `SalesReturn` and standalone `CreditNote`:

| Document type | Extreme (15-way, 1 trial) | Realistic (3-way, 10 trials) |
|---|---|---|
| SalesReturn (SRT) | 5 failures, **0 duplicates, 0 server errors** | 0 failures, 0 duplicates, 0 server errors |
| CreditNote (CN) | 5 failures, **0 duplicates, 0 server errors** | 0 failures, 0 duplicates, 0 server errors |

This is the identical pattern found in every phase since 1.8: realistic concurrency is always fully safe; extreme (15-way) concurrency still shows some requests exhausting all 8 retries and failing outright (never a duplicate number, never an unhandled server error) — a disclosed, pre-existing residual limitation of the shared utility, not something this phase introduced or attempted to fix. `PurchaseReturn` (PRT) and `DebitNote` (DN) numbering were verified under realistic concurrency as part of the main automated suite's 8-concurrent-request numbering test (0 duplicates, 0 server errors) and share the exact same code path as `SalesReturn`/`CreditNote`, so a separate extreme-scale probe for them was not run — a reasonable, disclosed proportionality decision, since the underlying mechanism is byte-for-byte identical.

---

## 16. Tenant/Company/Branch/Warehouse Isolation

Every new endpoint scopes its query by `tenantId` (never trusting a client-supplied tenant context), and `GET/POST` operations on a return, credit note, or debit note that belongs to a different tenant return `404`, not `403` — consistent with every other module in the codebase (a 403 would leak the record's existence). Verified directly: Tenant B receives `404` attempting to view, reverse, or even create a return against Tenant A's sale (a cross-tenant `saleId` in the request body correctly resolves to "not found," since the sale lookup itself is tenant-scoped).

Branch access is enforced via the existing, unmodified `assertBranchAccess` helper on every read and write — a branch-restricted user cannot create a return for a sale/purchase belonging to a branch they don't have access to (verified: `403`). Warehouse access is enforced via the existing `assertWarehouseAccess` helper — a user without access to the specified `warehouseId` is rejected (verified: `403`), exactly mirroring the guard pattern already used for warehouse-scoped operations in Phase 1.9/1.10. No new isolation mechanism was invented; all four new modules exclusively reuse `branchScopeWhere`/`assertBranchAccess`/`assertWarehouseAccess` from the existing `middleware/branchScope.js`.

---

## 17. RBAC

Four new resources were added to the centralized Phase 0.4 permission catalog — `SALES_RETURN`, `PURCHASE_RETURN`, `CREDIT_NOTE`, `DEBIT_NOTE` — using only the existing, fixed `PermissionAction` enum values (`VIEW`, `CREATE`, `REVERSE`, and the one genuinely new addition, `REFUND` — justified as a distinct financial action not covered by any existing value). `REVERSE` is deliberately reused for both "reverse a return" and "cancel a standalone note" semantics, since cancelling an un-refunded note is conceptually reversing its financial effect — consistent with existing codebase naming rather than inventing a redundant `CANCEL` action. No ad-hoc, inline role checks were introduced anywhere in the four new route modules; every endpoint is gated exclusively via `requirePermission(resource, action)`. No approval workflow was introduced merely because a permission exists — reversal/cancellation/refund require a MANAGEMENT-role permission grant, but there is no separate "pending approval" state to approve into (Section 11).

Verified directly: a `RECEPTIONIST` (no `SALES_RETURN:CREATE` grant) is rejected (`403`) creating a sales return; a `CASHIER` (has the grant) succeeds (`201`). Reversal and refund are both verified as MANAGEMENT-only (a `CASHIER`/`ACCOUNTANT` without the `REVERSE`/`REFUND` grant is rejected with `403`).

---

## 18. Offline-First Verification

**Deliberately not implemented for this phase**, and explicitly disclosed here rather than silently omitted. The audit (Section 2) found a clear, already-established precedent for *not* extending offline-outbox support to complex, multi-step, higher-risk operations: `PurchaseOrder`, `GoodsReceipt`, and `StockTransfer` dispatch/receive all lack offline outbox support today, with Phase 1.9's own report documenting the reasoning (these require server-side connectivity by design). Returns, credit notes, and debit notes are a comparable or higher risk category than those: each creation is a multi-entity atomic operation (an over-return quantity claim + a stock mutation + a combined journal posting + an auto-issued note, all inside one transaction), and a naive offline-outbox replay of such an operation against a since-changed server-side quantity or balance is a materially different and riskier failure mode than replaying a simple, single-entity `Sale`/`Purchase`/`Expense` creation (which the existing outbox architecture already handles safely via idempotency keys alone).

This is a considered scope decision, not an oversight: building unsafe offline behavior for financial/inventory mutations was explicitly prohibited by the task, and the existing outbox factories (`createOutbox`/`createActionOutbox`) were not extended or misapplied here to force a fit. All four new document types and every one of their actions (create, reverse, cancel, refund) require connectivity today. This is listed again as a residual limitation in Section 26 and a deferred item in Section 27, for a future phase to evaluate with dedicated design attention (e.g., a purpose-built conflict-resolution strategy for a return submitted offline against a sale whose quantity has since changed on the server).

---

## 19. Frontend

Extended, not duplicated:

- **`frontend/src/pages/sales/SalesHistory.jsx`**: a new, permission-gated (`SALES_RETURN:CREATE`) "Return" row action, distinct from the existing whole-invoice "Reverse" action already on the page. Opens a modal (fetching the sale's full detail with product names) listing each line's sold/already-returned/return-quantity, with a reason field, submitting to `POST /sales-returns`. Follows the page's existing conventions exactly (`Modal` component, `apiClient`, `extractErrorMessage`).
- **`frontend/src/pages/purchases/Purchases.jsx`**: an identical new "Return" row action (permission-gated on `PURCHASE_RETURN:CREATE`), shown only for `RECEIVED` purchases, submitting to `POST /purchase-returns`.
- **`frontend/src/pages/creditNotes/CreditNotes.jsx`** and **`frontend/src/pages/debitNotes/DebitNotes.jsx`** (both genuinely new pages — no prior UI existed for either): list with search/filter/pagination, a "+ New" standalone-creation modal, and a detail modal with permission-gated Cancel and Refund actions. Both were registered as new routes in `App.jsx` (`/credit-notes`, `/debit-notes`, each `ProtectedRoute`-gated on the matching `:VIEW` permission) and added to the sidebar navigation in `Layout.jsx`.
- No Optical/Medical-specific field, assumption, or terminology was introduced anywhere in the new UI — verified directly by an automated test asserting that an unexpected `prescriptionId` field sent to `POST /sales-returns` is silently ignored by the server and never appears on the created return.

**Testing limitation, disclosed transparently**: this environment has no browser-automation tool available, so the new pages could not be visually exercised in a live browser as the project's usual UI-verification standard calls for. In its place: (a) the existing `SalesHistory.test.jsx` suite (4 tests) was re-run and still passes unmodified after the new Return action was added; (b) `npm run build` and `npm run lint` both succeed cleanly (lint exits 0; the two new pages produce only the same pre-existing, codebase-wide `set-state-in-effect` warning style already present in every other list page, not a new class of warning); (c) the exact response shapes the new pages depend on (`GET /sales/:id`, `GET /purchases/:id`, `GET /credit-notes`, `GET /credit-notes/:id`, and their debit-note equivalents) were cross-checked line-by-line against the actual route handlers' `include`/`select` clauses to confirm every field referenced in the JSX (e.g., `line.product?.name`, `cn.salesReturn?.returnNumber`) is genuinely present in the API response. This is disclosed as a real gap in verification depth, not claimed as equivalent to a live browser check.

---

## 20. Search/Filter/Pagination

All four new list endpoints (`GET /sales-returns`, `/purchase-returns`, `/credit-notes`, `/debit-notes`) support pagination (`page`/`pageSize`, the existing shared `parsePagination` utility), status filtering, date-range filtering (`from`/`to`), a document-number `search` (case-insensitive `contains`), and the relevant party filter (`customerId`/`supplierId` for notes, `saleId`/`purchaseId`/`customerId`/`supplierId` for returns) — all additionally scoped by `branchScopeWhere` for branch-restricted users. This mirrors the exact filter-shape convention established by every prior phase's list endpoint (e.g., `expenses.routes.js`'s `GET /`).

---

## 21. Reporting

**No new dedicated aggregate report endpoint was added in this phase** — a deliberate, disclosed scope decision, not an oversight. `backend/src/modules/accounting/reports.routes.js` carries an explicit, pre-existing architectural invariant (stated in its own header comment): every report there is derived exclusively from `JournalEntry`/`JournalLine`, specifically so a report can never drift from what was actually posted to the ledger. Adding a returns/credit/debit-note summary report that read the new tables directly would have broken that invariant; deriving one purely from journal entries filtered by the new `sourceType` values was judged out of proportion to add on top of this phase's already substantial scope. In its place, the four new list endpoints (Section 20) already support filtering by date, branch, customer, and supplier — from which the specific figures the task names (returned quantities/value, refund totals) can be assembled today, just not yet as a single pre-aggregated report endpoint. This is listed as a deferred item in Section 27.

---

## 22. Security

- Every new endpoint requires authentication and an active tenant context (`authenticate`, `requireTenant`), exactly like every other module.
- Every write endpoint validates its request body with a Zod schema before touching the database; unrecognized or malformed input is rejected with `422`, never silently coerced.
- Cross-tenant access returns `404` everywhere (Section 16), never leaking existence via a `403`.
- Financial totals (`subtotal`/`tax`/`total`/`refundedAmount`) are always server-computed or server-guarded — never accepted as a trusted client value.
- **Error 1 (caught during implementation, before any test ran)**: `npm run seed:permissions` failed with `Invalid value for argument \`action\`. Expected PermissionAction.` — root cause: the initial `CREDIT_NOTE`/`DEBIT_NOTE` permission-catalog entries used `CANCEL`/`REFUND` as action names, but `PermissionAction` is a fixed Prisma enum without a `CANCEL` value. Fixed by renaming `CANCEL` → the existing `REVERSE` value (both in the catalog and the corresponding `requirePermission` calls) and adding a genuinely new `REFUND` enum value, justified as a distinct financial action not covered by any existing one.
- **Error 2 (self-caught during code review, before any test ran)**: in both `salesReturns.routes.js` and `purchaseReturns.routes.js`, the `InventoryTransaction.reference` field was initially set to the *original* `saleId`/`purchaseId` during creation (since the new return row didn't exist yet at the point the stock mutation code first ran), while the reverse handler correctly used the return's own id — an inconsistency that would have made inventory-transaction drill-down from a return inconsistent between its create and reverse legs. Fixed by restructuring both create handlers into two passes: the atomic quantity claim and stock mutation happen first (deferred into a `stockMutations` array, without creating the `InventoryTransaction` row yet), the return row is created next (producing its own id), then the `InventoryTransaction` rows are created referencing that id — identical to the reverse path's own reference.
- **Error 3 (caught during the comprehensive test suite's first run)**: a concurrent purchase-return over-return test asserted the losing request would always return `422`; it returned `409` instead. Root cause was a test-authoring assumption, not a product bug: the losing concurrent request can legitimately be rejected either at the friendly pre-check (`422`, if the two requests happen to fully serialize before either's transaction opens) or at the atomic in-transaction guard (`409`, a genuine collision) — which one occurs is a timing detail with no behavioral significance. Fixed by relaxing the test assertion to accept either status for the loser, while still asserting exactly one request succeeds and the final quantity never exceeds the original.

No other error was found during this phase's implementation or testing.

---

## 23. Regression Testing

Full backend suite (`npx jest --runInBand`, all 31 suites, no file filter), against the same `akvisionflow_phase113` database used throughout this phase:

- **Initial full-suite run**: 664 tests, 630 passed, 34 failed across 5 suites (`moduleArchitecture.test.js`, `mobileAlerts.test.js`, `mobileDashboard.test.js`, `productArchitecture.test.js`, `api.test.js`). **`returnsCreditDebitNotes.test.js` itself passed cleanly (34/34) in this same full-suite run.**
- Every one of the 34 failures traced to the same, single, previously-documented root cause: the recurring transient `Can't reach database server at 127.0.0.1:5432` connection-pool/timing flake on the Command Center dashboard's heavy multi-query aggregation endpoint (first documented in Phase 0.2, recurring intermittently in every phase since) — not to anything this phase changed. Confirmed Postgres was healthy immediately afterward (`pg_isready` responded normally); **no code was changed** in response.
- **Isolated retry of the 5 affected suites together**: 67/68 passed; only `moduleArchitecture.test.js` retained one residual failure, the identical dashboard flake.
- **Isolated retry of `moduleArchitecture.test.js` alone**: 12/12 passed, fully clean.

This is the exact same pattern (full-suite-only, isolation-clears-it) documented and disclosed in every prior phase's report; per the established protocol, both the full-suite and isolated results are reported here rather than only the passing retry.

Full frontend suite (`npx vitest run`): **136/136 tests passed across 30 files**, including the pre-existing `SalesHistory.test.jsx` re-run unmodified after this phase's Return-action addition. `npm run lint` (oxlint) exits `0` (warnings only, in the same pre-existing style already present across the codebase — no new warning category). `npm run build` (vite) succeeds cleanly.

---

## 24. Tests Added

`backend/tests/returnsCreditDebitNotes.test.js` — **34 tests**, covering: Sales Return partial/full/multiple-against-same-sale/over-return-rejection/rejection-against-a-reversed-sale; Sales Return concurrency (the task's exact 100/70/50 scenario, plus an exact-fit 40/60 scenario); Purchase Return partial/full/over-return-rejection/concurrency; standalone Credit Note and Debit Note creation with journal verification; standalone-note cancellation and its rejection when return-linked; partial refund, over-refund rejection, duplicate-refund-key idempotency, concurrent-refund over-limit prevention (both credit and debit notes); return reversal (restoring quantity/stock, cancelling the linked note), concurrent double-reversal protection, reversal rejection after a refund has occurred, and the purchase-return mirror; creation idempotency; numbering-under-concurrency (8-way); RBAC (create, reverse, refund, each for an unauthorized vs. authorized role); tenant/branch/warehouse isolation; inventory-transaction and balanced-journal-entry correctness; and an Optical/Medical-neutrality regression test.

---

## 25. Full Test Results

| Suite | Result |
|---|---|
| `tests/returnsCreditDebitNotes.test.js` (new) | **34/34 passed** |
| Full backend suite, initial run | 630/664 passed (34 failures, all the pre-existing dashboard flake — Section 23) |
| Full backend suite, isolated retry of affected files | 67/68 passed, then 12/12 on final isolated retry |
| Frontend suite (`vitest run`) | **136/136 passed**, 30/30 files |
| Frontend lint (`oxlint`) | exit 0 (pre-existing warning style only) |
| Frontend build (`vite build`) | succeeds cleanly |
| Numbering probe — SalesReturn/CreditNote, extreme (15-way) | 5 failures each, 0 duplicates, 0 server errors |
| Numbering probe — SalesReturn/CreditNote, realistic (3-way × 10) | 0 failures, 0 duplicates, 0 server errors |

---

## 26. Known Limitations

1. **Warehouse attribution-only, not stock-driving** (carried forward unchanged from Phase 1.9/1.10): `SalesReturn.warehouseId`/`PurchaseReturn.warehouseId` do not adjust a per-warehouse `WarehouseStock` row — only `Product.stockQuantity` is mutated.
2. **Proportional, not per-line, tax allocation** on partial returns (Section 9) — an approximation, disclosed, consistent with the rest of the codebase's lack of per-line tax tracking.
3. **Offline-first is not supported** for any of the four new document types or actions (Section 18) — a deliberate, disclosed decision, not an oversight.
4. **No dedicated returns/credit/debit-note aggregate report endpoint** was added (Section 21) — the underlying data is fully queryable via the new list endpoints' filters, just not yet pre-aggregated into a single summary view.
5. **Extreme-concurrency (15-way) numbering collisions remain possible** at the shared 8-retry ceiling (Section 15) — never a duplicate number or a data-integrity issue, only an outright request failure under load levels well beyond realistic single-tenant usage; this is the same pre-existing, disclosed characteristic of the shared `nextSequenceNumber` utility found in every phase since 1.11, not something newly introduced or newly discovered here.
6. **No visual, live-browser verification of the new/extended frontend pages** was possible in this environment (Section 19) — verified instead via build/lint/existing-test success and a field-by-field cross-check of API response shapes against what the new JSX references.
7. **Refund workflows are minimal by design** (Section 7): no automatic original-payment-method refund routing, no split-across-instruments refunds, no refund approval workflow.
8. **`backend/src/constants/permissionCatalog.js` was found to be untracked in git** (an incidental discovery during this phase's file-change audit, unrelated to Phase 1.13's own changes) — flagged here for visibility only; no git operations were performed on it, since the task's scope is Phase 1.13 functionality, not repository hygiene.

---

## 27. Deferred Items

- A dedicated Returns/Credit/Debit-Notes aggregate reporting endpoint (Section 21).
- A safe, purpose-built offline-outbox design for return creation specifically, if a future phase determines the business need outweighs the added conflict-resolution complexity (Section 18).
- Richer refund workflows (split refunds, automatic original-method routing, an approval threshold for large refunds mirroring the existing large-expense-threshold pattern) — none of these were requested by this phase's scope and none were built.
- Per-line tax tracking across the whole codebase (would allow exact, non-proportional tax allocation on partial returns) — a pre-existing, cross-cutting gap, not specific to this phase.
- Visual/browser-based UI verification of the new and extended frontend pages, once a browser-automation tool is available in this environment.

---

## 28. Files Changed

**Backend (new):**
- `backend/prisma/migrations/20260921060000_phase1_13_returns_credit_debit_notes/migration.sql`
- `backend/src/modules/salesReturns/salesReturns.routes.js`
- `backend/src/modules/purchaseReturns/purchaseReturns.routes.js`
- `backend/src/modules/creditNotes/creditNotes.routes.js`
- `backend/src/modules/debitNotes/debitNotes.routes.js`
- `backend/tests/returnsCreditDebitNotes.test.js`

**Backend (modified):**
- `backend/prisma/schema.prisma` — `SalesReturn`/`SalesReturnItem`/`PurchaseReturn`/`PurchaseReturnItem`/`CreditNote`/`DebitNote` models; `ReturnStatus`/`CreditNoteStatus`/`DebitNoteStatus` enums; `SaleItem.returnedQuantity`/`PurchaseItem.returnedQuantity`; `Payment.creditNoteId`/`debitNoteId`; new `JournalSourceType`/`InventoryTxnType`/`PermissionAction` enum values; back-relations on `Tenant`/`Sale`/`Purchase`/`Customer`/`Supplier`/`Branch`/`Warehouse`/`Product`/`User`.
- `backend/src/constants/permissionCatalog.js` — new `SALES_RETURN`/`PURCHASE_RETURN`/`CREDIT_NOTE`/`DEBIT_NOTE` resources (36 new grants).
- `backend/src/app.js` — mounted the 4 new route modules under `/api/sales-returns`, `/api/purchase-returns`, `/api/credit-notes`, `/api/debit-notes`.

**Frontend (new):**
- `frontend/src/pages/creditNotes/CreditNotes.jsx`
- `frontend/src/pages/debitNotes/DebitNotes.jsx`

**Frontend (modified):**
- `frontend/src/pages/sales/SalesHistory.jsx` — new permission-gated "Return" row action + modal.
- `frontend/src/pages/purchases/Purchases.jsx` — new permission-gated "Return" row action + modal.
- `frontend/src/App.jsx` — new `/credit-notes`/`/debit-notes` routes.
- `frontend/src/components/Layout.jsx` — new sidebar navigation entries.

---

## 29. Final Verdict

**PHASE 1.13 — CLOSED WITH CONDITIONS**

Justification: the core, task-mandated capability — partial/full Sales and Purchase Returns with correct, concurrency-safe over-return prevention (verified against the task's own exact worked example), automatically-issued Credit/Debit Notes with correct, non-duplicating journal posting, and refunds built entirely on the existing Payment architecture with atomic over-refund prevention — is fully implemented, thoroughly tested with real concurrent HTTP requests against a real database, and free of any known correctness defect. RBAC, tenant/branch/warehouse isolation, idempotency, and numbering all follow established, unmodified architectural precedent and are verified directly. Regression testing found zero new failures attributable to this phase's changes (the only failures observed are the long-standing, previously-documented dashboard-aggregation flake, confirmed to clear on isolated retry).

The "conditions" are the disclosed items in Section 26: offline-first is not supported for these new document types (a deliberate scope decision, not a defect); no dedicated aggregate reporting endpoint was added (existing filtered list endpoints cover the same underlying data); and the new/extended frontend pages could not be visually verified in a live browser in this environment, only through build/lint/existing-test success and a manual response-shape cross-check. None of these conditions represent an incorrect or unsafe behavior — each is a scoped, transparently-documented boundary consistent with the task's own instruction to disclose limitations rather than either silently omit them or over-build beyond what was asked.

**STOP. Phase 1.14 has not been started.** Awaiting Product Owner review of this report.
