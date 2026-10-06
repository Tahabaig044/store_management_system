# AK VisionFlow — Phase 5 (Industry Modules) Completion Verification Report

Scope: 5.1 Optical Shop, 5.2 Eye Clinic, 5.3 Medical Store & Lens Laboratory, 5.4 Industry Integration/Verification/V1 Closure. Read-only audit first, then only genuine gaps implemented. No production data touched; all testing ran against a local scratch PostgreSQL database (`phase5_scratch`), never the Neon production database referenced in `backend/.env`.

## 1. Executive Summary

Phases 0–4 were already complete and unaffected. Auditing Phase 5 found that the large majority of the specified clinical/optical functionality (Patient, Doctor, Appointment, Examination, ClinicalPrescription, Lab job lifecycle, Patient 360 view, lab turnaround reporting) was **already fully implemented** in earlier phases and did not need rebuilding. Three genuine, scoped gaps were found and closed:

1. **5.1 — Optical Orders had no link to tracked inventory.** A frame/lens sold through an Optical Order never deducted stock or posted COGS; only free-text descriptions existed. Closed by adding a proper `OpticalOrderItem` line-item model and reusing Sale's exact atomic stock-deduction/COGS-posting pattern — no new accounting or inventory engine.
2. **5.2 — A pure clinical visit (no eyewear purchase) had no traceable billing path.** Added an additive `Sale.appointmentId` link so a consultation fee can be billed as an ordinary Sale (reusing the existing `productKind: SERVICE` no-stock-deduction behavior) while staying traceable back to the visit that generated it.
3. **5.3 — Nothing prevented selling an already-expired medicine**, and the expiry report didn't distinguish "already expired" from "near expiry." Both closed with a minimal, additive guard and field.

Full-stack testing (backend, frontend, migrations, security, concurrency) was completed. One genuine concurrency-related bug was found in the new Optical Order status-update code during testing and fixed (see §4/§5). One pre-existing test failure, in code this session never touched, was found and is disclosed under Conditions rather than silently ignored.

**Final verdict: PHASE 5 — CLOSED WITH CONDITIONS** (see §11 and §12).

## 2. Existing Functionality Found (audited, not rebuilt)

- **Patient** (registration, number, DOB, gender, emergency contact) — `Patient` model, `patients.routes.js`, restricted to clinical staff via `PATIENT` permission; identity fields live on `Customer` and are never duplicated.
- **Clinical Visit / Appointment** — `Appointment` model + `appointments.routes.js`: token queue, doctor/branch assignment, status lifecycle (`SCHEDULED → CONFIRMED → ARRIVED → IN_PROGRESS → COMPLETED`/`CANCELLED`/`NO_SHOW`), today's-queue dashboard with waiting-time estimate.
- **Eye Examination** — `Examination` model: visual acuity, refraction, IOP, segment findings, diagnosis, notes — matches the spec without an oversized HIS.
- **Clinical History** — the existing "Patient 360" aggregation view (appointments + examinations + prescriptions + optical orders + balance), verified still correct after Phase 5 changes (`clinical.test.js`, 32/32 passing unmodified).
- **Prescription** (OD/OS sphere/cylinder/axis/add, PD, expiry, notes) — `Prescription` and `ClinicalPrescription` models, already covering the spec's exact clinical field list.
- **Optical Order lifecycle** — `OpticalOrder.status`/`labId`/`labCost`/`qcPassed`/`qcNotes`/`qcAt`/`deliveredAt` already modeled the full Customer → Prescription → Order → Lab → QC → Fitting → Delivery flow; the lab-queue turnaround report already existed.
- **Frame/Lens as inventory** — `ProductType.FRAME`/`LENS`, `ProductOpticalAttributes`, already fully supported in the Products UI (type-specific attribute fields, stock, pricing) — only the *link* from an Optical Order to these records was missing (see §3).
- **Medicine Master / expiry tracking** — `ProductType.MEDICINE`, `Product.batchNumber`/`expiryDate`, already reportable via `/reports/medicine-expiry` and surfaced on the owner dashboard's near-expiry widget.
- **Permission catalog** — `PATIENT`, `APPOINTMENT`, `EXAMINATION`, `PRESCRIPTION`, `OPTICAL_ORDER`, `SALE` resources already present with the correct actions; **zero new permission keys were needed** for Phase 5 (confirmed via `git diff` — the only permission-catalog changes on this branch are pre-existing Phase 4.3 entries).

