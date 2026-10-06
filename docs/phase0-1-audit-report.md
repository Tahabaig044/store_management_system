# AK VisionFlow — Phase 0.1 Existing System Audit & Feature Mapping
## Master Audit Report

**Master Phase:** Phase 0 — Universal Architecture & Refactoring | **Sub-Phase:** 0.1
**Date:** 2026-09-17 | **Audited HEAD:** `26a0f3b` (main)
**Status:** Audit complete. Awaiting client/product-owner approval before Phase 0.2 (Universal Product Architecture) begins, per the phase-gated workflow this project follows.

This report is the top-level entry point into the Phase 0.1 deliverable set. It does not repeat every line-item finding — each is cited with a file:line reference in the linked domain documents — but synthesizes them into the five things the spec asked this phase to produce: **Findings → Feature Matrix → Architecture Risks → Refactoring Backlog → Approval**.

### Linked deliverables

| # | Deliverable | File |
|---|---|---|
| 1–2 | Feature Inventory + Classification Matrix | [`phase0-1-feature-classification-matrix.md`](./phase0-1-feature-classification-matrix.md) |
| 3 | Database Entity Map | [`phase0-1-database-map.md`](./phase0-1-database-map.md) |
| 4 | API/Business Logic Map | [`phase0-1-api-map-core.md`](./phase0-1-api-map-core.md), [`phase0-1-api-map-accounting-procurement.md`](./phase0-1-api-map-accounting-procurement.md), [`phase0-1-api-map-clinical-ai-portal.md`](./phase0-1-api-map-clinical-ai-portal.md) |
| 5 | Web UI/Navigation Map | [`phase0-1-ui-map.md`](./phase0-1-ui-map.md) |
| 6 | Owner Android Dependency Map | [`phase0-1-android-map.md`](./phase0-1-android-map.md) |
| 7 | Test Coverage Matrix | [`phase0-1-test-coverage-matrix.md`](./phase0-1-test-coverage-matrix.md) |
| 8 | Odoo/QuickBooks Gap Matrix | [`phase0-1-odoo-quickbooks-gap-matrix.md`](./phase0-1-odoo-quickbooks-gap-matrix.md) |
| 9 | Refactoring Backlog | [`phase0-1-refactoring-backlog.md`](./phase0-1-refactoring-backlog.md) |
| 10 | Phase 0.2 Input Package | [`phase0-2-input-package.md`](./phase0-2-input-package.md) |

**Methodology note:** this audit was performed by 7 parallel evidence-gathering passes (database schema, 3 backend API domains, frontend UI, Android app, test coverage) plus 4 further sub-passes inside the clinical/AI/portal domain, each citing exact file:line evidence and applying the Status/Classification/Risk vocabulary defined in the Phase 0.1 spec. Nothing below was invented; anything that could not be verified is explicitly marked Unknown—Requires Inspection in the linked documents.

---

## 1. Findings — Executive Summary

### 1.1 The headline finding: tenant isolation is solid; branch isolation is not

Across **every** domain audited (core commerce, accounting, procurement, clinical, optical, AI, communication, mobile, portal), **zero Critical cross-tenant IDOR findings were confirmed**. The September 11 commit (`deaa562`, "Fix cross-tenant IDOR on foreign-key payloads") is corroborated by this audit's independent route-by-route review — every by-id read/mutation checked filters or verifies its target against `tenantId`, and `business.test.js`'s 62-test IDOR-regression suite exercises exactly this class of bug.

