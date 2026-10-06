# Phase 0.1 — API & Business Logic Inventory: Accounting + Procurement

Scope: `backend/src/modules/accounting/*` and `backend/src/modules/procurement/*` only. Evidence-based audit, no code changes. All line numbers refer to the file state at audit time (2026-09-17).

Mount points (`backend/src/app.js:225-233`):
- `/api/accounting/accounts` → `accounts.routes.js`
- `/api/accounting/journal` → `journal.routes.js`
- `/api/accounting/periods` → `periods.routes.js`
- `/api/accounting/tax-rates` → `taxRates.routes.js`
- `/api/accounting/reports` → `reports.routes.js`
- `/api/procurement/purchase-requests` → `purchaseRequests.routes.js`
- `/api/procurement/rfqs` → `rfqs.routes.js`
- `/api/procurement/purchase-orders` → `purchaseOrders.routes.js`
- `/api/procurement/goods-receipts` → `goodsReceipts.routes.js`

Role groups referenced below (`backend/src/constants/roles.js`):
- `TENANT_ADMIN_ONLY` = TENANT_ADMIN
- `MANAGEMENT` = TENANT_ADMIN, MANAGER
- `INVENTORY_STAFF` = TENANT_ADMIN, MANAGER, STORE_KEEPER
- `FINANCE_STAFF` = TENANT_ADMIN, MANAGER, ACCOUNTANT
- `ALL_ROLES` = every staff role

All routers apply `authenticate` (JWT, `backend/src/middleware/auth.js:8`) and `requireTenant` (`backend/src/middleware/auth.js:54`) at the router level, so every endpoint below inherits both unless noted otherwise. "Branch scope" below refers to `backend/src/middleware/branchScope.js` (`branchScopeWhere` / `assertBranchAccess`), the mechanism this codebase already uses elsewhere (e.g. `sales.routes.js`, `purchases.routes.js`) to restrict a branch-assigned STORE_KEEPER/ACCOUNTANT to their own branch(es); TENANT_ADMIN/MANAGER are always unrestricted by design.

---

## 1. Accounting — `accounts.routes.js`

Router-level: `authenticate, requireTenant, requireRole(...FINANCE_STAFF)` (line 10).

| Method | Route | Handler | Role(s) | Tenant scope | Branch scope | Validation | R/W | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | `accounts.routes.js:12` | FINANCE_STAFF | `tenantId: req.user.tenantId` (14-17) | N/A (Account has no branchId) | none (query flag only) | Read | `accounting.test.js:78` (auto-provision + RBAC) |
| POST | `/` | `accounts.routes.js:28` | MANAGEMENT | parent lookup scoped `id+tenantId` (33); create sets tenantId (37) | N/A | zod `createSchema` (21-26) | Mutation | `accounting.test.js:106` |
| PATCH | `/:id` | `accounts.routes.js:47` | MANAGEMENT | `findFirst({id, tenantId})` (51) before update | N/A | zod `updateSchema` (41-45); blocks deactivating system accounts (56-58) | Mutation | `accounting.test.js:92` |
| DELETE | `/:id` | `accounts.routes.js:64` | MANAGEMENT | `findFirst({id, tenantId})` (65) before delete | N/A | blocks system accounts, accounts with posted lines, or with children (67-72) | Mutation | not directly tested (delete path) |

## 2. Accounting — `journal.routes.js`

Router-level: `authenticate, requireTenant, requireRole(...FINANCE_STAFF)` (line 11).

| Method | Route | Handler | Role(s) | Tenant scope | Branch scope | Validation | R/W | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | `journal.routes.js:13` | FINANCE_STAFF | `where.tenantId` (18) | **None** — `branchId` is an optional *filter* query param (25), never restricted to the caller's accessible branches | pagination clamp only | Read | `accounting.test.js` reports section (indirect) |
| GET | `/:id` | `journal.routes.js:44` | FINANCE_STAFF | `findFirst({id, tenantId})` (45-46); drill-down lookups also re-scope by tenantId (60-66) | **None** | — | Read | not directly tested |
| POST | `/` | `journal.routes.js:92` | MANAGEMENT | account existence check scoped `{id: in, tenantId}` (103) | accepts arbitrary `branchId` (85) with **no `assertBranchAccess` call** | zod `createSchema`/`lineSchema` (73-87); debit-xor-credit per line (96-100); balance enforced inside `postJournalEntry` | Mutation | `accounting.test.js:340,358,534` |
| POST | `/:id/void` | `journal.routes.js:126` | MANAGEMENT | `findFirst({id, tenantId})` (127) | inherits reversal's branchId from original entry, no check | only MANUAL-sourced entries voidable (129-131) | Mutation | `accounting.test.js:370` |

