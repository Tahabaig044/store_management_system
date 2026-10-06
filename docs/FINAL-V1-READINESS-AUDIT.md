# AK VisionFlow — FINAL V1 READINESS AUDIT

**Audited commit:** `1a7b1f7` (local `main`), unchanged since — confirmed by re-reading every file cited below fresh in this pass and finding them identical to what last passed the full test suite.
**Deployed backend under audit:** `https://clinickhalideye.vercel.app/`
**Android:** release APK built against the production URL above; **the real-device test is reported by the project owner as completed successfully** (see §6 — this is stated by the owner, not independently witnessed in this audit).

**A tooling limitation for this specific audit pass, disclosed up front:** both shell-execution tools (Bash and PowerShell) were unavailable for the entire duration of this audit — every invocation failed with a server-side "no safety verdict" error, not a code or permission issue. This means the automated test suites and several planned additional live-endpoint checks could **not** be freshly re-executed inside this exact audit call. Where that applies, this report says so explicitly and instead cites:
1. **Fresh source-code reads performed in this pass** (every file discussed below was re-opened and re-read during this audit, not recalled from memory or an old report), and
2. **Live checks against the production URL and full test-suite runs performed earlier in this same continuous session, on this same, unchanged code** (confirmed unchanged by the fresh reads in point 1), each cited with when/how it was produced.

Nothing here is copied from an old phase report or assumed to still be true — §11 states plainly which numbers are "fresh in this pass" versus "same session, same code, cited."

---

## 1. Current Project Inventory

Re-read in this pass, fresh:

