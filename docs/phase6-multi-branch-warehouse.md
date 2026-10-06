# Phase 6 — Multi-Branch + Warehouse + Advanced Business Control

Supplements `README.md`, `docs/phase4-operations-runbook.md`, and
`docs/phase5-accounting-procurement.md`.

## 1. Organization Structure & Design Decisions

`Tenant → Branches → Warehouses → Users`. Branch already existed
(Phase 1, extended in Phase 4 with `branchId` on Sale/Purchase). Phase 6
**extends** it rather than duplicating it, per the migration guidance:

- `Branch` gained `code` and `isOpen` (additive) — no new model needed.
- `Warehouse` is a new, genuinely distinct concept: a *stock location*,
  optionally tied to a branch (`branchId` nullable) so central/head-office
  warehouses are representable without forcing every tenant to have one.

### The most consequential design decision: what happens to `Product.stockQuantity`

Before Phase 6, stock was a single tenant-wide number per product, read
directly in well over a dozen places (POS stock checks, all reports, the
Command Center, accounting COGS). Rebuilding all of that around a
warehouse-scoped model would have meant touching most of the existing core
— explicitly against this phase's own rule ("do not rebuild the existing
core"). Instead:

- **`Product.stockQuantity` keeps its exact pre-Phase-6 meaning**: the
  tenant-wide authoritative total. Every existing read of it (Sales,
  Reports, Command Center, accounting) is completely unaffected and
  required zero code changes.
