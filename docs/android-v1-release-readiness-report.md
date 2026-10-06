# AK VisionFlow — Android Owner App V1 Release Readiness Report

Scope: make the existing Android app release-ready (signing, versioning, production API config, R8/minification, ProGuard rules, a genuinely signed build). No business features were added, no backend logic was changed, and no new phase was started — this is release engineering only, on top of the app as it already existed.

---

## 1. What Was Already Present

The app itself needed no functional work — it was already implemented and tested:

- **Architecture:** native Kotlin/Jetpack Compose, MVVM (Repository → ViewModel → Compose screen), Retrofit + OkHttp + kotlinx.serialization for networking, `androidx.security:security-crypto` (Android Keystore-backed `EncryptedSharedPreferences`, AES-256-GCM) for the session token and session context.
- **Authentication / RBAC / branch context / dashboard / offline banner / session handling:** all implemented, with dedicated passing test files (`LoginViewModelTest`, `AuthRepositoryTest`, `ManagementSessionTest`, `SessionRepositoryTest`, `SessionLifecycleTest`, `SessionContextTest`, `ManageTest`, `BranchContextRepositoryTest`, `DashboardRepositoryTest`, `DashboardContractTest`, `HomeViewModelTest`, `HomeOfflineAndAlertsTest`, `ConnectivityStateTest`).
- **Security groundwork already correct before this task, and left unchanged:**
  - `AndroidManifest.xml`: `android:usesCleartextTraffic="false"`, `android:allowBackup="false"`, `android:fullBackupContent="false"`, and a `data_extraction_rules.xml` that excludes everything from Android 12+ cloud backup/device transfer.
  - A separate `debug`-source-set manifest override (cleartext + a `network_security_config_debug.xml` scoped to `10.0.2.2`/`localhost` only) that **never merges into a release build** — confirmed both by reading the file and, in this task, by dumping the built release manifest (§6).
  - `NetworkModule.kt` already gated its HTTP logging by `BuildConfig.DEBUG` (`Level.BASIC` in debug, `Level.NONE` in release) — no debug-only behavior needed disabling here; it already was.
- **Push notifications:** already honestly documented as **not real**. `DeviceIdProvider.kt`'s own comment states there is no Firebase Cloud Messaging project for this app; a stable per-install UUID is registered with the backend's mock push provider so the whole register → detect → notify → dedupe pipeline is real and tested end-to-end, with only the final OS-push hop mocked server-side. **Per the task's explicit instruction, this was not touched, not replaced, and no new notification system was built** — it is carried forward and documented again below as a V1 limitation.
- **What was missing (the actual gap this task closes):** no signing configuration anywhere in the Gradle files, `isMinifyEnabled = false` with `proguard-rules.pro` an empty placeholder, and `versionName = "1.0.0-phase1"`.

Toolchain confirmed present on this machine and used for every verification below: JDK 17 (Microsoft build), Android SDK with build-tools 34.0.0 and platform-tools (adb, apksigner, aapt2), Gradle 8.9 / AGP 8.5.2 / Kotlin 1.9.24.

---

## 2. What Was Changed

Three files modified, one new template file added, nothing else:

| File | Change |
|---|---|
| `android/app/build.gradle.kts` | Loads `android/keystore.properties` (git-ignored) if present; adds a `signingConfigs.release` from it; release `buildType` now sets `isMinifyEnabled = true`, `isShrinkResources = true`, and wires the signing config; `versionName` changed from `"1.0.0-phase1"` to `"1.0.0"`; a `gradle.taskGraph.whenReady` check refuses to run `assembleRelease`/`bundleRelease` unless a keystore is configured **and** a real (non-emulator) `-PapiBaseUrl` was supplied — debug builds, unit tests and lint are completely unaffected by this check. |
| `android/app/proguard-rules.pro` | Real R8 keep rules, replacing the empty placeholder: kotlinx.serialization's generated `$$serializer` companions for this app's own DTO package (`core.network.dto`) and Retrofit's reflected annotations (both would otherwise silently break network calls in a release build with no compile error), plus explicit keeps for `com.google.crypto.tink.**` (the crypto engine behind `EncryptedSharedPreferences`, historically the most likely R8 casualty since it registers ciphers by class name at runtime). |
| `.gitignore` | Added `android/keystore.properties` explicitly (`*.jks`/`*.keystore` were already covered from the earlier V1 stabilization pass). |
| `android/keystore.properties.example` *(new, committed)* | Template + the exact `keytool` command to generate a real keystore. |

