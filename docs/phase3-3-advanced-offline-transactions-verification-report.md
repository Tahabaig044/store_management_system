# Phase 3.3 — Advanced Offline Transactions: Verification Report

**Final status: PHASE 3.3 — CLOSED WITH CONDITIONS.** Read section 7 before describing this as "full offline support": several operations remain online-only by design, and one full-suite failure was not reproduced (section 4).

Scope built (as approved): offline record editing where safe; conflict resolution with edit-and-retry; offline returns; offline credit/debit notes with applications and refunds; multi-terminal reconciliation. Four sub-phases: 3.3.1 editing, 3.3.2 returns, 3.3.3 notes/applications/refunds, 3.3.4 multi-terminal reconciliation. Nothing from Phase 3.4 (local reports, encrypted storage, background sync) was started.

## 1. Audit of Phases 3.1 / 3.2 (before any change)
Reused unchanged: per-tenant/per-user Dexie DB, manifest + paged datasets, the stock overlay, the single coordinator (single flight, `$ref:` dependencies, backoff, statuses, 401 pause, discard log), idempotency keys, server error `code`s, `occurredAt`/`resolveEventTime`, the Phase 2.4 boundary.
Gaps that blocked this scope:

| # | Gap | Effect |
|---|---|---|
| A1 | No way to change a queued entry; conflicts could only be retried or discarded | A stock/return conflict forced re-entering everything |
| A2 | A conflict did not carry the server's facts (available stock, remaining returnable) | No safe suggestion possible |
| A3 | Returns, notes, refunds, applications had no `occurredAt`, no replay-dedupe, no coded conflicts | Unsafe to queue |
| A4 | Selection lists (returnable sales, open documents, notes with credit left) not available locally | Nothing to build an offline form from |
| A5 | No cross-terminal visibility of unsent or refused work | A terminal could hold conflicts nobody knew about |

