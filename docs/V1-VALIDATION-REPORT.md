# AK VisionFlow V1 — Real-World Validation (Phase 4)

Evidence labels: **VERIFIED** (run in this phase, result recorded here), **PARTIAL**, **NOT DONE** (could not be performed).

## What was and was not possible

| Roadmap item | Status |
|---|---|
| Real-device / real-browser testing (Android phone, tablets, POS hardware, Chrome/Edge on shop PCs) | **NOT DONE.** No physical device or interactive browser was available to this run. The browser-side offline engine is covered by 373 automated frontend tests using a simulated IndexedDB and WebCrypto, which is *not* the same as a real device. Encrypted local storage, the service worker and background sync were verified only in those simulations. **This must be done by a person before launch** (checklist below). |
| Android owner app | **NOT DONE on device.** Its 22 unit-test files exist but were not executed here, and no APK was built. |
| Multi-terminal offline pilot | **VERIFIED** against a real server process over real HTTP (`backend/scripts/validation/pilot.js`), production mode, fresh database. Terminals are simulated clients, not separate devices. |
| Load / performance test | **VERIFIED** on a slow development laptop (`load.js`). Numbers below are a floor, not a forecast for a real server. |
| Final bug-fix cycle + full regression | **DONE** — see Regression. |

## Multi-terminal pilot (3 terminals + owner, 200 products, 100 customers) — 20 / 20 checks

Run: `NODE_ENV=production` server on a fresh migrated database, then `node scripts/validation/pilot.js`.

| Scenario | Result |
|---|---|
| S1 — 60 simultaneous sales for the last 10 units, from 3 terminals | exactly 10 succeed, 50 are refused as `409 STOCK_INSUFFICIENT` (the state the terminal shows as a conflict), 0 server errors, stock exactly 0 |
| S2 — each terminal replays 40 queued offline sales, every request delivered twice (240 deliveries) | all 240 answered; exactly 120 sales exist, one per idempotency key; stock fell by exactly 120 units |
| S3 — a terminal that was offline replays a sale of an item since sold out | refused `409 STOCK_INSUFFICIENT`, stock unchanged (server stays authoritative) |
| S4 — 10 simultaneous payments of 300 on a 1,000 invoice | exactly 3 accepted, invoice `amountPaid` 900, `PARTIAL` — no over-collection |
| S5 — same idempotency key from 3 terminals at once | one sale |
| S6 — reverse a sale | stock restored exactly |
| S7 — terminal reports a conflict | manager sees it in the sync monitor; a cashier is refused (403) |
| S8 — books after all of the above | trial balance debits = credits; receivables, payables, cash and inventory each reconcile to their ledger |

### Real defect found and fixed by the pilot

The first run failed S2: under a burst, ~2 % of valid sales were rejected with a misleading `409 DUPLICATE`, and a lost sale left stock unchanged. Cause: every document number (`INV-…`, `JE-…`, `RCT-…`, 20+ series) was "count existing rows + 1", so simultaneous creates drew the same number and the loser failed on the unique index once its retry budget (15) ran out. A terminal would have filed that valid sale as a conflict needing manual work.

Fix (`utils/sequenceNumber.js`, migration `sequence_counters`): numbers now come from one atomic per-tenant counter row inside the document's own transaction — concurrent creates queue instead of colliding, a rolled-back document gives its number back (no gaps), and the counter self-heals from existing rows. Regression tests: `tests/sequenceNumbering.test.js` (100 simultaneous sales all succeed with distinct numbers; a refused sale burns no number; self-heal). After the fix the pilot passes 20/20.

## Load test (`load.js`)

Hardware: AMD A8-4500M laptop (2012, 4 slow cores) running the API, PostgreSQL **and** the load generator together. A production VPS should be several times faster (not measured). Data: 3,000 products, 500 customers. Mix: POS sales 45 %, product list/search, product detail, sync manifest, payments, sales history, dashboard, trial balance. Every run ended with a balanced trial balance and reconciled ledgers, and **0 server errors** (no 5xx, no 429).

| Profile | Requests | POS sale p50 / p95 | Verdict on this hardware |
|---|---|---|---|
| Typical shop: 8 users, a request every ~1.5 s each | 204 in 41 s | 181 ms / 527 ms | comfortable |
| Busy chain: 25 users, a request every ~0.6 s each (~40 req/s demanded) | ~575 in 43 s (~13 req/s served) | 1.4 s / 5.7 s | **saturated** on this machine |
| Baseline, no concurrency | — | 147 ms | health 33 ms, product detail 41 ms |

