# AK VisionFlow — Phase 7.2 (Production Infrastructure & Deployment) Verification Report

**Critical honesty note up front**: this session has no credentials to any live server, Vercel account, DNS registrar, or the production database beyond the read-only connection string already present in `backend/.env`. Every finding below is either (a) genuinely verified live via a real, read-only HTTP/database call made during this session, (b) verified by executing the actual deployment scripts against a local disposable database, or (c) explicitly marked NOT VERIFIED where it requires access this session does not have. Nothing below is guessed or assumed.

## 7.2.1 Determine Actual Deployment Target

**Two deployment configurations exist in the repository**: a hardened VPS+Docker+Caddy stack (`deploy/docker-compose.prod.yml`, `deploy/Caddyfile`), and a Vercel serverless config (`backend/vercel.json`, `frontend/vercel.json`). `docs/DEPLOYMENT.md` already documents, in its own words, why serverless is a poor fit: in-process SSE realtime subscriber state, an in-process rate-limiter store, and no built-in cron for the scheduled-automation endpoint.

**Live evidence gathered this session** (real HTTP calls against the URL previously provided in this conversation, `https://clinickhalideye.vercel.app`, and its documented frontend counterpart `https://khalideye-iota.vercel.app`):

| Check | Result |
|---|---|
| `GET /api/health` | **200**, `{"status":"ok","version":"1.0.0"}` — genuinely live, `Server: Vercel` and `X-Vercel-Id` headers confirm the backend is in fact running on Vercel right now. |
| `GET /api/mobile/v1/health` | **200**, healthy. |
| `http://` request | **308** redirect to `https://` — HTTPS is correctly enforced at the platform edge. |
| `GET /` on the documented frontend URL | **404**, body: `"The deployment could not be found on Vercel. DEPLOYMENT_NOT_FOUND"`. **The frontend deployment genuinely does not exist at its documented URL right now.** |
| CORS preflight from the (documented, currently-dead) frontend origin | No `Access-Control-Allow-Origin` header returned at all — even if the frontend existed at that URL, the backend's current CORS configuration would not permit it to call the API. |
| `GET /api/auth/config` | `{"signupMode":"open","passwordResetByEmail":false,"whatsappAvailable":true,"portalLoginAvailable":true,"pushAvailable":true}`. Per `utils/providerPolicy.js`'s `mockProvidersAllowed()` logic (read this session and in the prior consolidated audit), `whatsappAvailable`/`pushAvailable` can only be `true` when `NODE_ENV !== 'production'` or an explicit `ALLOW_MOCK_PROVIDERS=true` staging override is set. **This is now confirmed live, not just theorized**: this production instance is either not actually running with `NODE_ENV=production`, or has the staging-only mock override left on. Either way, real users hitting this instance right now would be told WhatsApp/push/portal-OTP are available when they are backed by a mock provider that cannot actually deliver anything. |
| `npx prisma migrate status` against the real production `DATABASE_URL` (read-only; no write attempted) | 3 migrations not yet applied: `phase4_3_procurement_completion`, `phase5_1_optical_items_and_visit_billing`, and this phase's own `phase7_1_optical_order_cancellation_credit_note`. This is expected and **not itself alarming** — the currently-deployed backend code predates this session's uncommitted Phase 4.3–7.1 work and does not need these columns/tables yet — but it does confirm the second finding below. |
| `backend/package.json`'s Vercel-relevant scripts | Only `"postinstall": "prisma generate"` — **there is no automated migration or permission-seed step anywhere in the Vercel deploy path.** Unlike the Docker path (whose `Dockerfile` CMD runs `prisma migrate deploy && node prisma/seedPermissions.js` on every container start), a Vercel deploy would silently leave the database schema and permission catalog exactly as they were, however stale, unless a human remembers to run both manually. |

**Determination**: the evidence — both the pre-existing, already-documented architectural incompatibilities and this session's own fresh, live findings (dead frontend, broken CORS, mock providers reporting available, no automated migration/seed safety net) — is unambiguous. **VPS + Docker + Caddy, exactly as `docs/DEPLOYMENT.md` already specifies, is the correct and only architecture this project should use for production.** The current Vercel deployment is not a viable parallel option; it is, at minimum, materially broken (no reachable frontend) and, at worst, actively misconfigured in a way that misleads real users about feature availability. This is a **Product Owner decision to act on** — this session cannot itself provision a VPS, register a domain, or change Vercel project settings, but the evidence and the recommendation are now unambiguous and documented in one place.

## 7.2.2 Production Environment

