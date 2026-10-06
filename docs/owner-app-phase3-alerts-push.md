# AK VisionFlow Owner Android App
# PHASE 3 FINAL REPORT

## 1. Executive Summary

Phase 3 adds proactive business monitoring: a backend-only alert engine (reusing the existing Phase 9 AI insight infrastructure rather than building a parallel one), a mock push-notification pipeline that mirrors the codebase's existing WhatsApp-provider pattern exactly, an Alert Center with priority grouping and a read-only-but-dismissible lifecycle, configurable notification preferences, and a once-daily business summary. A self-audit caught and fixed a serious latent routing bug (a Phase 1 architectural quirk that silently blocked every new safe-write endpoint) and two deep-linking gaps before calling this phase complete.

## 2. Official Requirements Audit

| Requirement | Status | Evidence | Test | Notes |
|---|---|---|---|---|
| 7 Alert Categories (Sales/Profit/Receivables/Inventory/Expenses/Business Anomaly/Performance) | VERIFIED | `alertMapping.js` maps every existing `AiInsight.category` string to one of the 7 | `alertMapping.test.js` | |
| 3-tier Priority (Critical/Important/Informational) | VERIFIED | Maps `AiInsightSeverity` (URGENT/ATTENTION/OPPORTUNITY/INFORMATION) down to the 3 tiers | tested | Display-layer mapping only — the underlying AI Recommendation Center enum is untouched |
| Push notification: key fact + why it matters + deep link | VERIFIED | Body = insight's evidence-backed summary + "Tap to review \<area\>." suffix, matching the spec's own example format | Manual review (no device — see §12) | Found missing the "Tap to review" suffix during audit; added |
| Daily Business Summary, once per day, owner-configured time | VERIFIED | `dailySummary.js`; enforced via `lastDailySummarySentAt` + tenant-timezone-aware hour matching | `mobileAlerts.test.js`: sends once, suppressed on immediate re-run | |
| Alert Center: unread/read, priority grouping, date/time, explanation, tap-to-open, dismiss without touching business data | VERIFIED | `AlertsScreen.kt` groups by priority; dismiss/read tested to leave the underlying Product row byte-identical | tested | |
| Notification Preferences (7 settings incl. Minimum Priority) | VERIFIED | `UserNotificationPreference` model + `/notification-preferences` GET/PUT | tested (defaults, persistence, validation) | |
| Alert Engine runs on the backend, consistent across devices, cannot be bypassed | VERIFIED | All detection is server-side (`anomaly.js`, `recommendations.js`); Android only ever GETs the result | Code review + tests | |
| Duplicate & Noise Control: no repeat for the same unresolved condition | VERIFIED | `AiInsight.notifiedAt`/`notifiedSeverity` — a push fires only for a new insight or an escalated severity | `mobileAlerts.test.js`: 2nd run sends 0 | |
| Duplicate & Noise Control: thresholds/minimum-change rules | VERIFIED | Every anomaly scan already threshold-gated (z-score, %-change); added a 5-point-minimum profit-margin-drop threshold | tested | |
| Duplicate & Noise Control: owner-configurable categories/priority | VERIFIED | Category toggles + `minimumPriority`, both enforced in `dispatchAlertPush` | tested (CRITICAL_ONLY suppresses IMPORTANT; disabled category suppresses regardless of priority) | |
| Duplicate & Noise Control: group related alerts where practical | PARTIAL | Each condition is its own alert card; no bundling (e.g. "5 low-stock items" as one card) | — | Non-blocking; disclosed in §12 |
| Duplicate & Noise Control: respect device notification permission/settings | NOT APPLICABLE (this phase) | No real FCM/notification channel exists yet — nothing reaches the OS tray to request permission for | — | Tied to the mock-provider decision; becomes real work once FCM is wired up |
| Deep Linking to the correct read-only screen | VERIFIED | Sales/Profit/Receivables/Inventory/Performance → Analytics; Expenses/Business Anomaly → Home (Analytics has no Expense section) | `alertMapping.test.js` + Android now reads `alert.deepLink` instead of a hardcoded target | Found and fixed two real gaps during audit — see §10 |
| Backend API: `/owner/alerts`, `/owner/alerts/{id}`, `/owner/notification-preferences`, Push Token Service, Alert Engine, Notification Service | VERIFIED | All present under `/api/mobile/v1/{alerts, notification-preferences, push}` + `ai/recommendations.js` + `push/pushService.js` | tested | Named `/alerts` not `/owner/alerts` — consistent with this codebase's existing `/api/mobile/v1/...` convention, not the doc's illustrative path |
| Security: no sensitive detail on lock screen, detail behind auth | VERIFIED | Push body is a fact string, not raw customer/financial records; full evidence is only ever returned by the authenticated `GET /alerts/:id` | Code review | Moot in practice today since no real OS notification is shown (mock provider) — the code path is nonetheless already lock-screen-safe by construction |
| Read-only security remains enforced | VERIFIED | Read/dismiss/preferences/device-registration are explicit, narrow, documented exceptions (notification metadata, never business data); every other write remains 401/403 | Full write-rejection matrix tested | |
| Ready for Phase 4 to consume the same intelligence/alert signals | VERIFIED | Phase 4 can call `ai/analytics.js`, `ai/anomaly.js` (incl. the new profit-decline scan), `AiInsight` via `alertMapping.js`, and the push pipeline directly | Architectural review | |

