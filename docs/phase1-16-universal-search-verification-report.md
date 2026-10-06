# PHASE 1.16 — UNIVERSAL SEARCH: IMPLEMENTATION & VERIFICATION REPORT

**Date:** 2026-09-24
**Scope:** A central, permission-aware, tenant/branch/warehouse-safe search API (`GET /api/search`) and a global search bar in the application header.
**Test database:** local, throwaway Postgres (`akvisionflow_phase116`) via the portable instance at `D:\pgsql-portable`. No production database was touched.

---

## 1. Executive Summary

Phase 1.16 began with an audit of the existing search architecture. It found that search was **100% siloed**: most list endpoints have their own `?search=` filter (each on a different, usually narrow, set of fields), but **no cross-module search endpoint and no global search UI existed anywhere**, and six entity types (Payment, Purchase Request, RFQ, Purchase Order, Goods Receipt, Notification) plus Product Variant had no search capability at all.

This phase added, additively and without touching any existing module's own search:

- A new module, `backend/src/modules/search/search.routes.js`, mounted at `GET /api/search`, searching **20 entity types plus Notifications** in one call, gated per entity type by the **existing Phase 0.4 permission catalog** (`hasPermission(role, resource, 'VIEW')`) — no second permission system.
- Two modes: a bounded, grouped, relevance-ranked **multi-entity "quick search"** (max 5 results per entity type, 100 overall), and a **single-entity paginated** mode (`?entity=CUSTOMER&page=&pageSize=`).
- Deterministic relevance (exact → prefix → contains), applied in application code on a bounded candidate set. No AI/semantic/fuzzy claims.
- A new header component, `GlobalSearch.jsx` (debounced, grouped, keyboard-navigable, loading/empty/error states), with `?search=` deep-links into eight existing list pages.
- Four plain btree indexes on the previously unindexed `Customer`/`Supplier` `phone`/`email` columns.

