# AK VisionFlow V1 Production Readiness Report

Version **1.0.0**, release candidate tag **`v1.0.0-rc1`** (local git tag; nothing has been pushed or deployed).
Written from the state of the repository at the end of the V1 roadmap (Phases 1–5).

## Verdict: **NOT READY** for a public production launch

The software is code-complete for the V1 scope and passes everything that can be tested without your infrastructure and devices. It is not ready because these launch conditions are **not met**, and I could not meet them from the development machine:

1. **No production environment exists.** Nothing is deployed. The production stack (`deploy/`: Docker Compose, Caddy HTTPS, backup service) has never been started — this machine has no Docker, and no server or domain was available. HTTPS, the realtime stream through the proxy, and the container build are **NOT VERIFIED**.
2. **Backups are verified only locally.** Backup, restore and restore-verification scripts work against a real 92-table database (and detect a missing row), but there is no live schedule, no off-server copy and no restore drill on the real server.
3. **Monitoring is not live.** The error-alert hook is built and tested, but no webhook is configured and no uptime monitor watches `/api/health`.
4. **Real-device validation was not done.** Offline-first is the product's main promise. It is verified against a real server with simulated terminals and by 374 simulated-browser tests — not on a real POS PC, phone, printer or scanner. The Android app was not built or run.
5. **Capacity on the target server is unknown.** A typical shop (8 users) runs comfortably even on a 2012 laptop; the "busy chain" profile (25 users) saturated it. The production server has not been measured.
6. **CI has never run on GitHub** (nothing is pushed). It passes locally step by step but is unproven as configured.

None of these is a code defect; all can be closed by the checklist in "Path to READY".

## Test and verification results (final, on the release code)

| Check | Result |
|---|---|
| Backend Jest — 55 suites | **1,025 / 1,025 passed** |
| Frontend Vitest — 57 files | **374 / 374 passed**; lint 0 errors; production build OK |
| Migrations from an empty database + schema-drift check | 35 migrations apply; no drift |
| Multi-terminal pilot (production mode, real HTTP) | **20 / 20** — last-unit race, offline replay delivered twice, stale sale refused, concurrent payments, duplicate keys, reversal, sync monitor, books balance |
| Smoke test (16 workflow steps) | **16 / 16** |
| Load test (2012 laptop, API + DB + generator together) | 0 server errors, books balanced after every run; typical shop fine, busy chain saturates (see validation report) |
| `npm audit --omit=dev` | 0 vulnerabilities (backend, frontend) |
| Backup → restore → row-count comparison | Verified locally (17,151 rows / 92 tables) |
| Android unit tests | **Not run** (22 test files exist) |

Environments tested: Windows 10, Node 26, PostgreSQL 16 (portable), Chrome-less (jsdom) frontend tests. **Not** tested: Linux/Docker, Alpine, real browsers, Android devices.

## Roadmap status

| Phase | Outcome |
|---|---|
| 1 Stabilization | **Done.** Repo committed in logical commits (368 uncommitted files → clean tree), permission seed automated (`npm run db:setup`, Docker start, CI), CI extended (seed, drift check), tests refuse a non-local database, README updated. Two malformed junk directories under `backend/prisma/` could not be deleted by me (deletion was blocked); they are git-ignored — please delete them by hand. |
| 2 Infrastructure | **Architecture and artifacts done; deployment and live monitoring NOT done.** Decision: one VPS, Docker Compose, persistent Node process (not Vercel — the realtime stream and scheduled work need one). Backup/restore/verify scripts verified locally. |
| 3 Security & integrations | **Done.** Password reset/change, session revocation, fail-closed signup, honest messaging, production error handling, security audit ([V1-SECURITY-AUDIT.md](V1-SECURITY-AUDIT.md)). |
| 4 Real-world validation | **Partly done.** Pilot and load harnesses run and produced real fixes; real-device testing not possible here ([V1-VALIDATION-REPORT.md](V1-VALIDATION-REPORT.md)). |
| 5 Launch | **Audit, release preparation, smoke test done; production deploy not done.** Tagged as release candidate, not `v1.0.0`. |

## Real defects found and fixed by this work