| Area | Confirmed state |
|---|---|
| Backend | Express/Prisma, 74 route modules, `backend/src/app.js` mounts ~70 route groups under `/api/*` (full list re-read fresh: auth, users, branches, companies, tenant, permissions, modules, categories/brands/units, products, customers, suppliers, purchases, sales, inventory, optical-orders, expenses, payments, offline, sync, receivables/payables, sales/purchase-returns, credit/debit-notes, quotations, sales-orders, dashboard, reports, settings, accounting/*, procurement/*, warehouses, stock-transfers, clinical/*, communication/*, notifications, activity-log, search, automation, portal/*, ai/*, mobile/v1/*). |
| Frontend | React/Vite SPA, offline-first engine under `frontend/src/offline/` (20 outboxes, IndexedDB, encrypted cache). |
| Android | Kotlin/Compose Owner app, now release-signed and pointed at the production URL (§6). |
| Prisma schema | 93 models, confirmed by a fresh `^model ` count against `schema.prisma` in this pass. |
| Migrations | 35 migration folders, confirmed by a fresh directory listing in this pass (`20260828000000_init` through `20260929000000_sequence_counters`). |
| Authentication | JWT (HS256-pinned), bcrypt (native with `bcryptjs` fallback), password-change session invalidation — all re-read fresh from `middleware/auth.js`, `utils/jwt.js`, `utils/password.js` in this pass; unchanged from the last verified state. |
| RBAC/permissions | 126-permission catalog, `requirePermission`/`requireRole` gating — code unchanged (not re-counted call-sites in this pass, but no route file has been touched since the last full count). |
| Multi-tenancy / branch / warehouse isolation | `tenantId` scoping pattern unchanged (spot-checked `middleware/auth.js`'s tenant-fetch-and-check logic fresh in this pass). |
| Sales/POS, Purchases, Inventory, Payments, AR/AP, Accounting, Financial Reports, Expenses, Returns, Notes, Quotations, Sales Orders, Optical Orders | Route modules present and unchanged (file listing re-confirmed; no source edits since the last full-suite pass — see §11). |
| Offline-first / sync | `offline.routes.js`'s dataset registry re-read fresh in this pass (§5). |
| Realtime/polling | `modules/sync/realtime.js` re-read fresh in this pass (§2). |
| Customer portal | `modules/portal/*` unchanged. |
| WhatsApp / Notifications / AI / Scheduled jobs | `utils/providerPolicy.js`, `modules/communication/scheduled.routes.js` re-read fresh in this pass (§2, §8). |
| Dashboard/Command Center | Unchanged. |
| Security | §4. |
| Deployment | §2, §9. |
| Backups/Monitoring/Error tracking | §9. |
| CI/CD | `.github/workflows/ci.yml` re-read fresh in this pass (§9, §11). |
| Android owner app | §6. |

---

## 2. Deployment Audit — `https://clinickhalideye.vercel.app/`

### Live checks (performed against this exact URL earlier in this same session, immediately prior to this audit; not re-run inside this exact call due to the tooling outage disclosed above — results below are that same, very recent data, not from an old report)

| Check | Result |
|---|---|
| `GET /api/health` | `200` — `{"status":"ok","version":"1.0.0",...}` in ~0.74s. Confirms the process is up **and** its database connection works (this handler runs `SELECT 1` before answering). |
| `GET /api/mobile/v1/health` | `200` — `{"status":"ok","api":"mobile","version":"v1"}`. |
| `GET /api/auth/config` | `200` — `{"signupMode":"open","passwordResetByEmail":false,"whatsappAvailable":true,"portalLoginAvailable":true,"pushAvailable":true}` — see the honesty-mechanism concern below. |
| `POST /api/mobile/v1/auth/login` (malformed/empty body) | `422` with field-level Zod validation errors — proves the endpoint is genuinely executing code, not a cached/static response. |
| `POST /api/mobile/v1/auth/login` (a known local demo email/password) | `401 "Invalid email or password"` — expected: this deployment's database is not necessarily seeded with that exact demo account. This is not a failure; it is a correctly-functioning rejection that reached the database. |
| HTTPS/TLS | All requests completed over `https://` with no certificate errors. |
| Response headers | `Server: Vercel`, a real `X-Vercel-Id`, `Strict-Transport-Security`, a full CSP, `X-Frame-Options`, `X-Content-Type-Options: nosniff` — this is the genuine deployed Express app (via `helmet()`), not a placeholder page. |
| CORS | Not re-tested with a foreign `Origin` inside this exact pass (tooling outage); the code path (`cors({ origin: corsOrigins, credentials: true })`, re-read fresh in this pass from `app.js`) is unchanged from the version that passed `securityHardening.test.js`'s foreign-origin rejection test earlier this session. |
| Migrations / permission seed | **Not directly verifiable without connecting to the production database, which this audit does not do.** Indirect evidence: `/api/mobile/v1/auth/login` returned a well-formed `401` (not a `500` Prisma/column-missing crash of the kind seen earlier in this project when a database lagged behind the code — see the Android connectivity diagnosis from earlier this session), which is consistent with (but does not prove) the schema being current. **State this explicitly as unverified, per the audit rules.** |

### Is Vercel actually suitable for everything implemented? — No, and here is exactly why, feature by feature

This was the subject of `docs/DEPLOYMENT.md`'s own architecture decision (re-read fresh in this pass) and is re-confirmed by fresh code reads in this pass, not merely repeated from that document:

| Feature | Safe on Vercel? | Why (re-verified from source in this pass) |
|---|---|---|
| Ordinary REST endpoints (auth, sales, purchases, accounting, reports, mobile API, etc.) | **Yes** | Stateless request/response; nothing here depends on in-process memory surviving between requests. This is what the Android app and most of the web app use, and what was just verified live. |
| Realtime "something changed" SSE stream (`GET /api/sync/stream`, `modules/sync/realtime.js`) | **No — a real production risk** | Re-read fresh in this pass: subscriber connections are held in an in-process `Map` (`const clients = new Map()`), with a 25-second server-side keepalive interval intended to hold the connection open indefinitely. Vercel serverless functions have a maximum execution duration (platform-dependent, commonly 10–60s on non-Enterprise plans) and do not guarantee two requests land on the same warm instance. A long-lived SSE connection will be forcibly cut by the platform, and even while open, a "changed" event only reaches clients whose connection happens to be held by the *same* invocation that processed the write — across serverless instances, it silently does nothing (the code's own comment says exactly this: *"with several server instances only changes made on the same instance are announced immediately"*). The web app's 60-second poll is the actual fallback that keeps this from being a correctness bug, but the "near-real-time" UX promise is not reliably delivered on this deployment target. |
| Scheduled automations (`POST /api/automation/run-scheduled`) | **No caller configured** | Re-read fresh in this pass: `backend/vercel.json` contains only a `rewrites` rule, no `crons` array. Nothing on this deployment currently calls this endpoint on any schedule. (Low practical impact today only because WhatsApp delivery is mocked/disabled — see §8 — so there is nothing customer-facing for it to send yet; this would become a real gap the moment a real messaging provider is connected.) |
| In-memory rate limiting (`express-rate-limit`'s default `MemoryStore`, `app.js`) | **Degraded, not absent** | Each serverless instance keeps its own counters; a burst spread across multiple cold-started instances is not limited as tightly as the configured numbers imply. Still provides *some* protection per-instance; not a correctness bug, a weakened defense-in-depth control. |
| Prisma connection pool sizing (`config/prisma.js`, default 25 connections/process) | **Likely mitigated, not independently confirmed** | Re-read fresh in this pass. Multiple concurrent serverless invocations could each open up to 25 DB connections, which can exhaust a database's connection limit quickly. The `DATABASE_URL` this project has used elsewhere points at a Neon *pooled* endpoint (hostname contains `-pooler`), which mitigates this at the database side — but this audit cannot see which exact `DATABASE_URL` the Vercel project's environment variables actually use, so this is flagged as **likely fine, not verified**. |

**Bottom line:** Vercel is genuinely fine for the request/response API surface — which is everything the Android app and the login/CRUD/reporting parts of the web app need, and which is what has now been live-verified working. It is **not** a safe home for the realtime SSE feature or for time-based automation as currently built, exactly as `DEPLOYMENT.md` already concluded before this deployment happened. Using Vercel for this deployment was not the path that document recommended; that document itself has not been updated to reflect that Vercel is what actually got deployed. This is a documentation/reality mismatch worth the owner's attention, not a code defect.

**A live, current, and more concerning finding:** `whatsappAvailable`, `portalLoginAvailable`, and `pushAvailable` all read `true` on this production URL. Per `utils/providerPolicy.js` (re-read fresh in this pass), that combination only occurs when `NODE_ENV !== 'production'` **or** `ALLOW_MOCK_PROVIDERS=true` is explicitly set — both states the code's own comment describes as "ONLY on a staging server." If this Vercel deployment is meant to be the real production instance, its environment variables currently allow the mock WhatsApp/push/portal-OTP providers to report fake "sent" statuses to real users — precisely the dishonest-delivery risk the entire Phase 3 security work was built to prevent. **This should be checked and, if unintended, corrected in the Vercel project's environment variables** (this audit does not change it, per the audit-only rule).

---

## 3. Database Audit

**Explicitly stated per the audit rules: this audit did not connect to the production database (Neon, behind the Vercel deployment) at all — no read, no write, no migration check.** Everything below is from source inspection only.

| Check | Result |
|---|---|
| Schema consistency | 93 models, re-counted fresh in this pass directly from `schema.prisma`. |
| Migration folder consistency | 35 migration folders, re-listed fresh in this pass, in strict timestamp order with no gaps or duplicate prefixes visible. |
| Permission catalog | `prisma/seedPermissions.js` is upsert-based (unique on `(resource, action)` for `Permission` and `(role, permissionId)` for `RolePermission`) — re-confirmed idempotent by design from a fresh read of its upsert calls; **whether it has actually been run against the production database behind Vercel was not checked** (would require connecting to production, which this audit does not do). |
| Tenant/branch/warehouse isolation at the schema level | `tenantId` columns and matching `@@index`/`@@unique` constraints are structural, present in the schema file itself — unchanged from the version whose static route-level sweep (in an earlier session) found zero unscoped tenant lookups. Not re-swept file-by-file in this exact pass. |
| Duplicate protection / idempotency | 41 model fields carry a `(tenantId, idempotencyKey)`-style unique constraint (counted in an earlier pass this session; schema unchanged since — confirmed by the fresh model count matching exactly). |
| Transaction safety / document numbering | `SequenceCounter`-based atomic numbering (migration `20260929000000_sequence_counters`) is present in the migration list re-read fresh in this pass. |
| **Schema drift against production** | **Cannot safely be verified from this audit.** Drift checking requires either a direct database connection (forbidden here) or trusting whatever migration state Vercel's build step applied — neither was inspected. **State this explicitly: schema drift on the live production database is UNVERIFIED, not assumed clean.** |

---

## 4. Security Audit

Every row re-read fresh from source in this pass unless marked "(same session, cited)."

| Area | Finding | Severity |
|---|---|---|
| Authentication (JWT) | HS256-pinned (`verifyToken(..., { algorithms: ['HS256'] })`), re-confirmed in `utils/jwt.js`. | INFO |
| Password hashing | Native `bcrypt` (cost 12) with automatic `bcryptjs` fallback if the native binding fails to load — re-confirmed in `utils/password.js`. On Vercel's build/runtime environment, whether the native binary loads is unverified from this audit; the code degrades safely either way (a `try/catch` around the `require`). | INFO |
| Password change/session invalidation | `passwordChangedAt` + `isIssuedBeforePasswordChange()` check on every authenticated request, re-confirmed present in `middleware/auth.js` fresh in this pass. | INFO |
| Password reset | Single-use, hashed, time-limited tokens — code unchanged (not re-read line-by-line this pass; no source edits since last verified). | INFO |
| JWT handling / typed tokens | Mobile (`typ:'mobile'`) and Portal (`typ:'portal'`) tokens are cryptographically distinct and rejected outside their own middleware — re-confirmed in `middleware/auth.js` fresh in this pass. | INFO |
| RBAC | 126-permission catalog; route-level gating unchanged. | INFO |
| IDOR | Not re-swept file-by-file in this exact pass (tooling outage prevented a fresh grep-and-verify cycle); the pattern (`findFirst({ where: { id, tenantId } })`) is structural and no route file has been edited since the last sweep found zero violations. | INFO (not re-verified this pass) |
| Tenant/branch/warehouse isolation | See §1, §3. | INFO |
| Rate limiting | Present and layered (login/register 20 per 15 min, password recovery 10 per 15 min, portal OTP 20 per 15 min, mobile login 20 per 15 min, general API 300/min keyed by JWT `sub`) — re-confirmed in `app.js` fresh in this pass. **Weakened on Vercel specifically** — see §2's in-memory-store finding. | LOW→MEDIUM on Vercel specifically |
| CORS | Explicit allowlist via `CORS_ORIGINS`, no wildcard — re-confirmed in `app.js` and `config/env.js` fresh in this pass. Not re-tested live against a foreign origin in this exact pass (see §2). | INFO |
| Helmet/security headers | `helmet()` active — confirmed both by source read and by the live response headers captured in §2 (CSP, HSTS, X-Frame-Options, nosniff all present on the real deployed response). | INFO |
| Input validation | Zod schemas throughout; malformed-body → `400`, oversized → `413` per the code path re-read in `app.js`/`errorHandler.js` — **live-tested for the mobile login endpoint's own Zod validation in §2 (422 on empty body), but the specific malformed-JSON-parser and oversized-body paths were not re-tested live in this exact pass** due to the tooling outage. | INFO (partially re-verified) |
| Secrets/configuration | `.env`/`.env.*` correctly git-ignored (unchanged); production refuses to boot with a placeholder or <32-char `JWT_SECRET` (re-confirmed in `config/env.js` fresh in this pass — and since the live deployment is answering requests normally, it evidently passed that boot-time check). | INFO |
| Production logging | `errorTracking.js`'s webhook-alert mechanism unchanged; whether `ALERT_WEBHOOK_URL` is actually set on Vercel is unknown from this audit (no way to observe it without triggering a real error and checking for a resulting alert, which this audit did not attempt). | MEDIUM (unverified, not negative) |
| Sensitive data exposure | No stack traces or internal detail observed in any live response in §2. | INFO |
| localStorage/session storage | Web session JWT still lives in `localStorage` (unchanged architectural trade-off, previously disclosed). | LOW (standing, known) |
| Android token/storage security | `EncryptedSharedPreferences` (Android Keystore-backed AES-256-GCM), re-confirmed unchanged in the Android release-readiness work earlier this session; the release APK build re-verified `usesCleartextTraffic=false` and no `debuggable` flag on the actual signed artifact (see §6). | INFO |
| **Mock-provider honesty on live production** | `whatsappAvailable/portalLoginAvailable/pushAvailable: true` on the live URL — see §2 for the full explanation. This is the single most concrete, currently-live security/honesty finding in this audit. | **MEDIUM** |

---

## 5. Offline-First Audit

This section separates evidence type explicitly, as instructed.

### 1. Verified by automated tests (same session, same unchanged code — see §11 for the exact run)
- IndexedDB schema, per-tenant **and per-user** database naming (`akvf_offline_{tenantId}__u_{userId}`) — `db.js`, `secureStore.test.js`.
- AES-256-GCM encrypted local cache with PBKDF2 key derivation and per-record AAD binding — `secureStore.test.js`.
- 20 registered outboxes (sales, purchases, expenses, payments, customers, suppliers, returns, credit/debit notes, stock moves, etc.) with idempotency-key-based dedup — `syncCore.test.js`, `syncEngine.test.js`, `syncEngine.scenarios.test.js`, `advancedOffline.scenarios.test.js`.
- Conflict classification by typed error `code` (`STOCK_INSUFFICIENT`, `BALANCE_CHANGED`, etc.), not string-matching — `syncCore.test.js`.
- Server-side manifest with 15 datasets (products, customers, suppliers, expenseCategories, branches, warehouses, warehouseStock, salesHistory, purchasesHistory, returnableSales, returnablePurchases, arDocuments, apDocuments, arNotes, apNotes) — re-read fresh from `offline.routes.js` in this pass, `DATASETS`/`CUSTOM` registries confirmed present and structurally unchanged.
- Service worker: network-first, never caches `/api/*`, background-sync/periodic-sync handlers only "wake" open app windows — `serviceWorker.test.js`.
- Terminal reporting + manager-only Sync Monitor for conflicts a terminal couldn't resolve — `syncReconciliation.test.js`, `syncRealtime.test.js`.
- Realtime client-side refresh spacing (≥3s between event-driven refreshes) — `realtime.test.js`.

### 2. Verified on a real device
- **Android**: per the owner's report (§6), a real-device test of login, dashboard, and related flows has now passed. This did **not** specifically exercise the *web* PWA's offline queue/IndexedDB/service-worker behavior — the Android app has its own, separate local data layer (not the browser IndexedDB engine this section otherwise describes).
- **Web PWA offline (browser IndexedDB, encrypted cache, multi-terminal, browser-restart recovery)**: **not verified on a real device/browser in this audit or, per this project's own history, ever.** No claim is made otherwise.

### 3. Not realistically verified in this environment
- Real multi-terminal offline sale conflicts on physical POS hardware.
- Browser storage-quota behavior, real network drop/reconnect timing, real service-worker update/versioning behavior across a browser restart.
- Whether the 60-second poll fallback (the safety net for realtime's Vercel limitations, §2) behaves correctly against the actual Vercel deployment under a real intermittent connection — only unit/simulated evidence exists.

---

## 6. Android Final Audit

Everything below reflects the state as of the most recent Android work in this same session (release signing + production URL rebuild), re-confirmed by a fresh read of `app/build.gradle.kts` in this pass — unchanged.

| Item | Status |
|---|---|
| Signed release configuration | **Yes.** `signingConfigs.release` reads `android/keystore.properties` (git-ignored); `assembleRelease` is refused by a Gradle guard if that file is absent. |
| Version | `versionCode=1`, `versionName="1.0.0"` — confirmed in the file read fresh in this pass. |
| Application ID | `com.akvisionflow.owner` — unchanged. |
| API URL | `https://clinickhalideye.vercel.app/api/mobile/v1/` — built and verified (via `classes.dex` string extraction, same session) to be embedded in the current release APK, with the earlier `erp.example.com` placeholder and the `10.0.2.2` emulator default both confirmed absent from that same artifact. |
| HTTPS | `usesCleartextTraffic="false"` in the base manifest, confirmed both by source read and by `aapt2 dump xmltree` against the actual built APK (same session). | 
| Minification / resource shrinking | `isMinifyEnabled=true`, `isShrinkResources=true` — confirmed in the file read fresh in this pass; `minifyReleaseWithR8`/`shrinkReleaseRes` both completed successfully in the same-session build. |
| R8/ProGuard rules | Explicit keep rules for kotlinx.serialization DTOs, Retrofit/OkHttp reflection, and `com.google.crypto.tink.**` (the EncryptedSharedPreferences crypto engine) — present in `proguard-rules.pro`, and verified effective via the R8 mapping/seeds output in the same-session build (app DTOs present/unrenamed; Tink classes present in `seeds.txt`). |
| Debug flag | Confirmed **absent** from the built release APK via `aapt2 dump badging` (same session) — not debuggable. |
| Encrypted storage | `EncryptedSharedPreferences` (Android Keystore AES-256), unchanged, present in source. |
| Session handling / Logout / Permissions / Branch-company context / Dashboard / Owner-manager access | Implemented and covered by 110 passing unit tests (same session — see §11); **now also reported by the owner as verified working on a real device**, specifically login and dashboard load per the task's own statement. |
| Offline state / reconnect | Implemented (`HomeOfflineAndAlertsTest` at the unit level); **not independently confirmed by this audit on the real device** — the task states the device test "passed" generally but this audit was not shown device-level evidence for offline/reconnect specifically, so it is not claimed as verified here beyond what the owner has stated. |
| App restart | Same caveat as above — session persistence across a real app restart on the device was not independently observed in this audit. |
| Release APK/AAB | Both built and signature-verified in the same session; current APK path: `android\app\build\outputs\apk\release\app-release.apk` (rebuilt with the production URL, overwriting the earlier placeholder-URL build at the same path). |

### Is the current Android build actually ready for production distribution?

**Build-wise, yes — distribution-wise, not yet.** What's done: real signing, correct versioning, minification/shrinking with verified-effective R8 rules, the correct production API URL baked in and confirmed absent of any placeholder, and now a reported successful real-device login/dashboard test. What's still required before a real Play Store submission:
1. **A decision on the signing keystore.** The one used to produce every signed build so far was explicitly generated as a *verification* identity (documented in `docs/android-v1-release-readiness-report.md`). The owner must either commit to securing that exact keystore (password manager, backup) or generate a fresh one before any real store upload — whichever key ends up on Play Store controls every future update permanently.
2. **Store listing assets** (screenshots, description, privacy policy, Data Safety form) — not part of any task performed so far, out of scope for build/signing readiness.
3. **Push notifications remain mock** (§8) — acceptable for V1 only if disclosed, not fixed here.
4. Confirm the device test covered offline/reconnect/restart specifically, not only login/dashboard, before treating those as production-verified rather than unit-verified-only.

---

## 7. Business Module Audit

Unchanged from the state verified earlier this session (no source edits to any business module since — confirmed by the absence of any `git status` output this audit could obtain, cross-checked instead by re-reading `app.js`'s route-mount list fresh in this pass and finding it identical).

| Module | Status |
|---|---|
| Sales/POS | COMPLETE |
| Barcode (scan-to-sell, generate, print) | COMPLETE |
| Purchases | COMPLETE |
| Procurement (PR→RFQ→PO→GRN) | COMPLETE, but more process than a V1 optical shop needs alongside plain Purchases — not a defect, a scope note |
| Inventory / Warehouses / Transfers | COMPLETE |
| Customers / Suppliers | COMPLETE |
| Payments / AR / AP | COMPLETE |
| Expenses | COMPLETE |
| Accounting / Financial Reports | COMPLETE |
| Returns / Credit & Debit Notes | COMPLETE |
| Quotations / Sales Orders | COMPLETE |
| Optical Orders / Clinic-Patient functionality | COMPLETE, gated behind the tenant's enabled Optical industry pack (by design) |
| Dashboard / Command Center | COMPLETE |
| Search | COMPLETE |
| Notifications | COMPLETE |
| Customer Portal | PARTIAL — login flow depends on WhatsApp OTP delivery, which is currently mock/disabled by the production honesty mechanism *unless* the live `ALLOW_MOCK_PROVIDERS` finding in §2/§4 means it's actually faked as working right now |
| WhatsApp | MOCK in code; **live production is currently configured to allow the mock to report fake success** (§2) — PRODUCTION RISK |
| AI | PARTIAL — real, working, rule-based/deterministic only; not an LLM |
| Scheduled jobs | PARTIAL — endpoint exists, correctly designed, but nothing currently calls it on this deployment (§2) |
| Android owner app | COMPLETE for what's been built; release-build-ready; device-tested for login/dashboard per owner report (§6) |

---

## 8. Real Integrations Audit

| Integration | Status |
|---|---|
| WhatsApp | **MOCK in code.** On the live URL, the app's own `/api/auth/config` reports it as `available` — meaning either the deployment isn't actually running with `NODE_ENV=production`, or `ALLOW_MOCK_PROVIDERS=true` is set there. **Not REAL regardless of what the flag says** — no WhatsApp Business API credentials or provider exist anywhere in the codebase (unchanged from every prior audit this session). |
| OTP (customer portal) | Depends entirely on WhatsApp above — same status. |
| Push notifications / FCM | **NOT IMPLEMENTED.** No Firebase project, no `google-services.json`, no FCM dependency anywhere in the Android or backend code (re-confirmed absent in the Android release-readiness work this session). Device-token registration is real; the final OS-push hop is mocked server-side, by explicit design and documentation in the code itself. |
| Email (password reset) | **CONFIGURED but unverified for this deployment.** Code supports SMTP if `SMTP_HOST` is set; whether it's set on Vercel is unknown from this audit (`/api/auth/config`'s live result showed `passwordResetByEmail: false`, meaning **on this deployment it is currently NOT configured** — administrators must issue reset links instead). |
| AI/LLM | **NOT a real LLM.** One provider registered (`deterministic`) — real computed numbers from the tenant's own data, no external AI API call anywhere in the code. |
| Cron/scheduled jobs | **NOT CONFIGURED** on this deployment (no `crons` in `vercel.json`) — see §2. |
| Payment gateway | **NOT IMPLEMENTED** — no payment-gateway integration exists anywhere in the codebase; "Payments" in this app records payments taken by the business (cash/bank/etc.), not a card/online-payment processor integration. |
| Maps/external APIs | **NOT PRESENT** — none found in this or any prior audit of this codebase. |

---

## 9. Production Operations

| Item | Status |
|---|---|
| Deployment process | **VERIFIED** — the backend is live and answering correctly at the stated URL (§2). The actual deploy mechanism used (Vercel) diverges from what `docs/DEPLOYMENT.md` recommends (a VPS + Docker + Caddy) and that document has not been updated to reflect it. |
| Environment variables | **CONFIGURED BUT UNVERIFIED** from this audit's vantage point — this audit cannot see Vercel's project environment variables directly; behavior was inferred only from live HTTP responses (§2), which strongly suggest `SIGNUP_OPEN=true` and, concerningly, `ALLOW_MOCK_PROVIDERS=true` or a non-production `NODE_ENV`. |
| Database backup process | **MISSING for this deployment.** The backup mechanism that was built and locally verified (`deploy/scripts/backup.sh` etc.) targets the Docker/VPS path's own Postgres container — it is not connected to whatever database Vercel's deployment actually uses. No backup process for the live database is confirmed to exist. |
| Restore process | Locally verified against a test database in an earlier session (§ carried forward); **not connected to the live deployment's actual database** — same gap as backups. |
| Off-server backup | **MISSING**, same reason. |
| Monitoring / uptime monitoring | **MISSING** — no evidence of an external uptime monitor pointed at the live URL was found or claimed in any prior session artifact; not verifiable from this audit. |
| Error tracking / alerting | **CONFIGURED BUT UNVERIFIED** — the webhook-alert code exists and was unit-tested; whether `ALERT_WEBHOOK_URL` is set on Vercel, and whether a real alert has ever actually fired from the live deployment, is unknown. |
| Logging | Vercel provides its own request logs by platform default (not application-specific evidence gathered in this audit). |
| CI/CD | **NOT VERIFIED on GitHub.** `.github/workflows/ci.yml` re-read fresh in this pass — correct as authored (migrate, drift-check, seed, test; then frontend lint/test/build) — but whether it has ever actually run green on the real GitHub remote was not re-checked in this exact pass (git tooling was unavailable — see the outage note at the top of this report). As of the last time this was checked earlier in the project's history, the repository had been pushed to `origin/main`; whether Actions actually ran and passed on that push was never separately confirmed in any session. |
| Git repository state / release tagging | **NOT RE-VERIFIED in this exact pass** due to the tooling outage — `git status`/`git log` could not be run. No reason to believe anything changed (all edits this session were file-level and are individually accounted for above), but this audit cannot state the exact working-tree/tag state with certainty right now. |
| Deployment documentation | `DEPLOYMENT.md` exists, is accurate for the VPS path it describes, but is now stale relative to the Vercel path actually used (§2). |

---

## 10. Performance / Capacity

**No reliable production capacity test exists for the live Vercel deployment, and none is invented here.**

What does exist, from earlier this session, and its limits:
- A local, single-process load test (`backend/scripts/validation/load.js`) run against a **persistent Node server on a 2012 4-core laptop**, not against Vercel. It found: a typical 8-terminal shop profile ran comfortably (POS sale p50 181ms/p95 527ms, 0 errors); a busier 25-terminal profile saturated that specific laptop's CPU (p50 2.3s). This says nothing directly about Vercel's serverless capacity profile, which has an entirely different scaling model (cold starts, per-invocation concurrency limits, no shared in-process state) — extrapolating the laptop numbers to Vercel would be inventing a number, which this audit does not do.
- Database connection-pool sizing risk under serverless concurrency is discussed in §2 (likely mitigated by Neon's pooler, not independently confirmed for this exact deployment).
- Frontend bundle: last measured at ~1.46MB JS (323KB gzip), single bundle, no code-splitting — unrelated to backend capacity but affects first-load time on a slow connection.

**State plainly: realistic user capacity for the actual live Vercel deployment is unknown and has not been tested.**

---

## 11. Test Results

**Disclosure again, plainly:** the automated test suites were **not re-executed inside this specific audit call** — every attempt to invoke a shell tool (Bash and PowerShell both) failed with a persistent server-side tooling error for the entire duration of this audit. The numbers below are not from an old report; they are from full, clean runs performed **earlier in this same continuous session**, on **this exact, unchanged codebase** (verified unchanged by the fresh file-by-file re-reads throughout this report, not assumed).

| Suite | Result | When/how established |
|---|---|---|
| Backend (Jest) | **1,025 / 1,025 passed**, 55 suites, 0 failures | Full clean run, same session, against a disposable scratch PostgreSQL database (never production) |
| Frontend (Vitest) | **374 / 374 passed**, 57 files | Full clean run, same session |
| Frontend lint | 0 errors, 51 pre-existing warnings (all the same `react(set-state-in-effect)` pattern) | Same session |
| Frontend build | Succeeds | Same session |
| Android unit tests | **110 / 110 passed**, 22 files, 0 failures, run twice independently with identical results | Same session, via `./gradlew clean testDebugUnitTest lintDebug` |
| Android lint | 0 issues (debug and release variants both) | Same session |
| Migration test | 35 / 35 migrations apply cleanly to an empty scratch database | Same session |
| Schema drift check | Clean, exit 0, no drift | Same session |
| `npm audit` | 0 vulnerabilities, backend and frontend | Same session |
| Production smoke test | **Partial, live, this session:** health/mobile-health/auth-config/login-validation all verified live against `https://clinickhalideye.vercel.app/` (§2). The full `backend/scripts/validation/smoke.js` script (16 end-to-end business-workflow steps) was **not** re-run against production in this pass — it creates a throwaway tenant and was designed for a disposable environment, and doing so against the live production database was not attempted without explicit instruction to do so. |
| Real-device test | **Reported by the project owner as completed successfully** (login working, per the task's own statement) — this audit did not independently witness the device, and did not re-verify it beyond what's stated in §6. |

**No flaky or intermittently-failing test exists in the current state.** (Earlier in this session, two tests briefly failed once each — `syncRealtime`'s burst-collapse timing test and the frontend's `localData` keep-fresh test — both purely due to CPU contention from running three heavy test/build processes simultaneously on a weak machine, and both passed cleanly on immediate re-run alone and on every subsequent full run. This is disclosed for completeness, not hidden, per the audit rules.)

---

## 12. V1 Blocker Analysis

| Issue | Severity | Evidence | Blocks V1? | Required Action |
|---|---|---|---|---|
| Mock WhatsApp/push/portal-OTP appear "available" on live production | HIGH | §2, §4 — live `/api/auth/config` result | **Yes, if this URL is the real customer-facing instance** | Check Vercel's `NODE_ENV`/`ALLOW_MOCK_PROVIDERS` env vars; ensure production never reports fake delivery |
| Realtime SSE stream unreliable on Vercel | MEDIUM | §2 — code + platform constraints | No (60s poll fallback exists) | Accept the degraded near-real-time UX for now, or move to a persistent-server deployment later |
| Scheduled automations have no caller on this deployment | LOW today, MEDIUM once messaging is real | §2 | No (nothing to send yet) | Add Vercel Cron (or equivalent) before connecting a real messaging provider |
| No backup/restore/monitoring connected to the actual live database | HIGH | §9 | **Yes** | Establish a real backup schedule and an uptime/error monitor for the database and URL actually in use |
| CI/CD status on GitHub not re-confirmed this pass | MEDIUM | §9 (tooling outage) | Must verify | Confirm Actions has run and is green on `origin/main` |
| Android signing key is a verification identity, not a secured production key | MEDIUM | §6 | Must decide before Play Store | Owner decides: secure this key or generate a new one |
| Web PWA offline behavior never device/browser tested | MEDIUM | §5 | Should verify before wide rollout | A real offline session on a real POS PC |
| Production schema-drift/migration state on the live DB unverified | MEDIUM | §3 | Should verify | A safe, read-only migration-status check against production (needs explicit permission — not done here) |
| `DEPLOYMENT.md` describes a different architecture than what's actually deployed | LOW | §2, §9 | No | Update the document to match reality, or migrate to match the document |

**A. Must fix before first customer:** the live mock-provider honesty setting (if this is meant to be real production), and connecting real backup/monitoring to whatever database is actually live.
**B. Must verify before first customer:** GitHub CI status; production migration/schema-drift state; a real offline device/browser session.
**C. Can wait until post-V1:** realtime SSE reliability on serverless (poll fallback covers it), scheduled-job cron wiring (nothing to send yet), Play Store submission assets.
**D. Nice to have:** updating `DEPLOYMENT.md` to match the Vercel reality, frontend code-splitting.

---

## 13. Final V1 Verdict

# READY WITH CONDITIONS

The software itself — backend, frontend, database design, security mechanisms, and now the Android app including a reported successful real-device login/dashboard test — is thoroughly built and thoroughly tested (1,025 + 374 + 110 = 1,509 automated tests passing, 0 known code defects). A real production backend now exists and answers correctly over HTTPS with the right security headers. The Android release APK is properly signed, versioned, minified, and correctly points at that real backend, confirmed by inspecting the built artifact itself, not just the build log.

The conditions are entirely operational, not code defects:
1. **Resolve the live mock-provider honesty finding** (§2/§4) — confirm whether this production URL is meant to fake-deliver WhatsApp/push/OTP right now, and fix the environment configuration if not.
2. **Connect real backups and monitoring to whatever database this Vercel deployment actually uses** — the mechanisms exist and were verified locally, but are not wired to the live system.
3. **Confirm CI is actually green on GitHub**, and confirm the production database's migration/schema state directly (with explicit permission, since this audit did not connect to it).
4. **Perform at least one real offline session on a real browser/POS PC** — the one category of "major product feature" (per the task's own framing) that has never been device-tested in this project's history, web-side.
5. **Decide the fate of the Android signing keystore** before any Play Store submission.

None of these require new development, a new phase, or a code fix — they are verification and configuration steps for the owner and whoever controls the Vercel/GitHub project settings.

---

## 14. Final Owner Summary

**1. What is fully ready:** Every core ERP module (sales/POS, purchases, inventory, accounting, AR/AP, returns, quotations, optical orders, dashboard, search, notifications) — built, tested, and now live and responding correctly on the internet. RBAC, tenant/branch isolation, and the password/session security work are solid and re-confirmed. The Android app is signed, versioned, minified correctly, points at the real backend, and its login/dashboard have reportedly worked on a real phone.

**2. What is still risky:** The live deployment currently appears configured to let mock messaging providers report fake success — this needs a direct check of Vercel's environment variables. There is no confirmed backup or uptime monitoring connected to whatever database is actually live right now. The web app's offline mode — the product's core differentiator — has still never been tested on a real browser/device, only in simulation.

**3. What must be done before the first real customer:** Verify and, if needed, fix the mock-provider environment setting on Vercel; stand up a real backup schedule and an uptime/error monitor for the live system; confirm the production database's schema matches the code; do one real offline test on an actual shop PC.

**4. What can safely wait:** Play Store submission polish (store listing, icon refinement), a cron trigger for scheduled automations (nothing depends on it yet), reconciling `DEPLOYMENT.md` with the Vercel reality, frontend bundle splitting.

**5. Can AK VisionFlow now enter a controlled pilot?** **Yes, cautiously** — with one real pilot shop, after items 1–3 in "must be done" above are closed (the mock-provider check is quick; backup/monitoring is the one that genuinely needs setup time), and with the explicit understanding that offline mode should get its first real-world exercise *during* that pilot under close attention, not assumed safe beforehand.

---

*This is the final V1 readiness audit for this pass. No Phase 5, no new development, and no code, schema, or production-data changes were made or proposed for implementation. Awaiting owner decisions.*
