# Phase 0.1 — Owner Android App: Evidence-Based Map & Audit

**Scope:** `android/app/` (Kotlin/Compose) and its backend counterparts under
`backend/src/modules/mobile/*` and `backend/src/modules/push/*`.
**Method:** direct source inspection only (no build/emulator run — Android SDK
is not installed in this environment; no local Postgres instance was started
per this machine's standing constraint). Every claim from the Phase 1–3
`.md` reports and the "Final Project Audit" `.html`/`.pdf` was checked
against the current working tree, not assumed. Where the current code could
not be independently exercised, the claim is marked **Unknown — Requires
Inspection** rather than repeated as fact.

Date of this audit: 2026-09-17.

---

## 0. Headline Finding: The Entire Owner Mobile Feature Is Uncommitted, and the Backend Half Is Currently Disabled

Two facts, both directly observable in the repo right now, are more
important than anything below and change how every other finding in this
document should be read:

1. **Nothing related to Owner Mobile has ever been committed to git.**
   `git status --porcelain -uall` shows the entire `android/` tree, every
   file in `backend/src/modules/mobile/` and `backend/src/modules/push/`,
   `backend/src/middleware/mobileAuth.js`, all five mobile-related backend
   test files (`mobile.test.js`, `mobileDashboard.test.js`,
   `mobileAlerts.test.js`, `alertMapping.test.js`,
   `mobileAiAdvisor.test.js`), the Prisma migration
   `20260915105019_phase3_owner_mobile_alerts_push/`, and all four
   `docs/owner-app-phase*` reports as `??` (untracked). `git log --oneline
   -- android/` returns **nothing** — there is no commit, ever, that
   touched the Android project. The only mobile-adjacent files that are
   tracked-and-modified (`M`, not `??`) are `backend/src/app.js`,
   `backend/src/config/env.js`, `backend/src/middleware/auth.js`,
   `backend/src/utils/jwt.js`, `backend/.env.example`, `README.md` — i.e.
   the small, generic hooks the mobile feature needed inside otherwise
   pre-existing files.

2. **The backend mobile API is currently unmounted and unreachable.**
   `backend/src/app.js` (lines 84–90 and 258–263) has an explicit comment:
   the six Owner Mobile routers (`mobile.routes.js`, `dashboard.routes.js`,
   `alerts.routes.js`, `aiAdvisor.routes.js`,
   `notificationPreferences.routes.js`, `pushRegistration.routes.js`) are
   **deliberately not `require`d or `app.use`d**, "while that app is
   paused," because they depend on "the not-yet-applied Owner Mobile Prisma
   migration ... which must stay unapplied in production until that work
   resumes." Confirmed independently: `backend/prisma/schema.prisma` (1929
   lines, single file, no additional `.prisma` files) has **no**
   `DeviceToken`, `PushConfig`, or `UserNotificationPreference` models, and
   `AiInsight` has no `notifiedAt`/`notifiedSeverity` fields — even though
   the migration SQL file implementing exactly those (table-for-table) sits
   untracked on disk at
   `backend/prisma/migrations/20260915105019_phase3_owner_mobile_alerts_push/migration.sql`.
   Practical effect: `backend/src/modules/mobile/pushRegistration.routes.js`
   and `backend/src/modules/push/pushService.js` call
   `prisma.deviceToken.upsert(...)`, `prisma.pushConfig...`,
   `prisma.userNotificationPreference...` — none of which exist on the
   generated Prisma Client. If these routers were mounted today against
   this schema, every one of those calls would throw
   (`TypeError: Cannot read properties of undefined`) at runtime. This is
   presumably *why* they are unmounted, not an oversight.

   This means: as the backend stands right now, **every single endpoint the
   Android app calls returns 404** (`/api/mobile/v1/*` is not mounted at
   all — not even `/health` or `/auth/login`). The Android app in its
   current form cannot log in against this backend.

3. **This is a change since the "Final Project Audit" report**, which is
   dated 2026-09-16 and itself does not mention routes being unmounted —
   it describes the migration as "not yet applied to production" (a
   deploy-gating decision) while treating the code as functional/testable
   locally. The `app.js` "paused" comment is new, uncommitted, current
   working-tree state as of 2026-09-17. Whatever caused the pause happened
   *after* that audit was written. This document cannot determine why from
   the code alone — flagged below as unresolved.