`android/keystore.properties` and `android/release-keystore.jks` were also created **locally, for this task's verification only** — see §4. Neither is committed (confirmed via `git status` and `git check-ignore`).

No file under `backend/` was touched. No file under `android/app/src/main` (actual app source) was touched — the entire change is build configuration.

---

## 3. Release Configuration

- `applicationId`: `com.akvisionflow.owner` (unchanged)
- `minSdk` 26 / `targetSdk` 34 / `compileSdk` 34 (unchanged)
- **Production API URL:** unchanged architecture (a build-time Gradle property, `-PapiBaseUrl=...`, already existed for exactly this purpose) — what changed is that a release build can no longer be produced *without* explicitly passing a real one. This was verified as an actual, working refusal (§6), not just written and assumed.
- **Debug-only behavior:** already correctly isolated per-buildType before this task (cleartext HTTP, verbose HTTP logging) — reconfirmed unaffected by today's changes since only the `release` block was touched.
- **Minification / resource shrinking:** now **on** for release (`isMinifyEnabled = true`, `isShrinkResources = true`); was off before.

## 4. Signing Status

A signing mechanism now exists (Gradle `signingConfigs` reading `android/keystore.properties`), and it was exercised end-to-end: a real keystore was generated on this machine with `keytool` and a real signed release build was produced and verified (§6).

**This generated keystore is a verification identity, not vetted as AK VisionFlow's permanent production signing key.** Concretely:
- `android/release-keystore.jks` + `android/keystore.properties` exist only on this machine, are git-ignored, and were never committed or transmitted anywhere.
- Whoever holds the signing key that ends up on the Play Store controls every future update to that app listing forever — losing it means the app can never be updated under the same identity again. Before any real submission, the app's owner must decide to either: (a) keep this exact keystore and immediately move it and its passwords into a password manager / secrets vault with a backup, or (b) generate a fresh one (`android/keystore.properties.example` documents the exact command) and discard this one. Either is fine; leaving it as a plaintext file on a single development machine is not, for a real release.

## 5. Version Information

| Field | Value |
|---|---|
| `applicationId` | `com.akvisionflow.owner` |
| `versionCode` | `1` (unchanged — correct for a first release; must be incremented on every subsequent store upload) |
| `versionName` | `1.0.0` (changed from `1.0.0-phase1`) |
| `minSdk` / `targetSdk` / `compileSdk` | 26 / 34 / 34 |

## 6. APK/AAB Build Result

Both a signed, minified APK and a signed App Bundle were built successfully in this session:

```
BUILD SUCCESSFUL in 12m 43s
63 actionable tasks: 35 executed, 28 up-to-date
```

| Artifact | Path | Size |
|---|---|---|
| APK | `android/app/build/outputs/apk/release/app-release.apk` | 2,093,940 bytes (~2.0 MB) |
| AAB | `android/app/build/outputs/bundle/release/app-release.aab` | 4,682,489 bytes (~4.5 MB) |

