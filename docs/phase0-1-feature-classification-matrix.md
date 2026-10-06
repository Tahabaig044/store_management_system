# Phase 0.1 — Feature Inventory & Classification Matrix

One master row per feature/module, per the spec's required columns. "Evidence" is abbreviated here; full file:line citations are in the linked domain documents. Status values: Existing/Complete, Existing/Partial, Existing/Legacy, Existing/Needs Refactor, Missing, Unknown—Requires Inspection.

## Identity & Tenancy

| ID | Feature | Status | UI | API | DB | Tenant/Branch | Roles | Tests | Classification | Reuse Decision | Gap | Risk | Dependency | Rec. Phase |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| I-1 | Tenant/company registration | Existing/Complete | RegisterTenant.jsx | `auth.routes.js` | Tenant | Root | Public | `api.test.js` | Platform-Infra | Reusable as-is | none | — | — | — |
| I-2 | Staff login/session | Existing/Complete | Login.jsx | `auth.routes.js` | User | N/A | Public→staff | widely used as test helper | Platform-Infra | Reusable as-is | none | — | — | — |
| I-3 | Branch management | Existing/Complete | Branches.jsx | `branches.routes.js` | Branch | Tenant | TENANT_ADMIN (write) | `multiBranch.test.js` | Universal Core | Reusable as-is | Route has no RBAC guard (any authenticated role can view); `Branch.code` not tenant-unique-constrained | Medium / Low | — | Phase 0.3 hardening |
| I-4 | Users & RBAC | Existing/Complete | Users.jsx | `users.routes.js` | User | Tenant | TENANT_ADMIN only | `business.test.js`, `phase12Hardening.test.js` | Universal Core | Reusable with extension | `RoleName` enum mixes generic + `DOCTOR` (clinic-specific); no archive/delete route (inconsistent w/ other modules) | Low | — | Phase 0.3 |
| I-5 | Multi-branch user access grants | Existing/Complete | Branches.jsx (access tab) | `branches.routes.js` | UserBranchAccess | Tenant (indirect) | TENANT_ADMIN | `phase12Hardening.test.js` | Universal Core | Reusable as-is | `UserBranchAccess` has no direct `tenantId` | Low | — | — |
| I-6 | Branch-scoped access enforcement | Existing/Needs Refactor | — | `middleware/branchScope.js` | — | — | — | `multiBranch.test.js` (where applied) | Platform-Infra | Reusable with extension | **Inconsistently applied** — see Finding register items 5,6,10-16 | High | — | Phase 0.1 backlog / pre-0.2 |

