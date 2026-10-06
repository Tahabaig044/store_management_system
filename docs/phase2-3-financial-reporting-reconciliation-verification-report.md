# Phase 2.3 — Financial Reporting & Reconciliation: Verification Report

**Verdict: CLOSED WITH CONDITIONS** (section 6). Phase 2.4 has **not** been started.

Test database: local portable PostgreSQL 16 (`akvisionflow_phase22`). Every run used an explicit `DATABASE_URL`; `backend/.env` (remote Neon) was not used. **No schema change in this phase** (no migration added).

## 1. Audit (before implementation)
Inspected the Phase 2.1/2.2 code and the existing reports (`reports.routes.js`), dashboard, `arapService`, frontend `Accounting.jsx`/`Reports.jsx`.

Verified existing and reused: journal-derived Trial Balance / P&L / Balance Sheet / Cash Flow / Cash & Bank Book (Phase 5, made reversal-correct in 2.1); the Phase 2.2 AR/AP read models (summary, statement, GL control balance); `branchScope` helpers; client-side CSV + print in `Reports.jsx` (there is no server-side export, so none was added).

Gaps found: no explicit branch/company filter on any statement; a bare-date `to`/`asOf` excluded that day's own entries; Cash/Bank Book running balance started from zero instead of the opening balance; no cash position report; no reconciliation of any kind; the Command Center's cash/bank figures ignored its branch filter and its net profit was document-derived, not ledger-derived.

## 2. Implemented
**Backend — one shared service** (`accounting/financialReportsService.js`), used by the report routes, the reconciliation and the dashboard so they agree by construction:
- Filters everywhere: `from`/`to`/`asOf`, `branchId`, `companyId`. Filters only **narrow** the caller's own branch access (a restricted user requesting another branch gets 403; company ∩ access; unknown ids from another tenant get 404). Bare dates mean start/end of that day.
- **Trial Balance** (`from` adds opening / period debit / period credit / closing), **Profit & Loss** (adds cost of goods sold, gross profit, operating expense), **Balance Sheet**, **Cash & Bank** position (per account opening/receipts/payments/closing + movement by source), **Cash/Bank Book** with the correct opening balance, **Cash Flow** (adds opening/closing), **KPIs**. Previous response fields are unchanged; new fields are additive.
- **Reconciliation** (`GET /accounting/reports/reconciliation`), one REPEATABLE READ snapshot so concurrent postings cannot make the parts disagree:
  - AR and AP: ledger control account vs the Phase 2.2 subledger; each differing party is classified (`MANUAL_OR_OPENING_ENTRIES`, `SETTLEMENT_HELD_ON_REVERSED_DOCUMENT`, `OPTICAL_ORDERS`, `UNTAGGED_LEDGER_ACTIVITY`) and anything else is `UNEXPLAINED` and fails the check.
  - Cash/bank ledger vs Payment records (cumulative), with the ledger movements that legitimately have no Payment row listed; tenant-wide only (reported as unavailable when branch-filtered, rather than guessed).
  - Standing checks: trial balance balances; no unbalanced journal entry exists (SQL check); AR/AP/cash reconciled → `allChecksPassed`.
- AR/AP summary and aging now accept `branchId`/`companyId` (the Phase 2.2 service gained an optional branch override).
- **Dashboard**: Command Center returns `accounting.ledger` (revenue, COGS, gross/net profit, cash, bank, receivables, payables from the ledger); its cash/bank now honor the branch filter.

**Frontend**: new *Financial Reports* page (`/accounting/reports`) — Trial Balance, P&L, Balance Sheet, Cash & Bank, Reconciliation; date/branch/company filters; CSV export (gated by the existing `REPORT:EXPORT`) and print; Command Center shows a "from the ledger" KPI row. CSV helper extracted to `utils/csv.js` (Reports.jsx now imports it; behavior unchanged).

**RBAC**: no new permission keys (`REPORT:VIEW` for reads, `REPORT:EXPORT` for the export button).