Verified, not just assumed:
- **Signature is real:** `apksigner verify --verbose` → `Verifies`, `Verified using v2 scheme: true`, `Number of signers: 1`. Certificate: `CN=AK VisionFlow, OU=Owner App, ...`, SHA-256 digest `7e6165509c287a21c444ccffe8e26222af49c174f7807195bd18e5b6a5b73e4a`.
- **AAB signing** was performed and validated by AGP's own `validateSigningRelease` → `signReleaseBundle` tasks (both completed; the earlier negative test in this same session, §"guard verification" below, proves `validateSigningRelease` genuinely fails the build when signing is absent, so its success here is meaningful, not a no-op).
- **Release manifest correctness**, dumped from the actual built APK with `aapt2 dump xmltree`: `usesCleartextTraffic=false`; no `debuggable` attribute present at all (confirmed via `aapt2 dump badging`, which prints `application-debuggable` only when the flag is set — it did not appear); package/version fields (`com.akvisionflow.owner`, versionCode 1, versionName 1.0.0) match §5 exactly, read back from the built artifact itself.
- **Two safety guards were exercised as negative tests, not just written:**
  1. `./gradlew assembleRelease --offline` (no `-PapiBaseUrl`) → **refused**, with the intended error message about the emulator-loopback default.
  2. `./gradlew assembleRelease -PapiBaseUrl=https://erp.example.com/api/mobile/v1/ --offline` with `keystore.properties` temporarily renamed away → **refused**, with the intended "would be unsigned" error message, task `validateSigningRelease FAILED`.
  Only after both guards were proven to work was the real build produced.

## 7. Android Tests

Run fresh in this session (`./gradlew clean testDebugUnitTest lintDebug --offline`):

```
BUILD SUCCESSFUL in 8m 38s
36 actionable tasks: 36 executed
```

**110 / 110 tests passed, 0 failures, 0 errors, 0 skipped**, across 22 test files. This matches two independent runs performed earlier the same day in an unrelated audit session — three consistent runs total, no flakiness observed. Today's release-configuration changes (signing/minify/version, all scoped to the `release` build type) do not affect the `debug`-variant tests that this suite runs against, and that was confirmed by running them again after the changes, not assumed.

## 8. Lint Result

Both variants, both clean:
- `lintDebug` → `No issues found.`
- `lintRelease` (run as part of the release build) → `No issues found.`

## 9. R8/Minification Result

`minifyReleaseWithR8` and `shrinkReleaseRes`/`shrinkBundleReleaseResources` both ran and completed as part of the successful release build (§6). Evidence the new ProGuard rules are actually taking effect, not just present in a file:

- `app/build/outputs/mapping/release/mapping.txt` — 294,691 lines (real obfuscation/shrinking occurred; an unminified build has no such file).
- The app's own DTO classes (`com.akvisionflow.owner.core.network.dto.*`) are present in the mapping, unrenamed and unremoved — 2,713 matching lines.
- `com.google.crypto.tink` classes: 20,682 entries in `seeds.txt` (R8's own record of what an explicit `-keep` rule protected) confirm the Tink keep rule took hold; the handful of `com.google.crypto.tink.*` lines that do appear in `usage.txt` (R8's removed-code log) turn out, on inspection, to be trivial no-op static initializers (`<clinit>` with no code) — not the classes themselves, which remain present and unrenamed in `mapping.txt`. This is safe, expected dead-code elimination, not a rule failure.

## 10. Device-Test Result

**Not performed — and not claimed.** `adb devices` was run twice during this session (Android SDK platform-tools are present and the daemon started successfully both times); it returned an empty device list both times, and no emulator was running. Per the task's explicit instruction, no device or emulator test is reported as done. This remains the single biggest gap between "the build is genuinely signed, minified and correct" (verified) and "the app has been seen actually running" (not verified in this or any prior session for this project).

## 11. Remaining Limitations

