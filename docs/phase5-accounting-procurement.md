# Phase 5 — Complete Accounting + Professional Procurement

This document covers the architecture, integration points, and known
limitations of the Phase 5 accounting and procurement subsystems. It
supplements `README.md` and `docs/phase4-operations-runbook.md`.

## 1. Accounting Architecture

A real double-entry ledger, not a reporting layer bolted onto existing
tables. Every accounting effect flows through one function:
`postJournalEntry()` in `backend/src/modules/accounting/ledger.js`, called
inside the *same database transaction* as the business mutation it
accompanies (a Sale, a Purchase receipt, an Expense, an Optical Order
payment, a GRN). If either half fails, both roll back together — a Sale can
never exist without its journal entry.

### Chart of Accounts

A default chart is auto-provisioned per tenant, lazily, the first time
anything needs to post (no manual setup step required for existing
tenants). Sixteen default accounts across Assets, Liabilities, Equity,
Revenue, and Expense, each tagged with a stable internal `systemKey` (e.g.
`CASH`, `ACCOUNTS_RECEIVABLE`) that the posting engine uses to find "the
Cash account" regardless of what a tenant later renames it to. System
accounts can be renamed but never deactivated or deleted. Custom accounts
(and one auto-created sub-account per Expense Category) can be added freely.

### Journal Entries

Every entry has a source (`SALE`, `PURCHASE`, `EXPENSE`, `OPTICAL_ORDER`,
`PAYMENT`, `MANUAL`, etc.) and, where applicable, a `sourceId` pointing back
to the originating record — `GET /api/accounting/journal/:id` follows that
link and returns the actual Sale/Purchase/Expense/Optical Order row
alongside the entry, satisfying the "every posting must be traceable"
requirement. Corrections are never edits or deletes: `reverseJournalEntry()`
posts an exact mirror (debit↔credit swapped on every line) and marks the
original `VOID` — both remain visible forever.

### Posting rules implemented

| Event | Effect |
|---|---|
| Sale | Dr Cash/Bank + Dr Accounts Receivable (split by amount paid), Cr Sales Revenue (net of discount), Cr Tax Payable; Dr COGS / Cr Inventory for the cost of goods sold |
| Sale reversal | Exact mirror of the original entry |
| Purchase (received immediately) | Dr Inventory + Dr Input Tax Recoverable, Cr Cash/Bank + Cr Accounts Payable (for whatever isn't paid) |
| Purchase (DRAFT, paid in advance) | Dr Advance to Suppliers, Cr Cash/Bank at creation; on later receipt, Dr Inventory/Input Tax, Cr Accounts Payable (full total), then Dr Accounts Payable / Cr Advance to Suppliers to clear the prepayment |
| Purchase payment (`/pay`) | Dr Accounts Payable, Cr Cash/Bank (or Dr Advance to Suppliers, Cr Cash/Bank if the purchase is still DRAFT) |
| Purchase return | Exact mirror of the original purchase entry. If the purchase was already paid, Accounts Payable for that supplier legitimately goes negative — the correct signal that the supplier now owes a refund, not a bug |
| Expense | Dr the expense's own category account (auto-created), Cr Cash/Bank |
| Optical Order (create + pay) | Dr Cash/Bank + Dr Accounts Receivable, Cr Optical Order Revenue; later payments Dr Cash/Bank, Cr Accounts Receivable |
| GRN | Same as "Purchase received", scoped to only the *accepted* quantity for that shipment; rejected/damaged quantities never post |

**Known limitation, disclosed rather than silently omitted:** Optical Order
*cancellation* does not currently reverse its accounting entry — this is
pre-existing Phase 1–4 behavior (cancelling an order was never wired to
reverse its payment either) and inventing a new business rule for it was
judged out of this phase's scope. Flagged as a follow-up.

### Accounting Periods

`AccountingPeriod` rows (TENANT_ADMIN-only to create/close/reopen) make
historical postings immutable: any attempt to post a journal entry dated
inside a `CLOSED` period is rejected with 409, tested explicitly.

### Tax

`TaxRate` is a plain configurable list (name, percentage, inclusive/exclusive,
default flag) — never hard-coded. `Sale.tax` and the new `Purchase.tax`
remain plain amount fields (as `Sale.tax` always was), so the frontend can
compute the amount from a selected rate without any backend contract
change. `Tenant.ntn`/`Tenant.strn` are optional foundation fields for future
FBR/e-invoicing integration — no actual FBR integration is implemented.

## 2. Financial Reports

All under `/api/accounting/reports/*`, all derived exclusively from
`JournalLine`/`JournalEntry` (never re-derived from Sale/Purchase totals
directly, so a report can never drift from what was actually posted):
Trial Balance, Profit & Loss, Balance Sheet, Cash Flow (simplified/direct
method — disclosed as such, not a full indirect-method statement), General
Ledger, Cash Book, Bank Book, AR Aging, AP Aging, Expense Summary, Income
Summary, Sales vs Cost vs Gross Profit, Branch-wise P&L, and Account-wise
Transactions (an alias of General Ledger, since the phase spec lists them
as separate report names). Customer Ledger and Supplier Ledger already
existed (Phase 3 customer/supplier history endpoints) and were left as-is
rather than duplicated.

## 3. Procurement Lifecycle

`Purchase Request → RFQ → Supplier Quotations → Comparison → Approval →
Purchase Order → Goods Receipt (GRN) → Inventory → existing Purchase/Payment
→ Supplier Ledger`

Deliberate architectural choice: **GRN receiving auto-generates the
existing `Purchase` record** (reusing its stock-increase, payment, and
ledger-posting logic) rather than inventing a parallel "supplier invoice"
table — per the phase's explicit instruction to integrate with existing
IDs/records instead of duplicating core entities. A `Purchase` created this
way carries `purchaseOrderId`, so a PO's full receiving history (one or
more partial shipments) is always visible via `GET
/api/procurement/purchase-orders/:id`.

