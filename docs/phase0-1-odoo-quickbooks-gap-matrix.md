# Phase 0.1 — Odoo / QuickBooks Capability Gap Matrix

Per spec §13: comparing capabilities, not implementation details, to identify business-critical gaps for the intended "Odoo/QuickBooks alternative for SMBs" positioning. Status values: Existing / Partial / Missing / Not Yet Planned / Industry-Specific. No parity is claimed without direct implementation+test evidence — see the linked domain documents for citations.

## QuickBooks-oriented areas

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Chart of Accounts | **Existing** | `Account` model, hierarchical, 5 types, `accounts.routes.js` full CRUD | Auto-provisions 18 default accounts per tenant + one per expense category. Real, tenant-customizable, not a stub. |
| Double-entry accounting (journal, Dr/Cr) | **Existing** | `JournalEntry`/`JournalLine`, `postJournalEntry` hard-rejects unbalanced/zero entries | Genuine mechanics — every business mutation posts through one choke point in `ledger.js`; reports are ledger-derived, not estimated. |
| Accounts Receivable (A/R) | **Existing** | `Sale.paymentStatus`, `Payment` (direction IN), AR Aging report | Aging report exists (`/ar-aging`); tracked at customer level via `JournalLine.customerId` sub-ledger dimension. |
| Accounts Payable (A/P) | **Existing** | `Purchase.paymentStatus`, `Payment` (direction OUT), AP Aging report, GRN auto-posts AP entry | Same mechanism, supplier side. |
| Invoicing | **Existing** | `Sale` (POS invoice), `Purchase` (supplier bill via GRN auto-generation) | No separate customer-facing "Invoice" document type beyond the Sale record itself — acceptable for a POS-centric SMB tool but not a full standalone invoicing module (e.g. no recurring invoices). |
| Expenses | **Existing** | `Expense`/`ExpenseCategory`, auto-posts to a mapped Account, branch-scoped, threshold-gated approval | Full coverage. |
| Banking / bank feeds | **Missing** | No `BankAccount`/bank-feed/reconciliation-import model found anywhere in `schema.prisma` | Cash/Bank are plain Chart-of-Accounts entries (`ensureChartOfAccounts`); no bank statement import or auto-matching exists. |
| Reconciliation | **Missing** | No reconciliation workflow/model found | Related to Banking gap above — no "match transaction to bank line" feature exists. |
| Taxes (calculation) | **Partial** | `TaxRate` model + CRUD exists; no code path found that looks up a `TaxRate` and auto-computes tax during Sale/PO/GRN posting | Every `tax` value found in Sale/PO/GRN is caller-supplied or pro-rated, not rate-calculated. The accounting *side* of tax (Input Tax/Tax Payable accounts) exists and is posted to correctly. |
| Financial reports (P&L, Balance Sheet, Trial Balance) | **Existing** | `reports.routes.js` — all three self-verify their own balance invariants | Also includes Cash Flow (simplified/direct), General Ledger, Cash/Bank Book, Income/Expense Summary — broader than the minimum ask. |
| Multi-currency | **Missing** | No currency field found on any monetary model in `schema.prisma` (all amounts are plain `Decimal`) | Single-currency system currently; a real gap for any tenant operating across currencies. |
| Customer statements | **Partial** | `TemplateType.CUSTOMER_STATEMENT` exists as a message-template type; no dedicated "generate statement" report/document endpoint was found in this audit's scope | The template exists for *sending* a statement but the underlying statement-generation logic wasn't located — flagged Unknown—Requires Inspection rather than assumed Missing outright. |

## Odoo-oriented areas

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Accounting | **Existing** | See QuickBooks section above | Same underlying system covers both comparisons. |
| Sales (quotation → order → invoice) | **Partial** | POS `Sale` is direct sale-to-invoice; no distinct "Sales Order" or "Quotation" stage before a Sale is recorded (the RFQ/Quotation concept exists only on the *procurement* side, not sales) | A retail POS doesn't need a quotation stage, but a B2B/services SMB using this as an Odoo alternative would find no sales-side quote-to-order pipeline. |
| Purchase (RFQ → PO → Receipt → Bill) | **Existing** | Full chain implemented and well-wired (RFQ selection auto-creates PO; GRN auto-creates Bill + posts ledger) | See Accounting/Procurement API map for the stage-by-stage wiring table. |
| Inventory | **Existing** | `InventoryTransaction` ledger, `Warehouse`/`WarehouseStock`, `StockTransfer` | Solid append-only ledger pattern; branch-scoping gap noted separately (see Refactoring Backlog), not a capability gap. |
| POS | **Existing** | `Pos.jsx` + `sales.routes.js`, offline-capable | Real POS with offline-first sync via IndexedDB/Dexie outbox. |
| CRM | **Partial** | `Customer` entity + history/ledger view exists; no lead/opportunity/pipeline model, no sales-activity tracking, no CRM-specific workflow | What exists is "customer master data + transaction history," not a CRM pipeline. |
| Expenses | **Existing** | See QuickBooks section | — |
| HR | **Partial** | `User` carries `role`/`branchId`; no employee-record concepts beyond login accounts (no attendance, leave, payroll structure, org chart) | Effectively "user accounts with roles," not an HR module. |
| Payroll | **Missing** | No payroll-related model or route found anywhere in scope | Not started. |
| Projects | **Missing** | No project/task/milestone model found | Not started. |
| Documents (DMS) | **Missing** | No generic document-storage/versioning model found (beyond message templates and audit logs) | Not started. |
| Helpdesk | **Missing** | No ticket/case model found | The Communication module's "follow-up request" (customer portal → staff notification) is a narrow substitute, not a helpdesk system. |
| Appointments | **Existing (Industry-Specific)** | `Appointment` model, full booking/status/conflict-detection workflow | Currently implemented specifically for the clinic vertical (patient/doctor-keyed); the booking *shape* itself is generic and reusable but not abstracted as a standalone Appointments module today. |
| Subscriptions | **Not Yet Planned** | `Subscription` model exists but is explicitly "foundation only, no billing UI yet" per the DB audit | Placeholder for future tenant billing, not a customer-facing subscription/recurring-revenue feature. |
| eCommerce | **Missing** | No storefront/online-catalog/checkout model found | Not started; out of current scope. |
| Manufacturing (BOM/work orders) | **Missing** | No bill-of-materials or work-order model found | The optical "lab job" workflow (`OpticalOrder`/`Lab`) is a narrow, industry-specific analog to a work order, not a general manufacturing module. |

## Overall assessment

AK VisionFlow's **accounting and procurement cores are genuinely comparable** to Odoo/QuickBooks at this stage — real double-entry bookkeeping and a well-wired procurement chain are not common to find this solid pre-Phase-2. The **biggest capability gaps for the stated positioning** are: no banking/reconciliation, no multi-currency, no rate-based tax calculation, no CRM pipeline, no payroll/projects/documents/helpdesk, and no eCommerce/manufacturing. Sales-side quotation-to-order flow and a standalone Appointments module (as opposed to the clinic-specific implementation that exists today) are the two gaps most directly relevant to broadening beyond the optical vertical. None of this should be read as a criticism of Phase 0–1 scope — these are exactly the kind of gaps Phase 0.1 exists to surface factually before Phase 2 (Universal Product Architecture) and later phases plan around them.
