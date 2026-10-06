# Phase 0.2 Input Package — Universal Product Architecture

This package hands off exactly what Phase 0.1 learned that Phase 0.2 needs, so Phase 0.2 can start from evidence instead of re-discovering it. It does not begin Phase 0.2 design work itself — per this project's phase-gated workflow, that starts only after Phase 0.1 is explicitly approved.

## 1. The core problem Phase 0.2 exists to solve

`Product` — the one entity every business using this system needs — is not universal today. From the Phase 0.1 Database Map:

- `Product.type` is a fixed 4-value Prisma enum: `GENERAL | MEDICINE | FRAME | LENS`.
- The table carries 9 permanently-nullable optical/pharmacy-specific columns: `frameBrand`, `frameModel`, `frameColor`, `frameSize`, `lensType`, `lensMaterial`, `lensCoating`, `batchNumber`, `expiryDate`.
- Every tenant that isn't optical/pharmacy pays for and ignores these columns; every new vertical needs a schema migration to add its own.
- No tenant-configurable custom-fields/attributes mechanism exists anywhere in the current schema.

This is the single highest-priority input from Phase 0.1 to Phase 0.2.

## 2. Directly related architecture findings Phase 0.2 should account for

1. **Fixed vertical-coupled enums elsewhere** (`AutomationEvent`, `TemplateType` in the Communication module) show the same anti-pattern is not unique to Product — whatever configuration mechanism Phase 0.2 designs for Product attributes should be reusable for these too, rather than solving the same problem twice.
2. **Six independent document+line-item workflows** (`Sale`, `Purchase`, `PurchaseOrder`, `PurchaseRequest`, `OpticalOrder`, `StockTransfer`) all reference `Product` as their line-item target. Any change to how Product is modeled needs to work across all six without requiring six separate migrations.
3. **Two incompatible polymorphic-reference patterns** already coexist in the schema (`Payment`'s per-target nullable FKs vs. `JournalEntry`/`AiForecast`'s `sourceType`+loosely-typed `sourceId`). If Phase 0.2's Product redesign introduces any new polymorphic relation (e.g., attribute-value storage), pick one pattern deliberately rather than adding a third.
4. **Existing reuse candidates already identified**: `Doctor` could generalize to a "Practitioner/Staff Resource" concept, and `Lab` to a "Fulfillment Partner" concept — both are currently Optical-Industry-Module-only but structurally close to something Product-adjacent industries (services businesses) would also need.
5. **`Product` is referenced with `RESTRICT` delete behavior everywhere it's transacted** (purchase/sale/RFQ/quotation/PO/GRN/warehouse-stock/transfer items) — any redesign must preserve this integrity guarantee (a product once transacted must remain referenceable by history).

## 3. What must NOT change (per Phase 0.1's own findings)

- The existing Optical/Medical fields and behavior must keep working exactly as-is for current tenants — Phase 0.2 should design an **additive** generalization (generic core + configurable extension), not a rewrite that risks breaking the Optical Industry Pack.
- `Category`, `Customer`, `Supplier` were all found to already be Universal Core / reusable as-is — no changes needed there as part of this work.
- The `InventoryTransaction` append-only ledger pattern was found to be a good universal pattern already — preserve it; Product changes should not require touching this ledger's shape.

## 4. Recommended Phase 0.2 starting questions (for the team to decide, not pre-answered here)

1. Should Product attributes become a generic EAV/JSON-attributes column, a formal custom-fields table, or a per-industry-pack schema extension table (1:1 FK, like `Patient` extends `Customer`)? Phase 0.1 notes `Patient`-as-extension-of-`Customer` as a **good existing example** of the third pattern already working in this codebase.
2. Does `ProductType` become fully open-ended (tenant-defined categories) or a smaller fixed set of universal types with industry packs contributing sub-types?
3. How does the answer to #1/#2 interact with the six document+line-item workflows (Refactoring Backlog item #10) — is that a Phase 0.2 concern or explicitly deferred to a later phase?

## 5. Evidence trail

Every claim above is sourced from, and cross-referenced against file:line evidence in:
- [`phase0-1-database-map.md`](./phase0-1-database-map.md) — Product entity definition, Cross-Cutting Findings A1–A5
- [`phase0-1-api-map-core.md`](./phase0-1-api-map-core.md) — `products.routes.js` schema/validation, §6 hard-coded industry assumptions
- [`phase0-1-ui-map.md`](./phase0-1-ui-map.md) — Products.jsx form fields, §4 hard-coded labels
- [`phase0-1-audit-report.md`](./phase0-1-audit-report.md) — Architecture Risks §3, items 1–3
- [`phase0-1-refactoring-backlog.md`](./phase0-1-refactoring-backlog.md) — P1 item 5, P2 items 9–11
