# Phase 4.3 — Management Operations: Verification Report

**Status: PHASE 4.3 COMPLETE, WITH CONDITIONS — stopped for Product Owner approval. Phase 4.4 has not been started.**
Decisions applied as approved: mobile roles = `TENANT_ADMIN` + `MANAGER`; API approach = an **allow-list of existing endpoints**, reusing the existing business logic (no Sale/Product/Customer logic was copied into mobile-specific implementations).

## 1. Audit (before any change)
- A mobile token was refused by every existing route (`authenticate` rejected any typed token) and the mobile surface was read-only, so the app could not reach customers, suppliers, products, sales, purchases or approvals at all.
- The existing routes already carry what is needed: permission checks, branch/warehouse scope, tenant isolation, pagination and search, audit logging, and — for the three approval documents (purchase request, purchase order, stock transfer) — **atomic status guards** (a repeat or a race returns 409). Sales-order "confirm" has no reject counterpart and was not included.
- Actions considered and deliberately **not** exposed (destructive, financial, or without a safe guard for a phone): creating/editing/deleting customers, suppliers, products; creating or reversing sales and purchases; payments; stock adjustments; cancelling documents; receiving goods; anything in accounting.

## 2. What was implemented
**Backend — the door, not a second implementation**
- `middleware/mobileGateway.js`: 26 exact method+path patterns (GET list/detail for customers (+history), suppliers (+ledger), products, warehouses (+stock), sales, purchases, purchase requests/orders, stock transfers; POST approve/reject on the last three). IDs must be UUID-shaped; the query string is ignored; look-alikes, traversal and other methods are refused.
- `authenticate` accepts a mobile token **only** for those pairs, re-checks on every request that the user still has a management role (a demoted or deactivated user loses access at once), and marks `req.user.mobile`. Everything behind it (permissions, branch scope, handlers, audit) is the unchanged web code, evaluated for the token's real role. Any other path/method with a mobile token is 401; portal tokens remain refused everywhere.
- **Genuine bug fixed:** stock-transfer approve/reject did not check warehouse access (view/cancel/dispatch/receive did). A warehouse-restricted approver could decide transfers between warehouses they cannot see. Both now require access to at least one side. Proven failing before the fix and passing after.

**Android (owner/manager focused, concise)**
- New **Manage** tab (only when the session may view at least one area) → a hub of the areas the permissions allow → searchable, paged lists (search sent to the server after a short pause) → detail screens: customer (balance, recent sales, payments), supplier (balance owed, purchases, payments), product (stock, low-stock level, prices), sale/purchase (items, totals, paid, balance, payments), and the three approval documents.
- **Approvals:** Approve (confirmation dialog) and Reject (reason required) only for a pending document and only when the session holds the approve permission; a double tap is one decision; if somebody else decided first the screen says "already decided — nothing was changed by your action" and reloads the current state; a refusal shows the server's reason. Approvals need a connection and are **never queued for later** (see caveats).
- Management records are **never written to the on-disk HTTP cache** (`Cache-Control: no-store` on all non-mobile-API responses); the cache is also wiped when a session ends (4.1).
- Kept small on purpose: reads plus three approval types. Existing alert read/dismiss and notification settings are unchanged.

## 3. Verification
| Check | Result |
|---|---|
| Backend full suite (local PostgreSQL, real HTTP) | **50/50 suites, 978/978 tests** (was 48/967; +8 `mobileOperations`, +3 `mobileOperationsGating`) |
| Android JVM unit tests | **22 classes, 110 tests, 0 failures** (95 → 110) |
| Android lint | 0 errors, 0 warnings (lint XML) |
| Android build | `assembleDebug` and `assembleDebugAndroidTest` succeed |

Backend tests prove: the allow-list matrix (20+ refused shapes incl. traversal, look-alikes, non-IDs); browse/search/details answered for owner and manager through the existing routes; **every write and every other module refused (401) with the data unchanged**; a demoted user's token dies at once; a cashier cannot obtain a mobile token; **tenant isolation** (another shop's customer/sale → 404, its approval attempt → 404 and the document unchanged); approve/reject for all three document types, **audited under the mobile user's id**; reject requires a reason and a decided document cannot be decided again; **concurrency: eight simultaneous approve/reject attempts by two managers on one document (for each of the three types) → exactly one 200, seven 409, stored state equals the winner's, exactly one audit row**; permission enforcement behind the door (catalog grants withheld from MANAGER → 403 and nothing changed, owner unaffected); branch scope (foreign branch → 403) and warehouse scope (see the bug above).
Android tests prove (against REAL saved server responses through the app's own DTOs): rows/details formatting and balances; search is a server search term; approval queues open on pending only; approve/reject hit the right endpoint per type; a rejection without a reason never leaves the phone; a 409 conflict becomes "already decided"; a refusal keeps the server's message; double-tap = one call; list keeps its rows when the server is unreachable; paging without duplicates; tab/area visibility from permissions; no-store rule for management paths.

## 4. Conditions / what could NOT be verified
1. **No real Android device/emulator run** (virtualization is disabled in this machine's firmware). The Compose screens (hub, lists, details, dialogs), real touch behaviour and the network stack are **NOT VERIFIED on a device**. I added instrumented tests for the hub (`Phase43InstrumentedTest`) that **compile but were not executed**; the detail/approval screen is covered by ViewModel/repository tests, not by a UI test.
2. **Offline scope for 4.3 (deliberately minimal):** browsing needs a connection; the list/detail already on screen stays visible with the reason when the server is unreachable, and there is a connection banner (4.1). **Approvals are online-only by design** — a decision queued while offline could be applied to a document that changed or was decided meanwhile. Offline caching of these records (encrypted) belongs to 4.4.
3. **A management approval needs the permission and the role check of the web routes.** Reject on purchase requests/orders still uses the web's role rule (management roles), which both mobile roles satisfy.
4. **Prices and costs are visible** in product/purchase details to any session whose role can see them on the web (the same routes); no extra masking was added.
5. **Web app unchanged**, except the stock-transfer approve/reject warehouse check above. The web frontend suite was not re-run for 4.3 (no frontend change); the backend regression is complete.
6. Search on approval queues is intentionally absent (queues show only what is pending). Product barcode lookup is not exposed (only the list search).
7. README documents the allow-list; adding a line to it is a security decision.

**Stopping here for Product Owner approval of Phase 4.3. Phase 4.4 has not been started.**
