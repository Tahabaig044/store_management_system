# Phase 8 — WhatsApp Integration, Business Automation & Customer Portal

## Overview

Phase 8 adds three connected capabilities to AK VisionFlow:

1. **Provider-agnostic WhatsApp messaging** — a message queue with idempotent dedup, opt-out enforcement, and exponential-backoff retry, dispatched through a swappable provider abstraction (a zero-network **mock provider** ships by default; a real WhatsApp Business API provider can be added later without changing any calling code).
2. **Business event automation** — a rule engine (`AutomationRule` / `AutomationExecution`) that reacts to business events (sale completed, optical order created/ready/delivered, appointment booked/no-show, purchase approved, stock transfer completed, and more) by sending a WhatsApp message and/or raising an internal staff notification, with per-tenant configurability and duplicate-proof execution.
3. **Customer Portal** — a separate, OTP-authenticated self-service surface where a customer can view their own orders, invoices, appointments, prescriptions, and outstanding balance, request an appointment or callback, and manage their WhatsApp opt-out — all strictly scoped to their own records.

## Data Model

| Model | Purpose |
|---|---|
| `CommunicationConfig` | Per-tenant WhatsApp provider settings (provider name, credentials, business hours, campaign cap). `credentials` is never returned by the API — only a `hasCredentials` boolean. |
| `MessageTemplate` | Reusable message bodies with `{{placeholder}}` variables, one of 15 `TemplateType`s. System-seeded templates cannot be deactivated. |
| `Message` | Every outbound communication: channel, status lifecycle (`QUEUED → SENT/FAILED → DELIVERED → READ`), retry bookkeeping, and links back to the customer, template, automation rule, and source business event. |
| `AutomationRule` | Tenant-configurable trigger: event → action (WhatsApp message or internal notification), with an optional delay and JSON conditions (e.g. `minAmount`, `branchId`). |
| `AutomationExecution` | One row per (rule, event, sourceId) — its unique constraint is what makes every automation idempotent. |
| `Notification` | Internal in-app alerts, scoped per staff user. |
| `CustomerCommunicationPreference` | Per-customer WhatsApp/promotional opt-out. |
| `CustomerPortalAccount` / `CustomerPortalOtp` | Portal identity and OTP login state — entirely separate from the staff `User` table. |

All new tables are additive; no existing table lost a column, and Phase 4–7 migrations are untouched.

## Messaging Pipeline

`queueMessage()` creates a `Message` row (or returns the existing one if the same `idempotencyKey` was already used — the same pattern as every other idempotent write in this codebase). `dispatchMessage()` calls the configured provider; on failure it applies exponential backoff (`min(2^retryCount, 60)` minutes) up to 5 attempts before marking the message permanently `FAILED`. `queueAndDispatch()` does both in one call — the path every automation and manual send uses. A permanently `FAILED` message can be manually retried by MANAGEMENT via `POST /api/communication/messages/:id/retry`, which resets `retryCount` to 0 so the retry gets a genuinely fresh set of attempts rather than immediately re-failing.

The **mock provider** (`providers/mockProvider.js`) makes no network calls and always succeeds, except for the reserved sentinel phone number `FAIL_TEST`, which deterministically fails — this is how the test suite exercises retry/backoff behavior without any external dependency. Swapping in a real provider is a matter of adding a new module to `providers/` and registering it in `providers/provider.js`; no other code changes.

## Automation Engine

`triggerEvent(client, { tenantId, event, sourceId, customer, variables, ... })` is the single entry point every business route calls, always **after** its own database transaction has committed. It is wrapped so that nothing inside it — a bad template, a provider outage, a database hiccup — can ever throw back into the caller; failures are logged and recorded on the `AutomationExecution` row, never surfaced as a failed sale/order/appointment. Because Vercel serverless functions can freeze immediately after a response is sent, these calls are `await`ed rather than left as detached fire-and-forget promises, while still running strictly after the business transaction's data is already durable.

Idempotency is enforced by `AutomationExecution`'s `@@unique([tenantId, automationRuleId, sourceId])` constraint: a second attempt to fire the same rule for the same source record (a retried request, an offline sale re-synced twice, a scheduler firing twice) hits a Prisma `P2002` and is silently skipped rather than sending a duplicate message.

15 default rules are lazily seeded per tenant on first use (`ensureDefaultAutomations`), covering both WhatsApp-message and internal-notification action types. `SALE_COMPLETED` ships **disabled** by default — a receipt on every single POS sale is spammy for a busy shop — every other rule ships enabled. Rules are fully tenant-configurable: any rule can be disabled, its delay changed, or its template swapped; system-seeded rules cannot be deleted, only disabled.

### Wired trigger points

