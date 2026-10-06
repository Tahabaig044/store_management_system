# Phase 4 — Production Hardening: Operations Runbook

This document covers the operational procedures required by Phase 4
(production hardening): deployment/configuration verification, rollback,
and database backup/recovery. It supplements, and does not replace, the
existing `README.md` deployment section.

## 1. Production Deployment/Configuration Checklist

Verified live during this phase (re-confirmed against the actual deployed
services, not assumed from code):

- [x] Backend deployed on Vercel (`https://clinickhalideye.vercel.app`) —
      `/api/health` returns `200 {"status":"ok"}`.
- [x] Frontend deployed on Vercel (`https://khalideye-iota.vercel.app`) —
      loads the correct SPA shell, client-side routes (`/login`, `/dashboard`)
      resolve via the SPA rewrite instead of 404ing, and the bundled JS
      correctly targets the backend above.
- [x] CORS: the live backend allows the live frontend's exact origin and
      rejects both an arbitrary origin and `localhost` — confirmed via direct
      preflight/GET requests with different `Origin` headers.
- [x] `VITE_API_URL` (frontend) — confirmed correct by decompiling the live
      bundle; it calls the backend URL above.
- [x] Neon database — reachable, all 4 pre-Phase-4 migrations applied, no
      drift (`prisma migrate status`).
- [ ] **Neon backup/PITR configuration** — requires the Neon dashboard/API,
      which this environment does not have credentials for. **This remains
      the operator's responsibility to confirm** (see §3).
- [ ] **Exact deployed commit SHA for each Vercel project** — not verifiable
      without Vercel CLI/dashboard access in this environment; behavior is
      consistent with the latest pushed `main` at the time of deployment.

Before deploying **this phase's** changes to production, additionally:

- [ ] Run `npx prisma migrate deploy` against the production `DATABASE_URL`
      to apply `20260912054836_add_branch_to_sale_purchase` (additive only:
      two nullable columns, two indexes, two `ON DELETE SET NULL` foreign
      keys — no data is rewritten or at risk).
- [ ] Confirm `npm audit fix` is applied at a convenient time (see §4) —
      non-blocking, no code changes required by this phase depend on it.

## 2. Rollback Procedure

Application code (Vercel):

1. Vercel keeps every previous deployment. To roll back, promote the last
   known-good deployment for the affected project (frontend or backend)
   back to production from the Vercel dashboard ("Promote to Production" on
   an earlier deployment) — this requires no code change or redeploy.
2. If rolling back past this phase's migration, do **not** run
   `prisma migrate reset`. The `branchId` columns added in this phase are
   nullable and harmless to leave in place even if the application code is
   rolled back to a pre-Phase-4 version that doesn't read them.

Database:

- This phase's migration is purely additive (nullable columns/indexes/FKs
  with `ON DELETE SET NULL`). There is no destructive rollback migration
  needed — simply redeploying older application code alongside the new
  columns is safe, since old code never references `branchId`.
- If a genuine schema rollback is ever required for a different, destructive
  migration in the future, restore from a backup taken immediately before
  that migration was applied (see §3), rather than attempting to hand-write
  a reverse migration against live data.

## 3. Database Backup & Recovery Procedure

**Primary mechanism: Neon's built-in Point-in-Time Recovery (PITR).**
Neon retains a continuous history of the database and can restore to any
point within the plan's retention window directly from the Neon
dashboard/API, without a manual `pg_dump`. **Confirming PITR is enabled and
knowing the retention window is an operator action requiring Neon dashboard
access** — this was not obtainable in this session's sandboxed environment
and remains an open item (tracked in the Phase 4 final report).

**Secondary/manual mechanism** (documented previously in `README.md` and
re-confirmed conceptually this phase):

1. Take a backup: `pg_dump "<production DATABASE_URL>" -Fc -f backup.dump`
2. Restore into a **separate, disposable** database (never directly over
   production): `pg_restore -d "<disposable DATABASE_URL>" backup.dump`
3. Verify: connect to the disposable database, run `npx prisma migrate
   status` against it (should show all migrations applied, schema current),
   and spot-check row counts for key tables (`tenants`, `users`, `sales`,
   `purchases`) against the source.
4. Discard the disposable database once verified.

**Limitation disclosed honestly:** this phase's sandboxed environment
blocked a live `pg_dump` directly against the production Neon database as a
safety measure (the session's tool-use classifier refused a direct
credentialed connection to production infrastructure), and the user elected
to verify backup/PITR and the restore drill directly via the Neon dashboard
instead of through this session. **A live restore drill has not been
independently re-performed in this Phase 4 session** — this is carried
forward as an open operational item, not silently marked done.

## 4. Dependency Findings

`npm audit` (backend) still reports 3 moderate advisories in `qs` (pulled
in transitively via `express`/`body-parser`): an array-limit bypass and a
buffer-check DoS. **Update from the last audit:** `npm audit fix` now
resolves all three (a fix was not available upstream previously). Not
applied in this phase (no code in this phase depends on it, and unrelated
dependency bumps are out of this phase's scope) — recommended as routine,
low-risk maintenance whenever convenient.
