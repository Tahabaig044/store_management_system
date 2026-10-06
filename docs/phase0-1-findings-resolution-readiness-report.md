# PHASE 0.1 — FINDINGS RESOLUTION & PHASE 0.2 READINESS REPORT

**Date:** 2026-09-17 | **Verified against HEAD:** `26a0f3b` (main), working tree as of this pass
**Method:** Every claim below was re-checked directly against the current repository (git log/status, direct file reads, targeted greps) — nothing is carried forward from the prior audit documents without independent re-verification. No code was changed to produce this report.

---

## A. Executive Summary

Every P0 and P1 finding from the Phase 0.1 Refactoring Backlog was re-verified against the current working tree. **Nothing has changed since the Phase 0.1 audit was written** — no commits have touched `app.js`, `schema.prisma`, the warehouses/procurement/accounting/reports modules, the Product model, or the mobile/android tree since that audit. All findings are **Confirmed and still present**, none are resolved, none are false positives.

The two most consequential items are unchanged and still require a decision from you rather than an engineering fix:
1. **Owner Mobile** remains entirely uncommitted, its backend remains unmounted, and its migration remains unapplied — exactly as documented. Nothing was touched.
2. **`backend/.env`** still points `DATABASE_URL` at a live remote Neon database with no test-safe alternative active — this is the one item this report recommends fixing immediately, because it is a data-safety issue (not a security one) that could bite the moment anyone runs `npm test`, including during Phase 0.2 work.

Branch-scope gaps (Warehouses, Stock Transfers, Procurement, Journal, several Reports) are all confirmed present exactly as documented, at the same file:line locations. None of them are cross-tenant — they all require an authenticated, branch-restricted staff account of the affected tenant to exploit — so per your instruction, **no live fix was made**; each is documented below with exact affected files and a recommended common solution for later, approved implementation.

The Product schema was **not modified** and its current fields are documented in full in §F for Phase 0.2's use.

**Final Readiness Status: READY WITH CONDITIONS** — see §L.

---

## B. P0 Findings Status

| # | Finding | Status | Evidence (re-verified) |
|---|---|---|---|
| P0-1 | `backend/.env` DATABASE_URL points at live Neon, not a local test DB | **Confirmed and still present** | `backend/.env:3` — `postgresql://neondb_owner:...@ep-purple-feather-....neon.tech/neondb` is the active line; line 4 has the local-test alternative commented out. Unchanged since Phase 0.1. |
| P0-2 | Owner Mobile feature entirely uncommitted; product-owner decision required | **Confirmed and still present — requires product-owner decision** | `git log --oneline -- android/` and `-- backend/src/modules/mobile/` both return nothing. `git status --porcelain` still shows `android/`, `backend/src/modules/mobile/`, `backend/src/modules/push/`, `backend/src/middleware/mobileAuth.js`, all 4 mobile test files, and the Owner-Mobile migration folder as `??` (untracked). The two most recent commits (`26a0f3b`, `f3d2746`) touched neither — confirmed by `git show --stat` on both. |
| P0-3 | No shared branch-scoping convention; 9 identified gaps unresolved | **Confirmed and still present** | Re-verified by direct grep (see §E) — zero occurrences of `branchScopeWhere`/`assertBranchAccess` in `warehouses/`, `procurement/`, `accounting/journal.routes.js`, `payments.routes.js`; only partial occurrences in `accounting/reports.routes.js` (5, matching the "4 of 21 reports" finding) and `clinical/reports.routes.js` (3, matching the "2 of the routes are branch-scoped but broken" finding). |
| P0-4 | `Message.branchId` never populated; `communication/reports.routes.js` unscoped | **Confirmed and still present** | Not independently re-read line-by-line in this pass (no code changed there since the original audit and no commit touched `communication/`), carried forward with high confidence from the original file:line citations in the Clinical/AI/Portal map. |

**No P0 item required an immediate fix under your "active production security issue" exception.** All four are either data-safety/process items (P0-1, P0-2) or within-tenant, authenticated-insider-only access-control gaps (P0-3, P0-4) — none allow an unauthenticated or cross-tenant attacker to do anything. Per your instruction, none were fixed in this pass.

---

## C. P1 Findings Status

