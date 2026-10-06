# AK VisionFlow — V1 Deployment & Launch Roadmap

## Purpose

AK VisionFlow's core ERP functionality is already substantially complete.

The objective of this roadmap is NOT to add large new product features.

The objective is to take the existing system from its current audited state to a stable, secure, tested and commercially deployable **V1 production release**.

The latest V1 Readiness Audit estimated:

- Core ERP: approximately 90% complete
- Commercial V1: approximately 70–75% complete
- Current major gaps are primarily stabilization, deployment, security, integrations and real-world validation.

---

# IMPORTANT DEVELOPMENT RULES

1. Work directly from this roadmap.
2. Do not wait for Product Owner approval between phases.
3. When one phase is completed and verified, automatically continue to the next phase.
4. Do not create additional major phases.
5. Do not expand the scope unnecessarily.
6. Do not rebuild functionality that already works.
7. Reuse existing architecture and business logic wherever possible.
8. Do not add new ERP modules unless they are explicitly required by this roadmap.
9. Fix genuine bugs discovered during implementation.
10. Do not hide limitations or failed tests.
11. Every phase must end with a concise verification report.
12. After completing Phase 5, STOP. Do not start Phase 6 or any post-V1 feature development.
13. Keep implementation practical and commercially focused.
14. Prefer simple, maintainable solutions over over-engineering.
15. Offline-first remains a core product requirement.
16. Preserve tenant, company, branch, warehouse and permission isolation everywhere.
17. Do not use the production database for testing.
18. Never expose or commit production secrets.

---

# PHASE 1 — PROJECT STABILIZATION

## Objective

Make the existing codebase clean, reproducible and safe to deploy.

## Scope

### 1. Repository & Git

- Audit all uncommitted files.
- Identify legitimate project files.
- Remove junk/debug/log/generated files that should not be committed.
- Check suspicious directories and malformed paths.
- Ensure `.env` and secrets are excluded.
- Organize and commit the current working state logically.
- Create an appropriate V1 baseline/tag when ready.

### 2. Permission Seed

Fix the current deployment problem where a fresh installation requires a manual permission seed.

- Make permission initialization part of the deployment process.
- Ensure a fresh database becomes usable without a manual undocumented step.
- Do not duplicate permissions.
- Keep seed operation idempotent.
- Verify existing permission counts and grants remain correct.

### 3. CI

Ensure CI performs at minimum:

- dependency installation
- database setup
- migrations
- required seed/setup
- backend tests
- frontend tests
- lint
- frontend build

CI must fail when any critical step fails.

### 4. Database & Migration Verification

- Verify all migrations from an empty database.
- Verify migration status.
- Investigate schema drift properly.
- Ensure test database configuration is isolated from production.
- Document the correct database setup.

## Exit Criteria

- Clean repository
- Reproducible setup
- Permission seed automated
- CI passes
- Backend tests pass
- Frontend tests pass
- Migrations pass
- No production database is used by tests
- V1 baseline committed/tagged

Then automatically continue to **Phase 2**.

---

# PHASE 2 — PRODUCTION INFRASTRUCTURE

## Objective

Create a real, reliable production environment.

## Scope

### 1. Deployment Architecture

Audit the current architecture and choose the appropriate production deployment model.

Specifically verify:

- Backend
- Frontend
- PostgreSQL
- WebSocket/SSE/realtime requirements
- Offline sync requirements
- scheduled jobs
- file storage
- environment configuration

Do not blindly use Vercel/serverless if the existing realtime or scheduled functionality requires a persistent server.

Choose the simplest architecture that properly supports the actual product.

### 2. Production Deployment

Deploy:

- frontend
- backend/API
- production database
- required storage/services

Configure production environment variables securely.

Verify:

- authentication
- API connectivity
- database connectivity
- migrations
- tenant isolation
- branch isolation
- permissions

### 3. Backup & Recovery

Implement/verify:

- automated database backups
- backup retention
- restore procedure
- restore test

A backup is not considered verified until an actual restore has been tested.

### 4. Monitoring

Implement practical production monitoring.

At minimum:

- application errors
- API failures
- database connectivity
- deployment failures
- critical sync failures

Avoid unnecessary monitoring infrastructure.

## Exit Criteria

- Production environment deployed
- Correct architecture confirmed
- Database backup working
- Restore successfully tested
- Monitoring/alerts working
- Production secrets secured
- Critical production flows verified

Then automatically continue to **Phase 3**.

---

# PHASE 3 — SECURITY & ESSENTIAL INTEGRATIONS

## Objective

Close the security and integration gaps that prevent a credible commercial V1.

## Scope

### 1. Authentication & Account Security

Implement/verify:

- forgot password
- password reset
- secure reset tokens
- password policy
- session handling
- login rate limiting
- production secret configuration

Review open signup and make it intentional.

Do not build a large identity-management system.