- **Approval thresholds** are configurable per tenant via the existing
  `Setting` key/value table (`purchaseApprovalThreshold`) — with none set,
  every PO auto-approves, keeping the default workflow simple for a small
  shop; set one and POs above it require `TENANT_ADMIN`/`MANAGER` approval
  before they can receive anything.
- **Partial/short/damaged receiving**: each GRN line records accepted,
  rejected, and damaged quantities separately; only the accepted quantity
  ever touches stock or cost. A PO can receive across multiple GRNs and
  rolls up to `PARTIALLY_RECEIVED` or `RECEIVED` automatically.
- **Duplicate prevention**: GRN creation accepts an `idempotencyKey` (same
  pattern as Sale/Purchase/Customer/Supplier) — a retried submission is
  deduplicated, not double-counted, tested explicitly.
- **Purchase returns**: `POST /api/purchases/:id/return` reverses a whole
  received purchase's stock and accounting effect.

**Known limitation:** quotation "configurable criteria" is implemented as
lowest-total-price (the default, always-computed recommendation) plus a
separately-surfaced fastest-delivery figure — a full weighted multi-criteria
scoring system was judged out of scope for this pass. Supplier performance
metrics (average delivery time, price trend, profitability) are **not**
implemented as dedicated endpoints this phase; `purchasePriceChanges` in the
Command Center response is the one price-trend signal that did get built.

## 4. Command Center Integration

`GET /api/dashboard/command-center` gained two new, additive top-level
keys (existing keys are unchanged, so nothing that reads the Phase 4 shape
breaks):

- `accounting`: `cashBalance`/`bankBalance` (a real running ledger balance,
  distinct from the existing `kpis.cash`/`kpis.bank` *period-movement*
  figures), `receivablesOverdue`/`payablesOverdue` (>30 days).
- `procurement`: `pendingApprovals`, `pendingPurchaseOrders`,
  `pendingGoodsReceipts`, `supplierPaymentCommitments`,
  `purchasePriceChanges` (top 10 by % change), and a `pipeline` list of
  in-flight POs for drill-down.

## 5. Frontend Coverage — what has a screen vs. what is API-only

Given the scope of this phase, backend correctness and test coverage were
prioritized over building a screen for every one of the ~30 new endpoints.
**Every endpoint below is implemented, tested, and reachable via the API**
regardless of whether it has a dedicated page yet:

| Has a frontend page | API-only (tested, no dedicated screen yet) |
|---|---|
| Chart of Accounts (view) | Chart of Accounts create/edit/delete |
| Journal (view) | Manual journal entry creation/void |
| Trial Balance, P&L, Balance Sheet, AR/AP Aging | Cash Flow, Cash Book, Bank Book, Expense/Income Summary, Sales-Cost-Profit, Branch P&L, Account Transactions |
| Purchase Requests (create/approve/reject) | — |
| Purchase Orders (create/approve/reject) | RFQ creation, supplier quotation entry, quotation comparison/selection |
| Goods Receipts (create against an approved PO, with accept/reject/damaged quantities) | Accounting periods management (create/close/reopen), tax rate management |

## 6. Migration & Data Safety

One migration, `20260912064557_phase5_accounting_procurement` — purely
additive (new tables; two new nullable columns on `Purchase`; one new
`PurchaseStatus` enum value `RETURNED`; one new `InventoryTxnType` enum
value `PURCHASE_RETURN`). Verified against a disposable database with
`prisma migrate deploy`; **not yet applied to production** — this is a
deployment precondition, not something done automatically (see the Phase 5
final report). No historical data was back-posted or fabricated: existing
tenants simply have an empty ledger until their first post-Phase-5
transaction, which is the honest state of affairs — inventing historical
journal entries for pre-Phase-5 activity was explicitly out of scope
("never silently fabricate financial history").

## 7. Testing

139 new/existing backend tests pass (24 in `tests/accounting.test.js`, 17 in
`tests/procurement.test.js`, plus the full pre-existing 95 unaffected), and
43 frontend tests (4 new). See the Phase 5 final report for the complete
breakdown and what each new test actually verifies (not just status codes —
real account balances, e.g. "a $100 cash sale posts exactly $60 to COGS/
Inventory for goods costing $30 each").