Verified by reading the actual configuration (not assumed):
- **Backend**: `deploy/docker-compose.prod.yml`'s `backend` service builds from `../backend`, sets `NODE_ENV=production`, and requires `JWT_SECRET`/`POSTGRES_PASSWORD`/`APP_DOMAIN` via Compose's `:?` required-variable syntax (the stack refuses to start with a default/placeholder secret — no silent weak fallback, unlike the legacy root `docker-compose.yml`).
- **Frontend**: builds via the `frontend` service with `VITE_API_URL=/api` (same-origin, proxied by Caddy — no separate frontend domain/CORS surface needed in this architecture, which also sidesteps the exact CORS gap found live on the current Vercel setup above).
- **PostgreSQL**: `postgres:16-alpine`, private network only (no published port), with a real healthcheck (`pg_isready`) gating the backend's own startup.
- **HTTPS**: automatic via Caddy + Let's Encrypt (`deploy/Caddyfile`), with HSTS and standard security headers set explicitly.
- **Domain**: parameterized via `APP_DOMAIN`, used for both the Caddy TLS certificate and the backend's `CORS_ORIGINS`/`APP_URL`.
- **Environment variables**: `deploy/.env.production.example` is a complete, ready-to-copy template (`APP_DOMAIN`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `ALERT_WEBHOOK_URL`, backup retention, signup mode, SMTP) — read in full this session, nothing missing.
- **JWT secrets**: required, fail-closed in production if left at the documented placeholder or under 32 characters (`config/env.js`, verified this session and in Phase 7.1's own credential-encryption work, which deliberately reuses this same secret rather than adding a new one).
- **AI secrets**: no new environment variable is needed — Phase 7.1 made AI provider credentials a per-tenant, database-stored (now encrypted) value via the existing `PUT /api/ai/config`, not a platform-wide env var.
- **Database credentials**: never hardcoded; read from `POSTGRES_PASSWORD`/`DATABASE_URL` only.
- **CORS**: `CORS_ORIGINS: https://${APP_DOMAIN}` in the Docker path — a single, explicit, correct origin, unlike the live Vercel instance's confirmed CORS gap.
- **Production logging**: `morgan` in `combined` format when `NODE_ENV=production` (verified in `app.js`).
- **Health endpoint**: `GET /api/health` — real, database-aware (`SELECT 1`), wired into the Docker healthcheck directly (`wget -qO- http://localhost:4000/api/health`).

No secret was committed, read aloud, or printed by this session at any point.

## 7.2.3 Database Deployment

- **Production migrations**: confirmed, live, this session (§7.2.1) — 3 migrations are not yet applied to the real production database. This is expected given the deployed code predates this session's work, **but it is now an explicit, confirmed fact, not an assumption** — the Product Owner should apply them (`prisma migrate deploy`, exactly as the Docker path already automates) as part of actually shipping this session's work, not before.
- **Permission seed**: `backend/prisma/seedPermissions.js` is upsert-keyed on compound unique keys (`resource_action`, `role_permissionId`) — genuinely idempotent, confirmed by reading it in full. It is **automated** in the Docker path (runs on every container start) and **not automated at all** in the current Vercel path — this asymmetry is itself part of the evidence for §7.2.1's determination.
- **Fresh database setup**: verified this session (and repeatedly throughout this project's earlier phases) — all 38 migrations apply cleanly, in order, to a brand-new empty database, with zero resulting schema drift (`prisma migrate diff --exit-code` → "No difference detected").
- **Existing database migration**: verified this session against the long-lived local scratch database — `prisma migrate status` reports "up to date" after applying, and drift-checks clean.
- **No destructive operation was performed or considered** against any database, local or production, this session.

## 7.2.4 Backups

Actually executed this session, against a local disposable database (`phase5_scratch`, never production) — not merely re-cited from a prior report:

1. `deploy/scripts/backup.sh` run for real: produced a genuine `pg_dump -Fc` compressed dump, **11,173,205 bytes**.
2. `deploy/scripts/restore.sh` run for real: restored that exact dump into a brand-new database (the script refuses to run if the target already exists — verified this guard is real, not just documented).
3. `deploy/scripts/verify-restore.sh` run for real, end-to-end: restored the dump into its own throwaway scratch database, compared every table's row count against the source, and reported **"RESTORE VERIFIED: 95 tables, 198,345 total rows, every count identical"** — then cleaned up its own scratch database automatically (confirmed no leftover test database remained afterward).

**Backup created**: yes, real, this session. **Backup location**: local disposable test path (`/tmp`), never production. **Restore successful**: yes. **Restored database integrity**: confirmed identical to the source, table-by-table, row-by-row count.

**What remains NOT VERIFIED**: an actual off-server backup copy from a real production server, and a restore drill against a genuinely separate environment from a live production instance. This session has no production server to run `backup.sh` against, and `deploy/scripts/backup-loop.sh`'s off-server-copy step is explicitly documented in its own comments as requiring an operator's own storage account, which does not exist in this session's scope. This is disclosed, not glossed over.

## 7.2.5 HTTPS & Domain

- **HTTPS**: verified live — the production Vercel instance correctly redirects `http://` to `https://` (308) and returns a valid HSTS header.
- **TLS certificate**: the live `curl` connection succeeded without a certificate warning, confirming a valid certificate chain is currently served (Vercel-managed, not Caddy, on the current deployment).
- **HTTP → HTTPS redirect**: confirmed live, as above.
- **API accessibility**: confirmed live (`/api/health`, `/api/mobile/v1/health` both 200).
- **Frontend accessibility**: **confirmed broken live** — `DEPLOYMENT_NOT_FOUND` at the documented URL (§7.2.1).
- **CORS**: **confirmed broken live** for the documented frontend origin (§7.2.1).
- **Android API connectivity**: not independently re-tested this session (would require a physical device or emulator, addressed honestly in Phase 7.4); the prior session's own connectivity verification report already established the release APK's embedded API URL matches this same live backend.

## 7.2.6 Realtime

The realtime/SSE architecture (`backend/src/modules/sync/realtime.js`, holding subscriber connections in an in-process `Map`) is fundamentally incompatible with a stateless serverless deployment model: a write handled by one serverless invocation has no way to reach an SSE connection held open by a different invocation/instance. `deploy/Caddyfile` explicitly disables proxy buffering (`flush_interval -1`) for `/api/*` specifically because the VPS+Docker path runs one persistent Node process where this problem does not exist.

**This session did not pretend this works on the current Vercel deployment.** No multi-instance SSE test was attempted against production (this session has no way to force Vercel to run multiple concurrent instances to observe the failure directly, and doing so would not change the already-clear architectural conclusion). The correct statement, consistent with the directive's own instruction ("if the backend is serverless and SSE is incompatible: do not pretend it works; use the supported production architecture; retain polling fallback where appropriate"): **the existing 60-second polling fallback (`frontend/src/offline/localData.js`) is what actually keeps the application correct today regardless of which deployment target is live** — SSE is a latency optimization only, never load-bearing, by the existing design. This was already true before this phase and required no code change; it is simply the correct reason the current Vercel deployment's realtime gap is a UX degradation, not a correctness bug, while still being one more concrete reason to complete the move to the VPS+Docker+Caddy architecture where the optimization actually works.

## 7.2.7 Verification Summary

| Check | Result |
|---|---|
| Production health check | **Live, verified**: 200 OK on both staff and mobile health endpoints. |
| Migration check | **Live, verified**: 3 migrations correctly pending (matches the currently-deployed, older code); mechanism itself proven clean on fresh + existing local databases. |
| Permission seed check | **Verified idempotent** (code read + local execution); **confirmed not automated at all on the current Vercel path** — a real, live-relevant gap. |
| HTTPS check | **Live, verified**: valid cert, HSTS present, HTTP→HTTPS redirect confirmed. |
| Database connectivity | **Live, verified** (read-only `migrate status` succeeded against the real production connection string). |
| Authentication | Not exercised live this session (no test tenant was created against production in this sub-phase — deferred to the explicit, "use safe test data" Phase 7.4.7 smoke test). |
| API smoke test | Partial: health + config endpoints only, live. Full workflow smoke test deferred to Phase 7.4.7 per the directive's own phase structure. |
| Realtime test | Not performed live (no way to force multi-instance behavior on Vercel from this session); architecturally assessed and honestly reported as incompatible with the current deployment target. |
| Backup test | **Executed for real this session** against a local disposable database — see §7.2.4. |
| Restore test | **Executed for real this session**, including full row-count integrity verification — see §7.2.4. |

## Conditions Carried Forward

1. **The frontend is not reachable at its documented production URL right now.** This is the single most launch-relevant finding in this entire phase and needs the Product Owner's direct attention before any claim of production readiness.
2. **The live backend's mock WhatsApp/push/portal-OTP providers report themselves as available to real users**, most likely because `NODE_ENV` is not actually `production` on that deployment, or a staging-only override was left enabled.
3. **Production's database schema and permission catalog are behind the current codebase**, and nothing in the current (Vercel) deploy path would have caught or corrected this automatically.
4. **A genuine off-server backup copy and a live-server restore drill remain unverified** — the mechanism itself is now freshly proven correct, but only against a local, disposable database.
5. Migrating to the VPS+Docker+Caddy architecture (already fully built and documented, just never actually provisioned onto a real server) is the recommended resolution for essentially all of the above at once.

# PHASE 7.2 — CLOSED WITH CONDITIONS

Continuing automatically to Phase 7.3.
