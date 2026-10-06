# PHASE 0.1 — CONDITIONS CLOSURE & OWNER DECISION NOTE

**Date:** 2026-09-17 | **Scope:** The two outstanding Phase 0.1 readiness conditions only — Test Database Safety and the Owner Mobile decision. No other Phase 0.1 finding is revisited here.

**Nothing was changed to produce this document.** `schema.prisma`, `app.js`, the `Product` model, all Optical/Medical functionality, and the entire Owner Mobile implementation (Android app, backend modules, migration, tests) remain exactly as they were. No destructive commands were run and no production data was touched or queried. This document is a proposal and a decision-support note, not an implementation.

---

## Executive Summary

**Condition 1 — Test Database Safety**: root cause fully identified. `backend/src/config/env.js` unconditionally loads `backend/.env` via `dotenv.config()` with no environment-aware file split, and `backend/.env`'s active `DATABASE_URL` line points at a live remote Neon Postgres database — the local-test alternative exists only as a commented-out line in the same file. **CI is already safe** (it injects its own `DATABASE_URL` as a job-level environment variable, which `dotenv` never overrides, and `backend/.env` is gitignored so it doesn't even exist on the CI runner). The risk is confined entirely to a developer running `npm test` locally. A concrete, low-risk fix is proposed below (§ Proposed Safe Test Architecture) — not yet implemented.

**Condition 2 — Owner Mobile**: current state re-confirmed unchanged from the prior audits — fully built (Android app + 6 backend routers + migration + 127 test cases across both platforms) but entirely uncommitted, unmounted, and unmigrated. Two options are presented with their consequences; a technical recommendation is given, but the decision is explicitly left to you.

---

## Test DB Safety Finding

### Why the current test configuration can point at the remote Neon database — exact mechanism

1. **`backend/src/config/env.js:1`** runs `require('dotenv').config()` unconditionally — this is the *only* place `DATABASE_URL` gets loaded into `process.env` for local runs, and it applies identically whether the process is `npm run dev`, `npm start`, `npm run seed`, or `npm test`. There is no `NODE_ENV`-aware file selection (no `.env.test`, no `.env.development` split).
2. **`backend/.env`** (confirmed present, gitignored — `git check-ignore -v backend/.env` confirms `.gitignore:4:.env` matches it, so it has never been committed and CI never sees it) contains, as its active uncommented line:
   ```
   DATABASE_URL="postgresql://neondb_owner:...@ep-purple-feather-....neon.tech/neondb?sslmode=require&channel_binding=require"
   # DATABASE_URL="postgresql://postgres:postgres@localhost:5432/akvisionflow_test?schema=public"
   ```
   The local-test URL is present but commented out — someone clearly intended a local-test path to exist, but it is not the active configuration.
3. **`backend/package.json`** has no `"jest"` config block, no `jest.config.js`, and no `setupFiles` anywhere in the repo — nothing intercepts or overrides `DATABASE_URL` before a test file's `require('../src/app')` triggers `env.js` to load `.env`.
4. **Jest itself sets `NODE_ENV=test`** by default when not already set (standard Jest CLI behavior), and `dotenv.config()`'s default behavior is to **never override** a `process.env` value that's already set. This means `.env`'s own `NODE_ENV=development` line is harmlessly ignored during test runs — but it also means nothing today uses `NODE_ENV=test` to pick a different `.env` file, because no such branch exists in `env.js`.
5. **CI (`.github/workflows/ci.yml`) is confirmed already safe**, independent of any of the above: it sets `DATABASE_URL`, `JWT_SECRET`, and `NODE_ENV: test` as job-level `env:` values directly in the workflow (lines 33-36), pointed at a fresh, disposable `postgres:16-alpine` service container created for that run only. Because `backend/.env` is gitignored, it is never checked out onto the CI runner, so there is nothing for `dotenv.config()` to even load there — CI's own environment variables are the only source, and dotenv's non-override default means they'd win even if `.env` somehow existed.