One real defect was found and fixed by this phase's own manual verification: the initial multi-entity fan-out fired ~19 Prisma queries simultaneously and **reproducibly failed once on a cold connection pool** (`Can't reach database server`); it now runs in bounded batches of 6 (Section 14/22).

**Overall result: PHASE 1.16 — CLOSED WITH CONDITIONS.** See Section 28.

---

## 2. Existing Search Architecture Audit

Read/verified before any code was written (repo-wide greps plus a full audit of routes, schema, permission catalog, frontend, offline layer and mobile module):

- **No global endpoint**: `app.js` mounts no `/search`; greps for `globalSearch|universalSearch|/search` across `backend/src` and `frontend/src` returned zero matches.
- **No global UI**: `Layout.jsx`'s header held only the sidebar toggle, sync widget, notification bell, theme toggle, user chip and logout. Every existing search input is per-page (`Products.jsx`, `Expenses.jsx`, `Quotations.jsx`, `SalesOrders.jsx`, `ActivityLog.jsx`, POS's client-side product filter).
- **Per-module fields (unchanged by this phase)**: Product `name/sku/barcode`; Customer/Supplier `name/phone/email/code` (via `crudFactory`); Sale `invoiceNumber`; Purchase `purchaseNumber`; Expense `expenseNumber/description`; returns/notes/quotation/order — document number only; Activity Log `action/entity/entityId`. **No `?search=`**: Payment, Purchase Request, RFQ, Purchase Order, Goods Receipt, Notification, Product Variant.
- **Indexes**: document numbers, SKU, customer/supplier `code` were already `@@unique([tenantId, …])`; barcode `@@index([tenantId, barcode])`. **`Customer`/`Supplier` `phone`/`email` had no index at all.** No `pg_trgm`/GIN/full-text index exists anywhere. Because every `contains` filter is `ILIKE '%term%'`, btree indexes cannot accelerate the wildcard match itself (verified with `EXPLAIN`, Section 14).
- **RBAC**: the catalog gave a clean resource-name mapping; `NOTIFICATION` has no catalog resource (self-scoped by design since Phase 1.15) and needed special-casing.
- **Existing tests**: per-module `?search=` assertions only; no cross-module test. **Mobile**: no search endpoint or test in `backend/src/modules/mobile`. **Offline**: only POS's in-memory product filter over the Dexie `products` cache.

Nothing existing was rebuilt or modified in behavior; the per-module list endpoints and their own `?search=` are untouched.

---

## 3. Searchable Entities

Final list (`ENTITIES` registry + Notification special case):

Product, Product Variant, Customer, Supplier, Sale, Purchase, Payment, Expense, Sales Return, Purchase Return, Credit Note, Debit Note, Quotation, Sales Order, Purchase Request, RFQ, Purchase Order, Goods Receipt, User, Activity Log, Notification (own only).

Decisions on entities the task listed conditionally:
- **"Inventory/Stock references"**: not a separate type. Stock is a field on Product (`stockQuantity` is returned in Product results' `metadata`); a duplicate "inventory" entity would be redundant. `WarehouseStock` rows are not searched.
- **Users**: only if the caller has `USER:VIEW` (TENANT_ADMIN only). Returned fields: name, email, role, active flag — never `passwordHash`.
- **Activity Log**: only with `AUDIT_LOG:VIEW` (MANAGEMENT).
- **Notifications**: only the caller's own (`userId = req.user.id`), regardless of role.
- **Not searched**: Journal entries, Optical/clinical entities (Patients, Appointments, Optical Orders) — deliberately excluded to keep the universal core industry-neutral.

---

## 4. Search Fields

| Entity | Matched fields |
|---|---|
| Product | name, sku, barcode, brand |
| Product Variant | name, sku, barcode, parent product name |
| Customer / Supplier | name, code, phone, email |
| Sale | invoiceNumber, customer name |
| Purchase | purchaseNumber, supplier name |
| Payment | receiptNumber, customer name, supplier name |
| Expense | expenseNumber, description, category name, supplier name, payee name |
| Sales/Purchase Return | returnNumber, customer/supplier name |
| Credit/Debit Note | note number, customer/supplier name |
| Quotation / Sales Order | own number, customer name |
| Purchase Request / RFQ / Goods Receipt | own number |
| Purchase Order | poNumber, supplier name |
| User | name, email |
| Activity Log | action, entity, entityId |
| Notification | title, body |

Gaps against the task's wish-list, disclosed: Product **category name** is not searched (brand free-text is); Sale/Purchase free-text `notes` and "reference" beyond the document number are not searched; Return/Note "original document" number is not searched (the parent's own number is); Goods Receipt/PR are not searched by supplier (they carry none directly). Password hashes, tokens and credentials are never selected, matched, or returned.

---

## 5. Central Search API

`GET /api/search` — authenticated, tenant-scoped.

| Param | Notes |
|---|---|
| `q` | required, ≤200 chars, whitespace-normalized; empty/whitespace-only → `422` |
| `entity` | optional; case-insensitive registry key or `NOTIFICATION`; unknown → `422` |
| `page`, `pageSize` | single-entity mode only (shared `parsePagination`: default 20, max 100) |
| `branchId`, `warehouseId` | optional; validated with `assertBranchAccess` / `assertWarehouseAccess` (403 if not the caller's) |
| `from`, `to` | optional; applied to each entity's own date column (`createdAt`, `quotationDate`, `expenseDate`) |

Validation is Zod-based; no arbitrary query, field, sort or operator is accepted from the client. Every query is a Prisma parameterized `findMany`/`count` — **no `$queryRaw`/`$executeRaw` anywhere in the module**.

---

## 6. Result Structure

Multi-entity: `{ query, groups: [{ entity, count, items }], totalGroups, totalResults }`. Single-entity: `{ items, total, page, pageSize, entity }`.

Every item: `{ entityType, entityId, title, reference, subtitle, status, metadata, route }`. Fields come from an explicit per-entity `select`, so only UI-needed columns are read from the database at all. `metadata` carries small display facts (e.g. `total`, `paymentStatus`, `stockQuantity`).

---

## 7. Permission-Aware Search

Before an entity type is queried, `hasPermission(req.user.role, resource, 'VIEW')` (the existing centralized function) must pass; otherwise that entity's table is **never queried** and it is absent from results. Verified over real HTTP with real role users:

- `RECEPTIONIST` (no `SALE:VIEW`): no Sale/Quotation/Sales Order/Sales Return results, in multi-entity or direct single-entity mode.
- `STORE_KEEPER` (not finance staff): no Payment/Expense/Credit Note/Debit Note results.
- `MANAGER`: no User results (`USER:VIEW` is TENANT_ADMIN-only).
- `CASHIER`: no Activity Log results (`AUDIT_LOG:VIEW` is MANAGEMENT-only).
- Notification search is available to any authenticated role but strictly own-rows.

A denied single-entity request returns an empty page (`200`, `items: []`) rather than `403` — deliberately, so entity-type existence is not distinguishable from "no matches."

**Limitation (Section 25.4):** permission is checked per request from the role/grant tables; there is no per-request cache in search itself beyond the existing `loadGrants()` cache in `permissions.js`, so a grant change is visible on the next search once that cache refreshes — the same staleness characteristic every `requirePermission` route already has.

---

## 8. Tenant / Company / Branch / Warehouse Isolation

Enforced server-side in every query (`tenantId` is always in the `where`):

- **Tenant**: Tenant B searching Tenant A's unique token gets zero groups (multi-entity) and zero items (direct). Verified.
- **Branch**: branch-aware entities merge `branchScopeWhere` (Sale, Purchase, Payment, Expense, Sales/Purchase Return, Credit/Debit Note, Quotation, Sales Order, Purchase Request, Purchase Order, Activity Log). A `CASHIER` assigned to Branch 1 cannot find a Branch-2 sale by its exact invoice number; a Branch-2 cashier can. An explicit `branchId` outside the caller's access → `403`. Verified.
- **Warehouse**: an explicit `warehouseId` outside the caller's access → `403`. Verified.
- **Company**: enforced **transitively via `Branch.companyId`**, exactly like every other transactional document (they carry no `companyId` column) — covered by the branch tests, not a separately-tested path.

**Limitation (Section 25.2):** entities with no branch column in their own model — Product, Product Variant, Customer, Supplier, RFQ, Goods Receipt, User, Notification — are tenant-wide in search exactly as they are in their own native list endpoints. `warehouseId` is only *validated*; it does not row-filter results, because no entity in the search set carries per-warehouse row-level ownership that its own list endpoint enforces by default (`Sale.warehouseId` etc. are attribution-only, Phase 1.8–1.10). Search therefore adds no new leak versus the existing endpoints, but it also provides no warehouse isolation beyond them.

---

## 9. Search Relevance

Deterministic, three-tier, no scoring engine: exact (rank 0) → prefix (1) → contains (2), taken as the best rank across the entity's designated match fields (e.g. for Customer: name, code, phone, email). Applied in the multi-entity mode: each entity's query fetches up to 15 candidates, ranks in JS, returns the top 5. Verified: an exact-name customer sorts before a "contains" one; a prefix supplier sorts before a mid-string one.

Not claimed: fuzzy matching, typo tolerance, stemming, synonyms, semantic search — none implemented. **Limitation (Section 25.1):** ranking happens on a bounded candidate window (15/entity), not the full table — in a tenant with >15 matching rows for a type, a better-ranked match beyond the window (the candidates come back in arbitrary/`createdAt desc` order) could be missed by quick search. Single-entity paginated mode does **not** re-rank: it keeps each module's natural order (newest first), because correct relevance-plus-pagination would need SQL-level ranking (`CASE`/raw SQL or trigram similarity), which was deliberately not introduced.

---

## 10. Multi-Entity Search

Grouped per entity type (`groups[].entity`), each item self-identifying via `entityType`; per-type cap 5, overall cap 100 (trimmed group-by-group, never mid-group). Only non-empty groups are returned. Verified that a single query returns Product/Customer/Supplier groups, each item typed correctly, none over 5.

---

## 11. Frontend Global Search

`frontend/src/components/GlobalSearch.jsx`, mounted in the `Layout.jsx` header: input with search icon and clear button; 350 ms debounce (one request per typing burst, verified); loading, empty and error states; results grouped under readable headings with status badges; ArrowUp/ArrowDown/Enter/Escape keyboard handling; click-outside close; Bootstrap classes only, no new UI library. Four component tests (debounce+grouping, navigation and non-clickable null-route items, empty/error states, clear).

**Disclosed:** the bar is hidden below the `md` breakpoint (`d-none d-md-block`) to avoid overcrowding the mobile-web header, so on small screens there is currently no global-search entry point (Section 25.7). There is no in-dropdown "load more"; deeper browsing happens on the destination page (single-entity paginated API mode exists but no UI is built on it yet).

---

## 12. Deep Links

Result `route`s point only at existing pages: `/products`, `/customers`, `/suppliers`, `/sales-history`, `/purchases`, `/expenses`, `/credit-notes`, `/debit-notes`, `/quotations`, `/sales-orders`, `/procurement`, `/users`, `/activity-log`, `/notifications`. Clicking navigates to `route?search=<reference or title>`.

- **Pages that pre-fill from `?search=`**: Products, Customers, Suppliers (Customers/Suppliers already did), Sales History, Expenses, Credit Notes, Debit Notes, Quotations, Sales Orders, Activity Log (eight pages edited additively, one line each; their existing tests were updated only to wrap renders in `MemoryRouter`).
- **Pages that navigate but do not pre-filter**: Purchases (no search UI/endpoint exists), Procurement (PR/PO/GRN share one tabbed page with no search), Users (no filter UI), Notifications (no search filter). Payments and Sales/Purchase Returns route to their parent pages (`/customers`, `/sales-history`, `/purchases`) because they have no dedicated screen.
- **RFQ has no frontend screen at all** (pre-existing Phase 1.9 gap): its results return `route: null` and render as non-clickable text with an explanatory tooltip.
- No detail page per record exists in the app (modules open modals), so links land on a filtered **list**, not on the specific record's detail view. No duplicate detail pages were created.

---

## 13. Pagination

Multi-entity: fixed caps only (5/type, 100 total) — never unbounded. Single-entity: real `skip/take` with an accurate `count`; verified with 15 rows → page 1 = 10, page 2 = 5, no overlap, `total = 15`. Multi-entity cap verified with 20 matching products → ≤5 returned. Only bounded windows are ever loaded; no table is read wholesale.

---

## 14. Database / Performance

- **Queries**: one bounded `findMany` per permitted entity (multi-entity) or one `findMany` + one `count` (single-entity); relations are eager-loaded through `select` (no N+1); no raw SQL.
- **Bounded fan-out (found and fixed this phase)**: the first implementation ran all ~19 entity queries in one `Promise.all`. On a cold Prisma pool the very first request failed reproducibly (`Can't reach database server`) while an immediate retry succeeded. They now run in batches of 6 (`mapWithBoundedConcurrency`); three consecutive cold-start smoke runs and a 5-way concurrent-search test then passed. **Residual risk:** under heavy simultaneous usage (many users × 6 concurrent queries each) the client pool can still be a bottleneck; pool sizing (`connection_limit`) was not tuned or load-tested.
- **Indexes added** (only where justified, plain btree, no extension, no Prisma-invisible DDL that later `migrate diff` runs could drop): `customers(tenantId, phone)`, `customers(tenantId, email)`, `suppliers(tenantId, phone)`, `suppliers(tenantId, email)` — migration `20260923000000_phase1_16_universal_search`, verified on a fresh database.
- **What is and isn't accelerated** (checked with `EXPLAIN`): the `tenantId` predicate uses a tenant-prefixed index; the `ILIKE '%term%'` part is applied as a *filter* and is **not** index-accelerated. `pg_trgm`/GIN was deliberately not introduced (it would need a Postgres extension and hand-written DDL that Prisma's diffing would try to drop).
- **Not load-tested**: correctness was verified with tens of rows per type, not hundreds of thousands. At large tenant scale, unanchored substring search across ~20 tables will degrade; trigram indexes or full-text search are the recommended next step (Section 26).