Bottlenecks identified:
1. **Login CPU.** `bcryptjs` (pure JavaScript, cost 12) blocked the event loop ~0.9 s per login; 20 simultaneous logins took ~19 s and stalled every other request. Switched to native `bcrypt` (thread pool, hashes interchangeable, automatic fallback to `bcryptjs` if the native binary cannot load): the same burst now ~3 s. *Native build on Alpine/Docker not verified* — the fallback protects against a load failure.
2. **Two queries per authenticated request** (user, then tenant) merged into one: ~25 % more throughput in the busy profile (9.5 → 12.8 req/s, sale p50 2.3 s → 1.4 s; single run, noisy).
3. **Refresh stampede.** Every terminal re-checks the sync manifest (~30 queries) after every change. Measured: 25 terminals refreshing once per second ≈ 18–23 manifest requests/s, comparable to the whole rest of the traffic. Event-driven refreshes are now spaced ≥ 3 s apart per terminal (was ~1 s); the 60 s poll and the server's sale-time stock check are unchanged, so correctness is unaffected — a terminal may see another terminal's stock change up to ~3 s later.
4. **Connection pool.** With document numbers now issued one at a time per tenant, a burst of simultaneous sales queues, and each waiting request holds a database connection. Prisma's default pool (9 connections, 10 s wait) ran out under 60 simultaneous sales ("Timed out fetching a new connection", HTTP 500). The API now defaults to a pool of 25 with a 30 s wait (`DB_POOL_SIZE`, or `connection_limit` / `pool_timeout` in `DATABASE_URL`). `sequenceNumbering.test.js` now fires **100** simultaneous sales and passed repeatedly, including while the CPU was saturated by the frontend suite.
5. The database is not the constraint (PostgreSQL used about a quarter of the CPU of the Node processes); the ceiling is application CPU. If a real server saturates, the next steps are more cores/faster CPU, then running the API as several processes (which needs the realtime stream state moved out of process memory).

**Capacity statement for V1:** a typical shop (up to ~10 concurrent terminals) is well within capacity even on this slow machine. The busy-chain profile is beyond it on this machine; re-run `load.js` on the production server before selling to multi-branch customers.

## Regression

| Suite | Result |
|---|---|
| Backend (Jest, 55 suites, 1,025 tests) — final, run alone on the release code | **1,025 / 1,025 passed** |
| Frontend (Vitest, 57 files, 374 tests) — final | **374 / 374 passed**; lint 0 errors; production build OK |
| Pilot (20 checks) and smoke (16 steps) on the final code, production mode, fresh database | **20 / 20** and **16 / 16** |

Honest note on earlier runs: while the backend and frontend suites ran at the same time on this slow machine, timing-sensitive tests failed once each (`syncRealtime`, frontend `localData` keep-fresh) and passed on immediate re-run alone; and the new numbering test exposed the connection-pool limit described above. All are resolved in the final runs.

## Manual checklist that still needs people and devices (do before launch)

1. Install the PWA on the shop's real POS PC (Chrome/Edge). Sign in, wait for the local data download, then disconnect the network for an hour: sell, take a payment, add a customer, open the sync monitor.
2. Reconnect: queued items sync in order; conflicts (e.g. stock sold elsewhere) appear with clear wording.
3. Two real PCs selling the same item while one is offline; reconnect and compare stock.
4. Close the browser while offline, reopen: queued items and the encrypted local data are still there and unlock with the password.
5. Log out on a shared PC: local data is locked; log in as a different user: they cannot read the first user's cache.
6. Android owner app: build a release APK, sign in on a phone, open dashboard/alerts/AI advisor/management screens on mobile data and offline (cached view).
7. Print a receipt and a barcode label on the real printer; scan a real barcode with the real scanner.
8. Run `load.js` (busy profile) on the production server and compare with the table above.

## Known limitations recorded by this phase

* Simulated terminals over HTTP are not real devices; nothing here proves browser storage limits, service-worker updates or OS-level background sync behave on a given device.
* One process, one server: the realtime "something changed" stream and rate-limit counters live in process memory.
* A ~3 s (was ~1 s) worst-case delay before a terminal notices another terminal's stock change.
* Document numbers are now gap-free per series but each series is serialized per tenant (fine at shop scale, measured with 60 simultaneous sales).