**Conclusion**: this is purely a **local developer environment** gap, not a CI gap. The fix belongs entirely in `backend/src/config/env.js` and a new local-only env file.

### Additional observation (not one of the two conditions, noted for completeness)

`backend/.env`'s committed-nowhere but disk-resident content includes a live Neon connection string with real credentials in plaintext. This is normal for a local `.env` file (that's what `.gitignore` is for) and is not a new finding, but is worth the product owner's awareness: anyone with filesystem access to this machine can read live production-adjacent database credentials from this file today. No action was taken on this observation — it's outside the two conditions in scope for this pass.

---

## Proposed Safe Test Architecture

**Not implemented — proposal only, pending your approval.**

### Files/configuration that would need to change

| File | Change |
|---|---|
| `backend/.env.test` (new, gitignored) | A new local-only file containing `NODE_ENV=test`, a `DATABASE_URL` pointed at a disposable local Postgres instance, and a throwaway `JWT_SECRET` — never a cloud/production connection string. |
| `.gitignore` | Add `.env.test` alongside the existing `.env`/`.env.local` entries, so it's never at risk of being committed. |
| `backend/src/config/env.js` | Change the unconditional `require('dotenv').config()` on line 1 to select the file based on `NODE_ENV`: load `.env.test` when `NODE_ENV === 'test'`, otherwise load `.env` as today. |
| `backend/src/config/env.js` (same file, new logic) | Add a hard-fail safety guard: if `NODE_ENV === 'test'` and the resolved `DATABASE_URL` does not point at `localhost`/`127.0.0.1` (or another explicitly-allowlisted local host), throw immediately before the app/tests can start. This is defense-in-depth — it protects against `.env.test` being missing, misconfigured, or someone later pointing it at a cloud database by mistake. |
| `backend/.env.test.example` (new, committed) | A checked-in template (mirroring how `.env.example` already documents `.env`) so any developer setting up the project knows a test database file is expected, without exposing real credentials. |
| `backend/README.md` / project setup docs | One paragraph documenting that `npm test` requires `backend/.env.test` to exist and point at a local database, and that the app will now refuse to run tests otherwise. |

### Proposed local database target

This machine already has a portable PostgreSQL instance at `D:\pgsql-portable` (confirmed present, with a `data/` directory and log files evidencing prior local test runs against it — e.g. `dash-test1.log`, `alerts-test1.log`) — per this project's own standing local-dev-environment note (no Docker/local PostgreSQL *install* on this machine; this portable instance is the intended substitute). The proposed `backend/.env.test` would point at a database on that instance, e.g.:
```
NODE_ENV=test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/akvisionflow_test?schema=public"
JWT_SECRET=test-only-secret-never-used-outside-jest
```
(exact port/credentials to be confirmed against however that portable instance is actually configured — not verified in this pass since starting/querying it was out of scope for a documentation-only condition-closure task).

---

## Verification Plan

Once the above is implemented (in a future, separately-approved step), this exact procedure would prove tests cannot write to production, without ever needing to run a test against the real Neon database to "check":

1. **Static proof**: `git grep -n "neon.tech" backend/.env.test backend/src/config/env.js` returns no matches — the test path has no code or config route to a cloud host.
2. **Negative-control test**: temporarily set `backend/.env`'s `DATABASE_URL` (the non-test file) to an intentionally invalid/unreachable value (e.g. `postgresql://invalid:invalid@0.0.0.0:1/nonexistent`), then run `npm test`. If the safe-architecture change is correctly wired, the full suite still passes — proving tests never touch `.env`'s value at all, only `.env.test`'s. Restore `.env` afterward.
3. **Positive-control guard test**: temporarily set `backend/.env.test`'s `DATABASE_URL` to a non-local host (e.g. reuse the real Neon string), run `npm test`, and confirm the new hard-fail guard rejects it immediately with a clear error before any test executes. Restore `.env.test` afterward. This proves the defense-in-depth guard actually fires rather than being dead code.
4. **Row-count proof**: before and after a full `npm test` run, independently query the production/Neon database's row counts for a fast-changing table (e.g. `SELECT COUNT(*) FROM sales` or `tenants`) via a separate one-off script or `psql` session pointed explicitly at the Neon URL — confirm the counts are identical, proving no test run touched it.
5. **CI proof (already true today, re-confirm after the change)**: re-run the existing `.github/workflows/ci.yml` and confirm it still passes unmodified — the change should have zero effect on CI, since CI never used `backend/.env`/`backend/.env.test` in the first place.