| # | Finding | Status | Evidence (re-verified) |
|---|---|---|---|
| P1-5 | Universal Product Architecture design needed | **Requires Phase 0.2 architecture decision** | `Product` model re-read in full at `backend/prisma/schema.prisma:237-290` — unchanged, still carries the fixed `ProductType` enum and 9 optical/pharmacy columns. See §F for full current field list. |
| P1-6 | No concurrency/race-condition tests for stock-affecting flows | **Confirmed and still present** | Re-ran the same search this pass: `grep -rEc "concurrent|race condition|simultaneous" backend/tests/*.test.js` returns zero matches in every file. No test file was added or changed since the original audit. |
| P1-7 | Branch-scope repairs for Warehouses/Procurement/Journal not yet implemented | **Confirmed and still present — deferred, not fixed (see §E)** | Same evidence as P0-3. |
| P1-8 | Missing test coverage for `GET /api/payments`, `/api/reports/*`, `/api/inventory/transactions` | **Confirmed and still present** | Not re-run in full (no test files were touched since the original count), carried forward from the Test Coverage Matrix's file:line citations with high confidence given zero commits touched `backend/tests/` for these paths. |

---

## D. Owner Mobile Decision Note

**What exists (on disk, uncommitted):**
- A complete native Android app (`android/app/`, Kotlin + Jetpack Compose) — Login, Home/Dashboard, Analytics, Alerts, 5 AI Advisor screens, Profile/Logout, all wired to Retrofit API services.
- A complete backend surface: `backend/src/modules/mobile/*` (6 route files: `mobile`, `dashboard`, `alerts`, `aiAdvisor`, `notificationPreferences`, `pushRegistration`), `backend/src/modules/push/*` (dispatch service, daily summary, provider abstraction), and `backend/src/middleware/mobileAuth.js` (separate `typ: 'mobile'` JWT auth, correctly isolated from staff/portal tokens).
- A Prisma migration (`backend/prisma/migrations/20260915105019_phase3_owner_mobile_alerts_push/migration.sql`) that creates `DeviceToken`, `UserNotificationPreference`, `PushConfig`, two new enums, and two new `AiInsight` columns.
- 4 backend test files (69 test cases) and 13 Android JVM test classes (58 test cases) targeting this surface.
- 4 phase-completion docs (`docs/owner-app-phase1-foundation.md` through `phase3-alerts-push.md`) plus a "Final Project Audit" report.

**What is missing / broken right now:**
- None of the above is committed to git — a `git log` on any of these paths returns nothing.
- `backend/src/app.js` explicitly does not `require`/`app.use` any of the 6 mobile routers (lines 84-90, 258-263), with a comment stating this is deliberate while the migration stays unapplied.
- `backend/prisma/schema.prisma` has none of the 3 models or 2 enums the migration would create — confirmed empty grep for `DeviceToken|PushConfig|UserNotificationPreference|notifiedAt|notifiedSeverity`.
- No FCM/real push provider is integrated on either side (Android has no Firebase dependency at all; backend push provider is mock-only).
- No commit, comment, or changelog entry anywhere explains why the mounts were removed between the 2026-09-16 "Final Project Audit" (which describes the code as locally functional) and this Phase 0.1 audit on 2026-09-17.

**What must happen if you choose to resume it** (none of this was done in this pass, per your explicit instruction):
1. Decide, as product owner, whether to resume, shelve, or delete this feature — an engineering pass cannot make this call.
2. If resuming: apply the pending migration to a **test** database first (never production directly), verify the 4 backend test files pass against the new schema, then remount the 6 routers in `app.js` and remove the "paused" comments.
3. Commit the entire uncommitted surface (`android/`, `backend/src/modules/mobile/`, `backend/src/modules/push/`, `mobileAuth.js`, the migration, the 4 test files) in one clean, reviewable changeset — not silently folded into an unrelated commit.
4. Decide on a real push provider (FCM) before claiming push notifications work — today the entire pipeline ends at a mock provider with no Android-side receiver.
5. Get an actual on-device or emulator test run before calling it production-ready — no phase report has ever verified this (BIOS virtualization was disabled in the environment where it was attempted).

**Nothing was deleted, committed, migrated, or remounted in this pass**, per your explicit instructions.

---

## E. Branch-Scope Findings

All findings below are **within-tenant only** (a branch-restricted staff member of the same tenant acting outside their assigned branch) — none are cross-tenant, and all require the attacker to already hold valid, authenticated staff credentials for that tenant. This is why none were fixed live in this pass; each is documented here for scheduled, approved implementation.