### 2. Messaging / OTP

Audit all current WhatsApp, OTP and messaging functionality.

The current system contains mock providers.

Make a clear V1 decision:

- integrate one real provider where required,

OR

- remove/disable unsupported promises and UI.

Do not leave fake "successful" messaging in production.

### 3. Android / Portal Integration Readiness

Ensure the Android owner app and customer portal do not advertise functionality that is actually unavailable.

Where real push/WhatsApp/OTP is not required for V1, clearly disable or defer those functions rather than pretending they work.

### 4. Production Security Audit

Verify:

- tenant isolation
- branch/warehouse authorization
- RBAC
- IDOR protection
- rate limits
- CORS
- security headers
- JWT configuration
- secret handling
- production error responses
- sensitive information leakage
- audit logging

Fix genuine critical/high-risk issues found.

## Exit Criteria

- Password reset works
- Authentication is production-safe
- Signup policy is intentional
- Unsupported integrations are removed/disabled or replaced
- Security audit passes
- No critical/high production security issue remains

Then automatically continue to **Phase 4**.

---

# PHASE 4 — REAL-WORLD VALIDATION

## Objective

Prove that the system works outside the test environment.

This phase is especially important because offline-first is a core AK VisionFlow differentiator.

## Scope

### 1. Real Device Testing

Test the actual application using real devices/browsers.

Verify:

- login
- logout
- POS
- sales
- inventory
- payments
- offline mode
- reconnect
- sync
- conflict handling
- encrypted local data
- Android owner app where applicable

Do not claim real-device verification if it cannot actually be performed.

### 2. Multi-Terminal Offline Pilot

Use realistic shop data and at least multiple terminals/devices.

Test:

- simultaneous sales
- stock conflicts
- offline sales
- reconnect
- queued transactions
- duplicate requests
- failed transactions
- retry
- conflict visibility
- reconciliation

Verify that the server remains authoritative.

### 3. Performance / Load Testing

Run practical load tests against critical flows:

- login
- POS
- sales
- inventory
- payments
- sync
- dashboard

Identify obvious bottlenecks.

Do not perform unnecessary enterprise-scale benchmarking.

### 4. Final Bug Fix Cycle

Fix only issues discovered during the validation phase that affect:

- correctness
- security
- data integrity
- offline reliability
- critical UX
- production stability

Re-run the complete regression suite after fixes.

## Exit Criteria

- Real-device testing completed where hardware permits
- Offline workflow validated
- Multi-terminal conflicts validated
- Critical flows load-tested
- No critical production blocker remains
- Full regression passes
- Final known limitations documented

Then automatically continue to **Phase 5**.

---

# PHASE 5 — V1 LAUNCH

## Objective

Prepare the final commercial V1 release.

## Scope

### 1. Final Product Audit

Perform a final audit of:

- ERP modules
- accounting
- inventory
- offline-first
- security
- permissions
- Android app
- reports
- integrations
- deployment
- database
- backups
- monitoring

### 2. Release Preparation

Prepare:

- production release build
- version number
- environment configuration
- deployment checklist
- rollback procedure
- database migration procedure
- basic administrator documentation

### 3. Final Smoke Test

Verify the most important real-world workflows:

- login
- customer creation
- product creation
- sale
- payment
- purchase
- inventory movement
- expense
- return
- accounting/reporting
- offline sale
- sync
- conflict handling
- owner dashboard

### 4. V1 Release Decision

Produce the final:

# AK VisionFlow V1 Production Readiness Report

The report must clearly state:

- READY / NOT READY
- remaining known issues
- known limitations
- production risks
- tested environments
- backup status
- monitoring status
- final test results

If READY:

- tag the V1 release
- deploy the final production version
- verify production smoke tests

## FINAL RULE

After Phase 5 is completed:

**STOP DEVELOPMENT.**

Do not start:

- Phase 6
- Phase 5.1
- AI expansion
- Industry expansion
- Subscription/billing expansion
- General-business expansion

Those are post-V1 decisions.

The purpose of this roadmap is to FINISH AK VisionFlow V1, not to continuously expand the project.

---

# V1 PRIORITY PRINCIPLE

When deciding whether to implement something during these phases:

**Production reliability > Data integrity > Security > Offline reliability > Core usability > Nice-to-have features**

If something is not required for V1 and does not affect these priorities, defer it.

---

# FINAL SUCCESS CONDITION

AK VisionFlow is considered V1 complete only when:

- Core ERP works
- Accounting is reliable
- Multi-tenant isolation is verified
- Offline-first workflows are reliable
- Production deployment is operational
- Backups and restore are verified
- Authentication/security are acceptable
- Critical integrations are honest and functional
- Real-world testing has passed
- Monitoring exists
- CI is passing
- Repository is clean
- Final release is tagged
- Production smoke test passes

**Target outcome: AK VisionFlow V1 — Production Ready & Launchable.**