No step above requires or permits running anything against the live Neon database as part of implementing the fix itself — steps 2-4 are one-time verification exercises using deliberately invalid or isolated targets, run once after implementation, not part of routine testing.

---

## Owner Mobile Current State

(Re-confirmed unchanged from the Phase 0.1 audit and the subsequent Findings Resolution pass — no new inspection was needed since nothing has been touched.)

**What exists, fully built but uncommitted:**
- Complete native Android app (`android/app/`, Kotlin + Jetpack Compose): Login, Home/Dashboard, Analytics, Alerts, 5 AI Advisor screens, Profile/Logout.
- Complete backend surface: 6 route files under `backend/src/modules/mobile/*`, the push pipeline under `backend/src/modules/push/*`, and `backend/src/middleware/mobileAuth.js` (correctly isolated `typ: 'mobile'` JWT auth).
- A Prisma migration creating `DeviceToken`, `UserNotificationPreference`, `PushConfig` and two new `AiInsight` columns.
- 69 backend test cases (4 files) + 58 Android JVM test cases (13 classes) — 127 total.
- Correctly-implemented security fundamentals where the code was reviewed: Keystore-backed `EncryptedSharedPreferences` token storage (not plaintext), HTTPS-only in release builds, token-type isolation from staff/portal auth.

**What is missing/inactive:**
- Nothing under `android/`, `backend/src/modules/mobile/`, `backend/src/modules/push/`, or `mobileAuth.js` has ever been committed to git.
- `backend/src/app.js` deliberately does not mount any of the 6 mobile routers — every endpoint the app calls currently returns 404.
- `backend/prisma/schema.prisma` has none of the 3 models the migration would create — the migration SQL exists on disk but was never applied, and the models it needs don't exist in the current schema.
- No FCM/real push provider integration exists on either side — push ends at a mock provider with no Android-side notification receiver at all.
- No on-device or emulator test has ever been successfully run (blocked by BIOS virtualization being disabled in the environment where it was attempted).
- No commit, comment, or changelog explains why the routers were unmounted between the 2026-09-16 "Final Project Audit" and the 2026-09-17 Phase 0.1 audit.

---

## Option A vs Option B

### Option A — Resume and integrate Owner Mobile now

**What this would require:**
1. Apply the pending migration to a local/test database first, verify the 4 backend test files pass against the new schema.
2. Remount the 6 routers in `app.js`, remove the "paused" comments.
3. Commit the entire uncommitted surface as one reviewable changeset.
4. Decide on and integrate a real push provider (FCM) — currently 0% built beyond a mock.
5. Achieve an actual on-device/emulator verification — never yet done.
6. Re-run and re-confirm every test-count claim in the prior phase reports, since this audit could not independently verify them (no DB was run against).

**Consequences:**
- Delays Phase 0.2 (Universal Product Architecture) start, since this work touches `app.js` and `schema.prisma` — the same two files Phase 0.2 will also need to modify, and both are explicitly on the "must not change" list until this is resolved.
- Requires resolving the unexplained unmount first (§ Owner Mobile Current State) — proceeding without understanding *why* it was paused risks reintroducing whatever problem caused that decision.
- Adds real scope (FCM integration, device testing) beyond just "turning the switch back on" — this is not a quick remount.
- Positive: the feature is genuinely close to done on the backend/API-design side; the core architecture (token isolation, tenant/branch scoping reviewed as solid in the Phase 0.1 audit) would not need rework.

