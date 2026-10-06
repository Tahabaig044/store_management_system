# Phase 2.1 — Chart of Accounts & General Ledger: Verification Report

**Verdict: CLOSED WITH CONDITIONS** (conditions listed in section 8). Phase 2.2 has **not** been started.

## 1. Implemented

**Schema (additive, one migration: `20260924000000_phase2_1_chart_of_accounts_general_ledger`)**
- `Account.description`; `JournalStatus` gains `DRAFT` and `CANCELLED`.
- `JournalEntry`: `reference`, `idempotencyKey` (`@@unique([tenantId, idempotencyKey])`), `createdById`, `postedAt` (existing rows backfilled from `createdAt`).

**Chart of Accounts** (`accountingService.js`, `accounts.routes.js`)
- Tenant-scoped, industry-neutral (18 default accounts, none industry-named; verified by test). Types Asset/Liability/Equity/Revenue/Expense, parent/child tree, code + name + description, active/inactive.
- Unique code per tenant; parent must be same tenant, same type, active, and not create a cycle.
- Deactivation/deletion blocked when unsafe (system accounts, accounts with ledger lines, with children, or used as a system mapping).
- Endpoints: list, tree (with rolled-up balances), detail (totals/line count), create, update, delete.

**General Ledger** (`journal.routes.js`)
- Manual entries with draft/post workflow: create (draft or immediate post), edit draft, post, cancel draft, reverse (`/void` alias kept).
- Every posted entry: ≥2 lines, one-sided lines, active same-tenant accounts, customer/supplier tenant checks, Debit = Credit; closed-period check.
- Posted entries are immutable through the API; correction is by reversal (mirror entry, original → `VOID`).
- Entry detail returns full source traceability (Sale, Purchase, returns, Payment, Expense, Credit/Debit Note, Optical Order incl. reversal/refund variants).
- List filters: status, search, sourceType, date range, account, branch.

**Opening balances** (`openingBalances.routes.js`): controlled, TENANT_ADMIN-only; automatic `OPENING_BALANCE_EQUITY` offset so the entry always balances; only one active opening entry (409 on duplicate; re-post allowed after reversing).

**Concurrency/idempotency**: per-tenant transaction advisory lock, atomic conditional `updateMany` claims (DRAFT→POSTED / CANCELLED, POSTED→VOID), whole-transaction retry on entry-number collision, `idempotencyKey` replay.

**RBAC**: new `ACCOUNT` and `OPENING_BALANCE` resources, `JOURNAL` extended with UPDATE/APPROVE/REVERSE; seeded through the Phase 0.4 catalog.

**Frontend**: Chart of Accounts (tree, create/edit/detail), Journal Entries (list, create/edit with live balance check, detail, post/cancel/reverse), Opening Balances; routes, permission-gated sidebar entries, POSTED/VOID status badges.

## 2. Verified existing (integration audit)
Sales, Purchases, Payments, Expenses, Sales/Purchase Returns, Credit Notes, Debit Notes and Optical Orders all post through `postJournalEntry(tx, …)` inside their own business transaction, and reverse through `reverseJournalEntry`. Not rewritten. Existing `accounting.test.js` (27 tests) passes unchanged.

## 3. Bugs found and fixed
1. **Reports counted only `POSTED` entries**, so once an entry was reversed (original → `VOID`) the reversal appeared alone: trial balance, P&L, balance sheet, ledger and dashboard showed the mirror as a negative (reproduced: Cash credit 20). Fixed with `LEDGER_STATUSES = ['POSTED','VOID']` in all report queries and the dashboard; DRAFT/CANCELLED never reach the ledger.
2. **Reversal race**: two concurrent reversals of one entry could both post a mirror. Now an atomic status claim; the loser gets 409 (tested).
3. **Journal source lookup** covered only some source types; expanded (see §1).
4. **Manual-entry validation gaps** (inactive/foreign accounts, customer/supplier tenant) closed.
5. **Test-infrastructure defect (pre-existing)**: 27 suites never disconnect their Prisma pool; in a full `--runInBand` run pools accumulated until Postgres answered "too many clients already", failing 11–12 unrelated suites. Fixed centrally (`jest.config.js` + `tests/setupDisconnect.js`, `afterAll` disconnect). Not a product bug.

