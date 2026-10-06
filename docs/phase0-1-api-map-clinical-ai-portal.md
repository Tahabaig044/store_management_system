# Phase 0.1 — API & Business Logic Map: Clinical, Optical, AI, Portal, Communication, Mobile, Push

Scope: `backend/src/modules/{clinical,opticalOrders,portal,communication,ai,mobile,push}/*`.

This file consolidates four sub-audits (AI module; Mobile + Push; Communication; Clinical + Optical Orders) run in parallel during Phase 0.1. Each section below is a self-contained, evidence-based audit with file:line citations. A cross-cutting summary and the Odoo/QuickBooks-relevant observations feed the master Phase 0.1 Audit Report.

> Note: `backend/src/modules/portal/` (customer-facing OTP auth: `otpAuth.routes.js`, `portal.routes.js`, `portalAuth.js`) was in the original scope for this file but was not covered by any of the four sub-audits below (each sub-agent picked a different partition of the assigned modules and portal fell through the cracks). It was independently audited directly afterward — see §5.

---

## Cross-Cutting Summary

| Domain | Files audited | Critical | High | Medium | Low/Info | Industry classification |
|---|---|---|---|---|---|---|
| AI (`modules/ai/*`) | 13 | 0 | 0 | 0 | 2 | ~85% Universal/AI-Layer, ~15% Optical-specific (isolated) |
| Mobile + Push (`modules/mobile/*`, `modules/push/*`) | 13 | 0 | 0 | 0 | 2 | Universal/Platform (entire surface currently unmounted/unreachable) |
| Communication (`modules/communication/*`) | 8 | 0 | 0 | 3 | 3 | Universal/Platform engine; Optical-specific only in seed data/enums |
| Clinical + Optical Orders (`modules/clinical/*`, `modules/opticalOrders/*`) | 8 | 0 | 0 | 2 | 2 | 100% Optical/Medical Industry Module |
| Portal (`modules/portal/*`) | 3 | 0 | 0 | 0 | 3 | Universal Module (customer self-service portal pattern) |

No Critical or High severity findings were confirmed in any of the four audited domains — tenant isolation is consistently enforced via `findFirst({id, tenantId})`-style lookups across all of them. The recurring theme across this entire file's scope is **branch-scope gaps**, not tenant-scope gaps (see Medium findings under Communication and Clinical below), and a **structural/process finding**: the entire Mobile+Push surface is uncommitted and unmounted in production.

---

# 1. AI Module Audit (`backend/src/modules/ai/`)

Mount prefixes (confirmed in `backend/src/app.js:78-83,252-257`):

| File | Mounted at |
|---|---|
| `config.routes.js` | `/api/ai/config` |
| `assistant.routes.js` | `/api/ai/assistant` |
| `brief.routes.js` | `/api/ai/brief` |
| `forecasts.routes.js` | `/api/ai/forecasts` |
| `insights.routes.js` | `/api/ai/insights` |
| `usageReports.routes.js` | `/api/ai/usage` |

All six route files apply `router.use(authenticate, requireTenant, requireRole(...ROLE_GROUP))` before any handler (`assistant.routes.js:14`, `brief.routes.js:10`, `config.routes.js:19`, `forecasts.routes.js:11`, `insights.routes.js:17`, `usageReports.routes.js:16`) — no route in this module is reachable without a valid tenant-scoped JWT and role check.

## 1.1 Route tables

### `assistant.routes.js` → `/api/ai/assistant`

| Method | Route | Auth | Role | Tenant scope | Branch scope | Validation | R/M |
|---|---|---|---|---|---|---|---|
| GET | `/suggested-questions` | authenticate, requireTenant | MANAGEMENT | N/A (static constant) | N/A | none | Read |
| POST | `/ask` | authenticate, requireTenant | MANAGEMENT | `assistant.ask()` scopes every downstream query by `tenantId` (`assistant.js:15,18,24`); optional `branchId` verified `findFirst({id, tenantId})` (`assistant.routes.js:31`) | Verified belongs to tenant only | `askSchema` (zod) | Mutation |
| GET | `/conversations` | authenticate, requireTenant | MANAGEMENT | `findMany({tenantId, userId})` (`assistant.js:44`) | — | none | Read |
| GET | `/conversations/:id` | authenticate, requireTenant | MANAGEMENT | `findFirst({id, tenantId, userId})` (`assistant.js:48-49`) | — | none | Read |

### `brief.routes.js` → `/api/ai/brief`

| Method | Route | Auth | Role | Tenant scope | Branch scope | Validation | R/M |
|---|---|---|---|---|---|---|---|
| GET | `/` | authenticate, requireTenant | MANAGEMENT | `assertWithinQuota(tenantId)`; optional `branchId` verified `findFirst({id, tenantId})` (`brief.routes.js:16`) | Verified belongs to tenant only | none | Read (side-effect: upserts `AiInsight` via `refreshInsights`, `brief.js:17`) |

