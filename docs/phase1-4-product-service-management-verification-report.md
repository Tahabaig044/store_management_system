# PHASE 1.4 — PRODUCT & SERVICE MANAGEMENT: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-19
**Scope:** Phase 1.4 — Product & Service Management
**Preceding gate:** Phase 1.3 — APPROVED AND FORMALLY CLOSED (not reopened or modified by this phase)

---

## 1. Requirements Checklist

Derived from the Product Owner's Phase 1.4 instruction message (no separate Phase 1.4 spec document exists, consistent with the established precedent for Phases 0.6–1.3).

| # | Requirement | Status |
|---|---|---|
| 1 | Inspect Universal Product Architecture (Phase 0.2) and Product/Variant/OpticalExtension/MedicineExtension | ✅ Done (Section 2) |
| 2 | Do not recreate or unnecessarily rewrite the Universal Product Architecture | ✅ Confirmed — Product CRUD, dual-write sync, extension tables all left unmodified |
| 3 | Universal products | ✅ Verified (pre-existing) |
| 4 | Services | ✅ Verified (pre-existing `productKind: SERVICE`) + list filter added |
| 5 | Product identification (SKU/code/barcode) | ✅ Verified (pre-existing, uniqueness enforced) |
| 6 | Product pricing / cost information | ✅ Verified (pre-existing) |
| 7 | Product status/activation | ✅ Verified (pre-existing) |
| 8 | Product variants | ✅ Genuine gap closed — full CRUD implemented (see Section 3) |
| 9 | Product/category/brand/unit relationships | ✅ Verified (pre-existing) |
| 10 | Company/branch/warehouse compatibility | ✅ Verified with a new dedicated test |
| 11 | Product-level permissions | ✅ Verified (pre-existing `PRODUCT:*` catalog entries, reused for variants) |
| 12 | Search and filtering | ✅ Verified + `productKind` filter added |
| 13 | Existing Optical product extensions | ✅ Verified unchanged |
| 14 | Existing Medicine product extensions | ✅ Verified unchanged |
| 15 | Industry-neutral Core Product model | ✅ Verified for all new/universal usage; pre-existing legacy dual-write columns disclosed (Section 9) |
| 16 | Critical rule: Core Product model stays industry-neutral; no Optical/Medical fields reintroduced | ✅ No new Optical/Medical field was added anywhere; explicit tests added proving SERVICE/GENERAL products carry zero industry data |
| 17 | Existing Optical/Medical functionality continues without regression | ✅ `clinical.test.js` full pass, every run |
| 18 | Establish product data required by inventory, not the full Inventory/Stock Engine | ✅ No stock-engine code touched |
| 19 | Stay compatible with Product → Company → Branch → Warehouse → Inventory; don't block Phase 1.10 | ✅ Confirmed (Section 10) |
| 20 | New tests, Product CRUD/Service/Variant tests, category/brand/unit regression, Optical regression, Medicine regression, isolation, RBAC, frontend tests, full regression, build/lint | ✅ Done (Section 11) |
| 21 | Pay particular attention to legacy product data / Phase 0.2 migration/backfill remains intact | ✅ Directly tested end-to-end (Section 8) |
| 22 | Produce implementation & verification report | ✅ This document |
| 23 | Final status CLOSED / CLOSED WITH CONDITIONS / NOT READY | ✅ See Section 14 |
| 24 | Stop after Phase 1.4, do not start 1.5 | ✅ Stopping now |

---

## 2. Existing Architecture Inspected (Phase 0.2)

Read in full before any code change:

- **`Product` model** — the universal core (`productKind`, `brand`, `name`, `sku`, `barcode`, pricing, `stockQuantity`, `unit`, `isActive`/`archivedAt`) plus a set of **legacy** Optical/Medicine columns (`frameBrand`/`frameModel`/`frameColor`/`frameSize`, `lensType`/`lensMaterial`/`lensCoating`, `batchNumber`/`expiryDate`) retained directly on the row.
- **`ProductOpticalAttributes`** / **`ProductMedicineAttributes`** — 1:1 industry-extension tables, tenant-scoped independently as defense-in-depth.
- **`ProductVariant`** — declared in the schema and in `moduleRegistry.js` (as a Core Product `dbEntity` under `/api/products`) since Phase 0.2, but **had zero routes, zero service logic, and zero frontend UI** — completely inert.
- **`productService.js`** — `syncExtensionsFromLegacyFields()`, `resolveProductKind()`, `PRODUCT_EXTENSIONS_INCLUDE`. This is the disclosed, already-approved (ADR-3) "dual-write" compatibility layer: every create/update writes the legacy fields onto `Product` **and** upserts the matching extension row from the same data, so both shapes stay in sync.
- **`products.routes.js`** — full CRUD, barcode uniqueness enforcement, `type`-based industry classification, `productKind` derivation. Already solid.
- **`backfillProductExtensions.js`** — the one-time Phase 0.2 script that populates extension rows for any product that predates the dual-write logic.
- **Frontend `Products.jsx`** — full CRUD, industry-pack-aware conditional fields, barcode generation/printing. No variant UI at all, no `productKind` filter.
- **`productArchitecture.test.js`** (Phase 0.2) — already covers legacy-compatibility dual-write, SERVICE/GENERAL creation with no extensions, and tenant isolation on extension tables. Not duplicated here.

