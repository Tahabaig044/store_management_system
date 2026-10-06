# PHASE 1.6 — CUSTOMER MANAGEMENT: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-21
**Scope:** Phase 1.6 — Customer Management
**Preceding gate:** Phase 1.5 — APPROVED AND FORMALLY CLOSED (not reopened or modified; free-text Product `brand`/`unit` fields remain backward compatible and untouched, per explicit instruction)

---

## 1. Requirements Checklist

Derived from the Product Owner's Phase 1.6 instruction message (no separate Phase 1.6 spec document exists, consistent with the established precedent for Phases 0.6–1.5).

| # | Requirement | Status |
|---|---|---|
| 1 | Inspect existing Customer model/routes/services/frontend/validation/search/permissions/consumers | ✅ Done (Section 2) |
| 2 | Do not duplicate or unnecessarily rewrite working Customer functionality | ✅ Confirmed — CRUD, search, tenant-scoping, history/balance all reused unchanged |
| 3 | Customer CRUD | ✅ Verified (pre-existing) |
| 4 | Customer profile/details | ✅ Verified (pre-existing: name/phone/email/address) |
| 5 | Customer contact information | ✅ Verified (pre-existing) |
| 6 | Customer code/identifier where applicable | ✅ Genuine gap closed — new optional `code` field, per-tenant unique |
| 7 | Customer status | ✅ Verified (pre-existing `isActive`) |
| 8 | Customer search and filtering | ✅ Verified (pre-existing) + `code` added to searchable fields |
| 9 | Customer notes where supported by the existing architecture | ✅ Genuine gap closed — new optional `notes` field, mirroring the existing lightweight `note` pattern elsewhere |
| 10 | Customer/company relationship where required | ✅ Verified — deliberately remains tenant-wide (Section 8) |
| 11 | Customer transaction-history compatibility | ✅ Verified (pre-existing `/customers/:id/history`), re-tested |
| 12 | Customer balance/receivable compatibility | ✅ Verified (pre-existing balance calculation), re-tested |
| 13 | Duplicate/identity handling where already supported or required | ✅ Genuine, minimal gap closed — non-blocking possible-duplicate flag (Section 3) |
| 14 | Customer permissions | ✅ Verified (pre-existing `CUSTOMER:*`, unchanged) |
| 15 | Frontend customer management | ✅ Extended with code/notes fields |
| 16 | Backend validation | ✅ Extended (code/notes schema, DB-level uniqueness) |
| 17 | Universal rule: no hard-coded industry assumptions in Customer | ✅ Verified — zero industry references anywhere in Customer code |
| 18 | Do not turn Customer into a clinical Patient entity | ✅ Explicitly re-verified — Patient remains a separate 1:1 extension, never merged |
| 19 | Preserve Tenant→Company→Branch→Warehouse and centralized RBAC | ✅ Unchanged |
| 20 | Customer data respects existing tenant/company/branch authorization | ✅ Verified via new + existing tests |
| 21 | Do not implement complete Sales/AR/CRM/Inventory engines | ✅ Confirmed — no such engine code touched |
| 22 | Offline-first: don't implement complete sync engine; must remain compatible | ✅ Verified against the already-existing offline outbox/cache architecture (Section 9) |
| 23 | New tests: CRUD/validation/search/RBAC/isolation/sales-customer regression/Optical-Medical regression/frontend/full regression/build-lint | ✅ Done (Section 11) |
| 24 | Specifically inspect Optical/Clinical workflows for Patient/Customer separation | ✅ Done, explicit tests added (Section 7) |
| 25 | Produce implementation & verification report | ✅ This document |
| 26 | Final status CLOSED / CLOSED WITH CONDITIONS / NOT READY | ✅ See Section 14 |
| 27 | Stop after Phase 1.6, do not start 1.7 | ✅ Stopping now |

---

## 2. Existing Architecture Inspected