## 4. Tests
- New backend suite `chartOfAccountsGeneralLedger.test.js`: **41 tests** — tenant isolation, RBAC, hierarchy, duplicate codes, invalid parents, deactivation/deletion rules, balanced/unbalanced, posting, draft workflow, reversal, source traceability, opening balances (offset, duplicate, re-post, TENANT_ADMIN-only, idempotency, concurrency), 10 concurrent posts, same-draft double post, post vs cancel, concurrent reversal, idempotency race, mixed manual+sale concurrency, permission parity, unchanged existing behavior, industry-neutrality.
- New frontend `AccountingPhase21.test.jsx`: **11 tests** (tree, permission gating, duplicate-code error, system-account actions, reverse visibility, draft post, live balance gating, opening-balance preview/posted/no-permission).

## 5. Regression results
| Check | Result |
|---|---|
| Backend full suite (`jest --runInBand`, local PG16 DB `akvisionflow_phase21`) | **35/35 suites, 808/808 tests**, 0 connection errors (final run) |
| Frontend `vitest run` | **32 files, 151/151** |
| Frontend lint | exit 0 (warnings only, same `set-state-in-effect` style as existing pages) |
| Frontend build | succeeds (existing chunk-size warning only) |
| Permission parity | 126 permissions / 385 grants (was 117/366: +9 / +19 = ACCOUNT 4/9, OPENING_BALANCE 2/4, JOURNAL +3/6); `permissionsArchitecture.test.js` passes |
| Migration verification | `migrate deploy` of full history on a fresh DB succeeds; `migrate status` up to date; earlier `migrate diff` showed no drift |

**Failure investigation (not classified as flake without evidence):**
- `accounting.test.js` 1 failure in an early full run (`Can't reach database server`, dashboard.routes.js) → isolated re-run 27/27 pass.
- Full run #1: 12 suites / 176 tests failed; log contained `FATAL: sorry, too many clients already` (17 occurrences in run #2). `pg_stat_activity` afterwards showed 6 connections (max 100), i.e. transient accumulation. Isolated retry of the 12 failed files: **12/12 suites, 190/190 pass, 0 connection errors**. Run #2 reproduced the same pattern on different suites → reproducible, so root-caused (leaked Prisma pools, §3.5), fixed, and confirmed by the clean full run #3.
- Note: `backend/.env` points at a remote Neon database; all runs used an explicit `DATABASE_URL` for the local database.

## 6. Known limitations
- Business modules' own postings do not take the per-tenant journal lock; a rare entry-number collision between a business posting and a manual posting is still possible (manual/opening paths retry; business paths do not).
- `postJournalEntry` does not validate account tenant/active state for business callers (only the manual path does).
- No DB-level immutability trigger; immutability is enforced at the API/service layer.
- No "header/non-postable" account concept; no closed-period/year-end handling beyond the existing period check.
- Opening AR/AP balances are not tied to individual invoices (aging derives from documents).
- Default `OPTICAL_REVENUE` account is industry-specific (pre-existing, retained for Optical orders).

## 7. Deferred
- **Phase 2.2/2.3**: reporting on the ledger (period closing, account statements beyond current), invoice-level opening balances, non-postable header accounts.
- **Phase 2.4 integration gaps**: PAYMENT entries' `sourceId` is ambiguous (sale/purchase id vs payment id); expense-category sub-account code generation (`51xx`) can collide with user-created codes; business postings should adopt the shared lock and account validation; OPTICAL_REVENUE default should move to the Industry Module phase.
- **Offline (Phase 3)** — nothing blocks the sync engine, but these are server-authoritative and **unsafe to queue offline blindly**: manual and opening-balance posting, draft posting, reversal, account deactivation/re-parenting/deletion. They rely on server-side sequential entry numbers, the tenant lock, and current account state; Phase 3 must define conflict handling (or block them offline). Idempotency keys are available for safe replay of manual entries.

## 8. Conditions
1. Business-module postings not yet using the shared lock/validation (Phase 2.4).
2. Test suites should be run against an explicit local `DATABASE_URL`, never the `.env` remote database.
3. Uncommitted work: all Phase 2.1 changes are in the working tree, not committed.