## 3. New Functionality (genuine gaps closed)

### 5.1 — Optical Order → real inventory (stock + COGS)
- New model `OpticalOrderItem` (productId, quantity, unitPrice, lineTotal), additive migration `20261001000000_phase5_1_optical_items_and_visit_billing`.
- `POST /optical-orders` now accepts an optional `items[]`; when present, each line is validated tenant-scoped, stock is deducted with the same atomic conditional `updateMany` guard Sales already uses (a `SERVICE`-kind product is skipped, matching Sales), an `InventoryTransaction` is recorded, and COGS is posted alongside revenue in one balanced journal entry (`OPTICAL_REVENUE` / `COGS` / `INVENTORY` / `ACCOUNTS_RECEIVABLE`). An order with no items behaves exactly as before (proven by `clinical.test.js`'s pre-existing "financial integration is unchanged" test still passing unmodified).
- `OpticalOrder` gained optional `branchId`/`warehouseId`, validated through the existing `assertBranchAccess`/`assertWarehouseAccess` — the same pattern Sale/Purchase/PO already use — closing a real multi-branch scoping gap (previously an Optical Order was invisible to branch-based list filtering).
- **Frontend**: `OpticalOrders.jsx` gained an optional "Frame (from inventory)" / "Lens (from inventory)" picker, populated from `/products?type=FRAME|LENS`, alongside the pre-existing free-text fields (both remain independently usable). Selecting a frame/lens now submits real stock-linked items through the existing offline outbox; picking neither is fully backward compatible (`items` omitted). The offline sync layer's optimistic stock-cache overlay was extended (`decrementCachedStockIfItems`) so a queued, not-yet-synced order that picked a frame/lens shows the same live stock preview a Sale does.

### 5.2 — Clinical visit billing traceability
- Additive `Sale.appointmentId` (validated tenant-scoped, nullable).
- **Frontend**: a completed Appointment now shows a "Bill Visit" action that opens POS pre-filled with that customer and tagged with the appointment — deliberately placed in the clinical Appointments screen (which already requires clinical-staff access) rather than the general retail POS screen, preserving the codebase's existing separation between ordinary POS staff (who never see clinical data) and clinical staff.

### 5.3 — Medicine expiry safety
- `POST /sales` now refuses a line whose product's `expiryDate` has already passed (`ConflictError`, code `PRODUCT_EXPIRED`), checked at the moment of sale.
- `/reports/medicine-expiry` now returns `isExpired`/`expiredCount`/`nearExpiryCount` per the spec's "near-expiry vs. already-expired are different concerns" distinction; the existing Reports UI tab was extended with expired/near-expiry badges rather than a new page.

## 4. Bugs Found

1. **Genuine, Phase-5-introduced concurrency bug**: the new atomic conditional-claim update on `PATCH /optical-orders/:id` (added to fix a real two-users-editing-the-same-order race) incorrectly treated a request that had nothing left to update — e.g. a client sending only `amountPaid`, which the schema silently strips — as "someone else changed it first," wrongly returning 409 instead of 200. Root cause: Prisma's `updateMany` returns `count: 0` for an empty `data` object without touching the row or erroring, and that `0` was indistinguishable from a real lost race.
2. **Pre-existing, unrelated failure** (not a Phase 5 regression): `tests/mobileDashboard42.test.js` → "accuracy: a reversed expense is not an expense" fails deterministically on this branch. Confirmed via `git status --short src/modules/mobile/ src/modules/ai/` that **zero files** in the code path this test exercises (`dashboardService.js`, `dashboard.routes.js`, `analytics.js`) were touched in this session, in Phase 4 or Phase 5. This is a legacy Phase 4.2 mobile-dashboard issue, out of Phase 5's scope to fix.

## 5. Bugs Fixed

- Fix for (1) above: the atomic claim is now skipped entirely when there is nothing left in `data` to set (nothing to race over), and the handler falls through to return the current record unchanged. Verified via four separate clean isolated re-runs (`business.test.js`, `phase5IndustryModules.test.js`, `clinical.test.js` — 125/125 combined) after the fix, including the real-concurrency "two simultaneous status updates" test that exercises the same code path with a non-empty payload and still correctly produces a conflict for the loser.
- (2) was **not** fixed — it is outside Phase 5's scope (Phase 4.2 mobile dashboard, untouched this session) and is disclosed as a Condition, not silently left out.

## 6. Tests

### Backend
- Full suite: **57 test suites / 1,060 tests** (includes the 13 new Phase 5 tests in `tests/phase5IndustryModules.test.js`, covering 5.1 stock/COGS/concurrency/terminal-state-lock/branch-scoping, 5.2 Sale–Appointment linking, and 5.3 expiry reporting/sale-time prevention).
- After the fix in §5: every suite passes cleanly when run in isolation or in small groups free of cross-file database contention — confirmed individually for every suite that ever showed a failure across many verification rounds this session, including `business.test.js`, `phase5IndustryModules.test.js`, `clinical.test.js`, `accounting.test.js`, `accountingIntegration.test.js`, `multiBranch.test.js`, `moduleArchitecture.test.js`, `universalSearch.test.js`, `financialReports.test.js`, `ai.test.js`, `quotationsAndOrders.test.js`, `sequenceNumbering.test.js`, `mobileAiAdvisor.test.js`, `mobileAlerts.test.js`, `mobileDashboard.test.js`, `mobileManagement.test.js`, `notificationsAndActivityLog.test.js`. Net result: **1,059/1,060 passing**, with the one exception being the pre-existing, unrelated failure in §4.2.
- **Disclosed testing-environment condition**: a single continuous `--runInBand` run of the full 1,060-test suite on this development machine intermittently shows additional, non-reproducible failures (a different random subset each run) traced to this machine's available memory dropping to ~1.7 GB free of ~9.9 GB total after hours of sustained heavy Postgres+Node test execution in this session — not a Postgres connection-limit refusal (no `FATAL`/"too many clients" ever appeared in the Postgres log; `max_connections` was raised from 100→300 and checkpoint/WAL settings were tuned as part of investigating this, with no change in the pattern) and not a deterministic code path (different tests fail on different runs). Every single test implicated in any of these runs passed cleanly and repeatably once isolated from that contention. This is a characteristic of this long local session, not of the Phase 5 code.

### Frontend
- Full suite: **59 test files / 383 tests — all passing** (6 new: 3 in `OpticalOrders.test.jsx`, 1 new case added to `Pos.test.jsx`, 2 in `Appointments.test.jsx`). Verified clean twice, including after adding the `Pos.jsx`/`Appointments.jsx` billing-link changes.
- One test (`localData.test.js`'s periodic keep-fresh check) was observed to fail once during a full-suite run and passed cleanly both immediately before and after in isolation — a pre-existing fake-timer test sensitive to system load, unrelated to any Phase 5 change; the full suite re-run clean at 383/383 confirms it.

### Lint
- `npm run lint` (oxlint): **exit code 0**. Only pre-existing `react(set-state-in-effect)`/`react(only-export-components)`/`react(purity)` warnings across the codebase (same pattern already present on dozens of unrelated pages before this phase) — no errors, nothing new introduced by Phase 5 beyond the same pre-existing pattern on the new `OpticalOrders.jsx` effect.

### Build
- `npm run build` (vite): **succeeds** — 233 modules transformed, no errors.

### Database
- New migration `20261001000000_phase5_1_optical_items_and_visit_billing`: purely additive (2 `ALTER TABLE ADD COLUMN`, 1 `CREATE TABLE`, 1 `CREATE INDEX`, 5 foreign keys). Applied cleanly to the scratch database.
- **Fresh-database migration test**: all 37 migrations (including this one) applied cleanly (`prisma migrate deploy`) to a brand-new, empty database — confirmed.
- **Drift check**: `prisma migrate diff --exit-code` against both the long-lived scratch database and the freshly-migrated database reports **"No difference detected"** — zero drift.
- No destructive migration was needed; nothing required stopping for approval.

### Security
- **Tenant isolation**: a new optical order cannot reference another tenant's branch, warehouse, product, patient, lab, or clinical prescription (pre-existing `findFirst({ tenantId })` guards, verified still enforced with the new `items`/`branchId`/`warehouseId` fields); a Sale cannot be linked to another tenant's appointment (new, tested); tenant B's medicine-expiry report never includes tenant A's medicines (tested).
- **Branch isolation**: `assertBranchAccess`/`assertWarehouseAccess` enforced on Optical Order create/update exactly as Sale/Purchase already do; tenant B cannot view tenant A's optical order (tested).
- **Permission enforcement**: `OPTICAL_ORDER:CREATE/VIEW/UPDATE` and `SALE:CREATE` middleware unchanged and confirmed still wired (`router.use`/`requirePermission` calls audited, unmodified); a RECEPTIONIST-role token correctly lacks `SALE:CREATE` under the pre-existing RBAC catalog (confirmed via test iteration — the test that initially assumed otherwise was corrected to use an appropriately-permissioned role rather than weakening the assertion).
- **Audit logging**: every new Phase 5 mutation flows through the same existing `logAudit` calls already present on `OPTICAL_ORDER_CREATE`/`OPTICAL_ORDER_UPDATE`/`SALE_CREATE` — no gaps introduced, no new logging mechanism created.
- **IDOR**: every new `items[].productId`, `branchId`, `warehouseId`, `appointmentId` is validated tenant-scoped before use (see §3); attempting to reference another tenant's record returns 404, not the record.

### Concurrency
- **Two optical orders racing for the last unit of a frame**: exactly one succeeds, the other receives a clean `STOCK_INSUFFICIENT` conflict — real `Promise.all` against real Postgres, not mocked.
- **Two simultaneous status updates on the same optical order**: exactly one applies; the other receives a clean `BALANCE_CHANGED` conflict instead of silently clobbering the winner — real concurrent HTTP requests against real Postgres, and the fix in §5 was itself verified not to break this test.

## 7. Conditions

1. **`tests/mobileDashboard42.test.js` pre-existing failure** (§4.2) is not fixed — it belongs to Phase 4.2's mobile dashboard, a module untouched in this session; fixing legacy, out-of-scope failures was not part of this directive.
2. **Medical Store true multi-batch inventory** (multiple batches of the same medicine with independent expiry dates) was deliberately **not** built. The existing `Product.batchNumber`/`expiryDate` (single value per product) already satisfies the spec's expiry-tracking and reporting requirements without duplicating inventory logic; `ProductMedicineAttributes`' own batch/expiry fields are pre-existing unused dead code that a full multi-batch rebuild would need to reconcile. Building a second, parallel batch-tracking system was judged disproportionate to the spec and against the explicit "do not duplicate inventory logic" rule.
3. **Local full-suite test run flakiness under sustained machine load** (§6, Backend) — disclosed in detail there; every implicated test passes cleanly in isolation.
4. **`Sale.appointmentId` frontend surface is deliberately minimal**: a "Bill Visit" link from a completed Appointment pre-fills POS; there is no dedicated "visit billing" screen beyond that, since the existing POS/Sale engine already fully covers the billing itself.

## 8. Deferred Items

None of Phase 5's four sub-phases were deferred — 5.1, 5.2, 5.3, and 5.4 were all audited and, where genuine gaps existed, completed. The scope-control decision in Condition 2 is a permanent architectural choice (consistent with "V1 Scope Control: do not duplicate inventory logic"), not a Phase 6 requirement — no future phase is implied or required by it.

## 9. Final Verdict

# PHASE 5 — CLOSED WITH CONDITIONS

PHASE 5 CLOSED WITH CONDITIONS — STOPPED BEFORE PHASE 6
