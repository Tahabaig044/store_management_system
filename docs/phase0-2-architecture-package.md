# Phase 0.2 — Universal Product Architecture: Architecture Package

**Status: DESIGN ONLY — NOT YET APPROVED, NOT YET IMPLEMENTED.** Per the Phase 0.2 spec's own Implementation Sequence (§16: "3) Document and approve target architecture" precedes "4) Implement new structures"), and per this project's standing phase-gated workflow, this package is the deliverable for that step-3 gate. **No schema, backend, or frontend code has been changed.** Implementation (steps 4-10) will not begin until you approve this design.

This is the primary document. Supporting deliverables are in companion files:
- [`phase0-2-entity-map-and-field-mapping.md`](./phase0-2-entity-map-and-field-mapping.md) — Current vs Target Entity Map, full Product-consumer inventory, Legacy Field Mapping Matrix
- [`phase0-2-migration-api-compatibility-plan.md`](./phase0-2-migration-api-compatibility-plan.md) — Database Migration & Rollback Plan, API Compatibility Plan
- [`phase0-2-frontend-ui-architecture.md`](./phase0-2-frontend-ui-architecture.md) — Frontend Product UI Architecture
- [`phase0-2-test-regression-security-matrix.md`](./phase0-2-test-regression-security-matrix.md) — planned Test/Regression/Security Matrix

---

## 0. Developer Checklist (Appendix, filled in)

| Area | Requirement | Status |
|---|---|---|
| Baseline | Phase 0.1 closure confirmed | ✅ Done — Phase 0.1 audit + Findings Resolution + Conditions Closure Note all complete |
| Consumers | All Product consumers mapped | ✅ Done — see entity-map document |
| Architecture | Target model documented and approved | 🟡 Documented here — **awaiting your approval** |
| Extensions | Industry ownership documented | ✅ Done — §3 below |
| Classification | Legacy types mapped | ✅ Done — §4 below + field mapping matrix |
| Database | Before/after schema map approved | 🟡 Documented — **awaiting your approval** |
| Migration | Migration + rollback tested | ⬜ Not started — implementation step, follows approval |
| API | Universal service boundary verified | ⬜ Not started |
| Frontend | Universal + industry-aware UI verified | ⬜ Not started |
| Inventory | Product/service stock behavior verified | ⬜ Not started |
| Security | Tenant/branch authorization verified | ⬜ Planned — see test matrix |
| Regression | Optical/Medical workflows verified | ⬜ Not started |
| Documentation | ADR, mappings and API docs complete | ✅ This package |
| Owner Gate | Product Owner approval obtained | ⬜ **This is what this package is for** |

---

## 1. Architecture Decision Record (ADR)

### ADR-1: Extension pattern — explicit per-pack tables, not a generic EAV store

**Decision**: Industry-specific Product attributes move into explicit, structurally separate tables — one per industry pack (`ProductOpticalAttributes`, `ProductMedicineAttributes`) — each a 1:1 extension of `Product` via a unique `productId` foreign key, `onDelete: Cascade`, with its own `tenantId` column.

**Why**: The spec requires "structured relational storage where reporting, indexing, or integrity requires it" and explicitly warns to "avoid an uncontrolled arbitrary attribute store." This codebase already has a proven precedent for exactly this pattern: `Patient` extends `Customer` via a 1:1 FK rather than baking clinical fields into `Customer` (identified as a **good** pattern in the Phase 0.1 Database Map). A generic EAV/JSON-attributes table was considered and rejected for this phase: it would satisfy the "avoid uncontrolled attribute store" requirement worse (harder to index, validate, or enforce integrity on), and there are currently only two concrete industry packs with real legacy data (Optical, Medicine) — building a fully dynamic, DB-driven attribute-metadata engine now would be speculative scope beyond what today's data requires, and the spec's own guardrail says "Do not turn Phase 0.2 into general code cleanup." The pattern is deliberately repeatable: adding a third pack later (e.g. Restaurant) means adding one new table + one registry entry, not a redesign.

**Consequence**: Attribute *metadata* (key/label/type/required/validation/visibility/owning module) is expressed as a small, static, code-level registry in the backend domain layer (one entry per known attribute, per pack) rather than a dynamic database-driven metadata system. This satisfies the letter of the spec's metadata requirement (§5) without over-building. If a future phase needs tenants to define their *own* custom fields beyond the fixed industry packs, that is a distinct, larger capability explicitly deferred — not silently built here.

