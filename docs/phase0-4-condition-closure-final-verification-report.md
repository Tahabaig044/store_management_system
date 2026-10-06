# PHASE 0.4 — CONDITION CLOSURE & FINAL VERIFICATION REPORT

**Scope of this pass:** complete the single open condition from the Phase 0.4 CLOSED WITH CONDITIONS report — migrate the remaining applicable `requireRole` usages to the centralized `requirePermission` system, using the already-created permission catalog, with zero expansion/reduction of access and zero unrelated changes.

---

## A. Remaining `requireRole` modules found (at the start of this pass)

At the start of this pass, 34 route files still used `requireRole` directly (some already partially migrated from the original Phase 0.4 pass — `products.routes.js`, `warehouses.routes.js`, `stockTransfers.routes.js`, `branches.routes.js`, `sales.routes.js` (partially)). The full remaining set, inspected file by file:

`categories`, `customers`, `suppliers`, `branches`, `companies`, `users`, `sales` (remaining routes), `purchases`, `payments`, `expenses`, `procurement/purchaseRequests`, `procurement/purchaseOrders`, `procurement/goodsReceipts`, `procurement/rfqs`, `accounting/journal`, `reports` (core), `accounting/reports`, `communication/reports`, `clinical/reports`, `clinical/patients`, `clinical/appointments`, `clinical/examinations`, `clinical/clinicalPrescriptions`, `clinical/doctors`, `clinical/labs`, `opticalOrders`, `communication/messages`, `communication/templates`, `communication/automationRules`, `communication/config`, `communication/scheduled`, `accounting/accounts`, `accounting/periods`, `accounting/taxRates`, `ai/*` (5 files), `dashboard`, `expenseCategories`, `inventory`, `settings`, `permissions`.

## B. Modules migrated in this pass

Every route below now uses `requirePermission(resource, action)` from the existing catalog. Where a route had no corresponding catalog action, it retains an **explicit** `requireRole(...)` call (never left unprotected) — see the per-file notes.