Everything in the sections that follow describes what the code *would do
if wired up / migrated*, cross-referenced against what actually exists on
disk today. Read "VERIFIED" anywhere below as "verified as present and
internally consistent in source," not "verified as running."

---

## 1. Screen → Backend API Map

All native screens live under `android/app/src/main/kotlin/com/akvisionflow/owner/feature/`, navigated via `OwnerNavHost.kt` / `MainScaffold.kt` (bottom nav: Home, Analytics, Alerts, AI Advisor, Profile — `Destinations.kt`) plus a standalone Login screen gated by `SessionRepository.state`.

| Screen (Kotlin) | ViewModel / Repository | Retrofit service | Backend route(s) | Backend router file | Mounted in `app.js`? |
|---|---|---|---|---|---|
| `LoginScreen.kt` | `LoginViewModel` → `AuthRepository` | `MobileApiService` | `POST /api/mobile/v1/auth/login` | `mobile.routes.js` | **No (unmounted)** |
| Logout (from `ProfileScreen`) | `ProfileViewModel` → `AuthRepository` | `MobileApiService` | `POST /api/mobile/v1/auth/logout` | `mobile.routes.js` | **No** |
| `HomeScreen.kt` | `HomeViewModel` → `DashboardRepository` | `DashboardApiService` | `GET /dashboard/summary`, `/dashboard/expenses`, `/dashboard/receivables`, `/dashboard/inventory` | `dashboard.routes.js` | **No** |
| `AnalyticsScreen.kt` | `AnalyticsViewModel` → `DashboardRepository` | `DashboardApiService` | `GET /dashboard/sales`, `/dashboard/profit`, `/dashboard/filters` | `dashboard.routes.js` | **No** |
| `AlertsScreen.kt` | `AlertsViewModel` → `AlertsRepository` | `AlertsApiService` | `GET /alerts`, `GET /alerts/:id`, `POST /alerts/:id/read`, `POST /alerts/:id/dismiss`, `GET/PUT /notification-preferences` | `alerts.routes.js`, `notificationPreferences.routes.js` | **No** |
| Device (un)registration (called from Login on success, Profile on logout) | `AlertsRepository.registerThisDevice()` / `.unregisterThisDevice()` | `AlertsApiService` | `POST /push/register-device`, `POST /push/unregister-device` | `pushRegistration.routes.js` | **No** |
| `AiAdvisorScreen.kt` (home) | `AiAdvisorViewModel` → `AiAdvisorRepository` | `AiAdvisorApiService` | `GET /ai/home` | `aiAdvisor.routes.js` | **No** |
| `AiBriefingScreen.kt` | " | " | `GET /ai/briefing` | " | **No** |
| `AiNeedsAttentionScreen.kt` | " | " | `GET /ai/needs-attention` | " | **No** |
| `AiHistoryScreen.kt` | " | " | `GET /ai/history` | " | **No** |
| `AiInsightDetailScreen.kt` (+ `JsonEvidenceView.kt`) | " | " | `GET /ai/insights/:id` (read/dismiss reuses `alerts.routes.js`) | " | **No** |
| `ProfileScreen.kt` | `ProfileViewModel` → `ProfileRepository` | `MobileApiService` | `GET /api/mobile/v1/profile` | `mobile.routes.js` | **No** |
| (implicit, called from `NetworkModule`/interceptors) | — | `MobileApiService.health()` | `GET /api/mobile/v1/health` | `mobile.routes.js` | **No** |

Notes on the map:
- The AI Advisor screens (`aiadvisor/*`) and their backend router
  (`aiAdvisor.routes.js`, `aiInsightMapping.js`) and test file
  (`mobileAiAdvisor.test.js`) exist in full, but **no "Phase 4 final
  report" `.md` exists** in `docs/` analogous to the Phase 1–3 reports —
  only the Phase 4 *specification* PDF
  (`AK_VisionFlow/AK_VisionFlow_Owner_App_Phase_4.pdf`, a requirements
  document, not a completion/verification report). The only phase-4
  verification claims found are the summary paragraphs in section H of
  `docs/owner-android-app-final-audit-report.html`. There is no per-phase
  breakdown of problems found, exact test counts, or Android file count for
  Phase 4 to cross-check the way there is for Phases 1–3.