### `config.routes.js` → `/api/ai/config`

| Method | Route | Auth | Role | Tenant scope | Validation | R/M |
|---|---|---|---|---|---|---|
| GET | `/` | authenticate, requireTenant | TENANT_ADMIN_ONLY | `findUnique({tenantId})`/create (`usage.js:9-15`) | none | Read (credentials redacted) |
| PUT | `/` | authenticate, requireTenant | TENANT_ADMIN_ONLY | id derived from tenant-scoped lookup (`config.routes.js:37-38`) | `updateSchema` (zod) | Mutation |

### `forecasts.routes.js` → `/api/ai/forecasts`

| Method | Route | Auth | Role | Tenant scope | Branch scope | Validation | R/M |
|---|---|---|---|---|---|---|---|
| POST | `/generate` | authenticate, requireTenant | MANAGEMENT | `assertScopeOwnership` → `findFirst({id: scopeId, tenantId})` for BRANCH/CATEGORY/PRODUCT scope (`forecasts.routes.js:20-26`) | Verified when scope==='BRANCH' | `generateSchema` (zod) | Mutation |
| GET | `/` | authenticate, requireTenant | MANAGEMENT | `findMany({tenantId, ...optional scope/scopeId})` (`forecasts.routes.js:45-48`) | Not ownership-verified but `tenantId` AND-ed in, so worst case is empty result | none | Read |

### `insights.routes.js` → `/api/ai/insights`

| Method | Route | Auth | Role | Tenant scope | Validation | R/M |
|---|---|---|---|---|---|---|
| POST | `/refresh` | authenticate, requireTenant | MANAGEMENT | `refreshInsights(tenantId)` | none | Mutation |
| GET | `/` | authenticate, requireTenant | MANAGEMENT | `findMany({tenantId, status/type/severity})` | none | Read |
| POST | `/:id/acknowledge` | authenticate, requireTenant | MANAGEMENT | `findFirst({id, tenantId})` before update (`insights.routes.js:46`) | none | Mutation |
| POST | `/:id/dismiss` | authenticate, requireTenant | MANAGEMENT | same pattern | none | Mutation |
| POST | `/:id/feedback` | authenticate, requireTenant | MANAGEMENT | `findFirst({id, tenantId})` (`insights.routes.js:64`) | `feedbackSchema` (zod) | Mutation |

### `usageReports.routes.js` → `/api/ai/usage`

| Method | Route | Auth | Role | Tenant scope | Validation | R/M |
|---|---|---|---|---|---|---|
| GET | `/` | authenticate, requireTenant | TENANT_ADMIN_ONLY | `findMany({tenantId, createdAt range})` | none | Read |
| GET | `/most-used-questions` | authenticate, requireTenant | TENANT_ADMIN_ONLY | `findMany({tenantId})` incl. nested messages | none | Read |

**No `:id` route in this module lacks a tenant-scoped `findFirst` before use.**

## 1.2 Logic files — optical-vs-generic classification

