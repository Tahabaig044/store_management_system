# Phase 2.2 — Receivables, Payables & Financial Transactions: Verification Report

**Verdict: CLOSED WITH CONDITIONS** (section 9). Phase 2.3 and 2.4 have **not** been started.

Test database: local portable PostgreSQL 16 (`akvisionflow_phase22`, cloned from the Phase 2.1 database). Every run used an explicit `DATABASE_URL`; `backend/.env` (remote Neon) was never used.

## 1. Audit summary (before any change)

Read: Phase 2.1 and Phase 1.11 reports; `payments.routes.js`, Sale/Purchase `:id/pay` and reversal/return, credit/debit note routes, sales/purchase-return reversal, `customers /history`, `suppliers /ledger`, the existing `/accounting/reports/ar-aging|ap-aging`, `ledger.js`, the offline outbox engine.

What already worked: `Payment` + `PaymentAllocation` (standalone allocation, auto-allocation, receipts, idempotency, reversal, atomic `amountPaid` guards); credit/debit notes with refunds; journal posting for every document; simple document-based aging; `balanceDue` on customer history / supplier ledger.

Gaps found: no statements; aging ignored credit/debit notes and had fixed buckets only; **no way to apply a credit/debit note to an invoice/purchase** (issued credit could only be refunded); no per-party outstanding view or GL reconciliation; the defects listed in section 4.

## 2. Implemented

**Schema (one additive migration `20260925000000_phase2_2_receivables_payables_note_applications`)**: `NoteApplication` (header) + `NoteApplicationLine` (mirrors `Payment`/`PaymentAllocation`), enum `NoteApplicationStatus`, `appliedAmount` on `CreditNote` and `DebitNote`. No column dropped or changed.

