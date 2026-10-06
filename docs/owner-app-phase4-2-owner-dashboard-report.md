# Phase 4.2 — Owner Dashboard: Verification Report

**Status: PHASE 4.2 COMPLETE, WITH CONDITIONS — stopped for Product Owner approval. Phase 4.3 has not been started.**

## 1. Audit against the approved 4.2 scope (before any change)
Reused, not rebuilt: the `/api/mobile/v1/dashboard` service (built on `ai/analytics.js`), the Home/Analytics screens, the shared filter repository, the Alerts feature, the 4.1 session/permission/branch-context foundation.

| Scope item | Already there? | Gap found |
|---|---|---|
| Business KPIs | Yes (sales, profit, expenses, orders) | — |
| Sales / **purchases** | Sales yes | **No purchases figures at all** |
| Stock | Yes | Ignores the branch filter without saying so |
| **Cash / bank** | No | Nothing on the dashboard |
| Receivables / **payables** | Receivables yes | **No payables** |
| Expenses | Yes | **Counted reversed expenses (bug)** |
| Notifications / important alerts | Alerts tab only | Nothing on Home |
| Branch / **company** filter | Branch only | **No company filter**; a restricted user with several branches was forced to pick one |
| Offline | None | Screen showed nothing when the server was unreachable |

**Genuine accuracy bugs found in the existing figures (each proven failing before the fix, passing after):**
| # | Bug | Evidence (fixture) |
|---|---|---|
| B1 | Reversed expenses were included in expense totals, net profit and month figures | 800 shown, 600 correct |
| B2 | Reversed payments were counted as collections, and collections ignored the branch filter | 90 shown, 70 correct |
| B3 | "Payables" (AI analytics + would-be dashboard) included draft/cancelled/returned purchases that never arrived | 800 shown, 300 correct |

## 2. What was implemented
**Backend (reusing existing logic — no new business rules)**
- `GET /dashboard/purchases`: received purchases (total, count, previous period and % change — `null` when there is nothing to compare, never invented), daily trend, top suppliers, **payables** (outstanding, overdue >30 days, aging 0-30/31-60/61-90/90+, top creditors).
- `GET /dashboard/cash`: cash and bank opening/receipts/payments/closing plus where the money moved, computed by the **same function the web Cash/Bank report uses** (`financialReportsService.cashBank`), so phone and web cannot disagree.
- `/dashboard/summary` now also carries `purchases`, `payables`, `cash`; `inventory.scope = "ALL_BRANCHES"` (stock is held for the whole business, and the response says so).
- `companyId` on every dashboard endpoint: narrows to that company's branches via the existing `resolveBranchIds`, intersected with the user's own access (never wider; a branch outside the company yields nothing; another shop's company → 422). With no selection, a branch-restricted user now gets the combined figures of exactly their branches (replaces 4.1's "must pick one" limitation).
- `/dashboard/filters` returns companies, and branches know their company. `/alerts?important=true` (critical + important) for the Home strip. B1–B3 fixed.
- No schema change, no migration.

**Android (concise, owner/manager focused)**
- Home: new **Cash & Bank**, **Payables**, **Purchases** sections, a **stock scope** label, and an **important-alerts strip** (unread count + top three, tap → Alerts). Analytics: **Purchases** (trend, top suppliers) + **Payables Aging** and **Cash & Bank** (money in/out/net, sources).
- Company filter chip (shown only when the business has several companies); picking a company clears a branch that may belong to another; the branch list narrows to the company.
- **Offline-first, kept small:** the last successful summary is saved per filter selection (encrypted at rest), shown when the network or server is unreachable **dated and clearly marked** ("Showing saved figures from … may be out of date"), refreshed automatically when the connection returns, and deleted the moment the session ends. A real refusal (403, expired session, validation) is never hidden behind saved figures.

## 3. Verification
| Check | Result |
|---|---|
| Backend full suite (local PostgreSQL, real HTTP) | **48/48 suites, 967/967 tests** (was 47/957; +10 in `mobileDashboard42`, gating test updated) |
| Android JVM unit tests | **21 classes, 95 tests, 0 failures** (85 → 95) |
| Android lint | 0 errors, 0 warnings (lint XML) |
| Android build | `assembleDebug` and `assembleDebugAndroidTest` succeed |

Backend tests prove (independently computed numbers, and equality with the web's own report): purchases 450/2, payables 300 (draft excluded), expenses 600 (reversed excluded), collections 70 and receivable 30 (reversal restored the invoice), company A vs B vs whole business (sales 300/100/400, purchases 300/150/450, expenses 500/100), branch-outside-company = 0, cash/bank closing balances **identical to `/api/accounting/reports/cash-bank`** for the whole business and for a company, foreign company/branch → 422, permission (`REPORT:VIEW`) and read-only rules on the new routes, a restricted user's combined scope.
Android tests prove: **contract tests parse REAL server responses** (saved from the backend test) with the app's own models; saved figures shown/marked/per-selection and never used for a real refusal; alerts strip contents and the `important` request; company filter query and branch reset.

## 4. Conditions / what could NOT be verified
1. **No real Android device/emulator run** (virtualization disabled in this machine's firmware). Compose rendering of the new sections, the encrypted snapshot storage on a real Keystore, and the real connectivity-triggered refresh are **NOT VERIFIED on a device**; only their logic (JVM) and compilation are. No new instrumented test was added for 4.2 beyond 4.1's, because it could not be executed here.
2. **Stock is not branch-filtered** (unchanged design: stock is held per product for the whole business). It is now labelled as such rather than silently ignoring the filter. Per-warehouse stock by branch would be new logic and was not built.
3. **Alerts are not branch/company-filtered** (they are business-level AI insights, as on the web).
4. Cash/bank uses the ledger's branch attribution: entries with no branch are excluded when a branch/company is chosen — the same rule as the web report.
5. The saved-figures copy covers the Home summary only (the main KPIs); Analytics sections need the network. Fuller offline viewing belongs to 4.4.
6. Restricted-branch mobile sessions are still not reachable with real users (managers/owners are never branch-restricted under the existing web rule); that path is proven with a controlled scope.
7. README updated for the new endpoints/parameters.

**Stopping here for Product Owner approval of Phase 4.2. Phase 4.3 has not been started.**
