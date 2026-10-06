# Phase 3.1 — Offline Data Architecture & Local Database: Verification Report

**Verdict: CLOSED WITH CONDITIONS.** This phase establishes the local/offline **data foundation**. It does **not** solve full offline synchronization — sync, conflict resolution and reconciliation are Phase 3.2 and were not started.

## 1. Audit of the existing offline layer (before any change)
Found: a per-tenant Dexie database with four read tables (products, customers, suppliers, expense categories), ten `pending*` outboxes (client idempotency keys, conflicts never auto-resolved), an app-shell service worker, and `refreshCaches` as the only fill path. Defects found, all confirmed:

| # | Defect | Effect |
|---|---|---|
| D1 | `refreshCaches` asked for `pageSize=500`, but every list endpoint caps at **100** | Only the first 100 products/customers/suppliers were ever cached; product #101+ could not be sold offline (proved: 130 products → list returns 100) |
| D2 | One `Promise.all` over four endpoints; expense categories are finance-only | For a **cashier the whole refresh failed (403)** — the cache never refreshed |
| D3 | Refresh did `clear()` + `bulkPut` | Erased the stock deductions of sales still waiting in the outbox → offline stock shown too high (oversell risk) |
| D4 | Refreshed only when certain pages mounted | Stock changed online elsewhere (another terminal, an adjustment, a return, a warehouse move) never reached the cache; nothing refreshed on reconnect |
| D5 | Database keyed by tenant only | Users/branches on one device shared cached data and each other's unsynced queue (which would then be sent under the wrong user) |
| D6 | Service worker had no navigation fallback | After a browser restart, opening `/pos` offline failed (no such file cached) |
| D7 | Freshness = one timestamp, unused by any UI | Stale stock was never shown as stale |
| D8 | No cache-shape versioning; nothing cached for branches/warehouses/per-warehouse stock | — |

Verified working and preserved: session (user/token/permissions) persists across restart; a 401 is the only thing that logs out (a network error does not); all outboxes and their tests.

## 2. Implemented
**Server (`/api/offline`, read-only)** — `GET /manifest` (datasets this role may cache, the exact access scope, `{count, maxUpdatedAt}` version per dataset, schema version) and `GET /datasets/:name` (keyset-paged, `updatedSince` deltas that also carry deactivations). Uses the same permission and branch/company/warehouse scoping as the normal endpoints — a terminal cannot cache more than its user may read online.