### ADR-2: Classification — a universal `productKind` (Physical Good / Service) replaces `ProductType`'s behavioral role; industry sub-classification moves into the extension tables

**Decision**: Introduce `ProductKind { PHYSICAL_GOOD, SERVICE }` on `Product` as the new universal, industry-neutral classification that actually drives behavior (stock tracking on/off). The legacy `ProductType` enum (`GENERAL/MEDICINE/FRAME/LENS`) is **not deleted** in this phase (see ADR-3) but is no longer the source of truth for new code. Within `ProductOpticalAttributes`, a small `opticalKind: FRAME | LENS | CONTACT_LENS | ACCESSORY` sub-classification captures what the old `FRAME`/`LENS` values meant, owned by the Optical pack rather than the universal core — directly satisfying the spec's "Industry packs may define Frame, Lens or Medicine as domain classifications while Universal Core remains industry-neutral."

**Why**: A flat, closed 4-value enum cannot represent "physical vs. service" (a Universal Core concept every vertical needs) and "which specific optical sub-type" (an Optical-pack concept) as the same dimension without conflating them, which is exactly today's problem. Splitting them lets Universal Core stay closed-and-simple (2 values, extensible later to include BUNDLE per the spec's noted future direction, not built now) while each industry pack owns however many sub-types it needs without touching the core enum.

**Consequence**: A product's full classification becomes: `productKind` (universal, required) + optionally *one* extension row (`ProductOpticalAttributes` and/or `ProductMedicineAttributes` — a product could theoretically have both, e.g. a medicated contact lens, though no such data exists today) + that extension's own sub-kind field, if any.

### ADR-3: Legacy compatibility — additive, dual-write, no drops in this phase

**Decision**: `Product.type` and all 9 existing optical/medicine columns **stay in the schema, unchanged, for the duration of this phase**. New structures are added alongside them. A service-layer adapter keeps both in sync (dual-write) so every existing consumer — 8 backend files and 4 frontend files identified in the consumer map — continues to function unmodified against the legacy columns, while new code can read from the new tables. Dropping the legacy columns is explicitly **out of scope for Phase 0.2** and is item 10 of the spec's own Implementation Sequence ("Obtain Product Owner approval before deprecating legacy structures") — a future, separately-approved step.

**Why**: The spec is explicit: "Do not perform a destructive rewrite," "Maintain rollback capability until migration and regression verification are complete," "Prefer additive/transitional migrations." Given 12 identified consumers of the legacy fields (see entity-map document), migrating all of them atomically in one phase is exactly the kind of risk this project's phase-gated workflow and the spec's own guardrails exist to prevent.

### ADR-4: A minimal "enabled industry packs" concept is a required, in-scope dependency — not scope creep