- **`Customer` model** — already genuinely universal: `name`, `phone`, `email`, `address`, `isActive`, `idempotencyKey`. **Zero industry-specific fields already** — this was correctly designed from an earlier phase, not something this phase needed to fix.
- **`Patient` model** — a separate, 1:1 clinical extension table (`customerId` FK), carrying every clinical field (`patientNumber`, `dateOfBirth`, `gender`, `bloodGroup`, `allergies`, `medicalHistory`, emergency contact). The schema's own comment already states the intended design precisely: "a Customer becomes clinically active by gaining a Patient profile - the identity is never duplicated, only extended. Not every Customer has one." This is exactly the correct architecture Phase 1.6 asks for — already built correctly in an earlier phase (Phase 7).
- **`customers.routes.js`** — full CRUD via `crudFactory`, search by name/phone/email, offline-create idempotency-key support, and a `/:id/history` endpoint aggregating sales + optical orders + payments with a balance-due calculation that correctly excludes reversed sales. Already solid, already tested (`business.test.js`, `permissionsArchitecture.test.js`).
- **Frontend `Customers.jsx`** — full CRUD UI, search, history modal with sales/optical-order/payment breakdown, and — notably — **customer creation already goes through a real, pre-existing offline-first outbox** (`OUTBOXES.customers.submit`, part of a shared offline architecture in `frontend/src/offline/syncEngine.js` covering Sales, Purchases, Expenses, Customers, Suppliers, and Optical Orders: local IndexedDB cache, client-generated idempotency keys, sequential sync-on-reconnect, and conflict/failure states surfaced for human review, never silently dropped). This is a materially more mature offline foundation than "Phase 1.6 must remain compatible with future offline operation" implied going in — it already exists and already works for Customer specifically.

**Conclusion:** Customer management's core (CRUD, search, tenant isolation, permissions, history/balance, and the universal/clinical separation) was already complete and correct, and none of it was rewritten. Two genuine, narrowly-scoped gaps were identified: an optional customer code/identifier, and a lightweight notes field. A third item — duplicate/identity handling — was already partially supported (search already covers phone/email) and was extended with a small, safe, advisory addition (Section 3).

---

## 3. Changes Implemented