## 3. Bugs found and fixed
1. **Date-only `to`/`asOf` excluded the whole day** (`2026-09-24` meant midnight) → now end of day.
2. **Cash/Bank Book running balance ignored the opening balance** → now starts from the balance before the period; `openingBalance` returned.
3. **Concurrent first-time report loads on a new tenant returned 409**: `ensureChartOfAccounts` seeding raced on the unique index (found by the concurrency test). Seeding now serializes on a per-tenant advisory lock; it affected every ledger entry point, not just reports.
4. **Dashboard cash/bank ignored the branch filter** (showed tenant-wide balance) → scoped.
5. General ledger report ignored explicit branch/company filters → now honored.

## 4. Tests and exact results
- New `financialReports.test.js`: **22 tests**, passed on 3 consecutive runs — end-of-day dates; period view opening+movement=closing; branch/company filters partition the ledger (branches sum to the whole, each subset balances); P&L gross/net; balance sheet balances at tenant/branch/company level and agrees with P&L; cash & bank vs balance sheet vs KPIs; cash book opening balance; reversal of a sale flows through P&L/cash/reconciliation; reconciliation on standard flows (AR, AP, cash residual 0); explained differences (manual entry, payment on a reversed sale); **detection** of an orphan ledger posting and of an unbalanced entry written around the API; scoped reconciliation; AR/AP aging filters; dashboard KPI parity and branch-filtered cash; tenant isolation (404 on foreign branch/company ids); branch-restricted user (403 on another branch, narrowing never widens); RBAC (doctor 403, accountant 200, unauthenticated 401); concurrent access (reads during in-flight sales all 200 and self-consistent); legacy response shapes.
- New frontend `FinancialReports.test.jsx` (6) and a Command Center ledger-KPI test (1).

## 5. Regression results
| Check | Result |
|---|---|
| Backend full suite | **37/37 suites, 870/870 tests**, 0 connection errors |
| Frontend full suite | **34 files, 169/169 tests** |
| Lint | exit 0 (pre-existing warning classes only) |
| Build | succeeds (existing chunk-size advisory) |
| Permission-key parity | 126 permissions / 385 grants, unchanged |
| Migrations | no schema change; full history deploys on a fresh DB; `migrate diff` shows no drift |

Failures during the phase, investigated not dismissed: the reconciliation endpoint returned 500 (nested `$transaction` on a transaction client — my bug, fixed, and covered); the concurrency test failed 3/3 with 409 on cold-tenant chart seeding (real defect, fix in §3.3, then 3/3 green); a first version of the concurrency test aborted on a sale-number race in test *setup* (Phase 1.8 residual) — the writes were made tolerant since the test is about what reads see.

## 6. Known limitations, conditions and deferred items
Conditions/limitations:
1. **Subledger reconciliation is a current-position check** (open documents carry current balances); it cannot be run "as of" a past date.
2. Cash-to-payment-records reconciliation is **tenant-wide only**; branch-filtered views report it as unavailable.
3. **Optical-order receivables** are recognised only as a classification (`OPTICAL_ORDERS`); they are not in the document subledger (Phase 2.4/industry module).
4. In a branch-filtered statement, a standalone multi-allocation payment is shown regardless of branch (Phase 2.2 behavior), which can surface as a party difference in a branch-scoped reconciliation.
5. No period-close-to-equity: the Balance Sheet still shows cumulative profit as a computed "Retained Earnings (current, unclosed)" line.
6. Export is client-side CSV + browser print only (existing architecture); no PDF/server export.
7. Uncommitted work: all Phase 2.3 changes are in the working tree.

Deferred: period close / year-end and posted-period locking; comparative (period-over-period) statements; per-branch balance sheet with inter-branch clearing; the Phase 2.4 integration items already listed in the Phase 2.2 report (unifying sale-reversal/payment behavior, optical receivables, payment-method GL accounts); Owner Android dashboard consumption of `accounting.ledger`.

## 7. Offline boundaries
Everything added is read-only. No accounting write, outbox, or offline operation was introduced; the Phase 2.2 classification of unsafe-offline operations is unchanged. Reports are computed live, so an offline copy is stale by definition; the reconciliation depends on a server-side consistent snapshot and must not be computed client-side.