- `AiAdvisorApiService`'s own doc comment says insight read/dismiss
  "reuses the Phase 3 `AlertsApiService` endpoints" — confirmed true in
  `aiAdvisor.routes.js`'s header comment and by the absence of any
  read/dismiss route in that file.
- Every mobile GET route requires `authenticateMobile`; every route past
  the module's own `mobileReadOnlyGuard` mount point in each router must be
  GET. The one exception class is explicit: `POST /auth/logout`,
  `POST /alerts/:id/{read,dismiss}`, `PUT /notification-preferences`, and
  `POST /push/{register,unregister}-device` are all pre-guard, deliberately
  documented as "notification-state/account metadata, never business data."

---

## 2. Security Baseline (as implemented in code)

| Area | Finding | Risk if this were live today |
|---|---|---|
| **Auth flow** | `POST /api/mobile/v1/auth/login` (`mobile.routes.js`) — email+bcrypt password check against the same `User` table as the web app, but only succeeds if `user.role === 'TENANT_ADMIN'` (checked **after** password verification, so a wrong-role account fails identically to a wrong password — deliberate enumeration resistance). Issues a JWT via `signMobileToken()` with `typ: 'mobile'` claim. | — |
| **Token type isolation** | `authenticateMobile` (`middleware/mobileAuth.js`) rejects any token whose `typ` isn't `'mobile'`; `middleware/auth.js` (the staff middleware) was generalized to reject any *typed* token, so a mobile or portal token can never reach a staff/web route and vice versa. Re-fetches `user`/`tenant` from the DB on every request (not just at login), so deactivation is immediate. | — |
| **Token storage on device** | `SecureTokenStore.kt` — `EncryptedSharedPreferences` (androidx.security-crypto 1.1.0-alpha06) backed by a Keystore `MasterKey` (AES256-GCM key, AES256-SIV key-encryption, AES256-GCM value-encryption). This is the *only* on-disk write of the raw token; everywhere else it lives only in memory for the process lifetime (`SessionRepository`). **This is a correctly-implemented hardware-backed store, not plaintext SharedPreferences.** A parallel `TokenStore` interface + `InMemoryTokenStore` exists purely for JVM-testability (not used in the real app — verified via `AppContainer.kt`/`ViewModelFactory.kt` wiring). | **None** — no plaintext-token finding here, contrary to what a generic "flag plain storage" checklist might expect to find. |
| **HTTPS enforcement** | Main manifest: `android:usesCleartextTraffic="false"` (release). Debug-only manifest (`src/debug/AndroidManifest.xml`) overrides to `true` + a debug-only `network_security_config_debug.xml` scoping cleartext to `10.0.2.2` and `localhost` only, with an explicit comment that release builds never merge this file. **However**, `build.gradle.kts`'s `buildConfigField` default for `API_BASE_URL` is `http://10.0.2.2:4000/api/mobile/v1/` — i.e. the *default* base URL is plain HTTP, overridable only via a Gradle property (`apiBaseUrl`) that must be supplied at release-build time. No production HTTPS URL is hard-coded or checked in anywhere. | **Medium** — HTTPS is structurally enforced for release builds (cleartext literally cannot work outside the debug manifest), but there is no fail-safe default production URL; a release built without explicitly passing `-PapiBaseUrl=https://...` would simply fail to connect (cleartext blocked) rather than silently downgrading to HTTP, which is the safe failure mode — but this has never actually been exercised (see §5.4). |
| **Role/owner-only enforcement** | Server-side, robust: `authenticateMobile` re-checks `user.role !== 'TENANT_ADMIN'` on every request in addition to at login. **Client-side, there is no role check at all** — the Android app doesn't inspect or gate on `role`; it relies entirely on the fact that non-owner accounts simply cannot obtain a mobile token in the first place. This is the correct design (server is the enforcement boundary, not defense-in-depth theater on the client) but means the app has zero redundancy if the server check were ever removed. |
| **Read-only enforcement** | `mobileReadOnlyGuard` rejects any non-GET under a router once mounted past it. Phase 1 doc discloses a real bug it found and fixed: the bare `/api/mobile/v1` router's unconditional guard was intercepting sibling routers' POST routes because of Express mount-prefix ordering — fixed by reordering `app.use()` calls. This fix is real in the current `alerts.routes.js`/`notificationPreferences.routes.js`/`pushRegistration.routes.js` source (guard is mounted *after* the safe-write routes in each file) but **cannot be observed operating end-to-end right now since the whole mount is disabled** (see §0). |
| **Logging** | `HttpLoggingInterceptor` level is `BASIC` in debug, `NONE` in release (`NetworkModule.kt`) — method/URL/status only, never headers/body, so the bearer token is never logged even in debug. Consistent with the final-audit report's claim in §K. |
| **Permissions** | `AndroidManifest.xml` requests only `INTERNET` and `ACCESS_NETWORK_STATE`. No `POST_NOTIFICATIONS`, no other permissions — consistent with §3 below (no real push receiver exists to need it). |
| **App export/backup** | `MainActivity` is `exported="true"` (required for the launcher activity, normal). `allowBackup="false"`, `fullBackupContent="false"`, plus `data_extraction_rules.xml` excluding all data — the only local non-token data is a random per-install UUID (`DeviceIdProvider`), so this is a reasonable, if minor, hardening choice already made. |

