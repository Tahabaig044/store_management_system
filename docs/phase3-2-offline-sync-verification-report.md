# Phase 3.2 — Offline Sync, Conflict Resolution & Queue Processing: Verification Report

**Verdict: CLOSED WITH CONDITIONS.** The synchronization engine works end to end for the Phase 2.4 offline-safe operations. Read section 5 before calling this "full offline support": it is deliberately not that.

## 1. Audit of the Phase 3.1 engine (before any change)
Reused: the ten outbox tables, client idempotency keys, optimistic stock effects, the Phase 3.1 local cache and freshness, the Phase 2.4 offline boundary. Gaps found:

| # | Gap | Effect |
|---|---|---|
| S1 | An entry left `syncing` by a crash/restart was never selected again | Stranded forever |
| S2 | A 5xx or dropped connection ended that outbox's drain; nothing retried on a timer; no attempt counting or backoff | Queue waited for the next page load/online event; a flaky server was hit immediately every time |
| S3 | Outboxes drained in parallel with no cross-outbox order; an offline-created record could not be referenced | Sale for an offline customer, payment for an offline sale, reversal of one: impossible or mis-ordered |
| S4 | Rejections were classified by HTTP status only; no machine-readable reason | "Exceeds balance" (422) treated as a permanent failure; a reversal whose reply was lost showed as a conflict though applied |
| S5 | No original event time was sent or accepted | Sale/payment/expense were dated at sync time, moving them to the wrong business day |
| S6 | Discard deleted silently; synced rows never pruned; UI showed only "Conflict" with a tooltip | Work could vanish without a trace; the reason was hidden |
| S7 | Two-tab / concurrent triggers each ran their own drain | Duplicate attempts (safe only by idempotency) |
| S8 | Server: a duplicate replay racing its own winner could answer 409 instead of the original result | Spurious conflict on retry (found by a test — see §4) |

## 2. Implemented
**Server**
- Every error carries a stable `code` (`STOCK_INSUFFICIENT`, `ALREADY_APPLIED`, `DOCUMENT_NOT_OPEN`, `PERIOD_CLOSED`, `BALANCE_CHANGED`, `DUPLICATE`, `NOT_FOUND`, `VALIDATION`, `FORBIDDEN`, `UNAUTHORIZED`, `CONFLICT`) in the response body; 30 throw sites tagged. Existing fields unchanged.
- **Original event time**: `occurredAt` accepted on sales, purchases, expenses, standalone payments and warehouse moves and used as the business date (record `createdAt`/`paidAt`/`expenseDate`, receipt time, journal-entry date). A device clock ahead of the server is clamped to now; garbage is 422; a closed accounting period still refuses (visible `PERIOD_CLOSED` conflict); a replay with a different `occurredAt` returns the original record unchanged.
- A duplicate of an operation that already succeeded now always resolves to that operation (sales/purchases/expenses), even when it raced the winner past the pre-check.

**Client (one engine, reusing the existing outboxes)** — `syncCore.js` (pure rules), `syncCoordinator.js` (the loop), outboxes refactored to register with it (public API unchanged: `queue/sync/retry/discard/submit/OUTBOXES/syncAll`).
- **Ordering**: oldest-first across all outboxes; `"$ref:<clientId>"` references make an entry wait for the entry it depends on, then the real server id is substituted. Offline-created customers/suppliers are selectable at once (`useLiveCustomers/Suppliers`).
- **Independence**: conflicting, failing or backing-off entries never hold up unrelated ones; a dependent of an entry that needs attention shows **Blocked** (with the reason) and is released automatically on resolution; if what it waits for is discarded it becomes a visible failure.
- **Retry**: unreachable server → wait, uncounted; 5xx/408/425/429 → exponential backoff (5 s → 5 min, ±20 % jitter), bounded at 8 attempts, then a visible `failed` item a person can retry. **Automatic**: on start, on reconnect, when something is queued, on focus, every 30 s, and exactly when a backoff expires. 401 pauses the queue with everything kept.
- **Recovery**: interrupted `syncing` entries are re-queued at every pass; cross-tab Web Lock plus in-tab single flight with one shared follow-up.
- **Conflicts**: deterministic classification from status + code; the server is never overwritten; a reversal answered "already applied" completes (intent satisfied). Each conflict stores kind, code, status, message.
- **Convergence**: after a pass that synced or conflicted, the local read copy is re-downloaded, so local stock = server truth + only what is still queued (Phase 3.1 overlay); discarding also re-baselines.
- **Never silent**: discard requires confirmation in the UI and is logged (what, when, why) in `discardLog`; synced entries are pruned only after 24 h and when nothing refers to them.
- **UI**: overall state (Syncing / N pending / offline-pending / N conflicts / N failed / N waiting / All synced), pending count, per-transaction status (Pending / Retrying at hh:mm / Syncing / Synced / Conflict / Failed / Waiting), the server's reason plus plain-language advice, "not applied on the server" notice, Retry, confirmed Discard, and when each transaction actually *happened*.