- **`WarehouseStock` is new and additive**: a per-warehouse breakdown, kept
  in perfect sync with `Product.stockQuantity` by a single chokepoint
  function, `adjustWarehouseStock()` in `warehouseStock.js` — every
  warehouse-scoped stock change (direct receive/dispatch/adjust, or a stock
  transfer's dispatch/receive) goes through it, applying the same delta to
  both numbers atomically in one transaction. The two figures can never
  drift apart.
- **Migration safety without a bulk script**: per the phase's explicit
  instruction ("assign existing stock to an explicitly chosen/default
  location without silently losing quantities"), this happens *lazily*,
  the same pattern that worked well for Phase 5's Chart of Accounts: the
  first time any product is asked about at a specific warehouse
  (`ensureWarehouseStock()`), if it has no `WarehouseStock` row anywhere
  yet, its **full existing** `Product.stockQuantity` is assigned to the
  tenant's default warehouse (auto-created on first use, tied to the
  tenant's main branch if one exists). Verified explicitly in
  `tests/multiBranch.test.js`: a product's pre-existing stock shows up
  intact at the default warehouse, and `Product.stockQuantity` is
  unchanged by that assignment (nothing is duplicated or lost).
- **A tenant that never visits a warehouse screen is completely
  unaffected** — no warehouse, no `WarehouseStock` row, is ever created
  until something asks for one. This satisfies "do not force users to
  configure unnecessary warehouses."

## 2. Stock Transfer Lifecycle

`Request → Approval (where required) → Dispatch → In Transit → Receive →
Completed`, implemented as `StockTransfer`/`StockTransferItem`. Concretely:

- **Dispatch** is the only point source stock decreases (the full
  requested quantity), and only from `APPROVED`.
- **Receive** is the only point destination stock increases, only from
  `IN_TRANSIT`, and only for the *accepted* quantity per line — `short`
  and `damaged` quantities are recorded on the line but never added to
  stock.
- **Idempotency**: the state-machine guards (`dispatch` only from
  `APPROVED`, `receive` only from `IN_TRANSIT`) make a retried dispatch or
  receive call safe by construction — the second attempt is rejected
  (409), not double-applied. Transfer *creation* additionally accepts an
  `idempotencyKey` (same pattern as Sale/Purchase/GRN) for a retried
  create request specifically.
- **Approval threshold**: configurable via the existing `Setting` table
  (`transferApprovalThreshold`, valued against dispatched quantity × the
  product's purchase price) — with none set, transfers auto-approve,
  keeping the default workflow simple.
- **No false revenue**: a transfer never touches the accounting ledger at
  all — it posts `InventoryTransaction` rows (`TRANSFER_DISPATCH`/
  `TRANSFER_RECEIVE`) but no `JournalEntry`. Verified explicitly: no
  `SALE`-sourced journal entry ever references a transfer's id.

## 3. Branch-Level Authorization (backend-enforced)

New `backend/src/middleware/branchScope.js`, used by Sales, Purchases, and
Expenses (list, detail, and create):

- `TENANT_ADMIN`/`MANAGER` are **never** restricted ("Tenant Admin/Owner may
  access all branches" / "Managers may have branch-wide permissions").
- Any other role is restricted **only once they actually have a branch
  assigned** (`User.branchId` and/or the new `UserBranchAccess` many-to-many
  table for additional branches). A staff member with no branch assignment
  at all sees tenant-wide data exactly as every role did before Phase 6.
- This design choice is what makes the change **fully backward compatible**:
  every existing test creates non-admin users without a `branchId`, so
  none of them are newly restricted — confirmed by the full pre-existing
  regression suite passing unchanged (167/167 including all Phase 1–5
  tests). The new restriction only activates for the new scenario this
  phase explicitly tests: a cashier *assigned* to a specific branch.
- Enforcement is real, not UI-only: a restricted user's direct `GET
  /api/sales/:id` for another branch's sale returns 404 (not just filtered
  from lists), and creating a sale/purchase/expense for a branch they
  don't have access to returns 403 — both tested by calling the API
  directly with the wrong role/branch, not by checking what the UI shows.

## 4. Approval & Control Workflows

| Workflow | Implementation |
|---|---|
| Purchase approval | Already existed (Phase 5) — unchanged |
| Inter-branch transfer approval | New, genuine queued request→approve (see §2) |
| Stock adjustment approval | Inline threshold enforcement (`stockAdjustmentApprovalThreshold` Setting) — a non-MANAGEMENT user's adjustment above the value-threshold is rejected (409) |
| Large expense approval | Inline threshold enforcement (`largeExpenseThreshold`) |
| Large discount approval | Inline threshold enforcement (`largeDiscountThreshold`) |
| Manual accounting adjustment approval | Already MANAGEMENT-only (Phase 5) — unchanged |

**Design choice, disclosed deliberately:** stock adjustment/large
expense/large discount use *inline* threshold rejection rather than a
queued multi-step request-then-approve flow. A full queue would mean a
cashier's checkout or a stock count correction sits "pending" mid-action —
workable for a Purchase Order (not time-critical) but a poor fit for a
point-of-sale discount or an on-the-spot stock count. Backend enforcement
is still real and cannot be bypassed via direct API call (all three are
tested that way), which is the acceptance criterion actually stated
("backend authorization must enforce approvals; UI-only restrictions are
insufficient") — it is the *shape* of the enforcement (inline vs. queued)
that differs from Transfers/Purchase Orders, not its strength.

## 5. Branch-Wise & Consolidated Reporting

New, all under `/api/accounting/reports/*`, all permission-aware (apply
the same `branchScopeWhere` a restricted caller would get on Sales):
Branch Sales, Branch Expenses, Branch Receivables/Payables, Branch
Comparison (with top-performer/underperformer), Warehouse Stock, Stock
Transfers, Stock Movement by Location. Branch-wise P&L already existed
(Phase 5) and needed no change.

## 6. Command Center Integration

`GET /api/dashboard/command-center` gained an additive `locations` key:
`warehouseComparison` (value/product-count per warehouse),
`pendingTransferApprovals`, `transferPipeline` (in-flight transfers).
The existing `branchId` filter and `branchPerformance` widget (Phase 4)
already provide the global-vs-single-branch toggle and branch comparison —
extended here with the warehouse dimension rather than rebuilt.

## 7. Staff & Business Control (lightweight, per the phase's own hedge)

Implemented: user-to-branch assignment (primary + `UserBranchAccess`),
role/permission control (unchanged RBAC, now branch-aware), sales/
discounts/returns by staff (already queryable via existing `cashierId`
fields — no new endpoint needed, exercised in the Command Center's
existing staff-performance widget). **Not implemented this phase**,
consistent with the spec's own "only if it fits" / "if compatible"
hedging: cashier shift open/close, attendance/presence, commission
tracking. These would each need new business rules not specified in
enough detail to build safely (e.g., what exactly should happen to a
sale made outside a "shift"?) and were judged higher-risk-of-getting-wrong
than valuable-if-rushed. Disclosed here rather than silently omitted.

## 8. Migration & Data Safety

One migration, `20260912071556_phase6_multi_branch_warehouse` — purely
additive: 4 new tables (`warehouses`, `warehouse_stocks`,
`stock_transfers`, `stock_transfer_items`), 1 new join table
(`user_branch_access`), `Branch.code`/`Branch.isOpen`,
`Expense.branchId`, `InventoryTransaction.warehouseId`, two new
`InventoryTxnType` enum values (`TRANSFER_DISPATCH`/`TRANSFER_RECEIVE`).
No existing column was altered or dropped. Verified via `prisma migrate
deploy` against a disposable database; **not applied to production**.

## 9. Testing

28 new tests in `tests/multiBranch.test.js`, covering: branch
create/edit/open-close/deactivate-without-data-loss, multi-branch user
access grant/restriction, branch-scoped RBAC (list filtering AND
direct-ID 404, both directions - restricted and unrestricted roles),
large-discount/large-expense threshold enforcement, warehouse CRUD and
RBAC, the default-warehouse lazy-migration guarantee (exact quantity
preserved), direct receive/dispatch/adjust keeping `Product.stockQuantity`
in sync, stock-adjustment threshold enforcement, the full transfer
lifecycle with exact quantity assertions at every step, short/damaged
receiving, double-dispatch/premature-receive rejection, transfer approval
thresholds, transfer idempotency, the "no false revenue" guarantee,
cancel-before-dispatch vs. cannot-cancel-after-dispatch, branch reports,
Command Center `locations` integration, and tenant isolation across
warehouses/transfers. All 167 backend tests (139 pre-existing + 28 new)
and 46 frontend tests (43 pre-existing + 3 new) pass.

## 10. Frontend Coverage

New pages: `pages/warehouses/Warehouses.jsx` (list, create, per-warehouse
stock view with receive/dispatch), `pages/warehouses/StockTransfers.jsx`
(full lifecycle: create, approve/reject, dispatch, receive with
short/damaged quantities, cancel). `pages/branches/Branches.jsx` extended
with `code` and an open/closed toggle. **Not built as a frontend
screen this phase** (all tested and reachable via API): a dedicated
central-replenishment-recommendation UI (the backend Command Center
surfaces `purchasePriceChanges`/low-stock data that a future screen could
consume), and a standalone branch-comparison report page (the data exists
at `/api/accounting/reports/branch-comparison` and partially in the
Command Center's existing branch performance widget).