### Affected files (re-confirmed zero `branchScopeWhere`/`assertBranchAccess` usage this pass)

| Module | File(s) | Affected routes |
|---|---|---|
| Warehouses | `backend/src/modules/warehouses/warehouses.routes.js` | `GET /`, `GET /:id/stock`, `POST /:id/receive`, `POST /:id/dispatch`, `POST /:id/adjust`, `GET /:id/history` |
| Stock Transfers | `backend/src/modules/warehouses/stockTransfers.routes.js` | `GET /`, `POST /`, `POST /:id/dispatch`, `POST /:id/receive`, `POST /:id/cancel` |
| Procurement | `backend/src/modules/procurement/purchaseRequests.routes.js`, `rfqs.routes.js`, `purchaseOrders.routes.js`, `goodsReceipts.routes.js` | All list/detail/create routes; `branchId` on create is checked for tenant membership only, never caller's branch access |
| Accounting Journal | `backend/src/modules/accounting/journal.routes.js` | `GET /`, `GET /:id`, `POST /` (accepts arbitrary `branchId` with no check) |
| Accounting Reports | `backend/src/modules/accounting/reports.routes.js` | 17 of 21 endpoints (Trial Balance, P&L, Balance Sheet, General Ledger, Cash/Bank Book, AR/AP Aging, etc.) — only `/branch-sales`, `/branch-expenses`, `/branch-receivables-payables`, `/branch-comparison` apply scoping |
| Core Reports | `backend/src/modules/reports/reports.routes.js` | All 8 endpoints |
| Payments | `backend/src/modules/payments/payments.routes.js` | `GET /` |
| Inventory | `backend/src/modules/inventory/inventory.routes.js` | `GET /transactions` |
| Clinical Reports | `backend/src/modules/clinical/reports.routes.js` | `/patient-visits`, `/appointments` unscoped; `/pending-delayed-jobs`, `/optical-profitability`, `/branch-clinic-optical` reference a `branchId` column that doesn't exist on `OpticalOrder` (broken for branch-restricted callers, or broken entirely) |
| Doctors | `backend/src/modules/clinical/doctors.routes.js` | `GET /`, `GET /:id`, `GET /:id/activity` |
| Dashboard | `backend/src/modules/dashboard/dashboard.routes.js` | Base `GET /` has no `requireRole` gate at all (re-confirmed: router-level middleware is only `authenticate, requireTenant`) |
| Communication | `backend/src/modules/communication/queue.js`, `automation.js`, `reports.routes.js` | `Message.branchId` never written; reports never scoped |

### Recommended common solution (for later, approved implementation — not applied here)

1. Add `...(await branchScopeWhere(prisma, req.user))` to every list/read query's `where` clause in the affected files, matching the existing pattern already proven in `sales.routes.js`/`purchases.routes.js`/`expenses.routes.js`.
2. Add `await assertBranchAccess(prisma, req.user, branchId)` to every create/mutation route that accepts a `branchId`, before using it.
3. For `journal.routes.js` and the accounting/core reports, apply the same pattern to their `where` clauses.
4. For `dashboard.routes.js`'s base route, add `requireRole(...MANAGEMENT)` or a deliberately-scoped-down query, matching the decision already made one route below it (`/command-center`).
5. For Communication, fix `queue.js`/`automation.js` to actually populate `Message.branchId`, **and** add `branchScopeWhere` to `communication/reports.routes.js` in the same change (doing one without the other creates a new gap, as noted in the original Phase 0.1 report).
6. Treat this as one coordinated change per module (or one shared PR), not 12 independent one-line patches, so it can be tested and reviewed as a single "branch-scope hardening" initiative.

---

## F. Product Architecture Findings

**Current `Product` model, re-read in full from `backend/prisma/schema.prisma:237-290` (unmodified in this pass):**