| Event | Route | Trigger point |
|---|---|---|
| `SALE_COMPLETED` | `sales.routes.js` | After sale transaction commits |
| `OPTICAL_ORDER_CREATED` | `opticalOrders.routes.js` | After order creation |
| `OPTICAL_JOB_READY` / `OPTICAL_ORDER_DELIVERED` | `opticalOrders.routes.js` | On status change to `READY` / `DELIVERED` |
| `APPOINTMENT_BOOKED` | `appointments.routes.js` | After appointment creation |
| `APPOINTMENT_NO_SHOW` | `appointments.routes.js` | On status change to `NO_SHOW` |
| `PURCHASE_APPROVED` | `purchaseOrders.routes.js` | On explicit `/approve` |
| `TRANSFER_COMPLETED` | `stockTransfers.routes.js` | On `/receive` |

### Scheduled automations

Vercel's serverless model has no persistent in-process timer, so time-based automations (appointment reminders, overdue invoices, delayed jobs, expiring stock, inactive customers, the daily close summary) are exposed as an on-demand endpoint, **`POST /api/automation/run-scheduled`** (TENANT_ADMIN only), meant to be invoked periodically by an external scheduler (e.g. Vercel Cron). Every scan uses a deterministic, per-day or per-record synthetic `sourceId` (e.g. `appt-reminder:<id>:<date>`, `daily-close:<date>`) so a scheduler firing twice — or being replayed — can never produce duplicate messages; this relies on the same `AutomationExecution` unique constraint as every other event.

## Customer Portal

Portal authentication is **fully separate** from staff authentication:

- Login is OTP-over-WhatsApp against a phone number already on file (`POST /api/portal/auth/request-otp`, `POST /api/portal/auth/verify-otp`) — no password. Responses are deliberately generic about whether a phone number matches a customer, to avoid enumeration.
- Portal JWTs carry a `typ: 'portal'` claim. The staff `authenticate` middleware explicitly rejects any token with that claim, and the portal's own `authenticatePortal` middleware rejects any token without it — a leaked or reused token from one surface can never be presented to the other.
- Every portal endpoint resolves the customer from the **verified token** (`req.portal.customerId` / `req.portal.tenantId`) — never from a path or body parameter — so one customer can never read or act on another customer's records, even in the same tenant. Prescription access is further re-verified against the customer's own `Patient` link before returning a record.
- Self-service "request an appointment" and "request a callback" never create real `Appointment` rows directly — they raise an internal `Notification` for front-desk staff, who create the actual record after confirming availability.
- Portal activity is written to the existing `AuditLog` table with `userId: null` and `metadata: { customerId, portalEvent: true }` — no schema change was needed; `logAudit()` was extended to fall back to `req.portal.tenantId` when `req.user` isn't present.
- The OTP endpoints share the same rate limiter pattern as staff login (20 requests / 15 minutes) since they are equally exposed to guessing/spam.

## Frontend

- **Communication Center** (`/communication`) — unified message history with filters, per-tenant stats, manual send (MANAGEMENT only), and retry for failed messages.
- **Automation Rules** (`/automation-rules`) — enable/disable and adjust delay for every rule; visible to `COMMUNICATION_STAFF`, editable by `MANAGEMENT` only.
- **Notification bell** — added to the shared staff header, polling unread count every 30s, with a dropdown to view and mark notifications read.
- **Customer Portal** (`/portal/login`, `/portal`) — a deliberately separate mini-app: its own axios instance and token storage key (`akvf_portal_token`, never mixed with the staff `akvf_token`), its own `PortalAuthContext`, and its own shell (not nested under the staff `Layout`/`ProtectedRoute`). Reached via a tenant-specific link (`/portal/login?tenant=<tenantId>`) since this deployment has no per-tenant subdomain.

## Testing

`backend/tests/communication.test.js` (31 tests) covers: RBAC across every new route, manual send + idempotency, the `FAIL_TEST` sentinel's deterministic failure/backoff/permanent-failure/retry lifecycle, template and automation-rule management (including system-record protection), tenant isolation for messages and automation rules, every wired business-event trigger (including the offline-retry-triggers-once case and the ships-disabled-by-default case for `SALE_COMPLETED`), opt-out enforcement, clinical-content redaction, the full OTP login flow (generic responses, wrong code, reuse prevention), portal-vs-staff token cross-rejection, portal ownership isolation between two customers in the same tenant, communication reports, Command Center integration, and the scheduled-scan endpoint's per-day idempotency. All 230 backend tests (199 pre-existing + 31 new) pass together. Frontend adds 9 new component tests (Communication Center, Automation Rules, Notification bell) against the existing 48, for 57 passing.

## Known Limitations / Follow-ups

- The mock provider is the only messaging provider wired up; a real WhatsApp Business API integration requires adding a provider module and tenant-supplied credentials, but no application code changes.
- `POST /api/automation/run-scheduled` must be invoked by an external scheduler in production (e.g. Vercel Cron) — nothing calls it automatically yet.
- Frontend pages were verified via `vite build`, `oxlint`, and component tests with real interaction assertions; no live-browser click-through was performed as part of this phase (no browser automation tool was available in this environment).
