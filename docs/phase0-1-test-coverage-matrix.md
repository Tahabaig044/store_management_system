# Phase 0.1 — Feature-to-Test Coverage Matrix

Evidence-based audit of the test suites in this repository as they exist on disk today. No code was changed to produce this document. No existing test was removed, weakened, or skipped.

## Methodology and a critical safety note on execution

**Backend tests were NOT executed.** `backend/.env` (the file Jest actually loads at run time) currently sets:

```
DATABASE_URL="postgresql://neondb_owner:...@ep-purple-feather-....neon.tech/neondb?sslmode=require..."
```

This is a live remote Neon Postgres database, not a local/disposable one — the commented-out line directly below it (`# DATABASE_URL="postgresql://postgres:postgres@localhost:5432/akvisionflow_test..."`) shows a local test DB was intended but is not the active configuration. Every backend integration test file (`business.test.js`, `multiBranch.test.js`, etc.) calls real HTTP routes via `supertest` against `require('../src/app')`, which reads live off `prisma` — i.e. `npm test` in `backend/` would write real rows (tenants, sales, users, journal entries) to whatever `DATABASE_URL` currently points at. Per the task's explicit constraint, this suite was **not run**; all backend figures below are from static reading of the test source (file paths and line numbers are cited so every claim is independently checkable).

**Frontend tests WERE executed** (`npx vitest run` in `frontend/`) because they run under `jsdom` with `apiClient` fully mocked (`vi.mock('../../api/client', ...)`) — no network calls, no database, confirmed by reading the test bodies first. Result:

```
Test Files  18 passed (18)
     Tests  72 passed (72)
```

Every backend count below is labelled **"not executed, counted from source"**.

---

## 1. Backend module coverage

Grep count is `it(`/`test(` occurrences in the named file(s); a module with no dedicated file but exercised inside another file's suite is marked accordingly.

