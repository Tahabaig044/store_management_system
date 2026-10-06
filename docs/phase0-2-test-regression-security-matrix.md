# Phase 0.2 — Test / Regression / Security Matrix (Planned)

Companion to [`phase0-2-architecture-package.md`](./phase0-2-architecture-package.md). **This is a plan of what will be tested once implementation begins — no test has been written or run yet, since no implementation code exists.** Structure follows spec §13's four categories exactly.

---

## 1. Unit tests (product/service creation, classification, attributes, validation, mapping)

| Test | Purpose |
|---|---|
| Creating a `productKind: PHYSICAL_GOOD` product with no industry pack fields succeeds | Confirms Acceptance Criterion 1 ("generic business can create/sell a physical product without Optical/Medical fields") |
| Creating a `productKind: SERVICE` product succeeds and stock fields are ignored/nulled | Confirms Acceptance Criterion 2 |
| Creating a legacy `type: 'FRAME'` product still succeeds and produces a corresponding `ProductOpticalAttributes` row with `opticalKind: FRAME` | Confirms the classification mapping's FRAME row |
| Same for `LENS` → `opticalKind: LENS`, and `MEDICINE` → `ProductMedicineAttributes` row | Confirms remaining classification mapping rows |
| Adapter correctly round-trips: create via legacy `type`+flat fields, read back, confirm both legacy fields and new nested `opticalAttributes`/`medicineAttributes` are present and consistent | Confirms dual-write sync (API Compatibility Plan §B.2) |
| Backfill script run twice against the same seed data produces no duplicate extension rows | Confirms migration idempotency (spec §8) |

## 2. Integration tests (API → service → database)

| Test | Purpose |
|---|---|
| `POST /api/products` with legacy payload shape (current `business.test.js` fixtures) still returns 201 with the same response shape as today | Regression: no breaking API change |
| `POST /api/products` with new `productKind`/`brand` fields, no `type`, succeeds | New capability |
| `GET /api/products/:id` for a pre-migration FRAME product returns both `type: 'FRAME'` and a populated `opticalAttributes` object | Confirms backfill + read adapter |
| `PATCH /api/products/:id` updating a legacy frame field (e.g. `frameColor`) also updates `ProductOpticalAttributes.frameColor` | Confirms ongoing dual-write, not just one-time backfill |

## 3. Migration tests (representative legacy Optical/Medical records, before/after mapping)

| Test | Purpose |
|---|---|
| Seed one `GENERAL`, one `FRAME`, one `LENS`, one `MEDICINE` product against a fresh isolated test database; run migration + backfill; assert each row's post-migration state matches the Classification Mapping table exactly | Direct verification of the migration plan |
| Re-run the backfill a second time; assert zero new rows created, zero errors | Idempotency proof (also listed under Unit, cross-referenced here as it's explicitly a spec-required migration test) |
| Rollback (down-migration) restores the schema to its exact pre-migration shape with zero data loss on the `Product` table | Confirms the Rollback Plan (§A.2 of the migration doc) |

## 4. Regression tests (products, sales, purchases, inventory, optical orders, medicine workflows)

| Test | Purpose |
|---|---|
| Full existing `business.test.js` Products/Sales/Purchases/Stock suites pass unmodified | No functional regression in the transactional core (already confirmed in the entity-map document that these modules don't branch on `.type` at all — low risk, but must be proven, not assumed) |
| Full existing `clinical.test.js` Optical Order lifecycle tests pass unmodified | Confirms the (already-established) independence of the Optical job workflow from `Product` |
| `/api/reports/medicine-expiry` and `/api/reports/inventory` continue returning the same shape and correct data for pre- and post-migration products | Confirms report-layer compatibility |
| Frontend `Products.test.jsx`-equivalent (currently does not exist per the Phase 0.1 Test Coverage Matrix — **a new test should be added here**, not assumed to already exist) covering the new conditional-rendering behavior | Closes a pre-existing coverage gap that this phase's own UI change would otherwise leave completely untested |

## 5. Security tests (cross-tenant and relevant cross-branch access)

| Test | Purpose |
|---|---|
| Tenant A cannot read/write Tenant B's `ProductOpticalAttributes`/`ProductMedicineAttributes`/`ProductVariant` rows by ID, even if they guess a valid UUID | Direct test of spec §12's explicit instruction to "test unauthorized access explicitly rather than relying on UI restrictions" |
| A request supplying a `productId` belonging to another tenant when creating/updating an extension record is rejected | Confirms the "industry extension records inherit the parent Product authorization boundary" requirement |
| No cross-branch test is required for `Product` itself, since Product is confirmed tenant-wide (not branch-scoped) both before and after this phase — explicitly noting this is a deliberate no-op, not an oversight | Per spec §12's "relevant" qualifier — branch-scoping doesn't apply here |

## 6. Negative tests (duplicate identifiers, invalid attributes, incompatible classifications, unauthorized access)

| Test | Purpose |
|---|---|
| Creating a product with a `sku` that already exists for the tenant still fails with the existing uniqueness error (unchanged behavior) | Regression on existing `@@unique([tenantId, sku])` constraint |
| Setting `opticalKind` to an invalid enum value is rejected by validation | New-field validation |
| Setting `productKind: SERVICE` while also supplying Optical/Medicine extension data — decide and test the defined behavior (recommend: allowed but flagged as unusual, not blocked outright, since a "service" with informational batch/expiry metadata isn't inherently invalid; this is a design point to confirm during implementation, not a hard rule already decided here) | Classification-consistency validation |
| Unauthenticated or wrong-tenant request to any new endpoint/field is rejected exactly like existing Product endpoints | Unauthorized-access regression |

---

## Coverage gap this plan deliberately surfaces rather than silently accepting

Per the Phase 0.1 Test Coverage Matrix, `Products.jsx` currently has **zero frontend tests** and stock-concurrency testing is entirely absent project-wide. This phase's implementation should not proceed to completion without at least the new conditional-rendering behavior being covered (row 4 above) — but a full closure of the pre-existing stock-concurrency gap (Phase 0.1 Refactoring Backlog P1 item 6) remains explicitly out of scope for Phase 0.2 unless the Product changes themselves introduce a new concurrency-sensitive path (they should not, per this design — `productKind`/extension tables are metadata, not stock-movement logic).