- **`analytics.js`** — every function takes `tenantId` as mandatory first arg, every `where` AND's it in (file header explicitly documents this as "source of truth," `analytics.js:1-11`). Generic (lines 1-317): `salesTotals`, `salesComparison`, `branchProfitability`, `profitDeclineAnalysis`, `productMargins`, `supplierPriceChanges`, `lowStockRisk`, `slowMovingStock`, `expiryRisk`, `receivablesAging`, `payablesSummary`, `newVsReturningCustomers`, `inactiveCustomers`, `highValueCustomers`. **Hardcoded optical/clinic** (lines 318-375, under the file's own `// Optical / clinic intelligence` header): `delayedOpticalJobs` (322-342, queries `opticalOrder`), `labPerformance` (344-357, `opticalOrder`+`lab.name`), `appointmentNoShowTrend` (359-367, `appointment`), `examinationConversion` (369-375, `examination`+`opticalOrder.patientId`).
- **`anomaly.js`** — deterministic threshold scans, all tenant-scoped. Generic: `unusualDiscounts`, `abnormalReversals`, `unexpectedStockAdjustments`, `unusualExpenseSpikes`, `unexpectedSalesDecline`, `profitMarginDecline`, `suddenBranchChanges`, `potentialDuplicateSales`. Hardcoded optical: `unusualJobDelays` (158-165, `opticalOrder.count`).
- **`assistant.js`** — fully generic orchestrator (intent match → fact retrieval → provider call → persistence → usage log).
- **`brief.js`** — mostly generic (sales/cash/receivables/low-stock/expiry/purchase-approval aggregation), but calls `analytics.delayedOpticalJobs` (line 24), bakes `"${delayedJobs.length} optical job(s) are overdue."` into generated text (line 45), and hardcodes `links.opticalOrders: '/optical-orders'` (line 66) into the response payload.
- **`config.routes.js`, `usage.js`, `providers/provider.js`** — fully generic, no domain concepts.
- **`context.js`** — intent matcher, deliberately keyword/regex based (not LLM). Generic intents: `sales_comparison`, `branch_profitability`, `product_margin`, `receivables_overdue`, `low_stock_risk`, `slow_moving_stock`, `profit_decline`, `supplier_price_changes`, `daily_brief`. Hardcoded optical: `delayed_optical_jobs` intent + regex `/(optical|job)/` (line 28) + fact-builder (line 65); `SUGGESTED_QUESTIONS` shown to **every tenant** includes `"Show me pending optical jobs older than the expected delivery date."` (line 86).
- **`dailyBrief.js`** — generic caching wrapper, but caches `brief.js`'s optical-flavored payload.
- **`forecast.js`** — fully generic OLS trend + seasonality forecaster over `Sale`/`SaleItem`. No optical references anywhere. Good example of already-generic, schema-driven design.
- **`recommendations.js`** — generic: low-stock, receivables-overdue, slow-moving-stock, discount/reversal/adjustment/expense/sales-decline/branch/profit-decline anomalies. Hardcoded optical: delayed-optical-job recommendation (80-92, title/category/sourceType literally "optical"/"OpticalOrder") and job-delay anomaly block (172-179).
- **`trendInsight.js`** — fully generic sales-trend narrative.
- **`providers/deterministicProvider.js`** — mostly generic phrasing composer. Hardcoded optical: `delayed_optical_jobs` case (92-96) and, notably, **the default fallback shown to every tenant for any unrecognized question** (line 106): `"I can answer questions about sales, profit, inventory, receivables/payables, procurement, and optical/clinic operations. Try one of the suggested questions."` — a literal advertisement of clinic-specific capability baked into the assistant's core fallback UX text.
- **`providers/provider.js`** — fully generic registry/timeout/fallback abstraction.

## 1.3 Security Findings

No Critical or High findings. Zero use of `$queryRaw`/`$executeRaw` anywhere in this module (confirmed by grep); every by-id route uses the safe `findFirst({id, tenantId})` pattern.

- **Low — `analytics.js:313`**: `highValueCustomers()`'s final `prisma.customer.findMany({ where: { id: { in: top.map(...) } } })` has no `tenantId` filter on this specific call. Not currently exploitable — `top`'s customer IDs are pre-derived from a tenant-scoped `groupBy` one line earlier (306-309) — but flagged as a defense-in-depth gap should this function ever be reused with externally-supplied IDs.
- **Informational — branch scoping is "belongs to my tenant," not "belongs to my assigned branch"** across `assistant.routes.js:31`, `brief.routes.js:16`, `forecasts.routes.js:20-26`: a MANAGER assigned to Branch A can request AI insights/forecasts/briefs scoped to Branch B of the same tenant. Confirmed **not unique to AI** — the same pattern exists in `sales.routes.js:85`, `purchases.routes.js:199`, `expenses.routes.js:58`, `appointments.routes.js:135` — this is a pre-existing, app-wide design choice, not an AI-specific regression.
- **Informational** — unvalidated query-string inputs on `insights.routes.js` GET `/` and `usageReports.routes.js` GET `/` (no zod on `status`/`type`/`severity`/`from`/`to`) — Prisma's typed builder means malformed input throws rather than leaks data. Low-priority robustness item, not a security hole.

## 1.4 Overall judgment

The AI layer's **architecture** is already close to industry-agnostic: the deterministic facts core (`analytics.js`, `anomaly.js`, `forecast.js`) runs on generic `Sale`/`SaleItem`/`Product`/`Expense`/`Purchase`/`Customer`/`Branch` models; intent-matching, provider abstraction, and quota/usage/insight-storage machinery are all mechanism, not domain content. It is **not** fully generic yet: optical/clinic vocabulary is hardcoded in ~6 well-isolated seams — five analytics/anomaly functions on clinic-specific models, one bounded intent + one suggested question in `context.js`, literal clinic phrasing in `brief.js`'s summary/links and `recommendations.js`'s insight titles/categories, and — most user-visible — the deterministic provider's fallback message advertising "optical/clinic operations" to every tenant. Generalizing is a **moderate, well-scoped rework, not a rewrite**: extract the identified optical-specific functions behind a vertical/feature-flag boundary and make the handful of hardcoded UI-facing strings tenant/vertical-configurable.

**Key files for follow-up**: `analytics.js` (318-375), `anomaly.js` (158-165), `context.js` (28, 65, 86), `brief.js` (24, 45, 66), `recommendations.js` (80-92, 172-179), `providers/deterministicProvider.js` (92-96, 106).

---

# 2. Mobile + Push Audit (`backend/src/modules/mobile/`, `backend/src/modules/push/`)