---

## 15. Search Normalization

Query is trimmed and internal whitespace runs are collapsed to one space; matching is case-insensitive (Prisma `mode: 'insensitive'`), so `zephyr`, `ZEPHYR` and `  Zephyr  ` behave identically. Partial references, SKUs, barcodes, phone numbers and email fragments match via `contains`. **No digit-only phone reformatting** (e.g. `0300-123` vs `0300123`) and no accent folding: stored values are compared as stored, so a differently-formatted phone will not match — a disclosed limitation chosen over a lossy transform that could change business meaning. `_` and `%` in a query are passed as parameters to Prisma's `contains`, which escapes LIKE wildcards; they match literally.

---

## 16. Security Testing

Verified over real HTTP: empty and whitespace-only query → `422`; unknown `entity` → `422`; quotes (`O'Brien`), `%`, `_`, unicode (`日本語テスト`), 200-char strings, multiple spaces, `<script>` markup → `200`/`422`, never `500`; SQL-injection strings (`'; DROP TABLE customers; --`, `' OR '1'='1`, `%' OR 1=1 --`, stacked `SELECT`) → `200` with literal matching, and the customers table and its rows are confirmed intact afterward. Over-length `q` (>200) is rejected by schema validation.

---

## 17. Result Data Security

Each entity's `select` is explicit: no `passwordHash`, tokens, authentication data, payment credentials or internal foreign keys are selected. Financial figures (`total`, `amount`, `paymentStatus`) appear only for entity types the caller's role may VIEW. Cross-tenant and cross-branch rows are excluded in the query (Section 8), not filtered afterward.

