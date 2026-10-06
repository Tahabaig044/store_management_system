# AK VisionFlow

[![CI](https://github.com/Syedaashnaghazanfar/AKlines-SaaS-Project/actions/workflows/ci.yml/badge.svg)](https://github.com/Syedaashnaghazanfar/AKlines-SaaS-Project/actions/workflows/ci.yml)

**A multi-tenant SaaS ERP for optical shops, eye clinics, medical stores, and lens laboratories.**

AK VisionFlow replaces manual registers and spreadsheets with a single connected platform for inventory, sales, customers, suppliers, optical prescriptions and orders, payments, and reporting. Any number of unrelated shops can subscribe to it, each operating in complete data isolation on the same shared codebase.

> Built in three phases. **Phase 1** (Core Commercial MVP) and **Phase 2** (Offline creation & sync) are complete and hardened. Phase 3 (SaaS Control Plane — Master Portal, billing, multi-branch, notifications) has not been started.

---

## Table of contents

- [What's included](#whats-included)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
  - [Prerequisites](#prerequisites)
  - [Backend](#backend)
  - [Frontend](#frontend)
  - [Docker Compose (both at once)](#docker-compose-both-at-once)
- [Creating a tenant](#creating-a-tenant-a-real-shopclinic)
- [Offline creation & sync](#offline-creation--sync-phase-2)
- [Roles & permissions](#roles--permissions)
- [Database & migrations](#database--migrations)
- [Backup & restore](#backup--restore-postgresql)
- [Testing](#testing)
- [API overview](#api-overview)
- [Deployment checklist](#deployment-checklist)
- [Security notes](#security-notes)
- [Roadmap](#roadmap)

---

## What's included

**Phase 1 — Core Commercial MVP**
Login & tenant registration · role-based access control · products & inventory (general/medicine/frame/lens) · categories · customers & suppliers with ledgers · purchases with atomic stock receiving · POS/sales with atomic stock deduction and reversal · optical orders with prescriptions · expenses · payments · a dashboard · 10 built-in reports · a PWA app shell.

**Phase 2 — Offline creation & sync**
Creating a record in POS/Sales, Purchases, Expenses, Customers, Suppliers, or Optical Orders works identically online or offline, with idempotent sync (no duplicate records on a retried request) and explicit, human-reviewed conflict handling (nothing is ever silently dropped or force-applied). See [Offline creation & sync](#offline-creation--sync-phase-2).

The product is generic and tenant-independent. **Khalid Eye Clinic** is used only as a demo/test tenant via the seed script — nothing about it is hard-coded into the application.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express (REST API), Prisma ORM, PostgreSQL, JWT auth |
| Frontend | React (Vite) SPA, Bootstrap 5, React Router, Axios |
| Offline | IndexedDB via Dexie.js, a generic sync-outbox engine |
| PWA | Web App Manifest + Service Worker (app-shell caching) |
| Testing | Jest + Supertest (backend), Vitest + fake-indexeddb (frontend offline engine) |
| Deployment | Docker Compose (Postgres + backend + nginx-served frontend) |

## Repository layout

```
backend/    Express API, Prisma schema + migrations, seed script, tests
frontend/   React + Vite SPA, offline sync engine, tests
docker-compose.yml   Postgres + backend + frontend, for local or VPS use
```

---

## Quick start

### Prerequisites
- Node.js 20+
- A PostgreSQL 14+ instance (via Docker, a local install, or a hosted DB)

### Backend

```bash
cd backend
npm install
cp .env.example .env      # edit DATABASE_URL, DIRECT_URL, JWT_SECRET, etc.
npm run db:setup          # migrations + idempotent permission seed (required; otherwise every route is 403)
npm run seed               # optional: creates a SUPER_ADMIN + demo tenant (see below)
npm run dev                 # starts the API on http://localhost:4000
```

If you're iterating on the schema itself (not just deploying it), use `npx prisma migrate dev` instead of `migrate deploy` — it will prompt to create a new migration from your schema changes. Never run `migrate reset` against a database with real tenant data.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env       # set VITE_API_URL if not http://localhost:4000/api
npm run dev                 # starts the SPA on http://localhost:5173
```

### Docker Compose (both at once)

```bash
docker compose up --build
# Postgres  -> localhost:5432
# Backend   -> localhost:4000
# Frontend  -> localhost:8080
```

After the containers are up, run migrations and (optionally) the seed script inside the backend container:

```bash
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npm run seed
```

---

## Creating a tenant (a real shop/clinic)

Two ways:

1. **Self-service:** `POST /api/auth/register-tenant` (also available from the frontend's "Create your account" screen) creates a new tenant, its main branch, and its first `TENANT_ADMIN` user in one step.
2. **Seed script (demo data only):** `npm run seed` inside `backend/` creates a demo tenant (default: "Khalid Eye Clinic") with sample categories, products, a customer, and a supplier, plus a platform `SUPER_ADMIN` user. This is **separate from production migrations** and should not be run against a production database unless you specifically want demo data.

Default seed credentials are controlled by environment variables in `.env` (`SEED_SUPER_ADMIN_EMAIL/PASSWORD`, `SEED_DEMO_ADMIN_EMAIL/PASSWORD`) — **change these before running the seed against anything but a local/dev database.**

---

## Offline creation & sync (Phase 2)

Creating a record in POS/Sales, Purchases, Expenses, Customers, Suppliers, or Optical Orders works identically online or offline.

**How it works** (`frontend/src/offline/`):
- `db.js` — a per-tenant IndexedDB database (via Dexie.js). Caches `products`, `customers`, `suppliers`, and `expenseCategories` for read access, plus one durable outbox table per entity (`pendingSales`, `pendingPurchases`, `pendingExpenses`, `pendingCustomers`, `pendingSuppliers`, `pendingOpticalOrders`).
- `syncEngine.js` — `createOutbox()` builds a full queue/sync/retry/discard lifecycle shared by every entity. Every create is written to its outbox first, with a client-generated idempotency key created once at queue time; `submit()` queues and then, if online, attempts to sync immediately, so the user never waits on the network. `syncAll()` drains every outbox at once (called automatically on reconnect and on app mount, or on demand via the "Sync Now" button in the sync status widget).
- **Idempotency is enforced server-side, not just client-side.** Every model that accepts offline creation (`Sale`, `Purchase`, `Expense`, `Customer`, `Supplier`, `OpticalOrder`) has a `@@unique([tenantId, idempotencyKey])` constraint; the corresponding controller looks up that key before creating and returns the original record on a retry instead of duplicating it. This is what makes a retried sync (after a dropped connection mid-request) safe.
- **Conflicts are never auto-resolved.** The sync engine relies entirely on each entity's existing server-side validation (e.g. the atomic stock-check in `POST /api/sales`) — a rejected item is marked `conflict` (409) or `failed` (other 4xx) and left in the sync status widget for a human to retry or discard. Nothing is ever silently dropped or force-applied.
- Cached lists used in offline-capable forms (products, customers, suppliers, expense categories) are reactive via Dexie `liveQuery`, so they reflect optimistic changes, completed syncs, and cache refreshes immediately.

**Known limitation:** an offline-created record (e.g. a brand-new Customer) cannot yet be referenced by another offline-created record (e.g. a Sale for that customer) in the same offline session, because the real server ID doesn't exist until it syncs. Referencing an already-existing customer/supplier/product while offline works fine. Browsing/searching full lists (Customers, Suppliers, Purchases, Expenses, Optical Orders) still requires connectivity — only creation is offline-capable; the underlying server-side pagination isn't replicated into the local cache.

**Verifying it manually:** open a page (e.g. POS or Expenses) once while online to populate its cache, then go offline (e.g. DevTools → Network → Offline) and create a record — it should show a "saved on this device" notice and a pending badge in the top bar. Reconnect and it should sync automatically, the badge should update, and the record should appear in the list.

---

## Roles & permissions

`TENANT_ADMIN`, `MANAGER`, `CASHIER`, `STORE_KEEPER`, `RECEPTIONIST`, `ACCOUNTANT` are tenant-scoped roles created via the Users page (Tenant Admin only). `SUPER_ADMIN` is a platform-level foundation role (no `tenantId`) — the full Master Portal for managing tenants is Phase 3. All role checks are enforced server-side (`backend/src/middleware/auth.js`, `backend/src/constants/roles.js`); the frontend only hides UI it knows the user can't use.

**Phase 4.1:** the mobile app is an owner/management app - `TENANT_ADMIN` and `MANAGER` may hold a mobile session (every other role is refused at login exactly like a wrong password). What a session may do still comes from the permission catalog above (mobile report routes need `REPORT:VIEW`), login/profile return an `access` block (real role, permission keys, branch scope), and `GET /api/mobile/v1/context` returns the branches/companies the session may use.

"Owner Mobile" (the Android app's access level) is **not** a separate `RoleName` in the database — a `TENANT_ADMIN` who logs in through `/api/mobile/v1/auth/login` gets a token carrying `typ: 'mobile'`, which is what actually restricts them to read-only, mobile-namespaced endpoints (see "Owner Mobile (Android app) API" above). Their web account and permissions are completely unaffected.

---

## Database & migrations

Migrations live in `backend/prisma/migrations/` and are version-controlled. Rules enforced by convention in this codebase:

- Migrations are **additive** — never edit a migration that has already been applied to a shared/production database. Create a new one instead.
- `npx prisma migrate deploy` is the **production-safe** command — it applies pending migrations without ever resetting data. Never run `prisma migrate reset` against a database holding real tenant data.
- Soft-delete (`isActive` flags, `archivedAt`) is used for master data (products, customers, suppliers, categories, branches) so historical sales/purchases referencing them stay valid.
- Financial and stock transactions (`Sale`, `Purchase`, `InventoryTransaction`, `Payment`) are never physically deleted or edited after the fact — sales are reversed via `POST /api/sales/:id/reverse`, which restores stock and marks the original record `REVERSED` rather than deleting it.

---

## Backup & restore (PostgreSQL)

**Backup:**
```bash
pg_dump -Fc "$DATABASE_URL" -f akvisionflow_$(date +%Y%m%d_%H%M).dump
```

**Restore (into an empty database):**
```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists akvisionflow_YYYYMMDD_HHMM.dump
```

**If running via `docker-compose.yml`**, run `pg_dump`/`pg_restore` inside the `postgres` container instead (it has the matching client tools installed):
```bash
docker compose exec postgres pg_dump -U postgres -Fc akvisionflow -f /tmp/backup.dump
docker cp $(docker compose ps -q postgres):/tmp/backup.dump ./akvisionflow_$(date +%Y%m%d_%H%M).dump
```
To restore, copy the dump back in and run `pg_restore` the same way, ideally into a separate database first (`CREATE DATABASE akvisionflow_restore_test;`) to verify it before ever restoring over a live one.

Take a backup before every migration deploy against a production database, and test the restore procedure on a staging database periodically — a backup you have never restored from is not a verified backup. **This procedure has been verified end-to-end**: a live backup was taken, restored into a separate test database, and every table's row count matched the original exactly (tenants, users, products, sales, purchases, customers).

---

## V1 documentation

| Document | Purpose |
|---|---|
| [docs/V1-PRODUCTION-READINESS-REPORT.md](docs/V1-PRODUCTION-READINESS-REPORT.md) | Current status, verdict, remaining launch items |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production architecture (VPS + Docker + Caddy), backups, monitoring |
| [docs/RELEASE.md](docs/RELEASE.md) | Release build, deployment checklist, migrations, rollback, administrator guide |
| [docs/V1-SECURITY-AUDIT.md](docs/V1-SECURITY-AUDIT.md) | Security audit and honest-integrations decisions |
| [docs/V1-VALIDATION-REPORT.md](docs/V1-VALIDATION-REPORT.md) | Multi-terminal pilot, load test, manual device checklist |

Validation scripts (run against a disposable server): `backend/scripts/validation/{pilot,load,smoke}.js`.

## Testing

**Continuous Integration:** every push and PR to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml), which:
- installs the backend, applies migrations to a fresh Postgres service container (proving every committed migration applies cleanly from scratch), then runs `npm test` against that same database;
- installs the frontend, runs lint, `npm test`, and a production build.

**Backend:**
```bash
cd backend
npm test
```
The backend suite (50 files, ~980 tests) is a full integration suite against a real database: business logic, RBAC for every module, tenant/branch isolation, accounting, concurrency and offline-sync endpoints. It registers its own throwaway tenants.

**Database isolation is enforced.** `tests/globalSetup.js` refuses to run unless `DATABASE_URL` points at a local host (`localhost`, `127.0.0.1`, `::1`, `postgres`), so a hosted/production URL in `.env` can never be hit by the tests. It also runs the idempotent permission seed before the suite, so a fresh test database works with no extra step.

```bash
# one-time: a disposable local database
createdb akvisionflow_test
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/akvisionflow_test?schema=public"
export DIRECT_URL="$DATABASE_URL"   # Prisma migrations use this direct connection
export JWT_SECRET=test-secret
npm run db:setup   # prisma migrate deploy + permission seed (same command production uses)
npm test
```

CI (`.github/workflows/ci.yml`) does the same on a fresh Postgres: migrate, seed, schema-drift check, backend tests; then frontend lint, tests and build.

**Frontend:**
```bash
cd frontend
npm test
```
- `src/offline/syncEngine.test.js` covers the generic outbox (`createOutbox()`) against a real in-memory IndexedDB (via `fake-indexeddb`), with only the network (`apiClient`) mocked: idempotency-key stability across retries, conflict (409) vs. failure (4xx) handling, a conflict never blocking the rest of the queue, network errors halting the drain without touching later items, optimistic stock effects for Sales/Purchases, and `syncAll()` draining every entity independently.
- Component tests (React Testing Library) cover `StatusBadge`, `Pagination`, `Modal`, `ProtectedRoute`'s auth/role redirect logic, and the `Login` page's submit flow (success navigates, failure shows the server's error message).

> Note: Vitest's default `forks` worker pool hangs in some sandboxed/restricted dev environments (process spawning disabled) — if you hit that (tests hang with "no tests" and a worker-timeout error), run `VITEST_SANDBOXED_ENV=1 npm test` instead; `vitest.config.js` switches to the `threads` pool when that variable is set. Leave it unset on a normal machine or in CI — `threads` fails there with a jsdom/Node worker_threads incompatibility (`webidl.util.markAsUncloneable is not a function`) that `forks` doesn't hit.

**Manual regression checklist** — run through this against a real (throwaway) Postgres database before a production release:

- [ ] Tenant registration + login
- [ ] A user from Tenant A cannot see Tenant B's data (tenant isolation)
- [ ] Role permission boundaries (e.g. a Cashier cannot access Users)
- [ ] Product create with opening stock creates an `OPENING_STOCK` inventory transaction
- [ ] Purchase → receive stock increases product stock atomically
- [ ] Sale → stock deduction is atomic and blocks over-selling (unless the `allowNegativeStock` tenant setting is explicitly enabled)
- [ ] Sale reversal restores stock and preserves the original sale record
- [ ] Reports return correct totals against known seed data
- [ ] `prisma migrate deploy` runs cleanly against a fresh database

---

## API overview

All endpoints are under `/api` and (except `/api/health`, `/api/auth/login`, `/api/auth/register-tenant`) require `Authorization: Bearer <JWT>`.

| Module | Base path |
|---|---|
| Auth | `/api/auth` (register-tenant, login, me) |
| Users | `/api/users` (Tenant Admin only) |
| Branches | `/api/branches` |
| Categories | `/api/categories` |
| Products | `/api/products` (+ `/:id/adjust-stock`) |
| Customers | `/api/customers` (+ `/:id/history`) |
| Suppliers | `/api/suppliers` (+ `/:id/ledger`) |
| Purchases | `/api/purchases` (+ `/:id/receive`, `/:id/pay`) |
| Sales / POS | `/api/sales` (+ `/:id/reverse`) |
| Inventory | `/api/inventory/transactions` |
| Optical Orders | `/api/optical-orders` (+ `/:id/pay`) |
| Expense Categories | `/api/expense-categories` |
| Expenses | `/api/expenses` |
| Payments | `/api/payments` (read-only ledger view) |
| Dashboard | `/api/dashboard` |
| Reports | `/api/reports/{sales/daily, sales/monthly, inventory, stock-movement, expenses, profit-loss, optical-orders, medicine-expiry}` |
| Settings | `/api/settings` |

All list endpoints support `page`, `pageSize`, and (where relevant) `search` query params and return `{ items, total, page, pageSize }`.

### Owner Mobile (Android app) API

**Phase 4.3 - management operations use the EXISTING endpoints through an allow-list.** A mobile token (TENANT_ADMIN/MANAGER only) is accepted by `authenticate` only for the exact method+path pairs in `backend/src/middleware/mobileGateway.js`: GET list/detail of customers (+history), suppliers (+ledger), products, warehouses (+stock), sales, purchases, purchase requests, purchase orders and stock transfers, and POST approve/reject on the last three. Everything behind that door - permissions, branch/warehouse scope, atomic status guards, audit - is the unchanged web implementation; any other path or method with a mobile token is 401. Adding a line to the allow-list is a security decision. Approve/reject on stock transfers now also requires access to one of the transfer's warehouses (as viewing and cancelling already did).

**Phase 4.2 additions** (all GET, all need `REPORT:VIEW`): `/dashboard/purchases` (received purchases, comparison, top suppliers, payables aging), `/dashboard/cash` (cash & bank from the ledger - the same report function as the web Cash/Bank report), `companyId` on every dashboard endpoint (narrows to that company's branches, never wider than the user's own access), `purchases`/`payables`/`cash` blocks on `/dashboard/summary`, `companies` on `/dashboard/filters`, and `important=true` on `/alerts` (critical + important). Stock figures are for the whole business and say so (`inventory.scope: ALL_BRANCHES`). Accuracy fixes: reversed expenses, reversed payments and never-received purchases are no longer counted in the dashboard/AI figures.

A separate, versioned, **read-only** surface for the AK VisionFlow Owner Android app (see `android/`), deliberately isolated from the web API above:

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/mobile/v1/health` | none | connectivity check, mirrors `/api/health` |
| `POST /api/mobile/v1/auth/login` | none (rate-limited) | email/password login; only succeeds for a tenant's `TENANT_ADMIN` (the owner) |
| `POST /api/mobile/v1/auth/logout` | mobile token | audit-only; JWTs are stateless, the client discards the token |
| `GET /api/mobile/v1/profile` | mobile token | owner + tenant + branch summary |

Mobile tokens carry a `typ: 'mobile'` JWT claim (same pattern as the Customer Portal's `typ: 'portal'`) and are only ever accepted by `authenticateMobile` (`backend/src/middleware/mobileAuth.js`) — a mobile token can never call a staff web route, and a staff web token can never call a mobile route (`authenticate` rejects any token carrying a `typ` claim). `mobileReadOnlyGuard` rejects any non-`GET` request under `/api/mobile` at the API level, so the read-only rule holds even if the app's UI were bypassed. See `backend/tests/mobile.test.js` for the full RBAC/tenant-isolation/read-only test suite.

---

## Deployment checklist

1. Provision PostgreSQL and set `DATABASE_URL` and `DIRECT_URL`. On a pooled host (e.g. Neon `-pooler`), `DATABASE_URL` is the pooled string and `DIRECT_URL` is the same string with `-pooler` removed from the host: migrations take an advisory lock that a PgBouncer pooler cannot hold reliably (Prisma P1002). On a plain Postgres both are identical.
2. Set a strong `JWT_SECRET` and correct `CORS_ORIGINS` in the backend `.env`.
3. `npm run db:setup` (migrate deploy + idempotent permission seed; never `migrate dev`/`reset` in production). Without the seed every route answers 403. The Docker image runs this automatically on start.
4. Build and run the backend (`npm run build` step is not required for the Express API; `npm start` runs it directly, or use `backend/Dockerfile`).
5. Build the frontend (`npm run build` in `frontend/`, or `frontend/Dockerfile` which serves the built SPA via nginx) with `VITE_API_URL` pointed at the deployed API's public URL.
6. Serve both over HTTPS (terminate TLS at your load balancer/reverse proxy — this is not done inside the containers).
7. Take a database backup, then smoke-test: register a tenant, log in, create a product, complete a POS sale, view the dashboard.

`docker-compose.yml` at the repo root brings up Postgres + backend + frontend together for a single-VPS deployment; for a managed PaaS, deploy `backend/` and `frontend/` as separate services pointing at a managed Postgres instance.

---

## Security notes

A manual security review was completed and the following are already fixed in this codebase:
- JWT verification is pinned to the `HS256` algorithm (defense-in-depth).
- No unused dependencies with known vulnerabilities (`npm audit` reports 0 vulnerabilities in both `backend/` and `frontend/`).
- Every protected route enforces tenant isolation and role checks server-side; a cross-tenant direct-ID lookup returns `404`, not `403`, so it doesn't even leak that a record exists.

**Before deploying to production, you must:**
- Set a real, random `JWT_SECRET` — `docker-compose.yml` and `backend/.env.example` both ship with a placeholder fallback that is public (it's in this repo) and must never be used as-is.
- Set a real `POSTGRES_PASSWORD` if using `docker-compose.yml` — it defaults to `postgres` for local dev convenience.
- Terminate HTTPS in front of the app (see [Deployment checklist](#deployment-checklist)).

---

## Roadmap

- ✅ **Phase 1 — Core Commercial MVP:** complete and hardened.
- ✅ **Phase 2 — Offline creation & sync:** complete and hardened, covering all six offline-capable modules.
- ⏳ **Phase 3 — SaaS Control Plane:** not started. Planned scope: Super Admin / Master Portal, subscription & billing, advanced/custom roles, full multi-branch expansion, advanced analytics, in-app/push notifications, a support ticket system, feature flags, platform monitoring, and integration hooks (WhatsApp/SMS/email, AI prescription reader, OCT, EMR boundary). Phases 1 and 2 — including all offline queues and synced data — must remain fully functional through the Phase 3 upgrade.
