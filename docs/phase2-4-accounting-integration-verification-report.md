# Phase 2.4 — Accounting Integration & Business-Module Posting: Verification Report

**Verdict: CLOSED WITH CONDITIONS** (section 5). Phase 3.1 has **not** been started.

Test database: local portable PostgreSQL 16 (`akvisionflow_phase22`). Every run used an explicit `DATABASE_URL`; `backend/.env` (remote Neon) was not used.

## Audit (before coding) — what bypassed or weakened the ledger
Already posting through `postJournalEntry`: sales, sale reversal, `/pay`, purchases (receive/advance/pay/return), standalone payments, expenses (+reverse), sales/purchase returns, credit/debit notes, optical orders, goods receipts, sales-order conversion. Quotations, sales/purchase orders, RFQs and stock transfers correctly have no ledger effect.

**Bypassing the ledger entirely:** opening stock at product creation, product stock adjustments, direct warehouse receive / dispatch / adjust — stock (an asset) changed with no journal entry.
**Posting, but unsafe/inconsistent:** business postings did not share the journal lock (entry/receipt/note-number collisions and 409s under load); no account/branch/party validation and no double-posting guard on business postings; sale reversal / purchase return silently handed back the cash settled at creation while the payment record and balances stayed put (later payments stayed as credit — two behaviors); payments could land on a document after it was reversed; several creates answered a duplicate-key race with a 409 instead of the original result; Sale/Purchase reversal had no branch check.