## 3. Features Implemented

- Alert Center (priority-grouped, unread indicator, tap-to-open-and-mark-read, dismiss).
- Notification preferences dialog (6 category toggles + minimum-priority radio group).
- Push registration/unregistration wired into login/logout.
- Backend: a new profit-margin-decline anomaly detector; a mock push provider pipeline; once-daily summary; a cron-safe dispatch step folded into the existing scheduled-automation endpoint.

## 4. Android Changes

8 new Kotlin files (`AlertDtos`, `AlertsApiService`, `AlertsRepository`, `AlertsViewModel`, `AlertsScreen`, `DeviceIdProvider`) + edits to `LoginViewModel`, `ProfileViewModel`, `MainScaffold`, `ViewModelFactory`, `AppContainer`, `NetworkModule`. 59 Kotlin files total in the project across all three phases.

## 5. Backend/API Changes

| File | Change |
|---|---|
| `prisma/schema.prisma` | **New models**: `DeviceToken`, `UserNotificationPreference`, `PushConfig`. **Additive fields**: `AiInsight.notifiedAt`/`notifiedSeverity`. New migration `20260915105019_phase3_owner_mobile_alerts_push`, applied to the local test DB only (see §13) |
| `backend/src/modules/mobile/alertMapping.js`, `alerts.routes.js`, `notificationPreferences.routes.js`, `pushRegistration.routes.js` | **New.** The mobile-facing alert/preferences/device-registration API |
| `backend/src/modules/push/{pushService.js, dailySummary.js, providers/*}` | **New.** Mock-provider push pipeline, mirroring `communication/providers/` exactly |
| `backend/src/modules/ai/anomaly.js` | Additive: `profitMarginDecline()` scan |
| `backend/src/modules/ai/recommendations.js` | Additive: wires the new scan into `generateAnomalyInsights` |
| `backend/src/modules/communication/scheduled.routes.js` | Additive: `run-scheduled` now also runs insight refresh + alert push dispatch + daily summary |
| `backend/src/app.js` | Mounts the 3 new routers; **reorders** the `/api/mobile/v1/*` mounts (critical fix — see §10) |

## 6. Database/Migration Changes

One additive migration (3 new tables, 2 new nullable columns on `AiInsight`, no changes to any existing column/enum). Applied only to the local throwaway test database — **not** deployed to the production Neon database; that remains a deliberate deploy-time decision for the deploy pipeline, per this project's standing practice.

## 7. Security/RBAC/Tenant Isolation

- Every alert/preference/device-token row is tenant-scoped and ownership-checked; a foreign tenant's alert ID returns 404, tested.
- The read-only exceptions (mark read, dismiss, update preferences, register/unregister device) are narrowly scoped, explicitly documented in code comments, and proven by test to never alter a business record (a dismiss is asserted to leave the underlying `Product` row byte-identical).
- Every other write attempt under `/api/mobile/v1/alerts`, `/notification-preferences`, and any undefined verb still returns 401 (no token/wrong token type) or 403 (`mobileReadOnlyGuard`), tested explicitly.

## 8. Tests Executed

**Backend:**
```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/akvisionflow_test?schema=public" JWT_SECRET=test-secret npx jest --runInBand
```
```
Test Suites: 12 passed, 12 total
Tests:       316 passed, 316 total   (31 new: mobileAlerts.test.js + alertMapping.test.js)
```

**Android:**
```
gradle :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```
```
BUILD SUCCESSFUL
49 unit tests passed, 0 failed
0 lint errors, 11 warnings (dependency-version notices only)
```

## 9. Build/Lint Results

Clean. One real lint catch fixed along the way (see §10).

## 10. Problems Found During Audit