## 2.1 Critical context — this entire surface is currently unreachable in production

- `git status --porcelain` shows `backend/src/modules/mobile/`, `backend/src/modules/push/`, `backend/src/middleware/mobileAuth.js` as `??` — **never committed**.
- `backend/src/app.js` (lines 84-90, 258-263) does **not** `require`/`app.use` any of the six mobile routers — an explicit comment states this is deliberate because the underlying migration hasn't been applied.
- `backend/prisma/schema.prisma` has **no** `DeviceToken`, `UserNotificationPreference`, or `PushConfig` models (grep: zero matches), and `AiInsight` lacks the `notifiedAt`/`notifiedSeverity`/`acknowledgedById`/`dismissedById` fields these modules reference.

**Practical effect**: none of these routes are reachable via the live API today; most handlers would throw at runtime if force-mounted (`prisma.deviceToken` doesn't exist). Findings below describe the code **as designed / as it will behave once mounted and migrated** — rated at the severity they'd carry once live, since this is clearly headed for activation, not abandonment. Mount prefixes below are **inferred** from file/router naming (`/api/mobile/v1/...`) since `app.js` has no mount lines to confirm against.

## 2.2 Route tables

### `mobile.routes.js` (base: `/api/mobile/v1`)

| Method | Route | Auth | Role | Tenant scope | Validation | R/W |
|---|---|---|---|---|---|---|
| GET | `/health` | none (public) | — | n/a | none | Read |
| POST | `/auth/login` | none (issues token) | TENANT_ADMIN only (inline check post password-verify) | tenant resolved via `user.tenantId`, `isActive` checked | `loginSchema` (zod) | Read + `lastLoginAt` write |
| POST | `/auth/logout` | `authenticateMobile` | TENANT_ADMIN (enforced in middleware) | n/a (audit log) | none | Mutation (audit log) |
| GET | `/profile` | `authenticateMobile` + `mobileReadOnlyGuard` | TENANT_ADMIN | `findUnique({id: req.user.id})` — safe, server-derived id | none | Read |

`authenticateMobile` hard-rejects any `role !== 'TENANT_ADMIN'` — every route in this module is implicitly TENANT_ADMIN-only, a stronger/narrower model than the staff `authenticate()`/`requireRole()` pair.

### `dashboard.routes.js` (base: `/api/mobile/v1/dashboard`, inferred)

All 7 routes (`/summary`, `/sales`, `/profit`, `/expenses`, `/receivables`, `/inventory`, `/filters`) are GET, `authenticateMobile+mobileReadOnlyGuard`, TENANT_ADMIN-only, and scope every query by `tenantId` via `dashboardService`. `branchId`/`categoryId` filters are verified via `assertFilterOwnership()` (`dashboardService.js:73-83`) before use — correctly prevents cross-tenant probing via filter params.

### `alerts.routes.js` (base: `/api/mobile/v1/alerts`, inferred)

`POST /:id/read`, `POST /:id/dismiss`, `GET /`, `GET /meta/categories`, `GET /:id` — all TENANT_ADMIN. Both mutating by-id routes use `loadOwnedInsight()` → `findFirst({id, tenantId})` (line 25) before update — safe pattern.

### `aiAdvisor.routes.js` (base: `/api/mobile/v1/advisor`, inferred)

`GET /home`, `/briefing`, `/needs-attention`, `/history`, `/insights/:id` — all TENANT_ADMIN, read-only, tenant-scoped; `/home` and `/briefing` additionally verify branch via `assertBranchOwnership()` (26-30).

### `notificationPreferences.routes.js`

`PUT /`, `GET /` — both keyed exclusively by `req.user.id` (server-derived), never a client-supplied identifier, so no cross-user read/write is structurally possible.

### `pushRegistration.routes.js`

`POST /register-device`, `POST /unregister-device` — both keyed by `req.user.tenantId`/`req.user.id`; `userId` always server-set on create/update. No IDOR vector via ID guessing.

## 2.3 Non-route logic files

- **`aiInsightMapping.js`** — pure display mapping (no I/O), converts shared `AiInsight` taxonomy into the mobile app's own 6-type vocabulary. Generic.
- **`alertMapping.js`** — pure function module (severity→priority, category mapping, deep-link resolution, notification-preference gating). One optical-domain leak: `CATEGORY_BY_RAW.optical → 'PERFORMANCE'`.
- **`dashboardService.js`** — every one of 7 exported functions takes `tenantId` as an explicit first arg, threaded into every Prisma call and into `modules/ai/analytics.js`; `assertFilterOwnership()` is the shared guard against cross-tenant branch/category probing. Business logic (revenue, profit, receivables aging, inventory value) is generic retail arithmetic; the only optical-flavored element is the `PRODUCT_TYPES` enum `['GENERAL','MEDICINE','FRAME','LENS']` used as a dashboard filter.
- **`push/pushService.js`** — `sendToUser(tenantId, userId, ...)` requires both as explicit where-clause filters; `usersWithActiveDevices`, `findInsightsNeedingPush`, `dispatchAlertPush` all tenant-scoped. No step crosses tenant/user identity.
- **`push/dailySummary.js`** — tenant-scoped, generic "daily business summary" concept, falls back from AI brief to plain KPI summary.
- **`push/providers/*`** — pure adapter/registry, no DB access.

## 2.4 Security Findings

**No Critical/High findings.** Every `:id` route resolves via `findFirst({id, tenantId})`; every device-token operation is keyed by server-derived `tenantId`+`userId`, never a client-supplied token-row ID; `notificationPreferences.routes.js` never accepts a client-supplied identifier at all.

- **M-1 (Low/Informational)** — `pushRegistration.routes.js:24-28`: upsert key is `tenantId_token` only (not `+userId`), so a shared device used to log in as two different TENANT_ADMIN accounts of the **same tenant** will silently reassign the push token's `userId` on the second login. Not cross-tenant, not an authorization bypass — a device-sharing UX edge case.
- **M-2 (Informational/Process)** — see §2.1: entire surface uncommitted/unmounted, referencing non-existent Prisma models. Recommend excluding this module from any "currently exposed attack surface" tally, while retaining this as the pre-activation review so it doesn't need a second full pass once wired up.

## 2.5 Industry classification

Overwhelmingly **Universal/Platform**: JWT-per-surface auth isolation, tenant-scoped KPI rollups, generic alert-severity/priority/category taxonomy, per-user notification preferences, pluggable push-provider abstraction mirroring the existing WhatsApp provider pattern. The only optical vocabulary found: `PRODUCT_TYPES` enum's `FRAME`/`LENS` values (`dashboardService.js`) and the `optical: 'PERFORMANCE'` mapping key (`alertMapping.js`).

---

# 3. Communication Module Audit (`backend/src/modules/communication/`)

## 3.1 Mount points (`backend/src/app.js`)

```
/api/communication/config           → config.routes.js        (line 243)
/api/communication/templates        → templates.routes.js     (line 244)
/api/communication/messages         → messages.routes.js      (line 245)
/api/communication/automation-rules → automationRules.routes.js (line 246)
/api/communication/reports          → reports.routes.js       (line 247)
/api/automation                     → scheduled.routes.js     (line 249 — different prefix)
```

`notifications.routes.js` is `require`'d at `app.js:73` but **never appears in any `app.use()` call** — see Finding below.

## 3.2 Route tables (condensed — see full detail in original sub-audit; role groups: `COMMUNICATION_STAFF`, `MANAGEMENT`, `TENANT_ADMIN_ONLY`, `FINANCE_STAFF`)

- **`automationRules.routes.js`**: GET `/`, PATCH `/:id`, DELETE `/:id`, GET `/:id/executions` — all tenant-scoped via `findFirst({id, tenantId})`; no `branchId` column on `AutomationRule`/`AutomationExecution` (N/A branch scope, schema fact).
- **`config.routes.js`**: GET/PUT `/` — TENANT_ADMIN_ONLY, singleton-per-tenant, correctly scoped.
- **`messages.routes.js`**: GET `/`, `/stats`, `/:id` apply/should-apply `branchScopeWhere()`; POST `/` (manual send), `/:id/retry`, `/webhook` — all tenant-scoped via `findFirst`. **`GET /stats` is missing `branchScopeWhere()`** while sibling routes have it.
- **`notifications.routes.js`**: GET `/`, `/unread-count`, PATCH `/:id/read`, POST `/mark-all-read` — self-scoped to `tenantId + userId`, correctly implemented, but **the router is never mounted** (see Finding, informational).
- **`reports.routes.js`**: 8 GET endpoints, all `where.tenantId` scoped; **6 of 8 are missing `branchScopeWhere()`** entirely (`/volume`, `/whatsapp-delivery`, `/appointment-reminders`, `/payment-reminders`, `/optical-order-notifications`, and `/branch-activity` which is deliberately cross-branch but under-gated — see Findings).
- **`scheduled.routes.js`** (mount: `/api/automation`, not `/api/communication/*`): POST `/run-scheduled` — TENANT_ADMIN_ONLY, every scan function explicitly `tenantId`-filtered. Code comment claims cross-tenant fan-out behavior that **is not actually implemented** — only `req.user.tenantId` is ever read, no `tenantId` query param exists. Stale comment, not a live security issue, but means the intended "one external cron call fans out to all tenants" design isn't built.
- **`templates.routes.js`**: GET `/`, POST `/`, PATCH `/:id`, POST `/:id/preview` — all correctly tenant-scoped.

## 3.3 Non-route logic files

- **`automation.js`** — the event-driven engine; `triggerEvent()` always takes explicit `tenantId`, never derives it from a nested object. Idempotency enforced via `AutomationExecution`'s `@@unique([tenantId, automationRuleId, sourceId])`. **Gap**: `branchId` is accepted only for `conditionsMatch()` (line 112) and never forwarded to `queueAndDispatch()` — root cause of Finding M-1 below.
- **`queue.js`** — `queueMessage()` never accepts/sets `branchId` at all, so `Message.branchId` is always `null`. `dispatchMessage(client, messageId)` uses a bare `findUnique({id})` with no tenant filter — safe today only because every call site pre-verifies tenant ownership before calling it; flagged as defense-in-depth gap (L-2).
- **`render.js`** — pure string substitution, no eval, no injection surface.
- **`providers/*`** — channel-agnostic registry + deterministic mock provider, no tenant data handling.

## 3.4 Security Findings

No Critical/High findings — no cross-tenant IDOR found on any `:id` route in this module.

- **M-1 (Medium)** — `queue.js:21-45`, `automation.js:106-141`: branch-scope enforcement on messages is a **no-op** because `Message.branchId` is never populated at write time. Fail-closed today (branch-restricted users see zero messages rather than wrong-branch messages), but defeats the intended feature and makes `/branch-activity`'s per-branch breakdown 100% "Unassigned."
- **M-2 (Medium)** — `reports.routes.js:21-129` vs `messages.routes.js:34,80`: inconsistent branch scoping over the same `Message` table — reports never apply `branchScopeWhere()`. **Once M-1 is fixed**, this becomes a real cross-branch information leak: a branch-restricted RECEPTIONIST/ACCOUNTANT would see tenant-wide message-volume/delivery/failure aggregates via reports, even though the raw message list is correctly branch-filtered.
- **M-3 (Medium)** — `reports.routes.js:132` `/branch-activity` (explicit cross-branch breakdown) is gated only by `COMMUNICATION_STAFF`, not `MANAGEMENT` — reachable by branch-restrictable RECEPTIONIST/ACCOUNTANT roles, letting a single-branch receptionist see all other branches' communication activity.
- **L-1 (Low)** — `messages.routes.js:27,149`: `/webhook` requires staff Bearer auth (inherited from router-level `requireRole`), making it unusable by any real external provider (contradicts its own code comment). Forward-looking note, not an access-control weakness as currently written.
- **L-2 (Low)** — `queue.js:52-53,34`: `dispatchMessage()` and the `customerCommunicationPreference` lookup take no tenant filter — safe today (all call sites pre-verify), but no compile/runtime signal enforces that for future callers.
- **Informational** — `notifications.routes.js` is required but never mounted in `app.js` — if unintentional, the entire in-app "bell" notification center is currently unreachable in production (handlers themselves are correctly scoped).

## 3.5 Industry classification

Architecturally a **generic, event-driven customer-communication engine** — nothing about the queue, render, provider abstraction, or route CRUD is optical-specific. The optical-specific surface is narrow and concentrated: seed data (`automation.js` `DEFAULT_TEMPLATES`/`DEFAULT_RULES`), fixed enum values in `schema.prisma` (`TemplateType`, `AutomationEvent` mixing generic and optical values), the `CLINICAL_TEMPLATE_TYPES` redaction set in `messages.routes.js`, and the optical-order grouping in `reports.routes.js`'s `/optical-order-notifications` and `scheduled.routes.js`'s `scanOpticalJobsDelayed`. Recommended split for a Universal/Platform extraction: keep the engine as-is; move only enum values, seed arrays, the clinical redaction set, and the optical-specific scan functions into a vertical config/plugin layer.

---

# 4. Clinical + Optical Orders Audit (`backend/src/modules/clinical/*`, `backend/src/modules/opticalOrders/*`)

## 4.1 Mount prefixes

| File | Mount |
|---|---|
| `clinical/patients.routes.js` | `/api/patients` |
| `clinical/doctors.routes.js` | `/api/doctors` |
| `clinical/appointments.routes.js` | `/api/appointments` |
| `clinical/examinations.routes.js` | `/api/examinations` |
| `clinical/clinicalPrescriptions.routes.js` | `/api/clinical-prescriptions` |
| `clinical/labs.routes.js` | `/api/labs` |
| `clinical/reports.routes.js` | `/api/clinical-reports` |
| `opticalOrders/opticalOrders.routes.js` | `/api/optical-orders` |

Role groups: `CLINICAL_STAFF = [TENANT_ADMIN, MANAGER, DOCTOR, RECEPTIONIST]`; `FRONT_DESK = [TENANT_ADMIN, MANAGER, RECEPTIONIST]`; `MANAGEMENT = [TENANT_ADMIN, MANAGER]`; `FINANCE_STAFF = [TENANT_ADMIN, MANAGER, ACCOUNTANT]`.

**Schema fact**: `OpticalOrder`, `Patient`, `Lab`, `Examination`, `ClinicalPrescription` have **no `branchId` column at all**. Only `Appointment` and `Doctor` do. "Branch scope N/A" below reflects this schema fact, not an audit oversight.

## 4.2 Route tables (condensed)

- **`appointments.routes.js`** — best-scoped file in the batch: every read/write is tenant- **and** branch-scoped (`branchScopeWhere` spread on reads, `assertBranchAccess()` on create).
- **`clinicalPrescriptions.routes.js`** — all tenant-scoped, no gaps; version chain (`supersedesId`) is patient+tenant verified before use.
- **`doctors.routes.js`** — base list/get/activity reads are **missing branch scoping** despite `Doctor` having a `branchId` column (create/update are MANAGEMENT-only so lower risk there; see Finding).
- **`examinations.routes.js`** — all tenant-scoped, no gaps (no `branchId` on model).
- **`labs.routes.js`** — all tenant-scoped, no gaps (no `branchId` on model).
- **`patients.routes.js`** — all tenant-scoped, no gaps; `/:id/360` is the richest PHI+financial aggregation endpoint (correctly audit-logged via `PATIENT_360_VIEW`).
- **`reports.routes.js`** — `/patient-visits` and `/appointments` **missing branch scoping** on a branch-bearing model (`Appointment`); `/pending-delayed-jobs`, `/optical-profitability`, `/branch-clinic-optical` reference a `branchId` field that **does not exist on `OpticalOrder`**, causing Prisma validation errors (broken for branch-restricted callers, or broken entirely for `/branch-clinic-optical`).
- **`opticalOrders.routes.js`** — all tenant-scoped, no gaps (no `branchId` on model). Note: `CASHIER` is excluded from `FRONT_DESK`, so cashiers can't record optical-order payments even though they handle payments elsewhere — a business-logic oddity, not a security bug.

## 4.3 Security Findings

**No Critical or High findings.** The Sept-11 cross-tenant-IDOR-on-foreign-key-payloads fix holds up under review here — every foreign key body payload (`patientId`, `doctorId`, `branchId`, `labId`, `examinationId`, `clinicalPrescriptionId`, `appointmentId`, `followUpOfId`, `supersedesId`, `duplicatePatientId`, `customerId`) is re-verified tenant-scoped before use.

- **Medium** — `clinical/reports.routes.js:23-45` (`/patient-visits`, `/appointments`): both query `Appointment` (which does carry `branchId` and is branch-scoped everywhere else) but omit `branchScopeWhere()`. A branch-restricted RECEPTIONIST/DOCTOR can see every branch's patient names, appointment times, and doctor assignments tenant-wide via these two report endpoints.
- **Medium** — `clinical/doctors.routes.js:24-31,33-40,80-108` (`GET /`, `GET /:id`, `GET /:id/activity`): `Doctor` has `branchId` but none of the three read routes apply branch scoping — `/:id/activity` in particular leaks a doctor's cross-branch appointment/examination/patient history to a branch-restricted caller.
- **Low/Correctness** — `clinical/reports.routes.js:60-66,78-88,149-172`: `branchScopeWhere`/`select` reference a `branchId` field that doesn't exist on `OpticalOrder` — `/branch-clinic-optical` throws for every caller (fully broken); `/pending-delayed-jobs` and `/optical-profitability` throw specifically for branch-restricted `ACCOUNTANT`/finance-staff callers (denial of availability, not confidentiality).
- **Informational** — `doctors.routes.js:49`, `patients.routes.js:82`: two by-field lookups (`findUnique({where:{userId}})`, `findUnique({where:{customerId}})`) have no `tenantId` filter of their own — safe today because callers pre-verify tenant ownership, but inconsistent with the "always filter by tenantId" pattern elsewhere; recommend adding `tenantId` defensively.

## 4.4 Industry classification

All 8 files are **100% Optical/Medical Industry Module** — no generic reuse candidates. `patients`/`doctors`/`examinations`/`clinicalPrescriptions` model core eye-care clinical data (OD/OS refraction values, visual acuity, versioned prescriptions) with no analog elsewhere in the ERP; `labs`/`opticalOrders` model the optical-lab job/frame/lens fulfillment workflow; `appointments`, while superficially generic scheduling, is implemented specifically around the clinic queue/token model; `reports.routes.js` is a set of purpose-built clinical/optical reports, not a generic report engine.

---

# 5. Portal Module Audit (`backend/src/modules/portal/`)

`otpAuth.routes.js` (105 lines), `portalAuth.js` (45 lines), `portal.routes.js` (168 lines) — the customer/patient-facing self-service portal, entirely separate from staff JWT auth.

## 5.1 Mount points

```
app.use('/api/portal/auth/request-otp', portalOtpLimiter)   (app.js:142 — rate limiter)
app.use('/api/portal/auth/verify-otp',  portalOtpLimiter)   (app.js:143 — rate limiter)
app.use('/api/portal/auth', portalOtpAuthRoutes)            (app.js:250)
app.use('/api/portal', portalRoutes)                        (app.js:251)
```

## 5.2 Authentication design

Login is OTP-over-WhatsApp, no password: `POST /api/portal/auth/request-otp` takes `{tenantId, phone}`, looks up an active `Customer` by `tenantId+phone`, and — regardless of whether a match was found — always returns the same generic message (`otpAuth.routes.js:19,67`) to avoid confirming which phone numbers are registered. `POST /api/portal/auth/verify-otp` takes `{tenantId, phone, code}`, re-resolves the customer, checks the most recent unconsumed/unexpired `CustomerPortalOtp` row, enforces `MAX_ATTEMPTS = 5` (`otpAuth.routes.js:18,85`), verifies the hashed code, and on success issues a `signPortalToken(account)` JWT carrying `typ: 'portal'`.

`portalAuth.js`'s `authenticatePortal` middleware is a **separate code path from the staff `authenticate()` middleware** by design (file header comment): it requires `payload.typ === 'portal'`, resolves to a `CustomerPortalAccount` (never a `User`), and re-checks both the account's and the tenant's `isActive` flag on every request. There is no code path by which a portal token can be accepted by a staff route or vice versa (staff `authenticate()` doesn't check `typ`, but portal tokens carry no `role`/staff claims a `requireRole()` check would accept).