## 1. Implemented
**Central posting layer (`ledger.js`, `financialTransaction.js`)** — one place, used by every business flow:
- `postJournalEntry` now validates every account/branch/customer/supplier belongs to the tenant, refuses inactive accounts (reversal mirrors exempt), and refuses a second original entry for the same sale / expense / credit note / debit note / sales return / inventory adjustment.
- The per-tenant journal lock is taken **inside** the posting (after a transaction's row claims), so entry, receipt and credit/debit-note numbers can no longer collide, and lock order is uniform (no lock cycles). `allocateReceiptNumber` / `allocateNoteNumber` use it. The earlier Phase 2.2 "lock first" calls were removed because they *could* form cycles with reversals.
- `runFinancialTransaction`: bounded retry on database-detected write conflict/deadlock (P2034) for every money/stock route.

**Inventory integration (`inventoryPosting.js`, new account 5030 *Inventory Adjustments*, enum `INVENTORY_ADJUSTMENT`)**: opening stock → Dr Inventory / Cr Opening Balance Equity; adjustments and direct warehouse receive/dispatch/adjust → Inventory vs Inventory Adjustments, valued at the product's purchase price (the basis sales use for COGS), attributed to the warehouse's branch. Services / zero-cost items post nothing; transfers between locations correctly post nothing.

**Sale reversal / purchase return** — operational balances and ledger now move together: money already collected from a known customer stays as their credit (cash is booked to the receivable, not returned), and a credit note (`reversedSaleId`, unique per sale) is issued for everything collected; purchases mirror it with a debit note (`returnedPurchaseId`). The note can be refunded (moves the cash) or applied to another invoice (Phase 2.2); it cannot be cancelled. A walk-in sale (no customer) keeps the full mirror; a prepayment cleared from Advance-to-Suppliers goes back to that asset with no note. Amounts are read after the atomic status flip.

**Concurrency/idempotency**: settlement now requires the document to still be open (a payment can no longer land after a reversal); Sale, Purchase, Expense and the four stock endpoints answer a duplicate-key race as the original result; number-collision retries raised to 15 with jitter; branch check added to sale reversal and purchase return.

**Reporting/KPIs**: reconciliation gains an informational Inventory-vs-stock-valuation block; the statement logic understands the new notes; the dashboard ledger KPIs read the same service (parity asserted).

**Offline boundary** (`frontend/src/offline/offlineBoundary.js`, enforced in the sync engine): see section 4.

## 2. Verified existing (unchanged, re-tested)
Quotation / order / RFQ flows have no accounting effect; optical order and GRN postings still work (regression suites pass); Phase 2.1–2.3 behavior intact; payment allocation, applications and statements reconcile after every transaction type.

## 3. Test results
| Check | Result |
|---|---|
| Backend full suite | **39/39 suites, 891/891 tests**, 0 connection errors |
| New backend suites | `accountingIntegration` (14) + `accountingConcurrency` (7), passed on 3 consecutive runs |
| Frontend full suite | **34 files, 174/174 tests** (+5 offline-boundary, +inventory reconciliation view) |
| Lint / Build | exit 0 / succeeds |
| Permission parity | 126 permissions / 385 grants, unchanged |
| Migration | `20260926000000_phase2_4_accounting_integration` (enum value + two unique indexes, additive); fresh-DB deploy clean, no drift |

New tests cover: opening/adjust/warehouse postings and branch attribution; Inventory ledger = stock valuation; cross-tenant account/branch/customer refusal; double-posting refusal; inactive-account refusal (atomic); paid-sale reversal → credit note → refund/apply, walk-in and unpaid cases, later-`/pay` case; purchase return → debit note and the prepayment case; reconciliation passing after sales, purchases, expenses, payments, notes, returns, adjustments and reversals combined, with dashboard KPI parity; **real concurrent HTTP**: mixed sale/purchase/expense/adjust/credit-note storm (unique numbers, one entry per document, balanced, reconciled), duplicate idempotency keys across four creates, concurrent reversal of a sale + purchase + expense (one effect each), payment-vs-reversal race, replay of every queueable operation, tenant isolation.

**Failures investigated, not dismissed:** the storm and idempotency tests initially failed with 409s — root-caused (duplicate-key races and invoice-number collisions) and fixed; a payment-vs-reversal race (payment landing after the reversal, credit note stale) reproduced and fixed; five existing tests asserted the old reversal behavior and the 18-account chart — updated deliberately with comments, not weakened; a rate-limiter cap on registrations (20 per file) made me split the suite in two.

## 4. Offline boundary (exact)
**Queueable** (idempotent + server guards): sales, purchases, expenses, payments **with explicit allocations only**, customers, suppliers, quotations, optical orders, sale reversal (atomic status flip → a replay/second device gets 409), warehouse stock moves (posted at *sync* time, valued at the cost then current).
**Never offline:** manual journals, opening balances, auto-allocated payments, payment reversal, credit/debit note apply/reverse/issue/cancel/refund, sales/purchase returns, `/pay` endpoints (generic action outbox carries no key), chart-of-accounts changes, period close.
Enforced, not just documented: the payments outbox refuses `autoAllocate` and allocation-less payloads before storing; a test pins the set of outboxes to the documented safe list so a new one cannot appear unnoticed; API-level tests prove replays change nothing.

## 5. Deferred / conditions
1. Numbering is still count-based; collisions are eliminated for payments/notes/journal entries (lock) but Sale/Purchase/Expense document numbers rely on retry (15 attempts + jitter) — safe for realistic concurrency, not a guarantee beyond ~15 simultaneous creates for one tenant.
2. Inventory valuation uses the product's **current** purchase price; changing it (or a standalone debit note) revalues stock without a movement — surfaced by the informational inventory check, not blocked. No weighted-average/FIFO costing.
3. Sales returns/purchase returns (partial) and optical orders were verified, not restructured; optical-order receivables remain outside the document subledger; per-payment-method GL accounts and due dates/terms remain deferred.
4. Legacy reversals made before this phase still carry the old cash mirror; the statement/reconciliation continue to explain them.
5. Sale reversal is queueable offline (existing, guarded); its result now includes a credit note issued at sync time.
6. Offline `Payment.paidAt` is server time at sync; a client date is not accepted (Phase 3 design item).
7. Uncommitted: all Phase 2.4 changes are in the working tree.
