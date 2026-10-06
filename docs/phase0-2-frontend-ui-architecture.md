# Phase 0.2 — Frontend Product UI Architecture

Companion to [`phase0-2-architecture-package.md`](./phase0-2-architecture-package.md). **Planning document only — no frontend code has been changed.**

---

## 1. Current state (re-confirmed, per the entity-map document's consumer inventory)

`frontend/src/pages/products/Products.jsx` renders the `type` dropdown (list-filter and create/edit form) and the FRAME/LENS/MEDICINE conditional field blocks **unconditionally for every tenant**, regardless of industry vertical. This is the concrete violation of the spec's Frontend Requirement (§10: "Industry fields appear only when the relevant industry/module is enabled") and part of what Acceptance Criteria §18 ("A generic business can create/sell a physical product without Optical/Medical fields") is checking for — not a validation bug (fields are already optional), but a UI-presentation gap.

## 2. Target architecture

### 2.1 New dependency: `enabledIndustryPacks` (from ADR-4)

The frontend needs to know, per tenant, which industry packs are enabled, to decide what to render. Proposed source: the existing `/api/auth/me` or a tenant-settings endpoint returns `enabledIndustryPacks: string[]` (e.g. `["OPTICAL", "MEDICINE"]`), sourced from the new `Tenant.enabledIndustryPacks` column. This is already loaded into `AuthContext` at login time in the current app (which already carries tenant/user info) — extending that existing payload is lower-risk than introducing a new API call.

### 2.2 `Products.jsx` restructuring

| Section | Current behavior | Target behavior |
|---|---|---|
| Universal fields (name, sku, barcode, category, price, unit, stock threshold) | Always shown | **Unchanged** — always shown |
| Product Kind selector (Physical Good / Service) | Does not exist | **New** — always shown; when `SERVICE` is selected, stock-related fields (quantity, low-stock threshold) are hidden, matching spec §11 ("Services do not create meaningless stock movements") |
| `type` dropdown (GENERAL/MEDICINE/FRAME/LENS) | Always shown | **Retained during transition** (backward compatibility — see below), but only offers MEDICINE/FRAME/LENS options when the tenant's `enabledIndustryPacks` includes the corresponding pack; a tenant with neither pack enabled sees only a simplified Physical Good/Service choice via the new Product Kind selector and never sees the legacy dropdown at all |
| Frame-specific field block | Always shown when `type === 'FRAME'` | Shown when `type === 'FRAME'` **and** `enabledIndustryPacks.includes('OPTICAL')` |
| Lens-specific field block | Always shown when `type === 'LENS'` | Shown when `type === 'LENS'` **and** `enabledIndustryPacks.includes('OPTICAL')` |
| Medicine-specific field block | Always shown when `type === 'MEDICINE'` | Shown when `type === 'MEDICINE'` **and** `enabledIndustryPacks.includes('MEDICINE')` |

**Why keep the legacy `type` dropdown at all during the transition**, rather than replacing it immediately with the new Product Kind selector: per ADR-3 (additive, dual-write, no drops), the backend keeps accepting/returning `type` throughout this phase, and 3 other frontend screens (`Reports.jsx`, `Dashboard.jsx`, `CommandCenter.jsx`) and the `?type=MEDICINE` deep-link contract depend on it continuing to mean what it means today. Removing the dropdown before those are migrated would break the deep-link from `CommandCenter.jsx`'s "Expiring Medicines" widget. The dropdown becomes conditionally visible (gated by `enabledIndustryPacks`) rather than disappearing outright in this phase.

### 2.3 Role/route controls

No change to existing `ProtectedRoute` role gates on `/products` (spec §10: "Do not weaken existing role/route controls"). Note: Phase 0.1 already flagged that `/products` has no route-level guard at all today (sidebar-only restriction) — that is a pre-existing, separately-tracked finding (Phase 0.1 Refactoring Backlog, P3 item 14) and is explicitly **not** this phase's job to fix, per the spec's own guardrail against scope expansion.

### 2.4 Other 3 frontend consumers

`Reports.jsx`, `Dashboard.jsx`, `CommandCenter.jsx` require **no changes** in this phase — they consume report/dashboard API output (`batchNumber`, `expiryDate`, the `?type=MEDICINE` link) which remains contractually unchanged per the API Compatibility Plan. They become candidates for updating to the new universal model only in a later phase, once the industry-pack-aware pattern established in `Products.jsx` is proven.

### 2.5 What this phase does NOT do to the frontend

- Does not introduce a settings/configuration screen for *choosing* `enabledIndustryPacks` — that value is set once via the migration backfill (defaulting every existing tenant to today's behavior) and, for this phase, is read-only from the frontend's perspective. A tenant-facing "manage your industry packs" settings UI is a reasonable future phase, not built here (avoids the spec's "Do not turn Phase 0.2 into general code cleanup" / scope-expansion guardrail).
- Does not touch `Categories.jsx`'s cosmetic `<datalist>` suggestions (confirmed not a real dependency in the entity-map document).
- Does not redesign the Products list/table layout, styling, or any unrelated UX.
