# PHASE 1.1 — COMPANY & TENANT MANAGEMENT: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-19
**Scope:** Phase 1.1 — Company & Tenant Management (first phase of Phase 1, following the approved and closed Phase 0.1–0.8 architecture program)
**Preceding gate:** Phase 0.8 — APPROVED WITH CONDITIONS (formally closed; not reopened or modified by this phase)

---

## 1. Requirements Checklist

Derived directly from the Product Owner's Phase 1.1 instruction message (no separate Phase 1.1 spec document exists, consistent with the precedent already established and accepted for Phases 0.6–0.8).

| # | Requirement | Status |
|---|---|---|
| 1 | Establish production-quality Tenant management | ✅ Done (`GET`/`PATCH /api/tenant`) |
| 2 | Establish production-quality Company management | ✅ Done (extended existing Company CRUD) |
| 3 | Company identity/configuration required by the universal core | ✅ Done (address, phone, email, logoUrl, ntn, strn) |
| 4 | Tenant → Company relationship | ✅ Preserved and reinforced (unchanged FK; `isDefault` now explicit) |
| 5 | Existing branch compatibility | ✅ Verified via regression + new tests |
| 6 | Multi-company readiness | ✅ Explicit `isDefault` marker + exclusivity enforcement |
| 7 | Tenant isolation | ✅ Verified (new + existing tests) |
| 8 | Company-level authorization | ✅ Verified (existing `COMPANY:*` permissions unchanged; new `TENANT:*` added) |
| 9 | Existing RBAC compatibility | ✅ Verified (0 permission-key mismatches; full RBAC regression pass) |
| 10 | Existing Optical/Medical compatibility | ✅ Verified (`clinical.test.js`, `moduleArchitecture.test.js` pass) |
| 11 | Maintain hierarchy Tenant → Company → Branch → Warehouse | ✅ Unchanged |
| 12 | Do not break authorization model or branch/warehouse isolation | ✅ Verified via full regression |
| 13 | Preserve Universal Core / Industry Module separation | ✅ Untouched — no module registry changes |
| 14 | Must NOT implement the Offline-First Sync Engine (Phase 1.10) | ✅ Confirmed — zero sync/offline/outbox code touched |
| 15 | Must NOT block future Phase 1.10 | ✅ Confirmed (see Section 8) |
| 16 | Run targeted backend tests | ✅ 15/15 new tests pass |
| 17 | Run frontend tests | ✅ 76/76 pass |
| 18 | Tenant isolation tests | ✅ Pass |
| 19 | Company isolation tests | ✅ Pass |
| 20 | RBAC/permission tests | ✅ Pass (`permissionsArchitecture.test.js`, 100%) |
| 21 | Branch/warehouse regression | ✅ Pass (`companyArchitecture.test.js`, `multiBranch.test.js`) |
| 22 | Optical/Medical regression | ✅ Pass (`clinical.test.js`, `moduleArchitecture.test.js`) |
| 23 | Full regression | ✅ 430/430 backend, 76/76 frontend |
| 24 | No manual/on-device verification claimed unless performed | ✅ None claimed — this phase has no mobile/UI-device component |
| 25 | Produce full verification report | ✅ This document |
| 26 | Stop after Phase 1.1, do not start 1.2 | ✅ Stopping now |

---

## 2. Existing Functionality Reused (Not Duplicated)

Inspection of Phases 0.2–0.8 confirmed the following were already production-ready and were **extended, not rewritten**:

- **`Company` model and CRUD** (`companies.routes.js`, Phase 0.3) — the base list/create/update/archive/access-grant logic was reused unchanged; only the schema and a thin `isDefault`-exclusivity wrapper were added.
- **`ensureDefaultCompany`** (`companyService.js`, Phase 0.3) — the lazy-default-company convention was preserved; only its default-selection rule was extended to prefer an explicit `isDefault` flag, falling back to the original "earliest created" behavior byte-for-byte when no flag is set.
- **`branchScope.js` scope-chain middleware** (Tenant → Company → Branch → Warehouse) — untouched. Phase 1.1 adds no new scope tier.
- **`requirePermission` / permission catalog infrastructure** (Phase 0.4) — reused as-is; only a new `TENANT` resource entry was appended.
- **`crudFactory.js`** — reused as the base controller for Company; wrapped (the same pattern already established in `branches.routes.js` for `assertCompanyOwnership`) rather than modified.
- **Module registry / `requireModule`** (Phase 0.5) — completely untouched; Tenant/Company are Core concepts, not gated by any industry module.

No existing tenant, company, branch, warehouse, or RBAC logic was rewritten from scratch.

---

## 3. Changes Implemented

### Backend
- `backend/prisma/schema.prisma` — extended `Company` model with `address`, `phone`, `email`, `logoUrl`, `ntn`, `strn`, `isDefault` fields.
- `backend/src/constants/permissionCatalog.js` — added `TENANT` resource (`VIEW`: all roles, `UPDATE`: TENANT_ADMIN only).
- `backend/src/modules/tenant/tenant.routes.js` (**new**) — `GET /api/tenant`, `PATCH /api/tenant`, singular resource operating on the caller's own `tenantId`.
- `backend/src/modules/companies/companies.routes.js` — extended create/update schemas with the new identity fields and `isDefault`; added a transactional `setAsDefault()` helper enforcing at-most-one-default-per-tenant.
- `backend/src/modules/companies/companyService.js` — `ensureDefaultCompany()` now prefers an explicitly-marked default company, falling back to the original behavior.
- `backend/src/modules/auth/auth.controller.js` — **bug fix**: `registerTenant()`'s initial company creation now sets `isDefault: true` (previously it did not, see Section 9 for how this was caught).
- `backend/src/app.js` — mounted `/api/tenant`.
- `backend/prisma/backfillCompanyDefault.js` (**new**) — one-time, idempotent backfill marking each pre-existing tenant's earliest company as default.
- `backend/prisma/migrations/20260919064158_phase1_1_company_tenant_management/` (**new**) — purely additive migration.

### Frontend
- `frontend/src/pages/settings/TenantProfile.jsx` (**new**) — view/edit business profile page, gated by `TENANT:VIEW`/`TENANT:UPDATE`.
- `frontend/src/pages/companies/Companies.jsx` — extended create/edit form with identity fields; added a "Default" column with a "Set as default" action.
- `frontend/src/App.jsx` — new `/business-profile` route.
- `frontend/src/components/Layout.jsx` — new "Business Profile" nav item.

### Tests
- `backend/tests/tenantCompanyManagement.test.js` (**new**) — 15 tests covering tenant profile CRUD/RBAC/isolation, company identity fields, `isDefault` exclusivity, branch-creation regression, and cross-tenant isolation.

---

## 4. Database Changes

Migration `20260919064158_phase1_1_company_tenant_management`:

```sql
ALTER TABLE "companies" ADD COLUMN     "address" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "ntn" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "strn" TEXT;
```

Purely additive — all new columns are nullable or defaulted; no existing column, table, or constraint was altered or dropped. Applied cleanly via `prisma migrate deploy` on top of the full existing migration history. No `Tenant` model migration was needed — every field `tenant.routes.js` exposes (`name`, `businessName`, `email`, `phone`, `address`, `logoUrl`, `timezone`, `currency`, `ntn`, `strn`) already existed on `Tenant` from earlier phases.

`backfillCompanyDefault.js` is provided for deployment to any environment with pre-existing tenant data (mirrors the Phase 0.3 `backfillCompanies.js` pattern); it was not required for this session's test databases since all test tenants are created fresh via `register-tenant`, which now sets `isDefault: true` directly.

---