---

## 18. Activity / Audit Decision

**Ordinary searches are deliberately not written to the Activity Log.** Search is read-only and high-frequency (debounced typing produces many requests); logging every query would create audit noise and add a write to a read path, and no existing security requirement mandates it. Sensitive entity types are already protected by permission gating (User, Activity Log are MANAGEMENT/TENANT_ADMIN-only). If a future compliance requirement demands access logging for those entity types, it can be added through the existing `logAudit()` service; nothing here blocks that. Note that the search query text itself may contain sensitive strings and is therefore also not persisted.

---

## 19. Offline-First

No offline universal search was built. The only pre-existing local search is POS's in-memory product filter over the Dexie cache, left untouched. The Dexie cache holds only products/customers/suppliers/expense categories, so a local "universal" search would present a small subset as if complete — explicitly avoided. When offline, the global search request fails and the bar shows the existing error state (no fabricated or stale cloud results are ever presented). No new sync framework or outbox was added. **Limitation:** there is no explicit "search unavailable while offline" message beyond the generic request error.

---

## 20. Mobile Verification

Audited: the Owner Android backend (`backend/src/modules/mobile`) has no search endpoint and no search test. Universal Search was **not** exposed under `/api/mobile/v1` and no mobile screen was touched, per the instruction not to expand scope. `/api/search` uses the staff web JWT; Owner mobile clients cannot use it. Documented as a limitation and deferred item.

