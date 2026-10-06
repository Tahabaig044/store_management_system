# Phase 3.4 — Offline Completion & Reliability: Verification Report

**Final status: PHASE 3.4 — CLOSED WITH CONDITIONS.** This is the last implementation phase of Major Phase 3; no further Phase 3 sub-phase is created. Read section 7 before describing the result as "full offline support".

Four sub-phases: 3.4.1 local history/statements/read models; 3.4.2 protected local storage; 3.4.3 background synchronization and realtime refresh; 3.4.4 recovery, integrity and device-isolation audit (with fixes).

## 1. Audit of Phases 3.1 / 3.2 / 3.3 (before any change)
Reused unchanged: per-tenant/per-user Dexie DB, manifest + paged datasets, stock overlay, the single coordinator (ordering, `$ref:`, backoff, statuses, recovery), idempotency, coded server errors, event time, edit-and-retry, terminal reporting, the service worker shell cache.

| # | Finding | Effect |
|---|---|---|
| A1 | Nothing to *view* offline beyond selection lists: no history, statement, summary or aging | A terminal could act offline but not look anything up |
| A2 | Customer/supplier records (phone, email, address) and document/note lists sat in IndexedDB in the clear; only sign-out removed them | Readable by anyone with the browser profile |
| A3 | No background trigger: throttled background tabs relied on timers; no `sync` handling; stock changes elsewhere noticed only at the 60 s poll | Slow catch-up; wider oversell window |
| A4 | IndexedDB not marked persistent; a full device surfaced as a raw error | Browser eviction could silently lose unsent work |
| A5 | **A queue entry the outbox could not turn into a request (damaged payload) threw out of the coordinator's pass** | One bad entry would abort every pass and block all entries behind it (see B1) |
| A6 | No startup integrity check of the queue; no report if the database cannot be opened | Damage invisible |
| A7 | Log of discarded work (names/amounts) kept indefinitely after sign-out; resolved reconciliation issues kept forever (3.3 condition) | Lingering personal data / unbounded table |

## 2. What was implemented
**3.4.1 Local history, statements, read models**
- Server: datasets `salesHistory`, `purchasesHistory` (last 90 days, every status, permission- and branch-scoped, paged by raw window, versioned).
- Client (`historyViews.js`, screen **History & Statements**): sales/purchase history with search/date filters; customer/supplier **statement** (open documents, credit held, balance); **sales summary** (by day and payment method; reversed excluded; server-accepted vs still-on-terminal shown separately); **aging** buckets and per-party totals. This terminal's unsynced entries appear marked "Not synced"; refused ones are shown as refused, never counted as sales. Every view states "as of the last download" and says plainly when nothing has been downloaded. These are viewing aids; the official ledger and reports stay on the server (online).

**3.4.2 Protected local storage** (`secureStore.js`, unlock banner)
- Customers, suppliers, sales/purchase history, returnable lists, open documents and notes are stored **AES-256-GCM sealed**; each row is bound to its table and id (a sealed row cannot be moved to another record) and tampering is detected.
- Key: random data key wrapped by a PBKDF2-SHA-256 key derived from the user's password; the unwrapped key is memory-only and non-extractable. Sign-in opens it; sign-out and page close forget it; after a restart the data stays locked until the password is typed (works offline; a wrong password destroys nothing). A password the old key no longer matches (changed elsewhere), proven by a fresh sign-in, replaces the key and drops only the re-downloadable sealed cache.
- **Fails closed**: locked or no WebCrypto ⇒ these datasets are not downloaded at all, and views are empty/"locked", never written in the clear. Unreadable or unsealed rows in a sealed table are dropped and the dataset re-downloaded.

**3.4.3 Background synchronization and realtime refresh**
- Service worker: `sync` (Background Sync) and `periodicsync` events wake the app's windows; the worker never sends transactions itself (ordering/idempotency/conflict rules and the session token live in the app). The app registers a background sync when work is queued offline or the tab is hidden, and requests persistent storage.
- Realtime: `GET /api/sync/stream` (Server-Sent Events, authenticated, capped at 5 streams per user / 200 per shop). Any successful write announces "something changed" to the shop's other terminals (bursts collapsed, ≈300 ms); the event carries **no data**; terminals then run their normal, scoped manifest check. It is used only while online and visible, retried with bounded backoff, and nothing depends on it (60 s polling continues).
- Retention (3.3 condition): resolved reconciliation issues older than 90 days and long-idle empty terminals are pruned.