1. **No real-device or emulator smoke test.** See §10.
2. **Push notifications are not real** (no Firebase/FCM project, mock device-token registration only) — unchanged by design, per instruction. The app and backend are both honest about this (no fake "delivered" state anywhere).
3. **The verification keystore is not vetted as the permanent production signing identity** — see §4's explicit decision the app's owner still needs to make before a real Play Store submission.
4. **No production backend exists to point a real release build at** (confirmed in the prior full-project audit, unchanged since) — today's `-PapiBaseUrl` guard makes it *impossible to forget*, but someone still has to supply a real, deployed URL when that day comes.
5. **Play Store submission assets** (store listing, screenshots, privacy policy, Data Safety form) are outside this task's scope (build/signing readiness, not store-listing readiness) and were not created.
6. **App icon is a simple placeholder vector graphic**, not a full adaptive-icon set — cosmetic, not a release blocker.
7. **`versionCode` stays at 1** for this first release build, as it should; it must be incremented by whoever cuts the next release.

## 12. Exact Commands Used For Verification

```bash
# Toolchain confirmation
java -version
D:\android-sdk\android-sdk\platform-tools\adb.exe devices

# Debug tests + lint (fresh, clean)
cd android
./gradlew.bat clean testDebugUnitTest lintDebug --offline

# Guard verification (both expected to fail, and did)
./gradlew.bat assembleRelease --offline
mv keystore.properties keystore.properties.bak
./gradlew.bat assembleRelease -PapiBaseUrl=https://erp.example.com/api/mobile/v1/ --offline
mv keystore.properties.bak keystore.properties

# Real signed release build (APK + AAB) + release lint
./gradlew.bat assembleRelease bundleRelease lintRelease \
  -PapiBaseUrl=https://erp.example.com/api/mobile/v1/ --offline

# Signature verification
D:\android-sdk\android-sdk\build-tools\34.0.0\apksigner.bat verify --verbose \
  android/app/build/outputs/apk/release/app-release.apk
D:\android-sdk\android-sdk\build-tools\34.0.0\apksigner.bat verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk

# Manifest / version / debuggable-flag verification on the built artifact itself
D:\android-sdk\android-sdk\build-tools\34.0.0\aapt2.exe dump badging \
  android/app/build/outputs/apk/release/app-release.apk
D:\android-sdk\android-sdk\build-tools\34.0.0\aapt2.exe dump xmltree \
  android/app/build/outputs/apk/release/app-release.apk --file AndroidManifest.xml

# R8 output inspection
grep -c "com.akvisionflow.owner.core.network.dto" android/app/build/outputs/mapping/release/mapping.txt
grep -c "com.google.crypto.tink" android/app/build/outputs/mapping/release/seeds.txt
```

Keystore used for this session's verification build (generated on this machine, not committed):
```
keytool -genkeypair -v -keystore release-keystore.jks -alias akvisionflow-owner \
  -keyalg RSA -keysize 2048 -validity 10950 \
  -dname "CN=AK VisionFlow, OU=Owner App, O=AK VisionFlow, L=Unspecified, ST=Unspecified, C=PK"
```

---

## Final Verdict

# ANDROID V1 — READY WITH CONDITIONS

The release engineering itself is genuinely done and verified: a proper Gradle-based signing mechanism exists and was proven to both work and to refuse an incomplete build; `versionCode`/`versionName` are set correctly for a first release; a release build can no longer silently point at the emulator; R8 minification and resource shrinking are on, with real, verified keep rules for every reflection-dependent library the app uses (networking, serialization, encryption); a signed APK and a signed AAB were both actually built and independently verified (signature, manifest, version, debuggable flag) rather than assumed. All 110 existing unit tests and both lint passes (debug and release) are clean.

The conditions are the honest limits of what could be done and verified without a deployed backend or a physical/emulated device on this machine: no real-device smoke test has ever been performed for this app; the exact signing keystore used to prove the mechanism today should be treated as provisional until the app's owner explicitly decides to keep and secure it (or replace it) before any real Play Store submission; and push notifications remain an intentionally-undelivered mock, unchanged, as instructed.

No further phase, feature, or fix has been started. Stopping here as directed.