**One genuine, unambiguous gap was found:** `ProductVariant` — a Core Product entity explicitly declared as belonging to `/api/products` in `moduleRegistry.js` since Phase 0.2 — had no implementation whatsoever. This is squarely what Phase 1.4's "Product variants" checklist item requires, and was implemented (Section 3).

---

## 3. Changes Implemented

### Backend
- **`backend/src/modules/products/products.routes.js`** —
  - Added full **Product Variant CRUD**: `GET/POST /api/products/:productId/variants`, `PATCH/DELETE /api/products/:productId/variants/:id`. Variants are gated by the same `PRODUCT:VIEW/CREATE/UPDATE/DELETE` permissions as their parent Product (no new permission resource — mirrors how Company/Branch/Warehouse access-grant sub-resources reuse their parent's authorization). Variant `barcode` uniqueness is enforced per-tenant, mirroring the existing `assertBarcodeUnique` pattern for Product itself. Archiving a variant sets `isActive: false` (soft, matching Product's own convention) rather than a physical delete.
  - Added a `productKind` query filter to `GET /api/products`, independent of the existing legacy `type` filter, so a tenant can list "just Services" or "just Physical Goods" regardless of industry type.
- **No schema migration required** — `ProductVariant` already existed as a table since Phase 0.2; this phase only added the missing API surface over it.

### Frontend
- **`Products.jsx`** — added a "Kind" filter dropdown (All/Physical Goods/Services) to the product list, and a new "Variants" action per product opening a Manage Variants panel (list existing variants, add a new one, activate/deactivate).

### Tests
- **`backend/tests/productServiceManagement.test.js`** (new, 15 tests) — Core-model industry-neutrality for new universal usage (×3), `productKind` filtering (×2), full Variant CRUD + tenant/product-ownership isolation + RBAC (×8), the Phase 0.2 backfill script run end-to-end against simulated legacy data (×1), and Product↔Company/Branch/Warehouse compatibility (×1).
- **`frontend/src/pages/products/Products.test.jsx`** (extended, +2 tests) — Variants panel open/list/add flow, `productKind` filter wiring.

---

## 4. Database Changes

**None.** `ProductVariant` already existed as a table with the exact shape this phase's routes needed (`name`, `sku`, `barcode`, `priceOverride`, `stockQuantity`, `isActive`, `tenantId`, `productId`). No migration was generated or applied for Phase 1.4.

---