**Decision**: Introduce a small tenant-level flag identifying which industry packs a tenant has enabled (proposed: `Tenant.enabledIndustryPacks: String[]`, default `["OPTICAL", "MEDICINE"]` for all existing tenants so today's behavior is unchanged for current users). The frontend uses this flag to decide whether to show Optical/Medicine fields at all (§10 of the spec: "Industry fields appear only when the relevant industry/module is enabled").

**Why**: Without this, the spec's own Frontend Requirement and Acceptance Criteria ("A generic business can create/sell a physical product without Optical/Medical fields") cannot be satisfied — today, per the Phase 0.1 UI audit, the Frame/Lens/Medicine dropdown options and conditional fields render unconditionally for every tenant regardless of vertical. This is the one piece of net-new capability this ADR introduces beyond pure data-modeling, and it is called out explicitly here because it is easy to mistake for scope creep; it is not — it is a direct, unavoidable prerequisite for the spec's own acceptance criteria.

**Open question for you**: is a simple string array sufficient for this phase (matching the phase's stated boundary of "architectural refactoring only," not a full industry-pack marketplace), or should this be a proper `TenantIndustryModule` join table now? Recommendation: string array now — it is trivially additive and migratable to a proper table later if a marketplace/billing dimension is added in a future phase, and building the richer version now would be exactly the "general code cleanup" / scope-expansion the spec's guardrails warn against.

### ADR-5: `brand` becomes a genuine Universal Core field

**Decision**: Add `Product.brand: String?` as a universal, optional field. `frameBrand` (currently Optical-specific) is recognized as a special case of a general "brand" concept every vertical can use (a retail shoe, a restaurant's packaged good, etc. all have brands) — it is not inherently optical. `frameBrand` is retained in `ProductOpticalAttributes` for backward API compatibility during the transition (per ADR-3) but new code should prefer the universal `brand` field going forward.

**Why**: The spec's Target Universal Product Architecture (§4) explicitly lists "brand" as a Universal Product field, and it does not exist anywhere in the current schema except as the optical-specific `frameBrand`. This is a genuine gap between the current model and the spec's stated target, not an invented addition.

### ADR-6: Variant support is added structurally now, but no existing data is migrated into it

**Decision**: Introduce `ProductVariant` (id, tenantId, productId FK, own optional sku/barcode/price/stockQuantity overrides) as specified (§4: "optional child structure for size, color, material or other differentiators"). No current Optical or Medicine data is migrated into variants — today's frame/lens color/size fields remain plain columns on `ProductOpticalAttributes`, since they describe one product's attributes, not separate sellable child items, per how they are actually used today (confirmed: `opticalOrders.routes.js` doesn't reference `Product` at all — frame/lens attributes on `Product` are for retail catalog/POS purposes only, unrelated to the optical job/prescription workflow).

**Why**: The spec marks Variant as "optional" and gives no legacy field that maps to it — there is no existing data-migration need. Building the table now satisfies "the architecture supports it" without forcing an unnecessary, risky data migration of working Optical data into a new shape it was never designed for.

---

## 2. Product/Service Domain Model

```
Universal Product (Product, existing table, additive changes only)
├── Identity: id, tenantId, categoryId?, name, sku?, barcode?, description?
├── Classification: type (LEGACY, retained), productKind (NEW: PHYSICAL_GOOD | SERVICE)
├── Commercial: brand (NEW, universal), purchasePrice, sellingPrice, unit
├── Inventory config: stockQuantity, lowStockThreshold — semantically meaningful only when productKind = PHYSICAL_GOOD
├── Status/audit: isActive, archivedAt, createdAt, updatedAt
├── Legacy columns (RETAINED, dual-written, not read by new code): frameBrand, frameModel, frameColor, frameSize,
│   lensType, lensMaterial, lensCoating, batchNumber, expiryDate
├── 0..1 → ProductOpticalAttributes (industry extension)
├── 0..1 → ProductMedicineAttributes (industry extension)
├── 0..N → ProductVariant (optional child structure)
└── [unchanged] 8 existing line-item relations (SaleItem, PurchaseItem, etc.) — no change needed, see entity-map doc

ProductOpticalAttributes (NEW table — Optical Industry Pack)
├── id, tenantId (defense-in-depth, per Phase 0.1 lesson), productId (unique FK, cascade)
├── opticalKind: FRAME | LENS | CONTACT_LENS | ACCESSORY
└── frameBrand?, frameModel?, frameColor?, frameSize?, lensType?, lensMaterial?, lensCoating?

ProductMedicineAttributes (NEW table — Medicine/Pharmacy Industry Pack)
├── id, tenantId, productId (unique FK, cascade)
└── batchNumber?, expiryDate?

ProductVariant (NEW table — Universal, optional)
├── id, tenantId, productId (FK, cascade)
├── name (e.g. "Large / Red")
├── sku?, barcode? (override; falls back to parent Product's if not set)
├── priceOverride?, stockQuantity? (only meaningful if parent productKind = PHYSICAL_GOOD)
└── isActive
```

**Service (§4 requirement)**: not a separate table — a `Product` row with `productKind = SERVICE`. Stock-related fields (`stockQuantity`, `lowStockThreshold`) are ignored/hidden for service rows; no `InventoryTransaction` rows are ever created against a service product (enforced in the service/domain layer, see API Compatibility Plan).

---

## 3. Industry Attribute/Extension Specification

| Attribute | Owning pack | Table | Data type | Required? | Notes |
|---|---|---|---|---|---|
| `opticalKind` | Optical | `ProductOpticalAttributes` | enum | Required if extension row exists | New — replaces the FRAME/LENS distinction previously encoded in `Product.type` |
| `frameBrand`, `frameModel`, `frameColor`, `frameSize` | Optical | `ProductOpticalAttributes` | string, nullable | Optional | Only meaningful when `opticalKind = FRAME` |
| `lensType`, `lensMaterial`, `lensCoating` | Optical | `ProductOpticalAttributes` | string, nullable | Optional | Only meaningful when `opticalKind` is `LENS`/`CONTACT_LENS` |
| `batchNumber` | Medicine | `ProductMedicineAttributes` | string, nullable | Optional | |
| `expiryDate` | Medicine | `ProductMedicineAttributes` | date, nullable | Optional | Drives the expiry-risk/reporting consumers (see entity-map doc) |

**Visibility rule** (enforced in the frontend, per ADR-4): a field row above is only rendered in the UI if the current tenant's `enabledIndustryPacks` includes that attribute's owning pack. **Validation rule**: none of these fields are ever required for a `Product` whose `productKind`/pack doesn't apply — this matches today's actual validation behavior (already all `.optional()` in `products.routes.js`), so no regression risk here; the gap being closed is visibility/structure, not validation.

---

## 4. Classification & Legacy Mapping Specification

| Legacy `ProductType` value | Target `productKind` | Target extension | Target sub-kind |
|---|---|---|---|
| `GENERAL` | `PHYSICAL_GOOD` | none | — |
| `FRAME` | `PHYSICAL_GOOD` | `ProductOpticalAttributes` | `opticalKind = FRAME` |
| `LENS` | `PHYSICAL_GOOD` | `ProductOpticalAttributes` | `opticalKind = LENS` |
| `MEDICINE` | `PHYSICAL_GOOD` | `ProductMedicineAttributes` | — (no sub-kind needed; pharmacy has one shape today) |
| *(new, not a legacy value)* `SERVICE` | `SERVICE` | none | — |

No legacy value maps to "unclear" or "owner decision" — all four map deterministically. `SERVICE` is net-new capability with no legacy data to migrate (confirmed: no service-like products exist in the current schema/data model at all).

---

## 5. Open Decisions Requiring Product Owner Approval

Before implementation (step 4 onward) can begin, please confirm or redirect on each:

1. **ADR-1** (per-pack extension tables vs. a generic dynamic attribute engine) — recommend approving the per-pack table approach.
2. **ADR-4** (`enabledIndustryPacks` as a simple string array vs. a full join-table/module system now) — recommend the simple array.
3. **ADR-5** (introducing a universal `brand` field) — recommend approving; low-risk additive field.
4. **ADR-6** (Variant table added structurally, no data migrated into it yet) — recommend approving.
5. **Scope of this phase's actual migration**: should the migration in this phase also add an optional `Product.defaultTaxRateId` FK (the spec's target field list mentions "pricing/tax references," which doesn't exist on Product today at all — tax is currently applied only at the Sale-line level)? This is a legitimate gap against the spec's target model, but is not required by any legacy field mapping and could reasonably be deferred to a later phase without blocking anything else here. **Recommend deferring** — flagging it now so it isn't silently dropped, per the spec's own instruction not to let unrelated findings expand or silently shrink this phase's true scope.

---

## 6. What Happens After Approval (Implementation Sequence, steps 4-10 — not started)

1. Implement the new tables/columns via an additive Prisma migration (see Migration & Rollback Plan doc).
2. Implement the compatibility/adapter layer in a new `products` domain/service module (currently business logic lives directly in `products.routes.js` — this phase introduces the service-boundary separation the spec requires in §9).
3. Write the one-time data-backfill script (idempotent, safe to re-run) migrating existing FRAME/LENS/MEDICINE rows into the new extension tables.
4. Test the migration against an isolated local database (never the live Neon DB — see the separately-tracked Phase 0.1 Test DB Safety condition).
5. Update the 8 identified backend consumers to read from the new structures where appropriate, without breaking their current output contracts.
6. Update the 4 identified frontend consumers, introducing the `enabledIndustryPacks`-aware conditional rendering.
7. Run the full regression/security/migration test matrix (see companion doc).
8. Produce the Implementation/Change Log and Phase 0.3 Handover Package (the two remaining spec deliverables not produced in this design-only pass).
9. Return to you for the final Phase 0.2 completion sign-off (§19 Phase Gate).

**Nothing in this section has been started. This document stops here, pending your approval of §5.**
