# Phase 0.2 — Database Migration & Rollback Plan, and API Compatibility Plan

Companion to [`phase0-2-architecture-package.md`](./phase0-2-architecture-package.md). **Planning document only — no migration has been written or run.**

---

## Part A — Database Migration & Rollback Plan

### A.1 Migration sequence (once approved)

1. **Additive schema migration** (a single Prisma migration, or two if you prefer smaller reviewable steps):
   - `CREATE TABLE product_optical_attributes` (id, tenant_id, product_id UNIQUE FK → products, optical_kind enum, frame_brand, frame_model, frame_color, frame_size, lens_type, lens_material, lens_coating)
   - `CREATE TABLE product_medicine_attributes` (id, tenant_id, product_id UNIQUE FK → products, batch_number, expiry_date)
   - `CREATE TABLE product_variants` (id, tenant_id, product_id FK → products, name, sku, barcode, price_override, stock_quantity, is_active)
   - `ALTER TABLE products ADD COLUMN product_kind ... DEFAULT 'PHYSICAL_GOOD'`
   - `ALTER TABLE products ADD COLUMN brand VARCHAR NULL`
   - `ALTER TABLE tenants ADD COLUMN enabled_industry_packs TEXT[] DEFAULT ARRAY['OPTICAL','MEDICINE']` (per ADR-4, backfills existing tenants to today's behavior)
   - **No existing column is dropped, renamed, or retyped. No existing row's data is deleted.**
2. **Idempotent data-backfill script** (a separate script, not embedded in the schema migration, run once against the target database):
   - For every `Product` where `type IN ('FRAME','LENS')`: **upsert** (not insert) a `ProductOpticalAttributes` row keyed by `productId`, copying the relevant existing columns and setting `opticalKind` per the Classification Mapping table.
   - For every `Product` where `type = 'MEDICINE'`: **upsert** a `ProductMedicineAttributes` row keyed by `productId`, copying `batchNumber`/`expiryDate`.
   - Using `upsert` keyed on the unique `productId` makes the script **safe to re-run** (spec §8: "Make migrations safe against accidental repeated execution") — a second run finds existing rows and updates them to the same values rather than creating duplicates or erroring.
   - The script does **not** touch `Product.type` or any of the 9 legacy columns — pure read-and-copy.

### A.2 Rollback plan

Because every change in A.1 is additive (new tables, new nullable/defaulted columns), rollback is low-risk and has two independent layers:
1. **Schema rollback**: a down-migration that drops the 3 new tables and the 2 new `Product` columns and the 1 new `Tenant` column. Since no existing column/table is touched, this is guaranteed not to lose any pre-existing data.
2. **Data safety**: because the backfill script only *reads* from legacy columns and *writes* to new tables, even a partially-run or failed backfill leaves the legacy columns — and therefore every existing consumer reading them — completely unaffected. Rollback of the backfill is simply: drop the new tables (covered by the schema rollback above); nothing needs to be restored on the `Product` table itself.

### A.3 Tenant/branch isolation in the new tables

Per spec §12 and the Phase 0.1 lesson (16 existing tables lack direct `tenantId`, flagged as a Critical defense-in-depth gap): all 3 new tables (`ProductOpticalAttributes`, `ProductMedicineAttributes`, `ProductVariant`) get their own direct `tenantId` column from day one, not just an inherited join through `productId`. This directly applies the Phase 0.1 finding rather than repeating it.

### A.4 Testing the migration (per spec §13 "Migration" testing strategy)

- Run against an isolated local test database only (never the live Neon database — see the separately-tracked Phase 0.1 Test DB Safety condition; this migration's testing is an additional reason that condition should be closed before implementation begins).
- Test with a representative sample: at least one `GENERAL`, one `FRAME`, one `LENS`, and one `MEDICINE` product, confirming each ends up with the correct `productKind` + extension row (or no extension row, for `GENERAL`) after the backfill.
- Test the backfill script's idempotency explicitly: run it twice against the same seeded data and confirm the second run produces zero duplicate rows and no errors.

---

## Part B — API Compatibility Plan

### B.1 Compatibility guarantee

Every existing `products.routes.js` request and response shape continues to work exactly as today, for the duration of this phase:
- `POST/PATCH /api/products` still accepts `type` and all 9 legacy fields exactly as now (all already optional, per the current zod schema — confirmed, no validation change needed for backward compatibility).
- `GET /api/products` / `GET /api/products/:id` still return `type` and all 9 legacy fields in their responses.
- No route is removed, renamed, or given a new required field that a legacy Optical/Medical caller doesn't already send.

### B.2 New, additive surface

- Request/response payloads gain optional new fields: `productKind`, `brand`, and (when present) nested `opticalAttributes`/`medicineAttributes` objects mirroring the new tables' contents.
- A new service/domain layer (spec §9: "Centralize product business rules in the service/domain layer rather than controllers") sits between `products.routes.js` and Prisma, responsible for:
  - Translating incoming legacy `type` + flat fields into the new `productKind` + extension-table writes (dual-write, so both old and new structures stay in sync during the transition).
  - Assembling the legacy flat fields back out of the extension tables for read responses, OR (simpler, lower-risk for this phase) continuing to read/write the legacy columns directly as the source of truth for now, with the extension tables kept as *read replicas* populated by the backfill + ongoing dual-write, promoted to source-of-truth only in a later phase once every consumer has migrated. **This sequencing choice is called out explicitly as a design point**: starting with legacy-columns-as-source-of-truth is the lower-risk option and is the recommended default; the alternative (extension-tables-as-source-of-truth from day one) is possible but raises the stakes of getting the dual-write adapter right immediately. Recommend the lower-risk default.

### B.3 Validation

- Validation remains industry/configuration-aware: a `productKind: SERVICE` product's schema does not require or expose stock-related fields as meaningful; a `productKind: PHYSICAL_GOOD` product without any industry pack enabled does not require or show any Optical/Medicine field (already true today at the validation layer — this phase's job is to make the *UI* match what validation already allows, not to loosen validation further).

### B.4 Regression testing obligation (per spec §9: "Regression-test existing Optical/Medical endpoints and payload expectations")

Before any implementation is considered complete, the existing `business.test.js` product tests (barcode uniqueness, category ownership, stock adjustment — all identified in the Phase 0.1 Test Coverage Matrix) must continue to pass unmodified, plus new tests covering the additive fields (see the companion Test/Regression/Security Matrix document).

### B.5 Security (spec §12)

- All new tables' reads/writes are tenant-scoped from creation (§A.3 above) — no new cross-tenant surface is introduced.
- Industry extension records inherit `Product`'s authorization boundary: every extension-table query in the service layer is scoped by `tenantId` *and* joined through an already-tenant-verified `productId`, matching the safe pattern already used throughout the codebase (`findFirst({id, tenantId})`).
- No generic/dynamic attribute endpoint is introduced (per ADR-1's rejection of a generic EAV store), so the specific cross-tenant risk the spec warns about ("Generic attribute endpoints cannot permit cross-tenant access") does not arise as a new attack surface — there is no generic attribute endpoint in this design.
- Branch-sensitive operations: `Product` itself is not branch-scoped today (confirmed in Phase 0.1 — products are tenant-wide, not per-branch), and this phase does not change that. The new tables inherit the same (tenant-wide, not branch-scoped) model, consistent with their parent.