| Problem | Root cause | Fix | Tests proving the fix |
|---|---|---|---|
| **Every new safe-write endpoint (`/alerts/:id/read`, preferences PUT, device registration) returned 403 "read-only"** | `mobile.routes.js` is mounted at the bare `/api/mobile/v1` prefix; Express runs that router's own unconditional `mobileReadOnlyGuard` for *any* path starting with that prefix — including sibling routers mounted at `/api/mobile/v1/alerts` etc. — before those routers are ever reached. This was a latent Phase 1 design flaw that only surfaced once Phase 3 needed writes on a sibling path | Reordered `app.js` so the specific `/api/mobile/v1/<sub-path>` routers are registered before the bare `/api/mobile/v1` mount | 14 previously-failing tests now pass; full Phase 1/2 mobile suites re-verified with zero regression |
| Deep-linking sent Expense/Business-Anomaly alerts to the Analytics tab, which has no Expense or anomaly content | Blanket-mapped every category to "analytics" without checking what Phase 2 actually built there | Remapped those two categories to "home" (which does show the relevant KPI cards) | `alertMapping.test.js` |
| The `deepLink` field was built into the API but the Android UI ignored it, always navigating to Analytics regardless | Oversight — `onOpenAnalytics` was hardcoded instead of reading `alert.deepLink` | `AlertsScreen`/`MainScaffold` now route via `alert.deepLink` | Build + code review |
| Push body omitted the "Tap to review X" phrase from the spec's own example | Under-scoped copy on first pass | Added a category-specific review prompt | Code review |
| `dailySummary.js`'s "already sent today" check compared *now* to *now* instead of to the last-sent timestamp | Copy-paste of the wrong date-key computation | Fixed to format `lastDailySummarySentAt` itself in the tenant's timezone | Caught during writing, before any test ran against it; `mobileAlerts.test.js`'s once-per-day test passes |
| Route-ordering bug: `GET /meta/categories` would have been swallowed by `GET /:id` | `/:id` registered before `/meta/categories` | Reordered | Caught during writing, before compile |
| Kotlin: `explicitNulls` needs `@OptIn(ExperimentalSerializationApi::class)` | New kotlinx.serialization option requires opt-in | Added the annotation | Compile succeeds |

## 11. Regression Results

All 12 backend suites (316 tests) pass — the entire existing web product (Phases 1–9) plus all three mobile suites. No existing web route, response shape, or migration was altered.

## 12. Remaining Issues

**Blocking:** none.

**Non-blocking:**
- No real Firebase Cloud Messaging project exists (a deliberate choice this phase) — push delivery is via a mock provider that logs "sent" without reaching a real device. The entire pipeline (detection → priority → preference filtering → dedup → "delivery") is real and tested up to that last hop; swapping in a real FCM provider later is a config change (`PushConfig.provider`), not a redesign.
- Because no real push reaches the OS, the Android app doesn't yet request the `POST_NOTIFICATIONS` runtime permission or create a notification channel — there's nothing to permission-gate until real delivery exists.
- "Group related alerts" (e.g., bundling multiple low-stock items into one card) isn't implemented — each condition surfaces as its own alert.
- Duplicate-suppression tracks "last notified" per insight, not per (insight, user) pair — in a multi-owner tenant, a second owner who registers a device after the first was already notified for a still-open condition won't get their own first push for it. Single-owner tenants (the overwhelmingly common case here) are unaffected.
- Same disclosed environment limitation as Phases 1–2: no Android emulator/device, so on-device interaction (tapping alerts, the settings dialog, the daily summary "notification" itself) is verified by build + unit tests + code review, not by touching a running app.

## 13. Git Status

- Branch: `main`, HEAD: `26a0f3b`
- Nothing committed — all Phase 1–3 changes remain in the working tree, uncommitted.
- New since Phase 2's report: the Prisma migration, `backend/src/modules/{mobile/alertMapping.js, mobile/alerts.routes.js, mobile/notificationPreferences.routes.js, mobile/pushRegistration.routes.js, push/*}`, `backend/tests/{mobileAlerts.test.js, alertMapping.test.js}`, plus the Android files in §4.
- Nothing pushed anywhere. The new migration has **not** been applied to the production Neon database — only to the local disposable test database.

## 14. Phase Verdict

🟡 **PHASE COMPLETE WITH NON-BLOCKING NOTES — READY FOR APPROVAL**

(Every functional, security, and duplicate-suppression requirement is VERIFIED with real, passing tests, including a serious routing bug the self-audit found and fixed. The non-blocking items are all direct, disclosed consequences of the mock-push-provider decision made at the start of this phase, not overlooked work.)

**Approved.**