## 2. What was implemented
**3.3.1 Editing + edit-and-retry** (`offline/editing.js`, `QueueEditModal.jsx`, sync panel)
- Only unaccepted entries (pending / conflict / failed / blocked) are editable; never synced or syncing. An entry whose last send ended without an answer (`maybeApplied`) must first be "Checked" (replayed) — otherwise the same idempotency key would return the original record and silently ignore the edit.
- An edit never changes the idempotency key or the original event time (a closed-period conflict may be corrected to today's date only as an explicit, confirmed, logged change). Every edit is logged (`revisions`) with the conflict it resolved. Validation per outbox.
- Suggestions come only from the server's own `details`: reduce a sale/move to available stock, reduce a return to what remains, refund/apply only what the note still holds, cap an application at the invoice's real balance; if nothing is left, it says "discard".
- Server: `STOCK_INSUFFICIENT`, `RETURN_EXCEEDS`, `BALANCE_CHANGED` now carry `details`.

**3.3.2 Offline returns** — sales and purchase returns (partial, line-level). Local lists `returnableSales` / `returnablePurchases` (last 60 days); the form subtracts returns already queued; stock is restocked/removed locally at once and reconciled from the server on the next download. Server: `occurredAt` (record + credit note + journal date), replay-dedupe, `RETURN_EXCEEDS`/`STOCK_INSUFFICIENT` with facts.

**3.3.3 Credit/debit notes, applications, refunds** — issue, apply to explicit documents, refund. Lists `arDocuments`/`apDocuments`/`arNotes`/`apNotes`. A note issued offline can be applied or refunded immediately (`$ref:` to the queued note; the coordinator sends the note first and substitutes the real id). Read-time derived views subtract everything queued, so the same credit cannot be promised twice on one terminal. Server: `occurredAt` on create/refund/apply, replay-dedupe on create and refund, coded `BALANCE_CHANGED` with the note's available credit or the document's real balance. New screen **Returns & Notes**; the Phase 2.4 boundary (`offlineBoundary.js`) was updated deliberately, with its test.

**3.3.4 Multi-terminal reconciliation** — each device has a terminal id; after every sync pass, on queue, on reconnect and on a 5-minute heartbeat it reports counts (waiting/conflict/failed, oldest waiting) and its refused entries (kind, code, message, server facts — no transaction content). Server (`/api/sync`, new tables `sync_terminals`, `sync_issues`, migration `20260927000000_phase3_3_sync_reconciliation`): reports are replay-safe and applied one at a time per terminal (row lock); a report older than one already applied is dropped; issues resolve when the terminal syncs or discards the entry and reopen if it is refused again; managers (TENANT_ADMIN/MANAGER) see all terminals, terminals holding unsent work that went quiet for 15 min, and open issues, and can acknowledge (atomic, idempotent, audited); the terminal learns which of its refusals a manager has seen. Screen **Terminals & Sync**. Reporting only observes — it never sends or changes a transaction.

## 3. Genuine bugs found and fixed
| # | Bug | Fix |
|---|---|---|
| B1 | `POST /sales-returns` on a **walk-in sale** (no customer) crashed with HTTP 500 (auto credit note needs a customer) | Walk-in returns refund the money account directly and write a `Payment OUT` record; cash reconciliation updated (`SALES_RETURN` no longer excluded from payment-row matching) |
| B2 | Racing over-applications of one note returned 422 `VALIDATION` instead of a conflict, so a client could not classify them | `BALANCE_CHANGED` + details on note and document balance errors |
| B3 | `syncLocalData` runs were shared per **tenant**, not per database (tenant + user): a run started for the previous user could be joined by the next, and a closed database made it reject despite the "never throws" contract | Runs keyed per database; `DatabaseClosedError` ends a run quietly |
| B4 | Duplicate replays of returns/notes/refunds racing their winner could answer with an error instead of the original | Resolve-to-original dedupe (same pattern as sales) |
| B5 | Queued stock effects were fragile to edit (undo-old/apply-new) | `_baseStock` captured before the first queued effect; overlay always recomputed from base |

## 4. Verification
**Backend, real concurrent HTTP against local PostgreSQL** (`tests/offlineAdvanced.test.js`, 13 tests; `tests/syncReconciliation.test.js`, 8 tests):
- Datasets: correct, permission- and branch-scoped, tenant-isolated, paged by raw window (a filtered-out row never truncates), version changes when data changes.
- Event time preserved on returns, notes, refunds, applications (record and ledger date); books still reconcile.
- 8 racing 1-unit returns of 3 sold → exactly 3 accepted, every loser `RETURN_EXCEEDS`, stock restocked once per unit; whole-quantity race → one wins; 6 duplicate replays → one return, one credit note; purchase-return race never drives stock negative.
- Credit-note create replays → one note, one journal entry; refund replay → pays once; refund vs application racing never spends more than the note holds; stale application → `BALANCE_CHANGED`, nothing changed; debit side likewise.
- Reconciliation: replay-safe; 12 reports racing for one new terminal → one terminal row, newest wins; out-of-order report dropped; resolve/reopen; manager-only reads; other shop sees nothing and cannot acknowledge; two managers acknowledging concurrently → both answered, one kept, one audit row; silent-terminal flag; malformed report → coded 422, nothing stored.

**Client, real code on fake-indexeddb against an in-memory server** (`advancedOffline.scenarios.test.js`, 8 scenarios; `editing.test.js`, 20; `QueueEditModal.test.jsx`, 5; `terminalReporting.test.js`, 7; `ReturnsNotes.test.jsx`, 3; `SyncMonitor.test.jsx`, 2): offline return restocks locally, is refused above what remains (queued returns counted), synced once with its original time; reply lost after apply → replay → exactly once; two terminals returning the same goods → loser sees `RETURN_EXCEEDS`, applies the suggested edit (same key, same time, logged) and is accepted, total never exceeds sold; offline customer → credit note → refund all sent in dependency order with real ids; application/refund race → `BALANCE_CHANGED` with the exact remaining credit as suggestion; stale invoice balance → suggestion is the real balance; reporting never sends a transaction and loses nothing when it cannot be sent.

**Results**
| Check | Result |
|---|---|
| Backend full suite (`jest --runInBand`, local DB `akvisionflow_phase22`) | Final run **43/43 suites, 939/939 tests** |
| Frontend full suite (vitest) | **49 files, 321 tests passed** (three consecutive full runs) |
| Frontend lint | 0 errors; only the project's existing warning classes (none new from files of this phase after fixes) |
| Frontend build | succeeds (existing chunk-size notice) |
| Backend lint | none configured in the project |
| Permission parity | 126 permissions / 385 grants, unchanged; every key used by backend and frontend exists in the catalog |
| Fresh-DB migrations | new DB `akvisionflow_fresh33`: `migrate deploy` applies all; `migrate diff --exit-code` → "No difference detected" |

**Failures during the work, investigated (not waved away)**
- `syncEngine.scenarios` (3–4 tests, `DatabaseClosedError`) after the DB grew to v8: passed alone, failed in the full file; traced to bug B3 and fixed at the cause.
- `offlineDataFoundation` manifest test pinned the old 7 datasets: legitimately stale after adding 6 datasets; expectation updated.
- `syncReconciliation`: (a) a test reused a fixed terminal id across runs (test bug, fixed); (b) an assertion assumed all 3 racing issues are stored, but a snapshot that loses to a newer one is dropped by design (correct semantics, assertion corrected; passes 5/5 repeats).
- Frontend `ReturnsNotes` first-open timeout and `SyncMonitor` duplicate-text query: test defects (cold IndexedDB open under load; two tables showing the same label), corrected.
- **Not explained:** in the first full backend run, `paymentsReceipts › Receipt numbering under concurrency` failed once. It passed 26/26 in isolation and in the next full run (939/939). I did not capture its failure output, and during that run I was also executing other database work (fresh-DB migration, scripts) on the same PostgreSQL, so contention is a hypothesis, **not a proven cause**. This test exercises code untouched by Phase 3.3 (receipt allocation), but I cannot rule out a latent race. Listed as a condition.

## 5. Offline behavior verified (summary)
Works with no network: queue, edit, fix-and-retry, sales/purchase returns, credit/debit notes, applying a note, refunding a note, each with local validation from local lists. On reconnect: sent in dependency order, idempotent, original time kept; anything the server refuses stays visible with the reason and a suggested fix. Two terminals can never over-return, over-refund or over-apply — proven against the real server.

## 6. Files
Server: `sales`, `salesReturns`, `purchaseReturns`, `creditNotes`, `debitNotes`, `receivables` (+`arapService`), `offline.routes` (6 datasets), `warehouseStock`, `financialReportsService`, `errors`, new `modules/sync/sync.routes.js`, schema + migration. Client: `db.js` (v8), `localData`, `syncEngine`, `syncCore`, `syncCoordinator`, `pendingEffects`, `offlineBoundary`, new `editing`, `derivedViews`, `terminalReporting`, pages `ReturnsNotes`, `SyncMonitor`, `QueueEditModal`, `SyncStatusWidget`, `Layout`, `App`.

## 7. Conditions / caveats
1. **Not everything works offline.** Still online-only (deliberately, to protect accounting/inventory integrity): editing a record the server already accepted; note cancel; payment reversal; `:id/pay`; application reversal; auto-allocated payments; manual journals; whole-purchase return; return reversal; optical orders and quotations editing.
2. **A return needs its sale/purchase in the local list** (recent 60 days, downloaded while online). A sale made offline on the same terminal cannot be returned until it has synced and been downloaded.
3. **Applications/refunds act on downloaded documents and notes** (plus notes queued on the same terminal). Documents created offline are not selectable until synced.
4. **Server is authoritative.** The local checks are a courtesy; a stale request becomes a visible conflict, never a partial overwrite. Suggestions are only offered when the server supplied the facts.
5. **Walk-in return refunds** are recorded as a cash-type `Payment OUT`; the refund method is chosen at entry.
6. **Reconciliation is reporting, not repair.** Only the device holding an entry can edit or discard it; a manager can acknowledge, not fix. A terminal that never reports again (wiped browser, lost device) leaves its issues open until a manager judges them; there is no retention/cleanup of resolved issues yet. Reports are tenant-wide for managers; branch-restricted managers are not filtered.
7. **Unexplained single failure** of `paymentsReceipts` concurrency test in one full run (section 4).
8. Backend has no lint; the browser-level end-to-end (real browser, real network toggling) was not run — client behavior is proven on fake-indexeddb with an in-memory server, server behavior on real PostgreSQL.

## 8. Deferred (not started)
Phase 3.4 items (local reports, encrypted storage, background sync); offline editing of accepted records (needs version tokens/merge rules); retention of resolved sync issues; manager-side "request re-sync"/remote actions; offline return of a same-terminal offline sale; offline application reversal.

**PHASE 3.3 — CLOSED WITH CONDITIONS.** Stopping here; Phase 3.4 not started.