## 3. Verified
| Requirement | Evidence |
|---|---|
| Offline create → reconnect → sync | client scenario: nothing sent offline; on reconnect accepted once; local stock converges to server's (7, not 4) |
| Network failure during sync → retry | dropped connection loses nothing (uncounted); reply lost after server applied → replayed with same key → exactly one sale |
| Browser restart with pending queue | close/reopen: queue intact and synced; entry caught mid-request is resumed; crash after server applied is deduplicated |
| Duplicate sync requests | 5 overlapping triggers → each record sent once; two-tab case |
| Out-of-order operations | payment→sale→customer created "in the wrong order" still syncs customer, sale, payment in dependency order with real ids and no `$ref` ever sent; reversal of a still-queued sale |
| Two-terminal stock conflict | server stock 5: A sells 3 offline, B sells 4 online; A's sale → 409 STOCK_INSUFFICIENT, visible conflict, server stock 1 (never negative), A's and B's local stock both converge to 1; retry after restock applies exactly once |
| Real-server concurrency | real HTTP, real Postgres: replay vs online sale of the last unit → one 201/one 409; 12 racing terminals on 5 units → exactly 5 accepted, 7 coded conflicts; retries idempotent |
| Stale-cache conflict | cache 10 / server 4 / sale of 7 → conflict citing "available: 4"; next download shows 4 |
| Partial failure & recovery | 5 entries: 3 good sync, 1 conflict visible, 1 flaky waits with backoff and is retried; 8 consecutive 503s → visible `failed`, still retryable |
| Original event time | fake-clock test: queued 09:30, synced two days later → `occurredAt` sent unchanged; real server stores sale/payment/journal/purchase/expense/stock-move at the event time and reports it on that day's P&L |
| Isolation | user A's queue neither visible to nor sent by user B; server: other tenant cannot touch stock, same key = separate operation |
| Existing offline regression | all 72 pre-existing offline tests pass unchanged |

## 4. Test results
| Check | Result |
|---|---|
| Backend full suite | **41/41 suites, 918/918 tests**, 0 connection errors (13 new: `offlineSyncServer`, 3 consecutive runs) |
| Frontend full suite | **43 files, 276/276 tests** (new: syncCore 12, sync scenarios 26, sync-status UI 8, offline-created records 2) |
| Lint / Build | exit 0 / succeeds |
| Migration | none (no schema change); `migrate diff` no drift |

Failures investigated: the real-server replay test failed intermittently — a duplicate replay running concurrently with its own winner got a 409 (stock already consumed) instead of the original sale; root-caused and fixed (S8), then 3/3 green. A sign-out/quick sign-in cleanup race (Phase 3.1) and a "database closed" unhandled rejection when a shop/user switched mid-pass were fixed and covered. Two test-authoring slips (shell quoting) were corrected.

## 5. Deferred / not claimed
- **The client engine is verified against an in-memory server that mirrors the real server's rules; the real server's behavior is verified separately over real HTTP.** There is no single test driving the browser engine against the running API and Postgres, and no test in a real browser (only jsdom + fake-indexeddb). I do not claim that.
- Not built (Phase 3.3+): editing an offline record before it syncs; merging edits made on two terminals; queued partial/whole returns, credit/debit notes, note applications, refunds, payment reversal, `/pay`, manual journals (still deliberately online-only — the Phase 2.4 boundary is unchanged); local read models for history/statements/reports; conflict "resolve by editing" (today: retry or discard); push instead of polling; encrypted local storage; background sync while the app is closed.
- `Optical order` and `Quotation` queues use the new engine but do not yet carry `occurredAt`.

## 6. Conditions and limitations
1. A conflicted sale is **not** applied; the customer has already been served at the counter. Resolving that (collect/refund/restock) is a business decision; the engine surfaces it, it does not decide.
2. Terminals still rely on stock the server holds: staleness while offline is bounded and shown (Phase 3.1) but real-time reservation across terminals does not exist.
3. Backdated events can land in a closed period (→ visible `PERIOD_CLOSED`) or shift totals of an already-reported past day; document numbers stay sequential by arrival, not by event time.
4. `Sale reversal` queued offline also issues its credit note at sync time (Phase 2.4 behavior).
5. Web Locks are used where the browser has them; elsewhere the in-tab single flight plus idempotency keys carry safety.
6. Uncommitted: all Phase 3.2 changes are in the working tree.
