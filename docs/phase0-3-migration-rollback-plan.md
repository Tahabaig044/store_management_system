# Phase 0.3 — Database Migration & Rollback Plan

## Migration file

`backend/prisma/migrations/20260917100806_phase0_3_multi_tenant_company_branch/migration.sql` — **tool-generated** via `npx prisma migrate dev` against an isolated scratch database (not hand-authored, unlike the Phase 0.2 migration, avoiding that class of risk entirely).

## What it does (purely additive)

```sql
ALTER TABLE "branches"   ADD COLUMN "companyId" TEXT;              -- nullable
ALTER TABLE "warehouses" ADD COLUMN "companyId" TEXT;              -- nullable

CREATE TABLE "companies" ( id, tenantId, name, code, isActive, createdAt, updatedAt );
CREATE TABLE "user_company_access" ( id, tenantId, userId, companyId, createdAt );

-- Indexes on tenantId for both new tables; unique (userId, companyId) on user_company_access.

ALTER TABLE "companies"           ADD CONSTRAINT ... FOREIGN KEY ("tenantId")  REFERENCES "tenants"("id")   ON DELETE CASCADE;
ALTER TABLE "user_company_access" ADD CONSTRAINT ... FOREIGN KEY ("tenantId")  REFERENCES "tenants"("id")   ON DELETE CASCADE;
ALTER TABLE "user_company_access" ADD CONSTRAINT ... FOREIGN KEY ("userId")    REFERENCES "users"("id")     ON DELETE CASCADE;
ALTER TABLE "user_company_access" ADD CONSTRAINT ... FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE;
ALTER TABLE "branches"            ADD CONSTRAINT ... FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT;
ALTER TABLE "warehouses"          ADD CONSTRAINT ... FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL;
```

**No existing column, table, row, or constraint is dropped, renamed, or retyped.** `companies` and `user_company_access` carry their own `tenantId` column directly (defense-in-depth, applying the Phase 0.1 lesson about child tables that relied purely on parent-join scoping).

`branches.companyId` → `RESTRICT`: a Company with branches still assigned to it cannot be deleted, forcing an explicit reassignment first — consistent with how this schema treats other referenced business entities (Customer, Supplier). `warehouses.companyId` → `SET NULL`: it's a derived convenience field, so losing it on a Company deletion is not destructive.

## Backfill (separate from the schema migration)

`backend/prisma/backfillCompanies.js` (`npm run backfill:companies`), same pattern as the Phase 0.2 Product backfill:
1. For every Tenant with no Company yet, creates one default Company named after the tenant's `businessName`.
2. Assigns every one of that tenant's Branches with `companyId IS NULL` to it.
3. Derives `Warehouse.companyId` from each warehouse's own Branch, for warehouses that have one.

**Idempotent, proven not just claimed**: run twice against the same database in verification — first run created what was needed, second run reported 0 new companies/branches/warehouses touched, 0 exceptions. Safe to re-run at any time.

**Forward-fix, not just backward patch**: `auth.controller.js`'s tenant-registration flow was also updated to create a default Company at registration time, so a brand-new tenant registering after this migration is applied never enters the "needs backfill" state in the first place — the backfill script exists for tenants that already existed before this phase.

## Rollback plan

Because every change is additive, rollback carries no risk to pre-existing data:

1. **Data rollback** (undo the backfill only): `DELETE FROM user_company_access; DELETE FROM companies;` then `UPDATE branches SET "companyId" = NULL; UPDATE warehouses SET "companyId" = NULL;`. Every other table and column is untouched by this.
2. **Full schema rollback** (undo the migration entirely): drop the 2 new tables and 2 new columns:
   ```sql
   ALTER TABLE "warehouses" DROP CONSTRAINT ...companyId_fkey, DROP COLUMN "companyId";
   ALTER TABLE "branches"   DROP CONSTRAINT ...companyId_fkey, DROP COLUMN "companyId";
   DROP TABLE "user_company_access";
   DROP TABLE "companies";
   ```
   No pre-existing column/table is affected.
3. **Code rollback**: since the new `/api/companies` routes and the `companyId` field are purely additive to existing endpoints (never replacing a required field elsewhere), reverting the code changes in this phase (routes, `branchScope.js`, frontend) requires no corresponding data migration — the schema rollback above is sufficient on its own if only the DB needs to revert.

## Verification evidence (see the Implementation & Verification Report for full detail)

- Migration applied cleanly to 3 separate fresh isolated databases across this session with zero errors.
- `prisma migrate status` confirmed "Database schema is up to date!" (no drift) after each apply.
- Every new table/column/index/constraint inspected directly via `psql` and matches this plan exactly.
- Backfill run twice (idempotency), against a database containing 52-58 real tenants created by the test suite, with 0 exceptions both times.