**Worst realistic security-relevant finding: not a code defect but a state
mismatch** — the backend this app is coded against does not currently run
that code path at all (§0), so nothing above can be considered "enforced in
production" regardless of how well it reads in source. Purely on
code-quality grounds, no High/Critical vulnerability (e.g. plaintext token
storage, hardcoded secrets, disabled TLS) was found.

---

## 3. Push Notifications: Real Pipeline, Mocked Last Hop, No Client-Side Receiver At All

- **No Firebase/FCM dependency exists anywhere.** `android/app/build.gradle.kts`
  has no `com.google.gms:google-services`, no `firebase-messaging`, no
  `google-services.json` anywhere in the repo (checked). There is no
  `FirebaseMessagingService` subclass, no notification channel creation, no
  `NotificationManager` usage, and no runtime `POST_NOTIFICATIONS`
  permission request in the Kotlin source (grepped for
  `firebase|FCM|PushNotification|NotificationManager` — the only match in
  `android/` is the comment inside `DeviceIdProvider.kt` explaining its own
  absence).
- **What actually exists**: `DeviceIdProvider.kt` generates and persists (in
  plain, unencrypted `SharedPreferences` — this is fine, it's a random UUID,
  not a secret) a stable per-install string like
  `android-<uuid>`, registered with the backend as if it were a real FCM
  token. The code's own comment is explicit and accurate about this being a
  stand-in: *"while no real Firebase Cloud Messaging project exists for this
  app ... Swapping in a real FCM token later is a one-line change here, not
  a pipeline redesign."*
- **Backend side**: `push/pushService.js` implements a real
  detect → filter-by-preference → dedupe (`notifiedAt`/`notifiedSeverity`)
  → "send" pipeline, calling `push/providers/mockProvider.js`, which never
  makes a network call and always returns `SENT` (or a forced `FAILED` for
  a magic test token). This mirrors the existing WhatsApp mock-provider
  pattern already used elsewhere in the codebase.
- **Conclusion**: the *server-side* alert-detection-to-"delivery" pipeline
  is real, coded, and (per the Phase 3 doc) was tested against a local DB.
  The *client-side* receiving half does not exist — there is nothing in the
  Android app that could display an OS-level push notification even if one
  were sent, because no push SDK is integrated. Describing this as "push
  notifications working end-to-end" would be inaccurate; describing it as
  "the alert pipeline up to the mocked delivery hop is wired, OS-level
  push is not implemented at all" is accurate. This matches Phase 3's own
  disclosure (§12 of that report) almost verbatim — the doc does not
  overclaim here.