**Finding J-1 (High):** No route in this file ever calls `branchScopeWhere`/`assertBranchAccess`, unlike the equivalent list/detail routes in `sales.routes.js` and `purchases.routes.js`, which do. See Security Findings §1.

## 3. Accounting — `ledger.js` (posting engine, not a router)

Not directly exposed as HTTP routes; invoked by `journal.routes.js` and by `sales/purchases/expenses/opticalOrders/procurement` routes inside the same DB transaction as the business mutation. Key functions: `postJournalEntry` (line 141), `reverseJournalEntry` (188), `ensureChartOfAccounts` (48), `assertPeriodOpen` (127). All accept `tenantId` explicitly from the caller and scope every internal lookup (`tx.account.findMany({..., tenantId})`, `tx.accountingPeriod.findFirst({..., tenantId})`) — no tenant-scope gap found here. `postJournalEntry` rejects entries with `debits != credits` (148-150) or a zero total (151-153) and enforces the closed-period check (156) — this is the actual double-entry mechanic (see Accounting Maturity §1).

## 4. Accounting — `periods.routes.js`

Router-level: `authenticate, requireTenant` (line 9); each route additionally role-gated.

| Method | Route | Handler | Role(s) | Tenant scope | Branch scope | Validation | R/W | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | `periods.routes.js:11` | FINANCE_STAFF | `where.tenantId` (12) | N/A (no branchId on model) | — | Read | `accounting.test.js:391,421` (indirect) |
| POST | `/` | `periods.routes.js:25` | TENANT_ADMIN_ONLY | create sets tenantId (30) | N/A | zod `createSchema` + start<end check (26-28) | Mutation | `accounting.test.js:391` |
| POST | `/:id/close` | `periods.routes.js:34` | TENANT_ADMIN_ONLY | `findFirst({id, tenantId})` (35) | N/A | rejects already-closed (37) | Mutation | `accounting.test.js:391` |
| POST | `/:id/reopen` | `periods.routes.js:46` | TENANT_ADMIN_ONLY | `findFirst({id, tenantId})` (47) | N/A | — | Mutation | `accounting.test.js:421` (role restriction) |

## 5. Accounting — `reports.routes.js`

Router-level: `authenticate, requireTenant, requireRole(...FINANCE_STAFF)` (line 12). All 21 reports are derived exclusively from `JournalEntry`/`JournalLine` (or, for aging/branch reports, `Sale`/`Purchase`/`Expense`), each scoped by `tenantId`.