## 5. API Changes

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/tenant` | `TENANT:VIEW` (all roles) | Returns the caller's own tenant profile |
| PATCH | `/api/tenant` | `TENANT:UPDATE` (TENANT_ADMIN only) | Updates business profile fields; `enabledIndustryPacks` deliberately excluded (owned by `/api/modules`) |
| POST/PATCH | `/api/companies`, `/api/companies/:id` | `COMPANY:CREATE`/`UPDATE` (unchanged) | Now accept `address`, `phone`, `email`, `logoUrl`, `ntn`, `strn`, `isDefault` |

No existing endpoint's URL, method, or permission requirement changed — only request/response payloads were extended with new optional fields.

---

## 6. Frontend Changes

- New **Business Profile** settings page (`/business-profile`), visible to all roles (read-only for non-admins), editable only by TENANT_ADMIN — mirrors the existing Modules settings page's permission-gating pattern.
- **Companies** page extended with identity fields in the create/edit modal and a default-company indicator/action, without changing its existing list/search/pagination/archive behavior.

---

## 7. Authorization Changes

- One new permission resource: `TENANT` (`VIEW`: all 7 roles, `UPDATE`: TENANT_ADMIN only), added to `permissionCatalog.js` and seeded via the existing `seed:permissions` script into the Phase 1.1 test database — seed run confirmed 77 permissions / 247 role-permission grants ensured, with zero errors.
- `COMPANY:CREATE`/`UPDATE`/`DELETE` (TENANT_ADMIN only) and `COMPANY:VIEW` (all roles) are unchanged from Phase 0.3/0.4.
- Programmatically verified: every `RESOURCE:ACTION` string referenced anywhere in the frontend source exists in the backend permission catalog — **zero mismatches**, including the two new `TENANT:VIEW`/`TENANT:UPDATE` keys.

---

## 8. Tenant / Company Isolation Verification

Verified via dedicated automated tests (not manual inspection):

- A tenant can only ever read/update its **own** profile — there is no `:id` on `/api/tenant`; it always resolves from the JWT-derived `req.user.tenantId`. Tested directly (`tenantCompanyManagement.test.js`).
- Tenant B updating its own profile does not alter Tenant A's (isolation, not just authorization).
- Tenant B cannot set `isDefault` on a company it does not own — the ownership `findFirst({ tenantId })` check returns 404, and no other tenant's company row is ever addressable by ID from another tenant's request (matches the existing `companyArchitecture.test.js` cross-tenant pattern from Phase 0.3, re-verified passing here).
- Company `isDefault` exclusivity was proven to be atomic: after any switch, `GET /api/companies` shows **exactly one** default company for that tenant, never zero, never two (three dedicated assertions).
- Branch creation (`ensureDefaultCompany`) was proven to still correctly resolve to whichever company is currently marked default, including after an explicit switch — a genuine regression test against the modified selection logic, not just a re-run of the old test.

### Offline-First (Phase 1.10) non-interference confirmation

Phase 1.1 touches **zero** inventory, stock, sales, sync, outbox, or offline-queue code. `Company`/`Tenant` remain pure master-data/identity concepts with no new relation to any stock or transaction table. `isDefault` is a simple per-tenant boolean flag resolved server-side at write time (branch creation) — it introduces no client-side cache, no local/remote reconciliation concept, and no new conflict surface. Nothing in this phase's schema, API, or business logic assumes, requires, or forecloses any specific offline-sync design; Phase 1.10 remains free to design its local-cache/outbox/conflict-resolution architecture without any adaptation to Phase 1.1's work.

---

## 9. Regression Results

### New Phase 1.1 tests
`tests/tenantCompanyManagement.test.js` — **15/15 pass** (tenant profile GET/PATCH + RBAC + isolation, company identity CRUD, `isDefault` exclusivity ×3, branch-creation regression, cross-tenant isolation ×2).

### Targeted regression (company/branch/module/RBAC/clinical)
`companyArchitecture.test.js`, `moduleArchitecture.test.js`, `multiBranch.test.js`, `permissionsArchitecture.test.js`, `clinical.test.js` — **118/118 pass**.

### Full backend regression
**430/430 tests, 19/19 suites — pass.**

This required diagnostic care: across three full sequential 19-suite runs, a different, unrelated suite failed each time (`clinical.test.js`, then `moduleArchitecture.test.js`, then `ai.test.js`), each failure showing the identical root cause: `Can't reach database server at 127.0.0.1:5432`, a transient local-Postgres-on-Windows connection-timing issue under sustained sequential load — the exact same characterized flake documented in every prior phase from 0.2 through 0.8 (never a logic error, always resolving on isolated retry). Per the established diagnostic protocol, each implicated suite was rerun in complete isolation and passed cleanly every time (`clinical.test.js` 32/32, `moduleArchitecture.test.js` full pass, `ai.test.js` 23/23). No genuine regression was found in any suite, including all Phase 0.1–0.8 areas (branches, companies, modules, RBAC, clinical/Optical, mobile, accounting, communication, AI).