**3.4.4 Recovery, integrity, device isolation**
- Damaged queue entries become visible non-retryable failures and no longer disturb the pass (B1). Startup audit (`integrity.js`) marks malformed entries as failed (never deletes), reports duplicate idempotency keys and dangling references; unopenable-database detection shows a banner with guidance and a warning about clearing site data. A full device yields a clear `STORAGE_FULL` error with nothing half-written. The discard log is trimmed to 30 days at sign-out.

## 3. Genuine bugs found and fixed
| # | Bug | Fix / evidence |
|---|---|---|
| B1 | A queue entry whose request could not be built (null/damaged payload) threw out of `attempt()`, aborting the whole pass, leaving the entry `syncing`, and — because passes run oldest-first — blocking every later entry, repeatedly | Request building is guarded; the entry becomes `failed`/`CORRUPT` and the pass continues. Verified: with the guard removed the test fails with `TypeError: Cannot read properties of null (reading 'saleId')`; restored, it passes |
| B2 | Realtime announcer, first written after the routers, never saw writes (Express order) | Mounted before all routers; test proves announcements |
| B3 | Personal cached data readable in the clear in IndexedDB | 3.4.2 |
| B4 | Sealed values stored as typed arrays failed to decrypt when re-read inside a `liveQuery` (cross-realm/clone) | Stored as base64 text |

## 4. Verification
**Backend** (real PostgreSQL, real HTTP): `offlineHistory.test.js` (4): statuses and fields, 90-day window, complete paging, permission/branch/tenant isolation, version moves. `syncRealtime.test.js` (6): auth required; a write is announced to the shop's other terminal, 8 concurrent writes → ≤3 events, event body contains only a timestamp; reads/rejected writes/terminal reports announce nothing; another shop hears nothing; per-user cap (429 `TOO_MANY_STREAMS`) and release on close; retention prunes only old resolved issues.
**Frontend** (real code, fake-indexeddb, in-memory server): `secureStore.test.js` (10) — raw rows contain none of the personal text; row swap and bit-flip rejected; plain row in a sealed table never trusted; restart ⇒ locked, wrong password changes nothing, right one reads offline; changed password resets cache only; user A's key never opens user B's database; locked/no-crypto sync stores nothing and does not even request the dataset; sign-out purges sealed tables, keeps the unsent queue. `historyViews.test.js` (7), `OfflineHistory.test.jsx` (4), `OfflineUnlockBanner.test.jsx` (3), `realtime.test.js` (stream parsing, refresh once per burst, backoff, 401 stops, offline/no-token no connect, persistent storage, background-sync registration/unsupported, SW message runs the normal sync, full device), service-worker tests (+3: wakes windows and sends nothing itself; no window ⇒ fails so the browser retries; foreign tags ignored), `integrity.test.js` (5), `AuthContext.test.jsx` (+2: sign-in opens key, restart locked, sign-out forgets key/purges sealed copy/keeps queue, localStorage holds no personal data, second user never inherits the key).