- On top of the above, this entire pipeline is currently unreachable
  regardless, per §0 (routes unmounted, and the Prisma models it depends on
  don't exist in `schema.prisma`).

---

## 4. Test Coverage

### Android (`android/app/src/test/kotlin/...`, JVM unit tests only)

No `androidTest` (instrumented) source set exists on disk at all — only
`src/main` and `src/test`. `androidx.test.espresso`/`androidx.test.ext:junit`
are declared as `androidTestImplementation` dependencies in
`build.gradle.kts`, but there is no `src/androidTest` directory and
therefore no instrumented test ever runs; the dependency is dead weight
until such a directory is created. This means **nothing about the app's
actual on-device UI behavior, Compose rendering, navigation clicks, or the
real `EncryptedSharedPreferences`/Keystore path has ever been exercised by
an automated test** — only plain-JVM logic (ViewModels, repositories,
mappers, filters) against fake API services (`testutil/Fake*ApiService.kt`).

Counted directly (`grep -c "@Test"`, excluding the 4 zero-test fake-service
files that only supply canned responses): **58 `@Test` methods** across 13
real test classes:

| Test class | Count | What it actually asserts |
|---|---|---|
| `SessionRepositoryTest` | 6 | State transitions (Authenticated ↔ LoggedOut) on login/logout/401 |
| `ApiResultMapperTest` | 6 | HTTP status → `ApiResult` kind mapping (401/403/422/network-failure/malformed-body/success) |
| `AuthRepositoryTest` | 5 | Login success stores token & flips session state; failed login doesn't; logout always clears local session even if the network call fails |
| `LoginViewModelTest` | 3 | UI state transitions around the login call, including device registration being triggered on successful login |
| `ProfileRepositoryTest` | 5 | In-memory cache hit / forced refresh / no-cache-on-error behavior |
| `DashboardRepositoryTest` | 3 | Repository forwards filter query params and maps responses |
| `HomeViewModelTest` | 3 | Reacts to shared `DashboardFilterRepository` changes |
| `DashboardFiltersTest` | 6 | Filter → query-map serialization logic (dates, custom range, branch/category ids) |
| `DashboardFilterRepositoryTest` | 3 | Shared filter state propagation |
| `AlertsRepositoryTest` | 5 | List/read/dismiss/preferences calls + register/unregister device wiring |
| `AlertsViewModelTest` | 4 | UI state around alert list/detail/dismiss |
| `AiAdvisorRepositoryTest` | 4 | Home/briefing/needs-attention/history/insight-detail calls map correctly |
| `AiAdvisorViewModelTest` | 5 | UI state for the AI Advisor screens |

None of these tests touch a real network call, a real Keystore, or a real
Compose UI tree — all are plain Kotlin/JUnit against hand-written fakes.
This is legitimate, useful unit coverage of client-side logic, but it is
**not** evidence that the app builds, installs, launches, or renders
correctly on a device — a limitation every one of the Phase 1–3 reports
discloses themselves (§12 "Remaining Issues" in each), so this part of
the prior docs is not an overclaim.

### Backend

Five mobile-related test files exist
(`mobile.test.js`, `mobileDashboard.test.js`, `mobileAlerts.test.js`,
`alertMapping.test.js`, `mobileAiAdvisor.test.js`) but were not executed as
part of this audit — this machine has no Docker and no local PostgreSQL
service running (per this project's known environment constraint; a
portable PostgreSQL exists at `D:\pgsql-portable` but was not started for
this documentation-only phase). Whether these currently pass is **Unknown —
Requires Inspection**; see §5.

---

## 5. Prior Claims Requiring Re-verification

Per Phase 0.1 rules, anything asserted in `docs/owner-app-phase1-foundation.md`,
`docs/owner-app-phase2-dashboard.md`, `docs/owner-app-phase3-alerts-push.md`,
or `docs/owner-android-app-final-audit-report.html`/`.pdf` that this audit
could not independently reproduce from the current code/state is listed
here as **Unknown — Requires Inspection**, not repeated as fact.

1. **"332/332 tests passed, 13 suites"** (final audit report, §A) and the
   per-phase figures **273/273** (Phase 1), **285/285** (Phase 2),
   **316/316** (Phase 3) — **Unknown — Requires Inspection.** No test run
   was executed for this audit (no DB available; also out of scope for a
   documentation-only phase). Additionally, given §0's finding that
   `schema.prisma` currently lacks the models the Phase 3 migration
   describes, it is not established that these test suites could pass
   *today* against the current schema even if a DB were available —
   `mobileAlerts.test.js` and the push-provider tests would need
   `prisma.deviceToken`/`prisma.pushConfig`/`prisma.userNotificationPreference`
   to exist on the Prisma Client, which they currently do not.
2. **"gradle :app:assembleDebug :app:testDebugUnitTest :app:lintDebug →
   BUILD SUCCESSFUL"** (all three phase reports) — **Unknown — Requires
   Inspection.** No Android SDK/Gradle is available in this environment;
   this audit could not run or re-run the build. The `@Test` counts in
   the reports (25 → 40 → 49) are lower than the 58 counted directly in
   this audit's static count, which is *consistent with* a Phase 4 that
   added `AiAdvisorRepositoryTest`/`AiAdvisorViewModelTest` (9 tests) after
   Phase 3's 49 — but no Phase 4 report exists to confirm that arithmetic
   was ever actually re-run and verified the way Phases 1–3 were.
3. **"New migration ... applied to the local test DB only ... not deployed
   to the production Neon database"** (Phase 3, §6) and **"the Phase 3
   schema migration ... has not been applied to production"** (final audit,
   §C) — the "not applied to production" half is plausible and consistent
   with standard practice, but **cannot be confirmed** without production
   DB access (correctly out of scope). More importantly, this audit found
   the migration **also isn't present in `schema.prisma` in the current
   working tree at all** — a materially different and more serious state
   than "written and tested locally, just not deployed yet," which is what
   both prior docs describe. Whether it was ever actually applied to *any*
   database, even the disposable local test DB, as claimed, is now
   **Unknown — Requires Inspection**.