---

## 21. Filters

Supported (deliberately few): `entity`, `branchId` (access-checked), `warehouseId` (access-checked, validation only), `from`/`to` (per-entity date column). Not built: status filter, customer/supplier filter (the free-text query already matches party names for documents) — avoiding excessive filters, per the instruction. The frontend bar exposes none of these filters (query text only).

---

## 22. Concurrency / Read Consistency

Verified: a search racing a concurrent record create returns `200` and the new record is found on the next search; five simultaneous multi-entity searches all return `200`. Search takes no locks and does no writes. Permission changes take effect per the grant-cache behavior noted in Section 7; no test toggled grants mid-search, and no stale-permission exposure beyond that existing cache window is claimed to be ruled out. The cold-start pool failure in Section 14 was the one read-consistency-adjacent defect found, and is mitigated, not eliminated.

---

## 23. Tests Added

- `backend/tests/universalSearch.test.js` — **36 tests**: per-entity search for every type (Product, Product Variant, Customer, Supplier, Sale, Purchase, Payment, Expense, Sales/Purchase Return, Credit/Debit Note, Quotation, Sales Order, PR/RFQ/PO, Notification, Activity Log, User); multi-entity grouping; exact/prefix relevance; pagination and per-type caps; permission filtering across four role scenarios plus notifications; tenant, branch and warehouse isolation; special-character, injection, empty-query and unknown-entity handling; concurrent create+search and concurrent searches; deep-link route correctness including the null RFQ route.
- `frontend/src/components/GlobalSearch.test.jsx` — **4 tests**.
- Updated (wrapping in `MemoryRouter` only, assertions unchanged): `Expenses.test.jsx`, `SalesHistory.test.jsx`.