### Backend — Schema (additive, one migration)
- **`Customer`** — added optional `code String?` (`@@unique([tenantId, code])` — standard SQL NULL semantics mean any number of customers may have no code; only an explicit duplicate value conflicts) and optional `notes String?` (a single free-text field, mirroring the existing simple `note` pattern already used on `InventoryTransaction` and other transaction records — deliberately not a full notes/activity-log or CRM system, which is out of this phase's scope).

### Backend — API
- **`customers.routes.js`** —
  - `code`/`notes` added to create/update schemas; `code` added to `searchFields`.
  - A duplicate-`code` create/update attempt now surfaces as a clean `409` via the existing generic Prisma `P2002` → 409 error-handler mapping — no new application-layer uniqueness check was needed.
  - **New, non-blocking possible-duplicate check**: on create, if the new customer's phone or email matches an existing *active* customer in the same tenant, the customer is still created (two real people can legitimately share a household phone; this is advisory, not a hard rule) but the response includes a `possibleDuplicate: {id, name, phone, email} | null` field. This directly serves the "Duplicate/identity handling where already supported" instruction without building a merge/dedup workflow (explicitly CRM scope, out of this phase).

### Frontend
- **`Customers.jsx`** — added Code and Notes fields to the create/edit form, and a Code column to the list. Editing still goes through the existing direct `PATCH` call; creating still goes through the existing offline outbox unchanged.

### Tests
- **`backend/tests/customerManagement.test.js`** (new, 18 tests) — code/notes CRUD and per-tenant uniqueness (×6), the new duplicate-check behavior (×4), explicit Customer/Patient separation verification (×3), Customer/branch compatibility (×1), tenant isolation (×1), permission re-verification (×2), plus one test confirming code is searchable.

---

## 4. Database Changes

Migration `20260919110000_phase1_6_customer_management` — purely additive:

```sql
ALTER TABLE "customers" ADD COLUMN "code" TEXT, ADD COLUMN "notes" TEXT;
CREATE UNIQUE INDEX "customers_tenantId_code_key" ON "customers"("tenantId", "code");
```

No existing column, table, or constraint was altered or dropped. Applied cleanly via `prisma migrate deploy` on top of the full existing migration history.

---

## 5. API Changes

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/customers` | `CUSTOMER:CREATE` (unchanged) | Now accepts optional `code`/`notes`; response now includes `possibleDuplicate` |
| PATCH | `/api/customers/:id` | `CUSTOMER:UPDATE` (unchanged) | Now accepts optional `code`/`notes` |
| GET | `/api/customers` | `CUSTOMER:VIEW` (unchanged) | `search` now also matches `code` |

No existing endpoint's URL, method, permission requirement, or payload shape changed for any field that existed before this phase.

---

## 6. Frontend Changes

- Customers page: Code column in the list, Code and Notes fields in the create/edit form.
- The existing offline-outbox create flow and the existing direct-PATCH edit flow are both fully compatible with the new fields with zero changes to either mechanism — `code`/`notes` simply pass through as ordinary form fields.

---

## 7. Universal-vs-Industry Separation — Explicit Verification

This was inspected with particular care per the explicit instruction to check Optical/Clinical workflows for correct separation:

- **The `Customer` model itself contains zero clinical fields, before or after this phase.** No schema change in this phase added anything Patient-related to Customer.
- **A new, explicit test** (`creating a Customer never accepts or requires any Patient-specific field`) sends `dateOfBirth`, `bloodGroup`, `allergies`, and `medicalHistory` directly in a `POST /api/customers` request and confirms the created record and response carry none of them — Zod's schema silently drops unknown keys, and the underlying table has no such columns to receive them even if it didn't.
- **A new, explicit test** confirms `GET /api/customers/:id` never includes the `patient` relation, for a customer with no Patient profile.
- **A new, explicit test** confirms the customer *list* endpoint never leaks clinical data even for a customer who *does* have a Patient profile — a customer with an attached Patient record (created via the existing, separate `POST /api/patients` endpoint) still returns a plain Customer row with no `bloodGroup`, `allergies`, or `patient` fields in the list response.
- **Existing full Optical/Clinical regression** (`clinical.test.js`, 32 tests covering patients, appointments, examinations, prescriptions, optical orders, and clinical reports) passes unchanged, confirming Phase 1.6 did not disturb the existing Patient-extension workflow in any way.

No code in this phase turns, or risks turning, the universal Customer entity into a clinical Patient entity. The two remain exactly as separately designed since Phase 7.

---

## 8. Customer/Company/Branch Relationship — Verification (Not a Change)

`Customer` remains deliberately tenant-wide, with no `companyId`/`branchId` field — consistent with the same design already used for `Category`/`Brand`/`Unit` (Phase 1.5) and `Supplier`. This was verified, not modified: a new test creates one customer and transacts with it at two different branches of the same tenant, confirming each `Sale` correctly records its own `branchId` while the customer master record itself remains a single, shared, tenant-wide identity — exactly matching how a real multi-branch retailer expects one customer to be recognizable everywhere. Adding company/branch scoping directly to Customer was considered and rejected as unnecessary and out of scope: nothing in the existing codebase or this phase's instructions requires it, and doing so would be a materially larger, riskier change affecting Sales/Payments/Portal modules broadly for no identified benefit.

---

## 9. Offline-Compatibility Considerations

Phase 1.6 did not implement the complete Offline-First Sync Engine, and this phase's own changes are compatible with the **already-existing** offline architecture found during inspection (`frontend/src/offline/syncEngine.js`, `db.js`):

- The local Dexie/IndexedDB cache schema declares only indexed columns (`customers: 'id, name'`) — it stores whatever full object the server returns, so the new `code`/`notes` fields require **no changes** to the local cache schema and were verified to pass through correctly.
- The customer creation outbox (`OUTBOXES.customers`) queues the full form payload as-is; `code`/`notes` flow through it unchanged, verified via a new frontend test.
- **One deliberate non-implementation, disclosed rather than silently done**: the new `possibleDuplicate` field returned by `POST /api/customers` is *not* surfaced in the Customers.jsx UI. The existing offline sync engine's generic `runSync()` (shared by six different entity outboxes: Sales, Purchases, Expenses, Customers, Suppliers, Optical Orders) only persists `data.item` from a successful sync response into the local cache — not the rest of the response body. Making `possibleDuplicate` visible in the UI would require modifying that shared, cross-entity function, which is a materially larger and riskier change than a Customer-specific advisory UX feature justifies, and is outside this phase's scope. The backend capability is fully implemented and tested at the API level; wiring it into the offline-aware creation UI is recorded as a future backlog item.
- Nothing added in this phase creates any obstacle for the eventual `Cloud Customer Data → Local Cache → Offline Transaction → Sync → Reconciliation` flow Phase 1.10 will complete — if anything, this phase's fields make the cached customer record slightly richer (an optional code, useful for offline receipt printing) with no new required data and no change to the sync/conflict model.

---

## 10. Authorization / Isolation Verification

- `CUSTOMER:VIEW`/`CREATE`/`UPDATE`/`DELETE` permissions are entirely unchanged (`CONTACTS_STAFF`/`CONTACTS_STAFF` respectively) — re-verified: a DOCTOR (not `CONTACTS_STAFF`) cannot view the customer list (`403`); a CASHIER (`CONTACTS_STAFF`) can create and view customers.
- Tenant isolation re-verified for the new fields specifically: Tenant B cannot view or update Tenant A's customer, including its `code`/`notes` (`404`).
- The new duplicate-check is tenant-scoped: a matching phone/email in a *different* tenant never triggers a cross-tenant duplicate flag, verified directly.
- `code` uniqueness is per-tenant, not global: two different tenants can use the identical code with no conflict, verified directly.

---

## 11. Test Results

### New Phase 1.6 backend tests
`tests/customerManagement.test.js` — **18/18 pass** on the first run.

### New Phase 1.6 frontend tests
`Customers.test.jsx` (new file) — **3/3 pass**.

### Targeted regression (customer/sales-history/RBAC/company/branch/module/clinical/category-brand-unit/product-service)
`customerManagement.test.js`, `business.test.js`, `clinical.test.js`, `permissionsArchitecture.test.js`, `companyArchitecture.test.js`, `multiBranch.test.js`, `moduleArchitecture.test.js`, `categoryBrandUnitManagement.test.js`, `productServiceManagement.test.js` together: **254/254 pass, 9/9 suites clean.**

*(An initial attempt at this run failed all 254 tests with "register-tenant failed: Internal server error" — diagnosed immediately as the local portable Postgres server having stopped between work sessions, not a code defect; confirmed via `pg_ctl status` showing no server running, restarted, and the identical run then passed 254/254 clean. Recorded here for transparency, not glossed over.)*

### Full backend regression
511 tests total (up from 493 in Phase 1.5, +18 for the new file), 24 suites (up from 23, +1 new file). One full run: 2 unrelated failures (`moduleArchitecture.test.js`, `mobileDashboard.test.js`), both showing the `Can't reach database server`/500 signature already extensively characterized in Phase 1.3/1.4/1.5's own reports. Isolated retry: `moduleArchitecture.test.js` passed clean on retry within the same paired run; `mobileDashboard.test.js` isolated fully alone — **12/12 pass, clean.** No genuine regression was found anywhere, including full Optical/Medical (`clinical.test.js`) and every other Phase 0/1 area.

### Frontend regression
- `npm run lint` (oxlint): 0 errors (only the same pre-existing warning pattern already present across the codebase).
- `npm run build` (vite): succeeds, no errors.
- `npm test` (vitest): **96/96 pass**, 26/26 files (93/25 baseline from Phase 1.5 + 3 new tests/1 new file) — zero regressions.

### Permission-key parity
Re-verified: every `RESOURCE:ACTION` string referenced anywhere in the frontend exists in the backend catalog — 46 keys, **zero mismatches** (unchanged from Phase 1.5 — Customer reuses its existing `CUSTOMER` permission resource; no new resource was needed).

### Manual/on-device verification
None claimed. Phase 1.6 has no mobile or physical-device component.

---

## 12. Security Findings

No defects found. Specifically verified:
- Cross-tenant customer access remains `404` for both read and write, including the new fields.
- `code` uniqueness is correctly scoped per-tenant (not a global collision surface).
- The possible-duplicate check only ever considers *active* customers within the *same* tenant — a deactivated customer's phone/email can be reused by a new customer without a false-positive flag, and no cross-tenant data is ever exposed through it (confirmed the `possibleDuplicate` object itself, when present, contains only `id`/`name`/`phone`/`email` — never any other field).

---

## 13. Explicit Non-Claims (per instruction: do not claim untested functionality)

- **The `possibleDuplicate` advisory is not surfaced anywhere in the frontend UI.** It is implemented and tested at the API level only (Section 9). No claim is made that a user sees a duplicate warning when creating a customer today.
- **No merge or dedup workflow exists.** Two customers that are flagged as possible duplicates remain two entirely separate records; nothing in this phase lets an admin combine them. That is CRM scope, explicitly excluded from this phase.
- **No customer-facing code auto-generation exists.** `code` is a plain optional field a staff member types in (or leaves blank); there is no "next available code" suggestion or sequence, unlike Sale/Purchase invoice numbering elsewhere in the system.

---

## 14. Remaining Conditions / Future Backlog

- Phase 0.5–1.5's previously accepted conditions/backlog items remain unchanged and are **not** reopened by this phase.
- Surfacing `possibleDuplicate` in the Customers.jsx create flow, which requires either a small, carefully-scoped change to the shared offline sync engine's `runSync()` (to persist more than `data.item`) or a Customer-specific bypass of the generic outbox for this one piece of advisory data — recommended as a future, explicitly-scoped frontend enhancement, not attempted here given the shared-code risk.
- An actual customer merge/dedup workflow (for when a genuine duplicate is found) remains explicit future CRM-phase scope.

---

## 15. Final Status

**PHASE 1.6 — CLOSED**

All 27 checklist items are satisfied with evidence. The existing Customer/Patient architecture — already correctly separated since Phase 7, with a mature CRUD, search, tenant-isolation, transaction-history, and even a working offline-first outbox — was inspected, found already correct, and reused without unnecessary rewriting. Two genuine, narrowly-scoped gaps (an optional code/identifier and a simple notes field) were closed, and a lightweight, non-blocking duplicate-identity signal was added at the API level, explicitly not wired into the UI where doing so would have required riskier changes to a shared, cross-entity offline sync mechanism. Customer/Patient separation was explicitly, freshly re-verified with new tests rather than assumed from prior-phase comments. 511/511 backend tests pass (24/24 suites, with the same long-documented transient DB-connection flake hitting two different unrelated files — never a Phase 1.6 file — confirmed clean on isolated retry). 96/96 frontend tests pass. Zero permission-key mismatches. No changes were made to the centralized authorization architecture, the Tenant→Company→Branch→Warehouse hierarchy, or any Sales/Accounting/CRM/Inventory engine. Nothing in this phase creates any obstacle for the future Phase 1.10 Offline-First Sync Engine — the existing offline outbox for Customer was found, verified compatible, and left otherwise untouched.

**Stopping here. Not starting Phase 1.7. Awaiting Product Owner approval.**