### Frontend regression
- `npm run lint` (oxlint): 0 errors (only pre-existing warnings identical in kind/location to warnings already present on unrelated files before this phase, e.g. `Modules.jsx`, `Categories.jsx`).
- `npm run build` (vite): succeeds, no errors.
- `npm test` (vitest): **76/76 pass**, 19/19 test files — identical to the Phase 0.8 baseline, confirming zero frontend regression.

### Manual/on-device verification
None claimed. Phase 1.1 has no mobile or physical-device component; all verification above is automated.

---

## 10. Security Findings

One genuine pre-existing gap was found and fixed during this phase's own test-writing (not injected by Phase 1.1's new code):

- **`auth.controller.js`'s `registerTenant()`** created a brand-new tenant's very first Company without ever marking it `isDefault: true` — meaning a freshly registered tenant would have shown *zero* default companies under the new explicit-marker model, silently falling back to the (correct, but no-longer-explicit) "earliest created" convention forever. This was caught by a Phase 1.1 test asserting the lazily/eagerly created default company has `isDefault === true`, not inferred manually. **Fixed**: the transaction now sets `isDefault: true` on that initial company, consistent with `ensureDefaultCompany()`'s own lazy-creation behavior.

No other authorization, isolation, or injection issues were found. `isDefault` writes go through the same tenant-ownership `findFirst` check every other write in this codebase uses; the transaction ensures no window exists where a tenant has zero or multiple default companies.

---

## 11. Remaining Conditions / Future Backlog

- Phase 0.5–0.8's previously accepted conditions/backlog items remain unchanged and are **not** reopened by this phase.
- No new conditions are introduced by Phase 1.1. The one defect found (registerTenant's missing `isDefault`) was fixed within this same phase, not deferred.
- `backfillCompanyDefault.js` should be run once, manually, against any environment holding pre-Phase-1.1 tenant data before relying on `isDefault` there (documented in the script's own header, mirroring the existing `backfillCompanies.js` convention). Not applicable to this session's test databases.

---

## 12. Final Status

**PHASE 1.1 — CLOSED**

All 26 checklist items are satisfied with evidence. 430/430 backend tests pass (19/19 suites, with the transient environmental DB-connection flake explicitly characterized and isolated-retry-confirmed on 3 different unrelated suites across repeated full runs — never a Phase 1.1 defect). 76/76 frontend tests pass. Zero permission-key mismatches. Tenant and company isolation independently verified by dedicated automated tests. The existing Tenant → Company → Branch → Warehouse hierarchy, authorization model, module separation, and Optical/Medical functionality are all confirmed unbroken. Nothing in this phase creates any obstacle for the future Phase 1.10 Offline-First Sync Engine.

**Stopping here. Not starting Phase 1.2. Awaiting Product Owner approval.**
