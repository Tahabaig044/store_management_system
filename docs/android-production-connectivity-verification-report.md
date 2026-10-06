# Android → Production Backend Connectivity Verification

Follow-up to `docs/android-v1-release-readiness-report.md`. Scope: point the release APK at the newly deployed
production backend (`https://clinickhalideye.vercel.app`) and rebuild — nothing else. No Android business logic,
database schema, or production data was touched.

---

## 1. Deployed Backend Verification

| Check | Result |
|---|---|
| `GET /api/health` | `200` — `{"status":"ok","version":"1.0.0",...}` in 0.74s. Confirms the server is up **and** its database connection works (this endpoint runs `SELECT 1` against the DB before answering). |
| `GET /api/mobile/v1/health` | `200` — `{"status":"ok","api":"mobile","version":"v1"}`. The mobile API surface specifically is live. |
| `POST /api/mobile/v1/auth/login` (malformed body) | `422` with field-level validation errors — proves the endpoint is genuinely processing requests, not returning a cached/static response. |
| `POST /api/mobile/v1/auth/login` (demo credentials `admin@khalideyeclinic.test`) | `401 "Invalid email or password"` — see note below. |
| HTTPS/TLS | All requests completed over `https://` with no certificate errors from `curl`. Response headers confirm `Server: Vercel`, `Strict-Transport-Security`, a real `X-Vercel-Id`, and a full set of security headers (CSP, X-Frame-Options, etc.) — this is the genuine deployed app, not a placeholder/parking page. |
| DNS | `clinickhalideye.vercel.app` resolves and connects correctly (contrast with `erp.example.com`, which does not resolve at all — see the prior diagnosis). |

**Login note:** the 401 is expected and is not a fault — it means the endpoint reached the database and correctly rejected credentials that don't exist in *this* database (this Vercel deployment's `DATABASE_URL` may point at a different, or freshly-seeded, database than the one this session's local testing used, or the demo tenant/password there simply differs). I did not attempt to guess further credentials or register a new tenant on production, per the instruction not to touch production data — a failed login writes nothing to the database (the row is only updated on a *successful* login), so this check was non-mutating. **A full successful login must be verified with the real owner's actual credentials on the device itself** — that's the real-device test below.

**One observation, not fixed (out of scope for this task):** `GET /api/auth/config` on this deployment reports `whatsappAvailable: true, portalLoginAvailable: true, pushAvailable: true`. Per the app's own honesty design (`utils/providerPolicy.js`), those only read `true` when `NODE_ENV` is not `"production"`, or `ALLOW_MOCK_PROVIDERS=true` is explicitly set. Worth checking the Vercel project's `NODE_ENV` environment variable when convenient — not addressed here since it's a backend/environment configuration matter, not an Android task.

**Architecture note carried over from the earlier full-project audit, not re-litigated here:** Vercel's serverless model doesn't hold the *web app's* realtime SSE stream (`/api/sync/stream`) correctly across invocations. This is irrelevant to what was just verified — none of the Android app's API services use that endpoint (it checked: `AiAdvisorApiService`, `AlertsApiService`, `DashboardApiService`, `ManageApiService`, `MobileApiService` — no SSE/stream calls in any of them) — but it means this Vercel deployment should not yet be treated as validating the *full* production architecture for the web frontend, only for what the Android app actually needs.

## 2. Android API URL Audit (before this change)

The release APK built in the prior task embedded the verification placeholder used to prove the signing/URL guard mechanism:
```
API_BASE_URL = https://erp.example.com/api/mobile/v1/
```
(Diagnosed in the previous turn — a non-resolvable RFC 2606 example domain, the root cause of "Unable to reach AK VisionFlow.")

The Gradle mechanism itself (`app/build.gradle.kts`) was **not changed** for this task — it already accepted the API URL as a build-time property (`-PapiBaseUrl=...`) with no default silently used for a release build (the guard added in the previous task refuses `assembleRelease` without one). Only the *value passed at build time* changed.

## 3. What Was Changed

**Nothing in source control.** Confirmed by `git status` before and after — identical to the previous task's diff (`.gitignore`, `app/build.gradle.kts`, `app/proguard-rules.pro`, `keystore.properties.example`, the release-readiness report). No business logic, no schema, no new files. The only difference is the value passed to the existing `-PapiBaseUrl` build parameter for this one build invocation.

## 4. New Signed Release Build

```
./gradlew.bat assembleRelease -PapiBaseUrl=https://clinickhalideye.vercel.app/api/mobile/v1/ --offline
BUILD SUCCESSFUL in 5m 37s
49 actionable tasks: 13 executed, 36 up-to-date
```

Same signing config and R8/minification as the previous build (unchanged files, so unchanged behavior) — `isMinifyEnabled = true`, `isShrinkResources = true`, signed with the same verification keystore from the prior task.

### APK path
```
D:\Taha\Khalid-Eye-Clinic\android\app\build\outputs\apk\release\app-release.apk
```
(2,093,904 bytes, built 2026-09-28 16:15 — this **overwrites** the previous `erp.example.com` build at the same path. If you still have the old APK installed on the phone, uninstall/reinstall or the OS may refuse the update since the signing key is the same but you'll want to be certain which build is on the device.)

### Verification of the two required conditions

Extracted directly from the built APK's `classes.dex` (not assumed from the build log):

| Check | Result |
|---|---|
| `https://erp.example.com` present? | **No matches found** — confirmed absent. |
| `http://10.0.2.2` (emulator default) present? | **No matches found** — confirmed absent. |
| `https://clinickhalideye.vercel.app/api/mobile/v1/` present? | **Found** (`API_BASE_URL`), plus `https://clinickhalideye.vercel.app/api/` (`API_ROOT_URL`, used by the management screens). |

### Other release-artifact checks (re-run, same results as the prior signed build)
- `apksigner verify --verbose` → `Verifies`, v2 scheme, 1 signer.
- `aapt2 dump badging` → `versionCode='1' versionName='1.0.0'`, no `application-debuggable` line.
- `aapt2 dump xmltree AndroidManifest.xml` → `usesCleartextTraffic=false`.

---

## Real-Device Test Checklist

Install `app-release.apk` (path above) on the phone and, in order:

1. **Install** — uninstall any prior build first if unsure which version is on the device.
2. **Login** — with a real, valid account for this Vercel deployment's database.
3. **Dashboard loads** — KPIs/summary render without an error banner.
4. **Branch/company context** — the header or profile screen shows the correct branch/company for that login.
5. **Permissions** — screens/actions match the signed-in user's role (e.g., a non-admin doesn't see admin-only management options).
6. **Logout** — returns cleanly to the login screen.
7. **Login again** — same or a different account, succeeds.
8. **Turn internet off** — app shows a clear offline/connection-error state (not a crash or infinite spinner).
9. **Turn internet on** — app recovers and reconnects/refreshes without needing a restart.
10. **Session handling** — close and reopen the app; confirm you're still signed in (or correctly prompted to sign in again if the session expired).
11. **Tenant/user data isolation** — if you have a second account (different tenant or different user), sign in with it after signing out of the first, and confirm nothing from the first account's session (cached names, numbers, alerts) is visible.

---

## Explicitly Not Done (per instructions)

- No V1 production-readiness claim is made.
- No additional infrastructure was deployed.
- No new phase was started.
- No Android business logic, database schema, or production data was modified.
- The `NODE_ENV`/mock-provider observation in §1 was noted, not changed.

Stopping here, as directed, after building the APK and writing this report.