4. **"Mounts the 3 new routers" / app.js reordering described as an
   applied, working fix** (Phase 3, §5, §10) — directly contradicted by
   the *current* `app.js`, which mounts **none** of the six Owner Mobile
   routers and explicitly documents them as intentionally unmounted. This
   is not necessarily a false claim *at the time Phase 3 was written* —
   the mounts may well have existed then and been removed afterward (see
   §0.3) — but it is **not true of the code as it stands now**, and no
   record in git or in the docs explains when or why the unmount happened.
5. **"production-ready Kotlin + Compose structure"** (Phase 1, §2) and the
   final audit's **"GO WITH CONDITIONS"** verdict — both are qualified
   in their own text (conditions listed: code not pushed, migration not in
   production, no release API URL configured, no real push credentials),
   so they are not blind overclaims. However, given §0, an additional,
   more basic condition now exists that neither document lists:
   **the backend this app talks to does not currently expose the app's API
   at all.** Whether "production ready" still holds given that is
   **Unknown — Requires Inspection**, and should be re-assessed once the
   reason for the unmount is understood.
6. **On-device install/launch/manual click-through** — all three phase
   reports and the final audit's own "Addendum" section already disclose
   this as **not verified** (no emulator/device — the final audit's
   addendum describes a genuine attempt blocked by BIOS-level
   virtualization being disabled). This audit adds nothing new here; it
   confirms the prior docs' own honesty on this point rather than flagging
   a new gap.
7. **"No hardcoded secrets or API keys were found anywhere in the app"**
   (final audit, §K) — spot-checked and consistent with this audit's own
   read of `NetworkModule.kt`/`build.gradle.kts` (API base URL is a build
   config property, not a secret; no API keys of any kind appear in the
   Android source). Not re-verified with an exhaustive secret scan, but no
   contradicting evidence found.
8. **Why the mobile routes were unmounted after the final audit was
   written (2026-09-16) but before this Phase 0.1 audit (2026-09-17)** —
   there is no commit, changelog entry, or comment beyond the `app.js` note
   itself explaining the decision. **Unknown — Requires Inspection** by
   whoever has context on what happened between those two dates.

---

## 6. Files Referenced

- Android source root: `android/app/src/main/kotlin/com/akvisionflow/owner/`
- Android tests: `android/app/src/test/kotlin/com/akvisionflow/owner/`
- Backend mobile modules: `backend/src/modules/mobile/`
- Backend push modules: `backend/src/modules/push/`
- Backend mobile auth: `backend/src/middleware/mobileAuth.js`
- Mount point / pause note: `backend/src/app.js` (lines 84–90, 258–263)
- Schema: `backend/prisma/schema.prisma`
- Untracked migration: `backend/prisma/migrations/20260915105019_phase3_owner_mobile_alerts_push/migration.sql`
- Prior docs verified against: `docs/owner-app-phase1-foundation.md`,
  `docs/owner-app-phase2-dashboard.md`, `docs/owner-app-phase3-alerts-push.md`,
  `docs/owner-android-app-final-audit-report.html`,
  `AK_VisionFlow/AK_VisionFlow_Owner_App_Phase_4.pdf` (spec, not a report)