| Check | Result |
|---|---|
| Backend full suite | **45/45 suites, 949/949 tests** (final run, nothing else running) |
| Frontend full suite | **55 files, 363/363 tests** |
| Frontend lint | 0 errors; no warnings from this phase's files |
| Frontend build | succeeds (existing chunk-size notice) |
| Permission catalog | unchanged (126 / 385) |
| Migration/drift | No Prisma schema change in 3.4 (last migration is 3.3.4's); `migrate diff --exit-code` against the dev database → "No difference detected"; fresh-DB deploy verified in 3.3 |

**Failures investigated, not waved away**
- Existing frontend tests writing plain rows into now-sealed tables / expecting the old 7 datasets: legitimately stale by design; they now seed and read through the sealed path (helper `test/secure.js`).
- Intermittent 5 s **timeouts** (never wrong results) in heavy UI tests under full parallel load (one in `QueueEditModal`, one in `syncEngine.scenarios`): the database now has 35 tables and WebCrypto; the default test timeout is raised to 20 s. Isolated reruns 3/3 and four further full-suite runs were clean. A test defect (`SyncMonitor`, duplicate label) was corrected.
- `paymentsReceipts › Receipt numbering under concurrency` failed once in a Phase 3.3 full run and I could not capture why. Attempts to reproduce in 3.4: 6 solo runs, 4 runs under three parallel jest processes hammering the same database, and two full-suite runs — all passed. **Still unexplained**; a possible mechanism (eight serialized advisory-lock transactions exceeding Prisma's default 5 s interactive-transaction timeout on a starved machine) is a hypothesis I could not confirm, so I made no code change.

## 5. Offline behavior verified
With no network: view sales/purchase history, party statements, summary, aging (from the device, marked "as of last download" and including unsynced work); unlock protected data by password; all Phase 3.3 actions. On reconnect or wake: the same ordered, idempotent, server-authoritative sync; a damaged entry is isolated; refusals stay visible. While online and visible: other terminals' changes trigger a refresh within about a second.

## 6. Security, recovery and device-isolation audit — result
Confirmed by tests: per-user databases; one user's key/data never opens another's; sign-out forgets the key, purges every read/sealed table, keeps unsent work; no personal data in localStorage; terminal reports carry no transaction content; realtime events carry no data and are shop-scoped; reconciliation and stream endpoints enforce authentication, roles and tenant isolation; recovery after restart (interrupted `syncing` entries, locked data, lost key) loses no transaction; damaged entries are contained; full storage is atomic and clear.

## 7. Conditions / caveats (things that cannot safely, or fully, work offline or be claimed)
1. **Encryption threat model.** Protection is against reading the stored data without the user's password (copied profile, raw storage tools). It does **not** protect data while the user is signed in on an unlocked device, nor the session token (already in `localStorage` by the existing design). The **unsent queue** (ids, quantities, amounts, party names in `display`) and **products/stock/branch/warehouse cache** are not sealed: the sync engine and stock overlay need them in the clear. Typing a wrong password offline when no key ring exists yet creates a ring for that password; a later online sign-in replaces it.
2. **After a restart, sealed data (customers, history, documents, notes) needs the password** before it is usable offline; online it is re-downloaded once unlocked. Until then those views are empty and returns/applications/refunds refuse to queue with a "locked" message.
3. **Insecure contexts (plain http) keep no personal data offline** (no WebCrypto).
4. **Background sync is best-effort.** Only Chromium-class browsers support Background Sync/Periodic Sync (the latter also needs an installed app and permission). The worker only wakes open windows: with the app fully closed nothing is sent until it is opened; Safari/Firefox rely on reconnect, visibility, focus and the heartbeat. A truly closed-app sync would need the engine and a token inside the worker — not built, deliberately.
5. **Realtime is single-instance.** Announcements are held in server memory; with several server instances only same-instance changes are pushed immediately; polling covers the rest. Proxies that buffer streams degrade to polling.
6. **History/statements are views "as of the last download"** (90-day window; documents created offline are not statement lines until synced). They are not accounting reports: official reports, ledger, journal, valuation, reversals of returns/applications, note cancellation, editing accepted records remain **online-only** (unchanged from 3.3).
7. **Unexplained single failure** of the receipt-numbering concurrency test (section 4).
8. **Not run:** real-browser end-to-end (actual Background Sync events, real service-worker lifecycle, real network toggling, storage-eviction behavior). These are verified through the worker's real source against fakes and the app's logic on fake-indexeddb.
9. `navigator.storage.persist()` is a request; the browser may refuse, in which case eviction under storage pressure remains possible (the app reports capability, does not guarantee it).

## 8. Not done (out of scope, not started)
Engine-in-worker sync for a closed app; multi-instance realtime (pub/sub backend); sealing the unsent queue; offline application reversal / return of a same-terminal offline sale (3.3 deferrals). No Phase 3.5 or further Phase 3 sub-phase has been created; Phase 4 has not been started.

**PHASE 3.4 — CLOSED WITH CONDITIONS.** Major Phase 3 ends here. Stopping.
