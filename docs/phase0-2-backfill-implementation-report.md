# PHASE 0.2 — BACKFILL IMPLEMENTATION & FINAL CLOSURE REPORT

**Date:** 2026-09-17 | **Scope:** the one remaining Phase 0.2 condition — the one-time legacy Product backfill mechanism — only. No Phase 0.3 work, no Company/Branch changes, no Owner Mobile changes, no unrelated refactoring.

---

## 1. Backfill Script Location

`backend/prisma/backfillProductExtensions.js`, run manually via:
```
npm run backfill:product-extensions          # live run
node prisma/backfillProductExtensions.js --dry-run   # preview only, zero writes
```
(the `backfill:product-extensions` npm script was added to `backend/package.json`, alongside the existing `seed` script it's modeled on)

It is **not** wired into `prisma migrate deploy`, the app's startup, or any route — it is a standalone, manually-triggered, one-time tool, exactly like the project's existing `prisma/seed.js`.

It reuses `syncExtensionsFromLegacyFields` from `backend/src/modules/products/productService.js` — the exact same function the live create/update routes already call — so the backfilled data is guaranteed identical in shape to what those routes would produce for the same input, with no separate/duplicated mapping logic to drift out of sync.

---

## 2. Legacy → New-Field Mapping (as implemented)

| Legacy `Product` field(s) | Condition | New location |
|---|---|---|
| `type = 'FRAME'` | any | `ProductOpticalAttributes` row created/updated, `opticalKind = FRAME` |
| `type = 'LENS'` | any | `ProductOpticalAttributes` row created/updated, `opticalKind = LENS` |
| `frameBrand`, `frameModel`, `frameColor`, `frameSize` | `type` is FRAME or LENS | copied verbatim into the same `ProductOpticalAttributes` row (present or null, matching source) |
| `lensType`, `lensMaterial`, `lensCoating` | `type` is FRAME or LENS | copied verbatim into the same `ProductOpticalAttributes` row |
| `type = 'MEDICINE'` | any | `ProductMedicineAttributes` row created/updated |
| `batchNumber`, `expiryDate` | `type = 'MEDICINE'` | copied verbatim into `ProductMedicineAttributes` |
| `type = 'GENERAL'` | any | no extension row — correctly skipped, not an omission |

No legacy column is deleted, renamed, or overwritten by this script at any point — it only ever *reads* `Product` columns and *writes* to the two new extension tables.

---

## 3. Verification Performed

All of the following was executed against a **freshly created, fully isolated local database** (`akvisionflow_backfill_test` on the portable Postgres instance at `127.0.0.1:5432`) — never the live Neon database. The server was stopped again at the end.

### 3.1 Representative legacy fixture (9 products across 2 tenants, inserted by directly calling Prisma — bypassing the new service layer entirely, to accurately simulate rows that existed before Phase 0.2's code did)

| Product | Type | Notable characteristic |
|---|---|---|
| A-General Widget | GENERAL | should be skipped — no extension expected |
| A-Full Frame | FRAME | all 4 frame fields populated |
| A-Partial Frame | FRAME | only `frameBrand` set, rest null — edge case |
| A-Full Lens | LENS | all 3 lens fields populated |
| A-Empty Lens | LENS | **zero** lens fields populated — edge case (type says LENS but no attribute data exists) |
| A-Full Medicine | MEDICINE | both `batchNumber` and `expiryDate` set |
| A-Expiry-Only Medicine | MEDICINE | `expiryDate` only, no `batchNumber` — edge case |
| B-Frame | FRAME | different tenant (B), for cross-tenant isolation proof |
| B-Medicine | MEDICINE | different tenant (B) |
| A-Already-Migrated Frame | FRAME | **already has** an extension row, simulating a product created after Phase 0.2 went live — exercises the idempotent re-sync path within the same run |

### 3.2 Records Processed

- **Total products in fixture database:** 10
- **Products with an industry-specific legacy type (candidates for backfill):** 9
- **Products correctly skipped (GENERAL, no extension needed):** 1

### 3.3 Records Successfully Migrated

- **Dry run** (`--dry-run`): reported 8 "would create" + 1 "would re-sync" = 9, **zero writes made** — confirmed independently via direct row-count query before and after (`product_optical_attributes`/`product_medicine_attributes` counts unchanged at 1/0).
- **Live run:** 8 extension rows newly created, 1 already-present row re-synced (the pre-seeded "already migrated" one) = **9/9 successful, 0 exceptions.**

### 3.4 Records Requiring Exceptions

**Zero.** The script's exception-handling path (per-product try/catch, logged and counted, non-fatal to the rest of the run) was implemented but never triggered in this run — every one of the 9 representative records, including the two deliberately sparse edge cases (a LENS with no lens fields, a MEDICINE with no batch number), was processed successfully. This confirms the mapping logic tolerates partially-populated legacy data correctly rather than assuming every field is present.

### 3.5 Idempotency Verification

The script was run a **second time** against the now-migrated database:
- Result: 0 newly created, 9 re-synced (100% correctly recognized as already-present).
- Row counts after the second run: **unchanged** — 6 `product_optical_attributes` rows, 3 `product_medicine_attributes` rows (same as after the first run).
- Explicit duplicate check (`GROUP BY "productId" HAVING count(*) > 1`) on both tables: **0 rows returned** — no duplicates, on either table.
- This safety is structural, not just behavioral: both extension tables have a DB-level `UNIQUE` constraint on `productId`, so even a theoretical bug in the script's own upsert logic could not have produced a duplicate — the database itself would reject it.

### 3.6 Before/After Data Verification

Directly queried and compared, row by row:
- **Legacy `Product` columns**: byte-for-byte identical before and after the backfill (verified via a full column dump of all 10 products, before and after) — confirms zero data loss or overwrite of existing data.
- **New extension data**: every field in every one of the 9 extension rows matches its source `Product` column exactly, including the two sparse edge cases (the "empty lens" product correctly got a `ProductOpticalAttributes` row with `opticalKind = LENS` and all attribute fields null — accurately representing "this is a lens, we just don't have its details," not silently dropped or defaulted to something incorrect).
- **Tenant isolation**: every one of the 9 extension rows' `tenantId` was verified to exactly match its parent product's `tenantId` (explicit `tenant_matches = true` check on every row) — confirmed even though Tenant A and Tenant B products were processed together in the same script run, with no cross-tenant contamination.
- **The pre-existing "already migrated" row**: its original values (`frameBrand: 'PreSynced'`, `frameColor: 'Gold'`) were preserved exactly through both backfill runs — re-syncing did not corrupt or duplicate it.

### 3.7 Regression Test Results

Run against the same database, **after** the backfill had already populated real extension data (not a clean database) — a stronger test than running regressions before any backfilled data existed:

- **Backend**: 288/288 passed across 11 suites on 2 of 3 full-suite runs today; **one transient failure** occurred in `tests/ai.test.js` on the first post-backfill run ("a conversation created in tenant A is invisible to tenant B", 500 error) — this test has **no code path that touches `Product`, `ProductOpticalAttributes`, `ProductMedicineAttributes`, or the backfill script in any way**. It was re-run in isolation immediately after (23/23 passed, including that exact test) and the full suite was re-run a second time afterward (288/288 passed, including `ai.test.js`). This is reported transparently as a pre-existing flake in an unrelated module, not a regression caused by this work — the evidence (passes in isolation, passes on full-suite retry, zero code overlap) supports that conclusion, but it is disclosed rather than hidden.
  - Specifically confirmed passing, every run: `business.test.js` (Sales/Purchases/Products/Stock, 80 tests), `clinical.test.js` (Optical/Medical workflows, 32 tests), `accounting.test.js` (27), `procurement.test.js` (17), `productArchitecture.test.js` (8).
- **Frontend**: 76/76 passed across all 19 files, both before and after the backfill work in this session.

---

## 4. Rollback / Recovery Procedure

Because the backfill only ever adds rows to the two new extension tables and never touches any pre-existing column, table, or row, rollback is simple and carries no risk to legacy data:

1. **To undo a backfill run** (e.g., if extension data needs to be recomputed from scratch for some reason): `DELETE FROM product_optical_attributes; DELETE FROM product_medicine_attributes;` — this has **zero effect** on the `products` table or any other data; the legacy columns remain exactly as they were, and the application continues to function exactly as it did before Phase 0.2 (since every consumer still reads the legacy columns as the source of truth per ADR-3).
2. **To recover from a partial/interrupted run**: no special recovery is needed — the script is idempotent (§3.5), so simply re-running it to completion will correctly finish any rows it didn't reach, and correctly re-confirm any it already processed, with no manual bookkeeping required.
3. **Full schema rollback** (undoing the Phase 0.2 migration entirely, not just the backfill): covered separately in `docs/phase0-2-migration-api-compatibility-plan.md` §A.2 — dropping the 3 new tables and 2 new `Product`/`Tenant` columns, which automatically removes all backfilled data along with them, with no impact on legacy columns.

---

## 5. Exact Production Execution Procedure

1. **Prerequisite**: the Phase 0.2 migration (`20260917120000_phase0_2_universal_product_architecture`) must already be applied to the target database (via the normal `prisma migrate deploy` process, already verified in `docs/phase0-2-final-verification-closure-report.md`).
2. **Take a database backup/snapshot** before running anything against production, per standard practice for any data-touching script — independent of this script's own safety, this is a baseline precaution.
3. **Restore that snapshot to a test/staging environment first.** Run:
   ```
   DATABASE_URL="<staging-db-url>" node prisma/backfillProductExtensions.js --dry-run
   ```
   Review the summary: confirm the "products with an industry-specific legacy type" count matches your expectation (roughly, the number of existing FRAME/LENS/MEDICINE products you know you have), and confirm **0 exceptions**.
4. **Run it live against staging**:
   ```
   DATABASE_URL="<staging-db-url>" node prisma/backfillProductExtensions.js
   ```
   Confirm the summary shows the expected "newly created" count and **0 exceptions**. If any exceptions are reported, they are logged with the specific `productId`/`tenantId`/`type` and error message — investigate those specific records before proceeding; the script's per-record try/catch means one bad record does not block the rest.
5. **Spot-check a handful of records** in staging (a few FRAME, LENS, and MEDICINE products) via the existing `GET /api/products/:id` endpoint, confirming the response now includes a populated `opticalAttributes`/`medicineAttributes` object alongside the unchanged legacy fields.
6. **Run your normal regression suite against staging** (or at minimum the Product/Sales/Purchase/Optical-Medical tests) — the same category of check performed in §3.7 of this report.
7. **Only after 3-6 are clean**, run the same command against production:
   ```
   DATABASE_URL="<production-db-url>" node prisma/backfillProductExtensions.js
   ```
   This is safe to run during business hours if needed — it makes no schema changes, holds no long-running locks (each product is processed in its own small transaction), and every write is additive-only.
8. **It is safe to run again** at any time afterward (e.g., if new legacy-typed products are somehow created through a path that bypasses the dual-write, or simply as a periodic consistency check) — idempotency is proven in §3.5, not just assumed.

---

## 6. Final Status

## **CLOSED**

Every item from the CLOSED WITH CONDITIONS report is now resolved:
- The one-time backfill mechanism exists, is documented, and is proven correct against representative data covering the normal case, sparse/partial-data edge cases, multi-tenant isolation, and the idempotent re-run case.
- Zero data loss, zero duplicates, zero unexplained exceptions.
- Full regression suite (backend + frontend) passes, with one unrelated pre-existing test flake disclosed and independently shown not to be caused by this work.
- A concrete, safe, step-by-step production execution procedure is documented, including a rollback path.

**Not done, correctly, per your instructions**: Phase 0.3 was not started, no Company/Branch changes were introduced, Owner Mobile was not touched, and no refactoring beyond this specific backfill mechanism was performed.

**Phase 0.2 is now fully closed.** Stopping here — Phase 0.3 will not begin until you explicitly approve it.