| # | Method | Route | Handler line | Branch scope applied? | Tests |
|---|---|---|---|---|---|
| 1 | GET | `/trial-balance` | 41 | No | `accounting.test.js:431` |
| 2 | GET | `/profit-loss` | 77 | No | `accounting.test.js:445` |
| 3 | GET | `/balance-sheet` | 100 | No | `accounting.test.js:438` |
| 4 | GET | `/cash-flow` | 142 | No | not directly tested |
| 5 | GET | `/general-ledger` | 169/204 | No | not directly tested |
| 6 | GET | `/cash-book` | 223 | No | not directly tested |
| 7 | GET | `/bank-book` | 224 | No | not directly tested |
| 8 | GET | `/ar-aging` | 234 | No | `accounting.test.js:456` |
| 9 | GET | `/ap-aging` | 256 | No | not directly tested |
| 10 | GET | `/expense-summary` | 279 | No | not directly tested |
| 11 | GET | `/income-summary` | 296 | No | not directly tested |
| 12 | GET | `/sales-cost-profit` | 316 | No | not directly tested |
| 13 | GET | `/branch-profit-loss` | 331 | No (reads all branches, does not filter to caller's accessible set) | not directly tested |
| 14 | GET | `/account-transactions` | 368 (alias of #5) | No | not directly tested |
| 15 | GET | `/branch-sales` | 376 | **Yes** — `branchScopeWhere` (378) | not directly tested |
| 16 | GET | `/branch-expenses` | 395 | **Yes** (397) | not directly tested |
| 17 | GET | `/branch-receivables-payables` | 414 | **Yes** (415) | not directly tested |
| 18 | GET | `/branch-comparison` | 439 | **Yes** (442, 449, 458) | not directly tested |
| 19 | GET | `/warehouse-stock` | 487 | No (not branch-relevant per se, but no restriction either) | not directly tested |
| 20 | GET | `/stock-transfers` | 504 | No | not directly tested |
| 21 | GET | `/stock-movement-by-location` | 517 | No | not directly tested |

**Finding R-1 (Medium):** Only 4 of 21 report endpoints (#15-18) apply `branchScopeWhere`. The other 17 — including Trial Balance, P&L, Balance Sheet, General Ledger, Cash/Bank Book, AR/AP Aging — return tenant-wide financial data regardless of the caller's branch restriction, so a branch-restricted ACCOUNTANT sees other branches' full ledger detail through these reports. All require FINANCE_STAFF, so this is not exploitable by unauthenticated or unrelated-role users, and it never crosses a tenant boundary — a within-tenant, cross-branch information-disclosure gap.

## 6. Accounting — `taxRates.routes.js`

Router-level: `authenticate, requireTenant` (line 9).

| Method | Route | Handler | Role(s) | Tenant scope | Branch scope | Validation | R/W | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | `taxRates.routes.js:14` | ALL_ROLES | `where.tenantId` (16) | N/A | — | Read | not directly tested here (used implicitly by POS/purchase tests) |
| POST | `/` | `taxRates.routes.js:29` | TENANT_ADMIN_ONLY | create sets tenantId (37); default-flag reset scoped `tenantId` (35) | N/A | zod `createSchema` (22-27) | Mutation | not directly tested |
| PATCH | `/:id` | `taxRates.routes.js:50` | TENANT_ADMIN_ONLY | `findFirst({id, tenantId})` (54) | N/A | zod `updateSchema` (42-48) | Mutation | not directly tested |

---

## 7. Procurement — `purchaseRequests.routes.js`

Router-level: `authenticate, requireTenant, requireRole(...INVENTORY_STAFF)` (line 30).

| Method | Route | Handler | Role(s) | Tenant scope | Branch scope | Validation | R/W | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | `purchaseRequests.routes.js:32` | INVENTORY_STAFF | `where.tenantId` (36) | **None** | pagination + optional status filter | Read | `procurement.test.js:340` (tenant isolation only) |
| GET | `/:id` | `purchaseRequests.routes.js:52` | INVENTORY_STAFF | `findFirst({id, tenantId})` (53-54) | **None** | — | Read | `procurement.test.js:340` |
| POST | `/` | `purchaseRequests.routes.js:67` | INVENTORY_STAFF | branch/product existence checks scoped `tenantId` (73, 77) | branchId accepted with **no `assertBranchAccess`** (72-75) | zod `createSchema`/`itemSchema` (12-22) | Mutation | `procurement.test.js:68` |
| POST | `/:id/approve` | `purchaseRequests.routes.js:100` | MANAGEMENT | `findFirst({id, tenantId})` (101) | **None** | must be PENDING_APPROVAL (103) | Mutation | `procurement.test.js:83` |
| POST | `/:id/reject` | `purchaseRequests.routes.js:113` | MANAGEMENT | `findFirst({id, tenantId})` (118) | **None** | reason required (114-116) | Mutation | `procurement.test.js:83,101` |
| POST | `/:id/cancel` | `purchaseRequests.routes.js:130` | INVENTORY_STAFF | `findFirst({id, tenantId})` (131) | **None** | must be PENDING_APPROVAL/APPROVED (133) | Mutation | not directly tested |

## 8. Procurement — `rfqs.routes.js`

Router-level: `authenticate, requireTenant, requireRole(...INVENTORY_STAFF)` (line 30).

| Method | Route | Handler | Role(s) | Tenant scope | Branch scope | Validation | R/W | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | `rfqs.routes.js:32` | INVENTORY_STAFF | `where.tenantId` (36) | N/A (RFQ has no branchId) | — | Read | `procurement.test.js:340` |
| GET | `/:id` | `rfqs.routes.js:52` | INVENTORY_STAFF | `findFirst({id, tenantId})` (53-54) | N/A | — | Read | `procurement.test.js:340` |
| POST | `/` | `rfqs.routes.js:66` | INVENTORY_STAFF | purchaseRequest/product/supplier lookups all scoped `tenantId` (72, 76, 79) | N/A | zod `createSchema` (23-27) | Mutation | `procurement.test.js:122` |
| POST | `/:id/quotations` | `rfqs.routes.js:115` | INVENTORY_STAFF | `findFirst({id, tenantId})` (119) | N/A | zod `quotationSchema` (101-113); supplier must be invited (122-124); RFQ must be OPEN (121) | Mutation | `procurement.test.js:132,141` |
| GET | `/:id/compare` | `rfqs.routes.js:160` | INVENTORY_STAFF | `findFirst({id, tenantId})` (161) | N/A | — | Read | `procurement.test.js:141` |
| POST | `/:id/quotations/:quotationId/select` | `rfqs.routes.js:178` | MANAGEMENT | RFQ scoped `{id, tenantId}` (179); quotation scoped `{id, rfqId, tenantId}` (182-185) | N/A | rejects already-selected (187); creates PO in same tx | Mutation | `procurement.test.js:161,178` |

## 9. Procurement — `purchaseOrders.routes.js`

Router-level: `authenticate, requireTenant, requireRole(...INVENTORY_STAFF)` (line 35).

| Method | Route | Handler | Role(s) | Tenant scope | Branch scope | Validation | R/W | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | `purchaseOrders.routes.js:37` | INVENTORY_STAFF | `where.tenantId` (41) | **None** | pagination + status/supplierId filters | Read | `procurement.test.js:340` |
| GET | `/:id` | `purchaseOrders.routes.js:58` | INVENTORY_STAFF | `findFirst({id, tenantId})` (59-60) | **None** | — | Read | `procurement.test.js:340,355` |
| POST | `/` | `purchaseOrders.routes.js:73` | INVENTORY_STAFF | supplier/branch/product lookups scoped `tenantId` (78, 81, 85) | branchId accepted with **no `assertBranchAccess`** (80-83) | zod `createSchema` (26-32) | Mutation | `procurement.test.js:196,206` |
| POST | `/:id/approve` | `purchaseOrders.routes.js:123` | MANAGEMENT | `findFirst({id, tenantId})` (124) | **None** | must be PENDING_APPROVAL (126) | Mutation | `procurement.test.js:206` |
| POST | `/:id/reject` | `purchaseOrders.routes.js:148` | MANAGEMENT | `findFirst({id, tenantId})` (153) | **None** | reason required (149-151) | Mutation | not directly tested |
| POST | `/:id/cancel` | `purchaseOrders.routes.js:165` | INVENTORY_STAFF | `findFirst({id, tenantId})` (166) | **None** | must be DRAFT/PENDING_APPROVAL/APPROVED (168) | Mutation | not directly tested |

## 10. Procurement — `goodsReceipts.routes.js`

Router-level: `authenticate, requireTenant, requireRole(...INVENTORY_STAFF)` (line 43).

| Method | Route | Handler | Role(s) | Tenant scope | Branch scope | Validation | R/W | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | `goodsReceipts.routes.js:45` | INVENTORY_STAFF | `where.tenantId` (49) | **None** | pagination + optional `purchaseOrderId` filter | Read | `procurement.test.js` GRN section (238+) |
| GET | `/:id` | `goodsReceipts.routes.js:65` | INVENTORY_STAFF | `findFirst({id, tenantId})` (66-67) | **None** | — | Read | `procurement.test.js:251` |
| POST | `/` | `goodsReceipts.routes.js:74` | INVENTORY_STAFF | PO lookup scoped `{id, tenantId}` (87-90); PO-item membership enforced via `poItemsById` built only from that PO's own items (96-105) — a cross-tenant/cross-PO `purchaseOrderItemId` cannot smuggle a line in | inherits PO's `branchId` when posting the resulting Purchase/journal entry (131, 191), but never checks the *caller's* branch access to that PO | zod `createSchema`/`lineSchema` (27-40); over-receipt blocked (100-104); idempotency-key dedup (79-85) | Mutation (stock + ledger + Purchase creation, all one DB transaction) | `procurement.test.js:251,270,291,309,317` |

---

## Security Findings

### 1. [High] Branch-scope enforcement is absent across the entire procurement module and `journal.routes.js`
**Evidence:** None of `purchaseRequests.routes.js`, `rfqs.routes.js`, `purchaseOrders.routes.js`, `goodsReceipts.routes.js`, or `journal.routes.js` import or call `branchScopeWhere`/`assertBranchAccess` (`backend/src/middleware/branchScope.js`) — confirmed by search across `backend/src/modules/*`, which shows only `sales.routes.js`, `purchases.routes.js`, `expenses.routes.js`, `messages.routes.js`, `appointments.routes.js`, `clinical/reports.routes.js`, and `accounting/reports.routes.js` (partially, see Finding 2) using it. Specific gaps:
- `purchaseRequests.routes.js:72-75`, `purchaseOrders.routes.js:80-83` — `branchId` on create is validated only for `tenantId` membership, never for the *creating user's* branch access.
- `purchaseRequests.routes.js:36,53`, `purchaseOrders.routes.js:41,59`, `rfqs.routes.js:36,53`, `goodsReceipts.routes.js:49,66`, `journal.routes.js:18,45` — list/detail queries filter only by `tenantId`, never by the caller's accessible branch set.

**Exploit scenario:** A STORE_KEEPER (`INVENTORY_STAFF`) whose `User.branchId` is Branch A can call `GET /api/procurement/purchase-orders/:id` (or purchase-requests, RFQs, GRNs) for a Purchase Order that belongs to Branch B of the *same tenant*, and can `POST /api/procurement/purchase-orders` with `branchId` set to Branch B despite having no access grant there — something `purchases.routes.js` (the equivalent, already-received-invoice side of the same workflow) explicitly prevents via `assertBranchAccess` at line 212. Likewise, a branch-restricted ACCOUNTANT can `GET /api/accounting/journal/:id` for any branch's journal entry.

**Severity rationale:** This is a within-tenant branch-isolation break, not a cross-tenant break (every route does correctly scope by `tenantId`) — so it is High, not Critical, per the stated Critical = broken tenant isolation bar. It is nonetheless a real regression relative to the pattern the same codebase enforces one module over (Sales/Purchases), and directly contradicts the Phase 6 design comment in `branchScope.js:1-8` that non-management roles should be branch-restricted.

### 2. [Medium] 17 of 21 accounting reports bypass branch scoping
**Evidence:** `reports.routes.js` applies `branchScopeWhere` only to `/branch-sales` (378), `/branch-expenses` (397), `/branch-receivables-payables` (415), and `/branch-comparison` (442, 449, 458). All other reports — including `/trial-balance`, `/profit-loss`, `/balance-sheet`, `/general-ledger`, `/cash-book`, `/bank-book`, `/ar-aging`, `/ap-aging`, `/branch-profit-loss` — query `JournalEntry`/`JournalLine`/`Sale`/`Purchase` scoped only by `tenantId`.

**Exploit scenario:** A branch-restricted ACCOUNTANT with no visibility into Branch B can still call `GET /api/accounting/reports/trial-balance` or `/general-ledger` and see Branch B's full ledger detail, defeating the purpose of branch restriction for financial reporting.

**Severity rationale:** Read-only, requires FINANCE_STAFF role already, and stays within the tenant — an information-disclosure gap rather than a data-integrity or full-isolation break.

### No Critical (cross-tenant) findings
Every route in both modules consistently scopes single-record lookups (`findFirst`/`findUnique`), list queries (`findMany`'s `where`), and nested-resource membership checks (e.g. GRN line items resolved only from the already-tenant-scoped PO's own `items`, not from client-supplied IDs directly) by `tenantId: req.user.tenantId`. No by-id fetch or mutation in `accounts`, `journal`, `periods`, `taxRates`, `reports`, `purchaseRequests`, `rfqs`, `purchaseOrders`, or `goodsReceipts` was found missing a `tenantId` filter. This is also explicitly covered by tests: `accounting.test.js:523-544` ("Tenant isolation" — a manual journal entry cannot reference another tenant's account) and `procurement.test.js:339-364` ("tenant B cannot see or act on tenant A's purchase requests, RFQs, or POs"; "a PO cannot be created against another tenant's supplier").

---

## Accounting/Procurement Maturity

### Chart of Accounts — **Existing**
`Account` model (`backend/prisma/schema.prisma:724-755`) supports hierarchical accounts (`parentId`/`children`), 5 standard types (ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE), tenant-scoped uniqueness on `code` and `systemKey`. `ensureChartOfAccounts` (`ledger.js:48-72`) auto-provisions 18 default system accounts per tenant (Cash, Bank, AR, Inventory, Input Tax, Advance to Suppliers, AP, Tax Payable, Opening Balance Equity, Sales/Optical Revenue, COGS, General Expenses) plus one auto-created sub-account per expense category (`getExpenseCategoryAccountId`, `ledger.js:84-109`). CRUD exposed via `accounts.routes.js`, with system accounts protected from deactivation/deletion. This is a real, tenant-customizable Chart of Accounts, not a stub.

### Double-entry journal entries — **Existing**
`JournalEntry`/`JournalLine` models (`schema.prisma:775-828`) store per-line `debit`/`credit` `Decimal` columns against an `accountId`. `postJournalEntry` (`ledger.js:141-183`) is the single choke point every business mutation (Sale, Sale reversal, Purchase, Purchase return, Payment, Expense, Optical Order, manual entry) posts through, inside the same DB transaction as the business record — and it hard-rejects any entry where `sum(debit) != sum(credit)` (148-150) or where the total is zero (151-153). Reversals (`reverseJournalEntry`, 188-217) post an exact debit/credit-swapped mirror rather than editing/deleting history, and mark the original `VOID`. Reports (`reports.routes.js`) are derived exclusively from `JournalLine` rows, never from `Sale`/`Purchase` totals directly, so this is genuine double-entry mechanics, not a facade — confirmed against the schema per the audit instruction, and exercised by `accounting.test.js:122-338` (Sale/Purchase/Expense/Optical-order posting produces balanced Dr/Cr pairs).

### Accounting periods / period-close — **Existing (partial)**
`AccountingPeriod` model (`schema.prisma:830-844`) with `status` OPEN/CLOSED, `closedAt`, `closedById`. `periods.routes.js` exposes create/close/reopen, TENANT_ADMIN-only. `assertPeriodOpen` (`ledger.js:127-134`) is called from inside `postJournalEntry`, so **every** posting path (not just manual entries) is blocked from writing into a closed period. Marked **Partial** rather than fully Existing because: (a) there is no period-close accounting entry that rolls Revenue/Expense into Retained Earnings/Equity — the Balance Sheet computes "Retained Earnings (current, unclosed)" as a live derived number every time (`reports.routes.js:118-121,131`), so closing a period does not actually zero out P&L accounts the way a real close does; (b) `status` is a bare `String` field, not an enum, so there is no DB-level constraint against invalid values.

### Tax rates / tax calculation — **Partial**
`TaxRate` model (`schema.prisma:846-861`) supports named rates, inclusive/exclusive flag, default flag, tenant-scoped. `taxRates.routes.js` gives full CRUD (TENANT_ADMIN-only for writes, readable by all roles). However, tax rates are **configuration only** — there is no evidence in this scope (or in `purchaseOrders.routes.js`/`goodsReceipts.routes.js`/`rfqs.routes.js`) of the posting/ordering code looking up a `TaxRate` record and auto-computing tax from it; every `tax` field found (PO `tax`, RFQ quotation item `tax`, GRN's derived `grnTax`) is a caller-supplied or pro-rated number (e.g. `goodsReceipts.routes.js:117-119` prorates the PO's already-given `tax` by received-quantity share, it does not calculate it from a rate). There is a system `TAX_PAYABLE`/`INPUT_TAX` account pair in the Chart of Accounts and GRN posts to `INPUT_TAX` when `grnTax > 0` (`goodsReceipts.routes.js:180,186`), so the *accounting* side of tax exists, but automatic rate-based tax *calculation* tied to `TaxRate` was not found within this scope.

### Financial reports (P&L, Balance Sheet, Trial Balance) — **Existing**
All three are implemented in `reports.routes.js`, ledger-derived (not estimated from Sale/Purchase tables), and self-check their own invariants: Trial Balance reports `balanced: Math.abs(totalDebit-totalCredit) < 0.01` (73), Balance Sheet reports `balanced: Math.abs(totalAssets-(totalLiabilities+totalEquity)) < 0.01` (135). Also present beyond the requested three: Cash Flow (simplified/direct method, self-disclosed as such at line 139-141), General Ledger, Cash/Bank Book, AR/AP Aging, Expense/Income Summary, Sales-Cost-Profit, and five Branch-wise variants. Tested: `accounting.test.js:430-471`.

### Procurement workflow maturity vs. Odoo's RFQ → PO → Goods Receipt → Bill/Payment

| Stage | Exists? | Wired to next stage? | Evidence |
|---|---|---|---|
| Purchase Request (requisition) | Yes | Optional — a PR can spawn an RFQ via `RFQ.purchaseRequestId` (`schema.prisma:921-922`, set in `rfqs.routes.js:87`), but a PO can also be created directly with no PR/RFQ at all (`purchaseOrders.routes.js` comment lines 1-4: "RFQ/quotation is a capability, not a mandatory gate"). | `purchaseRequests.routes.js` full CRUD + approve/reject/cancel |
| RFQ → Supplier Quotations | Yes | Yes — quotations must reference an invited supplier on that RFQ (`rfqs.routes.js:122-124`), and selecting one auto-closes the RFQ, rejects the rest, and **auto-creates the PO** in the same transaction (`rfqs.routes.js:194-228`), carrying over totals and `sourceQuotationId` (`schema.prisma:1010-1011`). | `rfqs.routes.js:178-232`; tested `procurement.test.js:161` |
| PO → approval | Yes | Threshold-based auto-approval (`purchaseOrders.routes.js:91-95`, `rfqs.routes.js:189-192`) reading a tenant `Setting` (`purchaseApprovalThreshold`) — no threshold configured means every PO auto-approves. | `procurement.test.js:196,206` |
| PO → Goods Receipt (GRN) | Yes | Yes, tightly — GRN can only be created against an APPROVED/PARTIALLY_RECEIVED PO (`goodsReceipts.routes.js:92-94`), enforces per-line remaining-quantity caps (100-104), and rolls the PO status up to PARTIALLY_RECEIVED or RECEIVED (`goodsReceipts.routes.js:210-215`). | `goodsReceipts.routes.js` |
| GRN → Inventory update | Yes | Yes — stock is incremented **only** at GRN time, never at PO approval (explicit design comment, `goodsReceipts.routes.js:1-4`), for the *accepted* quantity only; rejected/damaged quantities are recorded but never touch `Product.stockQuantity` (`goodsReceipts.routes.js:159-176`), and an `InventoryTransaction` audit row is written per line. | `goodsReceipts.routes.js:159-176`; tested `procurement.test.js:251,291` |
| GRN → Bill (Accounts Payable) | Yes | Yes — each GRN auto-generates a `Purchase` record ("supplier invoice") reusing the existing Purchase model rather than a separate Bill table (design comment, `goodsReceipts.routes.js:5-8`), status `RECEIVED`, `amountPaid: 0`, and **posts the journal entry** Dr Inventory (+Input Tax) / Cr Accounts Payable in the same DB transaction (`goodsReceipts.routes.js:121-198`). | `goodsReceipts.routes.js:124-198`; tested `procurement.test.js:251` |
| Bill → Payment | Partial / outside this scope | Payment against the auto-created `Purchase` happens via the separate `purchases.routes.js` (`POST /purchases/:id/pay`, referenced in comment `goodsReceipts.routes.js:123`) — not part of the audited procurement module, so payment/AP-clearing mechanics were not re-verified here, but the linkage (`Purchase.purchaseOrderId`, `GoodsReceipt.purchaseId`) is intact end-to-end. | `schema.prisma:441-442,1059-1060` |

**Overall assessment:** the RFQ→PO→GRN→Bill chain is **not manual/disconnected** — it is unusually well-wired for this stage of the project: RFQ selection auto-creates the PO, GRN creation auto-creates the Bill (Purchase) and auto-posts the ledger entry, all inside single DB transactions so partial states can't be left behind. The two intentional "manual/optional" seams are (a) PR→RFQ is optional, matching Odoo's own flexibility, and (b) Bill→Payment is a separate, later, manually-triggered step (`purchases.routes.js`), same as Odoo. The main structural gap relative to Odoo is not the workflow wiring but the branch-scope enforcement gap documented in Security Finding 1, and the absence of a true period-close-to-equity step (Accounting Maturity, Periods).