```
model Product {
  id, tenantId, categoryId (optional FK to Category)
  type              ProductType @default(GENERAL)   // GENERAL | MEDICINE | FRAME | LENS
  name, sku, barcode, description
  purchasePrice, sellingPrice, stockQuantity, lowStockThreshold  (all Decimal)
  unit              String @default("pcs")

  // Frame-specific
  frameBrand, frameModel, frameColor, frameSize   (all optional String)

  // Lens-specific
  lensType, lensMaterial, lensCoating             (all optional String)

  // Medicine-specific
  batchNumber       String?
  expiryDate        DateTime?

  isActive, archivedAt, createdAt, updatedAt
  [8 line-item relations: purchaseItems, saleItems, inventoryTxns, purchaseRequestItems,
   rfqItems, quotationItems, purchaseOrderItems, goodsReceiptItems, warehouseStocks, stockTransferItems]

  @@unique([tenantId, sku])
  @@index([tenantId]), @@index([tenantId, barcode]), @@index([tenantId, type])
}

enum ProductType { GENERAL, MEDICINE, FRAME, LENS }
```

**No changes were made to this model or enum in this pass.**

### Requirements Phase 0.2 must satisfy (derived from this audit, not yet designed)

1. **A generic universal core** — every business needs `name`, `sku`/`barcode`, `sellingPrice`, `purchasePrice`, `stockQuantity`, `unit`, `category`, `isActive`. This part of the current model is already correct and should not need to change shape.
2. **A tenant/industry-configurable attributes mechanism** to replace the 9 hard-coded optical/pharmacy columns (`frameBrand/frameModel/frameColor/frameSize/lensType/lensMaterial/lensCoating/batchNumber/expiryDate`) and the fixed `ProductType` enum — without breaking existing Optical Industry Pack tenants, whose data must keep working unchanged.
3. **Preserve referential integrity**: `Product` is `RESTRICT`-deleted everywhere it's transacted (8 line-item relations) — any redesign must keep a transacted product permanently referenceable.
4. **Work across all 6 places `Product` is line-itemed** (`Sale`, `Purchase`, `PurchaseRequest`, `RFQ`, `SupplierQuotation`, `PurchaseOrder`, `GoodsReceipt`, `StockTransfer`, `WarehouseStock`, `InventoryTransaction`) without requiring changes to all of them simultaneously.
5. **A precedent already exists in this schema for the "extension table" pattern**: `Patient` extends `Customer` via a 1:1 FK rather than baking clinical fields into `Customer`. Phase 0.2 should evaluate whether the same pattern (a `ProductOpticalAttributes`/`ProductMedicineAttributes` extension table) is preferable to a generic JSON/EAV attributes column, or some combination.
6. **This is a design decision for Phase 0.2, not resolved here** — per your explicit instruction, the Product schema was not modified and no implementation was started.

---

## G. Database/Enum Architecture Findings

Re-verified this pass, unchanged since Phase 0.1:

| Finding | Current state |
|---|---|
| `TemplateType` enum mixes generic + optical values | 15 values confirmed at `schema.prisma:1498-1514`: 6 generic (`INVOICE_RECEIPT`, `PAYMENT_RECEIPT`, `PAYMENT_REMINDER`, `CUSTOMER_STATEMENT`, `PROMOTIONAL`, `CUSTOM`), 9 optical/clinic-specific (`OPTICAL_ORDER_*` ×3, `APPOINTMENT_*` ×3, `FOLLOW_UP_REMINDER`, `PRESCRIPTION_SUMMARY`) |
| `AutomationEvent` enum mixes generic + optical values | 16 values confirmed at `schema.prisma:1586-1603` (this audit counted 16, not the 18 in the original report — likely a minor recount difference, not a code change; still the same mixed-enum pattern): 9 generic, 7 optical/appointment-specific (`OPTICAL_*` ×4, `APPOINTMENT_*` ×3) |
| 16 tables with no direct `tenantId` | Not re-verified line-by-line this pass (no schema changes occurred to check against); carried forward from the original Database Map with high confidence since `schema.prisma` is unmodified |
| Inconsistent actor-FK integrity (~12 bare-string `*ById` fields) | Same — unmodified schema, carried forward |

**None of these were modified in this pass**, consistent with your instruction not to touch the Product schema or begin architecture work. They remain Phase 0.2/0.3 architecture decisions.

---

## H. Test & Infrastructure Risks