1. Fresh install denied everyone (permission catalog needed a manual seed) — now automatic.
2. Login could lock a user out if the same email existed in another business — fixed; duplicates refused.
3. Sessions survived a password change — now revoked.
4. Malformed JSON / oversized bodies returned 500 (and would page the operator) — now 400 / 413.
5. **Valid sales rejected under concurrent bursts** (`409 DUPLICATE`): document numbers were "count + 1" — now an atomic per-tenant counter (gap-free on rollback).
6. Connection-pool exhaustion under a burst of 60+ simultaneous sales — larger default pool, longer wait.
7. Login blocked the whole server for ~0.9 s each (pure-JS bcrypt) — native bcrypt with fallback.
8. Two queries per request merged; sync refresh stampede (25 terminals ≈ 20 manifest requests/s) reduced by a 3 s minimum gap.
9. Production could report WhatsApp/push/portal-OTP as "sent" through mock providers — replaced by an honest "not configured" provider and visible UI notices.

## Module status (V1 scope)

| Area | Status |
|---|---|
| Multi-tenancy, branches, warehouses, RBAC (7 roles, 126 permissions) | Complete — tested, pilot- and smoke-verified |
| Sales / POS, quotations, sales orders, returns, credit & debit notes | Complete |
| Purchases, procurement chain, inventory, stock transfers | Complete |
| Payments, receivables/payables, expenses | Complete |
| Accounting: ledger, periods, financial reports, reconciliation | Complete — books balance after every run |
| Optical orders, patients, appointments, clinical records | Complete (tested; not part of the pilot) |
| Offline-first engine and sync monitor | Complete in code; **real-device validation pending** |
| Search, notifications, activity log, dashboard | Complete |
| Owner Android app | Code complete; **not built or run here**; no push (disabled), no store release prepared |
| WhatsApp automation, customer-portal sign-in, push | **Disabled by design in production** until a delivery provider is connected (UI says so) |
| AI assistant / recommendations | Rule-based only (no LLM); works, but should not be marketed as generative AI |
| Subscription billing | Not built (trial flag only) — post-V1 |

## Remaining known issues and limitations

* Web session token is stored in `localStorage`; no per-account lockout or 2FA (details in the security audit).
* Realtime stream and rate-limit counters are per process — correct for the single-server design, not for scaling out.
* Worst-case delay before a terminal sees another terminal's stock change is ~3 s (server still checks stock at sale time).
* Owner mobile tokens last 30 days (re-validated on every request).
* One pre-existing race is logged but harmless: default message-template creation can hit a unique-constraint race and is caught (`automation.js`).
* Frontend ships one ~960 kB script (no code splitting) — acceptable for V1, slower first load on weak links.
* Windows working copy stores CRLF; git normalizes to LF. Migration files were applied to the dev databases from CRLF copies; a database that was migrated on a Windows checkout and later deployed from Linux could report checksum differences — deploy fresh databases from Linux, or verify with `prisma migrate status` first.

## Path to READY (what only you can do)

1. **Provide a server and domain**, then follow [DEPLOYMENT.md](DEPLOYMENT.md): deploy, run `smoke.js` against it, check HTTPS and that the realtime stream is not buffered.
2. **Set `ALERT_WEBHOOK_URL`**, add an uptime monitor on `/api/health`, trigger a test alert.
3. **Copy backups off the server daily**, run `verify-restore.sh` on the server once, and record the result.
4. **Real-device pass** (checklist in [V1-VALIDATION-REPORT.md](V1-VALIDATION-REPORT.md)): a shop PC offline for an hour, two PCs on one item, printer and scanner, and a signed Android release build on a phone.
5. **Run `load.js` on the production server** (busy profile) and compare.
6. **Push the repository** and confirm CI is green on GitHub.
7. Delete the two junk directories in `backend/prisma/`, set `SIGNUP_INVITE_CODE`, choose whether to connect a WhatsApp/SMTP provider now or ship without.
8. Then re-tag `v1.0.0` and repeat the smoke test on production.

If steps 1–6 come back clean, the verdict becomes **READY**; no further development is needed for them, and per the roadmap no post-V1 work (billing, real messaging provider, AI, other industries) has been started.
