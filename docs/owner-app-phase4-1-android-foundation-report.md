# Phase 4.1 — Android Foundation: Verification Report

**Status: PHASE 4.1 COMPLETE, WITH CONDITIONS — stopped for Product Owner approval. Phase 4.2 has not been started.**

## 1. Audit of what already existed (before any change)
A Kotlin/Jetpack Compose owner app (59 Kotlin files, 25 → 85 unit tests) and a read-only `/api/mobile/v1` backend surface already existed from the earlier "Owner App Phases 1–3" (see `docs/owner-app-phase1..3`). Nothing was rebuilt. Reused as-is: Retrofit/OkHttp stack, `ApiResultMapper`, `AuthInterceptor`, Keystore-backed `SecureTokenStore`, `SessionRepository`, navigation shell, dashboard/alerts/AI screens, the separate `typ:'mobile'` token that cannot reach staff routes.

| # | Gap against the 4.1 scope | Evidence |
|---|---|---|
| G1 | **Roles:** only `TENANT_ADMIN` could sign in; the app is now an owner/**management** app | `mobileAuth.js`, `mobile.routes.js` |
| G2 | **Permission enforcement:** login returned a constant `{readOnly, role:'OWNER_MOBILE'}`; mobile routes checked no permission; the app had no notion of what a session may do | `mobile.routes.js`, `MobileDtos.kt` |
| G3 | **Branch/company context:** no context endpoint; dashboard/AI routes accepted any `branchId` of the tenant with no branch-access check | `dashboard.routes.js`, `aiAdvisor.routes.js` |
| G4 | **Session hygiene (bugs):** on sign-out or a 401 the on-disk OkHttp response cache, the cached profile (only cleared on manual sign-out, not on a 401), and the dashboard filter selection all survived into the next sign-in on the same device | `NetworkModule.kt`, `ProfileRepository.kt`, `DashboardFilterRepository.kt` |
| G5 | **Connection state:** no connectivity detection, no offline indication, no re-validation of the session after being offline | absent |
| G6 | **Display bug:** Profile showed the hard-coded text "Owner (read-only)" for every role | `ProfileScreen.kt:54` |

## 2. What was implemented
**Backend (reusing the existing permission catalog and branch scope — no new business rules)**
- Mobile sessions for `TENANT_ADMIN` and `MANAGER` (constant `MOBILE_ROLES`); every other role is refused with exactly the message of a wrong password. The role is re-checked from the database on every request (deactivation or a role change ends the session at once).
- Login and profile now also return `access { role, permissions[], branchRestricted, branchIds }` (the same `effectivePermissionsForRole` the web uses). The legacy `permissions` object is unchanged, so existing clients keep working.
- Mobile dashboard, alerts and AI-advisor routes require `REPORT:VIEW` (the permission the web reports need) via the catalog, evaluated for the session's real role.
- Branch scope: a `branchId` must belong to the tenant (422) **and** be accessible to the user (403); a branch-restricted session with several branches must choose one (`BRANCH_REQUIRED`), with exactly one it is defaulted; `dashboard/filters` lists only accessible branches. New `GET /api/mobile/v1/context` returns the accessible branches grouped by company.
- Still read-only (writes on the mobile surface remain 403). No schema change, no migration.

**Android**
- `SessionContext` (who, role, permission keys, branch scope), persisted encrypted next to the token (`SecureSessionContextStore`), restored on restart, dropped if no token, refreshed from every profile response (a revoked permission disappears immediately).
- Permission-aware navigation: tabs the session lacks permission for are not offered, cannot be navigated to, and the app leaves a tab whose permission is withdrawn. Start tab = first permitted. (UX only — the API enforces.)
- `BranchContextRepository`: loads the context after sign-in, drops a branch selection the user may not use, defaults a single-branch user.
- Connection handling: `ConnectivityMonitor` (validated-network callback), offline banner, and automatic session re-validation (profile + context) when the connection returns.
- Session-ended hook (sign-out **and** 401): clears the disk response cache, cached profile, filter selection, branch context, token and context exactly once (fixes G4).
- `ApiResult.Error` now carries the backend's stable `code`; Profile shows the real role and branch access (fixes G6).

## 3. Genuine bugs fixed
G4 (data of the previous user surviving into the next session on a shared device — three separate leaks) and G6 (wrong role label), plus G3 (any tenant branch accepted with no branch-access check).

## 4. Verification
| Check | Result |
|---|---|
| Backend full suite (local PostgreSQL, real HTTP) | **47/47 suites, 957/957 tests** (was 45/949; +8 new: `mobileManagement`, `mobileGating`) |
| Existing mobile suites (`mobile`, dashboard, alerts, AI) | all pass unchanged |
| Android JVM unit tests | **19 classes, 85 tests, 0 failures** (60 new/extended: session context, session lifecycle, destinations/permission visibility, branch context, connectivity state, management sign-in/refresh, error code) |
| Android lint | 0 errors, 0 fatal, 0 warnings (lint XML) |
| Android build | `assembleDebug` and `assembleDebugAndroidTest` succeed |

Backend tests prove: MANAGER sign-in and its real permission list (no `USER:CREATE`); CASHIER/STORE_KEEPER/ACCOUNTANT/RECEPTIONIST/DOCTOR refused with the wrong-password message; mobile token rejected on `/api/customers` and staff token rejected on mobile; foreign-tenant branch → 422; deactivation/role-change → 401 at once; a catalog without `REPORT:VIEW` → 403 on every report-like mobile route while the owner keeps access; branch-restricted session: context and filters limited, foreign branch 403, no branch with several → `BRANCH_REQUIRED`, single branch defaulted.

## 5. Conditions / caveats (stated plainly)
1. **Android UI was not exercised on a device or emulator.** An AVD exists but hardware virtualization is disabled in this machine's firmware, so it cannot run. I wrote instrumented tests (`Phase41InstrumentedTest`: offline banner, encrypted token/context storage round-trip) which **compile but were not executed**. Compose screens, the Keystore-backed storage and the real connectivity callback are therefore **NOT VERIFIED on a device**; only their logic (JVM) is. I tried adding Robolectric for JVM Compose tests, but the Java trust store here rejects the Maven TLS certificate (an interception proxy); I did not modify the machine's trust store without your approval and reverted the dependency.
2. **MANAGER is a decision for you.** I read "owner/management" as `TENANT_ADMIN` + `MANAGER` (the two roles the web app treats as unrestricted). Other roles (accountant, store keeper…) are refused. Tell me if the set should differ; it is one constant.
3. Per the existing web rule, `TENANT_ADMIN`/`MANAGER` are never branch-restricted, so today every mobile session is unrestricted; the branch-restriction code paths are proven with a controlled scope (mocked), not with a real restricted mobile user.
4. Connectivity is a hint, not a gate; screens still refresh through their existing retry actions after a reconnect (only session/context re-validate automatically). True offline viewing/actions are Phase 4.4.
5. Not in 4.1 by design: dashboards' content (4.2), operations (4.3), offline data/certificate pinning/release signing (4.4).
6. Backend README updated for the new access/context contract.

## 6. Decisions I need before 4.3 (flagged now, not acted on)
The mobile token cannot call the existing staff endpoints (customers, products, sales…). For 4.3 "reuse existing APIs" there are two options: (a) mobile-namespaced routes that delegate to the existing route logic with the same permission/branch checks, or (b) an explicit allow-list letting mobile tokens reach selected existing endpoints. I recommend (b) with a tight allow-list; I will not decide it without you.

**Stopping here for Product Owner approval of Phase 4.1.**
