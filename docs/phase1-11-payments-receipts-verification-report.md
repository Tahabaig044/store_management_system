# PHASE 1.11 — PAYMENTS & RECEIPTS: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-22
**Scope:** Customer & Supplier Payments, Receipt Generation & Numbering, Payment Allocation, Reversal, Idempotency, and Offline-First Support.
**Test database:** local, throwaway Postgres (`akvisionflow_phase111`) via the portable Postgres instance at `D:\pgsql-portable`. No production database was touched.

---

## 1. Executive Summary

Phase 1.11 began with a full audit of the existing payment architecture before writing any code. The audit found a working, tenant-scoped `Payment` ledger model already in place, but three genuine, confirmed gaps: (1) `payments.routes.js` was **read-only** — every Payment row was created only as a side effect of Sale/Purchase/Expense creation, with no standalone "record a customer/supplier payment" capability at all; (2) **Sale had no `:id/pay` endpoint** — once a sale was left PARTIAL/UNPAID at checkout, there was no way to record a later payment against it, even though Purchase already had this exact capability since Phase 5; (3) neither Purchase's existing `:id/pay` nor any Payment-creating code path had **idempotency-key support, receipt numbering, or a reversal mechanism**. All three gaps were closed additively, reusing every existing pattern (the atomic-conditional-update guard from Phase 1.8/1.9, the shared `nextSequenceNumber` utility, the existing accounting `postJournalEntry`/`reverseJournalEntry` helpers, the existing offline outbox factories) rather than building any parallel system.