**Local data model (`localData.js`, `db.js` v7, `pendingEffects.js`)**
- Cached: products (+stock), customers, suppliers, expense categories, **branches, warehouses, per-warehouse stock**. Reads never touch the network.
- Complete paged downloads applied in one transaction per dataset; datasets fail/are forbidden independently (D1, D2).
- Versioned refresh: one cheap manifest request; only changed datasets are downloaded, as deltas.
- **Stock kept current**: after any successful stock-affecting request from the app (adjust, sale, purchase, return, warehouse move, transfer, GRN…) a debounced refresh runs; plus every 60 s while online/visible, on focus, on reconnect. A change made by another terminal is picked up by the periodic check. Going offline marks the stock copy "possibly stale" (D4).
- **Queued work is never forgotten**: server numbers are re-baselined then this terminal's pending/syncing sales, receiving purchases and warehouse moves are re-applied idempotently (conflicted/failed entries take no stock) (D3).
- **Freshness/staleness**: per-dataset age vs TTL (stock 2 min, master data 15 min); `Stock may be out of date` badge in the sync widget and a notice in the POS that says how old the stock is and what that means offline (D7).
- **Isolation**: database per tenant **and user**; the cache records the access scope it was downloaded for — a change of identity, branch/warehouse access or cache-schema version purges what no longer applies; sign-out purges the read copy but **never** the unsynced queue; one-time adoption of pre-existing queued work into the first user's database (D5, D8).
- **Restart offline**: service worker precaches the shell plus the build's own assets and serves the shell for any client-side route when offline (D6).
- Non-blocking: every refresh is fire-and-forget, never throws, is skipped offline/hidden, and concurrent callers share one follow-up run (a burst can't miss a change made moments earlier).

Unchanged and working: all outboxes (`OUTBOXES`), the Phase 2.4 offline boundary, Sales/Purchases/Expenses/Customers/Suppliers/Optical/Warehouse flows. `refreshCaches`/`getCached*`/`getCacheFreshness` keep their names.

## 3. Verified
| Requirement | Evidence |
|---|---|
| Online → offline | keeper marks stock stale on `offline`; data still served; **no request is made offline** |
| Offline → online | `online` event triggers refresh and picks up changes made elsewhere meanwhile |
| Local data without network | products/customers readable with the network rejecting; manifest failure resolves quietly |
| Online stock change → local cache | stock-mutation event refresh; periodic pick-up of another terminal's change (product **and** warehouse row); server-side delta tests for adjustment, sale, purchase, warehouse receive |
| Queued stock survives refresh | pending sale/warehouse move stays deducted; synced is not double-counted; conflicted takes none; repeated refresh is idempotent |
| Scope isolation | two users same tenant → separate databases; other tenant sees nothing; branch-restricted user's manifest/branches/warehouses/stock limited to their access (server); access change purges location data, keeps catalog |
| Restart offline | close/reopen database with no network: data, freshness records and queued sale intact; SW serves `/pos` shell offline; session restore opens the user's database |
| Existing outboxes / no regression | all 42 pre-existing offline tests pass (network double updated to the new endpoints only); Sales/Purchases/Inventory/Customers/Suppliers/Expenses suites pass |
| >100 rows | 1,200 products downloaded across 3 pages, none lost |

## 4. Test results
| Check | Result |
|---|---|
| Backend full suite | **40/40 suites, 905/905 tests**, 0 connection errors (14 new: `offlineDataFoundation`) |
| Frontend full suite | **39 files, 229/229 tests** (new: localData 25, client interceptor 19, service worker 5, auth-scope 3, freshness UI 3) |
| Lint / Build | exit 0 / succeeds |
| Migration | none needed (no schema change); `migrate diff` shows no drift |

Failures investigated: an auth sign-out/sign-in race (the asynchronous clean-up of a sign-out could undo the scope of a quick sign-in) was found by a test and fixed with an ordering counter; a keeper test failure exposed that a concurrent refresh joined an in-flight run whose manifest predated the change — fixed with a single shared follow-up run; the 1,200-row test timed out once under full-suite load (3.5 s alone) and now has an explicit timeout; other failures were test-authoring errors (listener leaks, escaped regex).

## 5. Deferred to Phase 3.2 (explicitly NOT done)
Conflict detection/resolution and the UI for it; ordering/dependency between queued operations (a queued sale referencing a customer created offline); retry/back-off policy and background sync scheduling; server-side reconciliation of an offline sale against stock that has since moved (today: 409 → `conflict`, a human decides); deletion/merge of records edited on two terminals; offline capture of the original event time (`paidAt` and document dates are server time at sync); encrypted-at-rest local storage; push/SSE instead of polling; local read models for sales history, statements, reports, payments/receivables (still online-only).

## 6. Conditions and limitations
1. **A terminal offline cannot learn of changes made elsewhere** — staleness is bounded by how recently it was online (≤ ~1 minute of keep-fresh while online) and is *shown*, not eliminated; the server remains the authority at sync (oversell → conflict).
2. `warehouseStock` rows are downloaded as they exist; the server creates a warehouse's stock rows lazily when it is first viewed, so a never-viewed warehouse may have no rows to cache.
3. The stock figure a POS sees is the tenant-wide product quantity (existing behavior); per-warehouse quantities are cached for future/other screens.
4. Sign-out removes read data from the device; if a user never signs back in, their **unsynced queue stays on that device** until they (or an administrator's device reset) do — a deliberate no-data-loss choice.
5. Adoption of legacy queued work assigns it to the first user who signs in on that device/tenant after upgrade.
6. The interval/visibility keeper only runs while the app is open; no background (service-worker) sync exists yet.
7. Uncommitted: all Phase 3.1 changes are in the working tree.