Not covered by tests: offline behavior (none built), Product-category search (not implemented), digit-normalized phone search (not implemented), true large-volume/performance testing.

---

## 24. Full Regression Results

**Backend, full suite (`jest --runInBand`, 34 suites, 767 tests)** against `akvisionflow_phase116`:

- **Run 1** ended with 13 failed suites and `Postgres no response`: the portable Postgres server stopped around the session interruption (unclean shutdown → WAL recovery on restart, the same event class seen earlier in this project). That run is discarded as unreliable.
- **Run 2** (Postgres healthy): 767 tests, 629 passed, 138 failed across 8 suites, with `FATAL: too many clients already` in the log — the connection-exhaustion flake documented since Phase 1.14 (worsening as the suite grows; now 34 files). `universalSearch`, `notificationsAndActivityLog`, `quotationsAndOrders`, `returnsCreditDebitNotes`, `paymentsReceipts`, `expenseManagement`, `purchaseManagement`, `permissionsArchitecture`, `multiBranch` and others passed in the full run.
- **Isolated retry of the 8 failed suites**: 7 passed (137/138 tests); `moduleArchitecture` retained one failure (`Can't reach database server`, the pre-existing Command Center dashboard flake); **re-run alone it passed 12/12**.

No code was changed in response to any failure. Every failure observed traces to environment/DB availability or the documented pool-exhaustion flake; none touches search code. **Frontend**: full run 136/136 passed (30 files) before adding the new test file; the new `GlobalSearch.test.jsx` passes 4/4 (so 140 tests / 31 files); `npm run lint` exits 0 (only the codebase's existing `set-state-in-effect` warning style, one more instance in `GlobalSearch.jsx`); `npm run build` succeeds. Note: lint/build were run before adding `GlobalSearch.test.jsx`, and the full frontend suite was not re-run end-to-end after adding it.

---

## 25. Known Limitations

1. Relevance ranking is bounded to a 15-candidate window per entity in quick search and is absent in paginated single-entity mode (Section 9).
2. Warehouse isolation: `warehouseId` is validated only; entities without a branch column are tenant-wide, mirroring their own list endpoints (Section 8).
3. Substring search is not index-accelerated (Section 14); performance at large data volume is unproven.
4. Permission staleness follows the existing grant cache (Section 7).
5. Missing searchable fields: product category, free-text notes, original-document numbers on returns/notes (Section 4).
6. Deep links land on filtered list pages, not record detail views; Purchases, Procurement, Users, Notifications don't pre-filter; RFQ has no screen (Section 12).
7. Global search bar is hidden below the `md` breakpoint; no offline-specific message (Sections 11, 19).
8. No mobile (Owner Android) search (Section 20).
9. No digit-normalized phone/accent-insensitive matching (Section 15).
10. Concurrency ceiling: batched fan-out reduces but does not eliminate pool pressure under heavy simultaneous search load; no load test was performed (Section 14).
11. Regression environment: `too many clients` exhaustion and a portable-Postgres outage affected full-suite runs; results rely on isolated retries (Section 24). The `moduleArchitecture` dashboard flake recurred.
12. `search.routes.js` duplicates each entity's `select`/`orderBy` between the bounded `query()` and the paginated `SELECT_BY_ENTITY`/`ORDER_BY_ENTITY` tables — a maintenance smell, verified consistent by tests but a refactor candidate.

---

## 26. Deferred Items

- Trigram (`pg_trgm`) or full-text indexes and SQL-level ranking, with a deliberate migration strategy that Prisma's schema diffing won't undo.
- Per-entity "view all results" UI on top of the existing single-entity paginated API; load-more.
- Record-level deep links (open a specific record's modal) and search pre-fill for Purchases, Procurement, Users, Notifications; an RFQ screen.
- Mobile/Owner-app search; mobile-web header search entry.
- Offline-aware search fallback with an explicit "incomplete local results" indicator.
- Product-category and notes search; phone normalization.
- Load/scale testing and Prisma pool tuning.
- Access logging for sensitive-entity searches, if a compliance need appears.

---

## 27. Files Changed

**Backend (new):**
- `backend/src/modules/search/search.routes.js`
- `backend/prisma/migrations/20260923000000_phase1_16_universal_search/migration.sql`
- `backend/tests/universalSearch.test.js`

**Backend (modified):**
- `backend/prisma/schema.prisma` — 4 new indexes (`Customer`/`Supplier` `phone`/`email`)
- `backend/src/app.js` — mounted `/api/search`

**Frontend (new):**
- `frontend/src/components/GlobalSearch.jsx`
- `frontend/src/components/GlobalSearch.test.jsx`

**Frontend (modified):**
- `frontend/src/components/Layout.jsx` — header search slot; header layout changed from `justify-content-between` to gap/`ms-auto`
- `frontend/src/pages/products/Products.jsx`, `sales/SalesHistory.jsx`, `expenses/Expenses.jsx`, `creditNotes/CreditNotes.jsx`, `debitNotes/DebitNotes.jsx`, `quotations/Quotations.jsx`, `salesOrders/SalesOrders.jsx`, `activityLog/ActivityLog.jsx` — initial search filter seeded from `?search=`
- `frontend/src/pages/expenses/Expenses.test.jsx`, `frontend/src/pages/sales/SalesHistory.test.jsx` — `MemoryRouter` wrapper

No permission-catalog change was needed (existing resources reused); no existing route's behavior changed.

---

## 28. Final Verdict

**PHASE 1.16 — CLOSED WITH CONDITIONS**

The core capability — a central, RBAC-gated, tenant/branch-safe, parameterized, bounded search across 20 entity types plus own notifications, with deterministic (exact/prefix/contains) ranking in quick-search mode, pagination in single-entity mode, and a working header UI — is implemented and verified over real HTTP against a real database, with injection/special-character/isolation/permission tests all passing. The one defect found during development (cold-pool fan-out failure) was reproduced and mitigated, and no regression attributable to this phase was found; all observed suite failures were environmental (Postgres outage, connection exhaustion, the known dashboard flake) and cleared on isolated retry.

The conditions are the disclosed items in Section 25: substring search is not index-accelerated and unproven at scale; relevance ranking is bounded/absent in paginated mode; warehouse isolation is validation-only and tenant-wide entities mirror their native endpoints; deep links land on lists (and not at all pre-filtered for four pages, with RFQ having no screen); the search bar is hidden on small screens; there is no mobile or offline search; some listed fields (category, notes, original-document numbers) are not searchable; and full-suite regression depends on isolated retries because of a worsening connection-exhaustion flake.

**STOP. Phase 1.17 has not been started.** Awaiting Product Owner review of this report.