**Backend (`modules/receivables/`)** — one service (`arapService.js`) parameterised for AR and AP, one router factory mounted at `/api/receivables` and `/api/payables`:
- `GET /summary` — per-party documents due, available note credit, net outstanding, **GL control-account balance and reconciliation difference**.
- `GET /customers|suppliers/:id/outstanding` — invoice/purchase-level balances, available credit notes/debit notes, GL balance.
- `GET /customers|suppliers/:id/statement?from&to` — chronological rows (invoice, payment, payment reversal, credit/debit note and cancellation, note refund, reversal of a document, ledger adjustments) with running balance, opening/closing balance, and the party's GL balance for cross-check.
- `GET /aging?asOf&buckets=30,60,90&partyId&detail` — configurable ascending-day buckets (validated), credit netted separately, invoice detail optional.
- `POST /note-applications`, `GET /note-applications[/:id]`, `POST /note-applications/:id/reverse` — apply an issued credit/debit note against one or more open documents. **No journal impact** (the note's own entry already moved AR/AP); it increases `Sale/Purchase.amountPaid`, so every existing consumer of `total − amountPaid` (dashboard, AI, portal, reports) stays correct.
- Shared primitives `settleDocument` / `releaseDocument` (atomic conditional updates, never negative / over total) now used by payments, note applications and payment reversal — no duplicated logic.

**Frontend**: new Receivables and Payables pages (`PartyBalances.jsx`, routes `/receivables`, `/payables`, sidebar entries): outstanding list with GL reconciliation notice, aging with configurable buckets/as-of, per-party panel with outstanding documents, multi-invoice allocation (record payment through the existing `POST /payments`, with per-operation idempotency key), credit/debit note application, statement with date range, and payment detail with reverse.

**RBAC**: no new permission keys. Summary/aging → `REPORT:VIEW`; statement/outstanding → `CUSTOMER:VIEW`/`SUPPLIER:VIEW`; apply → `PAYMENT:CREATE`; reverse application → `PAYMENT:REVERSE`.

## 3. Existing functionality reused (not rebuilt)
`/api/payments` (creation, allocation, auto-allocation, receipts, idempotency, reversal), Sale/Purchase `:id/pay`, credit/debit note issue/cancel/refund, `postJournalEntry`/`reverseJournalEntry`, `findExistingByIdempotencyKey` + `@@unique([tenantId, idempotencyKey])` (also used by note applications — no competing mechanism), branch-scope helpers, the offline `paymentsOutbox`. Customer/Supplier CRUD and the Journal/GL were not modified.

## 4. Bugs found and fixed
1. **Accounting integrity — standalone supplier payment on a DRAFT purchase** debited Accounts Payable, but receiving that purchase later clears an *Advance-to-Suppliers* balance that was never debited (advance negative, Payable double-debited). Now the DRAFT portion debits Advance (as Purchase's own `/pay` does); reversing such a payment after the purchase was received is refused (409) because it would credit the advance twice. Covered by tests.
2. **Concurrent duplicate `/pay` requests returned a spurious 409** (reproduced 3/3): Sale and Purchase `:id/pay` had no retry for receipt-number collisions (count-based numbering). Fixed with the bounded retry plus a per-tenant advisory lock at the start of every payment transaction (payments, sale/purchase pay, refunds, payment reversal); an idempotency-key race now answers as a duplicate instead of a 409.
3. **No branch check on Sale/Purchase `:id/pay`**, on `GET /payments/:id` and on `POST /payments/:id/reverse` — a branch-restricted user could pay/read/reverse another branch's records. Now enforced (403).
4. **Purchase `/pay` accepted RETURNED/CANCELLED purchases** → now 409.
5. **Duplicate document in one allocation set** was not rejected explicitly → now 422.
6. **Note over-consumption**: a credit/debit note refund only saw `refundedAmount`; with applications the note could be over-consumed. Refund now checks amount − refunded − applied under a row lock. Cancelling an applied note, reversing a sale/purchase (or a sales/purchase return) with an active application are refused (409).
7. **Payment reversal** now releases amounts through the guarded primitive (cannot drive `amountPaid` below zero) and in a fixed lock order (no deadlocks).
8. **Test-infrastructure**: the connection-leak fix from Phase 2.1 (central jest `afterAll` disconnect) remained effective — 0 "too many clients" errors in the final run.

## 5. Tests and exact results
- New `receivablesPayables.test.js`: **40 tests** — AR/AP balances, partial/full settlement, multi-invoice allocation, duplicate/excess/foreign/reversed-document rejections, credit & debit note application (guards, reversal, refund interplay), DRAFT-purchase prepayment accounting, payment reversal, statements (running balance, date range, reversed invoice, notes, refunds — all cross-checked against the GL), aging (default/custom buckets, asOf, per-party, detail, invalid buckets, AP), RBAC, tenant isolation, branch isolation, unchanged existing behavior, and concurrency with real parallel HTTP requests: two payments on one invoice; payment + sale-pay + note application racing for one balance; two applications of one note; refund vs application; concurrent double reversal (payment and application); duplicate idempotency keys across four endpoints; 14 parallel payments across three endpoints (receipt collision). Passed 40/40 on three consecutive runs.
- New frontend `PartyBalances.test.jsx`: **11 tests** (list/totals/reconciliation notice, AP wording, aging buckets, multi-invoice allocation payload + idempotency key, over-allocation blocking, note application, permission gating, statement + payment reversal gating, error surfacing).
- Existing Phase 1.11 suite (`paymentsReceipts`, 26 tests), Phase 2.1 suites, returns/credit/debit suite, sales/purchase suites all pass unchanged.

## 6. Regression results
| Check | Result |
|---|---|
| Backend full suite | **36/36 suites, 848/848 tests**, 0 connection errors |
| Frontend full suite | **33 files, 162/162 tests** |
| Lint | exit 0 (pre-existing warning classes only) |
| Build | succeeds (existing chunk-size advisory) |
| Permission-key parity | 126 permissions / 385 grants, unchanged (no new keys); `permissionsArchitecture.test.js` passes |
| Fresh migration | `migrate deploy` of the full history on an empty DB succeeds; `migrate status` up to date; `migrate diff` shows no drift |

**Failures investigated during the phase (none classified as flake without evidence):**
- Phase 1.11 test "supplier payment split across two purchases" failed after my first fix (which rejected DRAFT purchases) — a real regression from my change, not an environment issue; replaced by the Advance-account fix, suite 26/26.
- `duplicate requests with one idempotency key` failed intermittently once, then 3/3 in isolated reruns with the HTTP body showing `409 "A record with these details already exists"` on `/pay` — root-caused (defect 2), fixed, 3/3 green and stable across later runs.
- The parallel-payment test failed twice with the same 409 at 14-way concurrency; root-caused to count-based receipt numbers under a high collision rate, fixed with the advisory lock, then 3/3 green.
- Two test-authoring errors (a bucket expectation, and a statement expectation that exposed the reversal behavior in §8) were fixed in the test/statement, not dismissed.

## 7. Accounting implications
- Invoice/purchase → existing entries (unchanged). Customer payment: Dr Cash/Bank, Cr AR. Supplier payment: Dr AP (received purchase) or Dr Advance-to-Suppliers (DRAFT), Cr Cash/Bank. Payment reversal: mirror entry (existing helper).
- Credit/debit note issue: existing entry (Dr Revenue/Tax, Cr AR; mirror for AP). **Application: no journal entry** — allocation only. Refund: existing entry (Dr AR, Cr Cash).
- The statement and summary reconcile the document view to the GL control account per party (customer/supplier id on journal lines); every standard flow ties exactly (asserted in tests). The reported reconciliation difference surfaces anything outside the document set (see limitations).

## 8. Offline analysis (engine not built; nothing added that blocks Phase 3)
Existing outboxes audited: `paymentsOutbox` (`POST /payments`, client idempotency key, 409 → `conflict`, other 4xx → `failed`, never auto-resolved), customers/suppliers outboxes (create only). No new outbox or queued operation was added.

| AR/AP operation | Offline |
|---|---|
| Explicit-allocation payment (`POST /payments` with `allocations`) | **Safe** — idempotent; a stale balance yields a 422 `failed` entry the user resolves; guards make corruption impossible |
| Payment with `autoAllocate` | **Unsafe blindly** — the documents it settles are decided by server state at sync time, not what the user saw |
| Sale/Purchase `:id/pay` | Server supports keys, but the generic action outbox sends none → **unsafe until keys are carried** |
| Payment reversal, note application/reversal, credit/debit refund, note cancel | **Unsafe** — depend on live balances and note availability; server-authoritative |
| Statements, aging, outstanding, summary | Read-only, computed live; an offline copy is stale by definition |
| Also for Phase 3 | `Payment.paidAt` is server time at sync (no client date accepted), so an offline payment is dated at sync time — statements/aging would shift |

## 9. Known limitations, conditions and deferred items
Conditions/limitations:
1. **Aging `asOf` changes document age only**; amounts due are current balances, not reconstructed as of that date (no payment history snapshot).
2. Aging/statement age is measured from the document date; the codebase has no due-date/terms field.
3. **Optical orders** (which also debit AR) are not part of the sale-based documents; the reconciliation difference will show them. Opening AR/AP balances and manual entries tagged to a party appear in the statement as ledger adjustments only when tagged with the party.
4. No customer/supplier advance/on-account balance (unchanged Phase 1.11 policy): overpayment is rejected; the only credit instruments are credit/debit notes.
5. Inline payments (recorded inside Sale/Purchase creation or `/pay`) still cannot be reversed individually (unchanged).
6. Numbering serialization covers the payment paths I touched; Sale/Purchase *creation* and other receipt creators still use the retry-only mitigation.
7. Uncommitted work: all Phase 2.2 changes are in the working tree.

Deferred to Phase 2.4 (integration): **Sale reversal / purchase return mirror the entire original entry including cash settled at creation while leaving the Payment row and `amountPaid` unchanged** (later `/pay` payments are kept as customer credit) — the two behaviors are inconsistent; the statement shows the returned amount explicitly (`SETTLEMENT_RETURNED`) so it still ties to the GL, but the underlying behavior should be unified. Also: reversing a sales/purchase return cancels a *refunded* note (only the direct cancel endpoint forbids that); sale reversal lacks a branch check; optical-order receivables; `PAYMENT` entries use the sale/purchase id as `sourceId` for `/pay` payments vs the payment id for standalone ones; distinct GL accounts per payment method; due dates/terms for aging.