Every route in `portal.routes.js` filters by **both** `req.portal.tenantId` and `req.portal.customerId`, taken only from the verified JWT — never from a path or body-supplied id (explicit file-header design comment, `portal.routes.js:1-5`, upheld consistently across all 11 routes). `GET /prescriptions/:id` goes further: it re-verifies the caller's own `Patient` link before trusting the prescription id, so a customer cannot view another patient's prescription within the same tenant even by guessing a valid id (`portal.routes.js:129-133,145-152`).

## 5.3 Security Findings

**No Critical or High findings.** This is one of the most carefully-scoped modules in the codebase — every data-returning route is filtered by server-derived `tenantId`+`customerId`, and the design intent is documented inline rather than left implicit.

- **Low — timing side-channel partially undermines the anti-enumeration design.** `otpAuth.routes.js:42-65`: `hashPassword(code)` (a deliberately slow bcrypt/argon-style hash) is only called inside the `if (customer)` branch. A request for a phone number that has no matching customer returns near-instantly, while a request for a registered number takes measurably longer (DB writes + password hashing) before the identical generic JSON response is sent. An attacker who scripts `request-otp` calls across many phone numbers could distinguish registered from unregistered numbers by response latency alone, despite the response body being intentionally identical. Recommend a dummy-cost delay (e.g. hash a constant string) on the not-found path to equalize timing.
- **Low/Informational — two write routes key by `req.portal.customerId` alone, without an explicit `tenantId` filter in that specific query.** `portal.routes.js:36-39` (`PATCH /me` → `customer.update({where:{id: req.portal.customerId}})`) and `portal.routes.js:159-163` (`PUT /communication-preferences` → `upsert({where:{customerId: req.portal.customerId}})`). Not exploitable — `req.portal.customerId` is server-derived from the verified JWT and was bound to its tenant at account-issue time, never client-supplied — but inconsistent with the "always filter by tenantId too" defense-in-depth pattern the same file uses everywhere else. Recommend adding `tenantId` to these two queries for consistency, not because of a live vulnerability.
- **Low — minor existence-enumeration via 403 vs 404 on `GET /prescriptions/:id`.** `portal.routes.js:145-151`: if the id belongs to a real prescription in the caller's own tenant but a different patient, the route returns `403 Forbidden` rather than `404 Not Found`, which technically confirms "a prescription with this ID exists in this tenant" (though never its content) to a caller who does not own it. Cosmetic; no PHI is disclosed.

No rate-limiting gap was found at the route level beyond what's already in place — `app.js:142-143` applies `portalOtpLimiter` to both OTP endpoints ahead of the router mount, and `MAX_ATTEMPTS = 5` bounds guesses against any single issued code.

## 5.4 Industry classification

**Universal Module**, not optical-specific as a pattern: OTP-over-messaging-channel login, a self-service profile/preferences view, and a "request a callback / request an appointment" notify-staff flow are all applicable to any customer-facing SMB vertical. Two routes reach into optical/clinic-specific data (`GET /optical-orders`, `GET /prescriptions`, `GET /prescriptions/:id`) and would need to become conditional on which industry modules a tenant has enabled, but the portal *engine* itself (OTP auth, account model, tenant+customer scoping middleware) is industry-agnostic and could serve any vertical's customer portal unchanged.