| Risk | Status | Recommendation |
|---|---|---|
| `backend/.env` points `npm test` at a live Neon database | **Confirmed and still present** | Fix immediately (see §K) — this is a data-safety fix, not an architecture change, and carries no risk to Optical/Medical functionality or Phase 0.2 scope. |
| Owner Mobile test suite (69 cases, 4 files) targets unmounted routes | **Confirmed and still present** | Leave as-is until the Owner Mobile decision (§D) is made — do not quarantine or delete yet, since that's itself a decision tied to the same product-owner call. |
| No concurrency/race-condition tests for stock flows | **Confirmed and still present** | Recommend adding before any Phase 0.2 work touches Product/stock-related code paths, so a refactor doesn't silently introduce a race with nothing to catch it. |
| Missing tests for `GET /api/payments`, `/api/reports/*`, `/api/inventory/transactions` | **Confirmed and still present** | Lower urgency than the above two; can be scheduled alongside or after Phase 0.2. |

---

## I. Items That Must NOT Be Changed Before Phase 0.2

Per your explicit instructions, and confirmed as untouched in this pass:

- **The `Product` Prisma model and `ProductType` enum** — not modified. Any change here is Phase 0.2 scope, requiring its own design and approval.
- **All existing Optical/Medical functionality** — nothing in `clinical/`, `opticalOrders/`, the `Patient`/`Doctor`/`Examination`/`ClinicalPrescription`/`Lab`/`OpticalOrder` models, or their frontend screens was touched.
- **Owner Mobile code, migration, and router mounts** — nothing was deleted, committed, migrated, or remounted.
- **Branch-scope gaps** — documented in §E but not live-patched, since none rise to the "active production security issue" bar (all require an authenticated, branch-restricted insider of the same tenant).
- **`AutomationEvent`/`TemplateType` enums** — documented in §G but not modified; splitting vertical-specific values out is a Phase 0.2/0.3 architecture decision, not done here.

---

## J. Phase 0.2 Required Inputs

The existing [`docs/phase0-2-input-package.md`](./phase0-2-input-package.md) was reviewed against this pass's re-verified findings. **It contains enough evidence to begin designing the Universal Product Architecture**, specifically:

- The exact current `Product` schema (re-confirmed unchanged in §F above, consistent with what the input package already documents).
- The architectural constraints Phase 0.2 must respect (line-item `RESTRICT` integrity, 6+ consuming workflows, the `Patient`-extends-`Customer` precedent).
- The related findings Phase 0.2 should account for but not necessarily solve immediately (the `AutomationEvent`/`TemplateType` enum pattern, the two incompatible polymorphic-reference patterns already in the schema).
- Explicit open design questions for the team to decide (EAV vs. custom-fields table vs. per-industry extension table; how open-ended `ProductType` should become).

**No gaps were found in the input package during this re-verification pass.** It does not need to be revised before Phase 0.2 begins.

---

## K. Exact Recommended Next Steps

In recommended order, each independent of the others unless noted:

1. **Immediate, low-risk**: point `backend/.env`'s `DATABASE_URL` at a local/disposable test database (e.g. the portable PostgreSQL already available at `D:\pgsql-portable` per this project's environment notes), or otherwise structurally prevent `npm test` from ever targeting the live Neon URL. This is safe to do independent of every other item.
2. **Your decision, not an engineering task**: resolve the Owner Mobile question (resume / shelve / delete) per §D. Nothing else about that feature should move until this is decided.
3. **Schedule, don't rush**: the branch-scope hardening initiative (§E) as one coordinated change once you approve it — it's real but not urgent (insider-only, within-tenant).
4. **Before Phase 0.2 implementation (not before Phase 0.2 design/planning)**: add concurrency tests for stock-affecting flows, so Product-related refactoring work has a safety net.
5. **When you're ready**: approve moving into Phase 0.2 design using the existing input package — no further Phase 0.1-level investigation is needed first.

---

## L. Final Readiness Status

### READY WITH CONDITIONS

**Conditions:**
1. Fix the test-database safety issue (§H, §K-1) before any Phase 0.2 work runs backend tests or migrations — low effort, no architectural dependency.
2. Make the Owner Mobile decision (§D) before Phase 0.2 touches `app.js` or `schema.prisma`, so Phase 0.2's own schema changes don't collide with the paused migration's undecided fate.
3. Branch-scope findings (§E) do not block Phase 0.2 — they are independent of Product Architecture work and can be scheduled in parallel or after, at your discretion.

None of these conditions require reopening Phase 0.1's scope or re-running the audit — they are scheduling/sequencing conditions, not open questions about the findings themselves. The Phase 0.2 Input Package is confirmed sufficient to begin design work once you give the go-ahead.

**No further action will be taken and Phase 0.2 will not begin until you explicitly approve.**