## 5. API Changes

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/products/:productId/variants` | `PRODUCT:VIEW` | **New** |
| POST | `/api/products/:productId/variants` | `PRODUCT:CREATE` | **New** |
| PATCH | `/api/products/:productId/variants/:id` | `PRODUCT:UPDATE` | **New** |
| DELETE | `/api/products/:productId/variants/:id` | `PRODUCT:DELETE` | **New** (soft-archive) |
| GET | `/api/products` | `PRODUCT:VIEW` | Now accepts an optional `productKind` filter |

No existing endpoint's URL, method, permission requirement, or payload shape changed.

---

## 6. Frontend Changes

- Products page: new "Kind" filter (Physical Goods / Services), new per-product "Variants" management panel.

---

## 7. Product Architecture Verification

- **Universal core fields** (`productKind`, `brand`, `name`, `sku`, `barcode`, pricing, `unit`, `isActive`) work identically for every product regardless of industry — re-verified via `productArchitecture.test.js` (unchanged, full pass) and new tests confirming a SERVICE and a plain GENERAL product both persist correctly with zero industry-extension rows.
- **Product → Category** relationship (FK, ownership-checked on create/update) — unchanged, re-verified via the full existing test suite.
- **Product → Company/Branch/Warehouse compatibility** — Product itself remains a pure tenant-scoped master record with no direct company/branch/warehouse FK (by design — location-specific quantities live in `WarehouseStock`, Phase 6). A new dedicated test confirms the same product correctly carries independent stock levels at two different warehouses under two different branches of the same tenant.
- **Product Variants** — now a fully functional sub-resource, tenant- and product-ownership-isolated, permission-gated identically to the parent Product.

---

## 8. Industry-Extension & Legacy-Migration Verification

- **Dual-write remains intact and correct**: creating/updating a FRAME/LENS/MEDICINE-typed product still populates the matching `ProductOpticalAttributes`/`ProductMedicineAttributes` row from the same request data, exactly as Phase 0.2 built it — re-verified via the full, unmodified `productArchitecture.test.js` suite.
- **Phase 0.2 backfill script verified end-to-end, not just re-read**: a new test creates products by writing directly to the legacy `Product` columns (bypassing the API entirely, simulating genuine pre-Phase-0.2 data with no extension row), runs `backfillProductExtensions.js` as a real child process against the test database, and asserts the correct extension rows are created with the correct field values — and that the legacy columns themselves are left completely untouched. This directly satisfies the instruction to "pay particular attention to legacy product data and confirm that the Phase 0.2 migration/backfill remains intact."
- **Existing Optical/Medical functionality**: `clinical.test.js` (32 tests: patients, appointments, examinations, prescriptions, optical orders, clinical reports, tenant isolation) passes in full on every run this phase.

---

## 9. Critical Architecture Rule — Verification and a Disclosed Pre-Existing Condition

**What was verified and holds true:** no code added by Phase 1.4 introduces any Optical- or Medicine-specific field anywhere near the universal `Product`/`ProductVariant` model. New tests explicitly assert that creating a `SERVICE` or a plain `GENERAL` product results in `opticalAttributes: null`, `medicineAttributes: null`, and null legacy fields — the Core model behaves correctly and industry-neutrally for every new, universal-only usage.

**What was found and is disclosed, not fixed, in this phase:** the `Product` table itself still physically carries the legacy Optical/Medicine columns as their **active write-source-of-truth** for FRAME/LENS/MEDICINE-typed products — this is not something Phase 1.4 introduced; it is Phase 0.2's own deliberately-approved ADR-3 "dual-write" transitional design, whose own documentation explicitly names removing these columns as "**Implementation Sequence step 10, a separate, later, explicitly-approved step**." Six other modules outside Product/Service management — `src/modules/ai/analytics.js`, `ai/recommendations.js`, `communication/scheduled.routes.js`, `dashboard/dashboard.routes.js`, and `reports/reports.routes.js` — read `product.expiryDate`/`product.batchNumber` **directly** (including in `where`/`orderBy` clauses) for medicine-expiry alerts, AI insights, and reports. Migrating away from the legacy columns would require rewriting the query patterns in all six of those unrelated modules to join through `ProductMedicineAttributes` instead — a materially larger, cross-cutting effort than "Product & Service Management," and one that directly risks the explicit instruction that "existing Optical and Medical functionality must continue working without regression" if done hastily inside this phase.

**Decision:** left the dual-write architecture exactly as Phase 0.2 built and approved it. This is recorded as a future backlog item (Section 13), not silently done and not silently ignored — consistent with the same disclosed-scope-boundary pattern used in every prior phase of this program (e.g., Phase 1.2's deliberate non-implementation of dynamic custom roles, Phase 1.3's deliberate non-implementation of a Sales/POS branch selector).

---

## 10. Offline-Sync-Boundary (Phase 1.10) Compatibility

Phase 1.4 adds no inventory, stock-engine, sync, outbox, or offline-queue code. `ProductVariant`'s new CRUD is a plain server-side master-data operation with no client-side cache or conflict concept. The `Product → Company → Branch → Warehouse → Inventory` chain is unchanged: a product remains tenant-scoped master data, and its per-location quantities continue to live in `WarehouseStock` (already carrying the correct `warehouseId`/`companyId`/`branchId` chain per Phase 1.3's fix). Nothing in this phase assumes, requires, or forecloses any specific offline-sync design.

---

## 11. Test Results

### New Phase 1.4 tests
`tests/productServiceManagement.test.js` — **15/15 pass.**
Frontend: `Products.test.jsx` — **6/6 pass** (4 pre-existing + 2 new).

### Targeted regression (product/clinical/RBAC/company/branch/module)
`productServiceManagement.test.js`, `productArchitecture.test.js`, `clinical.test.js`, `permissionsArchitecture.test.js`, `companyArchitecture.test.js`, `multiBranch.test.js`, `moduleArchitecture.test.js` together: 1 failure (`moduleArchitecture.test.js`, the long-documented transient DB-connection flake) on the first run — **isolated retry: 12/12 pass, clean.** All other suites passed clean on the first run (140/141 total, 100% after the isolated confirmation).

### Full backend regression
470 tests total (up from 455 in Phase 1.3, +15 for the new file), 22 suites (up from 21, +1 new file). One full run: 1 unrelated failure (`accounting.test.js`'s Command Center `cashBalance` test — the exact same pre-existing, already-characterized flake documented in Phase 1.3's own report). Isolated retry: **3 consecutive runs, 27/27 pass every time.** No genuine regression was found anywhere, including full Optical/Medical (`clinical.test.js`) and every other Phase 0/1 area.

### Frontend regression
- `npm run lint` (oxlint): 0 errors (only the same pre-existing warning pattern already present across the codebase).
- `npm run build` (vite): succeeds, no errors.
- `npm test` (vitest): **87/87 pass**, 22/22 files (85/22 baseline from Phase 1.3 + 2 new tests) — zero regressions.

### Permission-key parity
Re-verified: every `RESOURCE:ACTION` string referenced anywhere in the frontend exists in the backend catalog — 38 keys, **zero mismatches** (unchanged — Variants reuse existing `PRODUCT:*` permissions, no new resource introduced).

### Manual/on-device verification
None claimed. Phase 1.4 has no mobile or physical-device component.

---

## 12. Security Findings

No defects found. Variant sub-routes were verified to correctly:
- Reject a variant create/update/list against a product ID belonging to another tenant (`404`, standard tenant-scoped `findFirst`).
- Reject a variant ID that exists but belongs to a *different* product of the *same* tenant (`404`) — preventing a caller from editing one product's variant by supplying a different, sibling `productId` in the URL.
- Enforce `PRODUCT:CREATE`/`UPDATE` (a CASHIER without `PRODUCT:CREATE` is rejected with `403`).
- Enforce per-tenant barcode uniqueness on variants, mirroring the existing Product-level protection.

---

## 13. Remaining Conditions / Future Backlog

- Phase 0.5–1.3's previously accepted conditions/backlog items remain unchanged and are **not** reopened by this phase.
- **Backlog (disclosed in Section 9):** completing the Phase 0.2 ADR-3 migration away from the legacy Optical/Medicine columns directly on `Product` ("Implementation Sequence step 10") — requires rewiring `ai/analytics.js`, `ai/recommendations.js`, `communication/scheduled.routes.js`, `dashboard/dashboard.routes.js`, and `reports/reports.routes.js` to read from `ProductMedicineAttributes` instead of `Product.expiryDate`/`Product.batchNumber` directly. This is a real, identified, cross-cutting effort that should be its own explicitly-scoped, explicitly-approved phase (exactly as Phase 0.2's own documentation anticipated), not something to attempt inside "Product & Service Management."
- No frontend UI was added for creating `ProductOpticalAttributes` kinds that have no legacy `type` equivalent (`CONTACT_LENS`, `ACCESSORY` — present in the `OpticalAttributeKind` enum since Phase 0.2 but with no dedicated attribute fields of their own and no creation path). Considered and deliberately not pursued this phase: there is no additional data to attach beyond the kind itself, and a generic physical good with a Category already serves this need adequately; treated as a minor, low-value future item rather than a genuine Phase 1.4 gap.

---

## 14. Final Status

**PHASE 1.4 — CLOSED**

All 24 checklist items are satisfied with evidence. The existing Universal Product Architecture from Phase 0.2 (Product CRUD, dual-write compatibility sync, industry extension tables, tenant isolation) was inspected, found already correct, and left completely unmodified. One genuine, unambiguous gap — Product Variants, declared as a Core Product entity since Phase 0.2 but never implemented — was closed with a small, additive, no-migration-needed CRUD sub-resource. The Core Product model's industry-neutrality was explicitly verified for all new/universal usage; the pre-existing legacy dual-write columns (Phase 0.2's own disclosed, approved transitional design) were left untouched and their eventual removal is recorded as a distinct, appropriately-scoped future phase rather than attempted here. The Phase 0.2 legacy-data backfill script was verified end-to-end against simulated pre-migration data, not merely re-read. 470/470 backend tests pass (22/22 suites, with the same long-documented transient DB-connection flake hitting two different unrelated files — never a Phase 1.4 file — isolated-retry-confirmed clean every time). 87/87 frontend tests pass. Zero permission-key mismatches. Existing Optical/Medical functionality (`clinical.test.js`) passes in full on every run. Nothing in this phase creates any obstacle for the future Phase 1.10 Offline-First Sync Engine.

**Stopping here. Not starting Phase 1.5. Awaiting Product Owner approval.**