## Master Data

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| M-1 | Categories | Existing/Complete | Configuration | Reusable as-is | none | — | — |
| M-2 | Products | Existing/Needs Refactor | Universal Core (Industry fields leaking in) | Reusable with extension | `type` enum + 9 optical/pharmacy columns baked into the generic table; no custom-fields mechanism | **High** (Architecture Risk #1) | **Phase 0.2 primary target** |
| M-3 | Customers | Existing/Complete | Universal Core | Reusable as-is | none | — | — |
| M-4 | Suppliers | Existing/Complete | Universal Core | Reusable as-is | none | — | — |
| M-5 | Tax Rates | Existing/Partial | Universal Core | Reusable as-is | Configuration exists; no evidence of automatic rate-based tax calculation wired into POS/PO/GRN posting | Medium | Phase 2/5 (accounting) follow-up |

## Commerce

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| C-1 | POS / Sales | Existing/Complete | Universal Core | Reusable as-is | Sale-reversal trusts historical productId without re-verifying tenantId at mutation point (S-1, low, not currently exploitable) | Low | — |
| C-2 | Sale reversal | Existing/Complete | Universal Core | Reusable as-is | none functional; well-tested | — | — |
| C-3 | Payments (ledger) | Existing/Complete | Universal Core | Reusable as-is | `GET /api/payments` has no branch scoping and zero test coverage on its read/join side | Medium | Phase 0.1 backlog |
| C-4 | Optical Orders | Existing/Complete | **Industry Module** | Optical Industry Pack | No `branchId` on the entity at all (inconsistent w/ Sale/Purchase) | Low-Medium | Phase 3 (Industry Pack extraction) |

## Procurement

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| P-1 | Purchases (direct/receive) | Existing/Complete | Universal Core | Reusable as-is | none significant | — | — |
| P-2 | Purchase Requests | Existing/Complete | Universal Core | Reusable as-is | No branch-access check on create/approve (High, see Finding 6) | High | Phase 0.1 backlog |
| P-3 | RFQ + Supplier Quotations | Existing/Complete | Universal Module | Reusable as-is | Same branch-scope gap as above | High | Phase 0.1 backlog |
| P-4 | Purchase Orders | Existing/Complete | Universal Core | Reusable as-is | Same branch-scope gap | High | Phase 0.1 backlog |
| P-5 | Goods Receipts (GRN) | Existing/Complete | Universal Core | Reusable as-is | Same branch-scope gap; otherwise tightly wired to PO + auto-Bill + auto-ledger-post | High | Phase 0.1 backlog |

## Inventory / Warehouse

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| W-1 | Warehouses | Existing/Needs Refactor | Universal Core | Reusable as-is | **No branch scoping at all** (Finding 5) | **High** | Phase 0.1 backlog, urgent |
| W-2 | Stock Transfers | Existing/Needs Refactor | Universal Core | Reusable as-is | Same branch-scope gap | **High** | Phase 0.1 backlog, urgent |
| W-3 | Inventory transaction ledger | Existing/Complete | Universal Core | Reusable as-is (good append-only pattern) | List endpoint not branch-scoped; near-zero dedicated test coverage | Medium | Phase 0.1 backlog |

## Finance / Accounting

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| F-1 | Chart of Accounts | Existing/Complete | Universal Core | Reusable as-is | none | — | — |
| F-2 | Double-entry Journal | Existing/Complete | Universal Core | Reusable as-is | `OPTICAL_ORDER` value mixed into otherwise-generic `JournalSourceType` enum | Low | — |
| F-3 | Accounting Periods | Existing/Partial | Universal Core | Reusable as-is | No period-close-to-equity entry; `status` is a bare string, not an enum | Medium | Phase 2 follow-up |
| F-4 | Financial Reports (P&L/BS/TB/etc.) | Existing/Complete | Universal Core | Reusable as-is | 17 of 21 reports not branch-scoped (Finding 12) | Medium | Phase 0.1 backlog |
| F-5 | Journal browsing/voiding | Existing/Complete | Universal Core | Reusable as-is | Not branch-scoped at all (Finding 6) | High | Phase 0.1 backlog |
| F-6 | Expenses | Existing/Complete | Universal Core | Reusable as-is | none significant | — | — |

## Clinical / Optical (Industry Module)

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| CL-1 | Patients | Existing/Complete | Industry Module | Optical/Clinic Industry Pack | none significant; well-scoped, PHI-aware audit logging | — | — |
| CL-2 | Doctors | Existing/Needs Refactor | Industry Module (generalizable to "Practitioner") | Optical/Clinic Industry Pack | Not branch-scoped on reads (Finding 16) | Medium | Phase 0.1 backlog |
| CL-3 | Appointments | Existing/Complete | Industry Module (generalizable scheduling pattern) | Optical/Clinic Industry Pack now; extract scheduling shape later | none — best-scoped module in the audit | — | — |
| CL-4 | Examinations | Existing/Complete | Industry Module | Optical/Clinic Industry Pack | none significant | — | — |
| CL-5 | Clinical Prescriptions (versioned) | Existing/Complete | Industry Module | Optical/Clinic Industry Pack | none significant | — | — |
| CL-6 | Labs | Existing/Complete | Industry Module (generalizable to "Fulfillment Partner") | Optical/Clinic Industry Pack | none significant | — | — |
| CL-7 | Clinical reports | Existing/Needs Refactor | Industry Module | Optical/Clinic Industry Pack | 2 endpoints not branch-scoped (Finding 15); 3 endpoints reference a non-existent `OpticalOrder.branchId` (broken) | Medium | Phase 0.1 backlog |

## AI & Notifications

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| A-1 | AI Analytics/Anomaly/Forecast engine | Existing/Complete | Universal / AI Layer | Generalize across modules — already ~85% there | 5 functions hard-coded to optical models; fallback/suggested-question text advertises "optical/clinic" to every tenant | Low | Phase 0.2/0.3 |
| A-2 | AI Business Assistant | Existing/Complete | Universal / AI Layer | Reusable as-is | none significant | — | — |
| A-3 | Communication/Automation engine | Existing/Complete | Universal Module | Reusable as-is | `Message.branchId` never populated (Finding 13); reports inconsistently scoped (Finding 13/14); seed data + 2 enums vertical-coupled | Medium | Phase 0.1 backlog |
| A-4 | Customer Portal | Existing/Complete | Universal Module | Reusable as-is | Timing side-channel on OTP request (Low); 2 routes reach optical-specific data | Low | Phase 0.1 backlog (low priority) |
| A-5 | Owner Mobile app + backend | Existing/Legacy (paused, uncommitted) | Mobile Platform | Universal Owner Command Center (once resumed) | Entire surface uncommitted; backend unmounted; migration unapplied (Finding 9) | **High (process)** | Product-owner decision before Phase 0.2 |
| A-6 | Push notifications | Existing/Partial (mock only) | Integration | Reusable as-is (provider abstraction is generic) | No FCM/real push provider wired; no Android client-side receiver at all | Medium | Deferred with A-5 |

## Reporting & Dashboards

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| R-1 | Base Dashboard | Existing/Needs Refactor | Universal Core (entangled with Industry data) | Reusable with extension | No `requireRole` gate at all (Finding 10); hard-wires optical/medicine KPIs | Medium | Phase 0.1 backlog / Phase 0.2 |
| R-2 | Command Center (advanced BI) | Existing/Complete | Universal Module (widget framework) + Industry widgets | Widget framework reusable as-is; extract `opticalJobs`/"Expiring Medicines" widgets | Same hard-wiring issue as R-1, narrower scope | Low | Phase 0.2/0.3 |
| R-3 | Core Reports module | Existing/Needs Refactor | Universal Core | Reusable as-is | 8 of 8 endpoints missing branch scoping; `medicine-expiry` hard-codes an industry report inside a generic module | Medium | Phase 0.1 backlog |

## Frontend Platform

| ID | Feature | Status | Classification | Reuse Decision | Gap | Risk | Rec. Phase |
|---|---|---|---|---|---|---|---|
| FE-1 | Route-level RBAC | Existing/Needs Refactor | Platform-Infra | Reusable with extension | 4 routes have no `ProtectedRoute` guard (Finding 17) | Medium | Phase 0.1 backlog |
| FE-2 | Theming / Tenant Branding | Missing | Configuration | Build new | No branding config UI; literal strings + hex colors bypass the CSS token system in 2 high-traffic screens | Medium | Phase 0.2/0.3 (Tenant Branding Engine) |
| FE-3 | Offline-first sync (POS, Expenses, Customers, Suppliers) | Existing/Complete | Platform-Infra | Reusable as-is | none significant | — | — |

---

## Classification Rubric Recap (as applied)

- **Universal Core** (16 modules): concepts every business needs — Users, Branches, Warehouses, Customers, Suppliers, Products (core fields), Sales, Purchases, Payments, Expenses, Inventory ledger, Accounting (5 sub-modules), core Reports.
- **Universal Module** (6): broadly useful but optional — Communication/Automation, AI layer, Customer Portal, Procurement, Dashboard/Command-Center widget framework.
- **Industry Module** (8, all Optical/Medical): Patients, Doctors, Appointments, Examinations, ClinicalPrescriptions, Labs, OpticalOrders, Prescription snapshot.
- **Configuration** (3): Categories, ExpenseCategories, Settings.
- **Platform/Infrastructure** (3): Auth, tenant/branch/RBAC middleware, Audit logging.
- **Mobile** (1, paused): Owner Mobile app + its backend surface.
- **Integration** (1): Push notification provider abstraction.
- No feature was left classified "Uncertain" — every audited area reached sufficient evidence for a definite call.