### Option B — Defer Owner Mobile to a later phase

**What this would require:**
1. No immediate action — leave the uncommitted tree exactly as-is.
2. Optionally (not required): add a one-line note to `app.js` or a project doc recording the deferral decision and date, so a future session doesn't re-ask this same question from scratch.

**Consequences:**
- Phase 0.2 can proceed immediately without any interaction with the mobile surface, since Phase 0.2's scope (`Product`/`schema.prisma`) doesn't overlap with the mobile-specific models.
- The uncommitted work remains at risk of accidental loss (e.g., an unrelated `git clean`, a machine change, a careless `git checkout` without first stashing) for as long as it stays uncommitted — this risk exists under Option B and grows the longer it's deferred, regardless of whether the feature itself is paused.
- Whoever resumes it later will need to re-verify everything in this note, since more time will have passed and more of the surrounding codebase may have changed (e.g., if Phase 0.2's Product changes touch `schema.prisma` in ways that interact with how the mobile dashboard queries `Product`/`AiInsight`).
- No functionality is lost that is currently in production use — nothing about Owner Mobile is live today regardless (see Current State).

---

## Technical Recommendation

**Recommend Option B (defer), with one required safety action regardless of which option you choose: commit the uncommitted work to a separate branch (not `main`) immediately, even if unmounted/unmigrated, so it stops being at risk of accidental loss.** This is a pure git-hygiene action — it does not remount, migrate, or activate anything — and can be done under either option without prejudging the resume/shelve decision.

Reasoning for recommending Option B specifically:
- Phase 0.2 is scoped as Universal Product Architecture — unrelated to the mobile surface's actual blockers (FCM integration, device testing, the unexplained unmount).
- Resuming now would require touching `app.js` and `schema.prisma` for mobile-specific reasons at the same time Phase 0.2 needs to touch them for Product reasons — sequencing these separately reduces risk of the two efforts colliding.
- The unexplained unmount (§ Owner Mobile Current State) is itself unresolved — resuming without first understanding why it happened risks repeating whatever the original problem was.
- Nothing is lost by deferring: no Owner Mobile functionality is live in production today, so no user-facing capability regresses by waiting.

This is a recommendation, not a decision — the final call is yours.

---

## Exact Product Owner Decisions Required

1. **Test DB Safety**: Approve implementing the proposed `.env.test` + `env.js` guard change described above? (Yes/No — this is low-risk and independent of the Owner Mobile decision; it can be approved on its own.)
2. **Owner Mobile — resume or defer?** Option A or Option B (§ above).
3. **If deferred (Option B)**: approve the one recommended safety action — committing the current uncommitted mobile work to a separate, non-`main` branch, with no mounting/migration/activation — so it's not at risk of accidental loss while parked?
4. **If resumed (Option A)**: who/when will investigate why the routers were unmounted between 2026-09-16 and 2026-09-17, before any further mobile work proceeds?

---

## Phase 0.2 Entry Checklist

This replaces the "READY WITH CONDITIONS" status from the prior Findings Resolution report with a concrete checklist tied to these two conditions specifically:

- [ ] Test DB Safety proposal reviewed and either approved-and-implemented, or explicitly deferred with your acknowledgement of the residual risk.
- [ ] Owner Mobile decision made (Option A or B).
- [ ] If Option B chosen: uncommitted mobile work safely committed to a non-`main` branch (git-hygiene only, no functional change).
- [ ] If Option A chosen: the unexplained-unmount question (§ Decisions Required, item 4) has an owner and a timeline before mobile work resumes.
- [ ] No changes have been made to `schema.prisma`, `app.js`, `Product`, Optical/Medical functionality, or the Owner Mobile implementation as part of closing these conditions (confirmed true as of this document).

**Phase 0.2 does not begin as part of this task. Stopping here per your instruction, pending your decisions above.**