| Module | Dedicated test file(s) | Type | Test cases (source count) | Notes |
|---|---|---|---|---|
| auth (login/register-tenant) | none dedicated; exercised as setup helper in every integration file; explicit checks in `tests/api.test.js` | Integration-API | ~5 direct (`api.test.js`) + implicit in all | `/api/auth/me` correctness itself is only ever called from `mobile.test.js:170`, a file whose target routes are currently unmounted (see Critical gap #1) |
| users | within `business.test.js` (RBAC, tenant isolation), `phase12Hardening.test.js` (audit log, no password leak) | Integration-API, Security-RBAC | ~4 | No dedicated users.test.js |
| branches | `business.test.js` (RBAC), `multiBranch.test.js` (dedicated "Branch management" + "Multi-branch user access" describes) | Integration-API, Security-RBAC | ~6 in multiBranch + 1 in business | Good coverage of open/close, access grant, RBAC |
| warehouses | `multiBranch.test.js` ("Warehouses and location-aware inventory", "Stock Transfer lifecycle") | Integration-API | ~15 | Strong: default-warehouse creation, receive/dispatch sync, transfer lifecycle, short/damaged qty, idempotency, tenant isolation |
| categories | `business.test.js` (RBAC, productCount), `phase12Hardening.test.js` (audit log) | Integration-API, Security-RBAC | ~5 | |
| customers | `business.test.js` (RBAC, tenant isolation, "Customer History"), `phase12Hardening.test.js` (audit log, PII-leak check) | Integration-API, Security-RBAC | ~9 | |
| suppliers | `business.test.js` (RBAC, "Supplier Ledger"), `phase12Hardening.test.js` (audit log) | Integration-API, Security-RBAC | ~6 | |
| products | `business.test.js` ("Barcode" describe, "Stock" describe, tenant-isolation-via-category test), `phase12Hardening.test.js` (PRODUCT_ARCHIVE audit) | Integration-API | ~13 | |
| inventory (`/api/inventory/transactions`) | one incidental call, `business.test.js:608` | None (incidental only) | ~0 dedicated | The stock-movement-history endpoint itself (filters, pagination, product join) has no assertions of its own |
| sales | `business.test.js` ("Sales / POS" describe — reversal, insufficient stock, invalid product), `multiBranch.test.js` (branch scoping) | Integration-API | ~10 | Reversal correctness (`business.test.js:747`) and reversal RBAC (`:777`) both covered |
| purchases | `business.test.js` ("Purchases" describe), `procurement.test.js` (GRN), `accounting.test.js` (posting) | Integration-API | ~12 | |
| payments | `business.test.js` ("Payments - Purchases", "Payments - Optical Orders" — partial/full/overpayment/double-payment), `phase12Hardening.test.js` (audit) | Integration-API | ~13 | The read-side aggregate `GET /api/payments` (joins Payment→sale/purchase/customer/supplier/expense) has **zero test references** anywhere in `tests/` — only the write-side `/pay` actions are tested |
| accounting | `accounting.test.js` (dedicated, large) | Integration-API | 27 | Strong: sale/purchase/expense posting, reversal mirror entries, period close/reopen, trial balance / balance sheet / P&L / AR aging |
| procurement | `procurement.test.js` (dedicated) | Integration-API, Security-RBAC | 17 | Purchase request → RFQ → PO → GRN full lifecycle, thresholds, idempotency, tenant isolation |
| clinical | `clinical.test.js` (dedicated) | Integration-API, Security-RBAC | 32 | Patients, doctors, appointments (conflict detection), examinations/prescription versioning, lab lifecycle, tenant isolation |
| opticalOrders | `business.test.js`, `clinical.test.js` (clinical-to-commercial integration), `accounting.test.js` (posting), `communication.test.js` (automation triggers) | Integration-API | ~10 (spread across files) | Well covered but no single dedicated file |
| portal | `communication.test.js` ("Customer Portal" describe) | Integration-API, Security-RBAC | ~8 | OTP flow, token/staff isolation, cross-customer isolation, cross-tenant isolation |
| communication | `communication.test.js` (dedicated) | Integration-API, Security-RBAC | 31 | WhatsApp send/idempotency/retry-backoff, templates, automation rules, business-event triggers, opt-out/redaction, tenant isolation |
| ai | `ai.test.js` (dedicated), `alertMapping.test.js` (pure unit) | Unit, Integration-API, Security-RBAC | 23 + 10 | Deterministic grounding, forecasting, anomaly detection, provider fallback/timeout, quota, "AI cannot mutate business data" guard |
| mobile (Owner Mobile API) | `mobile.test.js`, `mobileAiAdvisor.test.js`, `mobileAlerts.test.js`, `mobileDashboard.test.js` | Integration-API (currently non-functional — see Critical gap) | 20+16+21+12 = 69 | **See Critical Gap #1** — these test a route prefix not mounted in `src/app.js` |
| push | only inside `mobileAlerts.test.js` ("push device registration", "alert push dispatch") | None (routes unmounted) | 0 live | Same unmounted-route issue as `mobile` above |
| dashboard (Command Center) | no dedicated file; integration blocks inside `business.test.js`, `multiBranch.test.js`, `accounting.test.js`, `clinical.test.js`, `ai.test.js`, `communication.test.js` | Integration-API, Security-RBAC | ~15 spread | Well covered in aggregate; each phase adds its own KPI-block assertions |
| reports (`/api/reports/*`: daily/monthly sales, inventory) | `api.test.js:26` references `/api/reports/inventory` only as an "auth required" smoke check | None (functional) | ~0 functional | No test asserts the actual numbers these report endpoints return are correct — distinct from `accounting.test.js` reports (trial balance etc.), which cover a different module |
| settings | used as a helper (thresholds) inside `multiBranch.test.js`, `procurement.test.js`, `communication.test.js` (config) | Integration-API (incidental) | 0 dedicated | `PUT /:key` is `TENANT_ADMIN`-only in code (`settings.routes.js:16`) but no test ever calls it as a non-admin to confirm the 403; every call in the suite already uses the admin token |

## 2. Frontend coverage

18 test files, 72 test cases, all passing (executed above). Component style: `vitest` + `@testing-library/react`, `apiClient` (`axios` wrapper) mocked with `vi.mock`.

| Page/component | Test file | Cases | What it actually asserts |
|---|---|---|---|
| Modal | `components/Modal.test.jsx` | 4 | render show/hide, title/body/footer, onClose click |
| NotificationBell | `components/NotificationBell.test.jsx` | 2 | basic render/poll behavior |
| Pagination | `components/Pagination.test.jsx` | 4 | page navigation controls |
| ProtectedRoute | `components/ProtectedRoute.test.jsx` | 4 | redirect when unauthenticated/wrong role |
| StatusBadge | `components/StatusBadge.test.jsx` | 3 | label/color mapping |
| syncEngine (offline) | `offline/syncEngine.test.js` | 17 | queued-mutation replay logic against `fake-indexeddb` |
| currency utils | `utils/currency.test.js` | 9 | formatting/rounding |
| Accounting page | `pages/accounting/Accounting.test.jsx` | 2 | renders ledger data from mocked API |
| AiAssistant | `pages/ai/AiAssistant.test.jsx` | 3 | renders chat/answer flow |
| RecommendationCenter | `pages/ai/RecommendationCenter.test.jsx` | 3 | renders insight list, dismiss action |
| Login | `pages/auth/Login.test.jsx` | 2 | form submit, error display |
| AutomationRules | `pages/communication/AutomationRules.test.jsx` | 3 | renders/toggles rules |
| CommunicationCenter | `pages/communication/CommunicationCenter.test.jsx` | 4 | message list, send action |
| CommandCenter (dashboard) | `pages/dashboard/CommandCenter.test.jsx` | 5 | KPI widgets render from mocked payload |
| Patients | `pages/patients/Patients.test.jsx` | 2 | list + 360 view render |
| Procurement | `pages/procurement/Procurement.test.jsx` | 2 | list render |
| StockTransfers | `pages/warehouses/StockTransfers.test.jsx` | 2 | list render |
| Warehouses | `pages/warehouses/Warehouses.test.jsx` | 1 | list render |

**Pages with zero test file** (17 of 28, i.e. ~61% of pages): `RegisterTenant`, `Branches`, `Categories`, `Appointments`, `Doctors`, `Customers`, `Dashboard`, `Expenses`, `OpticalOrders`, `PortalDashboard`, `PortalLogin`, `Products`, `Purchases`, `Reports`, **`Pos` (point-of-sale/checkout)**, `SalesHistory`, `Suppliers`, `Users`. The POS/checkout screen — the highest-risk, money-handling UI page, and one of the files currently modified per git status — has no frontend test at all.

## 3. Cross-cutting risk coverage

| Risk | Coverage found | Evidence (file:line) |
|---|---|---|
| Cross-tenant data access | **Covered, broadly.** Nearly every module has an explicit "Tenant isolation" describe block. | `business.test.js:285-411` (generic "direct record access by ID is tenant-scoped for every module"), `multiBranch.test.js:524-547`, `accounting.test.js:523-542`, `clinical.test.js:471-497`, `communication.test.js:262-301,590-596`, `ai.test.js:130-158`, `procurement.test.js:339-357`, `mobileAiAdvisor.test.js:196-211` (unmounted route), `mobileDashboard.test.js:268-276` (unmounted route) |
| Cross-branch data access | **Covered.** Dedicated describe block. | `multiBranch.test.js:125-183` ("Branch-level RBAC / data scoping" — cashier sees only own branch's sales, direct-ID access to another branch's sale returns 404, MANAGER sees all branches, branch-access grant extends visibility) |
| Role escalation / RBAC bypass | **Covered, extensively**, but only for currently-mounted routes. | `business.test.js:119-284` (whole "RBAC" describe, plus "unauthenticated requests rejected for every module used above"), module-specific RBAC assertions throughout `clinical.test.js:135-163`, `communication.test.js:94-122`, `procurement.test.js:68-118,178-194`, `ai.test.js:87-101`. **Gap:** `settings.routes.js` TENANT_ADMIN-only write is never tested against a non-admin caller (see above) |
| Stock/inventory integrity under concurrent operations | **Missing.** No test performs two simultaneous writes to the same stock row. | Searched all of `tests/` for `concurrent`, `race condition`, `Promise.all`, `simultaneous`. The only `Promise.all` hits are `phase12Hardening.test.js:257,267` (parallel independent GETs to burst-test the rate limiter) and `mobileDashboard.test.js:185` (three independent read-only GETs compared for consistency) — neither exercises a write-write race on shared inventory/ledger state. Sequential-only stock tests exist (`business.test.js:614-706`), which do not surface race conditions (e.g. two POS terminals selling the last unit of the same product at once) |
| Sales transaction reversal correctness | **Covered.** | `business.test.js:747-790` ("a sale can be reversed exactly once, restoring stock and marking it REVERSED"; "sale reversal is restricted to MANAGEMENT roles"); ledger-level mirror-entry correctness in `accounting.test.js:171-196` ("reversing a sale posts an exact mirror entry, netting to zero on every account"); regression guard in `business.test.js:1213-1240` (reversed sale doesn't inflate receivables) |
| Payment-to-invoice linkage | **Partially covered.** Write-side (recording a payment against a purchase/optical order, balance/status computation) is well tested; the read-side ledger/reporting join is not. | Covered: `business.test.js:412-515` (Payments - Purchases / Optical Orders: partial, full, overpayment, double-payment, real Payment row recorded). **Not covered:** `GET /api/payments` (`payments.routes.js:10-34`, the endpoint that actually joins `Payment` to `sale`/`purchase`/`customer`/`supplier`/`expense` for reconciliation) has no test anywhere in `tests/` |
| Concurrency / race conditions (general) | **Missing** beyond the rate-limiter burst check noted above. No idempotency-under-parallelism test — the existing idempotency tests (`multiBranch.test.js:438-453`, `procurement.test.js:317-338`, `clinical.test.js:206-221`, `communication.test.js:134-152,380-397`) all send the retries **sequentially**, which verifies dedup logic but not an actual two-requests-in-flight-at-once race on the idempotency-key check-then-insert | (absence confirmed by full-suite grep, see above) |
| Migration safety / rollback | **Missing.** No test applies, reverts, or otherwise exercises a Prisma migration. | 11 migration folders exist under `backend/prisma/migrations/` (`20260828000000_init` through `20260915105019_phase3_owner_mobile_alerts_push`) with no corresponding migration-up/down test; the one Owner-Mobile migration is deliberately **not applied** in the environment this code runs in (see Critical Gap #1), and there is no test that would have caught that drift automatically — it's only discoverable by reading `app.js`'s comments |

---

## 4. Test Coverage Gaps (prioritized)

### Critical

1. **Owner Mobile test suite (69 test cases, 4 files) targets routes that are not mounted in the current application.** `src/app.js:84-90` and `:258-263` state the six Owner Mobile route mounts (`/api/mobile/v1/*`) are "deliberately NOT wired up... while that app is paused," pending an unapplied Prisma migration. Yet `tests/mobile.test.js`, `tests/mobileAlerts.test.js`, `tests/mobileAiAdvisor.test.js`, and `tests/mobileDashboard.test.js` all `require('../src/app')` and issue requests against `/api/mobile/v1/...`. Every one of those requests would currently receive the app's generic `404 { error: 'Not found' }` (`app.js:265`) instead of reaching the intended handler, so essentially all assertions in these four files (`expect(res.status).toBe(200)`, etc.) would fail if `npm test` were run today. **Net effect: despite ~1,037 lines and 69 test cases existing on disk, live coverage of the Owner Mobile surface — auth, RBAC, tenant isolation, alerts, push, AI advisor, dashboard — is currently zero.** This is a stale/drifted test suite, not a passing one, and it is not caught by CI unless someone actually runs the backend suite (which this audit was instructed not to do against the live DB in `.env`). Recommendation: either restore the six route mounts + migration together, or explicitly skip/quarantine these four files with a comment so a false sense of coverage doesn't persist.
2. **No test coverage for stock/inventory integrity under concurrent write operations.** All inventory- and stock-affecting flows (sale, purchase receipt, stock adjustment, warehouse transfer) are tested sequentially only. A real-world double-sale race (two POS terminals selling the last unit of the same product simultaneously) or a concurrent stock-adjustment-vs-sale race is entirely unexercised. Given this is a multi-branch, multi-terminal retail/clinic system, this is a plausible production bug class with no safety net.
3. **`DATABASE_URL` in `backend/.env` currently points at a live remote Neon database, with the local/test alternative present only as a commented-out line.** This is not itself a missing *test*, but it means the entire backend integration suite (14 files, ~340 test cases) is one accidental `npm test` away from writing throwaway tenants/sales/journal entries into what may be a production-adjacent database. No `.env.test` / CI-specific database config was found to structurally prevent this.

### High

4. **No concurrency/race test for idempotency-key deduplication.** All four idempotency tests found (`multiBranch.test.js:438`, `procurement.test.js:317`, `clinical.test.js:206`, `communication.test.js:134,380`) send the duplicate request only after the first has fully resolved, which validates the dedup *logic* but not that the check-then-act sequence is safe against two truly concurrent requests with the same key.
5. **`GET /api/payments`** (`backend/src/modules/payments/payments.routes.js:10-34`) — the endpoint that reconciles/join-queries `Payment` against `sale`, `purchase`, `customer`, `supplier`, and `expense` — has no test anywhere in the suite. Only the write-side `/purchases/:id/pay` and `/optical-orders/:id/pay` actions are tested.
6. **`/api/reports/*`** (`backend/src/modules/reports/reports.routes.js` — daily/monthly sales, inventory reports) has no functional test; the only reference (`api.test.js:26`) checks that the route requires auth, not that its output is correct. This is a different module from the well-tested `accounting.test.js` "Reports" describe (trial balance, P&L, etc.).
7. **POS/checkout page (`frontend/src/pages/sales/Pos.jsx`) has zero frontend tests.** It is also one of the files currently modified per git status. This is the highest-transaction-volume, money-handling screen in the product with no UI-level regression protection.
8. **No test verifies `settings.routes.js`'s `TENANT_ADMIN`-only restriction on `PUT /:key`** with a non-admin caller — every test that calls this endpoint already holds the tenant-admin token from `register-tenant`.

### Medium

9. **17 of 28 frontend pages (~61%) have no test file at all**, including `Products`, `Purchases`, `Customers`, `Suppliers`, `SalesHistory`, `Expenses`, `OpticalOrders`, `Users`, `Branches`, `Categories`, `Appointments`, `Doctors`, `Dashboard`, `Reports`, `PortalDashboard`/`PortalLogin`, `RegisterTenant` — several of these (`Customers.jsx`, `Expenses.jsx`, `OpticalOrders.jsx`, `Products.jsx`, `Purchases.jsx`, `Suppliers.jsx`) are also currently modified per git status with no accompanying test change.
10. **`/api/inventory/transactions`** (stock-movement history/report endpoint) has only one incidental reference (`business.test.js:608`) inside an unrelated stock-adjustment test; its own filtering/pagination/product-join behavior is unverified.
11. **No unit-level tests for shared utility modules** — `backend/src/utils/crudFactory.js`, `backend/src/utils/jwt.js`, `backend/src/middleware/auth.js` (all modified per git status) are exercised only indirectly through full HTTP integration tests, never in isolation. A regression in tenant-scoping logic inside `crudFactory` (used by many "generic" CRUD routes) would only surface as a failure in whichever integration test happens to hit it, not as a targeted unit failure pinpointing the cause.
12. **`GET /api/auth/me`** is only ever called from `mobile.test.js:170`, itself inside a currently-non-functional (unmounted-route) test file, so its correctness on the actually-live `/api/auth/me` mount (`app.js:208`) is effectively unverified.

### Low

13. **Migration safety/rollback is entirely untested** — 11 Prisma migrations exist with no up/down or drift test. Low priority mainly because Prisma migrations are largely additive/generated in this codebase and the one known-risky case (Owner Mobile migration deliberately unapplied) is already flagged as Critical Gap #1 above; a general migration-rollback test would still be good practice but is less urgent than the concurrency and stale-suite issues above.
14. **No dedicated `users.test.js` or `settings.test.js`** — both modules are adequately exercised as *helpers* inside other files' setup code, but neither has a home file asserting its own contract end-to-end (e.g., password hashing on user update, full settings key catalog).

---

## Appendix: raw counts

Backend (not executed — counted from source):

| File | Lines | it/test count |
|---|---|---|
| tests/accounting.test.js | 545 | 27 |
| tests/ai.test.js | 391 | 23 |
| tests/alertMapping.test.js | 98 | 10 |
| tests/api.test.js | 59 | 5 |
| tests/business.test.js | 1331 | 80 |
| tests/clinical.test.js | 509 | 32 |
| tests/communication.test.js | 648 | 31 |
| tests/mobile.test.js | 222 | 20 |
| tests/mobileAiAdvisor.test.js | 221 | 16 |
| tests/mobileAlerts.test.js | 314 | 21 |
| tests/mobileDashboard.test.js | 280 | 12 |
| tests/multiBranch.test.js | 548 | 28 |
| tests/phase12Hardening.test.js | 333 | 17 |
| tests/procurement.test.js | 364 | 17 |
| **Total** | **5863** | **339** |

Frontend (executed via `npx vitest run`):

```
Test Files  18 passed (18)
     Tests  72 passed (72)
   Duration  57.16s
```