The recurring gap is **branch isolation** (the Phase 6 feature restricting non-management roles to their assigned branch). It is correctly implemented in `sales.routes.js`, `purchases.routes.js`, `expenses.routes.js`, `appointments.routes.js`, and `clinicalPrescriptions.routes.js` — but **absent** in:
- The entire **Warehouses + Stock Transfers** module (High — a branch-restricted STORE_KEEPER can adjust/dispatch stock or approve transfers at another branch's warehouse)
- The entire **Procurement** module (RFQs, Purchase Orders, Purchase Requests, Goods Receipts) and **Journal/accounting reports** (17 of 21) (High/Medium — a branch-restricted STORE_KEEPER/ACCOUNTANT can view/act on another branch's procurement or ledger data)
- **Communication reports**, **clinical reports** (`/patient-visits`, `/appointments`), and the **Doctor directory/activity** endpoints (Medium — cross-branch information disclosure)
- The base **Dashboard**, **Payments list**, **Inventory-transactions list**, and 8 of the core **Reports** endpoints (Medium — same pattern)
- Four **frontend routes** (`/products`, `/customers`, `/suppliers`, `/branches`) have no route-level RBAC guard at all — only sidebar visibility restricts them

This is a single systemic pattern repeated ~9 times across independently-written modules, not 9 unrelated bugs — the refactoring backlog treats it as one initiative (a shared, enforced branch-scoping convention) rather than nine point fixes.

### 1.2 Severity-ranked findings register

| Sev | # | Finding | Domain | Evidence |
|---|---|---|---|---|
| **Critical** | 1 | 16 tables (`SaleItem`, `WarehouseStock`, `JournalLine`, `Prescription`, etc.) carry no direct `tenantId` column — zero schema-level defense-in-depth if a future query forgets to join through the parent. Not a confirmed breach; a structural gap against the schema's own stated design principle. | Database | [DB map §Cross-Cutting B](./phase0-1-database-map.md) |
| **Critical** | 2 | Owner Mobile test suite (69 test cases, 4 files) targets `/api/mobile/v1/*` routes that are **not mounted** in `app.js` — every assertion would fail with 404 if run; real live coverage of that surface is zero despite the files existing. | Test Coverage | [Test matrix §Critical 1](./phase0-1-test-coverage-matrix.md) |
| **Critical** | 3 | No test anywhere exercises stock/inventory integrity under concurrent writes (e.g., two simultaneous sales of the last unit). All stock tests are sequential only. | Test Coverage | [Test matrix §Critical 2](./phase0-1-test-coverage-matrix.md) |
| **Critical** | 4 | `backend/.env`'s active `DATABASE_URL` points at a live remote Neon Postgres instance, with the local-test alternative only present as a commented-out line — the entire 14-file backend integration suite is one accidental `npm test` away from writing throwaway data into it. | Test Coverage / Infra | [Test matrix §Critical 3](./phase0-1-test-coverage-matrix.md) |
| **High** | 5 | Warehouses + Stock Transfers modules never apply branch scoping — a branch-restricted STORE_KEEPER can adjust/dispatch/receive stock or approve transfers at a warehouse outside their branch. | Core API | [API map core §W-1](./phase0-1-api-map-core.md) |
| **High** | 6 | The entire Procurement module (`purchaseRequests`, `rfqs`, `purchaseOrders`, `goodsReceipts`) and `journal.routes.js` never apply branch scoping — a branch-restricted STORE_KEEPER/ACCOUNTANT can view/act on another branch's PO/RFQ/GRN/journal entry within the same tenant. | Accounting/Procurement API | [Acct/Proc map §Finding 1](./phase0-1-api-map-accounting-procurement.md) |
| **High** | 7 | `AutomationEvent` (7/18 values) and `TemplateType` (9/15 values) hard-mix generic and Optical/Clinic-specific values inside fixed, non-extensible Prisma enums — the clearest concrete blocker to treating Optical/Clinic as a swappable industry pack; extending to a new vertical today requires a schema migration, not configuration. | Database | [DB map §Cross-Cutting A4](./phase0-1-database-map.md) |
| **High** | 8 | `Product` (a "Universal Core" entity) bakes in `type: GENERAL\|MEDICINE\|FRAME\|LENS` plus 9 optical/pharmacy-specific columns directly onto the one universal product table, with no tenant-configurable custom-fields mechanism. **This is the single most direct input to Phase 0.2 (Universal Product Architecture).** | Database / Core API | [DB map, Product](./phase0-1-database-map.md); [API map core §6](./phase0-1-api-map-core.md) |
| **High** | 9 | Owner Mobile feature (all Android code, all `backend/src/modules/mobile|push/*`, `mobileAuth.js`, its migration, and its docs) has **never been committed to git**, and the six mobile backend routers are explicitly unmounted in `app.js` because the Prisma migration was never applied — every endpoint the Android app calls currently 404s. No commit/comment explains why the unmount happened between the 2026-09-16 final audit and this 2026-09-17 audit. | Android / Process | [Android map §0](./phase0-1-android-map.md) |
| Medium | 10 | Base `GET /api/dashboard/` exposes tenant-wide financial KPIs to every authenticated role (including CASHIER/RECEPTIONIST/DOCTOR) with no `requireRole` gate, inconsistent with the MANAGEMENT-only `/command-center` one route below it. | Core API | [API map core §D-1](./phase0-1-api-map-core.md) |
| Medium | 11 | 8 of the core Reports endpoints, plus Payments-list and Inventory-transactions-list, have no branch scoping — a branch-restricted ACCOUNTANT/STORE_KEEPER sees tenant-wide figures. | Core API | [API map core §B-1](./phase0-1-api-map-core.md) |
| Medium | 12 | 17 of 21 accounting reports (Trial Balance, P&L, Balance Sheet, General Ledger, AR/AP Aging, etc.) bypass branch scoping. | Accounting API | [Acct/Proc map §Finding 2](./phase0-1-api-map-accounting-procurement.md) |
| Medium | 13 | `Message.branchId` is never populated at write time (`queue.js` drops it), silently defeating branch-scope enforcement on `messages.routes.js` and making the `/branch-activity` report's per-branch breakdown 100% "Unassigned." Once fixed, `reports.routes.js` (which never applies `branchScopeWhere` at all) would newly leak cross-branch message volumes to branch-restricted staff. | Communication API | [Clinical/AI/Portal map §3.4 M-1/M-2](./phase0-1-api-map-clinical-ai-portal.md) |
| Medium | 14 | `/api/communication/reports/branch-activity` (explicit cross-branch breakdown) is gated only by `COMMUNICATION_STAFF`, not `MANAGEMENT` — reachable by branch-restrictable RECEPTIONIST/ACCOUNTANT. | Communication API | [Clinical/AI/Portal map §3.4 M-3](./phase0-1-api-map-clinical-ai-portal.md) |
| Medium | 15 | Clinical reports (`/patient-visits`, `/appointments`) omit branch scoping on a branch-bearing model (`Appointment`), leaking every branch's patient/appointment data to a branch-restricted RECEPTIONIST/DOCTOR. | Clinical API | [Clinical/AI/Portal map §4.3](./phase0-1-api-map-clinical-ai-portal.md) |
| Medium | 16 | Doctor directory/activity endpoints (`GET /doctors`, `/:id`, `/:id/activity`) are not branch-scoped despite `Doctor.branchId` existing. | Clinical API | [Clinical/AI/Portal map §4.3](./phase0-1-api-map-clinical-ai-portal.md) |
| Medium | 17 | Frontend routes `/products`, `/customers`, `/suppliers`, `/branches` have no `ProtectedRoute` role guard — any authenticated role can navigate to them directly by URL regardless of sidebar visibility. | Frontend UI | [UI map §2](./phase0-1-ui-map.md) |
| Medium | 18 | Two clinical report endpoints reference a `branchId` column that doesn't exist on `OpticalOrder` — `/branch-clinic-optical` is fully broken (throws for every caller); `/pending-delayed-jobs` and `/optical-profitability` throw specifically for branch-restricted finance-staff callers. Correctness bug, not a security issue. | Clinical API | [Clinical/AI/Portal map §4.3](./phase0-1-api-map-clinical-ai-portal.md) |
| Low | 19–30+ | ~12 further Low/defense-in-depth findings (timing side-channel on portal OTP request; several `findUnique`/`findFirst` helpers that trust a pre-verified caller with no filter of their own; 403-vs-404 existence leaks; hex-color/branding drift outside the CSS token system; etc.) — see each domain document for the full list. | Various | See linked docs |

### 1.3 What did **not** need fixing

- No Critical tenant-isolation break was found anywhere — the codebase's core multi-tenancy guarantee holds.
- Double-entry accounting is real (not a facade): `JournalLine` has actual debit/credit columns, `postJournalEntry` hard-rejects unbalanced entries, and every financial report is derived from ledger rows, not estimated.
- The RFQ→PO→GRN→Bill procurement chain is unusually well-wired (auto-creates POs from selected quotations, auto-creates Bills + posts ledger entries from GRNs, all inside single DB transactions) — better than the audit expected to find at this stage.
- No destructive database migrations exist in the 11-migration history.
- The AI layer's architecture is already ~85% industry-agnostic; the optical-specific seams are narrow and well-isolated, not spread throughout.
- Frontend tests that exist (18 files, 72 cases) all pass; component-level regression protection is real where it exists.

---

## 2. Feature Matrix

See [`phase0-1-feature-classification-matrix.md`](./phase0-1-feature-classification-matrix.md) for the full per-feature table (Domain, Feature, Status, UI/API/DB/Test evidence, Classification, Reuse Decision, Gap, Risk, Dependency, Recommended Phase). Summary counts:

| Classification | Approx. feature/module count | Representative examples |
|---|---|---|
| Universal Core | 16 | Users, Branches, Warehouses, Customers, Suppliers, Sales, Purchases, Payments, Expenses, Inventory ledger, Accounting (CoA/Journal/Periods/Reports), Products (core fields only) |
| Universal Module | 6 | Communication/Automation engine, AI layer (analytics/forecast/assistant), Customer Portal, Procurement (RFQ/PO/GRN), Dashboard/Command-Center widget framework, Reports engine |
| Industry Module (Optical/Medical) | 8 | Patients, Doctors, Examinations, ClinicalPrescriptions, Appointments (clinic-flavored), Labs, OpticalOrders, Prescription (order snapshot) |
| Configuration | 3 | Categories, ExpenseCategories, Settings (tenant key/value store) |
| Platform/Infrastructure | 3 | Auth, Middleware (tenant/branch/RBAC), Audit logging |
| Mobile | 1 (paused) | Owner Mobile app + backend (uncommitted, unmounted) |
| Integration | 1 | Push notification providers (mock only, no FCM) |
| Uncertain | — | None — every audited area reached a definite classification; nothing was left "uncertain" for lack of evidence |

---

## 3. Architecture Risks

These are the findings with direct bearing on Phase 0.2 (Universal Product Architecture) and beyond — structural properties of the current design that make universalization harder than a simple relabeling exercise.

1. **The Product entity is not universal.** `Product.type` is a fixed 4-value enum (`GENERAL/MEDICINE/FRAME/LENS`) and the table carries 9 optical/pharmacy-only columns permanently NULL for any other business. **This is Phase 0.2's primary target** — a real "Universal Product Architecture" needs a generic core (SKU, name, price, tax, unit) plus a tenant/industry-configurable attributes mechanism, not more hard-coded columns per vertical.
2. **Six independent "document + line items" workflows** (`Sale`, `Purchase`, `PurchaseOrder`, `PurchaseRequest`, `OpticalOrder`, `StockTransfer`) each reimplement the same header/status/line-item shape from scratch. Adding a 7th document type today means a 7th full table pair, not a configuration change — the strongest concrete candidate for a generic Order/Document supertype with a `type` discriminator.
3. **Vertical coupling is baked into fixed Prisma enums**, not configuration: `AutomationEvent`, `TemplateType` (communication), and indirectly `Product.type`. Any new industry pack requires a schema migration today.
4. **Two incompatible polymorphic-reference patterns coexist** (`Payment`'s six nullable FK columns vs. `JournalEntry`/`AiForecast`'s `sourceType`+loosely-typed `sourceId`) — a universal platform should standardize on one.
5. **Inconsistent actor-FK integrity**: roughly half of all `*ById` "who did this" fields are real `User` relations; the other half are bare unconstrained strings (`PurchaseOrder.createdById`, `StockTransfer`'s four actor fields, `AiInsight.acknowledgedById`, etc.) — an auditability gap that will compound as more workflows are added.
6. **Branch isolation is a bolt-on convention, not an enforced framework property** (see §1.1) — nine independent omissions across modules built at different times shows there's no compile-time or architectural guarantee that a new route gets branch-scoped correctly; it depends entirely on the author remembering to call `branchScopeWhere`/`assertBranchAccess`.
7. **Dashboard/Command-Center hard-wire industry-specific KPIs** (`opticalJobs`, "Expiring Medicines") directly into what are meant to be two universal endpoints, rather than letting an Industry Module contribute its own widget. Every tenant pays the query cost and sees empty blocks today.
8. **No Industry Pack or Tenant Branding configuration surface exists yet**, frontend or backend — branding is 100% literal JSX strings (`"AK VisionFlow"`, `"Optical & Eyecare ERP"`), and two of the highest-traffic screens (`Dashboard.jsx`, `CommandCenter.jsx`) bypass the existing CSS custom-property theme system with their own hard-coded hex constants, so even a future theme-swap wouldn't fully retheme the app without also touching those two files.
9. **Refraction/clinical data is genuinely industry-specific** (OD/OS/Sphere/Cylinder/Axis/PD fields duplicated 3× across `Prescription`/`Examination`/`ClinicalPrescription`) — correctly identified as Industry Module scope, not something to force into the universal core; flagged here only so Phase 0.2 doesn't accidentally try to generalize it.
10. **The Owner Mobile surface's uncommitted/unmounted state is itself an architecture risk for planning purposes**: Phase 0.2 planning should explicitly decide whether to resume, formally shelve, or delete this in-progress feature before it silently rots further or gets accidentally overwritten by unrelated work.

---

## 4. Refactoring Backlog

Full prioritized backlog with dependencies is in [`phase0-1-refactoring-backlog.md`](./phase0-1-refactoring-backlog.md). Top items by priority:

| Priority | Item | Risk if deferred | Depends on |
|---|---|---|---|
| P0 | Decide the fate of the Owner Mobile feature (resume + commit + apply migration, or formally shelve) before any further work touches `app.js`/`schema.prisma` | Silent bit-rot; risk of accidental data loss of uncommitted work | Product-owner decision (this audit surfaces it, doesn't decide it) |
| P0 | Fix backend test-execution safety: point `.env`/CI at a disposable test database, never the live Neon URL | One `npm test` run away from corrupting/populating production-adjacent data | None — safe to do immediately |
| P0 | Introduce a single shared branch-scoping convention (lint rule, middleware default, or code-review checklist) and apply it to the 9 identified gaps (Warehouses/StockTransfers, Procurement, Journal, 8 core Reports + Payments + Inventory-transactions, 17 accounting reports, Communication reports, Clinical reports, Doctors) | Recurring cross-branch information disclosure / stock-integrity risk, will keep recurring in new modules otherwise | None |
| P1 | Design the Universal Product Architecture (generic core + configurable attributes) — this **is** Phase 0.2's scope, not a Phase-0.1 fix | Blocks Phase 0.2 from starting cleanly | This audit (feature matrix + DB map) |
| P1 | Add stock-integrity concurrency tests before any refactor touches sale/inventory code paths | Refactors could introduce or hide race conditions with no test to catch them | None |
| P1 | Split `AutomationEvent`/`TemplateType` vertical-specific values out of the fixed enums into tenant/industry configuration | Blocks a second industry pack from being added without a schema migration | Universal Product/Order Architecture decisions (Phase 0.2/0.3) |
| P2 | Unify the six document+line-item workflows behind a shared pattern (or explicitly decide not to, and document why) | Continued duplication cost for every future document type | Phase 0.2 architecture decision |
| P2 | Repair actor-FK integrity gaps (add real `User` relations to the ~12 bare-string `*ById` fields) | Auditability/data-integrity, low urgency | None |
| P3 | Frontend: add route-level RBAC guards to `/products`, `/customers`, `/suppliers`, `/branches`; consolidate hard-coded hex colors into the CSS token system; move literal branding strings toward a config point | Low-severity but compounds Tenant Branding Engine cost later | None |
| P3 | Quarantine or fix the 69-test Owner-Mobile test suite so it stops reporting false confidence | Misleading coverage signal for anyone who runs the suite | Depends on the P0 Owner Mobile decision |

---

## 5. Approval Checklist

Per the Phase 0.1 spec's Definition of Done and Approval Checklist:

- [x] Source repository, backend, frontend and Android inspected
- [x] Database schema and migrations inspected
- [x] APIs and services mapped (all 26 backend modules)
- [x] UI/navigation mapped (31 screens)
- [x] Tests mapped to capabilities (backend statically; frontend executed)
- [x] Tenant/branch/RBAC behavior documented (tenant: solid everywhere; branch: 9 documented gaps)
- [x] Optical/Medical hard-coding identified (schema enums, Product columns, ~15 frontend/backend locations)
- [x] Odoo/QuickBooks gaps documented (see linked matrix)
- [x] Refactoring risks/dependencies documented
- [x] Phase 0.2 inputs prepared (see linked input package)
- [ ] **Client/product-owner approval obtained** — pending. Per this project's standing phase-gated workflow, Phase 0.2 (Universal Product Architecture) will not begin until this box is checked by the user.

**This phase produced no new functionality and no code changes** — it is documentation only, as required. Nothing was refactored, no Optical/Medical functionality was touched, and no production database writes were made (backend tests were deliberately not executed against the live database found in `.env`).