Two real, previously-latent bugs were found and fixed during implementation, not merely during design: a connection-pool-exhaustion risk from calling the outer `prisma` client (instead of the transaction's own `tx`) inside a `$transaction` callback, and a genuinely invalid `JournalSourceType` value (`PAYMENT_REVERSAL` did not exist in the enum) that would have made every payment reversal fail with a 500. Both were caught by this phase's own testing before being reported here, not left for a future phase to discover.

A reproducible receipt-numbering collision was found under extreme concurrency (mirroring the exact class of bug Phase 1.8/1.9 found and locally mitigated for Sale/Purchase numbering) and was fixed the same way: a bounded retry wrapper around the whole transaction, without touching the shared `nextSequenceNumber` utility itself.

**Overall result: PHASE 1.11 — CLOSED WITH CONDITIONS.** See the Final Status section for the exact justification.

---

## 2. Scope

**In scope:** Customer & Supplier payments (standalone creation, allocation across one or more sales/purchases, auto-allocation), Sale's new `:id/pay` endpoint, idempotency on every payment-creating endpoint, payment reversal with double-reversal protection, receipt generation and numbering (including its concurrency safety), payment status/outstanding-balance correctness, search/filter/pagination, tenant/company/branch isolation, centralized RBAC, offline-first support via the existing outbox architecture, and regression against Sales/Purchase/Inventory/Accounting.

**Explicitly out of scope, per the user's instruction to audit first and never build a parallel system:** a full customer/supplier credit or advance-balance ledger (no such concept exists anywhere in the codebase today — building one would be a large, new financial primitive, not an additive extension); rewriting the shared `nextSequenceNumber` utility; rewriting Sale's or Purchase's own creation/return logic (only additive endpoints/fields were added); a new sync engine (the existing outbox factories were reused, one of them extended additively); a new frontend Payments management screen (none existed before this phase, and building one is a UI feature addition, not a payments-correctness fix — see Deferred Items).

---

## 3. Existing Payment Architecture Audit

Read in full before any change: `payments.routes.js` (55 lines, entirely read-only), the `Payment` Prisma model, `Sale`'s and `Purchase`'s payment-related code (`sales.routes.js`, `purchases.routes.js`), `customers.routes.js`'s and `suppliers.routes.js`'s history/ledger endpoints, `accounting/ledger.js` (`postJournalEntry`, `reverseJournalEntry`, `getMoneyAccountId`, `methodAccountKey`), the `PAYMENT` permission-catalog entry, and the frontend `paymentMethods.js` constant plus `syncEngine.js`.

Confirmed, not assumed:
- **`Payment` is a simple, append-only ledger row** — `direction` (IN/OUT), `amount`, `method` (a free-form string, no enum), and optional links to exactly one of `saleId`/`purchaseId`/`expenseId`/`opticalOrderId`, plus optional `customerId`/`supplierId`. It had no `status`, no numbering, no idempotency key, and no branch attribution.
- **`payments.routes.js` had only `GET /`** — no `POST`, no `PATCH`, no reversal. Its own top comment stated explicitly: "payments themselves are created as a side effect of sales, purchases, and expenses."
- **Purchase already has `POST /:id/pay`** (since Phase 5, made concurrency-safe in Phase 1.9) — an atomic conditional accumulation onto `Purchase.amountPaid`, posting a `Dr Accounts Payable / Cr Cash-Bank` (or `Dr Advance-to-Suppliers` if still DRAFT) journal entry. It had **no idempotency-key support**.
- **Sale had no equivalent `:id/pay` endpoint at all** — `amountPaid` could only ever be set once, at Sale creation time. A customer paying down a PARTIAL sale later had no API to do so.
- **Customer's `/:id/history` and Supplier's `/:id/ledger`** both compute `balanceDue` as `totalSales/totalPurchased - totalPaid`, aggregating each Sale's/Purchase's own `amountPaid` field directly — not by summing standalone Payment rows. This is the existing, working "outstanding balance" mechanism and was preserved exactly.
- **`method` is a free-form string** (no DB enum) — the frontend `PAYMENT_METHODS` constant already listed `cash`/`card`/`bank_transfer`/`other`; `cheque`/`online` were absent from the UI list only (the backend already accepted any string).
- **Accounting's `methodAccountKey`** treats anything other than the literal string `"cash"` as `"BANK"` for GL-account purposes — Card/Cheque/Online all post to the same Bank account today. This is an existing simplification, not something this phase's scope covers changing.
- **No offline outbox existed for Payment at all** — Sales, Purchases, Expenses, Customers, Suppliers, Optical Orders, and Sale Reversal all already had one; Payment did not.
- **RBAC**: the `PAYMENT` resource already existed in the centralized Phase 0.4 catalog with only `VIEW`.

---

## 4. Database Changes

Two additive migrations:

**`20260921040000_phase1_11_payments_receipts`:**
```sql
CREATE TYPE "PaymentRecordStatus" AS ENUM ('COMPLETED', 'REVERSED');
ALTER TABLE "payments" ADD COLUMN "branchId" TEXT, ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "receiptNumber" TEXT, ADD COLUMN "status" "PaymentRecordStatus" NOT NULL DEFAULT 'COMPLETED';
CREATE TABLE "payment_allocations" ( ... );
CREATE UNIQUE INDEX "payments_tenantId_idempotencyKey_key" ON "payments"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "payments_tenantId_receiptNumber_key" ON "payments"("tenantId", "receiptNumber");
-- + foreign keys: payments.branchId -> branches, payment_allocations.{paymentId,saleId,purchaseId}
```

**`20260921040001_phase1_11_payment_reversal_journal_type`:**
```sql
ALTER TYPE "JournalSourceType" ADD VALUE 'PAYMENT_REVERSAL';
```
(Generated as a second, separate migration rather than editing the first, once testing surfaced that the reversal handler needed this value — migrations are never edited after being applied, per the established convention.)

Both were verified to apply cleanly on top of the full existing migration history against a fresh scratch database before being copied into the real project. No existing column was dropped, renamed, or made non-nullable; every new `Payment` column is nullable/defaulted, so every pre-Phase-1.11 row is unaffected. `PaymentAllocation` is an entirely new, optional child table — a Payment created by any existing code path (Sale/Purchase creation, Purchase's `:id/pay`) simply has zero allocation rows, exactly as before.

---

## 5. Backend Changes

- **`sales.routes.js`** — new `POST /:id/pay` (role-gated `SALES_STAFF`, mirroring Purchase's own `INVENTORY_STAFF` gate on the equivalent endpoint): atomic conditional accumulation onto `Sale.amountPaid` (the same guard pattern as Purchase's `:id/pay`), idempotency-key support, receipt-number generation, and a `Dr Cash/Bank, Cr Accounts Receivable` journal posting — the mirror image of Purchase's own posting shape. Rejects payment against a non-`COMPLETED` (i.e. reversed) sale. The existing inline Payment creation in Sale's own `POST /` now also generates a receipt number.
- **`purchases.routes.js`** — `POST /:id/pay` gained idempotency-key support and receipt-number generation, purely additively; its existing atomic-guard logic (Phase 1.9) is unchanged. The inline Payment creation in Purchase's own `POST /` now also generates a receipt number.
- **`payments.routes.js`** — rebuilt from read-only to also support:
  - `POST /` — a standalone customer (`direction: IN`) or supplier (`direction: OUT`) payment, either explicitly split across one or more sales/purchases (`allocations`, which must sum exactly to `amount`) or auto-allocated oldest-open-invoice-first (`autoAllocate: true`). Each allocation is applied to its target's `amountPaid` via the same atomic-conditional-update pattern as Sale's/Purchase's own `:id/pay`, validated for tenant/customer/supplier ownership and branch access before being applied. Generates one receipt number for the whole payment (not per allocation) and posts one journal entry (`Dr Cash/Bank, Cr Accounts Receivable` for IN; the mirror for OUT) against the Payment's own id.
  - `POST /:id/reverse` — atomically flips `status: COMPLETED -> REVERSED` (guarded against double-reversal, identical to Sale's Phase 1.8 reversal guard), restores each allocation's effect on its target's `amountPaid`/`paymentStatus`, and mirrors the original journal entry via the existing `reverseJournalEntry` helper. **Deliberately scoped to payments that have allocation rows** (i.e., ones created via the new standalone endpoint) — a payment created inline by Sale/Purchase creation or by their own `:id/pay` posted its journal entry against that Sale's/Purchase's own id, not a Payment id, so reversing it here could not also correctly reverse the matching journal entry; such a payment is rejected with a clear 422, not silently mishandled.
  - `GET /` gained `customerId`/`supplierId` filters.
- **`products.routes.js`, `warehouses.routes.js`, `stockTransfers.routes.js`**: unchanged in this phase.

---

## 6. Frontend Changes

- **`frontend/src/constants/paymentMethods.js`** — added `cheque` and `online` to the existing `PAYMENT_METHODS` list (purely additive; the backend already accepted any string, so this only affects what the existing Purchase/Optical-Order payment modals let a user pick from).
- **`frontend/src/offline/syncEngine.js`, `db.js`, `useSyncStatus.js`** — a new `paymentsOutbox` was added (Section 11), reusing the existing `createOutbox` factory unchanged.
- No new frontend page was built. There is still no dedicated standalone "Payments" management screen — payments continue to be recorded via Sale/Purchase creation, Purchase's `:id/pay` (existing UI, unchanged), and are surfaced via Customer/Supplier history views (existing, unchanged). The new `POST /payments`/`:id/reverse`/Sale `:id/pay` capabilities are fully functional at the API level and directly tested, but no UI currently calls them — see Deferred Items.

---

## 7. Customer & Supplier Payments, Allocation, and Overpayment Handling

Directly tested: a customer payment can be split explicitly across two open sales (`allocations: [{saleId, amount}, ...]`), paying each down correctly and issuing one receipt; the same for a supplier payment across two purchases. `autoAllocate: true` applies the payment to the customer's/supplier's own open (UNPAID/PARTIAL) invoices oldest-first, verified with two sales of different ages — the older one is paid off first, with the remainder applied to the newer one.

**Overpayment handling** (explicitly requested in scope): this codebase has no customer/supplier credit or on-account balance concept anywhere (Sale and Purchase both already reject `amountPaid > total` outright, with no "credit" fallback). Building one would be a new financial primitive, not an additive extension of what exists — explicitly out of scope per the audit-first instruction. Overpayment is therefore **handled by rejection**: a payment whose amount exceeds the sum of every open invoice (auto-allocate) or the explicit allocation total is rejected with a clear 422, and — verified directly — leaves the target sale/purchase completely untouched (no partial or phantom effect). This is a documented, deliberate policy decision, not a silent gap.

Ownership is validated on every allocation: a sale/purchase must belong to the customer/supplier named in the payment (tested, 404/422 otherwise) and must be in an open, non-reversed/non-cancelled state (tested).

---

## 8. Receipt Generation & Numbering

Every Payment now carries a `receiptNumber`, generated via the existing shared `nextSequenceNumber` utility with an `RCT-` prefix — for the new standalone endpoint, Sale's new `:id/pay`, Purchase's existing `:id/pay`, and the inline Payment created by Sale/Purchase creation itself. Historical rows keep `receiptNumber: null` (nullable, additive).

**Concurrent receipt-number collision testing** (explicitly required): mirroring the exact diagnostic method used in Phase 1.8/1.9 for Sale's invoice number and Purchase's purchase number, a standalone probe issuing 15 simultaneous standalone-payment creates for one tenant reproduced a real, deterministic collision (the shared utility's own doc comment already discloses it is "not guaranteed gap-free under concurrent creates"). This was fixed the same way as Sale/Purchase: a bounded retry wrapper around the whole transaction (starting at 5 retries, raised to **8** after measurement showed Payment's collision rate under 15-way concurrency was higher than Purchase's had been, needing a larger bound to reach comparable safety). Results:
- At the original 15-way extreme-concurrency probe: failures dropped from 7/15 (5 retries) to 4/15 (8 retries) — a bounded retry is a probabilistic mitigation, not a mathematical guarantee, and this residual is disclosed rather than hidden.
- At realistic concurrency (3 simultaneous requests, 10 independent trials = 30 requests): **0 failures**.
- The automated test suite's own 8-way concurrent-create test (`tests/paymentsReceipts.test.js`) passed with zero 500s and zero duplicate receipt numbers among successes.

The shared `nextSequenceNumber` utility itself was **not** modified, consistent with the explicit instruction and the Phase 1.8/1.9 precedent.

---

## 9. Concurrency Protection — Real Concurrent-Request Test Results

All of the following used real concurrent HTTP requests via `Promise.all` against the real Express app and a real Postgres transaction — not simulated, not sequential calls.

| Scenario | Setup | Concurrent requests | Result | Final state |
|---|---|---|---|---|
| Concurrent Sale payment | Sale total=100, unpaid | pay 70, pay 60 | one 200, one 422 | amountPaid ∈ {70, 60}, never > 100 |
| Concurrent Purchase payment (sum fits) | Purchase total=100, unpaid | pay 40, pay 60 | both 200 | amountPaid=100, PAID |
| Concurrent standalone-payment double-reversal | Payment allocated 40 to a sale | reverse, reverse | one 200, one 409 | sale.amountPaid restored to 0 exactly once (not -40) |
| Receipt-numbering collision (extreme) | 15 simultaneous standalone creates | — | 11/15 succeeded, 0 duplicate numbers, 0 crashes | see Section 8 |
| Receipt-numbering (realistic) | 3 simultaneous × 10 trials | — | 30/30 succeeded | see Section 8 |

Case A (concurrent Sales, Phase 1.8) and the original Case B (concurrent Purchase receiving, Phase 1.9) were re-verified as still passing via the full, unmodified `salesManagement.test.js`/`purchaseManagement.test.js` suites in this phase's regression, not re-derived here.

---

## 10. Idempotency

Every payment-creating endpoint now accepts an optional client-generated `idempotencyKey`, backed by the existing `@@unique([tenantId, idempotencyKey])`-and-`findExistingByIdempotencyKey` pattern already used by Purchase/Sale/StockTransfer/GoodsReceipt/InventoryTransaction: Sale's new `:id/pay`, Purchase's existing `:id/pay` (a genuine, previously-missing gap, now closed), and the standalone `POST /payments`. Directly tested with real duplicate HTTP requests (submit → retry with the same key): each is deduplicated exactly once, returning `{ deduplicated: true }` and the current state, never double-applying the payment. A key used by one tenant does not falsely deduplicate a different tenant's request (tested).

---

## 11. Offline-First Payment Support

The existing outbox architecture (`createOutbox`/`createActionOutbox`, per-tenant Dexie database, client-generated idempotency keys, never-auto-resolved conflicts) already supports this cleanly — a new `paymentsOutbox` was added using the plain `createOutbox` factory unchanged (`POST /payments` is a plain "create a new top-level record" case, exactly like Sales/Purchases/Expenses). Directly tested (`syncEngine.test.js`, 4 new tests): queues with a client-generated idempotency key; syncs and stores the server's real `receiptNumber`; a 409 (e.g. overpayment) is marked `conflict`, not `failed`, and never auto-resolved; a network error leaves it `pending` for retry.

**Honest limitation**: no frontend screen calls this outbox yet (Section 6/13) — there is no standalone Payments creation UI today, online or offline. The outbox exists, is registered in the shared sync-status widget, and is fully tested at the syncEngine level, but is not yet reachable from the app's UI. This satisfies "offline-first support since the architecture supports it" at the engine level, honestly disclosed as not yet UI-connected, rather than overclaimed.

---

## 12. Payment Status & Outstanding Balance

`Sale.paymentStatus`/`Purchase.paymentStatus` (UNPAID/PARTIAL/PAID) remain the authoritative, existing status fields, correctly updated by every new code path (Sale's `:id/pay`, the standalone payment's allocations, and reversal). Customer's `/:id/history` and Supplier's `/:id/ledger` `balanceDue` computations were verified unchanged and still correct after a standalone payment (tested: a sale fully paid via a standalone payment shows `balanceDue: 0` in customer history).

---

## 13. Search/Filtering/Pagination

`GET /payments` gained `customerId`/`supplierId` filters alongside the existing `direction`/`from`/`to`, reusing the existing shared `parsePagination` utility (no duplication). Directly tested.

---

## 14. RBAC

The existing `PAYMENT` resource (previously `VIEW`-only) gained `CREATE` (granted to `CONTACTS_STAFF` — the same role group already used for Customer/Supplier CRUD, the entities a payment attaches to) and `REVERSE` (granted to `MANAGEMENT`, mirroring `SALE:REVERSE`/`PURCHASE:REVERSE`'s identical precedent exactly). Sale's new `:id/pay` uses `requireRole(...SALES_STAFF)`, mirroring Purchase's own `:id/pay` gate style precisely rather than introducing an inconsistent pattern for what is otherwise a symmetric feature; Purchase's existing `:id/pay` RBAC was deliberately left untouched (widening it to the new centralized permission would have been a behavior change, not a pure addition). Directly tested: a CASHIER can pay a sale, a STORE_KEEPER cannot (403); a RECEPTIONIST can create a standalone payment, a DOCTOR cannot (403); reversal is restricted to MANAGEMENT (403 for a CASHIER). No new permission resource was created — both actions were added to the existing `PAYMENT` resource. Verified via the full, unmodified `permissionsArchitecture.test.js` suite (all passing) plus this phase's own 5 dedicated RBAC tests.

---

## 15. Tenant/Company/Branch Isolation

Directly tested: Tenant B cannot view or reverse Tenant A's payment (404 for both); a customer payment cannot be allocated to another tenant's sale (404, not silently ignored); an idempotency key used by Tenant A never falsely deduplicates Tenant B's request (the `@@unique([tenantId, idempotencyKey])` constraint is correctly tenant-scoped). Each allocation target's branch access is checked (`assertBranchAccess`) before it is applied, using the transaction's own client (`tx`), not the outer `prisma` singleton (see Section 16 for why this distinction mattered). A standalone payment's own `branchId` is derived only when every one of its allocations shares the same branch — left `null` (visible tenant-wide, matching the existing precedent for branch-less payments) when ambiguous, rather than arbitrarily attributing it to one branch.

---

## 16. Errors Found and Fixed During This Phase (Full Disclosure)

Two genuine bugs were introduced during this phase's own implementation and caught by its own testing before being reported — disclosed here in full rather than silently corrected and omitted:

1. **Connection-pool-exhaustion risk**: the first draft of `POST /payments` called `assertBranchAccess(prisma, ...)` — the outer, non-transactional Prisma client — from *inside* a `prisma.$transaction(async (tx) => {...})` callback. Under concurrency, this can starve the connection pool (every open transaction holding one connection while trying to acquire a second for the nested call), and did in fact cause a full test-suite hang during this phase's own testing. Fixed by using the transaction's own `tx` client for that call, exactly as every other transactional handler in the codebase already does. This was caught by the test suite hanging, not silently left in.
2. **Invalid `JournalSourceType` value**: the reversal handler's first draft posted with `sourceType: 'PAYMENT_REVERSAL'`, a value that did not exist in the enum, which would have made every payment reversal fail with an unhandled 500. Caught immediately by this phase's own reversal test failing with exactly that error. Fixed by adding `PAYMENT_REVERSAL` to the enum (Section 4), mirroring the existing `SALE_REVERSAL`/`PURCHASE_RETURN` precedent of a reversal getting its own distinct, reportable source type.

Both are now covered by passing tests (`tests/paymentsReceipts.test.js`'s reversal and concurrency describe blocks) that would fail again if either regressed.

---

## 17. Sales, Purchase, and Inventory Integration

Sale's and Purchase's own creation/return/receive logic (Phase 1.8/1.9) was **not modified** beyond the additive receipt-number generation on their existing inline Payment creation (Section 5) — their atomic stock/status guards are untouched and re-verified via the full, unmodified `salesManagement.test.js`/`purchaseManagement.test.js`/`procurement.test.js` suites. Payments have no stock/inventory effect of their own (verified: no test or code path in this phase touches `Product.stockQuantity`, `WarehouseStock`, or `InventoryTransaction`) — a payment is a purely financial event layered on top of the existing Sale/Purchase amountPaid/paymentStatus fields, consistent with the existing architecture's separation of concerns.

---

## 18. Optical/Medical Regression

Directly tested: creating a standalone payment never accepts or requires any Optical/Medical-specific field (a `prescriptionId` sent in the request body is silently ignored, not persisted or echoed back). No industry-specific code path was touched.

---

## 19. Full Backend Regression

**Final full run:** 29 test suites, **609/609 tests passed, 0 failed.** An earlier run in this phase did hit the documented transient PostgreSQL connection-timing flake (24 failures across 4 unrelated test files — `ai.test.js`, `communication.test.js`, `moduleArchitecture.test.js`, `mobileAlerts.test.js` — all showing the same `Can't reach database server` signature on heavy dashboard-aggregation endpoints, seen in every phase since 0.2). Following the established diagnostic protocol: Postgres health was confirmed, no code changes were made between the failure and the retry, and all 4 files were retried together in isolation — **87/87 passed**, including every test that had failed in the full run. This is not concealed: it is reported here exactly as it happened, distinguishing the full-suite-initial result from the isolated-retry result, per the established reporting standard. The final, reported full-suite number above (609/609) is from a subsequent clean run with zero flake occurrence.

---

## 20. Full Frontend Regression, Lint, Build

- **Frontend regression**: `npx vitest run` — **29 test files, 130/130 tests passed, 0 failed** (126 pre-existing + 4 new payments-outbox tests).
- **Lint**: `npm run lint` (oxlint) — exit code 0. All output is pre-existing warning classes already present before this phase; none newly introduced.
- **Build**: `npm run build` (`vite build`) — succeeded, producing `dist/index.html`/`.css`/`.js` (734.53 kB, a negligible increase reflecting the new outbox code). The only warning is the pre-existing "chunk larger than 500kB" advisory, unrelated to this phase.
- **Permission-key parity**: `permissionsArchitecture.test.js` — passed in full (unmodified); the seeded catalog grew from 88 permissions/286 grants (Phase 1.10) to 90 permissions/294 grants, exactly the 2 new `PAYMENT` actions (`CREATE`, `REVERSE`) times their granted role counts.

---

## 21. Known Limitations

- **No customer/supplier credit or on-account balance ledger exists.** Overpayment is prevented by rejection (Section 7), not converted to a usable credit — a deliberate, disclosed scope boundary, not an oversight.
- **`POST /payments/:id/reverse` only reverses payments created via the standalone endpoint** (ones with allocation rows). A payment recorded inline at Sale/Purchase creation time, or via Purchase's own `:id/pay`, cannot be independently reversed through this new endpoint — reversing a Sale's payment is done via Sale's own `:id/reverse` (whole-sale reversal); an inline Purchase payment has no independent reversal path today, matching its pre-existing state before this phase.
- **No standalone Payments management UI exists** — the new capabilities are fully functional and tested at the API/outbox level, but no frontend screen calls `POST /payments`, `:id/reverse`, or the new `paymentsOutbox` yet. Payments continue to be recorded via the existing Sale/Purchase/Optical-Order flows and Purchase's existing "Pay" modal.
- **Card/Cheque/Online payment methods all post to the same "Bank" GL account** — an existing simplification (`methodAccountKey`), not changed by this phase, since building distinct GL accounts per method would be an accounting-engine change beyond this phase's scope.
- **Receipt-number retry is probabilistic, not absolute**, under extreme (15-way) concurrency (Section 8) — realistic concurrency is fully safe (0/30 failures across repeated trials).

## 22. Deferred Items

- A standalone Payments creation/management frontend screen.
- Wiring the new `paymentsOutbox` into that screen once it exists.
- A customer/supplier credit/advance-balance ledger, if ever required.
- Reversal support for inline (Sale/Purchase-creation-time or Purchase `:id/pay`-created) individual Payment rows.
- Distinct GL accounts per payment method (Cash vs. Card vs. Cheque vs. Online).

None of these were silently implemented; each is named here for a future phase to pick up deliberately.

---

## 23. Security Review

- Every new/modified route sits behind `authenticate` + `requireTenant` + either the centralized `requirePermission('PAYMENT', ...)` (new endpoints) or an existing `requireRole` gate mirrored from precedent (Sale's `:id/pay`).
- Every atomic guard uses `count === 0` (never a stale in-memory boolean) as the sole authoritative success/failure signal, consistent with the established pattern.
- Branch access for every allocation target is checked server-side (`assertBranchAccess`, using the transaction's own client), never trusted from the client or inferred only in the UI.
- The `idempotencyKey`/`receiptNumber` unique constraints are both correctly tenant-scoped (tested).
- No secrets, credentials, or production connection strings were introduced or logged.
- The connection-pool and invalid-enum bugs found during this phase's own testing (Section 16) were fixed before being reported, not left as known issues.

---

## 24. Acceptance Criteria Matrix

| # | Criterion | Result |
|---|---|---|
| 1 | Existing payment architecture audited before any change | PASS |
| 2 | No parallel/duplicate payment system built | PASS |
| 3 | Customer & Supplier payments (standalone creation) | PASS |
| 4 | Cash/Bank/Card/Cheque/Online methods supported | PASS |
| 5 | Partial, multiple, and full allocations | PASS |
| 6 | Overpayment handling | PASS (rejected by design, documented) |
| 7 | Payment validation | PASS |
| 8 | Tenant → Company → Branch isolation | PASS |
| 9 | Centralized RBAC/permissions | PASS |
| 10 | Atomic payment creation & allocation | PASS |
| 11 | Idempotency / client operation IDs | PASS |
| 12 | Concurrent customer/supplier payment tests | PASS |
| 13 | Duplicate submission tests | PASS |
| 14 | Payment reversal/refund | PASS |
| 15 | Double-reversal protection | PASS |
| 16 | Receipt generation & numbering | PASS |
| 17 | Concurrent receipt-number collision testing | PASS (bounded mitigation, disclosed residual at extreme concurrency) |
| 18 | Payment status & outstanding balance | PASS |
| 19 | Search/filter/pagination | PASS |
| 20 | Offline-first payment support | PASS (engine-level; not yet UI-connected, disclosed) |
| 21 | Interrupted sync / duplicate offline payment tests | PASS |
| 22 | Sales, Purchase, Inventory integration | PASS |
| 23 | Security & tenant isolation | PASS |
| 24 | New tests added | PASS (30 new backend + 4 new frontend) |
| 25 | Full backend regression | PASS (609/609 final; 1 transient flake episode disclosed) |
| 26 | Frontend tests/lint/build | PASS |

---

## 25. Final Status

**PHASE 1.11 — CLOSED WITH CONDITIONS**

Justification: every explicitly-requested capability was implemented, tested, and verified with real concurrent-request tests, mirroring the established methodology from Phase 1.8–1.10 exactly. Two genuine bugs introduced during this phase's own implementation were caught and fixed by its own testing before being reported (Section 16) — full disclosure of that process is itself evidence the verification was real, not a rubber stamp. A genuine, reproducible receipt-numbering collision was found and locally mitigated, consistent with the established, accepted precedent for this exact class of shared-utility limitation.

The CONDITIONS are:
1. **Disclosed architectural/scope boundaries**: no customer/supplier credit ledger exists (overpayment is rejected, not credited); `:id/reverse` is scoped to standalone-created payments only; no frontend UI yet calls the new standalone-payment or reversal endpoints or the new offline outbox; Card/Cheque/Online share one GL account with Bank.
2. **Receipt-number retry is probabilistic** at extreme (15-way) concurrency, though fully safe at realistic load (0/30 across repeated trials) — the same class of disclosed residual accepted for Sale's/Purchase's own numbering in Phase 1.8/1.9.

None of these conditions represent a concealed defect, a broken isolation boundary, lost money, a double-applied payment, or non-deterministic reversal behavior — each is a directly-tested, explicitly-documented, and reasonably-scoped-out limitation, consistent with the instruction to audit first, extend additively, and never silently build beyond what was asked.

---

**STOP. Phase 1.12 has not been started. Awaiting Product Owner approval before proceeding.**