| Module | Routes migrated | Notes |
|---|---|---|
| `categories.routes.js` | GET, GET/:id → `CATEGORY:VIEW`; POST → `CREATE`; PATCH → `UPDATE`; DELETE → `DELETE` | Fully migrated |
| `customers.routes.js` | Same pattern, incl. `/:id/history` → `VIEW` | Fully migrated |
| `suppliers.routes.js` | Same pattern, incl. `/:id/ledger` → `VIEW` | Fully migrated |
| `branches.routes.js` | CRUD → `BRANCH:*` | `/:id/access` sub-routes kept on `requireRole(...TENANT_ADMIN_ONLY)` — no `ACCESS_GRANT` action in catalog |
| `companies.routes.js` | CRUD → `COMPANY:*` | `/:id/access` sub-routes kept on `requireRole(...TENANT_ADMIN_ONLY)`, same reason |
| `users.routes.js` | GET→`USER:VIEW`, POST→`CREATE`, PATCH→`UPDATE` | Self-privilege-escalation guard (lines untouched) re-verified working |
| `sales.routes.js` | GET, GET/:id→`SALE:VIEW`; POST→`CREATE` | `/:id/reverse` already migrated in the original Phase 0.4 pass |
| `purchases.routes.js` | GET, GET/:id→`PURCHASE:VIEW`; POST→`CREATE`; `/:id/return`→`REVERSE` | `/:id/receive`, `/:id/pay` retained explicit `requireRole(...INVENTORY_STAFF)` — no matching action |
| `payments.routes.js` | GET→`PAYMENT:VIEW` | Fully migrated (single route) |
| `expenses.routes.js` | GET→`EXPENSE:VIEW`; POST→`CREATE` | PATCH `/:id` retained explicit `requireRole(...FINANCE_STAFF)` — no `EXPENSE:UPDATE` action |
| `procurement/purchaseRequests.routes.js` | GET, GET/:id→`VIEW`; POST→`CREATE`; `/:id/approve`→`APPROVE` | `/:id/reject` kept `requireRole(...MANAGEMENT)`; `/:id/cancel` kept `requireRole(...INVENTORY_STAFF)` — neither has a matching action |
| `procurement/purchaseOrders.routes.js` | Same pattern → `PURCHASE_ORDER:*` | `/:id/reject`, `/:id/cancel` retained explicit roles, same reasoning |
| `procurement/goodsReceipts.routes.js` | GET, GET/:id→`VIEW`; POST→`CREATE` | Fully migrated |
| `accounting/journal.routes.js` | GET, GET/:id→`JOURNAL:VIEW`; POST→`CREATE` | `/:id/void` retained explicit `requireRole(...MANAGEMENT)` — no `JOURNAL:REVERSE`/void action |
| `reports/reports.routes.js` | All routes (router-level) → `REPORT:VIEW` | Role set was already exactly `FINANCE_STAFF` for every route |
| `accounting/reports.routes.js` | All routes (router-level) → `REPORT:VIEW` | Same |
| `communication/reports.routes.js` | GET routes (router-level) → `COMMUNICATION:VIEW` | `/branch-activity` retained explicit `requireRole(...MANAGEMENT)` (Phase 0.3 narrowing, no matching action) |
| `clinical/reports.routes.js` | `patient-visits`→`PATIENT:VIEW`; `appointments`→`APPOINTMENT:VIEW`; `examinations`→`EXAMINATION:VIEW`; `prescription-conversion`→`PRESCRIPTION:VIEW`; remaining FINANCE_STAFF reports→`REPORT:VIEW` | Mixed-role file, mapped by content |
| `clinical/patients.routes.js` | GET, GET/:id, GET/:id/360→`PATIENT:VIEW`; POST→`CREATE`; PATCH→`UPDATE` | `/:id/merge` retained explicit `requireRole(...CLINICAL_STAFF)` — no `PATIENT:MERGE` action |
| `clinical/appointments.routes.js` | GET, GET/today, GET/:id→`VIEW`; POST→`CREATE`; PATCH `/status`, `/reschedule`→`UPDATE` | Fully migrated |
| `clinical/examinations.routes.js` | GET routes→`EXAMINATION:VIEW`; POST→`CREATE` | Fully migrated |
| `clinical/clinicalPrescriptions.routes.js` | GET routes→`PRESCRIPTION:VIEW`; POST→`CREATE` | Fully migrated |
| `opticalOrders.routes.js` | GET, GET/:id→`VIEW`; POST→`CREATE`; PATCH→`UPDATE` | `/:id/pay` retained explicit `requireRole(...FRONT_DESK)` — no matching action |
| `communication/messages.routes.js` | GET routes→`COMMUNICATION:VIEW` | POST `/` and `/:id/retry` unchanged (`requireRole(...MANAGEMENT)`, stricter than catalog's `COMMUNICATION:CREATE`); `/webhook` given explicit `requireRole(...COMMUNICATION_STAFF)` since the router-level blanket check was removed |
| `communication/templates.routes.js` | GET, `/:id/preview`→`COMMUNICATION:VIEW` | POST/PATCH unchanged (stricter `MANAGEMENT`) |
| `communication/automationRules.routes.js` | GET, `/:id/executions`→`COMMUNICATION:VIEW` | PATCH/DELETE unchanged (stricter `MANAGEMENT`) |

## C. Modules intentionally NOT migrated, with reason

Every module below has **no corresponding resource/action in the existing 24-resource `permissionCatalog.js`**. Adding one would expand the authorization model, which the task explicitly puts out of scope ("do not redesign the authorization architecture again"). These stay entirely on `requireRole`:

- `accounting/accounts.routes.js`, `accounting/periods.routes.js`, `accounting/taxRates.routes.js` — no Chart-of-Accounts/Period/TaxRate resource cataloged.
- `ai/assistant.routes.js`, `ai/brief.routes.js`, `ai/config.routes.js`, `ai/forecasts.routes.js`, `ai/insights.routes.js`, `ai/usageReports.routes.js` — no AI resource cataloged.
- `dashboard/dashboard.routes.js` — no Dashboard resource cataloged.
- `expenseCategories/expenseCategories.routes.js` — no ExpenseCategory resource cataloged (distinct from `EXPENSE`).
- `inventory/inventory.routes.js` — no distinct Inventory resource (separate from `PRODUCT`/`WAREHOUSE`).
- `settings/settings.routes.js` — no Settings resource cataloged.
- `communication/config.routes.js`, `communication/scheduled.routes.js` — no Communication-config/Scheduled-job resource distinct from `COMMUNICATION`.
- `procurement/rfqs.routes.js` — no RFQ resource cataloged.
- `clinical/doctors.routes.js` — no Doctor resource cataloged.
- `clinical/labs.routes.js` — no Lab resource cataloged.
- `permissions/permissions.routes.js` — the catalog introspection endpoint itself; adding a "PERMISSION" resource to gate access to the permission catalog would be circular.
- All `/access` grant/revoke sub-routes on `branches`, `companies`, and `warehouses` — no `ACCESS_GRANT`-type action cataloged for any resource.
- `products.routes.js`'s `/:id/adjust-stock` — no `ADJUST_STOCK` action cataloged (unchanged from the original Phase 0.4 pass).
- Owner Mobile app routes — explicitly out of scope per instruction #11 (not touched).

## D. Permission mapping used

No new permissions, resources, or role grants were added or changed. Every migration in Section B maps 1:1 onto an **existing** entry in `backend/src/constants/permissionCatalog.js` (unchanged file), verified against the role set each route previously enforced via `requireRole`/router-level middleware. Where the pre-existing role set for a route did not exactly match any cataloged action's role set (e.g., `PATCH /:id/void`'s `MANAGEMENT`-only gate having no `JOURNAL:REVERSE` action), the route was **left on `requireRole`** rather than mapped to a nearby-but-different permission — this is the guardrail against accidental expansion/reduction (requirement #4).

## E. Behavior-preservation verification

For every migrated route, the new `requirePermission(resource, action)` call's role set was checked against the previous `requireRole(...)`/router-level role set and found to be **identical** (same roles allowed, same roles denied) — this is enforced by construction, since `permissionCatalog.js` was built in the original Phase 0.4 pass specifically to mirror the pre-existing `requireRole` groups exactly. No route was left without either a `requirePermission` or an explicit `requireRole` guard (audited file-by-file, see Section B "Notes" column for every retained explicit role check).

## F. Security test results

- Full existing security/authorization suite (`tests/permissionsArchitecture.test.js`): **33/33 passed** (20 pre-existing + 13 new, after a test-infrastructure fix described below).
- Added 13 new test cases spanning `CATEGORY`, `SUPPLIER`, `BRANCH`/`COMPANY`, `USER`, `SALE`, `PURCHASE`, `EXPENSE`, `PAYMENT`, `PURCHASE_REQUEST`, `JOURNAL`, `REPORT`, `APPOINTMENT`, `OPTICAL_ORDER`, and `COMMUNICATION` — each proving both the allowed role succeeds and a non-permitted role is rejected with 403, plus one case proving an **unmigrated** route (`JOURNAL` manual-entry POST) correctly remains `MANAGEMENT`-only.
- **Bug found and fixed during this verification (in the new test file, not application code):** the first draft of the new tests minted a fresh user (register + login) per assertion, which collided with the pre-existing `authLimiter` (20 login/register attempts per 15 minutes, brute-force protection in `app.js`) once combined with the file's existing tests — causing spurious 401s. Fixed by creating each role's token **once** per describe block and reusing it across assertions (standard supertest pattern), bringing the file's total auth calls to exactly 20, safely within its own isolated run. Confirmed by an isolated rerun of the file: 33/33 pass.
- Self-privilege-escalation: `users.routes.js`'s existing guard (blocking a user from changing their own role) was structurally untouched by the middleware swap; `tests/permissionsArchitecture.test.js`'s "a TENANT_ADMIN cannot change their OWN role" test still passes.
- Cross-tenant / cross-company / cross-branch / cross-warehouse isolation tests: all pass unchanged (`tests/permissionsArchitecture.test.js`, `tests/companyArchitecture.test.js`, `tests/multiBranch.test.js`).

## G. Backend regression results

Full suite (`npx jest --runInBand --testPathIgnorePatterns="mobile"`), against a fresh, isolated local Postgres database with all migrations applied and the Permission/RolePermission catalog seeded (`npm run seed:permissions`):

- **334/334 tests passed, 13/13 suites passed** on the verification run.
- One transient failure was observed on an earlier full-suite pass (`clinical.test.js`, Patient 360 view, `Can't reach database server` — a Prisma connection-pool error, not a permission/auth failure) and **disappeared on an immediate isolated rerun of that file (32/32 pass)**. This is the same pre-existing, environment-level connection-pool flake documented across the Phase 0.2, 0.3, and 0.4 verification passes — a different, unrelated file each time, always clean on retry, never a real regression from this pass's changes. Disclosed here per standing practice rather than hidden.
- **Note on the first attempt at this run:** a fresh test database created for this verification pass had its migrations applied but the Permission/RolePermission catalog had not yet been seeded, causing ~300 unrelated spurious failures ("You do not have permission to..." for every role, including TENANT_ADMIN). This was a test-environment setup gap, not an application bug — running `npm run seed:permissions` against that database (73 permissions, 231 role grants, matching the catalog exactly) resolved it completely.

## H. Frontend regression results

- `npx vitest run`: **76/76 tests passed** (19/19 test files), including fixes to 3 existing test files (`Procurement.test.jsx`, `Warehouses.test.jsx`, `StockTransfers.test.jsx`) whose `useAuth()` mocks needed a `hasPermission: () => true` stub added, since those pages now call `hasPermission(...)` (mirroring the same fix pattern already applied to `Products.test.jsx` in the original Phase 0.4 pass).
- `npx oxlint`: exit code 0, only pre-existing warnings (all `react(set-state-in-effect)`/`only-export-components` style warnings that already existed across the codebase before this pass; no new warnings or errors introduced).
- `npx vite build`: succeeds cleanly (one pre-existing chunk-size advisory warning, unrelated).
- **Frontend permission checks updated** (requirement #8) for every migrated module where the frontend depended on a hardcoded role array:
  - `Companies.jsx`, `Branches.jsx`, `Categories.jsx`, `SalesHistory.jsx` (reversal button), `Procurement.jsx` (approve buttons, now resource-specific: `PURCHASE_REQUEST:APPROVE` / `PURCHASE_ORDER:APPROVE`), `Warehouses.jsx`, `StockTransfers.jsx` — all switched from `user?.role`/hardcoded arrays to `hasPermission('RESOURCE:ACTION')`.
  - `Layout.jsx`'s sidebar nav-item visibility and `App.jsx`'s route-level `ProtectedRoute` guards were switched to permission-based checks (`ProtectedRoute` gained an optional `permission` prop, backward-compatible with its existing `roles` prop) for every nav item/route whose backend module was migrated in this pass, preserving the exact same visible-role-set for each (verified role-set-for-role-set against the catalog before changing).
  - Left untouched, by design: modules whose backend routes were **not** migrated in this pass (`AiAssistant.jsx`, `Doctors.jsx`, `CommunicationCenter.jsx`'s send/retry buttons, `AutomationRules.jsx`'s edit/toggle controls, `/command-center` and `/ai-assistant`/`/recommendations` nav/routes) — their backend gates are unchanged `requireRole`, so their frontend hardcoded-role checks still correctly mirror the backend and were left alone per requirement #12 (no unrelated cleanup).

## I. Optical/Medical regression results

`tests/clinical.test.js`: **32/32 passed** in isolation, including:
- "clinical reports are restricted appropriately (FINANCE_STAFF-only reports reject a receptionist)" — proves the migrated `clinical/reports.routes.js` mapping did not change who can/cannot access clinical reports.
- Patient 360 view, examination/prescription versioning, optical-order job-card lifecycle, financial integration (ledger posting), audit logging, and tenant isolation for all clinical entities — all unaffected by the middleware swap.
- No Optical/Medical workflow, schema, or business logic was touched in this pass — only the authorization middleware on top of existing routes.

## J. Remaining conditions

**None specific to this migration.** The modules listed in Section C remain on `requireRole` by design (no corresponding catalog resource exists, and creating one is explicitly out of scope for a condition-closure pass). This is not treated as an open condition — it reflects the deliberate boundary of "migrate what the existing catalog supports" set by the task, not an incomplete migration.

## K. Final status: **CLOSED**

All applicable `requireRole` usages with a corresponding entry in the existing permission catalog have been migrated to `requirePermission`, with verified identical role behavior, no self-privilege-escalation regression, no Optical/Medical regression, full backend and frontend regression passing, and updated frontend permission checks for every migrated module. The remaining `requireRole` usages are intentional and documented (Section C), not gaps.

---

**STOP. Phase 0.5 has not been started.** Per instruction #9, this report is submitted for Product Owner approval before any Phase 0.5 work begins.
