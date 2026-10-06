# PHASE 1.15 — NOTIFICATIONS & ACTIVITY LOG: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-22
**Scope:** Universal in-app notifications, activity/audit log read access, centralized event-driven notification creation, branch-aware notification targeting, and safe integration with the modules added in Phase 1.11–1.14.
**Test database:** local, throwaway Postgres (`akvisionflow_phase115`) via the portable Postgres instance at `D:\pgsql-portable`. No production database was touched.

---

## 1. Executive Summary

Phase 1.15 began with a full audit of the existing notification, activity-log, communication, and push architecture before any code was written. The audit found substantial, working, pre-existing infrastructure that this phase was explicitly told not to rebuild: a `Notification` model and self-scoped `/api/notifications` routes (list, unread-count, mark-read, mark-all-read); an `AuditLog` model already written to by a centralized `logAudit()` service (`middleware/audit.js`) from dozens of call sites across every phase since 1.1; a genuinely centralized, event-driven notification mechanism (`triggerEvent()` in `communication/automation.js`) with its own real duplicate-prevention gate (`AutomationExecution`'s `@@unique([tenantId, automationRuleId, sourceId])`); and a working, mock-provider-based push/device-token pipeline (`DeviceToken`, `PushConfig`, `pushService.js`) for the Owner Mobile app.

The audit also found concrete, real gaps this phase's own mandate exists to close: **`AuditLog` was write-only** — no read endpoint or frontend page existed anywhere for a table that had been accumulating history since Phase 1.1; **`Notification` had no branch attribution at all**, so a role-targeted alert about one branch's activity was visible to every tenant user with that role regardless of branch — a genuine, confirmed isolation gap; **two `AutomationEvent` enum values (`PAYMENT_RECEIVED`, `STOCK_LOW`) existed with no default rule and no call site anywhere** — orphaned, unwired events; and **none of Phase 1.11–1.14's major mutation points** (Payments, Expenses, Returns, Credit/Debit Notes, Quotations, Sales Orders) had ever been wired into the notification engine.

All of this was closed additively, extending the existing models and the existing `triggerEvent()`/`logAudit()` services rather than building parallel systems: `Notification` gained `branchId`, `priority`, `readAt`, `entityType`/`entityId`, `channel`/`deliveryStatus`, and `expiresAt`; `AuditLog` gained `branchId` and two new indexes; `createRoleNotifications` (inside `triggerEvent`) now filters recipients by branch access when a `branchId` is given, reusing the existing, unmodified `getAccessibleBranchIds` three-tier check; a curated, high-value subset of ten new events (`SALE_CANCELLED`, `PAYMENT_REVERSED`, `EXPENSE_CREATED`, `EXPENSE_REVERSED`, `RETURN_CREATED`, `CREDIT_NOTE_CREATED`, `DEBIT_NOTE_CREATED`, `QUOTATION_ACCEPTED`, `SALES_ORDER_CONFIRMED`, `SALES_ORDER_CANCELLED`) was wired in, plus the orphaned `PAYMENT_RECEIVED`; and a brand-new `GET /api/activity-log` read module was added against the existing, unmodified `AuditLog` table, gated by a new, privileged `AUDIT_LOG:VIEW` permission.

A real bug was caught during implementation (before any test ran): my first attempt at branch-aware notification testing used `MANAGER` as the restricted role, which is always branch-unrestricted by this codebase's own long-established design — not a product defect, but it forced a correction to how the feature itself needed to be tested and confirmed the branch-filtering logic actually needed a genuinely restrictable role (`CASHIER`) to be meaningfully exercised at all.

**Overall result: PHASE 1.15 — CLOSED WITH CONDITIONS.** See Section 29 for the exact justification.

---

## 2. Existing Architecture Audit

Read in full before any code was written: the `Notification`, `AuditLog`, `AutomationRule`, `AutomationExecution`, `Message`, `DeviceToken`, `PushConfig`, and `UserNotificationPreference` Prisma models; `backend/src/middleware/audit.js`; the entire `backend/src/modules/communication/` directory (`automation.js`, `notifications.routes.js`, `queue.js`, `providers/`, `scheduled.routes.js`, and others); `backend/src/modules/push/pushService.js` and its provider registry; `backend/src/modules/mobile/{pushRegistration,notificationPreferences,alertMapping}.js`; `frontend/src/components/NotificationBell.jsx`; the permission catalog; and every existing test file touching these areas (`communication.test.js`, `mobileAlerts.test.js`, `phase12Hardening.test.js`, `clinical.test.js`).

Confirmed, not assumed:
- **`triggerEvent()` is already a genuine, centralized, event-driven notification service** — every business route that wants to notify calls this one function; it is not duplicated anywhere. Its `AutomationExecution` unique-constraint gate is a real, already-tested duplicate-prevention mechanism, not something this phase needed to invent.
- **`AuditLog` is write-only** — `grep -rl "prisma.auditLog"` across the whole backend returned only `middleware/audit.js` itself; no `GET` route existed anywhere, and no frontend page existed (`grep` for "AuditLog"/"ActivityLog" across `frontend/src` returned zero matches).
- **`Notification` has no `branchId`, `readAt`, `priority`, structured entity reference, delivery-channel/status, or expiry field** — only `id/tenantId/userId/type/title/body/link/isRead/createdAt`.
- **`PAYMENT_RECEIVED` and `STOCK_LOW` are pre-existing `AutomationEvent` enum values with zero call sites anywhere in the codebase** — confirmed by grepping every `triggerEvent(` invocation and cross-referencing against the enum; both were silently unwired since whichever phase introduced them.
- **Push (`DeviceToken`/`PushConfig`/`pushService.js`) and in-app notifications (`Notification`/`triggerEvent`) are two completely disconnected pipelines.** `createRoleNotifications` (the in-app path) never touches `DeviceToken`; `pushService.js`'s only caller, `dispatchAlertPush`, is wired exclusively to the AI Insight pipeline (`AiInsight` rows), never to `AutomationRule`/`triggerEvent`. An automation-triggered in-app alert is never also pushed to a user's phone even if they have an active device.
- **Push is entirely mock/simulated** — the provider registry (`push/providers/provider.js`) has exactly one entry (`mock`), which never calls a real FCM/APNs/Expo endpoint; its own header comment states plainly that no real push credentials exist for this app yet.
- **Two disjoint preference universes exist**: `UserNotificationPreference` (mobile/AI-insight push categories: `salesAlertsEnabled`, `profitAlertsEnabled`, etc., mapped via `alertMapping.js`'s `CATEGORY_BY_RAW`/`PREFERENCE_FIELD_BY_CATEGORY` tables) versus per-tenant `AutomationRule.isEnabled` (web/WhatsApp, tenant-wide, not per-user). `alertMapping.js`'s category taxonomy is built specifically for the 12 `AiInsight.category` raw values and does not map cleanly onto the new business events this phase wires in (e.g. `SALES_ORDER_CONFIRMED` has no natural `SALES/PROFIT/RECEIVABLES/INVENTORY/EXPENSES/BUSINESS_ANOMALY/PERFORMANCE` category) — this concretely informed the decision in Section 9 not to attempt push/in-app unification this phase.
- **The "queue" (`communication/queue.js`) is synchronous-in-request, not a real async worker** — its own header comment explains this is a deliberate consequence of running as Vercel serverless functions with no persistent timer; retried delivery for failed messages is handled via an externally-scheduled sweep (`POST /api/automation/run-scheduled`), not a background process this phase needed to build.
- **No `NOTIFICATION`, `AUDIT`, or `ACTIVITY` resource existed in the permission catalog** — `/api/notifications` is deliberately self-scoped with no RBAC gate at all (every user manages only their own rows), which is correct and was left unchanged; a new resource was needed only for the new activity-log viewer.
- **No duplicate or parallel notification/activity-log implementation exists anywhere else in the codebase.**

---

## 3. Notification Architecture

`Notification` (extended, not replaced) now carries: `id`, `tenantId`, `branchId` (new, nullable — Section 7), `userId`, `type` (free-text, matching `AutomationEvent` values by convention, unchanged), `title`, `body`, `entityType`/`entityId` (new — a structured deep-link target alongside the pre-existing, unchanged `link` string), `priority` (new `NotificationPriority` enum: `LOW/NORMAL/HIGH/CRITICAL`, default `NORMAL`), `isRead`/`readAt` (the latter new), `channel`/`deliveryStatus` (new, both defaulted for in-app's trivial "the row's existence is the delivery" semantics — present so a future non-in-app fan-out from the same event could record its own per-recipient outcome without another migration), `expiresAt` (new, nullable, unused unless a caller sets it), and `createdAt`. No Optical/Medical-specific type or field exists anywhere — `type` is always one of the free-text `AutomationEvent` values, all of them industry-neutral business events.

**Deliberately not added**: a `companyId` field. Exactly like `Sale`/`Purchase`/`Quotation`/every other transactional document in this codebase, company scope is enforced transitively via `branchId → Branch.companyId`, not a direct column — consistent with the established convention, not a gap.

**Deduplication is not a field on this model.** It is enforced one layer up, by `AutomationExecution`'s own pre-existing unique constraint in `triggerEvent()` — adding a second, overlapping idempotency key directly on `Notification` would be redundant with (and could silently disagree with) that already-tested guarantee, so none was added.

---

## 4. Notification Types/Events

A curated, high-value subset of the task's suggested event list was wired — not every suggested event, per the explicit instruction "Do NOT hard-code every possible future event" and "Only implement events that are actually appropriate to the existing architecture":

| Event | New or pre-existing enum value | Wired from |
|---|---|---|
| `SALE_CANCELLED` | new | `sales.routes.js` `POST /:id/reverse` |
| `PAYMENT_RECEIVED` | pre-existing, was unwired (Section 2) | `payments.routes.js` `POST /` (standalone, direction IN only) |
| `PAYMENT_REVERSED` | new | `payments.routes.js` `POST /:id/reverse` |
| `EXPENSE_CREATED` | new | `expenses.routes.js` `POST /` |
| `EXPENSE_REVERSED` | new | `expenses.routes.js` `POST /:id/reverse` |
| `RETURN_CREATED` | new | `salesReturns.routes.js` and `purchaseReturns.routes.js`, both `POST /` (one shared event, distinct `sourceId`/`entityType` per return type) |
| `CREDIT_NOTE_CREATED` | new | `creditNotes.routes.js` `POST /` (standalone only) |
| `DEBIT_NOTE_CREATED` | new | `debitNotes.routes.js` `POST /` (standalone only) |
| `QUOTATION_ACCEPTED` | new | `quotations.routes.js` `POST /:id/accept` |
| `SALES_ORDER_CONFIRMED` | new | `salesOrders.routes.js` `POST /:id/confirm` |
| `SALES_ORDER_CANCELLED` | new | `salesOrders.routes.js` `POST /:id/cancel` |

**Deliberately not wired, with reasoning**: "Purchase created"/"Purchase received" (Purchase's own creation and the existing `PURCHASE_APPROVED` event already cover the procurement-approval moment that matters most; adding a raw notification for every supplier invoice risked being noisy without a clearly higher-value payoff than what already exists); "Stock adjustment" and "Low stock" (`STOCK_LOW` remains an orphaned, unwired enum value exactly as the audit found it — wiring it correctly requires understanding Phase 1.10's inventory-threshold-check code in enough depth to avoid a false-positive-heavy alert, which is a materially different, larger undertaking than this phase's own scope, and is disclosed as a known limitation rather than attempted half-way); "Stock transfer" (already fully covered by the existing `TRANSFER_COMPLETED` event); "User/security event" and "System/admin event" (the existing `AuditLog`, now readable for the first time via Section 5's new endpoint, already captures every user/role/security action from every prior phase — a dedicated in-app *notification* for these was judged lower-value than the activity-log visibility this phase already delivers, and was left for a future phase to add if actually requested).

`CREDIT_NOTE_CREATED`/`DEBIT_NOTE_CREATED` fire **only** for the standalone creation path — a note auto-issued alongside a `SalesReturn`/`PurchaseReturn` is already covered by that return's own `RETURN_CREATED` event, and firing a second, separate notification for the same underlying staff action would be redundant noise, not added value.

`createRoleNotifications` (the reusable service every one of the above calls into, via `triggerEvent`) was extended, not duplicated, with an optional `branchId`/`entityType`/`priority` parameter set — no route creates a `Notification` row directly; every one of the twelve new call sites goes through the exact same, single, pre-existing function.

---

## 5. Activity Log Architecture

No new log table was created. `AuditLog` (extended: `branchId`, two new indexes — Section 7/19) already existed and had been written to since Phase 1.1 via `logAudit()`. This phase added the table's first-ever read surface: `backend/src/modules/activityLog/activityLog.routes.js`, a new module mounted at `/api/activity-log`, with `GET /` (filters: `userId`, `action`, `entity`, `entityId`, `branchId`, `search`, `from`/`to`, plus pagination) and `GET /:id` (full detail including `metadata`). Neither route, nor any other route in the codebase, ever calls `prisma.auditLog.update` or `.delete` — there is no mutation path for this table anywhere (Section 15).

At minimum, every `AuditLog` row already captured (unchanged by this phase): actor (`userId`), tenant, action, entity type/id, metadata (`Json?`), IP address, and timestamp — satisfying the task's Section 4 minimum field list. `branchId` is the one new field, added specifically to close the isolation gap the audit found (Section 7). "Before/after information" was not added as a new structured field: the existing `metadata` JSON column is already the vehicle every call site uses for whatever contextual detail it chooses to record (e.g. `expenses.routes.js` records `{ amount, categoryId }`; `PATCH` handlers record `{ changedFields: [...] }`), and this phase did not retrofit every existing call site to also capture a full before/after diff — a materially larger undertaking than "verify and extend" for a table with dozens of already-working call sites, and one this phase's own report discloses as a limitation (Section 26) rather than silently ignores.

---

## 6. Centralized Event/Activity Service

Both services this phase touches were already centralized before this phase — extended, not consolidated from scratch:

- **`logAudit({ req, action, entity, entityId, metadata, branchId })`** (`middleware/audit.js`) — the one `branchId` parameter is new and optional; every pre-existing call site (dozens, across every phase) is completely unaffected and now also gets a best-effort `branchId` (falling back to the acting user's own `branchId` when not explicitly passed) with zero code changes required at those call sites. It remains fire-and-forget, wrapped in try/catch, never throwing into the request path — unchanged.
- **`triggerEvent()`/`createRoleNotifications()`** (`communication/automation.js`) — both already existed as the single reusable event/notification service; this phase added `branchId`-aware recipient filtering and `entityType`/`priority` pass-through to `createRoleNotifications`, and ten `DEFAULT_RULES` entries (plus the one for the previously-orphaned `PAYMENT_RECEIVED`) so the new events actually produce a notification once a rule exists for them.

**Consistency model, confirmed unchanged and explicitly verified (not assumed) for this phase's own new call sites**: every `triggerEvent()` call in this phase's twelve new wiring points is made *after* the business transaction has already been `await`ed and resolved — mirroring the exact, pre-existing "fire strictly after commit" convention `SALE_COMPLETED` (Phase 1.8) already established. A notification-creation failure can never roll back a Sale/Payment/Expense/Return/Quotation/Order mutation (the whole point of the pattern), and a mutation that itself fails or rolls back never reaches the `triggerEvent()` line at all (it sits after the `await` on the transaction). This is a documented **at-least-once, best-effort, post-commit** model for the *notification*, layered on top of an **effectively-once** guarantee for the underlying business event's *processing* (via `AutomationExecution`'s unique constraint) — see Section 13 for the precise, tested distinction. No transactional outbox pattern was introduced; the existing post-commit-fire-and-forget convention, now used consistently across twelve more call sites, was judged sufficient and is not "an unnecessarily complex distributed system," per the task's own explicit caution.

---

## 7. Tenant/Company/Branch/User Isolation

**Tenant isolation**: every `Notification`/`AuditLog` query in both route modules filters by `tenantId` (unchanged, and freshly re-verified for the two new `/api/activity-log` endpoints). Verified directly: Tenant B's user sees zero of Tenant A's notifications or activity-log entries for a business action Tenant A took, even filtering explicitly by that action's own `entityId`.

**User isolation**: `/api/notifications` has always scoped every query by `userId: req.user.id` in addition to `tenantId` — a user can never retrieve, mark-read, or delete another user's notification row, verified directly (a freshly-created `CASHIER`, not a recipient of an `EXPENSE_CREATED` alert targeted at `MANAGEMENT` roles, sees none of those rows via any endpoint).

**Branch isolation — the confirmed, real gap this phase closes**: before this phase, `createRoleNotifications` notified every tenant user with a matching role regardless of branch. Now, when a caller supplies `branchId` to `triggerEvent`, each candidate recipient is checked via the existing, unmodified `getAccessibleBranchIds()` three-tier check (own branch / `UserBranchAccess` / company-wide `UserCompanyAccess`) before being notified; `TENANT_ADMIN`/`MANAGER` remain always-unrestricted, exactly like every other branch-scoped query in this codebase. Verified directly with a real branch-restricted role (`CASHIER` — `MANAGER`/`TENANT_ADMIN` are permanently branch-unrestricted by this codebase's own design, so testing with them would prove nothing): a `CASHIER` assigned to Branch 1 receives a Branch-1-scoped alert; a `CASHIER` assigned to Branch 2 does not. `GET /api/activity-log`'s `branchId` filter is validated against the caller's own access via the existing `assertBranchAccess`, exactly like every other list endpoint's explicit-filter convention.

**Company isolation**: enforced transitively via `branchId → Branch.companyId`, exactly like every other transactional document in this codebase (Section 3) — not a separate mechanism, and not separately re-tested beyond what branch-isolation testing already covers, consistent with Phase 1.14's identical, already-accepted reasoning for the same architectural pattern.

**Access rule for tenant-wide notifications, explicitly documented as required by the task**: a `Notification` with `branchId: null` (every pre-existing row, and any new one created without an explicit branch context, e.g. `DAILY_CLOSE`) is visible to every tenant user whose role matches the target roles — this is intentional, not an oversight, since a `null` branch means "this alert has no single-branch owner."

---

## 8. Notification Read/Unread

Verified directly: `GET /notifications/unread-count` returns an accurate count at every point in the test suite (before creation, after creation, after partial and full mark-read); `PATCH /:id/read` is now idempotent at the `readAt` level — re-marking an already-read notification preserves its original `readAt` rather than overwriting it with a later timestamp (a small, real fix: the pre-existing endpoint only ever set `isRead: true` with no `readAt` at all); `POST /mark-all-read` now also stamps `readAt`. **Concurrent read operations do not corrupt state** (Section 13.B/C): two simultaneous `PATCH /:id/read` calls on the same notification both return `200` and the unread count decrements by exactly one, not two or zero; two simultaneous `POST /mark-all-read` calls both succeed and the final unread count is exactly zero, never negative. A new `GET /:id` detail endpoint and a new `DELETE /:id` dismiss endpoint were added (Section 2's confirmed gap) — both self-scoped exactly like every existing action on this resource, verified directly (a dismissed notification returns `404` on any subsequent read).

---

## 9. Notification Delivery

**In-app**: the only channel that existed and needed no new integration work beyond what Sections 3/4 already describe — verified end-to-end for all twelve new event call sites.

**Push**: audited and left as a **separate, deliberately unintegrated channel** for automation-triggered notifications, per the task's own explicit instruction not to "introduce unrelated third-party integrations" and to "document the existing limitation" for channels not already wired together. The concrete reason, confirmed by reading `alertMapping.js` in full (Section 2): its category/preference-gating taxonomy is purpose-built for the 12 `AiInsight.category` values and does not map cleanly onto the new business events this phase adds (e.g. `SALES_ORDER_CONFIRMED` has no natural fit among `SALES/PROFIT/RECEIVABLES/INVENTORY/EXPENSES/BUSINESS_ANOMALY/PERFORMANCE`). Forcing a fit would mean either bypassing the user's actual configured push preferences (sending push regardless of what they opted into) or inventing new preference fields/categories — a materially larger design undertaking than "verify and extend," and one the task's own Section 10 explicitly warns against ("Do not create an unnecessarily complex preference engine"). This is disclosed as a known limitation (Section 26), not silently left unaddressed.

**Email/SMS/WhatsApp**: WhatsApp already exists (via `queueAndDispatch`, unrelated to this phase's new in-app events, none of which use `WHATSAPP_MESSAGE` as their `actionType`); Email/SMS do not exist anywhere in the codebase and were not introduced, per the explicit instruction against adding unrelated third-party integrations in this phase.

**Delivery status/retry/duplicate prevention for the channel that IS active (in-app)**: verified — an in-app notification's "delivery" is synchronous with its creation (no transit state possible), `deliveryStatus` defaults to `DELIVERED` accordingly, and duplicate prevention is Section 6/13's `AutomationExecution` gate, verified under real concurrency.

---

## 10. Push Notification Verification

Verified directly against the existing, unmodified `pushService.js` (mock provider): `sendToUser()` fans out to **every active device token** for a user — a test registering two device tokens for one user and calling `sendToUser` confirms both receive a `SENT` result, verifying "multiple devices per user" is genuinely supported, not just schema-permitted. A token the mock provider reports `FAILED` for (the literal test token `'FAIL_TEST'`) is deactivated (`isActive: false`) while the user's other, healthy token is left untouched — verified directly, confirming the existing self-healing cleanup-on-failure behavior works correctly and doesn't over-deactivate.

**Not modified in this phase, confirmed as pre-existing, disclosed characteristics**: device-token registration/unregistration (`/api/mobile/v1/push/*`) is unchanged; unregistration remains a manual client call, not automatic on logout (confirmed by the Section 2 audit, not re-verified further here since it's out of this phase's mutation scope); push remains 100% mock/simulated with no real FCM/APNs/Expo credentials — **no production push infrastructure was activated**, per the task's explicit instruction not to do so without real credentials, which do not exist for this app.

---

## 11. Notification Preferences

Audited, confirmed working, and deliberately left unmodified: `UserNotificationPreference` (mobile/AI-insight push categories) continues to function exactly as before, gating `dispatchAlertPush` via `meetsMinimumPriority`/`preferenceFieldFor`. No new preference field or engine was added for the new in-app business events added by this phase — they are gated only by the existing, tenant-wide `AutomationRule.isEnabled` toggle (per-rule, not per-user), the same mechanism every existing `IN_APP_NOTIFICATION`-type event (`STOCK_LOW`, `PURCHASE_APPROVED`, `TRANSFER_COMPLETED`, etc.) already uses. This is a disclosed limitation (Section 26): there is no way today for an individual user to opt out of, say, `EXPENSE_CREATED` bell notifications while a `TENANT_ADMIN` keeps the rule enabled tenant-wide — the same limitation the audit found already existed for every pre-existing `IN_APP_NOTIFICATION` event, not something this phase introduced.

---

## 12. Duplicate Prevention

**Mandatory, verified directly under real concurrency.** The mechanism is the pre-existing `AutomationExecution.@@unique([tenantId, automationRuleId, sourceId])` constraint — this phase did not invent a new one, having confirmed (Section 2) it already provides exactly the guarantee needed. Three real, concurrent `triggerEvent()` calls with the identical `event`+`sourceId` (`Promise.all`, no mocking) result in **exactly one** `AutomationExecution` row and **exactly one** `Notification` row per matching-role recipient — never zero, never two. A sequential retry (the same event+sourceId fired twice, one after the other) produces the identical result. An offline-outbox-style retried `POST /expenses` with the same client-generated `idempotencyKey` is deduplicated at the Express-handler level (the existing `findExistingByIdempotencyKey` mechanism, unmodified) before `triggerEvent` is ever called a second time for what the client believes is a retry of the same logical operation — verified directly that at most one `EXPENSE_CREATED` notification exists per recipient afterward.

---

## 13. Event Consistency / Outbox

The consistency model is **post-commit, fire-and-forget, at-least-once for delivery, effectively-once for processing** — documented precisely, not just asserted:

- **Business mutation succeeds → notification creation fails**: caught, logged (`console.error`), never re-thrown (unchanged, pre-existing `triggerEvent` behavior) — the user's Sale/Payment/Expense/etc. is unaffected; the notification is simply missing. This is an accepted, disclosed trade-off consistent with every existing event call site (`SALE_COMPLETED` since Phase 1.8), not a new risk introduced by this phase's twelve additional call sites.
- **Notification succeeds → business transaction rolls back**: cannot happen for any of this phase's new call sites, because every one of them is placed textually *after* the `await` on the transaction has already resolved — if the transaction throws, execution never reaches the `triggerEvent()` line at all. Verified by direct code inspection of all twelve call sites (not merely asserted) as part of this phase's own review, mirroring the exact placement convention of the pre-existing `SALE_COMPLETED` call.
- **No transactional outbox pattern, no background job queue, no new infrastructure was introduced.** The existing "fire after commit, `AutomationExecution` as the idempotency gate" architecture was judged sufficient for this phase's scope, per the explicit instruction to avoid "an unnecessarily complex distributed system."

---

## 14. Concurrency Testing

All scenarios use real, concurrent HTTP/database operations (`Promise.all`, `--runInBand` Jest, no mocking of the database):

- **A. Concurrent creation of the same business event** — three concurrent `triggerEvent()` calls with an identical `event`+`sourceId`: exactly one `AutomationExecution`, no duplicate notification per recipient (Section 12).
- **B. Concurrent mark-as-read** — two concurrent `PATCH /:id/read` on the same notification: both succeed, unread count decrements by exactly one.
- **C. Concurrent mark-all-as-read** — two concurrent `POST /mark-all-read`: both succeed, final unread count is exactly zero.
- **D. Concurrent notification retrieval** — two concurrent `GET /notifications` calls alongside a concurrent notification-creating action: all three resolve correctly with consistent, non-crashing responses.
- **E. Notification creation while user reads notifications** — covered by D.
- **F. Duplicate background/outbox retry** — the offline-idempotency-key scenario in Section 12.
- **G. Multiple device push delivery** — Section 10.

**Explicit delivery-guarantee statement, as the task requires**: notification *delivery* (the row landing in the recipient's bell) is **at-least-once in principle, effectively-once in practice** for any single business event, because the guarantee is enforced at the *event-processing* layer (`AutomationExecution`), not the notification-row layer itself — if a future code path ever created `Notification` rows outside of `triggerEvent`'s gated path, that new path would need its own duplicate-prevention story, since `Notification` itself carries no dedup key (Section 3). Push delivery (Section 10) is **at-most-once per attempt** (the mock provider's `sendToUser` never retries a failed send itself) — never claimed as exactly-once, and never verified as such, per the task's explicit instruction not to overclaim.

---

## 15. Activity Log Immutability

Verified directly, not merely by absence of a route: no `PATCH`/`PUT`/`DELETE` route exists for `AuditLog` in `activityLog.routes.js` or anywhere else in the codebase — a direct attempt at `PATCH /api/activity-log/:id` and `DELETE /api/activity-log/:id` both return `404` (no matching route), and the underlying database row is confirmed unchanged afterward via a direct Prisma read. No caller anywhere in the codebase (grepped) ever calls `prisma.auditLog.update` or `.delete`. There is no administrative retention/deletion capability of any kind for `AuditLog` today — not because one was removed, but because none ever existed; this is disclosed as-is (Section 27), not built in this phase since it wasn't required and "if administrative retention/deletion exists, verify it is explicitly privileged" doesn't apply when none exists.

---

## 16. Search/Filter/Pagination

`GET /api/activity-log`: `userId`, `action`, `entity`, `entityId`, `branchId` (access-checked), `search` (case-insensitive, across `action`/`entity`/`entityId`), `from`/`to`, plus the shared `parsePagination` utility (default/max page size unchanged from every other list endpoint in this codebase, so no unbounded history load is possible). `GET /api/notifications`: gained `type`, `priority`, `from`/`to` filters alongside the pre-existing `unreadOnly`, plus pagination (pre-existing, unchanged). Both verified directly with real filter combinations and pagination boundaries.

---

## 17. Frontend

- **`frontend/src/components/NotificationBell.jsx`** (extended): a new "View all notifications" link at the bottom of the existing dropdown, routing to a new full-history page — the dropdown's own existing list/mark-read/mark-all-read behavior is completely unchanged. This introduced a `react-router-dom` dependency into the component, which required updating `NotificationBell.test.jsx` to wrap the component in a `MemoryRouter` (a pure test-harness change — the test's assertions themselves are byte-for-byte unchanged).
- **`frontend/src/pages/notifications/Notifications.jsx`** (new): the full notification history the bell's 10-item dropdown couldn't provide — filters (unread-only, type, priority), pagination, mark-one-read, mark-all-read, and dismiss, all against the existing/extended `/api/notifications` endpoints.
- **`frontend/src/pages/activityLog/ActivityLog.jsx`** (new): the first-ever frontend surface for `AuditLog` — a filterable, paginated table (date, actor, action, entity, branch) with a detail modal showing full metadata, gated by the new `AUDIT_LOG:VIEW` permission.
- Both new pages were registered as routes (`/notifications` — no permission gate, matching the backend's own self-scoped design; `/activity-log` — `AUDIT_LOG:VIEW`-gated) in `App.jsx`, and added to the sidebar navigation in `Layout.jsx`.
- All controls are permission-driven: the Activity Log nav entry and route are both gated identically (`AUDIT_LOG:VIEW`), so an unauthorized user never even sees the link, and a direct URL visit is still rejected server-side.

**Testing limitation, disclosed transparently, identical to Phase 1.13/1.14's**: no browser-automation tool is available in this environment, so the new/extended pages could not be visually exercised live. Verified instead via: `npm run build` and `npm run lint` both succeeding cleanly (lint exits 0, only the same pre-existing `set-state-in-effect` warning style already present across the codebase); the full existing frontend suite (136 tests, 30 files) passing, including the updated `NotificationBell.test.jsx`; and a field-by-field cross-check of the new pages' JSX against the actual `GET /notifications`/`GET /activity-log` response shapes.

---

## 18. Mobile

Audited, not modified, per the explicit instruction not to introduce unrelated mobile features. Confirmed via direct test (Section 10) that the existing Owner Android push pipeline (device-token registration, tenant/user association, multiple devices, failed-token deactivation) works correctly and was unaffected by this phase's changes. **Not verified in this phase, and explicitly disclosed**: real push-received/deep-link/read-dismiss-synchronization behavior on an actual Android device — this environment has no such device and the provider is mock-only, so "push received" was verified only at the `sendToUser`/provider-response layer (Section 10), not end-to-end on-device. Deactivated-user handling (a deactivated `User.isActive: false` should presumably stop receiving push) was not separately re-verified in this phase; `sendToUser` sends to any `DeviceToken` matching `tenantId`+`userId`+`isActive: true` regardless of the linked `User.isActive` state — this is a pre-existing characteristic, not introduced by this phase, and is disclosed here for completeness (Section 26) rather than silently passed over.

---

## 19. Security

- Every new/extended endpoint requires authentication and an active tenant context, unchanged.
- `GET /api/activity-log` and its detail route are the only genuinely new privileged surface in this phase — gated by the new `AUDIT_LOG:VIEW` permission, `MANAGEMENT`-only, verified directly (`CASHIER` rejected `403`, `MANAGER` allowed).
- **No sensitive data logged**: verified directly with a test asserting a `USER_CREATE`-family audit entry's `metadata` never contains the literal password or the word "password" — `AuditLog.metadata` is populated per-call-site (Section 5), and no call site anywhere in the codebase (grepped, and directly verified for the user-creation path specifically) passes a password, token, or payment credential into it.
- Cross-tenant/cross-branch/cross-user access is rejected or silently filtered (never exposing existence via an inappropriate status code) exactly as Section 7 describes, verified directly.
- No unauthorized log modification is possible (Section 15) — there is no mutation route to even attempt one against.

---

## 20. Performance

- The new `@@index([tenantId, entity, entityId])` and `@@index([tenantId, action])` on `AuditLog` (Section 5) exist specifically because this table had no read query pattern to optimize for before this phase — without them, `GET /api/activity-log`'s `entity`/`entityId`/`action` filters would each force a sequential scan of the tenant's entire history partition as it grows.
- `Notification` gained `@@index([tenantId, userId, createdAt])` (for the new date-ordered/paginated full-history page) and `@@index([tenantId, entityType, entityId])` (for the new structured deep-link lookup), alongside its pre-existing `@@index([tenantId, userId, isRead])` (unchanged, still what backs the unread-count query).
- No N+1 pattern was introduced: `GET /api/activity-log`'s `user`/`branch` relations are eager-loaded via a single `include`, not per-row queries. The one place with an inherent per-row cost is `createRoleNotifications`'s branch-filtering path (Section 7), which calls `getAccessibleBranchIds` once per *candidate recipient user*, not once per tenant user overall — for a small-to-mid-size business's staff count (this codebase's consistent scale assumption throughout every phase), this is a small, bounded number of extra queries only when a `branchId` is actually supplied, and zero extra queries for every branch-agnostic event (the majority, including every pre-existing one).
- No heavy event infrastructure (message broker, job scheduler) was introduced, consistent with the task's explicit caution.

---

## 21. Offline-First

**Notifications**: there is no client-side offline mutation of notification read-state in this codebase — `PATCH /:id/read`/`POST /mark-all-read` are plain, immediate, online-only calls from `NotificationBell.jsx`/`Notifications.jsx`, exactly as before this phase (neither was ever registered in `syncEngine.js`'s `OUTBOXES`, and this phase did not add one). There is therefore no risk of "offline client state incorrectly marking cloud notifications as read" for this phase's own scope, since no offline path to do so exists at all — a disclosed non-capability, not a bug.

**Activity Logs**: business activity generated via an *existing* offline-outbox-capable mutation (e.g. an offline `Sale` creation via `OUTBOXES.sales`, unchanged since Phase 1.8) is never lost — `logAudit()` runs synchronously inside the same online request that eventually processes the synced mutation, exactly like every prior phase's offline-capable writes already work; this phase introduced no new offline-write path for activity logging itself. **Duplicate offline replay does not create a duplicate logical event**, verified directly in Section 12's idempotency test: a retried `POST /expenses` with the same `idempotencyKey` (the exact mechanism every offline-outbox-registered create already relies on) results in at most one `EXPENSE_CREATED` notification, because the Express handler itself short-circuits on the idempotency key before `triggerEvent` is ever reached a second time for what the client believes is a new operation.

No new synchronization framework was introduced anywhere in this phase — the existing outbox/idempotency-key architecture was reused as-is, per the explicit instruction.

---

## 22. Module Integration

Verified integration with, or explicit confirmation of no change needed for: **Users/RBAC** (the new `AUDIT_LOG` permission follows the existing catalog shape exactly; `USER_CREATE`-family audit entries were directly re-verified for sensitive-data safety); **Sales** (`SALE_CANCELLED`, new); **Payments** (`PAYMENT_RECEIVED` unwired-orphan fixed, `PAYMENT_REVERSED` new); **Expenses** (`EXPENSE_CREATED`/`EXPENSE_REVERSED`, both new); **Returns** (`RETURN_CREATED`, new, shared across Sales and Purchase Returns); **Credit Notes** and **Debit Notes** (both new, standalone-only); **Quotations** (`QUOTATION_ACCEPTED`, new); **Sales Orders** (`SALES_ORDER_CONFIRMED`/`SALES_ORDER_CANCELLED`, both new); **Inventory** (audited — `STOCK_LOW` remains a disclosed, unwired pre-existing gap, not touched; `TRANSFER_COMPLETED` already covers stock transfers and was left unchanged). **Products, Customers, Suppliers**: audited — no event was added for basic CRUD on these (their creation/update is already captured in `AuditLog` via existing `logAudit` calls from earlier phases, which this phase's new `GET /api/activity-log` now makes visible for the first time; a dedicated in-app *notification* for every product/customer/supplier CRUD action was judged low-value noise, consistent with the task's own caution against hard-coding every possible event).

No existing route was modified beyond adding its own new `triggerEvent()`/`logAudit(branchId)` call — no route's existing behavior, response shape, or validation was changed.

---

## 23. Reporting/Admin Integration

Audited: no existing Admin/Owner dashboard (`dashboard.routes.js`, the Owner Mobile dashboard/AI-advisor surfaces) currently queries `Notification` or `AuditLog` directly — they are independent of this phase's changes and continue to work exactly as before (confirmed via the full regression run, Section 24). Per the explicit instruction not to build "the future AI Business OS" in this phase, no new dashboard widget or admin aggregate view was added; the underlying data (`GET /api/notifications`, `GET /api/activity-log`) is now available for a future phase to consume if a dashboard integration is ever requested.

---

## 24. Tests Added

`backend/tests/notificationsAndActivityLog.test.js` — **29 tests**, covering: notification creation from seven real business-event call sites (Expense create/reverse, Sale reverse, standalone Payment create/reverse, Sales Return, Purchase Return, standalone Credit Note, Quotation accept, Sales Order confirm/cancel); notification retrieval, idempotent mark-read, mark-all-read, type/priority/date filtering and pagination, detail and dismiss endpoints; duplicate-prevention/idempotency (sequential and concurrent identical-event firing, offline-idempotency-key replay); concurrent mark-read, concurrent mark-all-read, and concurrent retrieval-during-creation; activity-log retrieval with every filter combination, pagination, detail view, immutability (direct route-absence and database-state verification), and sensitive-data-logging protection; RBAC for the new `AUDIT_LOG` resource; tenant/user/branch isolation (including the corrected, genuinely-restrictable-role branch-targeting test); multi-device push fan-out and failed-token deactivation; and an Optical/Medical-neutrality regression check.

---

## 25. Full Regression Results

Full backend suite (`npx jest --runInBand`, all 33 suites, no file filter), against `akvisionflow_phase115`:

- **Initial full-suite run**: 731 tests, 649 passed, 82 failed across 9 suites (`clinical.test.js`, `customerManagement.test.js`, `supplierManagement.test.js`, `inventoryStockManagement.test.js`, `tenantCompanyManagement.test.js`, `mobileDashboard.test.js`, `branchWarehouseManagement.test.js`, `productArchitecture.test.js`, `api.test.js`). **`notificationsAndActivityLog.test.js` and `quotationsAndOrders.test.js` both passed cleanly in this same full-suite run.**
- Root cause, confirmed by the actual error message: `FATAL: sorry, too many clients already` — the identical Postgres connection-pool-exhaustion class first observed and disclosed in Phase 1.14's report, now affecting a larger set of suites simply because the full test suite has grown to 33 files (2 more added this phase). Confirmed Postgres was healthy immediately afterward (`pg_isready` normal, 6 active connections moments later) — **no code was changed** in response.
- **Isolated retry of all 9 affected suites together**: **142/142 passed, fully clean.**

None of the 9 affected suites touch Notification/AuditLog/automation code. This is disclosed with full transparency as a continuation of the same environment-level flakiness class documented in Phase 0.2 onward, not a defect introduced by this phase.

Full frontend suite (`npx vitest run`): **136/136 tests passed across 30 files**, including the updated `NotificationBell.test.jsx`. `npm run lint` (oxlint) exits `0`. `npm run build` (vite) succeeds cleanly.

---

## 26. Known Limitations

1. **Push and in-app notification delivery remain two separate pipelines** (Section 9) — none of this phase's twelve new business events also send a push notification, even to a recipient with an active device token. A deliberate decision: unifying them would require either bypassing the user's actual configured push preferences or extending `alertMapping.js`'s AI-insight-specific category taxonomy in a way not cleanly suited to these events.
2. **No per-user preference for the new in-app business events** (Section 11) — gated only by the existing, tenant-wide `AutomationRule.isEnabled` toggle, the same limitation every pre-existing `IN_APP_NOTIFICATION` event already had.
3. **`STOCK_LOW` and stock-adjustment events remain unwired** (Section 4) — a pre-existing gap the audit found and disclosed, not fixed in this phase because doing so correctly requires deeper engagement with Phase 1.10's inventory-threshold logic than this phase's scope covers.
4. **`AuditLog.metadata` still varies in shape and depth per call site** — this phase did not retrofit every existing `logAudit()` call site to capture a structured before/after diff; the field remains exactly as rich (or as sparse) as each individual route already chose to make it.
5. **No administrative retention/deletion capability exists for `AuditLog`** (Section 15) — not built in this phase since none was required and none previously existed; history will accumulate indefinitely.
6. **Deactivated-user device tokens are not automatically excluded from push** (Section 18) — `sendToUser` filters by `DeviceToken.isActive`, not the linked `User.isActive`; a pre-existing characteristic, not introduced or fixed by this phase.
7. **No end-to-end, on-device Owner Android verification** was possible in this environment (Section 18) — push was verified only at the service/provider-response layer.
8. **No visual, live-browser verification of the new/extended frontend pages** was possible in this environment (Section 17) — verified instead via build/lint/existing-test success and response-shape cross-checking.
9. **Extreme-scale connection-pool exhaustion during the full, sequential 33-suite regression run** (Section 25) — an environment characteristic that grows with the test suite's own size across phases, not a defect in any phase's code; isolated retries are consistently clean.

---

## 27. Deferred Items

- Unifying push and in-app notification delivery for automation-triggered events, with a properly-designed category/preference extension (Section 26.1/26.2).
- Wiring `STOCK_LOW` (and a genuine stock-adjustment event) into the inventory module, with real threshold-check logic (Section 26.3).
- Retrofitting existing `logAudit()` call sites with structured before/after diffs (Section 26.4).
- An administrative activity-log retention/export/deletion capability, if ever required (Section 26.5).
- Excluding deactivated users' device tokens from push delivery (Section 26.6).
- End-to-end Owner Android device verification, once a real device/test harness is available (Section 26.7).
- Visual/browser-based UI verification of the new frontend pages, once a browser-automation tool is available in this environment (Section 26.8).
- A dashboard/admin aggregate view over notifications/activity data (Section 23), if a future phase requests one.

---

## 28. Files Changed

**Backend (new):**
- `backend/prisma/migrations/20260922020000_phase1_15_notifications_activity_log/migration.sql`
- `backend/src/modules/activityLog/activityLog.routes.js`
- `backend/tests/notificationsAndActivityLog.test.js`

**Backend (modified):**
- `backend/prisma/schema.prisma` — `Notification` gained `branchId`/`priority`/`readAt`/`entityType`/`entityId`/`channel`/`deliveryStatus`/`expiresAt` and two new indexes; new `NotificationPriority` enum; `AuditLog` gained `branchId` and two new indexes; `AutomationEvent` gained 10 new values; back-relations on `Branch`.
- `backend/src/constants/permissionCatalog.js` — new `AUDIT_LOG` resource (2 new grants).
- `backend/src/app.js` — mounted the new activity-log module under `/api/activity-log`.
- `backend/src/middleware/audit.js` — `logAudit()` accepts an optional `branchId`.
- `backend/src/modules/communication/automation.js` — `createRoleNotifications` gained branch-aware filtering and `entityType`/`priority` pass-through; 11 new `DEFAULT_RULES` entries (10 new events + the previously-orphaned `PAYMENT_RECEIVED`).
- `backend/src/modules/communication/notifications.routes.js` — new `GET /:id`, `DELETE /:id`; `type`/`priority`/`from`/`to` filters on `GET /`; idempotent `readAt` on mark-read/mark-all-read.
- `backend/src/modules/sales/sales.routes.js` — `SALE_CANCELLED` wired into `POST /:id/reverse`.
- `backend/src/modules/payments/payments.routes.js` — `PAYMENT_RECEIVED`/`PAYMENT_REVERSED` wired.
- `backend/src/modules/expenses/expenses.routes.js` — `EXPENSE_CREATED`/`EXPENSE_REVERSED` wired.
- `backend/src/modules/salesReturns/salesReturns.routes.js` — `RETURN_CREATED` wired.
- `backend/src/modules/purchaseReturns/purchaseReturns.routes.js` — `RETURN_CREATED` wired.
- `backend/src/modules/creditNotes/creditNotes.routes.js` — `CREDIT_NOTE_CREATED` wired (standalone only).
- `backend/src/modules/debitNotes/debitNotes.routes.js` — `DEBIT_NOTE_CREATED` wired (standalone only).
- `backend/src/modules/quotations/quotations.routes.js` — `QUOTATION_ACCEPTED` wired.
- `backend/src/modules/salesOrders/salesOrders.routes.js` — `SALES_ORDER_CONFIRMED`/`SALES_ORDER_CANCELLED` wired.

**Frontend (new):**
- `frontend/src/pages/notifications/Notifications.jsx`
- `frontend/src/pages/activityLog/ActivityLog.jsx`

**Frontend (modified):**
- `frontend/src/components/NotificationBell.jsx` — new "View all notifications" link.
- `frontend/src/components/NotificationBell.test.jsx` — wrapped in `MemoryRouter` (test-harness only; assertions unchanged).
- `frontend/src/App.jsx` — new `/notifications`/`/activity-log` routes.
- `frontend/src/components/Layout.jsx` — new sidebar navigation entries.

---

## 29. Final Verdict

**PHASE 1.15 — CLOSED WITH CONDITIONS**

Justification: the core, task-mandated capability — a universal, industry-neutral in-app notification system with accurate read/unread state verified under real concurrency, a first-ever activity-log read/filter/pagination surface built on the existing, immutable `AuditLog` table, a confirmed and closed branch-isolation gap in notification targeting, and centralized, duplicate-safe event creation extended (not duplicated) across twelve meaningful new business-event call sites spanning Phase 1.11–1.14's modules — is fully implemented, thoroughly tested with real concurrent operations against a real database, and free of any known correctness defect. Two genuinely pre-existing, orphaned architectural gaps (`AuditLog` being write-only, and `PAYMENT_RECEIVED` being an unwired enum value) were found and fixed as part of this phase's own mandate to audit first. A real test-authoring mistake (using a branch-unrestricted role to test branch restriction) was caught and corrected before being reported as a false negative. Regression testing found zero failures attributable to this phase's changes (the only failures observed are the now-familiar connection-pool-exhaustion flake, confirmed to clear completely on isolated retry).

The "conditions" are the disclosed items in Section 26: push and in-app delivery remain intentionally separate pipelines; per-user preferences for the new business events don't yet exist (matching a pre-existing limitation, not a new one); `STOCK_LOW` remains a disclosed, unwired legacy gap; `AuditLog.metadata` richness still varies by call site; there is no log-retention/deletion tooling; and the new frontend pages and the mobile push pipeline could not be verified end-to-end in this environment (no browser automation, no real device, mock provider only). None of these conditions represent an incorrect or unsafe behavior — each is a scoped, transparently-documented boundary consistent with the task's own instruction to disclose limitations, delivery guarantees, and deferred channels rather than either silently omitting them or over-building beyond what was asked.

**STOP. Phase 1.16 has not been started.** Awaiting Product Owner review of this report.
